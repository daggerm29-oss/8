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
  /** True when shell commands see only the toolchain (ro), the workspace and a private /tmp (F-SBX-2). */
  fsIsolation: boolean;
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

/** Host directories exposed read-only inside the contained root (toolchains + system config). */
export const DEFAULT_RO_PATHS = ['/usr', '/etc', '/opt'];
const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const DEV_NODES = ['null', 'zero', 'full', 'random', 'urandom', 'tty'];

/**
 * Builds a fresh root on tmpfs and chroots into it (F-SBX-2, §16.3). Runs as mapped root inside the
 * user+mount namespace. Args: $1 newroot, $2 workspace, $3 scratch, $4 cwd, $5 command, $6.. ro paths.
 * Nothing from the host is visible except the listed read-only paths, the workspace (rw) and a private
 * /tmp. /proc is deliberately not mounted: a bind of the host /proc would expose /proc/<pid>/environ of
 * same-uid processes (including the Engine and its provider keys).
 */
const CONTAIN_SCRIPT = `set -e
NR="$1"; WS="$2"; SC="$3"; CWD="$4"; CMD="$5"; shift 5
mount -t tmpfs -o mode=755 helix-root "$NR"
for p in "$@"; do
  [ -d "$p" ] || continue
  mkdir -p "$NR$p"; mount --rbind "$p" "$NR$p"; mount -o remount,bind,ro "$NR$p" 2>/dev/null || mount -o remount,bind,ro,nosuid,nodev "$NR$p"
done
for l in ${ROOT_LINKS.join(' ')}; do
  if [ -L "$l" ]; then ln -s "$(readlink "$l")" "$NR$l"; elif [ -d "$l" ]; then mkdir -p "$NR$l"; mount --rbind "$l" "$NR$l"; mount -o remount,bind,ro "$NR$l" 2>/dev/null || mount -o remount,bind,ro,nosuid,nodev "$NR$l"; fi
done
mkdir -p "$NR/dev" "$NR/tmp"
for d in ${DEV_NODES.join(' ')}; do [ -e "/dev/$d" ] && touch "$NR/dev/$d" && mount --bind "/dev/$d" "$NR/dev/$d"; done
ln -s /proc/self/fd "$NR/dev/fd"; ln -s /proc/self/fd/0 "$NR/dev/stdin"; ln -s /proc/self/fd/1 "$NR/dev/stdout"; ln -s /proc/self/fd/2 "$NR/dev/stderr"
mount --bind "$SC" "$NR/tmp"
mkdir -p "$NR$WS"; mount --rbind "$WS" "$NR$WS"
mount -o remount,ro,bind "$NR" 2>/dev/null || true
exec chroot "$NR" /usr/bin/env bash -c 'cd -- "$1" || exit 126; exec bash -c "$2"' helix "$CWD" "$CMD"`;

let mountProbe: boolean | undefined;

/** True when the full contained root (user+net+mount+pid namespaces, tmpfs, ro binds, chroot) can be built. */
export function mountNsAvailable(): boolean {
  if (mountProbe === undefined) {
    if (!unshareAvailable()) return (mountProbe = false);
    const nr = mkdtempSync(join(tmpdir(), 'helix-probe-root-'));
    const sc = mkdtempSync(join(tmpdir(), 'helix-probe-tmp-'));
    try {
      const r = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', nr, sc, sc, sc, 'test -d /usr/bin && ! test -e /home/.helix-probe', ...DEFAULT_RO_PATHS], { stdio: 'ignore', timeout: 10_000 });
      mountProbe = r.status === 0;
    } finally {
      rmSync(nr, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  }
  return mountProbe;
}

const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS_SAFE'];

/**
 * Local sandbox v0 (F-SBX-1, §16.2). Commands run in a fresh user + network namespace (`unshare -rn`)
 * so they have no network egress and no real root, with a scrubbed environment (provider keys and any
 * registered secret never cross the boundary, §8.3), a private HOME/TMPDIR, a wall-clock timeout that
 * kills the whole process group, and capped output. Filesystem confinement for Helix's own tools is
 * enforced by `resolvePath`; shell commands additionally run in a contained root (F-SBX-2) when
 * mount namespaces work, so they can only see the read-only toolchain, the workspace and a private /tmp. Falls back to a plain process when
 * namespaces are unavailable and reports `network: true` so policy can account for it.
 */
export class LocalSandbox {
  readonly id: string;
  readonly root: string;
  readonly provider: 'local-unshare' | 'local-process';
  readonly fsIsolation: boolean;
  private readonly scratch: string;
  private readonly newRoot: string | null;
  private readonly roPaths: string[];
  private destroyed = false;

  constructor(id: string, root: string, opts: { forceProcess?: boolean; noMountNs?: boolean; roPaths?: string[] } = {}) {
    this.id = id;
    this.root = realpathSync(resolve(root));
    this.provider = !opts.forceProcess && unshareAvailable() ? 'local-unshare' : 'local-process';
    this.fsIsolation = this.provider === 'local-unshare' && !opts.noMountNs && mountNsAvailable();
    this.scratch = mkdtempSync(join(tmpdir(), 'helix-sbx-'));
    this.newRoot = this.fsIsolation ? mkdtempSync(join(tmpdir(), 'helix-root-')) : null;
    this.roPaths = [...new Set([...DEFAULT_RO_PATHS, ...(opts.roPaths ?? [])])].filter((p) => isAbsolute(p) && !isDeniedHostPath(p));
  }

  info(): SandboxInfo {
    return { id: this.id, provider: this.provider, root: this.root, network: this.provider === 'local-process', fsIsolation: this.fsIsolation };
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
    const tmp = this.fsIsolation ? '/tmp' : this.scratch;
    Object.assign(env, { HOME: tmp, TMPDIR: tmp, TERM: 'dumb', CI: '1', NO_COLOR: '1', HELIX_SANDBOX: this.id });
    for (const [k, v] of Object.entries(extra)) if (!secrets.has(k)) env[k] = v;
    return env;
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.destroyed) return Promise.reject(new Error(`sandbox ${this.id} is destroyed`));
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const max = opts.maxOutputBytes ?? 256 * 1024;
    const [cmd, args] = this.fsIsolation
      ? ['unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', this.newRoot!, this.root, this.scratch, cwd, command, ...this.roPaths]]
      : this.provider === 'local-unshare'
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
    if (this.newRoot) rmSync(this.newRoot, { recursive: true, force: true });
  }
}
