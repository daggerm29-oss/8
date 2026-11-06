import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeniedHostPath, Vault } from '../vault/vault.ts';
import { globalRedactor } from '../util/redact.ts';

export interface ExecOptions {
  /** Working directory relative to the sandbox root. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxInfo {
  id: string;
  provider: string;
  root: string;
  network: boolean;
}

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPathError';
  }
}

let unshareProbe: boolean | undefined;

/** True when unprivileged user + network namespaces work on this host (§16.2 local provider). */
export function unshareAvailable(): boolean {
  if (unshareProbe === undefined) {
    const r = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--', 'true'], { stdio: 'ignore', timeout: 5000 });
    unshareProbe = r.status === 0;
  }
  return unshareProbe;
}

const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS_SAFE'];

/**
 * Local sandbox v0 (F-SBX-1, §16.2). Commands run in a fresh user + network namespace (`unshare -rn`)
 * so they have no network egress and no real root, with a scrubbed environment (provider keys and any
 * registered secret never cross the boundary, §8.3), a private HOME/TMPDIR, a wall-clock timeout that
 * kills the whole process group, and capped output. Filesystem confinement for Helix's own tools is
 * enforced by `resolvePath`; shell commands can still read host paths the user can read — whole
 * toolchain containment (bind-mount root) is F-SBX-2 (M1). Falls back to a plain process when
 * namespaces are unavailable and reports `network: true` so policy can account for it.
 */
export class LocalSandbox {
  readonly id: string;
  readonly root: string;
  readonly provider: 'local-unshare' | 'local-process';
  private readonly scratch: string;
  private destroyed = false;

  constructor(id: string, root: string, opts: { forceProcess?: boolean } = {}) {
    this.id = id;
    this.root = realpathSync(resolve(root));
    this.provider = !opts.forceProcess && unshareAvailable() ? 'local-unshare' : 'local-process';
    this.scratch = mkdtempSync(join(tmpdir(), 'helix-sbx-'));
  }

  info(): SandboxInfo {
    return { id: this.id, provider: this.provider, root: this.root, network: this.provider === 'local-process' };
  }

  /** Resolve a tool-supplied path inside the root; rejects escapes (incl. via symlinks), the host denylist, and `.git` writes. */
  resolvePath(p: string, mode: 'read' | 'write' = 'read'): string {
    if (typeof p !== 'string' || p.length === 0) throw new SandboxPathError('path is required');
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    let probe = abs;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    const real = join(realpathSync(probe), relative(probe, abs));
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new SandboxPathError(`path '${p}' is outside the workspace`);
    if (isDeniedHostPath(real)) throw new SandboxPathError(`path '${p}' is on the host denylist`);
    const rel = relative(this.root, real);
    if (mode === 'write' && (rel === '.git' || rel.startsWith(`.git${sep}`))) throw new SandboxPathError('writing inside .git is not allowed; use git commands');
    return real;
  }

  relative(abs: string): string {
    return relative(this.root, abs) || '.';
  }

  private env(extra: Record<string, string> = {}): Record<string, string> {
    const secrets = new Set(Vault.secretEnvNames());
    const env: Record<string, string> = {};
    for (const k of PASSTHROUGH_ENV) if (process.env[k] && !secrets.has(k)) env[k] = process.env[k]!;
    Object.assign(env, { HOME: this.scratch, TMPDIR: this.scratch, TERM: 'dumb', CI: '1', NO_COLOR: '1', HELIX_SANDBOX: this.id });
    for (const [k, v] of Object.entries(extra)) if (!secrets.has(k)) env[k] = v;
    return env;
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.destroyed) return Promise.reject(new Error(`sandbox ${this.id} is destroyed`));
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const max = opts.maxOutputBytes ?? 256 * 1024;
    const [cmd, args] = this.provider === 'local-unshare'
      ? ['unshare', ['--user', '--map-root-user', '--net', '--', 'bash', '-c', command]]
      : ['bash', ['-c', command]];
    const started = performance.now();
    return new Promise((resolveExec) => {
      const child = spawn(cmd, args, { cwd, env: this.env(opts.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
        if (bytes >= max) {
          truncated = true;
          return;
        }
        const s = chunk.subarray(0, max - bytes).toString('utf8');
        bytes += chunk.length;
        if (chunk.length > s.length) truncated = true;
        if (which === 'out') stdout += s;
        else stderr += s;
      };
      child.stdout.on('data', collect('out'));
      child.stderr.on('data', collect('err'));
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolveExec({
          exitCode: code, signal, timedOut, truncated, durationMs: Math.round(performance.now() - started),
          stdout: globalRedactor.redact(stdout), stderr: globalRedactor.redact(stderr),
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolveExec({ exitCode: null, signal: null, timedOut, truncated, durationMs: 0, stdout: '', stderr: `spawn failed: ${err.message}` });
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    rmSync(this.scratch, { recursive: true, force: true });
  }
}
