import { spawn, spawnSync } from 'node:child_process';
import { connect as netConnect, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeniedHostPath, Vault } from '../vault/vault.ts';
import { globalRedactor } from '../util/redact.ts';
import { EgressProxy, FORWARDER_SOURCE, egressPrelude, proxyEnv, type EgressHooks } from './egress.ts';

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
  /** F-SBX-3: `proxy` = allowlisted HTTP(S) via the Engine egress proxy only; `none` = fully offline; `open` = unrestricted host network. */
  egress: 'proxy' | 'none' | 'open';
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

export interface ServiceHandle {
  pid: number | undefined;
  port: number;
  readonly exited: boolean;
  /** Raw stream to the service port (through the in-sandbox bridge when namespaced). */
  connect(): Socket;
  /** True once something accepts TCP connections on the port inside the sandbox. */
  probe(): Promise<boolean>;
  stop(): void;
}

/** In-sandbox inbound bridge: `<sock>` → 127.0.0.1:<port> (falls back to [::1]); `<sock>.probe` answers 1/0. */
const BRIDGE_SOURCE = `const net=require('net');const fs=require('fs');const port=Number(process.argv[2]);const sock=process.argv[3];
function dial(cb){const a=net.connect(port,'127.0.0.1');a.once('connect',()=>cb(null,a));a.once('error',()=>{const b=net.connect(port,'::1');b.once('connect',()=>cb(null,b));b.once('error',e=>cb(e));});}
for(const p of [sock,sock+'.probe'])try{fs.unlinkSync(p)}catch{}
net.createServer(c=>{c.pause();dial((e,u)=>{if(e){c.destroy();return}c.pipe(u);u.pipe(c);c.resume();c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.on('close',()=>u.destroy());u.on('close',()=>c.destroy());});}).listen(sock);
net.createServer(c=>{dial((e,u)=>{if(u)u.destroy();c.end(e?'0':'1')});c.on('error',()=>{});}).listen(sock+'.probe');`;

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
  private readonly proxy: EgressProxy | null;
  private destroyed = false;

  constructor(id: string, root: string, opts: { forceProcess?: boolean; noMountNs?: boolean; roPaths?: string[]; egress?: EgressHooks } = {}) {
    this.id = id;
    this.root = realpathSync(resolve(root));
    this.provider = !opts.forceProcess && unshareAvailable() ? 'local-unshare' : 'local-process';
    this.fsIsolation = this.provider === 'local-unshare' && !opts.noMountNs && mountNsAvailable();
    this.scratch = mkdtempSync(join(tmpdir(), 'helix-sbx-'));
    this.newRoot = this.fsIsolation ? mkdtempSync(join(tmpdir(), 'helix-root-')) : null;
    this.roPaths = [...new Set([...DEFAULT_RO_PATHS, ...(opts.roPaths ?? [])])].filter((p) => isAbsolute(p) && !isDeniedHostPath(p));
    this.proxy = null;
    if (opts.egress && this.provider === 'local-unshare') {
      writeFileSync(join(this.scratch, '.helix-egress-fwd.cjs'), FORWARDER_SOURCE);
      this.proxy = new EgressProxy(join(this.scratch, '.helix-egress.sock'), opts.egress);
      this.proxy.ready.catch(() => { /* surfaced by exec */ });
    }
  }

  /** Path of the sandbox's private /tmp as seen from inside the sandbox. */
  private get innerTmp(): string {
    return this.fsIsolation ? '/tmp' : this.scratch;
  }

  /** Command prefixed with the egress forwarder prelude when this sandbox has a proxy. */
  private wrap(command: string): string {
    return this.proxy ? egressPrelude(this.innerTmp) + command : command;
  }

  info(): SandboxInfo {
    const egress = this.provider === 'local-process' ? 'open' : this.proxy ? 'proxy' : 'none';
    return { id: this.id, provider: this.provider, root: this.root, network: this.provider === 'local-process', fsIsolation: this.fsIsolation, egress };
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
    const tmp = this.innerTmp;
    Object.assign(env, { HOME: tmp, TMPDIR: tmp, TERM: 'dumb', CI: '1', NO_COLOR: '1', HELIX_SANDBOX: this.id });
    if (this.proxy) Object.assign(env, proxyEnv());
    for (const [k, v] of Object.entries(extra)) if (!secrets.has(k)) env[k] = v;
    return env;
  }

  async exec(rawCommand: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    if (this.proxy) await this.proxy.ready;
    const command = this.wrap(rawCommand);
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const max = opts.maxOutputBytes ?? 256 * 1024;
    const [cmd, args] = this.argv(command, cwd);
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

  /** Contained argv for a non-interactive command (user+net+mount+pid namespaces when available). */
  private argv(command: string, cwd: string): [string, string[]] {
    return this.fsIsolation
      ? ['unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', this.newRoot!, this.root, this.scratch, cwd, command, ...this.roPaths]]
      : this.provider === 'local-unshare'
        ? ['unshare', ['--user', '--map-root-user', '--net', '--', 'bash', '-c', command]]
        : ['bash', ['-c', command]];
  }

  /**
   * Long-running managed process (dev servers, F-PRV-1). Same containment as `exec` but no timeout. When the
   * sandbox has its own network namespace, an in-sandbox bridge exposes `127.0.0.1:<port>` (or `[::1]`) on a
   * Unix socket in the scratch dir so the Engine can forward to it; `probe()` reports whether anything is
   * listening on the port yet (TCP only — the preview opens before compilation finishes, §17.2 step 4).
   */
  service(command: string, opts: { port: number; cwd?: string; env?: Record<string, string>; onOutput?: (stream: 'stdout' | 'stderr', text: string) => void; onExit?: (code: number | null, signal: string | null) => void }): ServiceHandle {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    const port = Math.floor(Number(opts.port));
    if (!(port > 0 && port < 65536)) throw new Error(`invalid port ${opts.port}`);
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const bridged = this.provider === 'local-unshare';
    const hostSock = join(this.scratch, `.helix-port-${port}.sock`);
    let full = command;
    if (bridged) {
      writeFileSync(join(this.scratch, '.helix-bridge.cjs'), BRIDGE_SOURCE);
      const inner = this.innerTmp;
      full = `ip link set lo up 2>/dev/null; NODE_USE_ENV_PROXY= node ${inner}/.helix-bridge.cjs ${port} ${inner}/.helix-port-${port}.sock </dev/null >/dev/null 2>&1 & disown
${command}`;
    }
    const [cmd, args] = this.argv(this.wrap(full), cwd);
    const child = spawn(cmd, args, { cwd, env: this.env(opts.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => { const t = decoders[stream].write(chunk); if (t && opts.onOutput) opts.onOutput(stream, globalRedactor.redact(t)); });
    }
    let exited = false;
    child.on('close', (code, signal) => { exited = true; opts.onExit?.(code, signal); });
    child.on('error', (err) => { opts.onOutput?.('stderr', `spawn failed: ${err.message}\n`); });
    const connect = (): Socket => (bridged ? netConnect(hostSock) : netConnect({ host: '127.0.0.1', port }));
    return {
      pid: child.pid,
      port,
      get exited() { return exited; },
      connect,
      probe: () => new Promise<boolean>((resolve) => {
        if (exited) return resolve(false);
        const s = bridged ? netConnect(`${hostSock}.probe`) : netConnect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => { s.destroy(); resolve(ok); };
        s.setTimeout(2000, () => done(false));
        s.once('error', () => done(false));
        if (bridged) s.once('data', (d) => done(d.toString().startsWith('1')));
        else s.once('connect', () => done(true));
      }),
      stop: () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } },
    };
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
    const shell = this.wrap(`stty rows ${rows} cols ${cols} 2>/dev/null; export PS1='helix:\\W\\$ '; exec bash --noprofile --norc -i`);
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
    void this.proxy?.close();
    rmSync(this.scratch, { recursive: true, force: true });
    if (this.newRoot) rmSync(this.newRoot, { recursive: true, force: true });
  }
}
