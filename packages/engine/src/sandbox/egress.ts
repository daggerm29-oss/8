import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { rmSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import type { Db } from '../storage/db.ts';
import type { EventBus } from '../events/bus.ts';

/**
 * Egress control (F-SBX-3, §16.5). Sandboxes keep their private network namespace (no route out, so raw
 * sockets fail); the only way out is an HTTP/CONNECT proxy hosted by the Engine on a Unix socket inside the
 * sandbox's scratch dir, reached through an in-sandbox loopback forwarder. The proxy enforces a per-workspace
 * hostname allowlist and refuses to connect to private, loopback and link-local addresses (DNS rebinding,
 * cloud metadata). No TLS termination: HTTPS is tunnelled, so only the CONNECT hostname is inspected.
 */

export const DEFAULT_EGRESS_ALLOW = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com'];
export const EGRESS_PORTS = new Set([80, 443]);
/** Port the in-sandbox forwarder listens on (inside the sandbox's own network namespace, so it never collides). */
export const SANDBOX_PROXY_PORT = 3128;

export interface EgressHooks {
  /** Live check, so a host approved mid-task works on the next request. */
  allow(host: string): boolean;
  onDenied(info: { host: string; port: number; reason: string }): void;
  onAllowed?(info: { host: string; port: number }): void;
}

/** Normalise a hostname for allowlist matching; returns null when it is not a plausible host. */
export function normalizeHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h || h.length > 253) return null;
  if (isIP(h)) return h;
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) return null;
  return h;
}

/** `example.com` matches exactly; `*.example.com` matches any subdomain (not the apex). */
export function hostMatches(host: string, patterns: Iterable<string>): boolean {
  for (const p of patterns) {
    if (p === host) return true;
    if (p.startsWith('*.') && host.endsWith(p.slice(1)) && host.length > p.length - 1) return true;
  }
  return false;
}

/** True for addresses the proxy must never dial: loopback, private, link-local, CGNAT, multicast, unspecified. */
export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

type LookupFn = (hostname: string, cb: (err: Error | null, addresses: LookupAddress[]) => void) => void;
const defaultLookup: LookupFn = (h, cb) => dnsLookup(h, { all: true }, (err, addrs) => cb(err, addrs ?? []));

/** Engine-side proxy for one sandbox. */
export class EgressProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket | Duplex>();
  readonly ready: Promise<void>;
  private closed = false;
  readonly socketPath: string;
  private readonly hooks: EgressHooks;
  private readonly lookup: LookupFn;
  private readonly ports: Set<number>;
  private readonly allowPrivateTargets: boolean;

  /** `opts` exists for hermetic tests only (local upstreams); sandboxes always use the defaults. */
  constructor(socketPath: string, hooks: EgressHooks, opts: { lookup?: LookupFn; ports?: number[]; allowPrivateTargets?: boolean } = {}) {
    this.socketPath = socketPath;
    this.hooks = hooks;
    this.lookup = opts.lookup ?? defaultLookup;
    this.ports = opts.ports ? new Set(opts.ports) : EGRESS_PORTS;
    this.allowPrivateTargets = opts.allowPrivateTargets ?? false;
    this.server = createServer((req, res) => void this.onRequest(req, res));
    this.server.on('connect', (req, socket, head) => void this.onConnect(req, socket, head));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    this.server.on('clientError', (_e, s) => s.destroy());
    rmSync(socketPath, { force: true });
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  /** Allowlist + port check, then resolve and reject private targets. Resolves to an IP to dial, or a denial reason. */
  private async check(rawHost: string, port: number): Promise<{ host: string; ip: string } | { host: string; denied: string }> {
    const host = normalizeHost(rawHost);
    if (!host || host.startsWith('*.')) return { host: String(rawHost).slice(0, 255), denied: 'invalid host' };
    if (!this.ports.has(port)) return { host, denied: `port ${port} not allowed` };
    if (!this.hooks.allow(host)) return { host, denied: 'host not on allowlist' };
    const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<LookupAddress[]>((r) => this.lookup(host, (err, a) => r(err ? [] : a)));
    if (!addrs.length) return { host, denied: 'dns lookup failed' };
    if (!this.allowPrivateTargets && addrs.some((a) => isPrivateAddress(a.address))) return { host, denied: 'resolves to a private address' };
    return { host, ip: addrs[0].address };
  }

  private deny(host: string, port: number, reason: string): void {
    try { this.hooks.onDenied({ host, port, reason }); } catch { /* hook errors never break the proxy */ }
  }

  private async onConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const m = (req.url ?? '').match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
    const port = m ? Number(m[2]) : 0;
    const verdict = await this.check(m?.[1] ?? '', port);
    if ('denied' in verdict) {
      this.deny(verdict.host, port, verdict.denied);
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nhelix egress: ${verdict.denied}: ${verdict.host}\n`);
      return;
    }
    const upstream = netConnect({ host: verdict.ip, port });
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
    upstream.once('connect', () => {
      this.hooks.onAllowed?.({ host: verdict.host, port });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); client.destroy(); });
    client.on('close', () => upstream.destroy());
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? ''); } catch { res.writeHead(400).end('helix egress: absolute URL required\n'); return; }
    if (url.protocol !== 'http:') { res.writeHead(400).end('helix egress: only http:// is proxied directly; use CONNECT for https\n'); return; }
    const port = Number(url.port || 80);
    const verdict = await this.check(url.hostname, port);
    if ('denied' in verdict) {
      this.deny(verdict.host, port, verdict.denied);
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }).end(`helix egress: ${verdict.denied}: ${verdict.host}\n`);
      return;
    }
    const headers = { ...req.headers };
    for (const h of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive']) delete headers[h];
    headers.host = url.host;
    const up = httpRequest({ host: verdict.ip, port, method: req.method, path: url.pathname + url.search, headers }, (upRes) => {
      this.hooks.onAllowed?.({ host: verdict.host, port });
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    rmSync(this.socketPath, { force: true });
  }
}

/**
 * In-sandbox forwarder: 127.0.0.1:3128 → Unix socket. Exits when its parent shell goes away (no PID namespace
 * in the PTY path), and prints `ready` once listening so the prelude can wait without polling.
 */
export const FORWARDER_SOURCE = `const net=require('net');const sock=process.argv[2];const pp=process.ppid;
const srv=net.createServer(c=>{const u=net.connect(sock);c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.on('close',()=>u.destroy());});
srv.on('error',e=>{process.stdout.write('error '+e.code+'\\n');process.exit(1)});
srv.listen(${SANDBOX_PROXY_PORT},'127.0.0.1',()=>process.stdout.write('ready\\n'));
setInterval(()=>{if(process.ppid!==pp)process.exit(0)},250);`;

/**
 * Shell prelude run inside the sandbox before the user command. Uses a FIFO rather than process substitution
 * because /proc (hence /dev/fd) is not mounted in the contained root. The forwarder is `disown`ed so a bare
 * `wait` in the user's command does not block on it.
 */
export function egressPrelude(sandboxTmp: string): string {
  const fwd = `${sandboxTmp}/.helix-egress-fwd.cjs`;
  const sock = `${sandboxTmp}/.helix-egress.sock`;
  const fifo = `${sandboxTmp}/.helix-egress-ready.$$`;
  return `ip link set lo up 2>/dev/null; rm -f ${fifo}; mkfifo ${fifo} && { exec 8<>${fifo}; NODE_USE_ENV_PROXY= node ${fwd} ${sock} </dev/null >${fifo} 2>/dev/null & disown; read -t 5 -u 8 __helix_fwd; exec 8<&-; rm -f ${fifo}; unset __helix_fwd; }\n`;
}

export function proxyEnv(): Record<string, string> {
  const url = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    npm_config_proxy: url, npm_config_https_proxy: url, NODE_USE_ENV_PROXY: '1',
  };
}

/** Per-workspace allowlist: defaults ∪ `HELIX_EGRESS_ALLOW` (comma list) ∪ hosts approved in SQLite (`egress_allow`). */
export class EgressPolicy {
  private readonly extra: string[];
  private readonly db: Db;
  private readonly bus: EventBus;
  /** `HELIX_EGRESS=off` keeps sandboxes fully offline (pre-F-SBX-3 behaviour). */
  readonly enabled: boolean;

  constructor(db: Db, bus: EventBus, env: NodeJS.ProcessEnv = process.env) {
    this.db = db;
    this.bus = bus;
    this.extra = (env.HELIX_EGRESS_ALLOW ?? '').split(',').map((h) => normalizeHost(h)).filter((h): h is string => !!h);
    this.enabled = env.HELIX_EGRESS !== 'off';
  }

  list(ws: string): { defaults: string[]; configured: string[]; approved: Array<{ host: string; at: string }> } {
    return { defaults: DEFAULT_EGRESS_ALLOW, configured: this.extra, approved: this.db.all<{ host: string; at: string }>('SELECT host, created_at AS at FROM egress_allow WHERE ws = ? ORDER BY host', ws) };
  }

  isAllowed(ws: string, host: string): boolean {
    if (hostMatches(host, DEFAULT_EGRESS_ALLOW) || hostMatches(host, this.extra)) return true;
    const rows = this.db.all<{ host: string }>('SELECT host FROM egress_allow WHERE ws = ?', ws).map((r) => r.host);
    return hostMatches(host, rows);
  }

  allow(ws: string, rawHost: string): { host: string; added: boolean } {
    const host = normalizeHost(rawHost);
    if (!host) throw new Error(`invalid host '${String(rawHost).slice(0, 100)}'`);
    if (host === '*' || /^\*\.[^.]+$/.test(host)) throw new Error('wildcards must name at least a second-level domain (e.g. *.example.com)');
    const before = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM egress_allow WHERE ws = ? AND host = ?', ws, host)?.n ?? 0;
    if (!before) this.db.run('INSERT INTO egress_allow (ws, host, created_at) VALUES (?, ?, ?)', ws, host, new Date().toISOString());
    this.bus.publish({ topic: 'egress.allowed', ws, data: { host, added: !before }, persist: 'audit' });
    return { host, added: !before };
  }

  revoke(ws: string, rawHost: string): { host: string; removed: boolean } {
    const host = normalizeHost(rawHost) ?? String(rawHost);
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM egress_allow WHERE ws = ? AND host = ?', ws, host)?.n ?? 0;
    this.db.run('DELETE FROM egress_allow WHERE ws = ? AND host = ?', ws, host);
    if (n) this.bus.publish({ topic: 'egress.revoked', ws, data: { host }, persist: 'audit' });
    return { host, removed: n > 0 };
  }

  /** Hooks for one sandbox. Denials publish `egress.denied` (deduped per host+port+reason for 10 s to avoid retry floods). */
  hooks(ws: string, meta: { sandbox: string; task?: string; workspacePath: string }): EgressHooks {
    const lastDenied = new Map<string, number>();
    return {
      allow: (host) => this.isAllowed(ws, host),
      onDenied: ({ host, port, reason }) => {
        const now = Date.now();
        const key = `${host}|${port}|${reason}`;
        if ((lastDenied.get(key) ?? 0) > now - 10_000) return;
        lastDenied.set(key, now);
        this.bus.publish({ topic: 'egress.denied', ws, task: meta.task, data: { host, port, reason, sandbox: meta.sandbox, workspacePath: meta.workspacePath }, persist: 'audit' });
      },
    };
  }
}
