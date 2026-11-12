import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import type { PlanReview } from '../src/agent/runtime.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const PLAN = {
  goal: 'add a greeting module',
  affectedFiles: [{ path: 'src/index.js', reason: 'entry point', evidence: 'index.js:1' }],
  steps: [{ id: 's1', description: 'create src/greeting.js', writeSet: ['src/greeting.js'] }],
  verification: ['node -e 0'],
};

test('plan review: plan.update edits steps and plan.approve gates every write tool (FR-12, F-AGT-2)', async () => {
  const dir = tmp('helix-plan-review-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/index.js'), 'export const x = 1;\n');

  const planTurns: FakeTurn[] = [
    { toolCalls: [{ name: 'write_file', args: { path: 'src/early.js', content: 'too early\n' } }], usage: { input: 100, output: 10 } },
    { toolCalls: [{ name: 'submit_plan', args: PLAN }], usage: { input: 200, output: 20 } },
    { text: 'Plan ready.', usage: { input: 300, output: 5 } },
  ];
  const execTurns: FakeTurn[] = [
    { toolCalls: [{ name: 'write_file', args: { path: 'src/greeting.js', content: 'export const hi = "hello";\n' } }], usage: { input: 100, output: 10 } },
    { text: 'Done.', usage: { input: 150, output: 5 } },
  ];
  let planIdx = 0;
  let execIdx = 0;
  const execBodies: string[] = [];
  const toolResults: string[] = [];
  const script: FakeScript = ({ request }) => {
    const body = JSON.stringify(request.body);
    for (const m of body.matchAll(/denied by policy: [^"]*/g)) toolResults.push(m[0]);
    if (body.includes('PLAN MODE')) return planTurns[Math.min(planIdx++, planTurns.length - 1)];
    execBodies.push(body);
    return execTurns[Math.min(execIdx++, execTurns.length - 1)];
  };
  const fake = await startFakeProvider('gemini', script);
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false });
  try {
    const { port, token } = await engine.serve({ ui: false });
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/`);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const peer = new RpcPeer(wsTransport(socket));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });

    const created = engine.runtime.create({ workspacePath: dir, goal: 'plan a greeting module', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'plan' });
    const planned = await engine.runtime.wait(created.id, 30_000);
    assert.equal(planned.status, 'done', planned.error ?? '');

    assert.equal(existsSync(join(dir, 'src/early.js')), false, 'write before approval did not run');
    assert.ok(toolResults.some((r) => /Plan Mode is read-only until the user approves the plan/.test(r)), 'the write was denied by policy');

    const first = await peer.request<PlanReview>(Methods.planGet, { task: created.id });
    assert.equal(first.approved, false);
    assert.equal(first.plan?.revision, 1);
    assert.equal(first.executionTask, null);

    await assert.rejects(peer.request(Methods.planUpdate, { task: created.id, edit: { steps: [{ id: 'a', description: 'x', dependsOn: ['a'] }] } }), /cycle/);
    await assert.rejects(peer.request(Methods.planUpdate, { task: created.id, edit: { steps: [{ id: 'a', description: 'x', writeSet: ['../escape.js'] }] } }), /workspace-relative/);
    await assert.rejects(peer.request(Methods.planUpdate, { task: created.id, edit: { steps: [{ id: 'a', description: 'x', dependsOn: ['nope'] }] } }), /unknown step/);

    const edited = await peer.request<PlanReview>(Methods.planUpdate, {
      task: created.id, planId: first.plan!.id,
      edit: { steps: [...(first.plan!.data.steps as object[]), { id: 's2', description: 'export it from src/index.js', writeSet: ['src/index.js'], dependsOn: ['s1'] }] },
    });
    assert.equal(edited.plan?.revision, 2);
    assert.equal(edited.approved, false);
    assert.equal((edited.plan!.data.steps as unknown[]).length, 2);

    await assert.rejects(peer.request(Methods.planApprove, { task: created.id, planId: first.plan!.id }), /plan changed since you reviewed it/);
    assert.equal(existsSync(join(dir, 'src/greeting.js')), false, 'nothing executes until approval');

    const approved = await peer.request<PlanReview>(Methods.planApprove, { task: created.id, planId: edited.plan!.id });
    assert.equal(approved.approved, true);
    assert.ok(approved.executionTask);
    const again = await peer.request<PlanReview>(Methods.planApprove, { task: created.id });
    assert.equal(again.executionTask, approved.executionTask, 'approving twice is idempotent');
    await assert.rejects(peer.request(Methods.planUpdate, { task: created.id, edit: { goal: 'changed' } }), /already approved/);

    const exec = await engine.runtime.wait(approved.executionTask!, 30_000);
    assert.equal(exec.status, 'done', exec.error ?? '');
    assert.equal(readFileSync(join(dir, 'src/greeting.js'), 'utf8'), 'export const hi = "hello";\n', 'write tool is callable after approval');
    assert.equal(engine.runtime.planGet(created.id).plan?.data.revisionOf !== undefined, true);
    assert.match(execBodies[0], /export it from src\/index\.js/, 'the edited plan is what the execution task was told');
    assert.equal(engine.runtime.artifacts(approved.executionTask!, 'approved_plan').length, 1);
    assert.equal(engine.runtime.summary(created.id).status, 'done');
    peer.close();
  } finally {
    await engine.close();
    await fake.close();
  }
});
