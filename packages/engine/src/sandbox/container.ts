import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * `local-container` backend (F-SBX-1, SEC-2, architecture §16.2): rootless OCI container per command with
 * no network, all capabilities dropped, no-new-privileges, the engine's default seccomp profile, a
 * read-only rootfs and only the workspace (rw), a private /tmp and the read-only toolchain mounted.
 * gVisor (`runsc`) is preferred when installed.
 */

export type ContainerCli = 'podman' | 'docker';

export interface ContainerRuntime {
  cli: ContainerCli;
  /** OCI runtime passed with `--runtime`, or null for the engine default. */
  runtime: string | null;
  /** Display name of the runtime actually used (e.g. `runsc`, `crun`, `runc`). */
  runtimeName: string;
  gvisor: boolean;
  /**
   * `proc`: a private /proc for the container's PID namespace. `masked`: /proc is an empty tmpfs because the
   * host forbids mounting procfs from a user namespace (locked /proc overmounts, e.g. nested VMs); this
   * matches `local-unshare`, which never mounts /proc.
   */
  proc: 'proc' | 'masked';
  seccomp: boolean;
  /** Image (docker) or null when podman runs a host-toolchain rootfs directory. */
  image: string | null;
  /**
   * Podman >= 5 `--no-hostname` (skip the generated /etc/hostname bind). Podman 4.x (e.g. Ubuntu 24.04's 4.9.3)
   * rejects the unknown flag with exit 125, so it is passed only when `podman run --help` lists it. Not an
   * isolation control: without it Podman bind-mounts a file containing the container id.
   */
  noHostname?: boolean;
}

const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const CLIENT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CONTAINER_HOST', 'DOCKER_HOST', 'CONTAINERS_CONF', 'CONTAINERS_STORAGE_CONF'];

/** Environment for the container CLI itself: only what it needs to find its storage/daemon. Never provider keys. */
export function clientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CLIENT_ENV) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** Strict PATH lookup: no hidden fallback directories, so a backend missing from PATH is really unavailable (R0.2 fail closed). */
function onPath(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

/** Skeleton rootfs for podman `--rootfs`: empty mount points plus the host's merged-/usr symlinks. */
export function buildRootfs(dir: string, roPaths: string[]): string[] {
  const extraBinds: string[] = [];
  for (const d of ['dev', 'proc', 'sys', 'tmp', 'run', 'etc', 'usr', 'opt', 'var']) mkdirSync(join(dir, d), { recursive: true });
  for (const l of ROOT_LINKS) {
    if (!existsSync(l)) continue;
    const st = lstatSync(l);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(l), join(dir, l));
    else if (st.isDirectory()) extraBinds.push(l);
  }
  for (const p of roPaths) mkdirSync(join(dir, p), { recursive: true });
  return extraBinds;
}

export interface RunSpec {
  rt: ContainerRuntime;
  name: string;
  labels: Record<string, string>;
  /** Host rootfs directory (podman) — ignored for image mode. */
  rootfs: string | null;
  roPaths: string[];
  workspace: string;
  scratch: string;
  cwd: string;
  envFile: string;
  tty: boolean;
  argv: string[];
}

function mountArg(src: string, dst: string, ro: boolean): string {
  if (/[,\n]/.test(src) || /[,\n]/.test(dst)) throw new Error(`path not supported by the container backend: ${src}`);
  return `type=bind,src=${src},dst=${dst}${ro ? ',ro' : ''}`;
}

export function runArgs(s: RunSpec): string[] {
  const { rt } = s;
  const a: string[] = [];
  if (rt.cli === 'podman' && rt.runtime) a.push('--runtime', rt.runtime);
  // crun cannot set up /dev/console for a terminal on a read-only rootfs, so PTY containers on a podman
  // host-toolchain rootfs get an ephemeral overlay root instead (the skeleton holds no host content; every
  // host path is still a read-only bind). See docs/decisions.md IMPL-ADR for R0.1.
  const overlayRoot = s.tty && rt.cli === 'podman' && !rt.image;
  a.push('run', '--rm', '--name', s.name, '--network', 'none', ...(overlayRoot ? [] : ['--read-only']), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init', '-w', s.cwd, '--env-file', s.envFile);
  if (rt.cli === 'podman') a.push('--userns', 'keep-id', '--no-hosts', ...(rt.noHostname ? ['--no-hostname'] : []), '--read-only-tmpfs=false', '--log-driver', 'none');
  else a.push('--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--log-driver', 'none');
  for (const [k, v] of Object.entries(s.labels)) a.push('--label', `${k}=${v}`);
  if (rt.proc === 'masked') a.push('--mount', 'type=tmpfs,destination=/proc');
  a.push('-i');
  if (s.tty) a.push('-t');
  for (const p of s.roPaths) if (existsSync(p)) a.push('--mount', mountArg(p, p, true));
  a.push('--mount', mountArg(s.scratch, '/tmp', false));
  a.push('--mount', mountArg(s.workspace, s.workspace, false));
  if (rt.image) a.push(rt.image);
  else a.push('--rootfs', overlayRoot ? `${s.rootfs!}:O` : s.rootfs!);
  a.push(...s.argv);
  return a;
}

/** One capability-probe candidate and the concrete reason it was accepted or rejected. */
export interface ContainerProbeAttempt {
  cli: ContainerCli;
  runtime: string;
  proc: 'proc' | 'masked';
  ok: boolean;
  status: number | null;
  signal: string | null;
  /** Spawn or setup error (e.g. ENOENT, ETIMEDOUT), if any. */
  error: string | null;
  /** Tail of the container CLI's stderr/stdout. */
  output: string;
  probeFile: boolean;
  /** Cleanup failure; a probe whose temporary tree cannot be removed is rejected. */
  cleanup: string | null;
}

let probed: ContainerRuntime | null | undefined;
let probedKey: string | undefined;
let attempts: ContainerProbeAttempt[] = [];
let skipped: string[] = [];

/** Reset the cached probe (tests that change PATH). */
export function resetContainerProbe(): void {
  probed = undefined;
  attempts = [];
  skipped = [];
}

/** Every candidate tried by the last `containerRuntime()` probe, in order. */
export function containerProbeReport(): { attempts: ContainerProbeAttempt[]; skipped: string[] } {
  return { attempts: attempts.map((a) => ({ ...a })), skipped: [...skipped] };
}

/** Human-readable reason the last probe rejected each candidate (for errors, CI logs and conformance failures). */
export function describeContainerProbe(): string {
  const lines = skipped.map((s) => `- ${s}`);
  for (const a of attempts) {
    const head = `- ${a.cli} runtime=${a.runtime} proc=${a.proc}: ${a.ok ? 'ok' : 'rejected'}`;
    if (a.ok) { lines.push(head); continue; }
    const why = [a.status !== null ? `exit=${a.status}` : null, a.signal ? `signal=${a.signal}` : null, a.error ? `error=${a.error}` : null, a.status === 0 && !a.probeFile ? 'probe file missing' : null, a.cleanup ? `cleanup=${a.cleanup}` : null].filter(Boolean).join(' ');
    lines.push(`${head} (${why})${a.output ? `\n    ${a.output.replace(/\n/g, '\n    ')}` : ''}`);
  }
  return lines.length ? lines.join('\n') : '- no container CLI candidates were probed';
}

const tail = (s: string, max = 1200) => (s.length > max ? `…${s.slice(-max)}` : s).trim();

const probeKey = () => ['PATH', 'HELIX_CONTAINER_CLI', 'HELIX_CONTAINER_RUNTIME', 'HELIX_SANDBOX_IMAGE'].map((k) => process.env[k] ?? '').join('\0');

/**
 * Detect a working rootless container engine: tries gVisor first, then the engine's default runtime, then
 * crun/runc, each with a private /proc and then with a masked /proc. Returns null when none can run.
 * `HELIX_CONTAINER_CLI` (podman|docker), `HELIX_CONTAINER_RUNTIME` and `HELIX_SANDBOX_IMAGE` override.
 */
export function containerRuntime(): ContainerRuntime | null {
  const key = probeKey();
  if (probed !== undefined && probedKey === key) return probed;
  probedKey = key;
  probed = null;
  attempts = [];
  skipped = [];
  const forcedCli = process.env.HELIX_CONTAINER_CLI as ContainerCli | undefined;
  const clis: ContainerCli[] = forcedCli ? [forcedCli] : ['podman', 'docker'];
  for (const cli of clis) {
    if (!onPath(cli)) { skipped.push(`${cli}: not found on PATH`); continue; }
    const runtimes: Array<string | null> = [];
    if (process.env.HELIX_CONTAINER_RUNTIME) runtimes.push(process.env.HELIX_CONTAINER_RUNTIME);
    else {
      if (onPath('runsc')) runtimes.push(cli === 'podman' ? onPath('runsc') : 'runsc');
      runtimes.push(null);
      if (cli === 'podman') for (const r of ['crun', 'runc']) if (onPath(r)) runtimes.push(onPath(r));
    }
    const seccomp = probeSeccomp(cli);
    const image = cli === 'docker' ? process.env.HELIX_SANDBOX_IMAGE || 'docker.io/library/debian:stable-slim' : process.env.HELIX_SANDBOX_IMAGE || null;
    const noHostname = cli === 'podman' && podmanRunSupports('--no-hostname');
    if (cli === 'podman' && !noHostname) skipped.push('podman: `run --help` does not list --no-hostname (Podman < 5); the flag is omitted');
    for (const runtime of runtimes) {
      for (const proc of ['proc', 'masked'] as const) {
        const rt: ContainerRuntime = { cli, runtime, runtimeName: runtime ? runtime.split('/').pop()! : defaultRuntimeName(cli), gvisor: !!runtime && runtime.endsWith('runsc'), proc, seccomp, image, ...(cli === 'podman' ? { noHostname } : {}) };
        if (rt.gvisor && proc === 'masked') continue;
        if (tryRun(rt)) return (probed = rt);
      }
    }
  }
  return probed;
}

function defaultRuntimeName(cli: ContainerCli): string {
  const fmt = cli === 'podman' ? '{{.Host.OCIRuntime.Name}}' : '{{.DefaultRuntime}}';
  const r = spawnSync(cli, ['info', '--format', fmt], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : 'default';
}

/** Whether this podman's `run` accepts an optional flag (listed in `podman run --help`). */
export function podmanRunSupports(flag: string): boolean {
  const r = spawnSync('podman', ['run', '--help'], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return false;
  return new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?![\\w-])`, 'm').test(r.stdout);
}

function probeSeccomp(cli: ContainerCli): boolean {
  const fmt = cli === 'podman' ? '{{.Host.Security.SECCOMPEnabled}}' : '{{.SecurityOptions}}';
  const r = spawnSync(cli, ['info', '--format', fmt], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  return r.status === 0 && /true|seccomp/.test(r.stdout);
}

export function removeContainerDirectory(cli: ContainerCli, dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (cli !== 'podman' || !['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // Rootless Podman can map rootfs ownership to subordinate UIDs that the host user cannot traverse.
    const result = spawnSync(cli, ['unshare', 'rm', '-rf', '--', dir], { stdio: 'ignore', env: clientEnv(), timeout: 15_000 });
    if (result.status !== 0) throw error;
    rmSync(dir, { recursive: true, force: true });
  }
}

function tryRun(rt: ContainerRuntime): boolean {
  const attempt: ContainerProbeAttempt = { cli: rt.cli, runtime: rt.runtime ?? `${rt.runtimeName} (engine default)`, proc: rt.proc, ok: false, status: null, signal: null, error: null, output: '', probeFile: false, cleanup: null };
  attempts.push(attempt);
  const dir = mkdtempSync(join(tmpdir(), 'helix-cprobe-'));
  const rootfs = join(dir, 'root');
  const scratch = join(dir, 'tmp');
  const ws = join(dir, 'ws');
  let supported = false;
  try {
    mkdirSync(rootfs);
    mkdirSync(scratch);
    mkdirSync(ws);
    const roPaths = ['/usr', '/etc', '/opt'];
    const extra = rt.image ? [] : buildRootfs(rootfs, roPaths);
    const envFile = join(dir, 'env');
    writeFileSync(envFile, '');
    const args = runArgs({ rt, name: `helix-probe-${process.pid}-${Date.now().toString(36)}`, labels: { 'helix.probe': '1' }, rootfs, roPaths: [...roPaths, ...extra], workspace: ws, scratch, cwd: ws, envFile, tty: false, argv: ['bash', '-c', 'echo ok > ./probe && test -d /usr/bin'] });
    const r = spawnSync(rt.cli, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: clientEnv(), timeout: 60_000, maxBuffer: 1 << 20 });
    attempt.status = r.status;
    attempt.signal = r.signal ?? null;
    if (r.error) attempt.error = (r.error as NodeJS.ErrnoException).code ?? r.error.message;
    attempt.output = tail([r.stderr, r.stdout].filter((s) => typeof s === 'string' && s.trim()).join('\n'));
    attempt.probeFile = existsSync(join(ws, 'probe'));
    supported = r.status === 0 && attempt.probeFile;
  } catch (error) {
    attempt.error = (error as Error).message;
    supported = false;
  } finally {
    try { removeContainerDirectory(rt.cli, dir); } catch (error) { attempt.cleanup = (error as Error).message; supported = false; }
  }
  attempt.ok = supported;
  return supported;
}

/** Force-remove a container by name (timeout, cancel, destroy). Resolves when the CLI returns. */
export function removeContainer(cli: ContainerCli, name: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cli, ['rm', '-f', '-t', '0', name], { stdio: 'ignore', env: clientEnv() });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}
