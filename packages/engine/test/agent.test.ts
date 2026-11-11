import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Methods, PROTOCOL_VERSION, RpcPeer, streamTransport, type TaskSummary } from '@helix/protocol';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const MODEL = 'gemini-3.8-flash';

/** Each fixture: its verify command and the minimal fix a scripted model applies (fake model = plumbing only). */
export const FIXTURE_SPECS = [
  { name: 'js-calc', verify: 'node --test "test/*.test.js"', file: 'src/calc.js', old: 'export function subtract(a, b) {\n  return a + b;', new: 'export function subtract(a, b) {\n  return a - b;' },
  { name: 'py-strings', verify: 'python3 -m unittest -q', file: 'strings_util.py', old: 'return "-".join(words)', new: 'return "-".join(w.lower() for w in words)' },
  { name: 'ts-inventory', verify: 'node --test "test/*.test.ts"', file: 'src/inventory.ts', old: 'i < items.length - 1', new: 'i < items.length' },
];

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `helix-fx-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

function solver(spec: (typeof FIXTURE_SPECS)[number]): FakeTurn[] {
  return [
    { toolCalls: [{ name: 'run_shell', args: { command: spec.verify } }], usage: { input: 900, output: 40 } },
    { toolCalls: [{ name: 'read_file', args: { path: spec.file } }], usage: { input: 1400, cached: 800, output: 30 } },
    { toolCalls: [{ name: 'edit_file', args: { path: spec.file, old_string: spec.old, new_string: spec.new } }], usage: { input: 1900, cached: 1300, output: 60, reasoning: 20 } },
    { toolCalls: [{ name: 'run_shell', args: { command: spec.verify } }], usage: { input: 2100, cached: 1800, output: 30 } },
    { text: `Fixed the bug in ${spec.file}.`, usage: { input: 2600, cached: 2000, output: 25 } },
  ];
}

const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

function engineFor(url: string, apiKey: string, home = mkdtempSync(join(tmpdir(), 'helix-home-'))): Engine {
  return new Engine({ home, env: { GEMINI_API_KEY: apiKey, HELIX_GEMINI_BASE_URL: url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, taskRetryScale: 0.001 });
}

for (const spec of FIXTURE_SPECS) {
  test(`[exit-1/fake] agent fixes the seeded failing test in ${spec.name} inside the sandbox; ledger reconciles`, async () => {
    const fake = await startFakeProvider('gemini', scripted(solver(spec)));
    const engine = engineFor(fake.url, fake.apiKey);
    try {
      const dir = copyFixture(spec.name);
      const created = engine.runtime.create({ workspacePath: dir, goal: 'The test suite is failing. Fix the bug.', provider: 'gemini', model: MODEL, verifyCommand: spec.verify });
      const done = await engine.runtime.wait(created.id, 60_000);
      assert.equal(done.status, 'done', done.error ?? '');
      assert.ok(readFileSync(join(dir, spec.file), 'utf8').includes(spec.new));
      const t = engine.ledger.totals({ task: created.id });
      assert.deepEqual(
        { calls: t.calls, input: t.inputTokens, cached: t.cachedInputTokens, output: t.outputTokens, reasoning: t.reasoningTokens },
        { calls: fake.reported.calls, input: fake.reported.input, cached: fake.reported.cached, output: fake.reported.output, reasoning: fake.reported.reasoning },
        'exit-2: ledger totals equal provider-reported usage',
      );
      const sbx = engine.db.get<{ state: string; provider: string }>('SELECT state, provider FROM sandboxes WHERE ws = ?', done.workspaceId)!;
      assert.equal(sbx.state, 'destroyed');
      assert.equal(engine.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM checkpoints WHERE task = ? AND files_json != '[]'", created.id)!.n, 1);
      assert.equal(engine.bus.verifyAuditChain(), null);
    } finally {
      await engine.close();
      await fake.close();
    }
  });
}

test('verification gate feeds failures back to the model and retries', async () => {
  const spec = FIXTURE_SPECS[0];
  const fake = await startFakeProvider('gemini', scripted([
    { text: 'I think it is fine.', usage: { input: 500, output: 10 } },
    { toolCalls: [{ name: 'edit_file', args: { path: spec.file, old_string: spec.old, new_string: spec.new } }], usage: { input: 900, output: 30 } },
    { text: 'Fixed subtract.', usage: { input: 1200, output: 10 } },
  ]));
  const engine = engineFor(fake.url, fake.apiKey);
  try {
    const created = engine.runtime.create({ workspacePath: copyFixture(spec.name), goal: 'fix tests', provider: 'gemini', model: MODEL, verifyCommand: spec.verify });
    const done = await engine.runtime.wait(created.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.verifyAttempts, 2);
    const feedback = engine.runtime.transcript(created.id).find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('Verification failed')));
    assert.ok(feedback, 'diagnostics are fed back');
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('headless policy denies destructive commands; the denial is returned to the model and audited', async () => {
  const fake = await startFakeProvider('gemini', scripted([
    { toolCalls: [{ name: 'run_shell', args: { command: 'git push origin main' } }], usage: { input: 100, output: 10 } },
    { text: 'Could not push.', usage: { input: 200, output: 10 } },
  ]));
  const engine = engineFor(fake.url, fake.apiKey);
  try {
    const created = engine.runtime.create({ workspacePath: copyFixture('js-calc'), goal: 'push', provider: 'gemini', model: MODEL });
    const done = await engine.runtime.wait(created.id, 30_000);
    assert.equal(done.status, 'done');
    const row = engine.db.get<{ status: string }>('SELECT status FROM tool_calls WHERE task = ?', created.id)!;
    assert.equal(row.status, 'denied');
    const result = engine.runtime.transcript(created.id).flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result' && result.isError && /denied by policy/.test(result.content));
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('interactive approvals block until agent.approve and the transient overload backoff keeps the task alive', async () => {
  let overloads = 0;
  const fake = await startFakeProvider('gemini', ({ index }) => {
    if (index === 0 && overloads++ < 1) return { error: { status: 503, body: { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } } } };
    return [{ toolCalls: [{ name: 'run_shell', args: { command: 'echo approved-run' } }], usage: { input: 100, output: 10 } }, { text: 'ran it', usage: { input: 150, output: 5 } }][Math.min(index - 1, 1)] ?? { text: 'ran it', usage: { input: 1, output: 1 } };
  });
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { maxRetries: 0, baseDelayMs: 1 }, taskRetryScale: 0.001 });
  try {
    const requested = new Promise<string>((resolve) => engine.bus.subscribe('approval.requested', (e) => resolve((e.data as { approvalId: string }).approvalId)));
    const created = engine.runtime.create({ workspacePath: copyFixture('js-calc'), goal: 'run echo', provider: 'gemini', model: MODEL, policyProfile: 'interactive' });
    const approvalId = await requested;
    assert.equal(engine.runtime.summary(created.id).status, 'awaiting_approval');
    engine.runtime.approve(approvalId, true);
    const done = await engine.runtime.wait(created.id, 30_000);
    assert.equal(done.status, 'done', done.error ?? '');
    const result = engine.runtime.transcript(created.id).flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result' && result.content.includes('approved-run'));
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('[exit-3] SIGKILLed engine: a new engine resumes the task without repeating completed tool calls', async (t) => {
  const spec = FIXTURE_SPECS[2];
  const turns = solver(spec);
  // Turn 3 (the post-edit test run) hangs so the engine is killed mid-model-call after the edit was persisted.
  const fake = await startFakeProvider('gemini', ({ index }) => (index === 3 && !resumed ? { ...turns[3], delayMs: 8_000 } : turns[Math.min(index, turns.length - 1)]));
  t.after(() => fake.close());
  let resumed = false;
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const dir = copyFixture(spec.name);
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main, '--stdio'], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HELIX_HOME: home, GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url },
  });
  const peer = new RpcPeer(streamTransport(child.stdout!, child.stdin!));
  let taskId = '';
  try {
    await peer.request(Methods.initialize, { clientName: 'test', clientVersion: '0', protocolVersion: PROTOCOL_VERSION }, 20_000);
    const created = await peer.request<TaskSummary>(Methods.taskCreate, { workspacePath: dir, goal: 'fix', provider: 'gemini', model: MODEL, verifyCommand: spec.verify });
    taskId = created.id;
    const deadline = Date.now() + 30_000;
    while (fake.requests.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.requests.length, 4, 'engine reached the hanging 4th model call');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  assert.ok(readFileSync(join(dir, spec.file), 'utf8').includes(spec.new), 'edit happened before the crash');

  resumed = true;
  const engine = engineFor(fake.url, fake.apiKey, home);
  try {
    assert.ok(engine.runtime.isRunning(taskId), 'recover() resumed the task on open');
    const done = await engine.runtime.wait(taskId, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    const edits = engine.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tool_calls WHERE task = ? AND tool = 'edit_file'`, taskId)!.n;
    assert.equal(edits, 1, 'completed tool calls are not repeated');
    const okCalls = engine.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_entries WHERE task = ? AND status = 'ok'`, taskId)!.n;
    assert.equal(okCalls, fake.reported.calls, 'every completed model turn is billed exactly once; the killed call is not double-counted');
    assert.ok(engine.db.get(`SELECT 1 FROM events WHERE task = ? AND topic = 'task.resumed'`, taskId));
  } finally {
    await engine.close();
  }
});

test('[exit-4] SIGKILLed engine mid write-leased tool call: recovery expires the dead owner lease and resumes immediately (NFR-4)', async (t) => {
  const fake = await startFakeProvider('gemini', ({ request }) => JSON.stringify(request.body).includes('lease-resumed')
    ? { text: 'done after resume' }
    : { toolCalls: [{ name: 'run_shell', args: { command: 'sleep 3 && echo lease-resumed' } }] });
  t.after(() => fake.close());
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const dir = copyFixture('js-calc');
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main, '--stdio'], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HELIX_HOME: home, GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url },
  });
  const peer = new RpcPeer(streamTransport(child.stdout!, child.stdin!));
  let taskId = '';
  try {
    await peer.request(Methods.initialize, { clientName: 'test', clientVersion: '0', protocolVersion: PROTOCOL_VERSION }, 20_000);
    taskId = (await peer.request<TaskSummary>(Methods.taskCreate, { workspacePath: dir, goal: 'leased shell', provider: 'gemini', model: MODEL, policyProfile: 'headless' })).id;
    const deadline = Date.now() + 30_000;
    let held = false;
    while (!held && Date.now() < deadline) {
      const activity = await peer.request<{ leases: { state: string }[] }>('task.activity', { task: taskId });
      held = activity.leases.some((l) => l.state === 'held');
      if (!held) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(held, 'run_shell holds the workspace write lease');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const started = Date.now();
  const engine = engineFor(fake.url, fake.apiKey, home);
  try {
    assert.ok(engine.runtime.isRunning(taskId), 'recover() resumed the task on open');
    const done = await engine.runtime.wait(taskId, 30_000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.ok(Date.now() - started < 20_000, `resumed without waiting for the 60 s lease expiry (${Date.now() - started} ms)`);
    const leases = engine.db.all<{ state: string }>('SELECT state FROM activity_leases WHERE task = ? ORDER BY acquired_at', taskId);
    assert.deepEqual(leases.map((l) => l.state), ['expired', 'released']);
    const resumedEvent = engine.db.get<{ data_json: string }>(`SELECT data_json FROM events WHERE task = ? AND topic = 'task.resumed'`, taskId);
    assert.equal(JSON.parse(resumedEvent!.data_json).expiredLeases, 1);
  } finally {
    await engine.close();
  }
});
