import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * cgroup v2 resource limits for local sandboxes (F-SBX-5, ISSUE-005, §16.4). The Engine needs a delegated subtree:
 * its own cgroup must be writable by its uid, as under systemd `user@<uid>.service` (Delegate=yes) or after
 * `scripts/cgroup-delegate.sh`. On first use the Engine moves itself into a `helix-engine` leaf, so the delegated
 * base can enable controllers, and each sandbox gets `sbx-<owner>-<id>` with per-command leaves `c<n>`.
 * Threaded hosts (root cgroup in threaded mode, e.g. the v0 VM) only offer cpu and pids; memory.max then stays
 * unenforced and `enforced.memory` reports it.
 */
export interface SandboxLimits {
  memoryBytes?: number;
  pids?: number;
  cpus?: number;
  diskBytes?: number;
}

export const DEFAULT_LIMITS: Required<SandboxLimits> = { memoryBytes: 4 * 1024 ** 3, pids: 2048, cpus: 2, diskBytes: 20 * 1024 ** 3 };

const CG_ROOT = '/sys/fs/cgroup';
const ENGINE_LEAF = 'helix-engine';

interface Delegation { base: string; threaded: boolean; controllers: Set<string> }

let delegation: Delegation | null | undefined;
let delegationError: string | null = null;

const read = (p: string) => readFileSync(p, 'utf8').trim();
const tryWrite = (p: string, v: string) => { try { writeFileSync(p, v); return true; } catch { return false; } };

/** Why `cgroupDelegation()` returned null (for `info().limits.reason`). */
export function cgroupUnavailableReason(): string | null {
  cgroupDelegation();
  return delegationError;
}

/** The delegated cgroup v2 base this Engine may manage, or null (non-Linux, cgroup v1, or not delegated). */
export function cgroupDelegation(): Delegation | null {
  if (delegation !== undefined) return delegation;
  delegation = null;
  if (process.platform !== 'linux') { delegationError = 'cgroups are Linux-only'; return null; }
  try {
    if (!existsSync(join(CG_ROOT, 'cgroup.controllers'))) { delegationError = 'cgroup v2 is not mounted'; return null; }
    const line = read('/proc/self/cgroup').split('\n').find((l) => l.startsWith('0::'));
    if (!line) { delegationError = 'no cgroup v2 membership'; return null; }
    const own = join(CG_ROOT, line.slice(3));
    const base = basename(own) === ENGINE_LEAF ? dirname(own) : own;
    if (base === CG_ROOT) { delegationError = 'the Engine runs in the root cgroup (no delegated subtree; run scripts/cgroup-delegate.sh or use a systemd user slice)'; return null; }
    const threaded = read(join(base, 'cgroup.type')) === 'threaded';
    const moveFile = threaded ? 'cgroup.threads' : 'cgroup.procs';
    accessSync(base, constants.W_OK);
    accessSync(join(base, moveFile), constants.W_OK);
    accessSync(join(base, 'cgroup.subtree_control'), constants.W_OK);
    const leaf = join(base, ENGINE_LEAF);
    if (!existsSync(leaf)) mkdirSync(leaf);
    if (threaded && read(join(leaf, 'cgroup.type')) !== 'threaded') writeFileSync(join(leaf, 'cgroup.type'), 'threaded');
    // No-internal-process rule: every process still in the base moves to the Engine leaf before controllers are enabled.
    for (const id of read(join(base, moveFile)).split('\n').filter(Boolean)) tryWrite(join(leaf, moveFile), id);
    const available = read(join(base, 'cgroup.controllers')).split(/\s+/);
    for (const c of ['cpu', 'memory', 'pids']) if (available.includes(c)) tryWrite(join(base, 'cgroup.subtree_control'), `+${c}`);
    delegation = { base, threaded, controllers: new Set(read(join(base, 'cgroup.subtree_control')).split(/\s+/).filter(Boolean)) };
    delegationError = null;
  } catch (error) {
    delegationError = `cgroup subtree not delegated: ${(error as Error).message}`;
    delegation = null;
  }
  return delegation;
}

/** Reset the cached probe (tests). */
export function resetCgroupDelegation(): void {
  delegation = undefined;
  delegationError = null;
}

/** All task ids (threads) in a cgroup subtree. */
function tasks(dir: string): number[] {
  const out: number[] = [];
  const walk = (d: string) => {
    try { for (const t of read(join(d, 'cgroup.threads')).split('\n')) if (t) out.push(Number(t)); } catch { /* gone */ }
    try { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(join(d, e.name)); } catch { /* gone */ }
  };
  walk(dir);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kill everything in a cgroup subtree: `cgroup.kill`, or (threaded cgroups) freeze → SIGKILL each task → thaw. */
export function killCgroupTree(dir: string): void {
  if (!existsSync(dir)) return;
  if (tryWrite(join(dir, 'cgroup.kill'), '1')) return;
  tryWrite(join(dir, 'cgroup.freeze'), '1');
  for (let round = 0; round < 5; round++) {
    const ids = tasks(dir);
    if (!ids.length) break;
    for (const id of ids) { try { process.kill(id, 'SIGKILL'); } catch { /* exited */ } }
  }
  tryWrite(join(dir, 'cgroup.freeze'), '0');
}

/** Remove a cgroup subtree bottom-up once it is empty (killing what is left). */
export function removeCgroupTree(dir: string): void {
  if (!existsSync(dir)) return;
  killCgroupTree(dir);
  const rm = (d: string): void => {
    try { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) rm(join(d, e.name)); } catch { /* gone */ }
    for (let i = 0; i < 50; i++) {
      try { rmdirSync(d); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        killCgroupTree(d);
        const until = Date.now() + 20;
        while (Date.now() < until) { /* brief spin: rmdir succeeds once the killed tasks are reaped */ }
      }
    }
  };
  rm(dir);
}

/** Sandbox cgroups under the delegated base (for the reaper). */
export function listSandboxCgroups(): string[] {
  const d = cgroupDelegation();
  if (!d) return [];
  try { return readdirSync(d.base).filter((n) => n.startsWith('sbx-')).map((n) => join(d.base, n)); } catch { return []; }
}

export class SandboxCgroup {
  readonly path: string;
  readonly threaded: boolean;
  readonly enforced: { memory: boolean; pids: boolean; cpu: boolean };
  private seq = 0;

  private constructor(path: string, threaded: boolean, enforced: SandboxCgroup['enforced']) {
    this.path = path;
    this.threaded = threaded;
    this.enforced = enforced;
  }

  /** Create the sandbox cgroup with its limits, or null when no delegated subtree exists. */
  static create(name: string, limits: SandboxLimits): SandboxCgroup | null {
    const d = cgroupDelegation();
    if (!d) return null;
    const path = join(d.base, `sbx-${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
    mkdirSync(path, { recursive: true });
    if (d.threaded) writeFileSync(join(path, 'cgroup.type'), 'threaded');
    const l = { ...DEFAULT_LIMITS, ...limits };
    const memory = d.controllers.has('memory') && tryWrite(join(path, 'memory.max'), String(l.memoryBytes));
    if (memory) { tryWrite(join(path, 'memory.swap.max'), '0'); tryWrite(join(path, 'memory.oom.group'), '1'); }
    const pids = d.controllers.has('pids') && tryWrite(join(path, 'pids.max'), String(l.pids));
    const cpu = d.controllers.has('cpu') && tryWrite(join(path, 'cpu.max'), `${Math.max(1000, Math.round(l.cpus * 100_000))} 100000`);
    return new SandboxCgroup(path, d.threaded, { memory, pids, cpu });
  }

  /** A fresh per-command leaf; the command's whole process tree stays in it. */
  leaf(): string {
    const p = join(this.path, `c${++this.seq}`);
    mkdirSync(p);
    if (this.threaded) writeFileSync(join(p, 'cgroup.type'), 'threaded');
    return p;
  }

  /** `[cmd, args]` that first joins `leaf`, then execs the real command (children inherit the cgroup). */
  wrap(leaf: string, cmd: string, args: string[]): [string, string[]] {
    const file = join(leaf, this.threaded ? 'cgroup.threads' : 'cgroup.procs');
    return ['/bin/sh', ['-c', 'echo $$ > "$1" && shift && exec "$@"', 'helix-cg', file, cmd, ...args]];
  }

  removeLeaf(leaf: string): void {
    removeCgroupTree(leaf);
  }

  kill(leaf?: string): void {
    killCgroupTree(leaf ?? this.path);
  }

  /** Freeze every process of the sandbox (suspend); resolves once the kernel reports the subtree frozen. */
  async freeze(): Promise<void> {
    writeFileSync(join(this.path, 'cgroup.freeze'), '1');
    for (let i = 0; i < 200; i++) {
      if (/^frozen 1$/m.test(read(join(this.path, 'cgroup.events')))) return;
      await sleep(10);
    }
    throw new Error(`cgroup ${this.path} did not freeze`);
  }

  thaw(): void {
    tryWrite(join(this.path, 'cgroup.freeze'), '0');
  }

  frozen(): boolean {
    try { return /^frozen 1$/m.test(read(join(this.path, 'cgroup.events'))); } catch { return false; }
  }

  /** Limit hits recorded by the kernel: OOM kills (memory.events) and refused forks (pids.events). */
  events(): { oomKills: number; pidsMax: number } {
    const field = (file: string, key: string) => {
      try { return Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(read(join(this.path, file)))?.[1] ?? 0); } catch { return 0; }
    };
    return { oomKills: field('memory.events', 'oom_kill'), pidsMax: field('pids.events', 'max') };
  }

  destroy(): void {
    removeCgroupTree(this.path);
  }
}
