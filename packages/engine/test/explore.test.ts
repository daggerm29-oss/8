import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

type Body = { systemInstruction?: { parts: Array<{ text: string }> }; contents: unknown[]; tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> };
const systemOf = (b: Body) => b.systemInstruction?.parts.map((p) => p.text).join('') ?? '';
const toolsOf = (b: Body) => (b.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).map((f) => f.name).sort();

test('explore subagent: parent gets the short summary; subagent has only read tools and a fresh brief (F-ORC-1)', async () => {
  const dir = tmp('helix-explore-');
  cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
  const SUMMARY = 'subtract is defined in src/calc.js:5 and tested in test/calc.test.js:5. Suggested files: src/calc.js';
  const parentTurns: FakeTurn[] = [
    { toolCalls: [{ name: 'explore', args: { question: 'Where is subtract defined and tested?' } }], usage: { input: 100, output: 10 } },
    { text: 'Explored.', usage: { input: 200, output: 5 } },
  ];
  const explorerTurns: FakeTurn[] = [
    { toolCalls: [{ name: 'write_file', args: { path: 'pwned.txt', content: 'x' } }, { name: 'find_symbol', args: { name: 'subtract' } }], usage: { input: 50, output: 10 } },
    { text: SUMMARY, usage: { input: 80, output: 30 } },
  ];
  const explorerBodies: Body[] = [];
  let parentIdx = 0;
  let explorerIdx = 0;
  const script: FakeScript = ({ request }) => {
    const body = request.body as Body;
    if (systemOf(body).includes('read-only code explorer subagent')) {
      explorerBodies.push(body);
      return explorerTurns[Math.min(explorerIdx++, explorerTurns.length - 1)];
    }
    return parentTurns[Math.min(parentIdx++, parentTurns.length - 1)];
  };
  const fake = await startFakeProvider('gemini', script);
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false });
  try {
    const t = engine.runtime.create({ workspacePath: dir, goal: 'understand subtract', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'headless', verifyCommand: 'node -e 0' });
    const done = await engine.runtime.wait(t.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');

    assert.equal(explorerBodies.length, 2);
    assert.deepEqual(toolsOf(explorerBodies[0]), ['code_search', 'find_symbol', 'read_file'], 'subagent is offered only read tools');
    assert.equal(explorerBodies[0].contents.length, 1, 'fresh brief: only the question');
    assert.match(JSON.stringify(explorerBodies[0].contents), /Where is subtract defined and tested\?/);
    assert.doesNotMatch(JSON.stringify(explorerBodies[0].contents), /understand subtract/, 'parent goal/transcript not passed');
    const second = JSON.stringify(explorerBodies[1].contents);
    assert.match(second, /not available to the read-only explore subagent/);
    assert.match(second, /src\/calc\.js/, 'find_symbol ran for the subagent');
    assert.equal(existsSync(join(dir, 'pwned.txt')), false, 'write tool was not executed');

    const parentResults = engine.runtime.transcript(t.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as Array<{ name: string; content: string; isError?: boolean }>;
    assert.equal(parentResults.length, 1, 'subagent tool calls stay out of the parent transcript');
    assert.equal(parentResults[0].name, 'explore');
    assert.ok(!parentResults[0].isError);
    assert.equal(parentResults[0].content, SUMMARY);
  } finally {
    await engine.close();
    await fake.close();
  }
});
