import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskCreateParams } from '@helix/protocol';
import { json, parseJson, type Db } from '../storage/db.ts';
import { prefixedId } from '../util/ids.ts';
import type { TaskRuntime } from '../agent/runtime.ts';
import { inWriteSet, LEASE_HEARTBEAT_MS, LeaseManager } from './lease.ts';

export { globsOverlap, writeSetsOverlap } from './lease.ts';

/**
 * Task DAG scheduler (F-ORC-2 + F-ORC-3 minimal, §10.3–10.4). Each node is a general `coder` subagent = a child task with a
 * brief (node goal + its write set + dependency results), not the parent transcript. Ready nodes (all deps done) start in
 * critical-path order up to `concurrency`. A node with a `writeSet` must acquire a write lease first (overlap with a live
 * lease → it waits); its write tools are confined to the lease. A failed node blocks its transitive dependents.
 *
 * `isolation: 'worktree'` (git workspaces): the DAG gets an integration branch `helix/<dag>` from HEAD; each node runs in
 * its own git worktree branched from the integration tip, its changes are committed (files outside the lease → node fails),
 * then merged into the integration branch through a serialized merge queue. A conflicting merge goes to a merger subagent
 * (child task in the integration worktree, leased to the conflicted files, same verify gates); unresolved → merge aborted,
 * node failed. The user's checkout is never touched. No resume after restart, semantic conflict prediction, or per-node
 * dev-server ports yet.
 */
export interface DagNodeInput {
  id: string;
  goal: string;
  deps?: string[];
  /** Path globs the node may write (`*` within a segment, `**` across). Empty = unleased. */
  writeSet?: string[];
}

export interface DagRunParams extends Omit<TaskCreateParams, 'goal' | 'title' | 'start'> {
  nodes: DagNodeInput[];
  concurrency?: number;
  isolation?: 'shared' | 'worktree';
}

export type DagNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';
export interface DagMerge { commit: string | null; conflicts: string[]; mergerTask?: string; changed: string[] }
export interface DagNodeState { id: string; goal: string; deps: string[]; writeSet: string[]; priority: number; status: DagNodeStatus; task: string | null; result: string | null; error: string | null; startedAt: string | null; finishedAt: string | null; branch: string | null; merge: DagMerge | null }
export interface DagState { id: string; status: 'running' | 'done' | 'failed'; concurrency: number; branch: string | null; nodes: DagNodeState[] }

const MAX_CONCURRENCY = 8;
const RESULT_CHARS = 1500;
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

/** Validate ids/deps/cycles and compute each node's critical-path length (longest chain of dependents incl. itself). */
export function planDag(nodes: DagNodeInput[]): Map<string, number> {
  if (!nodes.length) throw new Error('a DAG needs at least one node');
  const byId = new Map<string, DagNodeInput>();
  for (const n of nodes) {
    if (!n.id || !/^[\w.-]{1,64}$/.test(n.id)) throw new Error(`invalid node id '${n.id}'`);
    if (!n.goal?.trim()) throw new Error(`node ${n.id} has no goal`);
    if (byId.has(n.id)) throw new Error(`duplicate node id '${n.id}'`);
    byId.set(n.id, n);
  }
  const dependents = new Map<string, string[]>([...byId.keys()].map((k) => [k, []]));
  for (const n of nodes) for (const d of n.deps ?? []) {
    if (!byId.has(d)) throw new Error(`node ${n.id} depends on unknown node '${d}'`);
    dependents.get(d)!.push(n.id);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) throw new Error(`dependency cycle through '${id}'`);
    visiting.add(id);
    const d = 1 + Math.max(0, ...dependents.get(id)!.map(visit));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of byId.keys()) visit(id);
  return depth;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Helix', '-c', 'user.email=helix@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

export class DagScheduler {
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly o: { db: Db; runtime: TaskRuntime; worktreeRoot: string };
  readonly leases: LeaseManager;
  constructor(o: DagScheduler['o']) {
    this.o = o;
    this.leases = new LeaseManager(o.db);
  }

  run(p: DagRunParams): DagState {
    const priority = planDag(p.nodes);
    const ws = this.o.runtime.workspaceFor(p.workspacePath);
    const id = prefixedId('dag');
    const now = new Date().toISOString();
    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(p.concurrency ?? 2)));
    const { nodes, concurrency: _c, isolation = 'shared', ...options } = p;
    let branch: string | null = null;
    if (isolation === 'worktree') {
      try { git(ws.path, 'rev-parse', '--verify', 'HEAD'); } catch { throw new Error('worktree isolation needs a git workspace with at least one commit'); }
      branch = `helix/${id}`;
      git(ws.path, 'branch', branch, 'HEAD');
      mkdirSync(join(this.o.worktreeRoot, id), { recursive: true });
      git(ws.path, 'worktree', 'add', '-q', join(this.o.worktreeRoot, id, '_integration'), branch);
    }
    this.o.db.run('INSERT INTO dags (id, ws, status, concurrency, options_json, created_at, updated_at, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, ws.id, 'running', concurrency, json({ ...options, workspacePath: ws.path, isolation }), now, now, branch);
    for (const n of nodes) {
      this.o.db.run('INSERT INTO dag_nodes (dag, id, goal, deps_json, write_set_json, priority, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, n.id, n.goal, json(n.deps ?? []), json(n.writeSet ?? []), priority.get(n.id)!, 'pending');
    }
    this.pumps.set(id, this.pump(id).finally(() => this.pumps.delete(id)));
    return this.status(id);
  }

  status(id: string): DagState {
    const d = this.o.db.get<{ id: string; status: DagState['status']; concurrency: number; branch: string | null }>('SELECT id, status, concurrency, branch FROM dags WHERE id = ?', id);
    if (!d) throw new Error(`unknown dag ${id}`);
    const nodes = this.o.db.all<Record<string, string | number | null>>('SELECT * FROM dag_nodes WHERE dag = ? ORDER BY rowid', id).map((r) => ({
      id: String(r.id), goal: String(r.goal), deps: parseJson<string[]>(r.deps_json, []), writeSet: parseJson<string[]>(r.write_set_json, []), priority: Number(r.priority),
      status: r.status as DagNodeStatus, task: (r.task as string) ?? null, result: (r.result as string) ?? null, error: (r.error as string) ?? null,
      startedAt: (r.started_at as string) ?? null, finishedAt: (r.finished_at as string) ?? null, branch: (r.branch as string) ?? null, merge: parseJson<DagMerge | null>(r.merge_json, null),
    }));
    return { id: d.id, status: d.status, concurrency: d.concurrency, branch: d.branch, nodes };
  }

  async wait(id: string, timeoutMs = 0): Promise<DagState> {
    const pump = this.pumps.get(id);
    if (pump) await (timeoutMs > 0 ? Promise.race([pump, new Promise((r) => setTimeout(r, timeoutMs).unref())]) : pump);
    return this.status(id);
  }

  private setNode(dag: string, node: string, fields: Partial<Record<'status' | 'task' | 'result' | 'error' | 'started_at' | 'finished_at' | 'branch' | 'merge_json', string | null>>): void {
    const keys = Object.keys(fields);
    this.o.db.run(`UPDATE dag_nodes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE dag = ? AND id = ?`, ...keys.map((k) => fields[k as keyof typeof fields] ?? null), dag, node);
  }

  private brief(node: DagNodeState, all: DagNodeState[]): string {
    const out = [node.goal.trim(), '', `You are DAG node '${node.id}', a coder subagent working on one part of a larger plan.`];
    if (node.writeSet.length) out.push(`Only create or modify files matching: ${node.writeSet.join(', ')}. Other nodes own the other files; writes outside this lease fail.`);
    const deps = all.filter((n) => node.deps.includes(n.id));
    if (deps.length) {
      out.push('', 'Results of the nodes you depend on:');
      for (const d of deps) out.push(`- ${d.id}: ${(d.result ?? '(no summary)').slice(0, RESULT_CHARS)}`);
    }
    return out.join('\n');
  }

  private async runChild(options: Omit<TaskCreateParams, 'goal'>, workspacePath: string, goal: string, title: string, lease: string[] | null, onTask: (task: string) => void) {
    const task = this.o.runtime.create({ ...options, workspacePath, goal, title, start: false });
    if (lease) this.o.runtime.writeLeases.set(task.id, lease);
    onTask(task.id);
    try {
      this.o.runtime.start(task.id);
      return await this.o.runtime.wait(task.id);
    } finally {
      this.o.runtime.writeLeases.delete(task.id);
    }
  }

  /** Merge a node branch into the integration worktree; conflicts go to a merger subagent. */
  private async merge(dag: string, integration: string, node: DagNodeState, branch: string, changed: string[], options: Omit<TaskCreateParams, 'goal'>): Promise<{ ok: boolean; merge: DagMerge; error?: string }> {
    try {
      git(integration, 'merge', '--no-ff', '--no-edit', '-m', `dag ${dag}: merge node ${node.id}`, branch);
      return { ok: true, merge: { commit: git(integration, 'rev-parse', 'HEAD'), conflicts: [], changed } };
    } catch {
      const conflicts = lines(git(integration, 'diff', '--name-only', '--diff-filter=U'));
      if (!conflicts.length) {
        try { git(integration, 'merge', '--abort'); } catch { /* nothing to abort */ }
        return { ok: false, merge: { commit: null, conflicts, changed }, error: 'merge failed without conflicted files' };
      }
      let mergerTask: string | undefined;
      const goal = [`You are the merge agent for DAG ${dag}. Merging node '${node.id}' (${node.goal.trim().slice(0, 300)}) into the integration branch produced conflicts in:`,
        ...conflicts.map((f) => `- ${f}`), '', 'Read each file, resolve every conflict so both sides\' intent is kept, and remove all <<<<<<< ======= >>>>>>> markers. Only edit the conflicted files.'].join('\n');
      const done = await this.runChild(options, integration, goal, `[dag ${node.id}] merge`, conflicts, (t) => { mergerTask = t; });
      const left = conflicts.filter((f) => !existsSync(join(integration, f)) || CONFLICT_MARKER.test(readFileSync(join(integration, f), 'utf8')));
      if (done.status === 'done' && !left.length) {
        git(integration, 'add', '-A');
        git(integration, 'commit', '-q', '--no-edit');
        return { ok: true, merge: { commit: git(integration, 'rev-parse', 'HEAD'), conflicts, mergerTask, changed } };
      }
      git(integration, 'merge', '--abort');
      return { ok: false, merge: { commit: null, conflicts, mergerTask, changed }, error: left.length ? `merge conflicts unresolved in ${left.join(', ')}` : `merge agent ${done.status}: ${done.error ?? ''}` };
    }
  }

  private async pump(id: string): Promise<void> {
    const options = parseJson<Omit<TaskCreateParams, 'goal'> & { isolation: 'shared' | 'worktree' }>(this.o.db.get<{ options_json: string }>('SELECT options_json FROM dags WHERE id = ?', id)!.options_json, { workspacePath: '', isolation: 'shared' });
    const { isolation, ...taskOptions } = options;
    const integration = join(this.o.worktreeRoot, id, '_integration');
    const running = new Map<string, Promise<void>>();
    let mergeQueue: Promise<unknown> = Promise.resolve();
    for (;;) {
      let state = this.status(id);
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of state.nodes) {
          const bad = n.deps.filter((d) => ['failed', 'blocked'].includes(byId.get(d)!.status));
          if (n.status === 'pending' && bad.length) {
            this.setNode(id, n.id, { status: 'blocked', error: `blocked by ${bad.join(', ')}`, finished_at: new Date().toISOString() });
            n.status = 'blocked';
            changed = true;
          }
        }
      }
      state = this.status(id);
      const active = state.nodes.filter((n) => n.status === 'running').length;
      const ready = state.nodes
        .filter((n) => n.status === 'pending' && n.deps.every((d) => byId.get(d)!.status === 'done'))
        .sort((a, b) => b.priority - a.priority);
      let slots = state.concurrency - active;
      for (const n of ready) {
        if (slots <= 0) break;
        const got = n.writeSet.length ? this.leases.acquire(`${id}:${n.id}`, n.writeSet) : null;
        if (got && !got.lease) continue;
        slots--;
        const lease = got?.lease ?? null;
        this.setNode(id, n.id, { status: 'running', started_at: new Date().toISOString() });
        n.status = 'running';
        const heartbeat = lease ? setInterval(() => this.leases.heartbeat(lease.id), LEASE_HEARTBEAT_MS) : undefined;
        heartbeat?.unref();
        running.set(n.id, (async () => {
          let wt = taskOptions.workspacePath;
          let branch: string | null = null;
          let base = '';
          if (isolation === 'worktree') {
            branch = `helix/${id}-${n.id}`;
            wt = join(this.o.worktreeRoot, id, n.id);
            base = git(integration, 'rev-parse', 'HEAD');
            git(taskOptions.workspacePath, 'worktree', 'add', '-q', '-b', branch, wt, base);
            this.setNode(id, n.id, { branch });
          }
          try {
            const done = await this.runChild(taskOptions, wt, this.brief(n, state.nodes), `[dag ${n.id}] ${n.goal.slice(0, 60)}`, n.writeSet.length ? n.writeSet : null, (task) => this.setNode(id, n.id, { task }));
            if (done.status !== 'done') {
              this.setNode(id, n.id, { status: 'failed', result: done.result ?? null, error: done.error ?? `task ${done.status}`, finished_at: new Date().toISOString() });
              return;
            }
            if (isolation === 'worktree') {
              git(wt, 'add', '-A');
              if (git(wt, 'status', '--porcelain')) git(wt, 'commit', '-q', '-m', `dag ${id}: node ${n.id}\n\n${n.goal.trim().slice(0, 500)}`);
              const files = lines(git(wt, 'diff', '--name-only', `${base}..HEAD`));
              const outside = n.writeSet.length ? files.filter((f) => !inWriteSet(n.writeSet, f)) : [];
              if (outside.length) {
                this.setNode(id, n.id, { status: 'failed', result: done.result ?? null, error: `lease violation: changed ${outside.join(', ')} outside ${n.writeSet.join(', ')}`, merge_json: json({ commit: null, conflicts: [], changed: files }), finished_at: new Date().toISOString() });
                return;
              }
              const m = await (mergeQueue = mergeQueue.then(() => this.merge(id, integration, n, branch!, files, taskOptions))) as Awaited<ReturnType<DagScheduler['merge']>>;
              this.setNode(id, n.id, { status: m.ok ? 'done' : 'failed', result: done.result ?? null, error: m.error ?? null, merge_json: json(m.merge), finished_at: new Date().toISOString() });
              return;
            }
            this.setNode(id, n.id, { status: 'done', result: done.result ?? null, finished_at: new Date().toISOString() });
          } finally {
            if (isolation === 'worktree' && existsSync(wt)) { try { git(taskOptions.workspacePath, 'worktree', 'remove', '--force', wt); } catch { /* left for inspection */ } }
            if (heartbeat) clearInterval(heartbeat);
            if (lease) this.leases.release(lease.id);
          }
        })().catch((e: Error) => this.setNode(id, n.id, { status: 'failed', error: e.message, finished_at: new Date().toISOString() })).finally(() => running.delete(n.id)));
      }
      if (!running.size) {
        if (this.status(id).nodes.some((n) => n.status === 'pending' && n.deps.every((d) => byId.get(d)!.status === 'done'))) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        break;
      }
      await Promise.race(running.values());
    }
    if (isolation === 'worktree' && existsSync(integration)) { try { git(taskOptions.workspacePath, 'worktree', 'remove', '--force', integration); } catch { /* left for inspection */ } }
    const final = this.status(id);
    const status = final.nodes.every((n) => n.status === 'done') ? 'done' : 'failed';
    this.o.db.run('UPDATE dags SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
  }
}
