import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function pythonProject(): string {
  const d = tmp('helix-waiver-');
  writeFileSync(join(d, 'test_ok.py'), 'import unittest\n\nclass Ok(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n');
  return d;
}

async function setup() {
  const fake = await startFakeProvider('gemini', () => ({ text: 'Done.', usage: { input: 100, output: 5 } }));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false });
  const events: Array<{ topic: string; data: Record<string, unknown> }> = [];
  engine.bus.subscribe('gate.waived', (e) => { events.push({ topic: e.topic, data: e.data as never }); });
  engine.bus.subscribe('gates.confirmed', (e) => { events.push({ topic: e.topic, data: e.data as never }); });
  const create = (workspacePath: string, extra: Record<string, unknown> = {}) =>
    engine.runtime.create({ workspacePath, goal: 'finish', provider: 'gemini', model: 'gemini-3.8-flash', ...extra });
  return { engine, fake, events, create };
}

const until = async <T>(fn: () => T | undefined, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

test('inferred gates run only after gates.confirm; confirmation is audited and persisted (F-AGT-4)', async () => {
  const { engine, fake, events, create } = await setup();
  try {
    const dir = pythonProject();
    const unconfirmed = await engine.runtime.wait(create(dir, { policyProfile: 'headless', verifyCommand: 'auto' }).id, 30_000);
    assert.equal(unconfirmed.status, 'failed');
    assert.match(unconfirmed.error ?? '', /inferred verification gates need confirmation.*gates\.confirm/);
    assert.equal(existsSync(join(dir, '.helix/verify.json')), false, 'nothing is persisted without confirmation');
    assert.deepEqual(engine.runtime.gatesInfer(dir).confirmed, false);

    const { gates } = engine.runtime.gatesConfirm(dir);
    assert.deepEqual(gates.map((g) => g.command), ['python3 -m unittest -q']);
    assert.equal(JSON.parse(readFileSync(join(dir, '.helix/verify.json'), 'utf8')).gates[0].command, 'python3 -m unittest -q');
    assert.equal(engine.runtime.gatesInfer(dir).confirmed, true);
    const confirmed = await engine.runtime.wait(create(dir, { policyProfile: 'headless', verifyCommand: 'auto' }).id, 30_000);
    assert.equal(confirmed.status, 'done', confirmed.error ?? '');

    const pre = pythonProject();
    const preapproved = await engine.runtime.wait(create(pre, { policyProfile: 'headless', verifyCommand: 'auto', preapprove: ['tool:gates.confirm'] }).id, 30_000);
    assert.equal(preapproved.status, 'done', preapproved.error ?? '');

    const ask = pythonProject();
    const interactive = create(ask, { policyProfile: 'interactive', verifyCommand: 'auto' });
    const approval = await until(() => engine.runtime.approvalList(interactive.id).find((a) => a.status === 'pending'));
    assert.equal(approval.tool, 'gates.confirm');
    assert.equal(engine.runtime.summary(interactive.id).status, 'awaiting_approval');
    engine.runtime.approve(approval.id, true);
    assert.equal((await engine.runtime.wait(interactive.id, 30_000)).status, 'done');
    assert.equal(existsSync(join(ask, '.helix/verify.json')), true);

    const refuse = pythonProject();
    const refused = create(refuse, { policyProfile: 'interactive', verifyCommand: 'auto' });
    engine.runtime.approve((await until(() => engine.runtime.approvalList(refused.id).find((a) => a.status === 'pending'))).id, false);
    const denied = await engine.runtime.wait(refused.id, 30_000);
    assert.equal(denied.status, 'failed');
    assert.match(denied.error ?? '', /not confirmed/);
    assert.equal(existsSync(join(refuse, '.helix/verify.json')), false);

    engine.bus.flush();
    assert.deepEqual(events.filter((e) => e.topic === 'gates.confirmed').map((e) => e.data.by), ['user', 'preapproval', 'user']);
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('a task with a red required gate ends done only through a logged waiver with reason and user (F-AGT-4)', async () => {
  const { engine, fake, events, create } = await setup();
  try {
    const { port, token } = await engine.serve({ ui: false });
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/`);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const peer = new RpcPeer(wsTransport(socket));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });

    const dir = tmp('helix-red-');
    const red = await engine.runtime.wait(create(dir, { policyProfile: 'headless', verifyCommand: 'node -e "process.exit(1)"' }).id, 60_000);
    assert.equal(red.status, 'failed', 'a red required gate never ends done on its own');
    assert.match(red.error ?? '', /verification failed 3 times/);
    engine.bus.flush();
    assert.equal(events.filter((e) => e.topic === 'gate.waived').length, 0);

    await assert.rejects(peer.request(Methods.gateWaive, { task: red.id }), /needs a reason/);
    await assert.rejects(peer.request(Methods.gateWaive, { task: red.id, reason: '   ' }), /needs a reason/);
    const waived = await peer.request<{ status: string; result: string; error: string | null }>(Methods.gateWaive, { task: red.id, reason: 'flaky upstream check, reviewed manually' });
    assert.equal(waived.status, 'done');
    assert.match(waived.result, /verification waived by user: flaky upstream check, reviewed manually \(gates: verify\)/);
    assert.equal(waived.error, null);
    engine.bus.flush();
    const waivers = events.filter((e) => e.topic === 'gate.waived');
    assert.equal(waivers.length, 1);
    assert.deepEqual(waivers[0].data, { gates: ['verify'], reason: 'flaky upstream check, reviewed manually', by: 'user' });
    assert.equal(engine.runtime.artifacts(red.id, 'gate_waiver').length, 1);

    await assert.rejects(peer.request(Methods.gateWaive, { task: red.id, reason: 'again' }), /only a task that ended with required gates still red/);
    const green = await engine.runtime.wait(create(dir, { policyProfile: 'headless', verifyCommand: 'node -e 0' }).id, 30_000);
    assert.equal(green.status, 'done');
    await assert.rejects(peer.request(Methods.gateWaive, { task: green.id, reason: 'not needed' }), /only a task that ended with required gates still red/);
    peer.close();
  } finally {
    await engine.close();
    await fake.close();
  }
});
