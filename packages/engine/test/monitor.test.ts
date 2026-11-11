import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type FakeScript } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import type { TaskActivity } from '@helix/protocol';

async function fixture(t: TestContext, script: FakeScript) {
  const root = mkdtempSync(join(tmpdir(), 'helix-monitor-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'hello.txt'), 'before\n');
  const fake = await startFakeProvider('gemini', script);
  const engine = new Engine({ home: join(root, 'home'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false, mcp: false, recover: false });
  t.after(async () => { await engine.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (overrides = {}) => engine.runtime.create({ workspacePath: repo, goal: 'Inspect and update hello.txt', provider: 'gemini', model: 'gemini-3.8-flash', ...overrides });
  return { engine, repo, fake, create };
}
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('R1.3 nested tree uses actual agent/step/ledger ancestry; pause blocks nested calls and resume continues', { timeout: 30_000 }, async (t) => {
  const { engine, create } = await fixture(t, ({ index }) => [
    { toolCalls: [{ name: 'explore', args: { question: 'Read hello.txt' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }] },
    { text: 'hello.txt:1 contains before' },
    { text: 'Inspected the file.' },
  ][Math.min(index, 3)]);
  let paused: ReturnType<typeof engine.runtime.pause> | undefined;
  const stop = engine.bus.subscribe('agent.step.activity', (event) => {
    const activity = event.data as TaskActivity;
    if (!paused && activity.agents.some((a) => a.kind === 'explore' && a.steps.some((s) => s.status === 'done'))) {
      stop(); paused = engine.runtime.pause(activity.task);
    }
  });
  const task = create({ budgetUsd: 1 });
  await waitFor(() => !!paused);
  assert.equal((await paused!).status, 'paused');
  const count = engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tool_calls WHERE task = ?', task.id)!.n;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tool_calls WHERE task = ?', task.id)!.n, count);
  engine.runtime.resume(task.id);
  assert.equal((await engine.runtime.wait(task.id, 15_000)).status, 'done');
  const activity = engine.runtime.activity(task.id);
  const child = activity.agents.find((a) => a.kind === 'explore')!;
  assert.equal(child.parent, 'primary');
  const primaryTool = activity.agents[0].steps.flatMap((s) => s.tools).find((c) => c.tool === 'explore')!;
  assert.equal(child.parentCall, primaryTool.id);
  assert.equal(child.steps[0].tools[0].tool, 'read_file');
  assert.ok(child.steps[0].tools[0].checkpoint);
  assert.equal(activity.budget!.hardUsd, 1);
  assert.equal(activity.checkpoints.length, 2);
  assert.ok(child.usage.inputTokens > 0);
  assert.equal(activity.usage.inputTokens, activity.agents.reduce((n, a) => n + a.usage.inputTokens, 0), 'no nested double counting');
  assert.ok(Object.keys(child.steps[0].context).length > 0);
});

test('R1.3 pause between primary tools, rollback while paused, no stale pending writes on resume', { timeout: 30_000 }, async (t) => {
  const { engine, create, repo } = await fixture(t, ({ index }) => index === 0 ? { toolCalls: [
    { name: 'edit_file', args: { path: 'hello.txt', old_string: 'before', new_string: 'after' } },
    { name: 'read_file', args: { path: 'hello.txt' } },
  ] } : { text: 'Update completed.' });
  let paused: ReturnType<typeof engine.runtime.pause> | undefined;
  const stop = engine.bus.subscribe('tool.result', (event) => { stop(); paused = engine.runtime.pause(event.task!); });
  const task = create();
  await waitFor(() => !!paused);
  assert.equal((await paused!).status, 'paused');
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'after\n');
  assert.throws(() => engine.runtime.start(task.id), /paused/);
  const activity = engine.runtime.activity(task.id);
  assert.equal(activity.agents[0].steps[0].tools[1].status, 'pending');
  assert.equal(activity.leases[0].state, 'released');
  const checkpoint = activity.checkpoints[0].id;
  await assert.rejects(engine.runtime.rollback(task.id, 'other-task-checkpoint'), /unknown checkpoint/);
  await engine.runtime.rollback(task.id, checkpoint);
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'before\n');
  assert.equal(engine.runtime.summary(task.id).status, 'paused');
  engine.runtime.resume(task.id);
  assert.equal((await engine.runtime.wait(task.id, 15_000)).status, 'done');
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'before\n');
  assert.ok(engine.runtime.transcript(task.id).some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('User restored checkpoint'))));
  assert.equal(engine.bus.verifyAuditChain(), null);
});

test('R1.3 cancelling a paused approval unblocks runtime and expires the approval; paused tasks survive recovery', { timeout: 30_000 }, async (t) => {
  const { engine, create } = await fixture(t, () => ({ toolCalls: [{ name: 'run_shell', args: { command: 'printf approved' } }] }));
  const task = create({ policyProfile: 'interactive' });
  await waitFor(() => engine.runtime.summary(task.id).status === 'awaiting_approval');
  assert.equal((await engine.runtime.pause(task.id)).status, 'paused');
  assert.equal((await engine.runtime.cancel(task.id)).status, 'cancelled');
  assert.ok(engine.runtime.approvalList(task.id).every((a) => a.status === 'expired'));
  assert.equal(engine.runtime.isRunning(task.id), false);
  const parked = create({ start: false });
  await engine.runtime.pause(parked.id);
  assert.ok(!engine.runtime.recover().includes(parked.id));
  assert.equal(engine.runtime.summary(parked.id).status, 'paused');
  await engine.runtime.cancel(parked.id);
});

test('R1.3 real write lease is held during execution, serializes tasks, releases on cancel; unknown prices stay unknown', { timeout: 30_000 }, async (t) => {
  const { engine, create } = await fixture(t, () => ({ toolCalls: [{ name: 'run_shell', args: { command: 'sleep 3' } }] }));
  const first = create(); const second = create();
  await waitFor(() => [first, second].some((task) => engine.runtime.activity(task.id).leases.some((l) => l.state === 'held')));
  assert.equal(engine.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_leases WHERE state = 'held'")!.n, 1);
  const holder = engine.db.get<{ task: string }>("SELECT task FROM activity_leases WHERE state = 'held'")!.task;
  const other = holder === first.id ? second.id : first.id;
  await engine.runtime.cancel(holder);
  await waitFor(() => engine.runtime.activity(other).leases.some((l) => l.state === 'held'));
  engine.db.run('UPDATE ledger_entries SET cost_usd = NULL WHERE task = ?', other);
  assert.equal(engine.runtime.activity(other).usage.costUsd, null);
  assert.equal((await engine.runtime.cancel(other)).status, 'cancelled');
  assert.equal(engine.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_leases WHERE state = 'held'")!.n, 0);
});

test('R1.3 streams agent.step.* events, exposes prompt contextItems, and supports fork + change model without ledger duplication', { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'helix-monitor-fork-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'HELIX.md'), 'Always preserve greeting clarity.\n');
  writeFileSync(join(repo, 'hello.txt'), 'before\n');
  const fake = await startFakeProvider('gemini', ({ index, request }) => {
    if (request.path.includes('gemini-3.5-flash-lite')) return { text: 'Completed on forked flash-lite model.' };
    if (index === 0) return { toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }] };
    if (index === 1) return { toolCalls: [{ name: 'edit_file', args: { path: 'hello.txt', old_string: 'before', new_string: 'after' } }] };
    return { text: 'Original finished.' };
  });
  const engine = new Engine({ home: join(root, 'home'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: true, mcp: false, recover: false });
  t.after(async () => { await engine.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); });
  const stepTopics: string[] = [];
  const unsub = engine.bus.subscribe('agent.step.**', (ev) => { stepTopics.push(ev.topic); });
  const original = engine.runtime.create({ workspacePath: repo, goal: 'Read then edit hello.txt', provider: 'gemini', model: 'gemini-3.8-flash', budgetUsd: 1.5 });
  assert.equal((await engine.runtime.wait(original.id, 15_000)).status, 'done');
  unsub();
  assert.ok(stepTopics.includes('agent.step.started'));
  assert.ok(stepTopics.includes('agent.step.completed'));
  assert.ok(stepTopics.includes('agent.step.activity'));
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'after\n');
  const origActivity = engine.runtime.activity(original.id);
  assert.ok(origActivity.agents[0].steps[0].contextItems.some((item) => item.kind === 'instructions' && item.tokens > 0));
  assert.ok(origActivity.agents[0].steps[1].contextItems.some((item) => item.kind === 'tool_result' && item.label === 'read_file'));
  const editCkpt = origActivity.agents[0].steps.flatMap((s) => s.tools).find((c) => c.tool === 'edit_file')!.checkpoint;
  const ledgerBeforeFork = engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_entries')!.n;
  const forked = await engine.runtime.fork(original.id, editCkpt);
  assert.equal(forked.status, 'paused');
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'before\n');
  assert.equal(engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_entries')!.n, ledgerBeforeFork, 'fork must not duplicate ledger rows');
  const updated = engine.runtime.setModel(forked.id, { provider: 'gemini', model: 'gemini-3.5-flash-lite' });
  assert.equal(updated.model, 'gemini-3.5-flash-lite');
  engine.runtime.resume(forked.id);
  assert.equal((await engine.runtime.wait(forked.id, 15_000)).status, 'done');
  const forkActivity = engine.runtime.activity(forked.id);
  assert.deepEqual(forkActivity.forkedFrom, { task: original.id, checkpoint: editCkpt });
  assert.equal(forkActivity.budget?.hardUsd, 1.5);
  assert.equal(forkActivity.agents[0].steps[0].model, 'gemini/gemini-3.5-flash-lite');
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'before\n');
  assert.equal(engine.bus.verifyAuditChain(), null);
});
