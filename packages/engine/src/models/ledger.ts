import type { LedgerTotals, ModelManifest, ModelRequest, Usage } from '@helix/protocol';
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
const tok = (chars: number) => Math.ceil(chars / 4);

/**
 * Attribution of one request (§29.6): tokens each tool's results contribute to this prompt (`toolTokens`,
 * by tool name) and the prompt split by kind (`contextBreakdown`). Estimated (~4 chars/token); the row's
 * provider-reported totals stay authoritative.
 */
export function attributeRequest(req: Pick<ModelRequest, 'system' | 'messages' | 'tools'>): { toolTokens: Record<string, number>; contextBreakdown: Record<string, number> } {
  const toolTokens: Record<string, number> = {};
  const breakdown: Record<string, number> = { system: tok((req.system ?? '').length), tool_specs: 0, user: 0, assistant: 0, tool_calls: 0, tool_results: 0, reasoning: 0 };
  for (const t of req.tools ?? []) breakdown.tool_specs += tok(t.name.length + t.description.length + JSON.stringify(t.inputSchema).length);
  for (const m of req.messages) {
    for (const p of m.parts) {
      if (p.type === 'text') {
        if (m.role === 'system') breakdown.system += tok(p.text.length);
        else breakdown[m.role === 'assistant' ? 'assistant' : 'user'] += tok(p.text.length);
      } else if (p.type === 'tool_call') breakdown.tool_calls += tok(p.name.length + JSON.stringify(p.args ?? null).length);
      else if (p.type === 'tool_result') {
        const n = tok(p.content.length + p.name.length);
        breakdown.tool_results += n;
        toolTokens[p.name] = (toolTokens[p.name] ?? 0) + n;
      } else if (p.type === 'reasoning') breakdown.reasoning += tok((p.summary ?? '').length);
    }
  }
  return { toolTokens, contextBreakdown: breakdown };
}

/** Fields every ledger row must carry (FR-31). `tool` = the `tool_tokens_json` attribution (may be `{}`). */
export const ATTRIBUTION_FIELDS = ['agent', 'task', 'tool', 'provider', 'model', 'role'] as const;

type TokenTotals = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };

export interface ReconcileGroup {
  provider: string;
  model: string;
  calls: number;
  ledger: TokenTotals & { costUsd: number | null };
  providerReported: TokenTotals & { costUsd: number | null };
  /** Largest relative difference across token kinds and cost, in percent. */
  maxDeltaPct: number;
}

export interface ReconcileReport {
  rows: number;
  providerReportedRows: number;
  /** Rows with no provider usage metadata (estimate only): cannot be reconciled. */
  estimatedRows: string[];
  unpricedRows: string[];
  /** Rows lacking one of ATTRIBUTION_FIELDS. */
  missingAttribution: Array<{ id: string; missing: string[] }>;
  groups: ReconcileGroup[];
  totals: { ledger: TokenTotals & { costUsd: number | null }; providerReported: TokenTotals & { costUsd: number | null }; maxDeltaPct: number };
  tolerancePct: number;
  ok: boolean;
}

const pct = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-12) * 100);
const zero = (): TokenTotals => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
const add = (t: TokenTotals, u: TokenTotals) => {
  t.inputTokens += u.inputTokens;
  t.cachedInputTokens += u.cachedInputTokens;
  t.outputTokens += u.outputTokens;
  t.reasoningTokens += u.reasoningTokens;
};
const maxDelta = (a: TokenTotals & { costUsd: number | null }, b: TokenTotals & { costUsd: number | null }) =>
  Math.max(pct(a.inputTokens, b.inputTokens), pct(a.cachedInputTokens, b.cachedInputTokens), pct(a.outputTokens, b.outputTokens), pct(a.reasoningTokens, b.reasoningTokens), a.costUsd !== null && b.costUsd !== null ? pct(a.costUsd, b.costUsd) : 0);

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

  /**
   * Reconciliation report (§29.6, FR-31): for every successful call, compares the ledger columns and
   * cost with usage re-derived from the stored raw provider metadata (provider-reported usage wins) and
   * checks attribution. `ok` = no attribution gaps, no estimate-only rows, every group within tolerance.
   */
  reconcile(opts: {
    task?: string; ws?: string; since?: string; tolerancePct?: number;
    normalizeUsage: (provider: string, raw: unknown) => Usage | undefined;
    pricing: (provider: string, model: string) => ModelManifest['pricing'] | undefined;
  }): ReconcileReport {
    const where = ["status = 'ok'"];
    const params: string[] = [];
    if (opts.task) (where.push('task = ?'), params.push(opts.task));
    if (opts.ws) (where.push('ws = ?'), params.push(opts.ws));
    if (opts.since) (where.push('at >= ?'), params.push(opts.since));
    const rows = this.db.all<{
      id: string; ws: string | null; task: string | null; agent: string | null; role: string | null; provider: string | null; model: string | null; tool_tokens_json: string | null;
      input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number; cost_usd: number | null; usage_source: string; provider_usage_json: string | null;
    }>(`SELECT * FROM ledger_entries WHERE ${where.join(' AND ')} ORDER BY at, id`, ...params);
    const tolerancePct = opts.tolerancePct ?? 1;
    const estimatedRows: string[] = [];
    const unpricedRows: string[] = [];
    const missingAttribution: ReconcileReport['missingAttribution'] = [];
    const groups = new Map<string, ReconcileGroup>();
    const totals: ReconcileReport['totals'] = { ledger: { ...zero(), costUsd: 0 }, providerReported: { ...zero(), costUsd: 0 }, maxDeltaPct: 0 };
    let providerReportedRows = 0;
    for (const r of rows) {
      const missing: string[] = [];
      for (const f of ATTRIBUTION_FIELDS) {
        const v = f === 'tool' ? r.tool_tokens_json : r[f];
        if (v === null || v === undefined || v === '') missing.push(f);
      }
      if (missing.length) missingAttribution.push({ id: r.id, missing });
      const raw = r.provider_usage_json ? JSON.parse(r.provider_usage_json) : undefined;
      const reported = r.usage_source === 'provider' && raw !== undefined ? opts.normalizeUsage(r.provider ?? '', raw) : undefined;
      if (!reported) {
        estimatedRows.push(r.id);
        continue;
      }
      providerReportedRows++;
      const key = `${r.provider}:${r.model}`;
      let g = groups.get(key);
      if (!g) {
        g = { provider: r.provider ?? '', model: r.model ?? '', calls: 0, ledger: { ...zero(), costUsd: 0 }, providerReported: { ...zero(), costUsd: 0 }, maxDeltaPct: 0 };
        groups.set(key, g);
      }
      const pricing = opts.pricing(g.provider, g.model);
      const ledgerTokens = { inputTokens: r.input_tokens, cachedInputTokens: r.cached_input_tokens, outputTokens: r.output_tokens, reasoningTokens: r.reasoning_tokens };
      const reportedCost = costOf(pricing, reported);
      g.calls++;
      add(g.ledger, ledgerTokens);
      add(g.providerReported, reported);
      g.ledger.costUsd = r.cost_usd === null || g.ledger.costUsd === null ? null : g.ledger.costUsd + r.cost_usd;
      g.providerReported.costUsd = reportedCost === null || g.providerReported.costUsd === null ? null : g.providerReported.costUsd + reportedCost;
      add(totals.ledger, ledgerTokens);
      add(totals.providerReported, reported);
      if (r.cost_usd === null || reportedCost === null) unpricedRows.push(r.id);
      totals.ledger.costUsd = r.cost_usd === null || totals.ledger.costUsd === null ? null : totals.ledger.costUsd + r.cost_usd;
      totals.providerReported.costUsd = reportedCost === null || totals.providerReported.costUsd === null ? null : totals.providerReported.costUsd + reportedCost;
    }
    for (const g of groups.values()) g.maxDeltaPct = maxDelta(g.ledger, g.providerReported);
    totals.maxDeltaPct = maxDelta(totals.ledger, totals.providerReported);
    const list = [...groups.values()];
    const ok = missingAttribution.length === 0 && estimatedRows.length === 0 && unpricedRows.length === 0 && totals.maxDeltaPct <= tolerancePct && list.every((g) => g.maxDeltaPct <= tolerancePct);
    return { rows: rows.length, providerReportedRows, estimatedRows, unpricedRows, missingAttribution, groups: list, totals, tolerancePct, ok };
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
