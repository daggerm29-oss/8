import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { FORWARDER_SOURCE, SANDBOX_PROXY_PORT, type EgressProxy } from './egress.ts';

const SYSTEM_CA_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];
import { tmpdir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeniedHostPath, Vault } from '../vault/vault.ts';
import { globalRedactor } from '../util/redact.ts';
import type { SpanRunner } from '../obs/tracing.ts';
import { wslEnvList, wslExecArgs, wslFromEnv, type WslConfig } from './wsl.ts';
import { buildRootfs, clientEnv, containerRuntime, describeContainerProbe, removeContainer, removeContainerDirectory, runArgs, type ContainerRuntime } from './container.ts';
import { bwrapArgv, localOsTool, seatbeltArgv, type LocalOsTool } from './localos.ts';

export type SandboxBackend = 'local-container' | 'local-unshare' | 'local-os';
/** `full`: container or namespaced contained root. `light`: `local-os` for a trusted repo (SEC-1). `partial`: WSL (no fs isolation or egress proxy yet, R2.15). */
export type SandboxIsolation = 'full' | 'light' | 'partial';

/** Raised instead of ever running an agent process unisolated (SEC-1, FR-19). Mapped to the `sandbox_unavailable` RPC error. */
export class SandboxUnavailableError extends Error {
  readonly code = 'sandbox_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/** `local-unshare` counts as isolating only when the full contained root works (fs + net + pid), not with unshare alone (SEC-2). */
function unshareIsolates(): boolean {
  return mountNsAvailable();
}

const lightToolName = () => (process.platform === 'darwin' ? 'Seatbelt (sandbox-exec)' : 'bubblewrap (bwrap)');

/**
 * Fail-closed backend resolution (§16.2, SEC-1). Full isolation: `local-container` when a rootless engine works, else
 * `local-unshare` with a contained root. `local-os` only when the caller passes the workspace's explicit trusted light-mode
 * opt-in, and then exactly `local-os` (no switch to another backend). `HELIX_SANDBOX_PROVIDER` may force a full backend; an
 * unknown or unavailable value is an error, never ignored. Throws `SandboxUnavailableError`; there is no unisolated fallback.
 */
export function resolveBackend(opts: { lightMode?: boolean } = {}): SandboxBackend {
  if (opts.lightMode) {
    if (localOsTool()) return 'local-os';
    throw new SandboxUnavailableError(`local-os light mode is selected for this trusted workspace, but ${lightToolName()} is not usable on this host; agent processes are refused`);
  }
  const forced = process.env.HELIX_SANDBOX_PROVIDER;
  if (forced && forced !== 'wsl') {
    if (forced === 'local-container') {
      if (containerRuntime()) return forced;
      throw new SandboxUnavailableError(`HELIX_SANDBOX_PROVIDER=local-container, but no working rootless podman/docker was found; agent processes are refused\n${describeContainerProbe()}`);
    }
    if (forced === 'local-unshare') {
      if (unshareIsolates()) return forced;
      throw new SandboxUnavailableError('HELIX_SANDBOX_PROVIDER=local-unshare, but user+mount namespaces with a contained root do not work on this host; agent processes are refused');
    }
    if (forced === 'local-os') throw new SandboxUnavailableError('HELIX_SANDBOX_PROVIDER=local-os is not accepted: light mode is enabled per workspace by the user (workspace.trust with lightMode), never by environment');
    throw new SandboxUnavailableError(`unknown HELIX_SANDBOX_PROVIDER '${forced}' (expected local-container or local-unshare)`);
  }
  if (containerRuntime()) return 'local-container';
  if (unshareIsolates()) return 'local-unshare';
  throw new SandboxUnavailableError('no isolating sandbox backend is available (needs rootless podman/docker, or unprivileged user+mount namespaces); agent processes are refused');
}

/** Resolution without throwing: the backend agent processes would use, or the reason they are refused. */
export function sandboxStatus(opts: { lightMode?: boolean } = {}): { backend: SandboxBackend | 'wsl' | null; isolation: SandboxIsolation | 'none'; reason: string | null } {
  if (wslFromEnv()) return { backend: 'wsl', isolation: 'partial', reason: null };
  try {
    const backend = resolveBackend(opts);
    return { backend, isolation: backend === 'local-os' ? 'light' : 'full', reason: null };
  } catch (e) {
    if (e instanceof SandboxUnavailableError) return { backend: null, isolation: 'none', reason: e.message };
    throw e;
  }
}

/** Default full-isolation backend, or null when agent processes would be refused. Never `local-os`. */
export function defaultBackend(): SandboxBackend | null {
  try {
    return resolveBackend();
  } catch (e) {
    if (e instanceof SandboxUnavailableError) return null;
    throw e;
  }
}

/** Backends usable on this host, best first. `local-os` is listed when present but is only used for trusted-repo opt-in. */
export function availableBackends(): SandboxBackend[] {
  const out: SandboxBackend[] = [];
  if (containerRuntime()) out.push('local-container');
  if (unshareIsolates()) out.push('local-unshare');
  if (localOsTool()) out.push('local-os');
  return out;
}

const IS_WINDOWS = process.platform === 'win32';
/** Windows needs these to start wsl.exe; they are never forwarded into WSL (not listed in WSLENV). */
const WINDOWS_HOST_ENV = ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'COMSPEC'];

/** Kill a spawned process tree: process group on POSIX, `taskkill /T /F` on Windows. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already exited */
  }
}

export interface ExecOptions {
  /** Working directory relative to the sandbox root. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Live, redacted output chunks (terminal panel). Called only for bytes within `maxOutputBytes`. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** In-sandbox TCP ports reachable from the host via `connectPort` while this command runs. */
  exposePorts?: number[];
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
  /** `full`, `light` (trusted-repo `local-os`, permanently indicated in the workbench), or `partial` (WSL). */
  isolation: SandboxIsolation;
  /** `local-container` only: engine, OCI runtime, gVisor use, /proc mode, seccomp. */
  container?: { cli: string; runtime: string; gvisor: boolean; proc: 'proc' | 'masked'; seccomp: boolean; image: string | null };
  /** `local-os` only: the light-mode tool and whether a private /proc is mounted. */
  localOs?: { tool: LocalOsTool['kind']; proc: boolean };
}

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPathError';
  }
}

const unshareProbes = new Map<string, boolean>();

/** True when unprivileged user + network namespaces work on this host (§16.2 local provider). Cached per PATH. */
export function unshareAvailable(): boolean {
  const key = process.env.PATH ?? '';
  let ok = unshareProbes.get(key);
  if (ok === undefined) {
    const r = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--', 'true'], { stdio: 'ignore', timeout: 5000 });
    unshareProbes.set(key, (ok = r.status === 0));
  }
  return ok;
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

const mountProbes = new Map<string, boolean>();

/** True when the full contained root (user+net+mount+pid namespaces, tmpfs, ro binds, chroot) can be built. Cached per PATH. */
export function mountNsAvailable(): boolean {
  const key = process.env.PATH ?? '';
  const cached = mountProbes.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  if (unshareAvailable()) {
    const nr = mkdtempSync(join(tmpdir(), 'helix-probe-root-'));
    const sc = mkdtempSync(join(tmpdir(), 'helix-probe-tmp-'));
    try {
      const r = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--kill-child=KILL', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', nr, sc, sc, sc, 'test -d /usr/bin && ! test -e /home/.helix-probe', ...DEFAULT_RO_PATHS], { stdio: 'ignore', timeout: 10_000 });
      ok = r.status === 0;
    } finally {
      rmSync(nr, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  }
  mountProbes.set(key, ok);
  return ok;
}

const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS_SAFE'];

/**
 * Local sandbox v0 (F-SBX-1, §16.2). Commands run in a fresh user + network namespace (`unshare -rn`)
 * so they have no network egress and no real root, with a scrubbed environment (provider keys and any
 * registered secret never cross the boundary, §8.3), a private HOME/TMPDIR, a wall-clock timeout that
 * kills the whole process group, and capped output. Filesystem confinement for Helix's own tools is
 * enforced by `resolvePath`; shell commands additionally run in a contained root (F-SBX-2) when
 * mount namespaces work, so they can only see the read-only toolchain, the workspace and a private /tmp. There is no
 * unisolated fallback: when no isolating backend works the constructor throws `SandboxUnavailableError` (SEC-1, R0.2).
 * `local-os` (bubblewrap/Seatbelt) is used only with `lightMode: true`, the caller's proof of the user's trusted-repo opt-in.
 */
export class LocalSandbox {
  readonly id: string;
  readonly root: string;
  readonly provider: SandboxBackend | 'wsl';
  readonly isolation: SandboxIsolation;
  private readonly wsl: WslConfig | null;
  private readonly container: ContainerRuntime | null = null;
  private readonly localOs: LocalOsTool | null = null;
  /** Sandbox-side /tmp is the scratch dir remapped (container, unshare, bwrap); false under Seatbelt (host paths). */
  private readonly remapsTmp: boolean;
  /** In-sandbox TCP port of the egress forwarder. Seatbelt shares the host network namespace, so it gets its own port. */
  private readonly proxyPort: number;
  /** Host-only directory for per-exec env files (never mounted into the sandbox). */
  private readonly ctlDir: string | null = null;
  private readonly live = new Set<string>();
  private readonly processes = new Map<() => void, Promise<void>>();
  private readonly removals = new Map<string, Promise<void>>();
  private seq = 0;
  readonly fsIsolation: boolean;
  private readonly scratch: string;
  private readonly newRoot: string | null;
  private readonly roPaths: string[];
  private destroyed = false;
  /** Egress bridge (F-SBX-3): resolves to the listener's close function once the Unix socket is up. */
  private readonly egressReady: Promise<(() => void) | null>;
  /** Bridge directory (sockets + forwarder) as seen from inside the sandbox, and on the host. Null without a netns. */
  private readonly bridgeDir: string | null = null;
  private readonly hostBridgeDir: string | null = null;
  private readonly egressOn: boolean = false;
  private readonly egress?: EgressProxy;

  private readonly trace?: SpanRunner;

  constructor(id: string, root: string, opts: { lightMode?: boolean; roPaths?: string[]; egress?: EgressProxy; wsl?: WslConfig | null; backend?: SandboxBackend; trace?: SpanRunner } = {}) {
    this.id = id;
    this.trace = opts.trace;
    this.root = realpathSync(resolve(root));
    this.wsl = opts.wsl !== undefined ? opts.wsl : wslFromEnv();
    const backend = this.wsl ? null : opts.backend ?? resolveBackend({ lightMode: opts.lightMode });
    if (backend === 'local-os' && !opts.lightMode) throw new SandboxUnavailableError('local-os requires the workspace to be marked trusted with light mode (workspace.trust)');
    if (backend === 'local-container') {
      this.container = containerRuntime();
      if (!this.container) throw new SandboxUnavailableError('local-container backend unavailable: no working rootless podman/docker');
    } else if (backend === 'local-unshare') {
      if (!unshareIsolates()) throw new SandboxUnavailableError('local-unshare backend unavailable: user+mount namespaces with a contained root do not work on this host');
    } else if (backend === 'local-os') {
      this.localOs = localOsTool();
      if (!this.localOs) throw new SandboxUnavailableError(`local-os backend unavailable: ${lightToolName()} is not usable on this host`);
    }
    this.provider = this.wsl ? 'wsl' : backend!;
    this.isolation = this.wsl ? 'partial' : backend === 'local-os' ? 'light' : 'full';
    this.fsIsolation = !this.wsl;
    this.remapsTmp = !this.wsl && this.localOs?.kind !== 'seatbelt';
    this.proxyPort = this.localOs?.kind === 'seatbelt' ? 20_000 + Math.floor(Math.random() * 30_000) : SANDBOX_PROXY_PORT;
    this.scratch = realpathSync(mkdtempSync(join(tmpdir(), 'helix-sbx-')));
    this.newRoot = this.provider === 'local-unshare' || this.provider === 'local-container' ? mkdtempSync(join(tmpdir(), 'helix-root-')) : null;
    this.roPaths = [...new Set([...DEFAULT_RO_PATHS, ...(opts.roPaths ?? [])])].filter((p) => isAbsolute(p) && !isDeniedHostPath(p));
    if (this.container) {
      this.ctlDir = mkdtempSync(join(tmpdir(), 'helix-ctl-'));
      if (!this.container.image) this.roPaths.push(...buildRootfs(this.newRoot!, this.roPaths));
    }
    const seatbeltSystem = this.localOs?.kind === 'seatbelt' && ['/usr/', '/opt/'].some((p) => process.execPath.startsWith(p));
    const nodeVisible = seatbeltSystem || this.roPaths.some((p) => process.execPath.startsWith(p + '/'));
    if (!this.wsl && nodeVisible) {
      const hostDir = join(this.scratch, '.helix');
      mkdirSync(hostDir, { mode: 0o700 });
      writeFileSync(join(hostDir, 'fwd.cjs'), FORWARDER_SOURCE);
      this.hostBridgeDir = hostDir;
      this.bridgeDir = this.remapsTmp ? '/tmp/.helix' : hostDir;
    }
    if (opts.egress && this.hostBridgeDir) {
      this.egressOn = true;
      this.egress = opts.egress;
      const ca = opts.egress.caFor(id).cert;
      const system = SYSTEM_CA_BUNDLES.find((p) => existsSync(p));
      writeFileSync(join(this.hostBridgeDir, 'helix-ca.pem'), ca);
      writeFileSync(join(this.hostBridgeDir, 'ca-bundle.pem'), `${system ? readFileSync(system, 'utf8') : ''}\n${ca}`);
      this.egressReady = opts.egress.listen(join(this.hostBridgeDir, 'egress.sock'), { sandboxId: id, root: this.root }).catch(() => null);
    } else {
      this.egressReady = Promise.resolve(null);
    }
  }

  info(): SandboxInfo {
    const c = this.container;
    return {
      id: this.id, provider: this.provider, root: this.root, network: !!this.wsl, fsIsolation: this.fsIsolation, egressProxy: this.egressOn, isolation: this.isolation,
      ...(c ? { container: { cli: c.cli, runtime: c.runtimeName, gvisor: c.gvisor, proc: c.proc, seccomp: c.seccomp, image: c.image } } : {}),
      ...(this.localOs ? { localOs: { tool: this.localOs.kind, proc: this.localOs.proc } } : {}),
    };
  }

  /** `podman|docker run …` argv for one contained command; the env goes through a host-only env file. */
  private containerSpawn(cwd: string, argv: string[], env: Record<string, string>, tty: boolean): { name: string; args: string[] } {
    const c = this.container!;
    const name = `helix-${this.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${++this.seq}-${process.pid}`;
    const envFile = join(this.ctlDir!, `${name}.env`);
    writeFileSync(envFile, Object.entries(env).filter(([, v]) => !/[\r\n]/.test(v)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    const args = runArgs({ rt: c, name, labels: { 'helix.sandbox': this.id, 'helix.owner': String(process.pid) }, rootfs: this.newRoot, roPaths: this.roPaths, workspace: this.root, scratch: this.scratch, cwd, envFile, tty, argv });
    return { name, args };
  }

  /** `[cmd, ...args]` running `bash -c <command>` under bubblewrap or Seatbelt (light mode). */
  private localOsArgv(cwd: string, command: string, newSession: boolean): string[] {
    const t = this.localOs!;
    return t.kind === 'bwrap'
      ? bwrapArgv(t, { roPaths: this.roPaths, workspace: this.root, scratch: this.scratch, cwd, proc: t.proc, newSession }, command)
      : seatbeltArgv(t, { roPaths: this.roPaths, workspace: this.root, scratch: this.scratch }, command);
  }

  private stopContainer(name: string): void {
    if (!this.container || !this.live.has(name)) return;
    if (!this.removals.has(name)) this.removals.set(name, removeContainer(this.container.cli, name));
  }

  private finishContainer(name: string): void {
    this.live.delete(name);
    rmSync(join(this.ctlDir!, `${name}.env`), { force: true });
  }

  /**
   * Shell prelude: bring up loopback, start the TCP→Unix forwarder to the Engine egress proxy (F-SBX-3) and
   * Unix→TCP forwarders for exposed in-sandbox ports (dev server, F-PRV-1), waiting until each listens.
   */
  private prelude(egress: boolean, expose: number[] = []): string {
    const d = this.bridgeDir;
    if (!d || (!egress && !expose.length)) return '';
    const fwd = (mode: string, sock: string, port: number, tag: string) =>
      `${process.execPath} ${d}/fwd.cjs ${mode} ${sock} ${port} ${d}/ready.${tag}.$$ </dev/null >/dev/null 2>&1 & ` +
      `for _helix_i in $(seq 150); do [ -e ${d}/ready.${tag}.$$ ] && break; sleep 0.02; done; rm -f ${d}/ready.${tag}.$$; `;
    let out = `PATH="$PATH:/usr/sbin:/sbin" ip link set lo up 2>/dev/null; `;
    if (egress) out += fwd('tcp', `${d}/egress.sock`, this.proxyPort, 'egress');
    for (const p of expose) out += fwd('unix', `${d}/port-${p}.sock`, p, `p${p}`);
    return `${out}unset _helix_i\n`;
  }

  /** Connect to a port inside the sandbox from the host (through the exposed-port bridge when namespaced). */
  connectPort(port: number): Socket {
    return this.hostBridgeDir ? connect(join(this.hostBridgeDir, `port-${port}.sock`)) : connect(port, '127.0.0.1');
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
    const tmp = this.remapsTmp || this.wsl ? '/tmp' : this.scratch;
    Object.assign(env, { HOME: tmp, TMPDIR: tmp, TERM: 'dumb', CI: '1', NO_COLOR: '1', HELIX_SANDBOX: this.id });
    if (this.egressOn) {
      const proxy = `http://127.0.0.1:${this.proxyPort}`;
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) env[k] = proxy;
      env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
      const bundle = `${this.bridgeDir}/ca-bundle.pem`;
      Object.assign(env, { SSL_CERT_FILE: bundle, CURL_CA_BUNDLE: bundle, REQUESTS_CA_BUNDLE: bundle, GIT_SSL_CAINFO: bundle, NODE_EXTRA_CA_CERTS: `${this.bridgeDir}/helix-ca.pem` });
    }
    for (const [k, v] of Object.entries(extra)) if (!secrets.has(k)) env[k] = v;
    if (this.egress) Object.assign(env, this.egress.sentinelEnv(this.root));
    if (this.wsl) {
      delete env.PATH;
      env.WSLENV = wslEnvList(Object.keys(env));
      for (const k of WINDOWS_HOST_ENV) if (process.env[k]) env[k] = process.env[k]!;
    }
    return env;
  }

  /** One `sandbox.exec` span per command (§26.1): backend, redacted command, exit status, and duration. */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.trace) return this.execUntraced(command, opts);
    return this.trace('sandbox.exec', { 'sandbox.id': this.id, 'sandbox.provider': this.provider, command: globalRedactor.redact(command).slice(0, 200) }, async (span) => {
      const r = await this.execUntraced(command, opts);
      span.setAttributes({ exit_code: r.exitCode, signal: r.signal, timed_out: r.timedOut, truncated: r.truncated, duration_ms: r.durationMs, output_bytes: r.stdout.length + r.stderr.length, outcome: r.timedOut ? 'timeout' : r.exitCode === 0 ? 'ok' : 'error' });
      return r;
    });
  }

  private async execUntraced(command: string, opts: ExecOptions): Promise<ExecResult> {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const egress = !!(await this.egressReady);
    opts.signal?.throwIfAborted();
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    command = this.prelude(egress, opts.exposePorts?.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)) + command;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const max = opts.maxOutputBytes ?? 256 * 1024;
    const env = this.env(opts.env);
    const ctr = this.container ? this.containerSpawn(cwd, ['bash', '-c', command], env, false) : null;
    const lightArgv = this.localOs ? this.localOsArgv(cwd, command, true) : null;
    const [cmd, args] = this.wsl
      ? [this.wsl.exe, wslExecArgs(this.wsl, cwd, command)]
      : ctr
      ? [this.container!.cli, ctr.args]
      : lightArgv
      ? [lightArgv[0], lightArgv.slice(1)]
      : ['unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--kill-child=KILL', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', this.newRoot!, this.root, this.scratch, cwd, command, ...this.roPaths]];
    const started = performance.now();
    return new Promise((resolveExec) => {
      if (ctr) this.live.add(ctr.name);
      const child = spawn(cmd, args, { cwd, env: ctr ? clientEnv() : env, detached: !IS_WINDOWS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (ctr) this.stopContainer(ctr.name);
        else killTree(child.pid);
      };
      let closed!: () => void;
      this.processes.set(kill, new Promise<void>((resolve) => { closed = resolve; }));
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        closed();
        this.processes.delete(kill);
        opts.signal?.removeEventListener('abort', onAbort);
        if (ctr) this.finishContainer(ctr.name);
        if (ctr && timedOut) { code = null; signal = signal ?? 'SIGKILL'; }
        resolveExec({
          exitCode: code, signal, timedOut, truncated, durationMs: Math.round(performance.now() - started),
          stdout: globalRedactor.redact(stdout), stderr: globalRedactor.redact(stderr),
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        closed();
        this.processes.delete(kill);
        opts.signal?.removeEventListener('abort', onAbort);
        if (ctr) this.finishContainer(ctr.name);
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
    const shell = `${this.prelude(this.egressOn)}stty rows ${rows} cols ${cols} 2>/dev/null; export PS1='helix:\\W\\$ '; exec bash --noprofile --norc -i`;
    // No --pid here: as PID-namespace init the shell never owns the PTY's foreground group, so Ctrl-C is lost.
    // /proc stays unmounted, so host processes remain invisible.
    const ptyEnv = this.env();
    delete ptyEnv.NO_COLOR;
    delete ptyEnv.CI;
    ptyEnv.TERM = 'xterm-256color';
    const ctr = this.container ? this.containerSpawn(cwd, ['bash', '-c', shell], ptyEnv, true) : null;
    const argv = ctr
      ? [this.container!.cli, ...ctr.args]
      : this.localOs
      ? this.localOsArgv(cwd, shell, false)
      : ['unshare', '--user', '--map-root-user', '--net', '--mount', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', this.newRoot!, this.root, this.scratch, cwd, shell, ...this.roPaths];
    const quoted = this.wsl ? '' : argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const env = ctr ? { ...clientEnv(), TERM: 'xterm-256color' } : ptyEnv;
    if (ctr) this.live.add(ctr.name);
    // Under WSL the PTY is allocated by `script` inside the distro; the host only relays pipes. BSD `script` (macOS) takes argv.
    const child = this.wsl
      ? spawn(this.wsl.exe, wslExecArgs(this.wsl, cwd, `exec script -qfec '${shell.replace(/'/g, `'\\''`)}' /dev/null`), { cwd, env, detached: !IS_WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : process.platform === 'darwin'
      ? spawn('script', ['-q', '/dev/null', ...argv], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('script', ['-qfec', quoted, '/dev/null'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    const emit = (chunk: Buffer) => { const s = decoder.write(chunk); if (s) opts.onData(globalRedactor.redact(s)); };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.stdin.on('error', () => { /* shell already gone */ });
    const kill = () => {
      if (ctr) this.stopContainer(ctr.name);
      else killTree(child.pid);
    };
    let closed!: () => void;
    this.processes.set(kill, new Promise<void>((resolve) => { closed = resolve; }));
    let exited = false;
    const done = (code: number | null) => { if (!exited) { exited = true; closed(); this.processes.delete(kill); if (ctr) this.finishContainer(ctr.name); opts.onExit(code); } };
    child.on('close', (code) => done(code));
    child.on('error', (err) => { opts.onData(`spawn failed: ${err.message}\r\n`); done(null); });
    return {
      pid: child.pid,
      write: (data) => { if (!exited && typeof data === 'string') child.stdin.write(data); },
      kill,
    };
  }

  async stopProcesses(): Promise<void> {
    const active = [...this.processes];
    for (const [kill] of active) kill();
    await Promise.all([...active.map(([, closed]) => closed), ...this.removals.values()]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const kill of this.processes.keys()) kill();
    for (const name of this.live) this.stopContainer(name);
    if (this.ctlDir) rmSync(this.ctlDir, { recursive: true, force: true });
    void this.egressReady.then((close) => close?.());
    for (const dir of [this.scratch, this.newRoot]) {
      if (!dir) continue;
      if (this.container) removeContainerDirectory(this.container.cli, dir);
      else rmSync(dir, { recursive: true, force: true });
    }
  }
}
