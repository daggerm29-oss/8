import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { availableBackends, LocalSandbox } from '../src/sandbox/sandbox.ts';

async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'condition timed out');
    await delay(5);
  }
}

function livePids(sandbox: string): number[] {
  return readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).flatMap((pid) => {
    try {
      const env = readFileSync(`/proc/${pid}/environ`).toString().split('\0');
      return env.includes(`HELIX_SANDBOX=${sandbox}`) ? [Number(pid)] : [];
    } catch { return []; }
  });
}

for (const backend of availableBackends().filter((b) => b !== 'local-os')) {
  test(`R0.6 ${backend}: 20 running sleep cancellations stop loop and all descendants within 1s p95`, { timeout: 120_000 }, async (t) => {
    const previous = process.env.HELIX_SANDBOX_PROVIDER;
    process.env.HELIX_SANDBOX_PROVIDER = backend;
    const root = mkdtempSync(join(tmpdir(), 'helix-cancel-'));
    const fake = await startFakeProvider('gemini', () => ({ toolCalls: [{ name: 'run_shell', args: { command: 'setsid bash -c "echo ready > started; sleep 30" & wait' } }] }));
    const engine = new Engine({ home: join(root, 'home'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false });
    const latencies: number[] = [];
    try {
      for (let run = 0; run < 20; run++) {
        const marker = join(root, 'started');
        rmSync(marker, { force: true });
        const task = engine.runtime.create({ workspacePath: root, goal: 'run sleep', provider: 'gemini', model: 'gemini-3.8-flash', preapprove: ['run_shell'] });
        await until(() => existsSync(marker));
        const sandbox = engine.db.get<{ id: string }>('SELECT id FROM sandboxes WHERE labels_json LIKE ?', `%${task.id}%`)!.id;
        const before = livePids(sandbox);
        assert.ok(before.length > 0, 'real running sandbox processes observed before cancellation');
        let eventAt = 0;
        const unsubscribe = engine.bus.subscribe('task.cancelled', (event) => { if (event.task === task.id) eventAt = performance.now(); });
        const started = performance.now();
        const cancelled = await engine.runtime.cancel(task.id);
        await until(() => livePids(sandbox).length === 0, 1000);
        const elapsed = performance.now() - started;
        unsubscribe();
        assert.equal(cancelled.status, 'cancelled');
        assert.ok(eventAt >= started, 'task.cancelled emitted after cancellation request');
        assert.equal(engine.runtime.isRunning(task.id), false);
        assert.equal(engine.db.get<{ state: string }>('SELECT state FROM sandboxes WHERE id = ?', sandbox)!.state, 'destroyed');
        const calls = engine.db.all<{ status: string; checkpoint: string }>('SELECT status, checkpoint FROM tool_calls WHERE task = ?', task.id);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 'cancelled');
        assert.ok(engine.db.get('SELECT id FROM checkpoints WHERE id = ?', calls[0].checkpoint));
        latencies.push(Math.max(elapsed, eventAt - started));
      }
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      t.diagnostic(JSON.stringify({ backend, runs: latencies.length, p95Ms: Math.round(p95), maxMs: Math.round(sorted.at(-1)!), latenciesMs: latencies.map(Math.round) }));
      assert.ok(p95 <= 1000, `p95 ${p95}ms exceeds 1000ms`);
    } finally {
      await engine.close();
      await fake.close();
      if (previous === undefined) delete process.env.HELIX_SANDBOX_PROVIDER;
      else process.env.HELIX_SANDBOX_PROVIDER = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('R0.6 read, write, invalid and denied calls have durable checkpoint IDs and write rollback remains correct', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-checkpoints-'));
  const fake = await startFakeProvider('gemini', ({ index }) => index === 0 ? { toolCalls: [
    { name: 'write_file', args: { path: 'hello.txt', content: 'hello' } },
    { name: 'read_file', args: { path: 'hello.txt' } },
    { name: 'read_file', args: {} },
    { name: 'run_shell', args: { command: 'git push origin main' } },
  ] } : { text: 'done' });
  const engine = new Engine({ home: join(root, 'home'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false });
  try {
    const task = engine.runtime.create({ workspacePath: root, goal: 'exercise checkpoints', provider: 'gemini', model: 'gemini-3.8-flash' });
    assert.equal((await engine.runtime.wait(task.id, 15_000)).status, 'done');
    const rows = engine.db.all<{ checkpoint: string; status: string }>('SELECT checkpoint, status FROM tool_calls WHERE task = ? ORDER BY rowid', task.id);
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map((r) => r.checkpoint)).size, 4);
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'ok', 'error', 'denied']);
    for (const row of rows) assert.ok(engine.db.get('SELECT id FROM checkpoints WHERE id = ? AND task = ?', row.checkpoint, task.id));
    const spans = engine.db.all<{ attributes_json: string }>("SELECT attributes_json FROM spans WHERE name = 'tool.call'");
    for (const span of spans) assert.ok(rows.some((r) => r.checkpoint === JSON.parse(span.attributes_json)['checkpoint.id']));
    engine.runtime.restore(task.id, rows[0].checkpoint);
    assert.equal(existsSync(join(root, 'hello.txt')), false);
  } finally { await engine.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});

test('R0.6 an already-aborted command never spawns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-aborted-'));
  const sandbox = new LocalSandbox('aborted', root);
  try {
    await assert.rejects(sandbox.exec('touch should-not-exist', { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(existsSync(join(root, 'should-not-exist')), false);
  } finally { sandbox.destroy(); rmSync(root, { recursive: true, force: true }); }
});
