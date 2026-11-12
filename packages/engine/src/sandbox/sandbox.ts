import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { chmodSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { cgroupUnavailableReason, DEFAULT_LIMITS, SandboxCgroup, type SandboxLimits } from './cgroup.ts';
import { engineIdentity, removeSandboxRecord, writeSandboxRecord } from './reaper.ts';
import { helixHome } from '../util/log.ts';
import { FORWARDER_SOURCE, SANDBOX_PROXY_PORT, type EgressProxy } from './egress.ts';

const SYSTEM_CA_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];
import { tmpdir } from 'node:os';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { FILE_HELPER_SOURCE, FileOpError, hostFileOp, type FileRequest, type FileStat } from './files.ts';
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
  /** `openStdio` only: in-sandbox TCP ports whose connections are handed to a host handler (browser dev-server proxy, R1.7). */
  inbound?: Array<{ port: number; handler: (client: Socket) => void }>;
  /** `openStdio` only: mount a private /proc (own PID namespace). Refused with `SandboxUnavailableError` where the host cannot. */
  proc?: boolean;
  /** `openStdio` only: false skips the egress forwarder (internal helpers that never use the network). */
  egress?: boolean;
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
  /** Resource limits (R1.8): which are kernel-enforced, the sandbox cgroup, and why cgroups are unavailable if they are. */
  limits?: { memoryBytes: number; pids: number; cpus: number; diskBytes: number; enforced: { memory: boolean; pids: boolean; cpu: boolean; disk: boolean; diskHard: boolean }; cgroup: string | null; reason: string | null };
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
 * user+mount namespace. Args: $1 newroot, $2 workspace, $3 scratch, $4 cwd, $5 command, $6 proc (1|0), $7.. ro paths.
 * Nothing from the host is visible except the listed read-only paths, the workspace (rw) and a private
 * /tmp. The host /proc is never bound: it would expose /proc/<pid>/environ of same-uid processes (including
 * the Engine and its provider keys). With proc=1 (only under --pid) a fresh procfs of the sandbox's own PID
 * namespace is mounted, which lists sandbox processes only; Chrome needs it (R1.7).
 */
const CONTAIN_SCRIPT = `set -e
NR="$1"; WS="$2"; SC="$3"; CWD="$4"; CMD="$5"; PROC="$6"; shift 6
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
if [ "$PROC" = 1 ]; then mkdir -p "$NR/proc"; mount -t proc -o nosuid,nodev,noexec helix-proc "$NR/proc"; fi
mount --bind "$SC" "$NR/tmp"
mkdir -p "$NR$WS"; mount --rbind "$WS" "$NR$WS"
mount -o remount,ro,bind "$NR" 2>/dev/null || true
exec chroot "$NR" /usr/bin/env bash -c 'cd -- "$1" || exit 126; exec bash -c "$2"' helix "$CWD" "$CMD"`;

/**
 * Hard disk quota (R1.8a, §16.4): a long-lived holder user+mount namespace per sandbox mounts a tmpfs of the quota size
 * and an overlay over the workspace path whose upper dir lives on it, so writes past the quota fail with ENOSPC at the
 * byte. The real workspace stays reachable inside the holder at $LV for syncing edits back. Args: $1 tmpfs dir, $2 lower
 * view dir, $3 workspace, $4 size in bytes.
 */
const QUOTA_HOLD_SCRIPT = `set -e
Q="$1"; LV="$2"; WS="$3"; SIZE="$4"
mount -t tmpfs -o size="$SIZE",mode=700 helix-quota "$Q"
mkdir "$Q/u" "$Q/w"
mount --bind "$WS" "$LV"
mount -t overlay helix-ws -o userxattr,lowerdir="$WS",upperdir="$Q/u",workdir="$Q/w" "$WS"
: > "$Q/.ready"
exec sleep infinity`;

/** Idle re-mount: drop the (already synced) upper layer and shrink the tmpfs to the quota left. Exit 3 when busy. */
const QUOTA_REMOUNT_SCRIPT = `Q="$1"; LV="$2"; WS="$3"; SIZE="$4"
umount "$WS" 2>/dev/null || exit 3
rm -rf "$Q/u" "$Q/w"
mount -o remount,size="$SIZE" "$Q"
mkdir "$Q/u" "$Q/w"
mount -t overlay helix-ws -o userxattr,lowerdir="$LV",upperdir="$Q/u",workdir="$Q/w" "$WS"`;

/**
 * Copies the overlay upper layer onto the real workspace (run inside the holder namespace). Whiteouts (0:0 char devices)
 * delete; upper directories drop lower entries the merged view no longer lists (opaque dirs); files and symlinks changed
 * since the last sync (ctime) are copied in place. Args: upper, merged (workspace path), lower view, since (ms).
 */
const QUOTA_SYNC_SOURCE = `'use strict';
const fs = require('fs'); const p = require('path');
const [U, M, L, since] = process.argv.slice(2); const t = Number(since);
const kind = (s) => s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : s.isFile() ? 'f' : 'o';
const lst = (x) => { try { return fs.lstatSync(x); } catch { return null; } };
function walk(rel) {
  let names; try { names = fs.readdirSync(p.join(U, rel)); } catch { return; }
  for (const name of names) {
    const r = p.join(rel, name), u = p.join(U, r), l = p.join(L, r), m = p.join(M, r);
    const st = lst(u); if (!st) continue;
    const ls = lst(l);
    if (st.isCharacterDevice() && st.rdev === 0) { if (ls) fs.rmSync(l, { recursive: true, force: true }); continue; }
    if (ls && kind(ls) !== kind(st)) fs.rmSync(l, { recursive: true, force: true });
    if (st.isDirectory()) {
      if (!ls || !ls.isDirectory()) fs.mkdirSync(l);
      let keep = null; try { keep = new Set(fs.readdirSync(m)); } catch { /* removed meanwhile */ }
      if (keep) for (const e of fs.readdirSync(l)) if (!keep.has(e)) fs.rmSync(p.join(l, e), { recursive: true, force: true });
      fs.chmodSync(l, st.mode & 0o7777);
      walk(r);
    } else if (st.isSymbolicLink()) {
      if (ls && kind(ls) === 'l' && st.ctimeMs < t) continue;
      fs.rmSync(l, { force: true }); fs.symlinkSync(fs.readlinkSync(u), l);
    } else if (st.isFile()) {
      if (ls && kind(ls) === 'f' && st.ctimeMs < t) continue;
      fs.copyFileSync(u, l); fs.chmodSync(l, st.mode & 0o7777);
    }
  }
}
walk('.');`;

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
      const r = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--kill-child=KILL', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', nr, sc, sc, sc, 'test -d /usr/bin && ! test -e /home/.helix-probe', '0', ...DEFAULT_RO_PATHS], { stdio: 'ignore', timeout: 10_000 });
      ok = r.status === 0;
    } finally {
      rmSync(nr, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  }
  mountProbes.set(key, ok);
  return ok;
}

const procProbes = new Map<string, boolean>();

/**
 * True when the contained root can mount a private procfs for its own PID namespace (needed by Chrome, R1.7).
 * Hosts whose /proc has locked overmounts (e.g. nested VMs with /proc/kcore masked) refuse procfs from a user
 * namespace; callers that need /proc then fail closed instead of binding the host /proc.
 */
export function unshareProcAvailable(): boolean {
  const key = process.env.PATH ?? '';
  const cached = procProbes.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  if (mountNsAvailable()) {
    const nr = mkdtempSync(join(tmpdir(), 'helix-probe-root-'));
    const sc = mkdtempSync(join(tmpdir(), 'helix-probe-tmp-'));
    try {
      const check = 'test -r /proc/self/status && test "$(ls /proc | grep -c "^[0-9]")" -lt 8';
      const r = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--kill-child=KILL', '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', nr, sc, sc, sc, check, '1', ...DEFAULT_RO_PATHS], { stdio: 'ignore', timeout: 10_000 });
      ok = r.status === 0;
    } finally {
      rmSync(nr, { recursive: true, force: true });
      rmSync(sc, { recursive: true, force: true });
    }
  }
  procProbes.set(key, ok);
  return ok;
}

/** True when the default full-isolation backend can give a command a private /proc (container with real /proc, or unshare procfs). */
export function sandboxProcAvailable(): boolean {
  if (wslFromEnv()) return false;
  const backend = defaultBackend();
  if (backend === 'local-container') return containerRuntime()?.proc === 'proc';
  if (backend === 'local-unshare') return unshareProcAvailable();
  return false;
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
  private readonly bridgeNode: string = process.execPath;
  private readonly hostBridgeDir: string | null = null;
  private readonly egressOn: boolean = false;
  private readonly egress?: EgressProxy;

  private readonly trace?: SpanRunner;
  /** Per-sandbox cgroup (R1.8): limits, per-command leaves, freeze (suspend) and whole-tree kill. Null without delegation. */
  private readonly cg: SandboxCgroup | null = null;
  private readonly limits: Required<SandboxLimits>;
  private readonly diskWatch: { baseline: number } | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private diskHits = 0;
  /** Hard disk quota (R1.8a): holder namespace with the workspace overlay on a size-limited tmpfs. */
  private readonly quota: { base: string; baseline: number; holder: ChildProcess | null; lastSync: number; syncing: Promise<void>; busy: boolean; timer: NodeJS.Timeout | null } | null = null;
  private readonly hardQuotaReason: string | null = null;
  private suspended = false;
  private readonly idleSuspendMs: number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(id: string, root: string, opts: { lightMode?: boolean; roPaths?: string[]; egress?: EgressProxy; wsl?: WslConfig | null; backend?: SandboxBackend; trace?: SpanRunner; limits?: SandboxLimits; idleSuspendMs?: number } = {}) {
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
    if (!this.wsl) {
      const hostDir = join(this.scratch, '.helix');
      mkdirSync(hostDir, { mode: 0o700 });
      writeFileSync(join(hostDir, 'fwd.cjs'), FORWARDER_SOURCE);
      this.hostBridgeDir = hostDir;
      this.bridgeDir = this.remapsTmp ? '/tmp/.helix' : hostDir;
      if (!nodeVisible) {
        // Packaged Node may live under Downloads or /tmp; never mount its host parent into the sandbox.
        copyFileSync(process.execPath, join(hostDir, 'node'), constants.COPYFILE_FICLONE);
        // Reflink copies may retain a different owner across nested user namespaces; the private bridge directory still limits access.
        chmodSync(join(hostDir, 'node'), 0o555);
        this.bridgeNode = join(this.bridgeDir, 'node');
      }
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
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.idleSuspendMs = opts.idleSuspendMs ?? 0;
    if (!this.wsl) this.cg = SandboxCgroup.create(`${engineIdentity().replace(':', '_')}-${id}`, this.limits);
    if (opts.limits?.diskBytes && !this.wsl) this.diskWatch = { baseline: duBytes([this.root, this.scratch]) };
    if (process.env.HELIX_DISK_QUOTA === 'hard') {
      if (this.provider === 'local-unshare') {
        const base = mkdtempSync(join(tmpdir(), 'helix-quota-'));
        mkdirSync(join(base, 'q'));
        mkdirSync(join(base, 'lv'));
        writeFileSync(join(base, 'sync.cjs'), QUOTA_SYNC_SOURCE);
        this.quota = { base, baseline: duBytes([this.root]), holder: null, lastSync: 0, syncing: Promise.resolve(), busy: false, timer: null };
      } else {
        this.hardQuotaReason = `hard overlay disk quota is implemented for local-unshare only (backend ${this.provider}); the sampled quota applies`;
      }
    }
    writeSandboxRecord({ id, owner: engineIdentity(), createdAt: new Date().toISOString(), cgroup: this.cg?.path ?? null, containerCli: this.container?.cli ?? null, dirs: [this.scratch, this.newRoot, this.ctlDir, this.quota?.base].filter((d): d is string => !!d) });
  }

  /** Lifecycle state (§16.4). */
  get state(): 'ready' | 'busy' | 'suspended' | 'destroyed' {
    return this.destroyed ? 'destroyed' : this.suspended ? 'suspended' : this.processes.size ? 'busy' : 'ready';
  }

  /** Suspend: freeze every process of the sandbox in place (cgroup v2 freezer). Files and process state are kept. */
  async suspend(): Promise<void> {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    if (!this.cg) throw new SandboxUnavailableError(`suspend needs a delegated cgroup v2 subtree: ${cgroupUnavailableReason() ?? 'unavailable'}`);
    await this.cg.freeze();
    this.suspended = true;
  }

  /** Resume a suspended sandbox (also done implicitly by every exec/stdio/pty call). */
  resume(): void {
    if (this.suspended) { this.cg!.thaw(); this.suspended = false; }
    if (this.idleSuspendMs > 0 && !this.destroyed) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.destroyed && !this.suspended && this.cg) void this.suspend().catch(() => {}); }, this.idleSuspendMs);
      this.idleTimer.unref();
    }
  }

  /** Limit hits: OOM kills and refused forks (kernel counters), and disk-quota kills. */
  limitEvents(): { oomKills: number; pidsMax: number; disk: number } {
    return { ...(this.cg?.events() ?? { oomKills: 0, pidsMax: 0 }), disk: this.diskHits };
  }

  /**
   * Snapshot the workspace and sandbox /tmp into a host tar file, produced by `tar` inside the sandbox (the Engine never
   * reads workspace content on the host, §16.3). Secrets cannot be in it: the sandbox only ever holds sentinels (§16.4).
   */
  async snapshot(dest?: string): Promise<{ path: string; bytes: number }> {
    if (this.wsl) throw new SandboxUnavailableError('snapshots are not supported under WSL (partial isolation)');
    const dir = join(helixHome(), 'snapshots');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = dest ?? join(dir, `${this.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${Date.now()}.tar`);
    const tmp = this.remapsTmp ? 'tmp' : this.scratch.slice(1);
    const { process: child } = await this.openStdio(`exec tar --exclude=${shq(`${tmp}/.helix`)} -C / -cf - ${shq(this.root.slice(1))} ${shq(tmp)}`, { egress: false });
    child.stdin.end();
    child.stderr.resume();
    const out = createWriteStream(path, { mode: 0o600 });
    child.stdout.pipe(out);
    const code = await new Promise<number | null>((res) => child.once('close', res));
    await new Promise<void>((res) => (out.writableFinished ? res() : out.once('finish', () => res())));
    if (code !== 0 && code !== 1) throw new Error(`snapshot of ${this.id} failed (tar exit ${code})`);
    return { path, bytes: statSync(path).size };
  }

  /** Restore files from a snapshot (extracted inside the sandbox). */
  async restore(path: string): Promise<void> {
    const { process: child } = await this.openStdio('exec tar -C / -xf -', { egress: false });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on('error', () => { /* tar exited early */ });
    createReadStream(path).pipe(child.stdin);
    const code = await new Promise<number | null>((res) => child.once('close', res));
    if (code !== 0) throw new Error(`restore of ${this.id} failed (tar exit ${code})`);
  }

  /** Join a fresh per-command cgroup leaf before exec (no-op without a cgroup). */
  private launch(cmd: string, args: string[]): { cmd: string; args: string[]; leaf: string | null } {
    if (!this.cg) return { cmd, args, leaf: null };
    const leaf = this.cg.leaf();
    const [c, a] = this.cg.wrap(leaf, cmd, args);
    return { cmd: c, args: a, leaf };
  }

  private releaseLeaf(leaf: string | null): void {
    if (leaf) this.cg?.removeLeaf(leaf);
    if (!this.processes.size && this.diskTimer) { clearInterval(this.diskTimer); this.diskTimer = null; }
  }

  /**
   * Disk quota over the sandbox's writable area (workspace + /tmp) while commands run. A `statfs` free-space delta is
   * sampled every 10 ms (cheap, sees page-cache writes at once); when it exceeds the quota the sandbox is frozen and
   * `du` confirms the usage is the sandbox's own (not other host writers) before killing it. RLIMIT_FSIZE caps single files.
   */
  private watchDisk(): void {
    if (!this.diskWatch || this.diskTimer) return;
    const dirs = [this.root, this.scratch];
    const free = () => {
      const seen = new Set<number>();
      let n = 0;
      for (const d of dirs) {
        try { const dev = statSync(d).dev; if (seen.has(dev)) continue; seen.add(dev); const f = statfsSync(d); n += f.bavail * f.bsize; } catch { /* gone */ }
      }
      return n;
    };
    const quota = this.limits.diskBytes;
    const step = (used: number) => used + Math.max((quota - used) / 2, 1024 * 1024);
    let anchor = { free: free(), used: 0 };
    let threshold = step(0);
    let checking = false;
    let lastDu = Date.now();
    const timer = setInterval(() => {
      if (checking) return;
      if (this.destroyed || !this.processes.size) { clearInterval(timer); if (this.diskTimer === timer) this.diskTimer = null; return; }
      // statfs is filesystem-wide: deferred frees elsewhere can hide writes, so du also runs back-to-back (≥ 50 ms apart).
      const suspect = anchor.used + (anchor.free - free()) > threshold;
      if (!suspect && Date.now() - lastDu < 50) return;
      checking = true;
      void (async () => {
        const frozeHere = suspect && !!this.cg && !this.suspended;
        if (frozeHere) await this.cg!.freeze().catch(() => {});
        const used = (await duBytesAsync(dirs)) - this.diskWatch!.baseline;
        lastDu = Date.now();
        if (used > quota) {
          this.diskHits++;
          this.cg?.kill();
          for (const kill of this.processes.keys()) kill();
        } else {
          // Re-anchor on the measured usage (deferred frees and other host writers skew statfs) and halve the headroom.
          anchor = { free: free(), used };
          threshold = step(used);
        }
        if (frozeHere) this.cg!.thaw();
        checking = false;
      })();
    }, 10);
    timer.unref();
    this.diskTimer = timer;
  }

  /** Shell prefix: per-file size limit (bash `ulimit -f` counts 1 KiB blocks). */
  private limitPrefix(): string {
    // Under the hard quota the tmpfs returns ENOSPC at the byte; RLIMIT_FSIZE would pre-empt it with SIGXFSZ.
    if (this.quota) return '';
    return `ulimit -f ${Math.max(1, Math.floor(this.limits.diskBytes / 1024))} 2>/dev/null; `;
  }

  /** Quota left for the writable layer: the limit minus the workspace growth already synced to the host. */
  private quotaSize(): number {
    const grown = Math.max(0, duBytes([this.root]) - this.quota!.baseline);
    return Math.max(64 * 1024, this.limits.diskBytes - grown);
  }

  /** PID of the live holder namespace (spawned, and waited for until its overlay is mounted, on first use). */
  private holderPid(): number {
    const q = this.quota!;
    if (q.holder && q.holder.exitCode === null && q.holder.signalCode === null) return q.holder.pid!;
    const qdir = join(q.base, 'q');
    const h = spawn('setpriv', ['--pdeathsig', 'KILL', '--', 'unshare', '--user', '--map-root-user', '--mount', '--fork', '--kill-child=KILL', '--', 'bash', '-c', QUOTA_HOLD_SCRIPT, 'helix', qdir, join(q.base, 'lv'), this.root, String(this.quotaSize())], { stdio: 'ignore', detached: true });
    h.unref();
    h.once('error', () => { /* reported by the readiness wait */ });
    const ready = spawnSync('sh', ['-c', 'for i in $(seq 1000); do kill -0 "$1" 2>/dev/null || exit 1; nsenter -t "$1" -U -m -- test -e "$2/.ready" 2>/dev/null && exit 0; sleep 0.005; done; exit 1', 'helix', String(h.pid), qdir], { stdio: 'ignore', timeout: 15_000 });
    if (!h.pid || ready.status !== 0) {
      try { if (h.pid) process.kill(h.pid, 'SIGKILL'); } catch { /* already gone */ }
      throw new SandboxUnavailableError('HELIX_DISK_QUOTA=hard: could not mount the workspace overlay on a size-limited tmpfs (needs overlayfs with userxattr in a user namespace, Linux >= 5.11)');
    }
    q.holder = h;
    q.lastSync = 0;
    return h.pid;
  }

  /** argv for one contained command on `local-unshare`; under the hard quota it enters the holder's user+mount namespace. */
  private containedArgv(cwd: string, command: string, proc: boolean, pidNs = true): [string, string[]] {
    const inner = ['--net', '--mount', ...(pidNs ? ['--pid', '--fork', '--kill-child=KILL'] : []), '--', 'bash', '-c', CONTAIN_SCRIPT, 'helix', this.newRoot!, this.root, this.scratch, cwd, command, proc ? '1' : '0', ...this.roPaths];
    if (!this.quota) return ['unshare', ['--user', '--map-root-user', ...inner]];
    return ['nsenter', ['-t', String(this.holderPid()), '-U', '-m', '--', 'unshare', ...inner]];
  }

  /**
   * Copy the overlay upper layer to the host workspace (R1.8a), so edits reach the host repo. When no process is live the
   * overlay is re-mounted with an empty upper layer on a tmpfs shrunk to the quota left. Serialized; new commands wait.
   */
  private syncQuota(): Promise<void> {
    const q = this.quota;
    if (!q?.holder || q.holder.exitCode !== null || q.holder.signalCode !== null) return Promise.resolve();
    const pid = String(q.holder.pid);
    const run = (cmd: string, args: string[]) => new Promise<number | null>((res) => {
      const c = spawn(cmd, args, { stdio: 'ignore' });
      c.once('close', res);
      c.once('error', () => res(null));
    });
    q.syncing = q.syncing.then(async () => {
      if (this.destroyed) return;
      q.busy = true;
      const started = Date.now() - 2;
      const code = await run('nsenter', ['-t', pid, '-U', '-m', '--', process.execPath, join(q.base, 'sync.cjs'), join(q.base, 'q', 'u'), this.root, join(q.base, 'lv'), String(q.lastSync)]);
      if (code === 0) q.lastSync = started;
      if (code === 0 && !this.processes.size && !this.destroyed) {
        const lv = join(q.base, 'lv');
        if (await run('nsenter', ['-t', pid, '-U', '-m', '--', 'bash', '-c', QUOTA_REMOUNT_SCRIPT, 'helix', join(q.base, 'q'), lv, this.root, String(this.quotaSize())]) === 0) q.lastSync = 0;
      }
      q.busy = false;
    });
    return q.syncing;
  }

  /** While commands run under the hard quota, sync their edits to the host every second (dev servers, PTYs, MCP servers). */
  private watchQuotaSync(): void {
    const q = this.quota;
    if (!q || q.timer) return;
    q.timer = setInterval(() => {
      if (this.destroyed || !this.processes.size) { clearInterval(q.timer!); q.timer = null; return; }
      if (!q.busy) void this.syncQuota();
    }, 1000);
    q.timer.unref();
  }

  /** Resolves once edits made so far are on the host (no-op without the hard quota). */
  private quotaSettled(): Promise<void> {
    return this.quota ? this.quota.syncing : Promise.resolve();
  }

  info(): SandboxInfo {
    const c = this.container;
    return {
      id: this.id, provider: this.provider, root: this.root, network: !!this.wsl, fsIsolation: this.fsIsolation, egressProxy: this.egressOn, isolation: this.isolation,
      ...(c ? { container: { cli: c.cli, runtime: c.runtimeName, gvisor: c.gvisor, proc: c.proc, seccomp: c.seccomp, image: c.image } } : {}),
      ...(this.localOs ? { localOs: { tool: this.localOs.kind, proc: this.localOs.proc } } : {}),
      limits: { ...this.limits, enforced: { memory: !!this.cg?.enforced.memory, pids: !!this.cg?.enforced.pids, cpu: !!this.cg?.enforced.cpu, disk: !!this.diskWatch || !!this.quota, diskHard: !!this.quota }, cgroup: this.cg?.path ?? null, reason: this.cg ? this.hardQuotaReason : cgroupUnavailableReason() ?? this.hardQuotaReason },
    };
  }

  /** `podman|docker run …` argv for one contained command; the env goes through a host-only env file. */
  private containerSpawn(cwd: string, argv: string[], env: Record<string, string>, tty: boolean): { name: string; args: string[] } {
    const c = this.container!;
    const name = `helix-${this.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${++this.seq}-${process.pid}`;
    const envFile = join(this.ctlDir!, `${name}.env`);
    writeFileSync(envFile, Object.entries(env).filter(([, v]) => !/[\r\n]/.test(v)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    const args = runArgs({ rt: c, name, labels: { 'helix.sandbox': this.id, 'helix.owner': engineIdentity() }, rootfs: this.newRoot, roPaths: this.roPaths, workspace: this.root, scratch: this.scratch, cwd, envFile, tty, argv, limits: { inheritCgroup: !!this.cg, memoryBytes: this.limits.memoryBytes, pids: this.limits.pids, cpus: this.limits.cpus } });
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
  private prelude(egress: boolean, expose: number[] = [], inbound: Array<{ sock: string; port: number }> = []): string {
    const d = this.bridgeDir;
    if (!d || (!egress && !expose.length && !inbound.length)) return '';
    const fwd = (mode: string, sock: string, port: number, tag: string) =>
      `${this.bridgeNode} ${d}/fwd.cjs ${mode} ${sock} ${port} ${d}/ready.${tag}.$$ </dev/null >/dev/null 2>&1 & ` +
      `for _helix_i in $(seq 150); do [ -e ${d}/ready.${tag}.$$ ] && break; sleep 0.02; done; rm -f ${d}/ready.${tag}.$$; `;
    let out = `PATH="$PATH:/usr/sbin:/sbin" ip link set lo up 2>/dev/null; `;
    if (egress) out += fwd('tcp', `${d}/egress.sock`, this.proxyPort, 'egress');
    for (const p of expose) out += fwd('unix', `${d}/port-${p}.sock`, p, `p${p}`);
    for (const i of inbound) out += fwd('tcp', i.sock, i.port, `i${i.port}`);
    return `${out}unset _helix_i\n`;
  }

  /** True when commands can get a private /proc on this backend (container with real /proc, bwrap --proc, unshare procfs). */
  procCapable(): boolean {
    if (this.wsl) return false;
    if (this.container) return this.container.proc === 'proc';
    if (this.localOs) return this.localOs.kind === 'seatbelt' || this.localOs.proc;
    return unshareProcAvailable();
  }

  /** Host Unix listeners for `inbound` ports; the in-sandbox side is a TCP→Unix forwarder started by the prelude. */
  private async openInbound(list: NonNullable<ExecOptions['inbound']>): Promise<Array<{ port: number; sock: string; server: Server }>> {
    if (!list.length) return [];
    if (!this.hostBridgeDir || !this.bridgeDir) throw new SandboxUnavailableError('inbound ports need a namespaced sandbox bridge');
    const out: Array<{ port: number; sock: string; server: Server }> = [];
    for (const { port, handler } of list) {
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error(`invalid inbound port ${port}`);
      const name = `in-${port}-${++this.seq}.sock`;
      const server = createServer(handler);
      await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(join(this.hostBridgeDir!, name), () => res()); });
      out.push({ port, sock: `${this.bridgeDir}/${name}`, server });
    }
    return out;
  }

  /**
   * One file-tool operation executed inside the sandbox (§16.3): a short-lived Node helper with no network sees only
   * the sandbox's mounts, so a workspace symlink to a host file cannot be followed. The helper source travels in the
   * environment, not through the (agent-writable) sandbox /tmp. WSL keeps the in-Engine path (partial isolation, R2.15).
   */
  async fileOp<T>(req: FileRequest, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.wsl || !this.bridgeDir) return hostFileOp(req) as T;
    const { process: child, kill } = await this.openStdio(`exec '${this.bridgeNode}' -e "eval(Buffer.from(process.env.HELIX_FILES_SCRIPT, 'base64').toString('utf8'))"`, {
      env: { HELIX_FILES_SCRIPT: Buffer.from(FILE_HELPER_SOURCE).toString('base64') }, signal: opts.signal, egress: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (c: Buffer) => { size += c.length; if (size <= 64 * 1024 * 1024) chunks.push(c); else kill(); });
    child.stderr.resume();
    child.stdin.on('error', () => { /* helper exited early */ });
    child.stdin.end(JSON.stringify(req));
    const timer = setTimeout(kill, opts.timeoutMs ?? 30_000);
    const code = await new Promise<number | null>((res) => child.once('close', res));
    clearTimeout(timer);
    await this.quotaSettled();
    let reply: { ok: boolean; value?: unknown; code?: string; message?: string };
    try {
      reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new FileOpError('EIO', `sandbox file helper failed (exit ${code})`);
    }
    if (!reply.ok) throw new FileOpError(reply.code ?? 'EIO', reply.message ?? 'file operation failed');
    return reply.value as T;
  }

  statFile(abs: string, signal?: AbortSignal): Promise<FileStat> {
    return this.fileOp<FileStat>({ op: 'stat', root: this.root, path: abs }, { signal });
  }

  readText(abs: string, signal?: AbortSignal): Promise<string> {
    return this.fileOp<string>({ op: 'read', root: this.root, path: abs }, { signal });
  }

  async writeText(abs: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.fileOp<boolean>({ op: 'write', root: this.root, path: abs, content }, { signal });
  }

  listDir(abs: string, depth: number, signal?: AbortSignal): Promise<string[]> {
    return this.fileOp<string[]>({ op: 'list', root: this.root, path: abs, depth }, { signal });
  }

  searchText(abs: string, pattern: string, glob?: string, signal?: AbortSignal): Promise<string> {
    return this.fileOp<string>({ op: 'search', root: this.root, path: abs, pattern, glob }, { signal });
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

  /** Binary-safe protocol channel; stdin stays open and teardown kills the entire contained process tree. */
  async openStdio(command: string, opts: Pick<ExecOptions, 'cwd' | 'env' | 'signal' | 'exposePorts' | 'inbound' | 'proc' | 'egress'> = {}): Promise<{ process: ChildProcessWithoutNullStreams; kill(): void }> {
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    this.resume();
    const cwd = this.resolvePath(opts.cwd ?? '.');
    if (opts.proc && !this.procCapable()) throw new SandboxUnavailableError(`${this.provider} cannot mount a private /proc on this host (locked /proc overmounts or masked container /proc); refusing rather than exposing the host /proc`);
    const egress = opts.egress !== false && !!(await this.egressReady);
    opts.signal?.throwIfAborted();
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    const ports = opts.exposePorts?.filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    const inbound = await this.openInbound(opts.inbound ?? []);
    const closeInbound = () => { for (const i of inbound) i.server.close(); };
    await this.quotaSettled();
    command = this.limitPrefix() + this.prelude(egress, ports, inbound) + command;
    const env = this.env(opts.env);
    const ctr = this.container ? this.containerSpawn(cwd, ['bash', '-c', command], env, false) : null;
    const light = this.localOs ? this.localOsArgv(cwd, command, true) : null;
    const [cmd, args] = this.wsl ? [this.wsl.exe, wslExecArgs(this.wsl, cwd, command)]
      : ctr ? [this.container!.cli, ctr.args]
      : light ? [light[0], light.slice(1)]
      : this.containedArgv(cwd, command, !!opts.proc);
    if (ctr) this.live.add(ctr.name);
    const run = this.launch(cmd, args as string[]);
    const child = spawn(run.cmd, run.args, { cwd, env: ctr ? clientEnv() : env, detached: !IS_WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => {
      killTree(child.pid);
      if (ctr) this.stopContainer(ctr.name);
      if (run.leaf) this.cg!.kill(run.leaf);
    };
    let closed!: () => void;
    this.processes.set(kill, new Promise<void>((resolve) => { closed = resolve; }));
    const cleanup = () => {
      closed();
      closeInbound();
      this.processes.delete(kill);
      opts.signal?.removeEventListener('abort', kill);
      if (ctr) this.finishContainer(ctr.name);
      this.releaseLeaf(run.leaf);
      void this.syncQuota();
    };
    child.once('close', cleanup);
    child.once('error', cleanup);
    opts.signal?.addEventListener('abort', kill, { once: true });
    if (opts.signal?.aborted) kill();
    this.watchDisk();
    this.watchQuotaSync();
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return { process: child, kill };
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
    this.resume();
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const egress = !!(await this.egressReady);
    opts.signal?.throwIfAborted();
    if (this.destroyed) throw new Error(`sandbox ${this.id} is destroyed`);
    await this.quotaSettled();
    command = this.limitPrefix() + this.prelude(egress, opts.exposePorts?.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)) + command;
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
      : this.containedArgv(cwd, command, false);
    const started = performance.now();
    return new Promise((resolveExec) => {
      if (ctr) this.live.add(ctr.name);
      const run = this.launch(cmd, args as string[]);
      const child = spawn(run.cmd, run.args, { cwd, env: ctr ? clientEnv() : env, detached: !IS_WINDOWS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (run.leaf) this.cg!.kill(run.leaf);
      };
      let closed!: () => void;
      this.processes.set(kill, new Promise<void>((resolve) => { closed = resolve; }));
      this.watchDisk();
      this.watchQuotaSync();
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
        this.releaseLeaf(run.leaf);
        if (ctr && timedOut) { code = null; signal = signal ?? 'SIGKILL'; }
        const result: ExecResult = {
          exitCode: code, signal, timedOut, truncated, durationMs: Math.round(performance.now() - started),
          stdout: globalRedactor.redact(stdout), stderr: globalRedactor.redact(stderr),
        };
        void this.syncQuota().then(() => resolveExec(result));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        closed();
        this.processes.delete(kill);
        opts.signal?.removeEventListener('abort', onAbort);
        if (ctr) this.finishContainer(ctr.name);
        this.releaseLeaf(run.leaf);
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
    this.resume();
    const cwd = this.resolvePath(opts.cwd ?? '.', 'read');
    const cols = Math.min(Math.max(Math.floor(Number(opts.cols) || 100), 20), 500);
    const rows = Math.min(Math.max(Math.floor(Number(opts.rows) || 30), 5), 200);
    const shell = `${this.limitPrefix()}${this.prelude(this.egressOn)}stty rows ${rows} cols ${cols} 2>/dev/null; export PS1='helix:\\W\\$ '; exec bash --noprofile --norc -i`;
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
      : (([c, a]) => [c, ...a])(this.containedArgv(cwd, shell, false, false));
    const quoted = this.wsl ? '' : argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const env = ctr ? { ...clientEnv(), TERM: 'xterm-256color' } : ptyEnv;
    if (ctr) this.live.add(ctr.name);
    let ptyLeaf: string | null = null;
    // Under WSL the PTY is allocated by `script` inside the distro; the host only relays pipes. BSD `script` (macOS) takes argv.
    const child = this.wsl
      ? spawn(this.wsl.exe, wslExecArgs(this.wsl, cwd, `exec script -qfec '${shell.replace(/'/g, `'\\''`)}' /dev/null`), { cwd, env, detached: !IS_WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : process.platform === 'darwin'
      ? spawn('script', ['-q', '/dev/null', ...argv], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : (() => { const run = this.launch('script', ['-qfec', quoted, '/dev/null']); ptyLeaf = run.leaf; return spawn(run.cmd, run.args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); })();
    const decoder = new StringDecoder('utf8');
    const emit = (chunk: Buffer) => { const s = decoder.write(chunk); if (s) opts.onData(globalRedactor.redact(s)); };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.stdin.on('error', () => { /* shell already gone */ });
    const kill = () => {
      if (ctr) this.stopContainer(ctr.name);
      else killTree(child.pid);
      if (ptyLeaf) this.cg!.kill(ptyLeaf);
    };
    let closed!: () => void;
    this.processes.set(kill, new Promise<void>((resolve) => { closed = resolve; }));
    let exited = false;
    const done = (code: number | null) => { if (!exited) { exited = true; closed(); this.processes.delete(kill); if (ctr) this.finishContainer(ctr.name); this.releaseLeaf(ptyLeaf); void this.syncQuota().then(() => opts.onExit(code)); } };
    this.watchQuotaSync();
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    if (this.quota) {
      if (this.quota.timer) clearInterval(this.quota.timer);
      try { if (this.quota.holder?.pid && this.quota.holder.exitCode === null) process.kill(this.quota.holder.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    if (this.suspended) { this.cg?.thaw(); this.suspended = false; }
    for (const kill of this.processes.keys()) kill();
    for (const name of this.live) this.stopContainer(name);
    this.cg?.destroy();
    if (this.ctlDir) rmSync(this.ctlDir, { recursive: true, force: true });
    void this.egressReady.then((close) => close?.());
    for (const dir of [this.scratch, this.newRoot, this.quota?.base]) {
      if (!dir) continue;
      if (this.container) removeContainerDirectory(this.container.cli, dir);
      else rmSync(dir, { recursive: true, force: true });
    }
    removeSandboxRecord(this.id);
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Bytes used under `paths` (`du -sxb`, no symlink following). */
function duBytes(paths: string[]): number {
  const r = spawnSync('du', ['-sxb', ...paths], { encoding: 'utf8', timeout: 60_000 });
  return (r.stdout ?? '').split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0), 0);
}

function duBytesAsync(paths: string[]): Promise<number> {
  return new Promise((res) => {
    let out = '';
    const c = spawn('du', ['-sxb', ...paths], { stdio: ['ignore', 'pipe', 'ignore'] });
    c.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    c.once('close', () => res(out.split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0), 0)));
    c.once('error', () => res(0));
  });
}
