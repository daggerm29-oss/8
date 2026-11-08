import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { FORWARDER_SOURCE, SANDBOX_PROXY_PORT, type EgressProxy } from './egress.ts';
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
  /** Live, redacted output chunks (terminal panel). Called only for bytes within `maxOutputBytes`. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
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
  /** True when HTTP(S) egress goes through the Engine allowlisting proxy (F-SBX-3). */
  egressProxy?: boolean;
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
  /** Egress bridge (F-SBX-3): resolves to the listener's close function once the Unix socket is up. */
  private readonly egressReady: Promise<(() => void) | null>;
  /** Directory holding the egress socket + forwarder, as seen from inside the sandbox. */
  private readonly egressDir: string | null = null;

  constructor(id: string, root: string, opts: { forceProcess?: boolean; noMountNs?: boolean; roPaths?: string[]; egress?: EgressProxy } = {}) {
    this.id = id;
    this.root = realpathSync(resolve(root));
    this.provider = !opts.forceProcess && unshareAvailable() ? 'local-unshare' : 'local-process';
    this.fsIsolation = this.provider === 'local-unshare' && !opts.noMountNs && mountNsAvailable();
    this.scratch = mkdtempSync(join(tmpdir(), 'helix-sbx-'));
    this.newRoot = this.fsIsolation ? mkdtempSync(join(tmpdir(), 'helix-root-')) : null;
    this.roPaths = [...new Set([...DEFAULT_RO_PATHS, ...(opts.roPaths ?? [])])].filter((p) => isAbsolute(p) && !isDeniedHostPath(p));
    const nodeVisible = !this.fsIsolation || this.roPaths.some((p) => process.execPath.startsWith(p + '/'));
    if (opts.egress && this.provider === 'local-unshare' && nodeVisible) {
      const hostDir = join(this.scratch, '.helix');
      mkdirSync(hostDir, { mode: 0o700 });
      writeFileSync(join(hostDir, 'fwd.cjs'), FORWARDER_SOURCE);
      this.egressDir = this.fsIsolation ? '/tmp/.helix' : hostDir;
      this.egressReady = opts.egress.listen(join(hostDir, 'egress.sock'), { sandboxId: id, root: this.root }).catch(() => null);
    } else {
      this.egressReady = Promise.resolve(null);
    }
  }

  info(): SandboxInfo {
    return { id: this.id, provider: this.provider, root: this.root, network: this.provider === 'local-process', fsIsolation: this.fsIsolation, egressProxy: this.egressDir !== null };
  }

  /** Shell prelude that brings up loopback and starts the TCP→Unix forwarder to the Engine egress proxy. */
  private egressPrelude(): string {
    if (!this.egressDir) return '';
    const d = this.egressDir;
    return `PATH="$PATH:/usr/sbin:/sbin" ip link set lo up 2>/dev/null; ${process.execPath} ${d}/fwd.cjs ${d}/egress.sock ${SANDBOX_PROXY_PORT} ${d}/ready.$$ </dev/null >/dev/null 2>&1 & ` +
      `for _helix_i in $(seq 150); do [ -e ${d}/ready.$$ ] && break; sleep 0.02; done; rm -f ${d}/ready.$$; unset _helix_i\n`;
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
    if (this.egressDir) {
      const proxy = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) env[k] = proxy;
      env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
    }
    for (const [k, v] of Object.entries(extra)) if (!secrets.has(k)) env[k] = v;
    return env;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    if (await this.egressReady) command = this.egressPrelude() + command;
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
        const room = max - bytes;
        const s = chunk.subarray(0, room).toString('utf8');
        if (chunk.length > room) truncated = true;
        bytes += chunk.length;
        if (which === 'out') stdout += s;
        else stderr += s;
        if (opts.onOutput && s) opts.onOutput(which === 'out' ? 'stdout' : 'stderr', globalRedactor.redact(s));
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

  /**
   * Interactive shell on a real PTY (F-TRM-1). util-linux `script` allocates the PTY on the host and runs the
   * same contained `bash -i` as `exec` (same namespaces, scrubbed env), so no native module is needed.
   * Limitation: size is fixed at open (no live resize through `script`).
   */
  pty(opts: { cols?: number; rows?: number; cwd?: string; onData: (data: string) => void; onExit: (exitCode: number | null) => void }): { pid: number | undefined; write(data: string): void; kill(): void } {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const cols = Math.min(Math.max(Math.floor(Number(opts.cols) || 100), 20), 500);
    const rows = Math.min(Math.max(Math.floor(Number(opts.rows) || 30), 5), 200);
    const shell = `${this.egressPrelude()}stty rows ${rows} cols ${cols} 2>/dev/null; export PS1='helix:\\W\\$ '; exec bash --noprofile --norc -i`;
    // No --pid here: as PID-namespace init the shell never owns the PTY's foreground group, so Ctrl-C is lost.
    // /proc stays unmounted, so host processes remain invisible.
    const argv = this.fsIsolation
      ? ['unshare', '--user', '--map-root-user', '--net', '--mount', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', this.newRoot!, this.root, this.scratch, cwd, shell, ...this.roPaths]
      : this.provider === 'local-unshare'
        ? ['unshare', '--user', '--map-root-user', '--net', '--', 'bash', '-c', shell]
        : ['bash', '-c', shell];
    const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const env = this.env();
    delete env.NO_COLOR;
    delete env.CI;
    env.TERM = 'xterm-256color';
    const child = spawn('script', ['-qfec', quoted, '/dev/null'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    const emit = (chunk: Buffer) => { const s = decoder.write(chunk); if (s) opts.onData(globalRedactor.redact(s)); };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.stdin.on('error', () => { /* shell already gone */ });
    let exited = false;
    const done = (code: number | null) => { if (!exited) { exited = true; opts.onExit(code); } };
    child.on('close', (code) => done(code));
    child.on('error', (err) => { opts.onData(`spawn failed: ${err.message}\r\n`); done(null); });
    return {
      pid: child.pid,
      write: (data) => { if (!exited && typeof data === 'string') child.stdin.write(data); },
      kill: () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } },
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.egressReady.then((close) => close?.());
    rmSync(this.scratch, { recursive: true, force: true });
    if (this.newRoot) rmSync(this.newRoot, { recursive: true, force: true });
  }
}
