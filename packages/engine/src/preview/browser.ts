import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { prefixedId } from '../util/ids.ts';

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
}

export interface PageCapture {
  url: string;
  title: string;
  /** Visible text excerpt (first 2000 chars of `document.body.innerText`). */
  text: string;
  console: ConsoleEntry[];
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

/**
 * Headless Chrome driven over CDP for agent browser tools (F-PRV-5 minimal, §18.5). One browser per Engine,
 * launched lazily with a throwaway profile; it only ever navigates to the workspace dev-server URL.
 */
export class PreviewBrowser {
  private proc?: ChildProcess;
  private profile?: string;
  private cdp?: Promise<Cdp>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly chrome: string | null;
  private readonly outDir: string;

  constructor(opts: { outDir: string; chrome?: string | null }) {
    this.outDir = opts.outDir;
    this.chrome = opts.chrome === undefined ? findChrome() : opts.chrome;
  }

  available(): boolean {
    return this.chrome !== null;
  }

  private connect(): Promise<Cdp> {
    if (this.cdp) return this.cdp;
    this.cdp = (async () => {
      if (!this.chrome) throw new Error('no Chrome/Chromium found (set HELIX_CHROME)');
      this.profile = mkdtempSync(join(tmpdir(), 'helix-chrome-'));
      this.proc = spawn(this.chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-dev-shm-usage', '--no-sandbox', `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
      const portFile = join(this.profile, 'DevToolsActivePort');
      const deadline = Date.now() + 20_000;
      while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
        if (Date.now() > deadline || this.proc.exitCode !== null) throw new Error('Chrome did not start');
        await new Promise((r) => setTimeout(r, 100));
      }
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = pages.find((p) => p.type === 'page');
      if (!page) throw new Error('Chrome has no page target');
      const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      const cdp = new Cdp(ws);
      await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      return cdp;
    })();
    this.cdp.catch(() => { this.cdp = undefined; this.kill(); });
    return this.cdp;
  }

  /** Navigate to `url`, wait for load (+ settle), and collect console output emitted meanwhile. */
  private load(url: string, timeoutMs: number): Promise<{ cdp: Cdp; capture: PageCapture }> {
    const run = async () => {
      const cdp = await this.connect();
      const entries: ConsoleEntry[] = [];
      const offs = [
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
        const status = await Promise.race([onLoad.then(() => 'loaded' as const), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))]);
        offLoad();
        await new Promise((r) => setTimeout(r, 400));
        const info = await cdp.send<{ result: { value: { title: string; text: string; url: string } } }>('Runtime.evaluate', {
          expression: '({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 2000) })', returnByValue: true,
        });
        return { cdp, capture: { ...info.result.value, console: entries, status } };
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

  /** Load the page at `url` and return its console messages and uncaught exceptions. */
  async console(url: string, opts: { timeoutMs?: number } = {}): Promise<PageCapture> {
    return (await this.load(url, opts.timeoutMs ?? 15_000)).capture;
  }

  private kill(): void {
    try { this.proc?.kill('SIGKILL'); } catch { /* gone */ }
    this.proc = undefined;
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
