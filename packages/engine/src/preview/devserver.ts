import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { get as httpGet } from 'node:http';
import { LocalSandbox } from '../sandbox/sandbox.ts';
import type { EgressProxy } from '../sandbox/egress.ts';
import { prefixedId } from '../util/ids.ts';

export interface DevRecipe {
  /** Shell command run in the sandbox (workspace root as cwd). */
  command: string;
  /** Port the server listens on inside the sandbox. */
  port: number;
  framework: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  script: string;
}

export interface DevServerInfo {
  url: string;
  hostPort: number;
  port: number;
  command: string;
  framework: string;
  sandbox: string;
  startedAt: string;
}

const FRAMEWORK_PORTS: Array<[string, string, number]> = [
  ['next', 'next', 3000],
  ['vite', 'vite', 5173],
  ['astro', 'astro', 4321],
  ['@sveltejs/kit', 'sveltekit', 5173],
  ['nuxt', 'nuxt', 3000],
  ['@remix-run/dev', 'remix', 3000],
];

/** Deterministic dev-server detection from `package.json` + lockfile (F-PRV-1, §17.2 step 1–2, Node subset). */
export function detectDevServer(root: string): DevRecipe | null {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { return null; }
  const scripts = pkg.scripts ?? {};
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!script) return null;
  const body = scripts[script];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = FRAMEWORK_PORTS.find(([dep]) => deps[dep] !== undefined);
  const hinted = /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/.exec(body);
  const port = hinted ? Number(hinted[1]) : fw?.[2] ?? 3000;
  const packageManager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm';
  return { command: `${packageManager} run ${script}`, port, framework: fw?.[1] ?? 'node', packageManager, script };
}

interface Running {
  info: DevServerInfo;
  sandbox: LocalSandbox;
  server: Server;
  abort: AbortController;
  exited: Promise<void>;
  log: string[];
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(url, (res) => { res.resume(); resolve(true); });
    req.setTimeout(2000, () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/**
 * Managed dev servers, one per workspace (F-PRV-1, §17.2 step 3–4). Each runs as a long-lived command in its own
 * sandbox; the Engine forwards a free host loopback port to the in-sandbox port (§17.3 forwarder, plain TCP).
 */
export class DevServers {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<DevServerInfo>>();
  private readonly o: { egress?: EgressProxy; forceProcess?: boolean; onReady?: (root: string, info: DevServerInfo) => void; onExit?: (root: string, info: DevServerInfo, code: number | null) => void };

  constructor(opts: DevServers['o'] = {}) {
    this.o = opts;
  }

  get(root: string): DevServerInfo | null {
    return this.running.get(root)?.info ?? null;
  }

  logTail(root: string): string {
    return (this.running.get(root)?.log ?? []).join('').slice(-4000);
  }

  /** Start (or return the already running) dev server for `root`. Resolves once it answers HTTP on the host port. */
  start(root: string, opts: { timeoutMs?: number; recipe?: DevRecipe } = {}): Promise<DevServerInfo> {
    const existing = this.running.get(root);
    if (existing) return Promise.resolve(existing.info);
    const pending = this.starting.get(root);
    if (pending) return pending;
    const p = this.launch(root, opts).finally(() => this.starting.delete(root));
    this.starting.set(root, p);
    return p;
  }

  private async launch(root: string, opts: { timeoutMs?: number; recipe?: DevRecipe }): Promise<DevServerInfo> {
    const recipe = opts.recipe ?? detectDevServer(root);
    if (!recipe) throw new Error('no dev server found: package.json needs a "dev" or "start" script');
    const sandbox = new LocalSandbox(prefixedId('dev'), root, { forceProcess: this.o.forceProcess, egress: this.o.egress });
    const server = createServer((client: Socket) => {
      const up = sandbox.connectPort(recipe.port);
      client.pipe(up);
      up.pipe(client);
      const kill = () => { client.destroy(); up.destroy(); };
      client.on('error', kill);
      up.on('error', kill);
      client.on('close', kill);
      up.on('close', kill);
    });
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res()); });
    const hostPort = (server.address() as { port: number }).port;
    const info: DevServerInfo = { url: `http://127.0.0.1:${hostPort}/`, hostPort, port: recipe.port, command: recipe.command, framework: recipe.framework, sandbox: sandbox.id, startedAt: new Date().toISOString() };
    const abort = new AbortController();
    const log: string[] = [];
    let exitCode: number | null | undefined;
    const exited = sandbox.exec(recipe.command, {
      timeoutMs: 24 * 3600_000, maxOutputBytes: 16 * 1024 * 1024, signal: abort.signal, exposePorts: [recipe.port],
      env: { PORT: String(recipe.port), HOST: '127.0.0.1', BROWSER: 'none' },
      onOutput: (_s, text) => { log.push(text); if (log.length > 200) log.splice(0, log.length - 200); },
    }).then((r) => { exitCode = r.exitCode; }, () => { exitCode = null; });
    const run: Running = { info, sandbox, server, abort, exited, log };
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
    while (Date.now() < deadline && exitCode === undefined) {
      if (await probe(info.url)) {
        this.running.set(root, run);
        void exited.then(() => {
          if (this.running.get(root) !== run) return;
          this.teardown(root, run);
          this.o.onExit?.(root, info, exitCode ?? null);
        });
        this.o.onReady?.(root, info);
        return info;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const tail = log.join('').slice(-2000);
    this.teardown(root, run);
    throw new Error(`dev server '${recipe.command}' ${exitCode !== undefined ? `exited with code ${exitCode}` : 'did not answer HTTP in time'}${tail ? `\n${tail}` : ''}`);
  }

  private teardown(root: string, run: Running): void {
    if (this.running.get(root) === run) this.running.delete(root);
    run.abort.abort();
    run.server.close();
    void run.exited.then(() => run.sandbox.destroy());
  }

  stop(root: string): boolean {
    const run = this.running.get(root);
    if (!run) return false;
    this.teardown(root, run);
    return true;
  }

  async closeAll(): Promise<void> {
    const all = [...this.running.entries()];
    for (const [root, run] of all) this.teardown(root, run);
    await Promise.all(all.map(([, r]) => r.exited));
  }
}
