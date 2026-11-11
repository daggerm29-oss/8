import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { prefixedId } from '../util/ids.ts';
import { DEFAULT_RO_PATHS, LocalSandbox, SandboxUnavailableError, sandboxProcAvailable } from '../sandbox/sandbox.ts';

/** In-sandbox ports of the contained browser: DevTools (exposed to the Engine) and the dev-server proxy (inbound). */
const CDP_PORT = 9222;
const PROXY_PORT = 9333;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Host side of the contained browser's only network route (§16.3, §18.5): an HTTP proxy that forwards plain
 * requests and CONNECT tunnels to host-loopback ports the caller allows (the running dev servers) and answers 403
 * to everything else, so page scripts cannot reach the Engine RPC port, other host services, or the internet.
 */
export function browserProxy(allow: (host: string, port: number) => boolean): (client: Socket) => void {
  const target = (host: string, port: number) => LOOPBACK.has(host) && Number.isInteger(port) && allow(host, port);
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try { url = new URL(req.url ?? ''); } catch { res.writeHead(400).end(); return; }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (url.protocol !== 'http:' || !target(url.hostname, port)) { res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked by Helix browser policy'); return; }
    const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path: url.pathname + url.search, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    if (!m || !target(m[1], Number(m[2]))) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = netConnect(Number(m[2]), '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
    const end = () => { client.destroy(); up.destroy(); };
    up.on('error', end); client.on('error', end);
  });
  return (client) => server.emit('connection', client);
}

const CHROME_CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

/** Locate a Chrome/Chromium binary (`HELIX_CHROME` overrides). */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HELIX_CHROME && existsSync(env.HELIX_CHROME)) return env.HELIX_CHROME;
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  source: 'console' | 'exception' | 'log';
  url?: string;
  line?: number;
  /** Identical messages are counted, not repeated (§18.3). */
  count: number;
}

export interface NetEvent {
  method: string;
  /** Query values whose key looks secret (token, key, auth, …) are replaced with `[redacted]`. */
  url: string;
  status?: number;
  type?: string;
  failed?: string;
  ms?: number;
}

export interface A11yNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  state?: string[];
  children?: A11yNode[];
}

/** Environment Snapshot v1 subset (F-PRV-4, §18.4): no build status, visual pHash, or boxes yet. */
export interface EnvironmentSnapshot {
  v: 1;
  seq: number;
  at: string;
  page: { url: string; title: string; viewport: { w: number; h: number }; scroll: { y: number; maxY: number } };
  ui: { tree: A11yNode[]; textDigest: string; focused?: string };
  console: { newErrors: ConsoleEntry[]; newWarnings: number };
  network: { failed: NetEvent[]; slow: NetEvent[]; pending: number };
  diff?: { since: number; added: A11yNode[]; removed: A11yNode[]; changed: Array<{ ref: string; field: string; from: string; to: string }> };
}

const SECRET_QUERY = /token|key|secret|pass|auth|sig|session|code|credential/i;
const SLOW_MS = 1000;

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (SECRET_QUERY.test(k)) u.searchParams.set(k, '[redacted]');
    return u.href.replace(/%5Bredacted%5D/g, '[redacted]');
  } catch { return raw; }
}

const KEEP_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'tab', 'switch', 'slider', 'spinbutton',
  'heading', 'banner', 'navigation', 'main', 'contentinfo', 'complementary', 'form', 'search', 'dialog', 'alert', 'alertdialog', 'status', 'img', 'image', 'table', 'article']);
const LANDMARKS = new Set(['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'form', 'search', 'dialog', 'region']);
const STATES = ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'focused', 'required', 'invalid'];
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface RawAx { nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; properties?: Array<{ name: string; value: { value?: unknown } }>; childIds?: string[]; parentId?: string }

/** Deterministic pruning (§18.4 steps 2–5, minus boxes): keep interactive roles, landmarks, headings, alerts, named images; lift everything else. */
export function pruneAxTree(raw: RawAx[]): { tree: A11yNode[]; focused?: string } {
  const byId = new Map(raw.map((n) => [n.nodeId, n]));
  const root = raw.find((n) => !n.parentId || !byId.has(n.parentId));
  const used = new Map<string, number>();
  let focused: string | undefined;
  const visit = (n: RawAx, landmarks: string[]): A11yNode[] => {
    const role = String(n.role?.value ?? '');
    const name = String(n.name?.value ?? '').trim();
    const nextLandmarks = LANDMARKS.has(role) ? [...landmarks, `${role}:${name}`] : landmarks;
    const kids = (n.childIds ?? []).flatMap((id) => { const c = byId.get(id); return c ? visit(c, nextLandmarks) : []; });
    const keep = !n.ignored && KEEP_ROLES.has(role) && !((role === 'img' || role === 'image') && !name);
    if (!keep) return kids;
    const base = createHash('sha1').update(`${role}\0${name}\0${landmarks.join('/')}`).digest('hex').slice(0, 6);
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    const node: A11yNode = { ref: `@e${base}${seen > 1 ? `-${seen}` : ''}`, role };
    if (name) node.name = clip(name);
    const value = n.value?.value;
    if (value !== undefined && value !== '') node.value = clip(String(value));
    const state = STATES.filter((st) => { const v = n.properties?.find((p) => p.name === st)?.value.value; return v !== undefined && v !== false && v !== 'false'; });
    if (state.length) node.state = state;
    if (state.includes('focused')) focused = node.ref;
    if (kids.length) node.children = kids;
    return [node];
  };
  return { tree: root ? visit(root, []) : [], focused };
}

function flatten(tree: A11yNode[], out = new Map<string, A11yNode>()): Map<string, A11yNode> {
  for (const n of tree) { out.set(n.ref, n); if (n.children) flatten(n.children, out); }
  return out;
}

export function diffSnapshots(prev: EnvironmentSnapshot, next: EnvironmentSnapshot): NonNullable<EnvironmentSnapshot['diff']> {
  const a = flatten(prev.ui.tree);
  const b = flatten(next.ui.tree);
  const strip = (n: A11yNode): A11yNode => { const { children: _c, ...rest } = n; return rest; };
  const changed: Array<{ ref: string; field: string; from: string; to: string }> = [];
  for (const [ref, n] of b) {
    const o = a.get(ref);
    if (!o) continue;
    for (const field of ['value', 'state'] as const) {
      const from = field === 'state' ? (o.state ?? []).join(',') : o.value ?? '';
      const to = field === 'state' ? (n.state ?? []).join(',') : n.value ?? '';
      if (from !== to) changed.push({ ref, field, from, to });
    }
  }
  return { since: prev.seq, added: [...b.keys()].filter((r) => !a.has(r)).map((r) => strip(b.get(r)!)), removed: [...a.keys()].filter((r) => !b.has(r)).map((r) => strip(a.get(r)!)), changed };
}

const nodeLine = (n: A11yNode) => `${n.ref} ${n.role}${n.name ? ` "${n.name}"` : ''}${n.value ? ` = "${n.value}"` : ''}${n.state?.length ? ` [${n.state.join(', ')}]` : ''}`;

/** Compact text form for the agent: diff only when a previous snapshot of the URL exists (unless `full`). */
export function formatSnapshot(s: EnvironmentSnapshot, opts: { full?: boolean } = {}): string {
  const out = [`snapshot #${s.seq} ${s.page.url} — "${s.page.title}" viewport ${s.page.viewport.w}x${s.page.viewport.h} scroll ${s.page.scroll.y}/${s.page.scroll.maxY} text ${s.ui.textDigest}${s.ui.focused ? ` focused ${s.ui.focused}` : ''}`];
  if (s.diff && !opts.full) {
    const d = s.diff;
    out.push(`ui diff since #${d.since}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed`);
    for (const n of d.added) out.push(`+ ${nodeLine(n)}`);
    for (const n of d.removed) out.push(`- ${nodeLine(n)}`);
    for (const c of d.changed) out.push(`~ ${c.ref} ${c.field}: "${c.from}" → "${c.to}"`);
  } else {
    const walk = (nodes: A11yNode[], depth: number) => { for (const n of nodes) { out.push(`${'  '.repeat(depth)}${nodeLine(n)}`); if (n.children) walk(n.children, depth + 1); } };
    out.push('ui:');
    walk(s.ui.tree, 1);
  }
  out.push(`console: ${s.console.newErrors.length} error(s), ${s.console.newWarnings} warning(s)`);
  for (const e of s.console.newErrors) out.push(`  [error${e.count > 1 ? ` ×${e.count}` : ''}] ${clip(e.text, 300)}`);
  out.push(`network: ${s.network.failed.length} failed, ${s.network.slow.length} slow, ${s.network.pending} pending`);
  for (const n of s.network.failed) out.push(`  ${n.method} ${n.url} → ${n.failed ?? n.status}`);
  for (const n of s.network.slow) out.push(`  slow ${n.method} ${n.url} ${n.ms} ms`);
  return out.join('\n');
}

/** Element card for select-and-instruct (§18.6): what the agent is told about the clicked element. */
export interface ElementCard {
  tag: string;
  role: string;
  name: string;
  text: string;
  classes: string[];
  id?: string;
  box: { x: number; y: number; w: number; h: number };
  style: { color: string; background: string; fontSize: string; padding: string; display: string };
  /** `data-helix-loc` on the element itself, else the nearest ancestor's. */
  loc: string | null;
  locOnElement: boolean;
  /** Every `data-helix-loc` from the outermost ancestor down to the element (component chain). */
  locChain: string[];
}

const ELEMENT_CARD_JS = `function (x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === document.documentElement) return null;
  const implicit = { button: 'button', a: 'link', input: 'textbox', textarea: 'textbox', select: 'combobox', img: 'img', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', form: 'form', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading' };
  const tag = el.tagName.toLowerCase();
  const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
  const chain = [];
  for (let p = el; p && p.nodeType === 1; p = p.parentElement) { const l = p.getAttribute('data-helix-loc'); if (l) chain.unshift(l); }
  const own = el.getAttribute('data-helix-loc');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { tag, role: el.getAttribute('role') || implicit[tag] || 'generic', name: (el.getAttribute('aria-label') || el.getAttribute('alt') || text).slice(0, 80), text: text.slice(0, 200),
    classes: [...el.classList], id: el.id || undefined, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    style: { color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, padding: cs.padding, display: cs.display },
    loc: own || chain[chain.length - 1] || null, locOnElement: !!own, locChain: chain };
}`;

export interface PageCapture {
  url: string;
  title: string;
  /** Visible text excerpt (first 2000 chars of `document.body.innerText`). */
  text: string;
  console: ConsoleEntry[];
  network: NetEvent[];
  /** Requests still in flight when the capture was taken. */
  pending: number;
  status: 'loaded' | 'timeout';
}

/** Minimal CDP session over one page WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    });
    ws.on('close', () => { for (const p of this.pending.values()) p.reject(new Error('CDP connection closed')); this.pending.clear(); });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: Record<string, unknown>) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, (this.listeners.get(method) ?? []).filter((f) => f !== fn));
  }
}

/** GET a DevTools JSON endpoint of the contained Chrome through the sandbox's exposed-port bridge. */
function cdpJson<T>(sandbox: LocalSandbox, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port: CDP_PORT, path, createConnection: () => sandbox.connectPort(CDP_PORT), timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body) as T); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Headless Chrome driven over CDP for agent browser tools (F-PRV-5 minimal, §18.5). One browser per Engine,
 * launched lazily with a throwaway profile; it only ever navigates to the workspace dev-server URL.
 */
export class PreviewBrowser {
  private sandbox?: LocalSandbox;
  private stopChrome?: () => void;
  private profile?: string;
  private cdp?: Promise<Cdp>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly chrome: string | null;
  private readonly outDir: string;
  private readonly allowTarget: (host: string, port: number) => boolean;
  private readonly createSandbox: (dir: string, roPaths: string[]) => LocalSandbox;
  private readonly lastSnapshot = new Map<string, EnvironmentSnapshot>();
  private seq = 0;

  /**
   * `allowTarget` decides which host-loopback ports pages may load (the Engine passes its running dev servers;
   * the default allows any loopback port). Chrome always runs inside a sandbox (F-SBX-2, SEC-1).
   */
  constructor(opts: { outDir: string; chrome?: string | null; allowTarget?: (host: string, port: number) => boolean; createSandbox?: (dir: string, roPaths: string[]) => LocalSandbox }) {
    this.outDir = opts.outDir;
    this.chrome = opts.chrome === undefined ? findChrome() : opts.chrome;
    this.allowTarget = opts.allowTarget ?? (() => true);
    this.createSandbox = opts.createSandbox ?? ((dir, roPaths) => new LocalSandbox(prefixedId('browser'), dir, { roPaths }));
  }

  /** Chrome is installed and the sandbox can give it the private /proc it needs; otherwise browser tools are refused. */
  available(): boolean {
    return this.chrome !== null && sandboxProcAvailable();
  }

  private connect(): Promise<Cdp> {
    if (this.cdp) return this.cdp;
    this.cdp = (async () => {
      if (!this.chrome) throw new Error('no Chrome/Chromium found (set HELIX_CHROME)');
      const chrome = realpathSync(this.chrome);
      const installDir = dirname(chrome);
      const roPaths = DEFAULT_RO_PATHS.some((p) => installDir.startsWith(p + '/')) ? [] : [installDir];
      this.profile = realpathSync(mkdtempSync(join(tmpdir(), 'helix-chrome-')));
      const sandbox = (this.sandbox = this.createSandbox(this.profile, roPaths));
      if (!sandbox.procCapable()) throw new SandboxUnavailableError('the contained browser needs a private /proc, which this sandbox cannot mount; Chrome is not started on the host');
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-dev-shm-usage', '--no-sandbox', '--no-zygote',
        `--user-data-dir=${this.profile}/data`, `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${CDP_PORT}`, `--proxy-server=http://127.0.0.1:${PROXY_PORT}`, '--proxy-bypass-list=<-loopback>', '--window-size=1280,800', 'about:blank'];
      const session = await sandbox.openStdio(`exec ${q(chrome)} ${args.map(q).join(' ')}`, { proc: true, exposePorts: [CDP_PORT], inbound: [{ port: PROXY_PORT, handler: browserProxy(this.allowTarget) }] });
      session.process.stdout.resume();
      session.process.stderr.resume();
      session.process.stdin.end();
      let exited = false;
      session.process.once('close', () => { exited = true; });
      this.stopChrome = session.kill;
      const deadline = Date.now() + 20_000;
      let pages: Array<{ type: string; webSocketDebuggerUrl: string }> | null = null;
      while (!pages) {
        if (Date.now() > deadline || exited) throw new Error('Chrome did not start in the sandbox');
        pages = await cdpJson<Array<{ type: string; webSocketDebuggerUrl: string }>>(sandbox, '/json/list').catch(() => null);
        if (!pages) await new Promise((r) => setTimeout(r, 100));
      }
      const page = pages.find((p) => p.type === 'page');
      if (!page) throw new Error('Chrome has no page target');
      const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, createConnection: () => sandbox.connectPort(CDP_PORT) });
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      const cdp = new Cdp(ws);
      await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable'), cdp.send('Network.enable'), cdp.send('Accessibility.enable')]);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      return cdp;
    })();
    this.cdp.catch(() => { this.cdp = undefined; this.kill(); });
    return this.cdp;
  }

  /** Navigate to `url`, wait for load (+ settle), and collect console output emitted meanwhile. */
  private load<T = undefined>(url: string, timeoutMs: number, after?: (cdp: Cdp) => Promise<T>): Promise<{ cdp: Cdp; capture: PageCapture; extra: T }> {
    const run = async () => {
      const cdp = await this.connect();
      const raw: Array<Omit<ConsoleEntry, 'count'>> = [];
      const entries = { push: (e: Omit<ConsoleEntry, 'count'>) => raw.push(e) };
      const requests = new Map<string, NetEvent & { t0: number; done: boolean }>();
      const offs = [
        cdp.on('Network.requestWillBeSent', (p) => {
          const r = p.request as { method: string; url: string };
          if (r.url.startsWith('data:')) return;
          requests.set(String(p.requestId), { method: r.method, url: redactUrl(r.url), type: p.type as string | undefined, t0: Number(p.timestamp), done: false });
        }),
        cdp.on('Network.responseReceived', (p) => {
          const q = requests.get(String(p.requestId));
          if (q) { q.status = (p.response as { status: number }).status; q.type = (p.type as string | undefined) ?? q.type; }
        }),
        cdp.on('Network.loadingFinished', (p) => {
          const q = requests.get(String(p.requestId));
          if (q) { q.done = true; q.ms = Math.round((Number(p.timestamp) - q.t0) * 1000); }
        }),
        cdp.on('Network.loadingFailed', (p) => {
          const q = requests.get(String(p.requestId));
          if (q) { q.done = true; q.failed = String(p.errorText ?? 'failed'); q.ms = Math.round((Number(p.timestamp) - q.t0) * 1000); }
        }),
        cdp.on('Runtime.consoleAPICalled', (p) => {
          const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
          entries.push({ level: String(p.type), text: args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' '), source: 'console' });
        }),
        cdp.on('Runtime.exceptionThrown', (p) => {
          const d = p.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number };
          entries.push({ level: 'error', text: d.exception?.description ?? d.text ?? 'exception', source: 'exception', url: d.url, line: d.lineNumber });
        }),
        cdp.on('Log.entryAdded', (p) => {
          const e = p.entry as { level: string; text: string; url?: string; lineNumber?: number };
          entries.push({ level: e.level, text: e.text, source: 'log', url: e.url, line: e.lineNumber });
        }),
      ];
      try {
        let loaded!: () => void;
        const onLoad = new Promise<void>((r) => { loaded = r; });
        const offLoad = cdp.on('Page.loadEventFired', () => loaded());
        await cdp.send('Page.navigate', { url });
        let timer: NodeJS.Timeout | undefined;
        const status = await Promise.race([onLoad.then(() => 'loaded' as const), new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); })]);
        clearTimeout(timer);
        offLoad();
        await new Promise((r) => setTimeout(r, 400));
        const info = await cdp.send<{ result: { value: { title: string; text: string; url: string } } }>('Runtime.evaluate', {
          expression: '({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 2000) })', returnByValue: true,
        });
        const extra = (after ? await after(cdp) : undefined) as T;
        const deduped: ConsoleEntry[] = [];
        for (const e of raw) {
          const same = deduped.find((d) => d.level === e.level && d.text === e.text && d.source === e.source);
          if (same) same.count++; else deduped.push({ ...e, count: 1 });
        }
        const network = [...requests.values()].map(({ t0: _t, done: _d, ...n }) => n);
        return { cdp, capture: { ...info.result.value, console: deduped, network, pending: [...requests.values()].filter((r) => !r.done).length, status }, extra };
      } finally { offs.forEach((o) => o()); }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Screenshot the page at `url` into `outDir`; returns the PNG path plus page facts. */
  async screenshot(url: string, opts: { timeoutMs?: number } = {}): Promise<PageCapture & { path: string; bytes: number }> {
    const { cdp, capture } = await this.load(url, opts.timeoutMs ?? 15_000);
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    mkdirSync(this.outDir, { recursive: true });
    const path = join(this.outDir, `${prefixedId('shot')}.png`);
    const buf = Buffer.from(shot.data, 'base64');
    writeFileSync(path, buf);
    return { ...capture, path, bytes: buf.length };
  }

  /**
   * Environment Snapshot (F-PRV-4): load `url`, prune the accessibility tree into stable refs, and attach
   * telemetry (F-PRV-3) from this load. A previous snapshot of the same URL yields a ref-level diff.
   */
  async snapshot(url: string, opts: { timeoutMs?: number } = {}): Promise<EnvironmentSnapshot> {
    const { capture, extra } = await this.load(url, opts.timeoutMs ?? 15_000, async (cdp) => {
      const ax = await cdp.send<{ nodes: RawAx[] }>('Accessibility.getFullAXTree');
      const page = await cdp.send<{ result: { value: { w: number; h: number; y: number; maxY: number; text: string } } }>('Runtime.evaluate', {
        expression: '({ w: innerWidth, h: innerHeight, y: Math.round(scrollY), maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight), text: document.body ? document.body.innerText : "" })', returnByValue: true,
      });
      return { ax: ax.nodes, page: page.result.value };
    });
    const { tree, focused } = pruneAxTree(extra.ax);
    const snap: EnvironmentSnapshot = {
      v: 1, seq: ++this.seq, at: new Date().toISOString(),
      page: { url: capture.url, title: capture.title, viewport: { w: extra.page.w, h: extra.page.h }, scroll: { y: extra.page.y, maxY: extra.page.maxY } },
      ui: { tree, textDigest: createHash('sha1').update(extra.page.text).digest('hex').slice(0, 12), ...(focused ? { focused } : {}) },
      console: { newErrors: capture.console.filter((e) => e.level === 'error'), newWarnings: capture.console.filter((e) => e.level === 'warning' || e.level === 'warn').reduce((n, e) => n + e.count, 0) },
      network: { failed: capture.network.filter((n) => n.failed || (n.status ?? 0) >= 400), slow: capture.network.filter((n) => !n.failed && (n.ms ?? 0) > SLOW_MS), pending: capture.pending },
    };
    const prev = this.lastSnapshot.get(url);
    if (prev) snap.diff = diffSnapshots(prev, snap);
    this.lastSnapshot.set(url, snap);
    return snap;
  }

  /** Load `url` and describe the element at viewport point (x, y) (§18.6 element card); null when nothing is there. */
  async locate(url: string, x: number, y: number, opts: { timeoutMs?: number } = {}): Promise<ElementCard | null> {
    const { extra } = await this.load(url, opts.timeoutMs ?? 15_000, async (cdp) => {
      const r = await cdp.send<{ result: { value: ElementCard | null } }>('Runtime.evaluate', { expression: `(${ELEMENT_CARD_JS})(${Number(x)}, ${Number(y)})`, returnByValue: true });
      return r.result.value;
    });
    return extra;
  }

  /** Load the page at `url` and return its console messages and uncaught exceptions. */
  async console(url: string, opts: { timeoutMs?: number } = {}): Promise<PageCapture> {
    return (await this.load(url, opts.timeoutMs ?? 15_000)).capture;
  }

  private kill(): void {
    this.stopChrome?.();
    this.stopChrome = undefined;
    this.sandbox?.destroy();
    this.sandbox = undefined;
    if (this.profile) rmSync(this.profile, { recursive: true, force: true });
    this.profile = undefined;
  }

  async close(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) { try { (await cdp).ws.close(); } catch { /* not connected */ } }
    this.kill();
  }
}
