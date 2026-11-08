import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import { DevServers, detectDevServer } from '../src/preview/devserver.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { LocalSandbox } from '../src/sandbox/sandbox.ts';

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-dev-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

const SERVER = `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<h1>Hello fixture</h1>'); })
  .listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT));\n`;

function fixture(): string {
  return app({ 'package.json': JSON.stringify({ name: 'fx', scripts: { dev: 'node server.js' } }), 'server.js': SERVER });
}

test('detectDevServer: scripts, package manager, framework port defaults and hints', () => {
  assert.equal(detectDevServer(app({})), null);
  assert.equal(detectDevServer(app({ 'package.json': '{"scripts":{"build":"x"}}' })), null);
  assert.deepEqual(detectDevServer(app({ 'package.json': '{"scripts":{"dev":"vite"},"devDependencies":{"vite":"5"}}', 'pnpm-lock.yaml': '' })),
    { command: 'pnpm run dev', port: 5173, framework: 'vite', packageManager: 'pnpm', script: 'dev' });
  const next = detectDevServer(app({ 'package.json': '{"scripts":{"start":"next start"},"dependencies":{"next":"16"}}', 'yarn.lock': '' }))!;
  assert.equal(next.command, 'yarn run start');
  assert.equal(next.port, 3000);
  assert.equal(detectDevServer(app({ 'package.json': '{"scripts":{"dev":"node s.js --port 8123"}}' }))!.port, 8123);
});

test('dev server: fixture app starts in the sandbox and responds on a host localhost port (F-PRV-1)', async () => {
  const root = fixture();
  const ready: string[] = [];
  const devs = new DevServers({ onReady: (_r, i) => ready.push(i.url) });
  try {
    const info = await devs.start(root, { timeoutMs: 60_000 });
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(info.port, 3000);
    const res = await fetch(info.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hello fixture/);
    assert.deepEqual(ready, [info.url]);
    assert.equal((await devs.start(root)).url, info.url, 'start is idempotent');
    assert.match(devs.logTail(root), /listening on 3000/);
    assert.equal(devs.stop(root), true);
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(fetch(info.url));
  } finally {
    await devs.closeAll();
  }
});

test('dev server: a crashing script fails fast with its output', async () => {
  const root = app({ 'package.json': JSON.stringify({ scripts: { dev: 'node -e "console.error(\'boom-dev\'); process.exit(3)"' } }) });
  const devs = new DevServers();
  await assert.rejects(devs.start(root, { timeoutMs: 30_000 }), /exited with code 3[\s\S]*boom-dev/);
  await devs.closeAll();
});

test('engine: preview.start RPC emits preview.ready and start_dev_server tool returns the URL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const root = fixture();
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  try {
    engine.index(root);
    const { port, token } = await engine.serve({ ui: false });
    const sock = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/`);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const peer = new RpcPeer(wsTransport(sock));
    const events: Array<{ topic: string; data: { url: string } }> = [];
    peer.onNotification('event', (e: unknown) => events.push(e as never));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: ['preview.*'] });
    const info = await peer.request(Methods.previewStart, { workspacePath: root }, 90_000) as { url: string };
    assert.match(await (await fetch(info.url)).text(), /Hello fixture/);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.some((e) => e.topic === 'preview.ready' && e.data.url === info.url), JSON.stringify(events));

    const sbx = new LocalSandbox('sbx_dev_tool', root);
    const out = await builtinTools().run('start_dev_server', {}, { sandbox: sbx, signal: new AbortController().signal, startDevServer: () => engine.devServers.start(sbx.root) });
    sbx.destroy();
    assert.equal(out.isError, undefined);
    assert.ok(out.content.includes(info.url), out.content);
    assert.deepEqual(await peer.request(Methods.previewStop, { workspacePath: root }), { stopped: true });
    sock.close();
  } finally {
    await engine.close();
  }
});
