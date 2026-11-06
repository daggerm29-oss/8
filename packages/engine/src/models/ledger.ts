import type { LedgerTotals, ModelManifest, Usage } from '@helix/protocol';
import type { Db } from '../storage/db.ts';
import type { EventBus } from '../events/bus.ts';
import { prefixedId } from '../util/ids.ts';

export type ModelRole = 'planner' | 'coder' | 'explorer' | 'reviewer' | 'debugger' | 'summarizer' | 'embedder' | 'completion' | 'router';

export interface LedgerEntryInput {
  ws?: string;
  task?: string;
  agent?: string;
  step?: string;
  role: ModelRole;
  provider: string;
  model: string;
  routerReason?: string;
  usage: Usage;
  latencyMs: number;
  status: 'ok' | 'error' | 'cancelled';
  providerResponseId?: string;
  error?: string;
  contextBreakdown?: Record<string, number>;
  toolTokens?: Record<string, number>;
}

export interface BudgetSpec {
  scope: 'task' | 'day';
  scopeId: string;
  softUsd?: number | null;
  hardUsd?: number | null;
  softTokens?: number | null;
  hardTokens?: number | null;
  actionOnHard?: 'pause' | 'deny';
}

export interface BudgetDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  budgetId?: string;
  spentUsd: number;
  spentTokens: number;
}

/** Cost in USD from manifest pricing (§29.6). `null` when the model has no verified price. */
export function costOf(pricing: ModelManifest['pricing'] | undefined, usage: Pick<Usage, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>): number | null {
  if (!pricing) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const cachedRate = pricing.cachedInputPerM ?? pricing.inputPerM;
  return (uncached * pricing.inputPerM + cached * cachedRate + usage.outputTokens * pricing.outputPerM) / 1_000_000;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Token ledger v0 + budgets (F-TOK-1, F-TOK-2). One row per model call attempt. */
export class Ledger {
  private readonly db: Db;
  private readonly bus?: EventBus;

  constructor(db: Db, bus?: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  record(e: LedgerEntryInput, pricing: ModelManifest['pricing'] | undefined): { id: string; costUsd: number | null } {
    const id = prefixedId('led');
    const costUsd = e.status === 'ok' ? costOf(pricing, e.usage) : 0;
    const at = new Date().toISOString();
    this.db.run(
      `INSERT INTO ledger_entries (id, at, ws, task, agent, step, role, provider, model, router_reason, input_tokens, cached_input_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, cost_usd, latency_ms, status, usage_source, provider_usage_json, provider_response_id, context_breakdown_json, tool_tokens_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, at, e.ws ?? null, e.task ?? null, e.agent ?? null, e.step ?? null, e.role, e.provider, e.model, e.routerReason ?? null,
      e.usage.inputTokens, e.usage.cachedInputTokens, e.usage.cacheWriteTokens, e.usage.outputTokens, e.usage.reasoningTokens,
      costUsd, Math.round(e.latencyMs), e.status, e.usage.source, e.usage.raw ? JSON.stringify(e.usage.raw) : null, e.providerResponseId ?? null,
      e.contextBreakdown ? JSON.stringify(e.contextBreakdown) : null, e.toolTokens ? JSON.stringify(e.toolTokens) : null, e.error ?? null,
    );
    if (e.ws) {
      this.bus?.publish({
        topic: 'ledger.entry', ws: e.ws, task: e.task, agent: e.agent, step: e.step,
        data: { id, provider: e.provider, model: e.model, status: e.status, inputTokens: e.usage.inputTokens, cachedInputTokens: e.usage.cachedInputTokens, outputTokens: e.usage.outputTokens, reasoningTokens: e.usage.reasoningTokens, costUsd, usageSource: e.usage.source },
      });
    }
    return { id, costUsd };
  }

  totals(filter: { task?: string; ws?: string; since?: string } = {}): LedgerTotals {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.task) {
      where.push('task = ?');
      params.push(filter.task);
    }
    if (filter.ws) {
      where.push('ws = ?');
      params.push(filter.ws);
    }
    if (filter.since) {
      where.push('at >= ?');
      params.push(filter.since);
    }
    const row = this.db.get<Record<string, number | null>>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(cached_input_tokens),0) AS cached,
        COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(reasoning_tokens),0) AS reasoning, COALESCE(SUM(cost_usd),0) AS cost,
        COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END),0) AS provider_calls,
        COALESCE(SUM(CASE WHEN usage_source = 'estimate' THEN 1 ELSE 0 END),0) AS estimated_calls
       FROM ledger_entries WHERE status = 'ok'${where.length ? ` AND ${where.join(' AND ')}` : ''}`,
      ...params,
    )!;
    return {
      calls: Number(row.calls), inputTokens: Number(row.input), cachedInputTokens: Number(row.cached), outputTokens: Number(row.output),
      reasoningTokens: Number(row.reasoning), costUsd: Number(row.cost), providerReportedCalls: Number(row.provider_calls), estimatedCalls: Number(row.estimated_calls),
    };
  }

  entries(filter: { task?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    if (filter.task) return this.db.all('SELECT * FROM ledger_entries WHERE task = ? ORDER BY at, id LIMIT ?', filter.task, filter.limit ?? 1000);
    return this.db.all('SELECT * FROM ledger_entries ORDER BY at DESC, id DESC LIMIT ?', filter.limit ?? 100);
  }

  setBudget(spec: BudgetSpec): string {
    const existing = this.db.get<{ id: string }>('SELECT id FROM budgets WHERE scope = ? AND scope_id = ?', spec.scope, spec.scopeId);
    const id = existing?.id ?? prefixedId('bud');
    this.db.run(
      `INSERT INTO budgets (id, scope, scope_id, soft_usd, hard_usd, soft_tokens, hard_tokens, action_on_hard) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET soft_usd = excluded.soft_usd, hard_usd = excluded.hard_usd, soft_tokens = excluded.soft_tokens,
         hard_tokens = excluded.hard_tokens, action_on_hard = excluded.action_on_hard`,
      id, spec.scope, spec.scopeId, spec.softUsd ?? null, spec.hardUsd ?? null, spec.softTokens ?? null, spec.hardTokens ?? null, spec.actionOnHard ?? 'pause',
    );
    return id;
  }

  getBudget(scope: BudgetSpec['scope'], scopeId: string): (BudgetSpec & { id: string }) | undefined {
    const row = this.db.get<{ id: string; soft_usd: number | null; hard_usd: number | null; soft_tokens: number | null; hard_tokens: number | null; action_on_hard: 'pause' | 'deny' }>(
      'SELECT * FROM budgets WHERE scope = ? AND scope_id = ?', scope, scopeId,
    );
    if (!row) return undefined;
    return { id: row.id, scope, scopeId, softUsd: row.soft_usd, hardUsd: row.hard_usd, softTokens: row.soft_tokens, hardTokens: row.hard_tokens, actionOnHard: row.action_on_hard };
  }

  /** Pre-call check (§29.6): deny when spent + estimate would exceed a hard limit. Emits soft-threshold events once. */
  check(ctx: { task?: string; ws?: string; estimateUsd: number | null; estimateTokens: number }): BudgetDecision {
    const scopes: Array<{ budget: (BudgetSpec & { id: string }) | undefined; totals: LedgerTotals; label: string }> = [];
    if (ctx.task) scopes.push({ budget: this.getBudget('task', ctx.task), totals: this.totals({ task: ctx.task }), label: `task ${ctx.task}` });
    const day = today();
    scopes.push({ budget: this.getBudget('day', day), totals: this.totals({ since: `${day}T00:00:00.000Z` }), label: `day ${day}` });
    let spentUsd = 0;
    let spentTokens = 0;
    for (const { budget, totals, label } of scopes) {
      const usd = totals.costUsd;
      const tokens = totals.inputTokens + totals.outputTokens;
      if (label.startsWith('task')) {
        spentUsd = usd;
        spentTokens = tokens;
      }
      if (!budget) continue;
      const nextUsd = usd + (ctx.estimateUsd ?? 0);
      const nextTokens = tokens + ctx.estimateTokens;
      if (budget.hardUsd != null && nextUsd > budget.hardUsd) {
        this.budgetEvent(budget.id, 'hard_block', { label, spentUsd: usd, estimateUsd: ctx.estimateUsd, hardUsd: budget.hardUsd }, ctx.ws, ctx.task);
        return { decision: 'deny', reason: `hard budget for ${label} would be exceeded: spent $${usd.toFixed(4)} + estimated $${(ctx.estimateUsd ?? 0).toFixed(4)} > $${budget.hardUsd}`, budgetId: budget.id, spentUsd, spentTokens };
      }
      if (budget.hardTokens != null && nextTokens > budget.hardTokens) {
        this.budgetEvent(budget.id, 'hard_block', { label, spentTokens: tokens, estimateTokens: ctx.estimateTokens, hardTokens: budget.hardTokens }, ctx.ws, ctx.task);
        return { decision: 'deny', reason: `hard token budget for ${label} would be exceeded: ${tokens} + ~${ctx.estimateTokens} > ${budget.hardTokens}`, budgetId: budget.id, spentUsd, spentTokens };
      }
      const softHit = (budget.softUsd != null && nextUsd > budget.softUsd) || (budget.softTokens != null && nextTokens > budget.softTokens);
      if (softHit && !this.db.get('SELECT id FROM budget_events WHERE budget = ? AND kind = ?', budget.id, 'soft_threshold')) {
        this.budgetEvent(budget.id, 'soft_threshold', { label, spentUsd: usd, spentTokens: tokens }, ctx.ws, ctx.task);
      }
    }
    return { decision: 'allow', spentUsd, spentTokens };
  }

  private budgetEvent(budgetId: string, kind: string, data: Record<string, unknown>, ws?: string, task?: string): void {
    this.db.run('INSERT INTO budget_events (id, budget, at, kind, data_json) VALUES (?, ?, ?, ?, ?)', prefixedId('bev'), budgetId, new Date().toISOString(), kind, JSON.stringify(data));
    if (ws) this.bus?.publish({ topic: 'budget.threshold', ws, task, data: { budgetId, kind, ...data }, persist: 'audit' });
  }
}
