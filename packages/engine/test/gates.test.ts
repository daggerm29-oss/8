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
