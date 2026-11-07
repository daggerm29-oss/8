import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { describeGates, diagnosticKey, expandGateCommand, GateConfigError, parseGateConfig, resolveGates, type Gate } from '../src/verify/gates.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const copy = (name: string) => { const d = tmp(`helix-sel-${name}-`); cpSync(join(FIXTURES, name), d, { recursive: true }); return d; };
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];
const FIX_SUBTRACT = { name: 'edit_file', args: { path: 'src/calc.js', old_string: 'return a + b;\n}\n\nexport function multiply', new_string: 'return a - b;\n}\n\nexport function multiply' } };

test('expandGateCommand / diagnosticKey / config parsing', () => {
  const gate: Gate = { name: 'unit', kind: 'test', command: 'node --test {{tests}}', required: true, timeoutMs: 1000 };
  assert.deepEqual(expandGateCommand(gate, ['test/a.test.js', "test/it's.test.js"]), { command: `node --test test/a.test.js 'test/it'\\''s.test.js'`, selectedTests: ['test/a.test.js', "test/it's.test.js"] });
  assert.deepEqual(expandGateCommand(gate, []), { command: 'node --test', selectedTests: [] });
  assert.deepEqual(expandGateCommand({ ...gate, fallback: 'npm test' }, null), { command: 'npm test', selectedTests: [] });
  assert.deepEqual(expandGateCommand({ ...gate, command: 'npm test' }, ['x']), { command: 'npm test', selectedTests: null });
  assert.equal(diagnosticKey({ file: 'a.ts', message: 'expected 5 got 7' }), diagnosticKey({ file: 'a.ts', message: 'expected 6 got 9' }));
  assert.notEqual(diagnosticKey({ file: 'a.ts', message: 'x' }), diagnosticKey({ file: 'b.ts', message: 'x' }));
  const parsed = parseGateConfig({ gates: [{ command: 'node --test {{tests}}', fallback: 'npm test', allowPreexisting: true }] });
  assert.equal(parsed[0].fallback, 'npm test');
  assert.equal(parsed[0].allowPreexisting, true);
  assert.throws(() => parseGateConfig({ gates: [{ command: 'x', fallback: '' }] }), GateConfigError);
  const dir = tmp('helix-sel-cfg-');
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ baseline: true, gates: [{ command: 'node --test {{tests}}' }] }));
  const cfg = resolveGates(dir, null);
  assert.equal(cfg.baseline, true);
  assert.match(describeGates(cfg), /node --test <tests covering your changes>/);
});

async function runTask(dir: string, turns: FakeTurn[]) {
  const fake = await startFakeProvider('gemini', scripted(turns));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 } });
  const gates: Array<Record<string, unknown>> = [];
  const baselines: Array<Record<string, unknown>> = [];
  engine.bus.subscribe('verify.gate', (e) => { gates.push(e.data as never); });
  engine.bus.subscribe('verify.baseline', (e) => { baselines.push(e.data as never); });
  try {
    const created = engine.runtime.create({ workspacePath: dir, goal: 'fix subtract', provider: 'gemini', model: 'gemini-3.8-flash' });
    const done = await engine.runtime.wait(created.id, 60_000);
    engine.bus.flush();
    return { done, gates, baselines, transcript: engine.runtime.transcript(created.id), artifacts: engine.runtime.artifacts(created.id, 'baseline'), changeset: engine.runtime.changeset(created.id) };
  } finally {
    await engine.close();
    await fake.close();
  }
}

test('runtime: {{tests}} runs only tests covering the changeset (unrelated failing test is skipped)', async () => {
  const dir = copy('js-calc');
  writeFileSync(join(dir, 'test/unrelated.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('unrelated', () => assert.fail('always red'));\n");
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ gates: [{ name: 'unit', kind: 'test', command: 'node --test {{tests}}', fallback: 'node --test "test/*.test.js"' }] }));
  const r = await runTask(dir, [
    { toolCalls: [FIX_SUBTRACT], usage: { input: 100, output: 10 } },
    { text: 'Fixed subtract.', usage: { input: 200, output: 5 } },
  ]);
  assert.equal(r.done.status, 'done', r.done.error ?? '');
  assert.deepEqual(r.changeset, ['src/calc.js']);
  assert.equal(r.gates.length, 1);
  assert.deepEqual(r.gates[0].selectedTests, ['test/calc.test.js']);
  assert.equal(r.gates[0].command, 'node --test test/calc.test.js');
});

test('runtime: empty selection runs the fallback command', async () => {
  const dir = copy('js-calc');
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ gates: [{ name: 'unit', kind: 'test', command: 'node --test {{tests}}', fallback: 'node --test "test/*.test.js"' }] }));
  const r = await runTask(dir, [
    { text: 'Nothing to do.', usage: { input: 100, output: 5 } },
    { toolCalls: [FIX_SUBTRACT], usage: { input: 100, output: 10 } },
    { text: 'Fixed.', usage: { input: 200, output: 5 } },
  ]);
  assert.equal(r.done.status, 'done', r.done.error ?? '');
  assert.equal(r.gates[0].command, 'node --test "test/*.test.js"');
  assert.deepEqual(r.gates[0].selectedTests, []);
  assert.equal(r.gates[0].passed, false);
  assert.deepEqual(r.gates[1].selectedTests, ['test/calc.test.js']);
});

test('runtime: baseline labels pre-existing diagnostics; allowPreexisting tolerates old lint debt only', async () => {
  const dir = copy('js-calc');
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ baseline: true, gates: [
    { name: 'legacy', kind: 'lint', command: 'echo "src/legacy.js:3:1: error: legacy debt 42" && exit 1', allowPreexisting: true },
    { name: 'unit', kind: 'test', command: 'node --test "test/*.test.js"' },
  ] }));
  const r = await runTask(dir, [
    { text: 'Done (not really).', usage: { input: 100, output: 5 } },
    { toolCalls: [FIX_SUBTRACT], usage: { input: 200, output: 10 } },
    { text: 'Fixed.', usage: { input: 300, output: 5 } },
  ]);
  assert.equal(r.done.status, 'done', r.done.error ?? '');
  assert.match(r.done.result ?? '', /pre-existing failures only: legacy/);
  assert.equal(r.artifacts.length, 1);
  const base = r.artifacts[0].data as { gates: Array<{ name: string; passed: boolean; keys: string[] }> };
  assert.deepEqual(base.gates.map((g) => `${g.name}:${g.passed}`), ['legacy:false', 'unit:false']);
  assert.equal(r.baselines.length, 1);
  const retry = r.transcript.find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('Verification failed')))!;
  const text = (retry.parts[0] as { text: string }).text;
  assert.match(text, /Gate 'unit'/);
  assert.match(text, /\[pre-existing\]/);
  assert.ok(!text.includes("Gate 'legacy'"), 'tolerated pre-existing failure is not sent as a retry');
  assert.equal(r.gates[0].preexisting, 1);
  assert.equal(r.gates[0].new, 0);
});

test('runtime: allowPreexisting still blocks on new diagnostics', async () => {
  const dir = copy('js-calc');
  mkdirSync(join(dir, '.helix'));
  writeFileSync(join(dir, '.helix/verify.json'), JSON.stringify({ baseline: true, gates: [
    { name: 'legacy', kind: 'lint', command: 'grep -q "a - b" src/calc.js && echo "src/calc.js:6:1: error: new problem" && exit 1; echo "src/legacy.js:3:1: error: legacy debt" && exit 1', allowPreexisting: true },
  ] }));
  const r = await runTask(dir, [
    { toolCalls: [FIX_SUBTRACT], usage: { input: 100, output: 10 } },
    { text: 'Fixed.', usage: { input: 200, output: 5 } },
  ]);
  assert.equal(r.done.status, 'failed');
  assert.match(r.done.error ?? '', /verification failed 3 times/);
  assert.equal(r.gates[0].new, 1);
  const retry = r.transcript.find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('Verification failed')))!;
  assert.match((retry.parts[0] as { text: string }).text, /\[new\] \[generic\] src\/calc\.js:6:1 new problem/);
});
