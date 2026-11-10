import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { extract } from '../src/index/extract.ts';
import { loadInstructions } from '../src/context/instructions.ts';
import { assembleContext } from '../src/context/assembler.ts';
import { parseDiagnostics } from '../src/diagnostics/parsers.ts';
import { LocalSandbox } from '../src/sandbox/sandbox.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const copy = (name: string) => { const d = tmp(`helix-m1-${name}-`); cpSync(join(FIXTURES, name), d, { recursive: true }); return d; };
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

test('diagnostics: tsc, node:test, unittest, pytest, eslint, generic, and tracebacks parse to structured items', () => {
  const tsc = parseDiagnostics('npx tsc --noEmit', "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts:3:1 - error TS2304: Cannot find name 'x'.");
  assert.deepEqual(tsc.map((d) => [d.file, d.line, d.code]), [['src/a.ts', 12, 'TS2322'], ['src/b.ts', 3, 'TS2304']]);

  const nodeOut = `not ok 1 - subtract returns the difference
  ---
  duration_ms: 1.2
  location: '/w/test/calc.test.js:5:1'
  failureType: 'testCodeFailure'
  error: 'Expected values to be strictly equal:\\n\\n5 !== 1\\n'
  expected: 1
  actual: 5
  ...`;
  const n = parseDiagnostics('node --test "test/*.test.js"', nodeOut, { root: '/w' });
  assert.equal(n.length, 1);
  assert.equal(n[0].file, 'test/calc.test.js');
  assert.equal(n[0].line, 5);
  assert.match(n[0].message, /subtract returns the difference/);
  assert.match(n[0].detail ?? '', /expected 1 · actual 5/);

  const ut = parseDiagnostics('python3 -m unittest -q', `======================================================================
FAIL: test_slug (test_strings_util.T.test_slug)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/w/test_strings_util.py", line 7, in test_slug
    self.assertEqual(slugify("Hello World"), "hello-world")
AssertionError: 'Hello-World' != 'hello-world'
`, { root: '/w' });
  assert.equal(ut[0].file, 'test_strings_util.py');
  assert.equal(ut[0].line, 7);
  assert.match(ut[0].message, /AssertionError/);

  const py = parseDiagnostics('pytest -q', 'FAILED tests/test_x.py::test_add - assert 3 == 4');
  assert.equal(py[0].file, 'tests/test_x.py');

  const es = parseDiagnostics('eslint .', 'src/app.js\n  10:3  error  Unexpected console statement  no-console\n');
  assert.deepEqual([es[0].file, es[0].line, es[0].code], ['src/app.js', 10, 'no-console']);

  const gen = parseDiagnostics('make', 'lib/x.c:4:2: error: expected ;');
  assert.equal(gen[0].file, 'lib/x.c');
  assert.equal(parseDiagnostics('make', 'all good').length, 0);
});

test('extractor: TS/Python/Go/Rust symbols with ranges, nesting, exports, and imports', () => {
  const ts = extract('ts', `import { a } from './a';
export interface Item { sku: string }
export class Inventory {
  private items: Item[] = [];
  add(item: Item): void {
    this.items.push(item);
  }
  total(): number {
    return 1;
  }
}
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function helper() {
  return 2;
}
`);
  const names = ts.symbols.map((s) => `${s.kind}:${s.qualifiedName}:${s.line}-${s.endLine}:${s.exported ? 'e' : '-'}`);
  assert.deepEqual(names, ['interface:Item:2-2:e', 'class:Inventory:3-11:e', 'method:Inventory.add:5-7:-', 'method:Inventory.total:8-10:-', 'function:sum:12-12:e', 'function:helper:13-15:-']);
  assert.deepEqual(ts.imports, ['./a']);

  const py = extract('py', 'import os\nfrom .util import x\n\nclass Slug:\n    def run(self):\n        return 1\n\ndef slugify(s):\n    return s\n');
  assert.deepEqual(py.symbols.map((s) => `${s.kind}:${s.qualifiedName}`), ['class:Slug', 'method:Slug.run', 'function:slugify']);
  assert.deepEqual(py.imports.sort(), ['.util', 'os']);

  const go = extract('go', 'package main\nfunc (s *Server) Start() error {\n  return nil\n}\ntype Server struct {\n}\n');
  assert.deepEqual(go.symbols.map((s) => `${s.kind}:${s.name}:${s.exported}`), ['method:Start:true', 'struct:Server:true']);

  const rs = extract('rs', 'pub fn parse(x: &str) -> u8 {\n  0\n}\nstruct Inner;\n');
  assert.deepEqual(rs.symbols.map((s) => `${s.kind}:${s.name}:${s.exported}`), ['function:parse:true', 'struct:Inner:false']);
});

test('index: incremental by content hash, symbol lookup, import edges, covering tests, hybrid search, secret files skipped', () => {
  const dir = copy('ts-inventory');
  writeFileSync(join(dir, '.env'), 'SECRET=hunter2');
  const db = new Db(':memory:');
  db.run(`INSERT INTO workspace (id, path, created_at) VALUES ('ws1', ?, 'now')`, dir);
  const idx = new WorkspaceIndex(db, 'ws1', dir);
  const first = idx.update();
  assert.ok(first.indexed >= 2, `indexed ${first.indexed}`);
  assert.ok(!db.get(`SELECT 1 FROM idx_files WHERE path = '.env'`), 'secret file must not be indexed');
  const second = idx.update();
  assert.equal(second.indexed, 0);
  assert.equal(second.unchanged, first.indexed);

  const src = readFileSync(join(dir, 'src/inventory.ts'), 'utf8');
  const firstSymbol = extract('ts', src).symbols[0];
  const hits = idx.findSymbol(firstSymbol.name);
  assert.equal(hits[0].path, 'src/inventory.ts');
  const tests = idx.coveringTests('src/inventory.ts');
  assert.ok(tests.some((t) => t.startsWith('test/')), `covering tests: ${tests}`);

  const results = idx.search(`${firstSymbol.name} in inventory.ts`);
  assert.equal(results[0].path, 'src/inventory.ts');
  assert.ok(results[0].why.length >= 2, `fused retrievers: ${results[0].why}`);

  writeFileSync(join(dir, 'src/extra.ts'), 'export function computeDiscountRate(total: number) {\n  return total > 100 ? 0.1 : 0;\n}\n');
  const third = idx.update();
  assert.equal(third.indexed, 1);
  assert.equal(idx.search('discount rate')[0].path, 'src/extra.ts');
  assert.ok(idx.repoMap().includes('src/extra.ts: computeDiscountRate'));
  db.close();
});

test('instructions + assembler: AGENTS.md, user HELIX.md, nested files, truncation, and budgeted composition', () => {
  const dir = copy('js-calc');
  const home = tmp('helix-home-');
  writeFileSync(join(home, 'HELIX.md'), 'Prefer small diffs.');
  writeFileSync(join(dir, 'AGENTS.md'), 'Use ESM only. Run node --test.');
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'src', 'AGENTS.md'), 'src rule');
  const ins = loadInstructions(dir, { helixHome: home, touchedPaths: ['src/deep/x.js'] });
  assert.deepEqual(ins.sources.map((s) => s.scope), ['user', 'repo', 'nested']);
  assert.ok(ins.text.indexOf('Prefer small diffs') < ins.text.indexOf('Use ESM only') && ins.text.indexOf('Use ESM only') < ins.text.indexOf('src rule'));
  writeFileSync(join(dir, 'HELIX.md'), 'x'.repeat(20_000));
  assert.ok(loadInstructions(dir).warnings.length === 1);

  const db = new Db(':memory:');
  db.run(`INSERT INTO workspace (id, path, created_at) VALUES ('ws1', ?, 'now')`, dir);
  const idx = new WorkspaceIndex(db, 'ws1', dir);
  idx.update();
  const c = assembleContext({ goal: 'subtract returns the wrong value', index: idx, instructions: ins, budgetTokens: 3000 });
  assert.ok(c.usedTokens <= c.budgetTokens);
  assert.ok(c.text.includes('Use ESM only'));
  assert.ok(c.text.includes('src/calc.js'));
  assert.ok(c.items.some((i) => i.kind === 'file_slice' && i.ref.startsWith('src/calc.js')));
  db.close();
});

test('runtime: composed context is in the system prompt, persisted, and context.composed is emitted; restore undoes the task', async () => {
  const dir = copy('js-calc');
  writeFileSync(join(dir, 'AGENTS.md'), 'HOUSE RULE: keep functions pure.');
  const original = readFileSync(join(dir, 'src/calc.js'), 'utf8');
  let systemSeen = '';
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'find_symbol', args: { name: 'subtract' } }], usage: { input: 500, output: 20 } },
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'return a + b;\n}\n\nexport function multiply', new_string: 'return a - b;\n}\n\nexport function multiply' } }, { name: 'write_file', args: { path: 'NOTES.md', content: 'tmp' } }], usage: { input: 900, output: 40 } },
    { text: 'Fixed subtract.', usage: { input: 1000, output: 10 } },
  ];
  const fake = await startFakeProvider('gemini', (ctx) => {
    const body = ctx.request.body as { systemInstruction?: { parts: Array<{ text: string }> } };
    systemSeen = body.systemInstruction?.parts.map((p) => p.text).join('') ?? systemSeen;
    return scripted(turns)(ctx);
  });
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, taskRetryScale: 0.001 });
  try {
    const events: string[] = [];
    engine.bus.subscribe('context.*', (e) => { events.push(e.topic); });
    const created = engine.runtime.create({ workspacePath: dir, goal: 'subtract is wrong', provider: 'gemini', model: 'gemini-3.8-flash', verifyCommand: 'node --test "test/*.test.js"' });
    const done = await engine.runtime.wait(created.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.match(systemSeen, /HOUSE RULE: keep functions pure/);
    assert.match(systemSeen, /Repository map/);
    engine.bus.flush();
    assert.ok(events.includes('context.composed'));
    assert.equal(engine.runtime.artifacts(created.id, 'context').length, 1);
    const toolRows = engine.db.all<{ tool: string; summary: string }>('SELECT tool, summary FROM tool_calls WHERE task = ?', created.id);
    assert.match(toolRows.find((r) => r.tool === 'find_symbol')!.summary, /find_symbol subtract: [1-9]/);

    const cps = engine.runtime.checkpoints(created.id);
    assert.equal(cps.length, 2);
    assert.deepEqual(cps.map((c) => c.files[0]), [{ path: 'src/calc.js', created: false }, { path: 'NOTES.md', created: true }]);
    const r = engine.runtime.restore(created.id);
    assert.deepEqual(r.restored, ['src/calc.js']);
    assert.deepEqual(r.deleted, ['NOTES.md']);
    assert.equal(readFileSync(join(dir, 'src/calc.js'), 'utf8'), original);
    assert.ok(!existsSync(join(dir, 'NOTES.md')));
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('plan mode: write tools absent, submit_plan produces a plan artifact, workspace untouched', async () => {
  const dir = copy('js-calc');
  const before = readFileSync(join(dir, 'src/calc.js'), 'utf8');
  let toolNames: string[] = [];
  const plan = { goal: 'fix subtract', affectedFiles: [{ path: 'src/calc.js', reason: 'subtract adds', evidence: 'calc.js:subtract' }, { path: 'src/new.js', reason: 'new helper' }], steps: [{ id: 's1', description: 'change + to -', writeSet: ['src/calc.js'] }], verification: ['node --test'] };
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'code_search', args: { query: 'subtract' } }], usage: { input: 300, output: 10 } },
    { toolCalls: [{ name: 'submit_plan', args: plan }], usage: { input: 600, output: 80 } },
    { text: 'Plan: change subtract.', usage: { input: 700, output: 10 } },
  ];
  const fake = await startFakeProvider('gemini', (ctx) => {
    const body = ctx.request.body as { tools?: Array<{ functionDeclarations: Array<{ name: string }> }> };
    toolNames = body.tools?.flatMap((t) => t.functionDeclarations.map((f) => f.name)) ?? toolNames;
    return scripted(turns)(ctx);
  });
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 } });
  try {
    const created = engine.runtime.create({ workspacePath: dir, goal: 'plan the subtract fix', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'plan', verifyCommand: 'node --test "test/*.test.js"' });
    const done = await engine.runtime.wait(created.id, 30_000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.ok(toolNames.includes('submit_plan') && !toolNames.includes('edit_file') && !toolNames.includes('run_shell'), `tools: ${toolNames}`);
    const arts = engine.runtime.artifacts(created.id, 'plan');
    assert.equal(arts.length, 1);
    assert.deepEqual((arts[0].data as { unverifiedPaths: string[] }).unverifiedPaths, ['src/new.js']);
    assert.equal(readFileSync(join(dir, 'src/calc.js'), 'utf8'), before);
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('verify retry prompt carries structured diagnostics instead of the raw log', async () => {
  const dir = copy('js-calc');
  const turns: FakeTurn[] = [
    { text: 'Done (but not really).', usage: { input: 100, output: 5 } },
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'return a + b;\n}\n\nexport function multiply', new_string: 'return a - b;\n}\n\nexport function multiply' } }], usage: { input: 200, output: 20 } },
    { text: 'Fixed.', usage: { input: 300, output: 5 } },
  ];
  const fake = await startFakeProvider('gemini', scripted(turns));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 } });
  try {
    const created = engine.runtime.create({ workspacePath: dir, goal: 'fix it', provider: 'gemini', model: 'gemini-3.8-flash', verifyCommand: 'node --test "test/*.test.js"' });
    const done = await engine.runtime.wait(created.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    const retry = engine.runtime.transcript(created.id).find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('Verification failed')))!;
    const text = (retry.parts[0] as { text: string }).text;
    assert.match(text, /Diagnostics \(\d+\):\n- \[node-test\] test\/calc\.test\.js:\d+/);
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('sandbox root is reported for diagnostics path relativization', () => {
  const dir = copy('js-calc');
  const sbx = new LocalSandbox('sbx_t', dir);
  try {
    assert.ok(sbx.root.length > 0);
  } finally {
    sbx.destroy();
  }
});
