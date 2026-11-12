import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { GateConfigError, inferGates, parseGateConfig, resolveGates } from '../src/verify/gates.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const copy = (name: string) => { const d = tmp(`helix-gates-${name}-`); cpSync(join(FIXTURES, name), d, { recursive: true }); return d; };
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

test('gates: explicit command > .helix/verify.json > inferred (auto only); config validation', () => {
  const dir = copy('js-calc');
  assert.deepEqual(resolveGates(dir, 'make test').gates.map((g) => g.command), ['make test']);
  assert.equal(resolveGates(dir, null).source, 'none', 'no inference without auto');
  const auto = resolveGates(dir, 'auto');
  assert.equal(auto.source, 'inferred');
  assert.deepEqual(auto.gates.map((g) => [g.kind, g.command]), [['test', 'npm test --silent']]);

  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ gates: [{ name: 'types', kind: 'typecheck', command: 'true' }, { kind: 'lint', command: 'false', required: false, timeoutMs: 5000 }] }));
  const cfg = resolveGates(dir, null);
  assert.equal(cfg.source, 'config');
  assert.deepEqual(cfg.gates.map((g) => [g.name, g.required, g.timeoutMs]), [['types', true, 300_000], ['lint-2', false, 5000]]);

  assert.throws(() => parseGateConfig({ gates: [] }), GateConfigError);
  assert.throws(() => parseGateConfig({ gates: [{ command: 'x', kind: 'nope' }] }), /kind must be one of/);
  assert.throws(() => parseGateConfig({ gates: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }), /duplicate/);

  const py = copy('py-strings');
  assert.deepEqual(inferGates(py).map((g) => g.command), ['python3 -m unittest -q']);
  const go = tmp('helix-gates-go-');
  writeFileSync(join(go, 'go.mod'), 'module x\n');
  assert.deepEqual(inferGates(go).map((g) => g.kind), ['typecheck', 'test']);
});

test('runtime: runs every gate, retries only on required failures, reports optional failures', async () => {
  const dir = copy('js-calc');
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ gates: [
    { name: 'syntax', kind: 'typecheck', command: 'node --check src/calc.js' },
    { name: 'style', kind: 'lint', command: 'echo "src/calc.js:1:1: warning: style" && exit 1', required: false },
    { name: 'unit', kind: 'test', command: 'node --test "test/*.test.js"' },
  ] }));
  const turns: FakeTurn[] = [
    { text: 'Done (not really).', usage: { input: 100, output: 5 } },
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'return a + b;\n}\n\nexport function multiply', new_string: 'return a - b;\n}\n\nexport function multiply' } }], usage: { input: 200, output: 20 } },
    { text: 'Fixed.', usage: { input: 300, output: 5 } },
  ];
  let systemSeen = '';
  const fake = await startFakeProvider('gemini', (ctx) => {
    const body = ctx.request.body as { systemInstruction?: { parts: Array<{ text: string }> } };
    systemSeen = body.systemInstruction?.parts.map((p) => p.text).join('') ?? systemSeen;
    return scripted(turns)(ctx);
  });
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 } });
  try {
    const gateEvents: Array<{ gate: string; passed: boolean; attempt: number }> = [];
    engine.bus.subscribe('verify.gate', (e) => { gateEvents.push(e.data as never); });
    const created = engine.runtime.create({ workspacePath: dir, goal: 'fix it', provider: 'gemini', model: 'gemini-3.8-flash' });
    const done = await engine.runtime.wait(created.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.match(done.result ?? '', /optional gates failed: style/);
    assert.match(systemSeen, /verification gates in order: `node --check src\/calc\.js` \(typecheck\)/);
    engine.bus.flush();
    assert.deepEqual(gateEvents.map((g) => `${g.attempt}:${g.gate}:${g.passed}`), ['1:syntax:true', '1:style:false', '1:unit:false', '2:syntax:true', '2:style:false', '2:unit:true']);
    const retry = engine.runtime.transcript(created.id).find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('Verification failed')))!;
    const text = (retry.parts[0] as { text: string }).text;
    assert.match(text, /Gate 'unit' \(test\)/);
    assert.ok(!text.includes("Gate 'style'"), 'optional gate failures do not trigger retries');
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('runtime: invalid .helix/verify.json fails the task with a clear error', async () => {
  const dir = copy('js-calc');
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), '{ not json');
  const fake = await startFakeProvider('gemini', scripted([{ text: 'Done.', usage: { input: 10, output: 2 } }]));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 } });
  try {
    const created = engine.runtime.create({ workspacePath: dir, goal: 'x', provider: 'gemini', model: 'gemini-3.8-flash' });
    const done = await engine.runtime.wait(created.id, 30_000);
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /verify\.json is not valid JSON/);
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('retries are minimal: each retry diff is audited against the diagnostics and unrelated edits are called out (F-AGT-3, §9.5)', async () => {
  const dir = tmp('helix-retry-');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, '.helix'));
  const body = (name: string, bad: number[]) => Array.from({ length: 20 }, (_, i) => `export const ${name}${i + 1} = ${bad.includes(i + 1) ? 'BAD' : i + 1};`).join('\n') + '\n';
  writeFileSync(join(dir, 'src/a.ts'), body('l', [3, 9]));
  writeFileSync(join(dir, 'src/b.ts'), body('b', []));
  writeFileSync(join(dir, 'check.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const lines = readFileSync('src/a.ts', 'utf8').split('\\n');",
    'let bad = 0;',
    "lines.forEach((l, i) => { if (l.includes('BAD')) { bad++; console.log(`src/a.ts(${i + 1},1): error TS2322: bad token`); } });",
    'process.exit(bad ? 1 : 0);',
    '',
  ].join('\n'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ gates: [{ name: 'check', kind: 'typecheck', command: 'node check.mjs', parser: 'tsc' }] }));
  const edit = (path: string, from: string, to: string) => ({ name: 'edit_file', args: { path, old_string: from, new_string: to } });
  const turns: FakeTurn[] = [
    { toolCalls: [edit('src/b.ts', 'b15 = 15;', 'b15 = 150;')], usage: { input: 100, output: 10 } },
    { text: 'Done.', usage: { input: 150, output: 5 } },
    { toolCalls: [edit('src/a.ts', 'l3 = BAD;', 'l3 = 3;'), edit('src/b.ts', 'b16 = 16;', 'b16 = 160;')], usage: { input: 200, output: 20 } },
    { text: 'Fixed line 3.', usage: { input: 250, output: 5 } },
    { toolCalls: [edit('src/a.ts', 'l9 = BAD;', 'l9 = 9;')], usage: { input: 300, output: 10 } },
    { text: 'Fixed line 9.', usage: { input: 350, output: 5 } },
  ];
  const fake = await startFakeProvider('gemini', scripted(turns));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false });
  try {
    const reports: Array<{ attempt: number; related: number; unrelated: number; files: string[]; hunks: Array<{ path: string; startLine: number; related: boolean }> }> = [];
    engine.bus.subscribe('verify.retry_diff', (e) => { reports.push(e.data as never); });
    const created = engine.runtime.create({ workspacePath: dir, goal: 'fix the type errors', provider: 'gemini', model: 'gemini-3.8-flash' });
    const done = await engine.runtime.wait(created.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    engine.bus.flush();

    assert.deepEqual(reports.map((r) => [r.attempt, r.related, r.unrelated]), [[2, 1, 1], [3, 1, 0]], 'retry 2 touched one unrelated hunk, retry 3 only the diagnostic');
    assert.deepEqual(reports[0].hunks.map((h) => [h.path, h.startLine, h.related]), [['src/a.ts', 3, true], ['src/b.ts', 16, false]]);
    assert.deepEqual(reports[1].files, ['src/a.ts']);

    const prompts = engine.runtime.transcript(created.id).filter((m) => m.role === 'user').map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
    const failures = prompts.filter((p) => p.startsWith('Verification failed'));
    assert.equal(failures.length, 2);
    assert.match(failures[0], /Your changes so far \(minimal diff since the start of the task\):[\s\S]*-export const b15 = 15;[\s\S]*\+export const b15 = 150;/);
    assert.match(failures[1], /Your changes since the last failed verification \(minimal diff\):[\s\S]*-export const l3 = BAD;[\s\S]*\+export const l3 = 3;/);
    assert.doesNotMatch(failures[1], /^[-+]export const b15/m, 'the retry diff excludes edits already reported (b15 only appears as context)');
    assert.match(failures[1], /\[minimality\].*src\/b\.ts:16/);
    assert.doesNotMatch(failures[0], /\[minimality\]/);
  } finally {
    await engine.close();
    await fake.close();
  }
});
