import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { exportBundle, type SessionBundle } from '../src/replay/bundle.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

test('session bundle + deterministic replay: identical run offline, no side effects, divergences reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-replay-'));
  cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
  const original = readFileSync(join(dir, 'src/calc.js'), 'utf8');
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/calc.js' } }], usage: { input: 900, output: 30 } },
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }], usage: { input: 1400, output: 60 } },
    { toolCalls: [{ name: 'run_shell', args: { command: `echo token=${TOKEN} && node --test "test/*.test.js"` } }], usage: { input: 1900, output: 30 } },
    { text: 'Fixed subtract.', usage: { input: 2300, output: 20 } },
  ];
  let i = 0;
  const fake = await startFakeProvider('gemini', () => turns[Math.min(i++, turns.length - 1)]);
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, mcp: false } as never);
  try {
    const t = engine.runtime.create({ workspacePath: dir, goal: 'Fix the failing subtract test.', preapprove: ['exec', 'write'] });
    const s = await engine.runtime.wait(t.id, 60_000);
    assert.equal(s.status, 'done', s.error ?? '');
    const callsAfterRecording = i;

    const bundle = exportBundle(engine.db, t.id);
    assert.equal(bundle.models.length, 4);
    assert.deepEqual(bundle.tools.map((x) => `${x.tool}:${x.status}`), ['read_file:ok', 'edit_file:ok', 'run_shell:ok']);
    assert.deepEqual(bundle.timeline.map((e) => e.kind), ['model', 'tool', 'model', 'tool', 'model', 'tool', 'model']);
    assert.ok(bundle.models.every((m) => m.ref === `gemini/${t.model}` && /^step=edit tier=/.test(m.routerReason ?? '')), 'ledger ref + router reason per model turn');
    assert.match(bundle.tools[0].content, /export function subtract/);
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes(TOKEN), 'secret-looking token excluded from the bundle');
    assert.match(text, /\[REDACTED:github-token\]/);

    // Deterministic replay: restore the original file to prove replayed tools have no side effects.
    writeFileSync(join(dir, 'src/calc.js'), original);
    const report = await engine.runtime.replay(bundle);
    assert.equal(report.identical, true, report.divergence ?? '');
    assert.deepEqual(report.modelTurns, { recorded: 4, replayed: 4 });
    assert.deepEqual(report.toolCalls, { recorded: 3, replayed: 3 });
    assert.equal(report.finalTextMatches, true);
    assert.equal(i, callsAfterRecording, 'replay made no provider calls');
    assert.equal(readFileSync(join(dir, 'src/calc.js'), 'utf8'), original, 'replay did not touch the workspace');
    assert.equal(engine.runtime.artifacts(report.task, 'replay').length, 1);
    const profileOf = (id: string) => engine.db.get<{ policy_profile: string }>('SELECT policy_profile FROM tasks WHERE id = ?', id)?.policy_profile;
    assert.equal(profileOf(report.task), profileOf(t.id), 'replay keeps the recorded policy profile');

    // Interactive recording without preapprovals: approvals are answered from the recording, not forced to headless denials.
    const interactive = await engine.runtime.replay({ ...bundle, task: { ...bundle.task, policyProfile: 'interactive', preapprove: [] } });
    assert.equal(interactive.identical, true, interactive.divergence ?? '');
    assert.equal(profileOf(interactive.task), 'interactive');
    // A human denied the shell command in an interactive session: replaying as interactive reproduces the denial,
    // while the old forced-headless replay (exec allowed) would diverge.
    const deniedShell = { ...bundle, tools: bundle.tools.map((x) => (x.tool === 'run_shell' ? { ...x, status: 'denied' } : x)) } as SessionBundle;
    const asRecorded = await engine.runtime.replay({ ...deniedShell, task: { ...bundle.task, policyProfile: 'interactive', preapprove: [] } });
    assert.equal(asRecorded.identical, true, asRecorded.divergence ?? '');
    const asHeadless = await engine.runtime.replay({ ...deniedShell, task: { ...bundle.task, policyProfile: 'headless', preapprove: [] } });
    assert.match(asHeadless.divergence ?? '', /run_shell was denied in the recording but is allowed now/);
    await assert.rejects(engine.runtime.replay({ ...bundle, task: { ...bundle.task, policyProfile: 'yolo' } }), /unknown policy profile/);

    // Policy differs from the recording's harness (edit_file was denied there, allowed now) → divergence at tool call 2.
    const stricter = { ...bundle, tools: bundle.tools.map((x) => (x.index === 1 ? { ...x, status: 'denied' } : x)) } as SessionBundle;
    const policy = await engine.runtime.replay(stricter);
    assert.equal(policy.identical, false);
    assert.match(policy.divergence ?? '', /tool call 2: edit_file was denied in the recording but is allowed now/);
    assert.equal(readFileSync(join(dir, 'src/calc.js'), 'utf8'), original, 'divergence stops before any tool runs');

    // Truncated recording: the loop asks for a 4th model turn that does not exist.
    const short = await engine.runtime.replay({ ...bundle, models: bundle.models.slice(0, 3) });
    assert.equal(short.identical, false);
    assert.match(short.divergence ?? '', /model turn 4 requested but the recording has only 3/);
    assert.equal(i, callsAfterRecording, 'still no provider calls');
  } finally {
    await engine.close();
    await fake.close();
  }
});
