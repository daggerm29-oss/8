import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { mutants } from '../src/verify/testgen.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));

const header = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from '../src/calc.js';\n";
const VACUOUS = `${header}test('divide exists', () => assert.equal(typeof divide, 'function'));\n`;
const FAILING = `${header}test('divide', () => assert.equal(divide(1, 2), 1));\n`;
const GOOD = `${header}test('divide', () => { assert.equal(divide(9, 3), 3); assert.throws(() => divide(1, 0), RangeError); });\n`;

test('mutants: one per flippable operator, limited to the range, comments skipped', () => {
  const src = 'export function f(a, b) {\n  // a === b\n  if (a === b) return true;\n  return a < b && b > 0;\n}\nconst x = 1 + 2;';
  const m = mutants(src, { start: 1, end: 5 });
  assert.deepEqual(m.map((x) => `${x.line}:${x.from}→${x.to}`), ['3:===→!==', '3:return true→return false', '4:<→>=', '4:>→<=', '4:&&→||']);
  assert.match(m[0].source.split('\n')[2], /a !== b/);
  assert.equal(m[0].source.split('\n')[1], '  // a === b');
});

test('propose_test: vacuous and failing tests rejected, a killing test is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-testgen-'));
  cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
  const propose = (path: string, content: string) => ({ toolCalls: [{ name: 'propose_test', args: { path, content, target: 'src/calc.js', symbol: 'divide' } }], usage: { input: 800, output: 60 } });
  const turns: FakeTurn[] = [
    propose('test/vacuous.test.js', VACUOUS),
    propose('test/failing.test.js', FAILING),
    propose('test/divide.test.js', GOOD),
    { text: 'Added a divide test.', usage: { input: 1200, output: 10 } },
  ];
  let i = 0;
  const fake = await startFakeProvider('gemini', () => turns[Math.min(i++, turns.length - 1)]);
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, mcp: false } as never);
  try {
    const t = engine.runtime.create({ workspacePath: dir, goal: 'Add a unit test for divide.', verifyCommand: 'node --test test/divide.test.js', preapprove: ['exec', 'write'] });
    const s = await engine.runtime.wait(t.id, 60_000);
    assert.equal(s.status, 'done', s.error ?? '');
    const results = engine.runtime.transcript(t.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && (p as { name?: string }).name === 'propose_test') as Array<{ content: string; isError?: boolean }>;
    assert.equal(results.length, 3);

    assert.equal(results[0].isError, true);
    assert.match(results[0].content, /^REJECTED: test\/vacuous\.test\.js not written — vacuous: the test still passes with all 2 mutants/);
    assert.match(results[0].content, /src\/calc\.js:14 '==='→'!==': survived/);
    assert.match(results[0].content, /src\/calc\.js:15 '\/'→'\*': survived/);
    assert.equal(existsSync(join(dir, 'test/vacuous.test.js')), false);

    assert.equal(results[1].isError, true);
    assert.match(results[1].content, /does not pass against the current code/);
    assert.equal(existsSync(join(dir, 'test/failing.test.js')), false);

    assert.ok(!results[2].isError, results[2].content);
    assert.match(results[2].content, /^ACCEPTED: wrote test\/divide\.test\.js — 2\/2 mutants killed/);
    assert.equal(readFileSync(join(dir, 'test/divide.test.js'), 'utf8'), GOOD);
    assert.match(readFileSync(join(dir, 'src/calc.js'), 'utf8'), /if \(b === 0\)/, 'target restored');
    assert.deepEqual(existsSync(join(dir, '.helix/scratch')) ? readdirSync(join(dir, '.helix/scratch')) : [], [], 'scratch copies removed');
    assert.equal(engine.runtime.changeset(t.id).filter((p) => p.endsWith('test/divide.test.js')).length, 1, 'write checkpointed');
  } finally {
    await engine.close();
    await fake.close();
  }
});
