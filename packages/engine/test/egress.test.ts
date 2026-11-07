import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { EgressProxy, hostMatches, isPrivateAddress, normalizeHost, DEFAULT_EGRESS_ALLOW } from '../src/sandbox/egress.ts';
import { LocalSandbox, unshareAvailable } from '../src/sandbox/sandbox.ts';
import { Engine, wsTransport } from '../src/engine.ts';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helix-egress-ws-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  return dir;
}

/** True when the host itself can reach the public registry (CI without internet skips the live checks). */
const hostOnline = await new Promise<boolean>((resolve) => {
  const s = connect({ host: 'registry.npmjs.org', port: 443, timeout: 4000 });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.once('timeout', () => { s.destroy(); resolve(false); });
});

test('egress: host normalisation, wildcard matching and private-address detection', () => {
  assert.equal(normalizeHost(' Registry.NPMJS.org. '), 'registry.npmjs.org');
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost('bad host'), null);
  assert.equal(normalizeHost('a'.repeat(300)), null);
  assert.ok(hostMatches('registry.npmjs.org', DEFAULT_EGRESS_ALLOW));
  assert.ok(!hostMatches('evil-registry.npmjs.org.attacker.com', DEFAULT_EGRESS_ALLOW));
  assert.ok(hostMatches('api.example.com', ['*.example.com']));
  assert.ok(!hostMatches('example.com', ['*.example.com']), 'wildcard does not match the apex');
  assert.ok(!hostMatches('badexample.com', ['*.example.com']));
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['104.16.0.35', '8.8.8.8', '2606:4700::6810:1']) assert.ok(!isPrivateAddress(a), a);
});

test('egress proxy: allowlisted HTTP + CONNECT are forwarded; others are denied and reported', async () => {
  const upstream = createServer((req, res) => res.end(`upstream ${req.method} ${req.url} host=${req.headers.host}`));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const port = (upstream.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'helix-egress-'));
  const denied: Array<{ host: string; reason: string }> = [];
  const allowed: string[] = [];
  const lookup = (_h: string, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
  const proxy = new EgressProxy(join(dir, 'p.sock'), { allow: (h) => h === 'ok.test', onDenied: (d) => denied.push(d), onAllowed: (d) => allowed.push(d.host) }, { lookup, ports: [port], allowPrivateTargets: true });
  await proxy.ready;
  const viaProxy = (path: string, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: proxy.socketPath, method, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const tunnel = (target: string) => new Promise<string>((resolve, reject) => {
    const req = request({ socketPath: proxy.socketPath, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve(`status ${res.statusCode}`); return; }
      socket.write(`GET /tunnelled HTTP/1.1\r\nhost: ok.test\r\nconnection: close\r\n\r\n`);
      let data = '';
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const ok = await viaProxy(`http://ok.test:${port}/hello?x=1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, `upstream GET /hello?x=1 host=ok.test:${port}`);
    assert.match(await tunnel(`ok.test:${port}`), /upstream GET \/tunnelled host=ok\.test/);

    const no = await viaProxy(`http://evil.test:${port}/`);
    assert.equal(no.status, 403);
    assert.match(no.body, /not on allowlist: evil\.test/);
    assert.equal(await tunnel(`evil.test:${port}`), 'status 403');
    assert.equal(await tunnel('ok.test:22'), 'status 403', 'non-allowlisted port');
    assert.equal((await viaProxy('/relative')).status, 400);
    assert.deepEqual(denied.map((d) => `${d.host}:${d.reason}`), ['evil.test:host not on allowlist', 'evil.test:host not on allowlist', 'ok.test:port 22 not allowed']);
    assert.ok(allowed.includes('ok.test'));
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test('egress proxy: allowlisted names that resolve to private addresses are refused (rebinding / metadata)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-egress-'));
  const denied: string[] = [];
  const lookup = (_h: string, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
  const proxy = new EgressProxy(join(dir, 'p.sock'), { allow: () => true, onDenied: (d) => denied.push(d.reason) }, { lookup });
  await proxy.ready;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: proxy.socketPath, method: 'CONNECT', path: 'metadata.test:443' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.deepEqual(denied, ['resolves to a private address']);
  } finally {
    await proxy.close();
  }
});

test('sandbox egress: only the proxy path works; direct sockets and --noproxy fail; denials are reported', { skip: !unshareAvailable() && 'unshare unavailable' }, async () => {
  const denied: string[] = [];
  const sbx = new LocalSandbox('sbx_eg1', workspace(), { egress: { allow: (h) => hostMatches(h, DEFAULT_EGRESS_ALLOW), onDenied: (d) => denied.push(d.host) } });
  try {
    assert.equal(sbx.info().egress, 'proxy');
    const r = await sbx.exec([
      `echo "proxy=$HTTPS_PROXY"`,
      `curl -sS -m 10 -o /dev/null -w 'denied=%{http_code}\\n' https://example.com/ 2>&1 | tail -1`,
      `curl -sS -m 5 --noproxy '*' https://registry.npmjs.org/ >/dev/null 2>&1 && echo BYPASS || echo noproxy-failed`,
      `node -e "require('net').connect(443,'104.16.0.35').on('connect',()=>{console.log('RAW-CONNECTED');process.exit(0)}).on('error',e=>{console.log('raw-failed',e.code);process.exit(0)})"`,
      `sleep 0.2 & wait; echo wait-ok`,
    ].join('; '), { timeoutMs: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /proxy=http:\/\/127\.0\.0\.1:3128/);
    assert.match(r.stdout, /CONNECT tunnel failed, response 403|denied=000/);
    assert.match(r.stdout, /noproxy-failed/);
    assert.ok(!r.stdout.includes('BYPASS') && !r.stdout.includes('RAW-CONNECTED'), r.stdout);
    assert.match(r.stdout, /raw-failed/);
    assert.match(r.stdout, /wait-ok/, 'a bare `wait` does not block on the forwarder');
    assert.deepEqual(denied, ['example.com']);
  } finally {
    sbx.destroy();
  }
});

test('sandbox egress (live): allowlisted registry is reachable through the proxy with curl and node fetch', { skip: (!unshareAvailable() && 'unshare unavailable') || (!hostOnline && 'host has no internet access') }, async () => {
  const sbx = new LocalSandbox('sbx_eg2', workspace(), { egress: { allow: (h) => hostMatches(h, DEFAULT_EGRESS_ALLOW), onDenied: () => {} } });
  try {
    const r = await sbx.exec(`curl -sS -m 20 -o /dev/null -w 'curl=%{http_code}\\n' https://registry.npmjs.org/; node -e "fetch('https://registry.npmjs.org/left-pad').then(r=>console.log('fetch='+r.status)).catch(e=>console.log('fetch-err',e.cause?.code??e.message))"`, { timeoutMs: 60_000 });
    assert.match(r.stdout, /curl=200/, r.stdout + r.stderr);
    assert.match(r.stdout, /fetch=200/, r.stdout + r.stderr);
  } finally {
    sbx.destroy();
  }
});

test('engine: egress.list/allow/revoke persist per workspace, emit audit events, and take effect immediately', { skip: !unshareAvailable() && 'unshare unavailable' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const root = workspace();
  const other = workspace();
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  try {
    const { port, token } = await engine.serve({});
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/`);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const peer = new RpcPeer(wsTransport(ws));
    const events: Array<{ topic: string; data: Record<string, unknown> }> = [];
    peer.onNotification('event', (e: unknown) => events.push(e as never));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: ['egress.*'] });
    await assert.rejects(peer.request(Methods.egressAllow, { workspacePath: root, host: 'x.test' }), /unknown workspace/);
    engine.index(root);
    engine.index(other);

    const before = await peer.request(Methods.egressList, { workspacePath: root }) as { enabled: boolean; defaults: string[]; approved: unknown[] };
    assert.equal(before.enabled, true);
    assert.ok(before.defaults.includes('registry.npmjs.org'));
    assert.deepEqual(before.approved, []);

    const denied = await peer.request(Methods.terminalRun, { workspacePath: root, command: `curl -sS -m 10 -o /dev/null -w '%{http_code}' https://blocked.invalid/ 2>&1 | tail -1` }, 30_000) as { exitCode: number; sandbox: { egress: string } };
    assert.equal(denied.sandbox.egress, 'proxy');
    for (let i = 0; i < 50 && !events.some((e) => e.topic === 'egress.denied'); i++) await new Promise((r) => setTimeout(r, 20));
    const ev = events.find((e) => e.topic === 'egress.denied');
    assert.ok(ev, 'egress.denied event published');
    assert.equal(ev.data.host, 'blocked.invalid');
    assert.equal(ev.data.reason, 'host not on allowlist');

    await assert.rejects(peer.request(Methods.egressAllow, { workspacePath: root, host: '*.com' }), /wildcards/);
    await assert.rejects(peer.request(Methods.egressAllow, { workspacePath: root, host: 'not a host' }), /invalid host/);
    assert.deepEqual(await peer.request(Methods.egressAllow, { workspacePath: root, host: 'Blocked.Invalid' }), { host: 'blocked.invalid', added: true });
    assert.deepEqual(await peer.request(Methods.egressAllow, { workspacePath: root, host: 'blocked.invalid' }), { host: 'blocked.invalid', added: false });
    assert.ok(engine.egress.isAllowed(engine.runtime.workspaceFor(root).id, 'blocked.invalid'));
    assert.ok(!engine.egress.isAllowed(engine.runtime.workspaceFor(other).id, 'blocked.invalid'), 'allowlist is per workspace');

    // Same (long-lived) terminal sandbox: the host now passes the allowlist and fails only at DNS (.invalid never resolves).
    events.length = 0;
    await peer.request(Methods.terminalRun, { workspacePath: root, command: `curl -sS -m 10 https://blocked.invalid/ 2>&1 | tail -1` }, 30_000);
    for (let i = 0; i < 50 && !events.some((e) => e.topic === 'egress.denied'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.find((e) => e.topic === 'egress.denied')?.data.reason, 'dns lookup failed');

    const listed = await peer.request(Methods.egressList, { workspacePath: root }) as { approved: Array<{ host: string }> };
    assert.deepEqual(listed.approved.map((a) => a.host), ['blocked.invalid']);
    assert.deepEqual(await peer.request(Methods.egressRevoke, { workspacePath: root, host: 'blocked.invalid' }), { host: 'blocked.invalid', removed: true });
    assert.ok(!engine.egress.isAllowed(engine.runtime.workspaceFor(root).id, 'blocked.invalid'));
    engine.bus.flush();
    const audit = engine.db.all<{ topic: string }>(`SELECT topic FROM audit_log WHERE topic LIKE 'egress.%' ORDER BY id`).map((r) => r.topic);
    assert.ok(audit.includes('egress.denied') && audit.includes('egress.allowed') && audit.includes('egress.revoked'), audit.join(','));
    ws.close();
  } finally {
    await engine.close();
  }
});

test('engine: HELIX_EGRESS=off keeps sandboxes fully offline', { skip: !unshareAvailable() && 'unshare unavailable' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const engine = new Engine({ home, env: { HELIX_EGRESS: 'off' }, recover: false, mcp: false, indexing: false });
  try {
    assert.equal(engine.egress.enabled, false);
  } finally {
    await engine.close();
  }
});
