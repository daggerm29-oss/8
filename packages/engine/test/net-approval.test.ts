import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import type { EgressContext } from '../src/sandbox/egress.ts';
import { connectVia } from './net-helpers.ts';

async function until<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('network approval class: unknown domain raises a `network` approval; once allows that call only; always persists per workspace (FR-18, F-SBX-3)', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'helix-netappr-')));
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  const ws = engine.runtime.workspaceFor(root);
  const now = new Date().toISOString();
  const insertTask = (id: string, profile: string) => engine.db.run(
    `INSERT INTO tasks (id, ws, title, goal, status, provider, model, policy_profile, preapprove_json, verify_command, max_steps, created_at, updated_at)
     VALUES (?, ?, 't', 'g', 'running', 'replay', 'm', ?, '[]', NULL, 10, ?, ?)`, id, ws.id, profile, now, now);
  insertTask('task_inter', 'interactive');
  insertTask('task_headless', 'headless');
  const denied: Array<{ host: string; reason: string }> = [];
  const unsub = engine.bus.subscribe('egress.*', (e) => { if (e.topic === 'egress.denied') denied.push(e.data as never); });
  const dir = mkdtempSync(join(tmpdir(), 'helix-netappr-sock-'));
  const ctx = (name: string, task: string): [string, EgressContext] => [join(dir, `${name}.sock`), { sandboxId: `sbx_${name}`, root, task }];
  const [sock, c1] = ctx('inter', 'task_inter');
  const [hsock, c2] = ctx('headless', 'task_headless');
  const close1 = await engine.egress.listen(sock, c1);
  const close2 = await engine.egress.listen(hsock, c2);
  const { port, token } = await engine.serve({ ui: false });
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(wsTransport(socket));
  await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
  const pending = (host: string) => until(() => engine.runtime.approvalList('task_inter').find((a) => a.status === 'pending' && (a.args as { host: string }).host === host));
  try {
    const first = connectVia(sock, 'once.invalid:443');
    const appr = await pending('once.invalid');
    assert.equal(appr.actionClass, 'network');
    assert.equal(appr.tool, 'net.domain');
    assert.deepEqual(await peer.request(Methods.approvalRespond, { approvalId: appr.id, approved: true }), { ok: true, decision: 'once', host: 'once.invalid', alwaysAllowed: null });
    assert.match(await first, /502/, 'approved once: this connection goes upstream');

    const second = connectVia(sock, 'once.invalid:443');
    const again = await pending('once.invalid');
    assert.notEqual(again.id, appr.id, 'approve-once does not persist: the next call asks again');
    await peer.request(Methods.approvalRespond, { approvalId: again.id, approved: false });
    assert.match(await second, /403/);
    engine.bus.flush();
    assert.ok(denied.some((d) => d.host === 'once.invalid' && d.reason === 'network approval denied'), JSON.stringify(denied));

    const third = connectVia(sock, 'always.invalid:443');
    const a3 = await pending('always.invalid');
    await peer.request(Methods.approvalRespond, { approvalId: a3.id, approved: true, always: true });
    assert.match(await third, /502/);
    assert.match(await connectVia(sock, 'always.invalid:443'), /502/, 'approve-always: allowed without another approval');
    assert.equal(engine.runtime.approvalList('task_inter').filter((a) => (a.args as { host: string }).host === 'always.invalid').length, 1);
    const list = await peer.request(Methods.egressList, { workspacePath: root }) as { workspace: Array<{ host: string }> };
    assert.deepEqual(list.workspace.map((h) => h.host), ['always.invalid'], 'persisted for the workspace');
    assert.match(await connectVia(hsock, 'always.invalid:443'), /502/, 'workspace allow applies to other sandboxes of the workspace');

    assert.match(await connectVia(hsock, 'other.invalid:443'), /403/, 'headless task: no approval, denied at once');
    assert.equal(engine.runtime.approvalList('task_headless').length, 0);
  } finally {
    unsub();
    socket.close();
    close1();
    close2();
    await engine.close();
  }
});
