import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns';
import { rmSync } from 'node:fs';

/** Hosts reachable from every sandbox without approval (§16.5 defaults, M1 subset). */
export const DEFAULT_EGRESS_ALLOWLIST = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'codeload.github.com'];

/** Loopback port the in-sandbox forwarder listens on; each command has its own network namespace. */
export const SANDBOX_PROXY_PORT = 39128;

export interface EgressContext {
  sandboxId: string;
  /** Real workspace root of the sandbox. */
  root: string;
}

export interface EgressPolicy {
  isAllowed(host: string, ctx: EgressContext): boolean;
  onDenied(info: { host: string; port: number; method: string; reason: string }, ctx: EgressContext): void;
}

/** RFC1918, loopback, link-local (incl. cloud metadata), CGNAT, ULA: always blocked (§16.5). */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s.startsWith('::ffff:')) return isBlockedAddress(s.slice(7));
    return s === '::' || s === '::1' || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('fc') || s.startsWith('fd');
  }
  return true;
}

/** DNS lookup that refuses private/loopback targets, so allowlisted names cannot be pointed inward. */
function safeLookup(host: string, opts: { all?: boolean }, cb: (err: Error | null, address: unknown, family?: number) => void): void {
  lookup(host, { all: true }, (err, addresses) => {
    if (err) return cb(err, opts.all ? [] : '', 0);
    const blocked = addresses.find((a) => isBlockedAddress(a.address));
    if (blocked || !addresses.length) return cb(new Error(`blocked address ${blocked?.address ?? 'none'} for ${host}`), opts.all ? [] : '', 0);
    if (opts.all) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  });
}

function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return { host: '', port: 0 };
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : defPort };
}

/**
 * Engine egress proxy (F-SBX-3, §16.5): HTTP forward proxy + CONNECT tunnels, no TLS termination.
 * One Unix-socket listener per sandbox (bind-visible inside its contained root); the sandbox's own
 * network namespace has only loopback, so this socket is the single way out.
 */
export class EgressProxy {
  private readonly servers = new Set<Server>();

  private readonly policy: EgressPolicy;

  constructor(policy: EgressPolicy) {
    this.policy = policy;
  }

  /** Listen on `socketPath` for one sandbox. Resolves with a close function. */
  listen(socketPath: string, ctx: EgressContext): Promise<() => void> {
    rmSync(socketPath, { force: true });
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => this.forward(req, res, ctx));
    server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => this.tunnel(req, client, head, ctx));
    server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.on('clientError', (_e, s) => s.destroy());
    this.servers.add(server);
    const close = () => {
      if (!this.servers.delete(server)) return;
      server.close();
      sockets.forEach((s) => s.destroy());
      rmSync(socketPath, { force: true });
    };
    return new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(socketPath, () => { server.off('error', rej); res(close); });
    });
  }

  private check(host: string, port: number, method: string, ctx: EgressContext): string | null {
    let reason: string | null = null;
    if (!host) reason = 'bad target';
    else if (isIP(host) && isBlockedAddress(host)) reason = 'private address';
    else if (port !== 443 && port !== 80) reason = `port ${port} not allowed`;
    else if (!this.policy.isAllowed(host, ctx)) reason = 'host not on allowlist';
    if (reason) this.policy.onDenied({ host, port, method, reason }, ctx);
    return reason;
  }

  private tunnel(req: IncomingMessage, client: Socket, head: Buffer, ctx: EgressContext): void {
    const { host, port } = splitHostPort(req.url ?? '', 443);
    const denied = this.check(host, port, 'CONNECT', ctx);
    if (denied) {
      client.end(`HTTP/1.1 403 Forbidden\r\nX-Helix-Egress: denied\r\nContent-Type: text/plain\r\n\r\nhelix egress denied: ${host} (${denied})\n`);
      return;
    }
    const upstream = connect({ host, port, lookup: safeLookup as never });
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const fail = () => { upstream.destroy(); client.destroy(); };
    upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); fail(); });
    client.on('error', fail);
    client.on('close', fail);
  }

  private forward(req: IncomingMessage, res: ServerResponse, ctx: EgressContext): void {
    let url: URL;
    try { url = new URL(req.url ?? ''); } catch { res.writeHead(400).end('absolute URL required\n'); return; }
    if (url.protocol !== 'http:') { res.writeHead(400).end('only http:// via forward proxy; use CONNECT for https\n'); return; }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port ? Number(url.port) : 80;
    const denied = this.check(host, port, req.method ?? 'GET', ctx);
    if (denied) { res.writeHead(403, { 'X-Helix-Egress': 'denied', 'Content-Type': 'text/plain' }).end(`helix egress denied: ${host} (${denied})\n`); return; }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = httpRequest({ host, port, method: req.method, path: url.pathname + url.search, headers, lookup: safeLookup as never }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  }

  close(): void {
    for (const s of [...this.servers]) s.close();
    this.servers.clear();
  }
}

/**
 * In-sandbox bridge forwarder, run with the toolchain's node inside the sandbox network namespace.
 * argv: mode sock port readyFile. `tcp`: listen on 127.0.0.1:port → unix sock (egress). `unix`: listen on sock →
 * 127.0.0.1:port (exposed port). Exits when its parent shell exits (reparenting changes ppid).
 */
export const FORWARDER_SOURCE = `const net = require('net'); const fs = require('fs');
const [mode, sock, port, ready] = process.argv.slice(2);
const ppid = process.ppid;
const pipe = (c) => { const u = mode === 'tcp' ? net.connect(sock) : net.connect(Number(port), '127.0.0.1'); c.pipe(u); u.pipe(c); const k = () => { c.destroy(); u.destroy(); }; c.on('error', k); u.on('error', k); c.on('close', k); u.on('close', k); };
const srv = net.createServer(pipe);
const done = () => fs.writeFileSync(ready, '');
if (mode === 'tcp') srv.listen(Number(port), '127.0.0.1', done); else { try { fs.unlinkSync(sock); } catch {} srv.listen(sock, done); }
setInterval(() => { if (process.ppid !== ppid) { try { if (mode !== 'tcp') fs.unlinkSync(sock); } catch {} process.exit(0); } }, 300);
`;
