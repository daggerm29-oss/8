import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { connectVia } from './net-helpers.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import { LocalSandbox, unshareAvailable } from '../src/sandbox/sandbox.ts';
import { EgressProxy, isBlockedAddress } from '../src/sandbox/egress.ts';

const skip = !unshareAvailable() && 'network namespaces unavailable';

function ws(): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-egress-'));
  writeFileSync(join(root, 'a.txt'), 'x\n');
  return root;
}

const code = (host: string, extra = '') => `curl -sS -m 20 ${extra} -o /dev/null -w 'code=%{http_code}\\n' https://${host}/ 2>&1; echo "exit=$?"`;

test('isBlockedAddress covers private, loopback, link-local and metadata ranges', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '::1', 'fd00:ec2::254', 'fe80::1', '::ffff:10.1.1.1']) assert.equal(isBlockedAddress(a), true, a);
  for (const a of ['104.16.1.1', '8.8.8.8', '2606:4700::1']) assert.equal(isBlockedAddress(a), false, a);
});

test('egress: allowlisted host works through the proxy, others are denied and reported, direct egress fails (F-SBX-3)', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const root = ws();
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  const denied: Array<{ host: string; reason: string }> = [];
  const unsub = engine.bus.subscribe('egress.*', (e) => { if (e.topic === 'egress.denied') denied.push(e.data as never); });
  engine.index(root);
  const sbx = new LocalSandbox('sbx_egress', root, { egress: engine.egress });
  try {
    assert.equal(sbx.info().egressProxy, true);
    const ok = await sbx.exec(code('registry.npmjs.org'), { timeoutMs: 60_000 });
    assert.match(ok.stdout, /code=200/, ok.stdout + ok.stderr);

    const bad = await sbx.exec(code('example.com'), { timeoutMs: 60_000 });
    assert.doesNotMatch(bad.stdout, /code=200/);
    assert.doesNotMatch(bad.stdout, /exit=0/);
    engine.bus.flush();
    assert.ok(denied.some((d) => d.host === 'example.com' && d.reason === 'host not on allowlist'), JSON.stringify(denied));

    const direct = await sbx.exec(code('registry.npmjs.org', "--noproxy '*'"), { timeoutMs: 60_000 });
    assert.doesNotMatch(direct.stdout, /exit=0/, 'no route out except the proxy');

    const internal = await sbx.exec(`curl -sS -m 5 -o /dev/null -w 'code=%{http_code}\\n' http://169.254.169.254/latest/meta-data/ 2>&1; echo "exit=$?"`, { timeoutMs: 30_000 });
    assert.match(internal.stdout, /code=403/, 'metadata endpoint is blocked by the proxy');

    const local = await sbx.exec(`node -e "require('http').createServer((q,s)=>s.end('local-ok')).listen(4321,'127.0.0.1',function(){require('http').get('http://127.0.0.1:4321/',r=>{r.on('data',d=>{console.log(String(d));process.exit(0)})})})"`, { timeoutMs: 30_000 });
    assert.match(local.stdout, /local-ok/, 'localhost inside the sandbox bypasses the proxy (NO_PROXY)');

    const { port, token } = await engine.serve({ ui: false });
    const sock = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/`);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const peer = new RpcPeer(wsTransport(sock));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
    await assert.rejects(peer.request(Methods.egressAllow, { workspacePath: root, host: 'not a host' }), /DNS name/);
    assert.deepEqual(await peer.request(Methods.egressAllow, { workspacePath: root, host: 'Example.com' }), { ok: true, host: 'example.com' });
    const list = await peer.request(Methods.egressList, { workspacePath: root }) as { workspace: Array<{ host: string }> };
    assert.deepEqual(list.workspace.map((h) => h.host), ['example.com']);
    sock.close();

    const after = await sbx.exec(code('example.com'), { timeoutMs: 60_000 });
    assert.match(after.stdout, /code=200/, 'workspace allow is honored: ' + after.stdout);
    const row = engine.db.get<{ host: string }>('SELECT host FROM egress_allow');
    assert.equal(row?.host, 'example.com', 'allow is persisted');
  } finally {
    unsub();
    sbx.destroy();
    await engine.close();
  }
});

test('egress: per-tool allowlist — a host allowed for tool A is denied for tool B (F-SBX-3, §16.5)', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const root = realpathSync(ws());
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  engine.runtime.workspaceFor(root);
  const denied: Array<{ host: string; tool?: string; reason: string }> = [];
  const unsub = engine.bus.subscribe('egress.*', (e) => { if (e.topic === 'egress.denied') denied.push(e.data as never); });
  const dir = mkdtempSync(join(tmpdir(), 'helix-pertool-'));
  const closeA = await engine.egress.listen(join(dir, 'a.sock'), { sandboxId: 'mcp-a', root, ws: 'engine', tool: 'mcp:alpha' });
  const closeB = await engine.egress.listen(join(dir, 'b.sock'), { sandboxId: 'mcp-b', root, ws: 'engine', tool: 'mcp:beta' });
  const { port, token } = await engine.serve({ ui: false });
  const sock = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(wsTransport(sock));
  try {
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
    assert.deepEqual(await peer.request(Methods.egressAllow, { host: 'tool-a.invalid', tool: 'mcp:alpha' }), { ok: true, host: 'tool-a.invalid', tool: 'mcp:alpha' });
    await assert.rejects(peer.request(Methods.egressAllow, { host: 'x.invalid', tool: 'bad tool' }), /mcp:<server>/);
    assert.match(await connectVia(join(dir, 'a.sock'), 'tool-a.invalid:443'), /502/, 'tool A: allowed, so the proxy dials upstream');
    assert.match(await connectVia(join(dir, 'b.sock'), 'tool-a.invalid:443'), /403/, 'tool B: same host is denied');
    engine.bus.flush();
    assert.deepEqual(denied.map((d) => [d.host, d.tool, d.reason]), [['tool-a.invalid', 'mcp:beta', 'host not on allowlist']]);
    const list = await peer.request(Methods.egressList, { workspacePath: root }) as { workspace: unknown[]; tools: Array<{ host: string; tool: string }> };
    assert.deepEqual(list.workspace, []);
    assert.deepEqual(list.tools.map((t) => [t.tool, t.host]), [['mcp:alpha', 'tool-a.invalid']]);
  } finally {
    unsub();
    sock.close();
    closeA();
    closeB();
    await engine.close();
  }
});

test('egress: proxy refuses non-web ports and IP-literal private targets without a sandbox', async () => {
  const seen: string[] = [];
  const proxy = new EgressProxy({ isAllowed: () => true, onDenied: (i) => seen.push(`${i.host}:${i.port}:${i.reason}`) });
  const sockPath = join(mkdtempSync(join(tmpdir(), 'helix-egs-')), 'p.sock');
  const close = await proxy.listen(sockPath, { sandboxId: 's', root: '/' });
  const { connect } = await import('node:net');
  const ask = (target: string) => new Promise<string>((resolve) => {
    const c = connect(sockPath, () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    c.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { c.destroy(); resolve(buf.split('\r\n')[0]); } });
    c.on('error', () => resolve(buf));
  });
  try {
    assert.match(await ask('example.com:22'), /403/);
    assert.match(await ask('10.0.0.1:443'), /403/);
    assert.deepEqual(seen, ['example.com:22:port 22 not allowed', '10.0.0.1:443:private address']);
  } finally {
    close();
  }
});

test('egress: a sentinel in a plain-http request body is blocked and reported', async () => {
  const root = ws();
  const exfil: Array<{ secret: string; host: string; where: string }> = [];
  const proxy = new EgressProxy({ isAllowed: () => true, onDenied: () => {}, onExfil: (info) => exfil.push(info) });
  const b = proxy.bind(root, { name: 'API_TOKEN', value: 'real-secret', injectHosts: ['api.example.test'] });
  const sock = join(mkdtempSync(join(tmpdir(), 'helix-egress-sock-')), 'p.sock');
  const close = await proxy.listen(sock, { sandboxId: 'sbx_body', root });
  try {
    const { request } = await import('node:http');
    const send = (body: string, type: string) => new Promise<{ status: number; text: string }>((res, rej) => {
      const q = request({ socketPath: sock, method: 'POST', path: 'http://example.org/collect', headers: { host: 'example.org', 'content-type': type } }, (r) => {
        let text = '';
        r.on('data', (c) => (text += c));
        r.on('end', () => res({ status: r.statusCode ?? 0, text }));
      });
      q.on('error', rej);
      q.end(body);
    });
    const r = await send(`payload=${b.sentinel}`, 'application/octet-stream');
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /never sent over plain http/);
    assert.deepEqual(exfil, [{ secret: 'API_TOKEN', host: 'example.org', where: 'plain http body' }]);
  } finally {
    close();
    proxy.close();
  }
});
