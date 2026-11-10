import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { TLSSocket } from 'node:tls';
import { CertAuthority } from './x509.ts';

/** A secret the sandbox only sees as a sentinel; the proxy swaps in the value for `injectHosts` (F-SBX-4, §16.6). */
export interface SecretBinding {
  name: string;
  injectHosts: string[];
  sentinel: string;
  value: string;
  /** How many times the proxy has swapped this secret into a request (credential use, §26.5). Never the value. */
  uses: number;
}

/** Request bodies with these content types are scanned (and substituted); others pass unscanned. */
const SCANNED_BODY = /json|x-www-form-urlencoded|^text\/|xml|graphql/i;
const MAX_SCANNED_BODY = 4 * 1024 * 1024;

/** Test seam: route intercepted upstream requests elsewhere and trust an extra CA. */
export interface UpstreamOverride {
  resolve: (host: string, port: number) => { host: string; port: number };
  ca?: string;
}

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
  /** A sentinel was sent somewhere its secret may not go; the request was blocked. */
  onExfil?(info: { secret: string; host: string; where: string }, ctx: EgressContext): void;
  /** The proxy injected a bound secret into a request to `host` (by count, not value). */
  onInject?(info: { secret: string; host: string; where: string; uses: number }, ctx: EgressContext): void;
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
  private readonly upstream?: UpstreamOverride;
  /** Secret bindings per real workspace root (in memory only, like Vault v0). */
  private readonly bindings = new Map<string, SecretBinding[]>();
  /** Per-sandbox CA, trusted only inside that sandbox (via its CA bundle env). */
  private readonly cas = new Map<string, CertAuthority>();
  private readonly mitmMeta = new WeakMap<object, { host: string; port: number; ctx: EgressContext }>();
  private readonly mitm: Server;

  constructor(policy: EgressPolicy, opts: { upstream?: UpstreamOverride } = {}) {
    this.policy = policy;
    this.upstream = opts.upstream;
    this.mitm = createServer((req, res) => this.relay(req, res));
    this.mitm.on('clientError', (_e, s) => s.destroy());
  }

  /** Bind (or rebind) a secret for a workspace; returns its sentinel. The real value never enters a sandbox. */
  bind(root: string, b: { name: string; value: string; injectHosts: string[] }): SecretBinding {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.name)) throw new Error(`invalid secret name: ${b.name}`);
    if (!b.value) throw new Error(`secret ${b.name} has no value`);
    const hosts = [...new Set(b.injectHosts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
    if (!hosts.length) throw new Error('injectHosts must name at least one host');
    const list = (this.bindings.get(root) ?? []).filter((x) => x.name !== b.name);
    const binding: SecretBinding = { name: b.name, value: b.value, injectHosts: hosts, sentinel: `helix_sntl_${randomBytes(16).toString('hex')}`, uses: 0 };
    list.push(binding);
    this.bindings.set(root, list);
    return binding;
  }

  bindingsFor(root: string): SecretBinding[] {
    return this.bindings.get(root) ?? [];
  }

  /** Env entries for a sandbox of `root`: each bound secret name → its sentinel. */
  sentinelEnv(root: string): Record<string, string> {
    return Object.fromEntries(this.bindingsFor(root).map((b) => [b.name, b.sentinel]));
  }

  caFor(sandboxId: string): CertAuthority {
    let ca = this.cas.get(sandboxId);
    if (!ca) { ca = new CertAuthority(`Helix sandbox CA ${sandboxId}`); this.cas.set(sandboxId, ca); }
    return ca;
  }

  private intercepts(host: string, root: string): boolean {
    return this.bindingsFor(root).some((b) => b.injectHosts.includes(host));
  }

  /** Terminate TLS for a bound host with a leaf cert from the sandbox CA and relay each request (§16.6). */
  private intercept(host: string, port: number, client: Socket, head: Buffer, ctx: EgressContext): void {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.unshift(head);
    const leaf = this.caFor(ctx.sandboxId).leaf(host);
    const tls = new TLSSocket(client, { isServer: true, key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] });
    tls.on('error', () => client.destroy());
    this.mitmMeta.set(tls, { host, port, ctx });
    this.mitm.emit('connection', tls);
  }

  /** Swap sentinels allowed for `host`; null (and an exfil alert) when any other sentinel is present. */
  private substitute(s: string, host: string, where: string, ctx: EgressContext): string | null {
    let out = s;
    for (const b of this.bindingsFor(ctx.root)) {
      if (!out.includes(b.sentinel)) continue;
      if (!b.injectHosts.includes(host)) { this.policy.onExfil?.({ secret: b.name, host, where }, ctx); return null; }
      out = out.split(b.sentinel).join(b.value);
      b.uses += 1;
      this.policy.onInject?.({ secret: b.name, host, where, uses: b.uses }, ctx);
    }
    return out;
  }

  private relay(req: IncomingMessage, res: ServerResponse): void {
    const meta = this.mitmMeta.get(req.socket);
    if (!meta) { res.writeHead(500).end(); return; }
    const { host, port, ctx } = meta;
    const deny = () => res.writeHead(403, { 'X-Helix-Egress': 'secret-blocked', 'Content-Type': 'text/plain' }).end(`helix: secret not allowed for ${host}\n`);
    const path = this.substitute(req.url ?? '/', host, 'url', ctx);
    if (path === null) { req.resume(); deny(); return; }
    const headers: Record<string, string | string[]> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      if (k === 'proxy-connection' || k === 'proxy-authorization' || k === 'content-length' || k === 'transfer-encoding') continue;
      const v = this.substitute(req.rawHeaders[i + 1], host, `header ${k}`, ctx);
      if (v === null) { req.resume(); deny(); return; }
      const prev = headers[k];
      headers[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_SCANNED_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_SCANNED_BODY) { res.writeHead(413).end('helix: request body too large for the masking proxy\n'); return; }
      let body = Buffer.concat(chunks);
      if (body.length && SCANNED_BODY.test(String(headers['content-type'] ?? ''))) {
        const s = this.substitute(body.toString('utf8'), host, 'body', ctx);
        if (s === null) { deny(); return; }
        body = Buffer.from(s, 'utf8');
      } else if (body.length) {
        const foreign = this.bindingsFor(ctx.root).find((b) => !b.injectHosts.includes(host) && body.includes(b.sentinel));
        if (foreign) { this.policy.onExfil?.({ secret: foreign.name, host, where: 'body' }, ctx); deny(); return; }
      }
      if (body.length || !['GET', 'HEAD'].includes(req.method ?? 'GET')) headers['content-length'] = String(body.length);
      const target = this.upstream?.resolve(host, port) ?? { host, port };
      const up = httpsRequest({ host: target.host, port: target.port, servername: isIP(host) ? undefined : host, method: req.method, path, headers, ...(this.upstream ? { ca: this.upstream.ca } : { lookup: safeLookup as never }) }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      up.end(body);
    });
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
      this.cas.delete(ctx.sandboxId);
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
    else if (!this.policy.isAllowed(host, ctx) && !this.intercepts(host, ctx.root)) reason = 'host not on allowlist';
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
    if (this.intercepts(host, ctx.root)) { this.intercept(host, port, client, head, ctx); return; }
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
    const leaked = this.bindingsFor(ctx.root).find((b) => (req.url ?? '').includes(b.sentinel) || req.rawHeaders.some((h) => h.includes(b.sentinel)));
    if (leaked) {
      this.policy.onExfil?.({ secret: leaked.name, host, where: 'plain http' }, ctx);
      res.writeHead(403, { 'X-Helix-Egress': 'secret-blocked', 'Content-Type': 'text/plain' }).end(`helix: secrets are never sent over plain http (${host})\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers['transfer-encoding'];
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_SCANNED_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_SCANNED_BODY) { res.writeHead(413).end('helix: request body too large for the egress proxy\n'); return; }
      const body = Buffer.concat(chunks);
      const inBody = this.bindingsFor(ctx.root).find((b) => body.includes(b.sentinel));
      if (inBody) {
        this.policy.onExfil?.({ secret: inBody.name, host, where: 'plain http body' }, ctx);
        res.writeHead(403, { 'X-Helix-Egress': 'secret-blocked', 'Content-Type': 'text/plain' }).end(`helix: secrets are never sent over plain http (${host})\n`);
        return;
      }
      if (body.length || !['GET', 'HEAD'].includes(req.method ?? 'GET')) headers['content-length'] = String(body.length);
      else delete headers['content-length'];
      const up = httpRequest({ host, port, method: req.method, path: url.pathname + url.search, headers, lookup: safeLookup as never }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      up.end(body);
    });
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
