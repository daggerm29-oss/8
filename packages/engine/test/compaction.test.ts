import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from '@helix/protocol';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { compactedView, constraintsOf, deterministicSummary, parseSummary, selectCut, type CompactionArtifact } from '../src/context/compaction.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const prov = { source: 'builtin' as const, trust: 'trusted' as const, taint: false };
const u = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });
const a = (id: string, name = 'read_file', args: unknown = { path: 'src/calc.js' }): Message => ({ role: 'assistant', parts: [{ type: 'tool_call', id, name, args }] });
const r = (id: string, content: string, isError = false, name = 'read_file'): Message => ({ role: 'tool', parts: [{ type: 'tool_result', callId: id, name, content, isError, provenance: prov }] });

test('selectCut cuts only at assistant boundaries and keeps the recent turns', () => {
  const msgs = [u('goal'), a('1'), r('1', 'x'), a('2'), r('2', 'y'), a('3'), r('3', 'z')];
  assert.equal(selectCut(msgs, 0, 1), 5);
  assert.equal(selectCut(msgs, 0, 2), 3);
  assert.equal(selectCut(msgs, 0, 3), null);
  assert.equal(selectCut(msgs, 5, 1), null, 'nothing new to compact');
  assert.equal(selectCut(msgs, 0, 0), 5, 'keep is clamped to >= 1 so the current step is never compacted');
  for (const k of [1, 2]) assert.equal(msgs[selectCut(msgs, 0, k)!].role, 'assistant');
});

test('parseSummary validates schema; deterministic fallback and constraints', () => {
  const ok = parseSummary('```json\n{"decisions":["fix subtract"],"factsLearned":[],"filesTouched":[{"path":"src/calc.js","why":"bug"}],"openQuestions":[],"failingChecks":["test 2"],"userPreferences":[]}\n```');
  assert.deepEqual(ok?.filesTouched, [{ path: 'src/calc.js', why: 'bug' }]);
  assert.deepEqual(ok?.decisions, ['fix subtract']);
  assert.equal(parseSummary('not json'), null);
  assert.equal(parseSummary('{"decisions":"nope"}'), null);
  assert.deepEqual(parseSummary('{"decisions":["d"]}')?.factsLearned, [], 'missing keys default to []');

  const msgs = [
    u('Fix subtract. Do not touch tests.'), a('1', 'run_shell', { command: 'npm test' }), r('1', 'FAIL subtract', true, 'run_shell'),
    a('2', 'edit_file', { path: 'src/calc.js', old_string: '+', new_string: '-' }), r('2', 'edited', false, 'edit_file'),
    u('Verification failed (attempt 1/3).\n\nlint error'), u('Also keep the API stable.'),
  ];
  const s = deterministicSummary(msgs);
  assert.deepEqual(s.filesTouched, [{ path: 'src/calc.js', why: 'modified via edit_file' }]);
  assert.ok(s.failingChecks.some((x) => x.includes('FAIL subtract')));
  assert.ok(s.failingChecks.some((x) => x.startsWith('Verification failed')));
  assert.deepEqual(constraintsOf(msgs), ['Fix subtract. Do not touch tests.', 'Also keep the API stable.'], 'user text verbatim, generated prompts excluded');

  const art: CompactionArtifact = { upTo: 3, summary: s, constraints: constraintsOf(msgs, 3), source: 'deterministic', tokensBefore: 10, tokensAfter: 5, ref: { task: 't', fromIndex: 0, toIndex: 3 } };
  const view = compactedView(msgs, art);
  assert.equal(view.length, msgs.length - 3 + 1);
  assert.equal(view[1], msgs[3], 'kept turns start at an assistant message');
  const head = (view[0].parts[0] as { text: string }).text;
  assert.ok(head.includes('Fix subtract. Do not touch tests.') && head.includes('[compacted]') && head.includes('src/calc.js'));
  assert.equal(compactedView(msgs, undefined), msgs);
});

function textOf(body: any): string {
  return JSON.stringify(body?.contents ?? []);
}
const isSummarizer = (body: any) => JSON.stringify(body?.systemInstruction ?? '').includes('You compress');

for (const mode of ['model', 'deterministic'] as const) {
  test(`e2e: long task compacts (${mode} summary); later requests start with the summary + verbatim goal`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-cmp-'));
    cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
    const goal = 'Fix the failing subtract test. KEEP-THIS-CONSTRAINT: never edit tests.';
    const coder: FakeTurn[] = [
      { toolCalls: [{ name: 'run_shell', args: { command: 'node --test "test/*.test.js"' } }], usage: { input: 900, output: 40 } },
      { toolCalls: [{ name: 'read_file', args: { path: 'src/calc.js' } }], usage: { input: 1400, output: 30 } },
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }], usage: { input: 1900, output: 60 } },
      { toolCalls: [{ name: 'run_shell', args: { command: 'node --test "test/*.test.js"' } }], usage: { input: 2100, output: 30 } },
      { text: 'Fixed subtract in src/calc.js.', usage: { input: 2600, output: 25 } },
    ];
    const coderBodies: any[] = [];
    let summaries = 0;
    const fake = await startFakeProvider('gemini', ({ request }) => {
      if (isSummarizer(request.body)) {
        summaries++;
        return mode === 'model'
          ? { text: JSON.stringify({ decisions: ['SUMMARY-MARKER'], factsLearned: [], filesTouched: [{ path: 'src/calc.js', why: 'subtract bug' }], openQuestions: [], failingChecks: [], userPreferences: [] }), usage: { input: 300, output: 50 } }
          : { text: 'sorry, here is prose instead of JSON', usage: { input: 300, output: 10 } };
      }
      coderBodies.push(request.body);
      return coder[Math.min(coderBodies.length - 1, coder.length - 1)];
    });
    const engine = new Engine({
      home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url },
      retry: { baseDelayMs: 1, maxDelayMs: 5 }, taskRetryScale: 0.001, mcp: false, compaction: { triggerTokens: 1, keepRecentTurns: 1, minSliceTokens: 0 },
    });
    try {
      const t = engine.runtime.create({ workspacePath: dir, goal, model: 'gemini-3.8-flash', verifyCommand: 'node --test "test/*.test.js"', preapprove: ['exec', 'write'] });
      const s = await engine.runtime.wait(t.id, 60_000);
      assert.equal(s.status, 'done', s.error ?? '');
      assert.match(readFileSync(join(dir, 'src/calc.js'), 'utf8'), /return a - b;/);
      const arts = engine.runtime.artifacts(t.id, 'compaction').map((x) => x.data as CompactionArtifact);
      assert.ok(arts.length >= 1, 'expected at least one compaction');
      assert.ok(summaries >= arts.length);
      for (const art of arts) {
        assert.equal(art.source, mode);
        assert.ok(art.constraints.includes(goal));
        assert.ok(art.tokensAfter < art.tokensBefore, `${art.tokensAfter} < ${art.tokensBefore}`);
      }
      assert.ok(arts.every((x, i) => i === 0 || x.upTo > arts[i - 1].upTo), 'cut moves forward');
      if (mode === 'deterministic') assert.match(arts[0].error ?? '', /not valid summary JSON/);
      const last = coderBodies.at(-1);
      const first = last.contents[0];
      assert.equal(first.role, 'user');
      const head = JSON.stringify(first.parts);
      assert.ok(head.includes('[compacted]') && head.includes('KEEP-THIS-CONSTRAINT'), head);
      if (mode === 'model') assert.ok(head.includes('SUMMARY-MARKER'));
      assert.equal(last.contents[1].role, 'model', 'kept window starts at a model turn');
      assert.ok(textOf(last).length < textOf(coderBodies[3]).length + 2000);
      assert.equal(engine.runtime.transcript(t.id)[0].parts[0].type === 'text' && (engine.runtime.transcript(t.id)[0].parts[0] as { text: string }).text, goal, 'originals kept');
      const ledger = engine.ledger.totals({ task: t.id });
      assert.equal(ledger.calls, coderBodies.length + summaries, 'summarizer calls are on the ledger');
    } finally {
      await engine.close();
      await fake.close();
    }
  });
}
