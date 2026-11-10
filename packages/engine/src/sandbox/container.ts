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
  if (rt.cli === 'podman') a.push('--userns', 'keep-id', '--no-hosts', '--no-hostname', '--read-only-tmpfs=false', '--log-driver', 'none');
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

let probed: ContainerRuntime | null | undefined;
let probedKey: string | undefined;

/** Reset the cached probe (tests that change PATH). */
export function resetContainerProbe(): void {
  probed = undefined;
}

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
  const forcedCli = process.env.HELIX_CONTAINER_CLI as ContainerCli | undefined;
  const clis: ContainerCli[] = forcedCli ? [forcedCli] : ['podman', 'docker'];
  for (const cli of clis) {
    if (!onPath(cli)) continue;
    const runtimes: Array<string | null> = [];
    if (process.env.HELIX_CONTAINER_RUNTIME) runtimes.push(process.env.HELIX_CONTAINER_RUNTIME);
    else {
      if (onPath('runsc')) runtimes.push(cli === 'podman' ? onPath('runsc') : 'runsc');
      runtimes.push(null);
      if (cli === 'podman') for (const r of ['crun', 'runc']) if (onPath(r)) runtimes.push(onPath(r));
    }
    const seccomp = probeSeccomp(cli);
    const image = cli === 'docker' ? process.env.HELIX_SANDBOX_IMAGE || 'docker.io/library/debian:stable-slim' : process.env.HELIX_SANDBOX_IMAGE || null;
    for (const runtime of runtimes) {
      for (const proc of ['proc', 'masked'] as const) {
        const rt: ContainerRuntime = { cli, runtime, runtimeName: runtime ? runtime.split('/').pop()! : defaultRuntimeName(cli), gvisor: !!runtime && runtime.endsWith('runsc'), proc, seccomp, image };
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

function probeSeccomp(cli: ContainerCli): boolean {
  const fmt = cli === 'podman' ? '{{.Host.Security.SECCOMPEnabled}}' : '{{.SecurityOptions}}';
  const r = spawnSync(cli, ['info', '--format', fmt], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  return r.status === 0 && /true|seccomp/.test(r.stdout);
}

function tryRun(rt: ContainerRuntime): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'helix-cprobe-'));
  const rootfs = join(dir, 'root');
  const scratch = join(dir, 'tmp');
  const ws = join(dir, 'ws');
  try {
    mkdirSync(rootfs);
    mkdirSync(scratch);
    mkdirSync(ws);
    const roPaths = ['/usr', '/etc', '/opt'];
    const extra = rt.image ? [] : buildRootfs(rootfs, roPaths);
    const envFile = join(dir, 'env');
    writeFileSync(envFile, '');
    const args = runArgs({ rt, name: `helix-probe-${process.pid}-${Date.now().toString(36)}`, labels: { 'helix.probe': '1' }, rootfs, roPaths: [...roPaths, ...extra], workspace: ws, scratch, cwd: ws, envFile, tty: false, argv: ['bash', '-c', 'echo ok > ./probe && test -d /usr/bin'] });
    const r = spawnSync(rt.cli, args, { stdio: ['ignore', 'ignore', 'ignore'], env: clientEnv(), timeout: 60_000 });
    return r.status === 0 && existsSync(join(ws, 'probe'));
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Force-remove a container by name (timeout, cancel, destroy). Resolves when the CLI returns. */
export function removeContainer(cli: ContainerCli, name: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cli, ['rm', '-f', '-t', '0', name], { stdio: 'ignore', env: clientEnv() });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}
