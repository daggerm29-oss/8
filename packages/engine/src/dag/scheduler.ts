import type { TaskCreateParams } from '@helix/protocol';
import { json, parseJson, type Db } from '../storage/db.ts';
import { prefixedId } from '../util/ids.ts';
import type { TaskRuntime } from '../agent/runtime.ts';

/**
 * Task DAG scheduler (F-ORC-2 minimal, §10.3). Each node is a general `coder` subagent = a child task with a brief
 * (node goal + its write set + dependency results), its own step cap and budget. Ready nodes (all deps done) are started
 * in critical-path order up to `concurrency`; a node whose `writeSet` overlaps a running node's waits (serialized).
 * A failed node blocks its transitive dependents. DAG + node state persist in SQLite. No leases/worktrees (F-ORC-3),
 * merge queue, or resume after restart yet.
 */
export interface DagNodeInput {
  id: string;
  goal: string;
  deps?: string[];
  /** Path globs the node may write (`*` within a segment, `**` across). */
  writeSet?: string[];
}

export interface DagRunParams extends Omit<TaskCreateParams, 'goal' | 'title' | 'start'> {
  nodes: DagNodeInput[];
  concurrency?: number;
}

export type DagNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';
export interface DagNodeState { id: string; goal: string; deps: string[]; writeSet: string[]; priority: number; status: DagNodeStatus; task: string | null; result: string | null; error: string | null; startedAt: string | null; finishedAt: string | null }
export interface DagState { id: string; status: 'running' | 'done' | 'failed'; concurrency: number; nodes: DagNodeState[] }

const MAX_CONCURRENCY = 8;
const RESULT_CHARS = 1500;

/** Static prefix before the first wildcard. */
const staticPrefix = (glob: string) => glob.replace(/^\.\//, '').split('*')[0];

/** Conservative overlap test: two globs may touch the same file when one static prefix is a prefix of the other. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a), pb = staticPrefix(b);
  const wa = a.includes('*'), wb = b.includes('*');
  if (!wa && !wb) return pa === pb;
  if (!wa) return pa.startsWith(pb);
  if (!wb) return pb.startsWith(pa);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export const writeSetsOverlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => globsOverlap(x, y)));

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
  for (const n of nodes) for (const d of n.deps ?? []) if (n.id === d) throw new Error(`dependency cycle through '${n.id}'`);
  return depth;
}

export class DagScheduler {
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly o: { db: Db; runtime: TaskRuntime };
  constructor(o: DagScheduler['o']) {
    this.o = o;
  }

  run(p: DagRunParams): DagState {
    const priority = planDag(p.nodes);
    const ws = this.o.runtime.workspaceFor(p.workspacePath);
    const id = prefixedId('dag');
    const now = new Date().toISOString();
    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(p.concurrency ?? 2)));
    const { nodes, concurrency: _c, ...options } = p;
    this.o.db.run('INSERT INTO dags (id, ws, status, concurrency, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ws.id, 'running', concurrency, json({ ...options, workspacePath: ws.path }), now, now);
    for (const n of nodes) {
      this.o.db.run('INSERT INTO dag_nodes (dag, id, goal, deps_json, write_set_json, priority, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, n.id, n.goal, json(n.deps ?? []), json(n.writeSet ?? []), priority.get(n.id)!, 'pending');
    }
    this.pumps.set(id, this.pump(id).finally(() => this.pumps.delete(id)));
    return this.status(id);
  }

  status(id: string): DagState {
    const d = this.o.db.get<{ id: string; status: DagState['status']; concurrency: number }>('SELECT id, status, concurrency FROM dags WHERE id = ?', id);
    if (!d) throw new Error(`unknown dag ${id}`);
    const nodes = this.o.db.all<Record<string, string | number | null>>('SELECT * FROM dag_nodes WHERE dag = ? ORDER BY rowid', id).map((r) => ({
      id: String(r.id), goal: String(r.goal), deps: parseJson<string[]>(r.deps_json, []), writeSet: parseJson<string[]>(r.write_set_json, []), priority: Number(r.priority),
      status: r.status as DagNodeStatus, task: (r.task as string) ?? null, result: (r.result as string) ?? null, error: (r.error as string) ?? null,
      startedAt: (r.started_at as string) ?? null, finishedAt: (r.finished_at as string) ?? null,
    }));
    return { id: d.id, status: d.status, concurrency: d.concurrency, nodes };
  }

  async wait(id: string, timeoutMs = 0): Promise<DagState> {
    const pump = this.pumps.get(id);
    if (pump) await (timeoutMs > 0 ? Promise.race([pump, new Promise((r) => setTimeout(r, timeoutMs).unref())]) : pump);
    return this.status(id);
  }

  private setNode(dag: string, node: string, fields: Partial<Record<'status' | 'task' | 'result' | 'error' | 'started_at' | 'finished_at', string | null>>): void {
    const keys = Object.keys(fields);
    this.o.db.run(`UPDATE dag_nodes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE dag = ? AND id = ?`, ...keys.map((k) => fields[k as keyof typeof fields] ?? null), dag, node);
  }

  private brief(node: DagNodeState, all: DagNodeState[]): string {
    const lines = [node.goal.trim(), '', `You are DAG node '${node.id}', a coder subagent working on one part of a larger plan.`];
    if (node.writeSet.length) lines.push(`Only create or modify files matching: ${node.writeSet.join(', ')}. Other nodes own the other files.`);
    const deps = all.filter((n) => node.deps.includes(n.id));
    if (deps.length) {
      lines.push('', 'Results of the nodes you depend on:');
      for (const d of deps) lines.push(`- ${d.id}: ${(d.result ?? '(no summary)').slice(0, RESULT_CHARS)}`);
    }
    return lines.join('\n');
  }

  private async pump(id: string): Promise<void> {
    const options = parseJson<Omit<TaskCreateParams, 'goal'>>(this.o.db.get<{ options_json: string }>('SELECT options_json FROM dags WHERE id = ?', id)!.options_json, { workspacePath: '' });
    const running = new Map<string, Promise<void>>();
    for (;;) {
      let state = this.status(id);
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of state.nodes) {
          if (n.status === 'pending' && n.deps.some((d) => ['failed', 'blocked'].includes(byId.get(d)!.status))) {
            const why = n.deps.filter((d) => ['failed', 'blocked'].includes(byId.get(d)!.status));
            this.setNode(id, n.id, { status: 'blocked', error: `blocked by ${why.join(', ')}`, finished_at: new Date().toISOString() });
            n.status = 'blocked';
            changed = true;
          }
        }
      }
      state = this.status(id);
      const active = state.nodes.filter((n) => n.status === 'running');
      const ready = state.nodes
        .filter((n) => n.status === 'pending' && n.deps.every((d) => byId.get(d)!.status === 'done'))
        .sort((a, b) => b.priority - a.priority);
      for (const n of ready) {
        if (active.length >= state.concurrency) break;
        if (active.some((r) => writeSetsOverlap(r.writeSet, n.writeSet))) continue;
        active.push(n);
        const task = this.o.runtime.create({ ...options, goal: this.brief(n, state.nodes), title: `[dag ${n.id}] ${n.goal.slice(0, 60)}`, start: false });
        this.setNode(id, n.id, { status: 'running', task: task.id, started_at: new Date().toISOString() });
        n.status = 'running';
        running.set(n.id, (async () => {
          this.o.runtime.start(task.id);
          const done = await this.o.runtime.wait(task.id);
          const ok = done.status === 'done';
          this.setNode(id, n.id, { status: ok ? 'done' : 'failed', result: done.result ?? null, error: ok ? null : (done.error ?? `task ${done.status}`), finished_at: new Date().toISOString() });
        })().catch((e: Error) => this.setNode(id, n.id, { status: 'failed', error: e.message, finished_at: new Date().toISOString() })).finally(() => running.delete(n.id)));
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    const final = this.status(id);
    const status = final.nodes.every((n) => n.status === 'done') ? 'done' : 'failed';
    this.o.db.run('UPDATE dags SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
  }
}
