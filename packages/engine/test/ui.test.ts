import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import { unifiedDiff } from '../src/util/diff.ts';

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(port: number, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}

test('unifiedDiff: modified, added, deleted, unchanged', () => {
  const m = unifiedDiff('a.js', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
  assert.equal(m.status, 'modified');
  assert.equal(m.additions, 2);
  assert.equal(m.deletions, 1);
  assert.match(m.patch, /^--- a\/a\.js\n\+\+\+ b\/a\.js\n@@ -1,3 \+1,4 @@\n one\n-two\n\+2\n three\n\+four\n$/);
  assert.equal(unifiedDiff('n.js', null, 'x\n').status, 'added');
  assert.match(unifiedDiff('n.js', null, 'x\n').patch, /--- \/dev\/null/);
  assert.equal(unifiedDiff('d.js', 'x\n', null).deletions, 1);
  assert.equal(unifiedDiff('u.js', 'x', 'x').patch, '');
  const far = unifiedDiff('f.txt', Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 2 || i === 25 ? `L${i}` : `l${i}`)).join('\n'));
  assert.equal((far.patch.match(/^@@/gm) ?? []).length, 2, 'distant changes produce separate hunks');
});

test('workbench server: serves UI, rejects foreign Host/Origin, token-gates WS, checkpoint.diff', async () => {
  const fake = await startFakeProvider('gemini', ({ index }) => [
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/a.js', old_string: 'return 1', new_string: 'return 2' } }], usage: { input: 10, output: 5 } },
    { toolCalls: [{ name: 'write_file', args: { path: 'src/new.js', content: 'export const n = 1;\n' } }], usage: { input: 10, output: 5 } },
    { text: 'done', usage: { input: 10, output: 2 } },
  ][Math.min(index, 2)]);
  const home = mkdtempSync(join(tmpdir(), 'helix-ui-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'helix-ui-repo-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.js'), 'export function a() {\n  return 1;\n}\n');
  const engine = new Engine({ home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  try {
    const { port, token, url } = await engine.serve({ ui: true });
    assert.ok(url.endsWith(`#token=${token}`), 'token is carried in the URL fragment');

    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Helix Workbench/);
    assert.ok(!page.body.includes(token), 'served HTML never contains the token');
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    assert.equal((await get(port, '/app.js')).status, 200);
    assert.equal((await get(port, '/../src/engine.ts')).status, 404);
    assert.equal(JSON.parse((await get(port, '/config.json')).body).auth, 'token');
    assert.equal((await get(port, '/', 'evil.example:80')).status, 403, 'DNS-rebinding Host rejected');

    await assert.rejects(connect(port, { Origin: 'http://evil.example' }), /403/);

    const bad = new RpcPeer(wsTransport(await connect(port)));
    await assert.rejects(bad.request(Methods.taskList, {}), /initialize/);
    await assert.rejects(bad.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token: 'nope' }), /invalid token/);
    bad.close();

    const ws = await connect(port, { Origin: `http://127.0.0.1:${port}` });
    const peer = new RpcPeer(wsTransport(ws));
    const topics: string[] = [];
    peer.onNotification('event', (e) => { topics.push((e as { topic: string }).topic); });
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: ['task.*', 'tool.*'] });
    const t = await peer.request<{ id: string }>(Methods.taskCreate, { workspacePath: repo, goal: 'change a', model: 'gemini-3.8-flash', policyProfile: 'headless', start: true });
    const done = await peer.request<{ status: string }>(Methods.taskWait, { id: t.id, timeoutMs: 20000 });
    assert.equal(done.status, 'done');
    assert.ok(topics.includes('tool.result'), 'events stream over the workbench socket');

    const diff = await peer.request<Array<{ path: string; status: string; patch: string }>>(Methods.checkpointDiff, { task: t.id });
    const a = diff.find((d) => d.path === 'src/a.js')!;
    assert.equal(a.status, 'modified');
    assert.match(a.patch, /-  return 1;\n\+  return 2;/);
    assert.equal(diff.find((d) => d.path === 'src/new.js')!.status, 'added');

    const cps = await peer.request<Array<{ id: string }>>(Methods.checkpointList, { task: t.id });
    const onlySecond = await peer.request<Array<{ path: string }>>(Methods.checkpointDiff, { task: t.id, checkpoint: cps[1].id });
    assert.deepEqual(onlySecond.map((d) => d.path), ['src/new.js']);

    await peer.request(Methods.checkpointRestore, { task: t.id });
    const after = await peer.request<Array<{ status: string }>>(Methods.checkpointDiff, { task: t.id });
    assert.ok(after.every((d) => d.status === 'unchanged'), 'diff is empty after restore');

    const wsl = await peer.request<Array<{ path: string }>>(Methods.workspaceList, {});
    assert.equal(wsl.length, 1);
    assert.deepEqual(await peer.request(Methods.approvalList, { task: t.id }), []);
    peer.close();
  } finally {
    await engine.close();
    await fake.close();
  }
});
