import type { Db } from '../storage/db.ts';
import { json } from '../storage/db.ts';
import type { EventBus } from '../events/bus.ts';
import { prefixedId } from '../util/ids.ts';
import { DEFAULT_EGRESS_ALLOWLIST, type EgressContext } from './egress.ts';

export type NetDecision = 'once' | 'always' | 'deny';

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeHost(host: unknown): string {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (!HOST_RE.test(h) || h.length > 253) throw new Error('host must be a DNS name like example.com');
  return h;
}

/**
 * Layered egress allowlist and the per-domain `network` approval class (F-SBX-3, FR-18, §16.5, §10.5).
 * Layers: defaults, then workspace (`tool = ''`), then per-tool (`tool = 'mcp:<server>'`) entries that apply
 * only to that tool. An unknown host from an interactive task's sandbox raises a `network` approval:
 * `once` allows that connection only, `always` persists the host for the workspace, `deny` refuses it.
 */
export class NetPolicy {
  private readonly pending = new Map<string, { resolve: (d: NetDecision) => void; ws: string; host: string; task: string; tool: string }>();
  private readonly o: { db: Db; bus: EventBus; workspaceId: (root: string) => string; timeoutMs?: number };

  constructor(o: NetPolicy['o']) {
    this.o = o;
    o.db.run(`UPDATE approvals SET status = 'expired', decision_by = 'system' WHERE action_class = 'network' AND tool = 'net.domain' AND status = 'pending'`);
  }

  scope(ctx: EgressContext): string {
    return ctx.ws ?? this.o.workspaceId(ctx.root);
  }

  isAllowed(host: string, ctx: EgressContext): boolean {
    if (DEFAULT_EGRESS_ALLOWLIST.includes(host)) return true;
    return !!this.o.db.get(`SELECT 1 AS ok FROM egress_allow WHERE ws = ? AND host = ? AND (tool = '' OR tool = ?)`, this.scope(ctx), host, ctx.tool ?? '');
  }

  allow(ws: string, host: string, opts: { tool?: string; by?: string } = {}): { ok: true; host: string; tool?: string } {
    const h = normalizeHost(host);
    const tool = opts.tool?.trim() ?? '';
    if (tool && !/^mcp:[A-Za-z0-9_.-]+$/.test(tool)) throw new Error(`tool must look like mcp:<server> (got ${tool})`);
    this.o.db.run('INSERT OR IGNORE INTO egress_allow (ws, tool, host, at) VALUES (?, ?, ?, ?)', ws, tool, h, new Date().toISOString());
    this.o.bus.publish({ topic: 'egress.allowed', ws, data: { host: h, ...(tool ? { tool } : {}), by: opts.by ?? 'user' }, persist: 'audit' });
    return { ok: true, host: h, ...(tool ? { tool } : {}) };
  }

  list(ws: string): Array<{ host: string; tool?: string; at: string }> {
    return this.o.db.all<{ host: string; tool: string; at: string }>('SELECT host, tool, at FROM egress_allow WHERE ws = ? ORDER BY tool, host', ws)
      .map((r) => ({ host: r.host, ...(r.tool ? { tool: r.tool } : {}), at: r.at }));
  }

  /** Raise a `network` approval for an interactive task; anything else (headless, plan, no task) resolves null (plain deny + allow prompt). */
  ask(info: { host: string; port: number; method: string }, ctx: EgressContext): Promise<boolean | null> {
    const task = ctx.task ? this.o.db.get<{ ws: string; policy_profile: string; status: string }>('SELECT ws, policy_profile, status FROM tasks WHERE id = ?', ctx.task) : undefined;
    if (!task || task.policy_profile !== 'interactive' || ['done', 'failed', 'cancelled'].includes(task.status)) return Promise.resolve(null);
    const host = info.host;
    const ws = this.scope(ctx);
    const id = prefixedId('appr');
    const args = { host, port: info.port, method: info.method, sandbox: ctx.sandboxId, ...(ctx.tool ? { tool: ctx.tool } : {}) };
    this.o.db.run(`INSERT INTO approvals (id, task, tool, args_json, action_class, status, at) VALUES (?, ?, 'net.domain', ?, 'network', 'pending', ?)`, id, ctx.task!, json(args), new Date().toISOString());
    this.o.bus.publish({ topic: 'approval.requested', ws: task.ws, task: ctx.task, data: { approvalId: id, tool: 'net.domain', args, actionClass: 'network', choices: ['once', 'always', 'deny'] }, persist: 'audit' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(id, 'deny', 'system'), this.o.timeoutMs ?? 5 * 60_000);
      timer.unref();
      this.pending.set(id, {
        ws, host, task: ctx.task!, tool: ctx.tool ?? '',
        resolve: (d) => { clearTimeout(timer); resolve(d !== 'deny'); },
      });
    });
  }

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  decide(approvalId: string, decision: NetDecision, by = 'user'): { ok: true; decision: NetDecision; host: string } {
    const p = this.pending.get(approvalId);
    if (!p) throw new Error(`no pending network approval ${approvalId}`);
    this.pending.delete(approvalId);
    const approved = decision !== 'deny';
    this.o.db.run('UPDATE approvals SET status = ?, decision_by = ? WHERE id = ?', by === 'system' ? 'expired' : approved ? 'approved' : 'denied', by, approvalId);
    if (decision === 'always') this.allow(p.ws, p.host, { by });
    const taskWs = this.o.db.get<{ ws: string }>('SELECT ws FROM tasks WHERE id = ?', p.task)?.ws ?? p.ws;
    this.o.bus.publish({ topic: 'approval.decided', ws: taskWs, task: p.task, data: { approvalId, tool: 'net.domain', actionClass: 'network', host: p.host, approved, scope: decision, by }, persist: 'audit' });
    p.resolve(decision);
    return { ok: true, decision, host: p.host };
  }

  close(): void {
    for (const id of [...this.pending.keys()]) this.decide(id, 'deny', 'system');
  }
}
