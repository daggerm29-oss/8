import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { helixHome } from '../util/log.ts';
import { listSandboxCgroups, removeCgroupTree } from './cgroup.ts';
import { clientEnv, removeContainerDirectory, type ContainerCli } from './container.ts';

/**
 * Orphaned-sandbox reaper (F-SBX-5, SEC-12, §16.4). Every LocalSandbox writes an owner record to
 * `$HELIX_HOME/sandboxes/<id>.json`; containers carry `helix.owner=<engine-id>` and `helix.sandbox=<id>` labels.
 * On Engine start and on a timer, records whose owning Engine is gone are destroyed: cgroup subtree killed and
 * removed, labelled containers removed, scratch/root/control directories deleted.
 */
export interface SandboxRecord {
  id: string;
  owner: string;
  createdAt: string;
  cgroup: string | null;
  containerCli: ContainerCli | null;
  dirs: string[];
}

/** `<pid>:<start time in clock ticks>`, unique per process lifetime (a reused pid does not match). */
export function processIdentity(pid: number): string | null {
  if (process.platform !== 'linux') {
    try { process.kill(pid, 0); return `${pid}:0`; } catch { return null; }
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return `${pid}:${start}`;
  } catch {
    return null;
  }
}

let self: string | null = null;
export function engineIdentity(): string {
  self ??= processIdentity(process.pid) ?? `${process.pid}:0`;
  return self;
}

function ownerAlive(owner: string): boolean {
  const pid = Number(owner.split(':')[0]);
  return Number.isInteger(pid) && pid > 0 && processIdentity(pid) === owner;
}

const registryDir = () => join(helixHome(), 'sandboxes');

export function writeSandboxRecord(rec: SandboxRecord): void {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${encodeURIComponent(rec.id)}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function removeSandboxRecord(id: string): void {
  rmSync(join(registryDir(), `${encodeURIComponent(id)}.json`), { force: true });
}

export function listSandboxRecords(): SandboxRecord[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).flatMap((n) => {
    try { return [JSON.parse(readFileSync(join(dir, n), 'utf8')) as SandboxRecord]; } catch { return []; }
  });
}

function removeContainersByLabel(cli: ContainerCli, label: string): number {
  const ls = spawnSync(cli, ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8', env: clientEnv(), timeout: 30_000 });
  const ids = ls.status === 0 ? ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (ids.length) spawnSync(cli, ['rm', '-f', '-t', '0', ...ids], { stdio: 'ignore', env: clientEnv(), timeout: 60_000 });
  return ids.length;
}

/** Labelled Helix containers whose owner Engine is dead and that have no record (e.g. record lost). */
function strayContainers(cli: ContainerCli): Array<{ id: string; owner: string }> {
  const ls = spawnSync(cli, ['ps', '-a', '--filter', 'label=helix.owner', '--format', '{{.ID}} {{index .Labels "helix.owner"}}'], { encoding: 'utf8', env: clientEnv(), timeout: 30_000 });
  if (ls.status !== 0) return [];
  return ls.stdout.split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 2).map(([id, owner]) => ({ id, owner }));
}

export interface ReapResult { reaped: string[]; containers: number; cgroups: number }

/**
 * Destroy sandboxes whose owning Engine no longer runs. `minAgeMs` skips records younger than that (TTL),
 * protecting sandboxes an Engine is still creating.
 */
export function reapOrphans(opts: { minAgeMs?: number; containerClis?: ContainerCli[] } = {}): ReapResult {
  const out: ReapResult = { reaped: [], containers: 0, cgroups: 0 };
  const minAge = opts.minAgeMs ?? 0;
  const clis = new Set<ContainerCli>(opts.containerClis ?? []);
  const known = new Set<string>();
  for (const rec of listSandboxRecords()) {
    known.add(rec.cgroup ?? '');
    if (rec.containerCli) clis.add(rec.containerCli);
    if (ownerAlive(rec.owner) || Date.now() - Date.parse(rec.createdAt) < minAge) continue;
    if (rec.cgroup && existsSync(rec.cgroup)) { removeCgroupTree(rec.cgroup); out.cgroups++; }
    if (rec.containerCli) out.containers += removeContainersByLabel(rec.containerCli, `helix.sandbox=${rec.id}`);
    for (const d of rec.dirs) {
      try { if (rec.containerCli) removeContainerDirectory(rec.containerCli, d); else rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    removeSandboxRecord(rec.id);
    out.reaped.push(rec.id);
  }
  // Sandbox cgroups without a record: the name embeds the owner's pid and start time (`sbx-<pid>_<start>-…`).
  for (const cg of listSandboxCgroups()) {
    if (known.has(cg)) continue;
    const m = /^sbx-(\d+)_(\d+)-/.exec(basename(cg));
    if (!m || ownerAlive(`${m[1]}:${m[2]}`)) continue;
    try { if (Date.now() - statSync(cg).ctimeMs < minAge) continue; } catch { continue; }
    removeCgroupTree(cg);
    out.cgroups++;
  }
  for (const cli of clis) {
    for (const c of strayContainers(cli)) {
      if (ownerAlive(c.owner)) continue;
      spawnSync(cli, ['rm', '-f', '-t', '0', c.id], { stdio: 'ignore', env: clientEnv(), timeout: 60_000 });
      out.containers++;
    }
  }
  return out;
}

/** Reap once now, then every `intervalMs` (unref'd timer). Returns a stop function. */
export function startReaper(opts: { intervalMs?: number; minAgeMs?: number; onReap?: (r: ReapResult) => void } = {}): () => void {
  const run = () => {
    try {
      const r = reapOrphans({ minAgeMs: opts.minAgeMs });
      if (r.reaped.length || r.containers || r.cgroups) opts.onReap?.(r);
    } catch { /* the next tick retries */ }
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
