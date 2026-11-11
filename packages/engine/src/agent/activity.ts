import type { ActivityAgent, ActivityContextItem, ActivityStep, ActivityUsage, TaskActivity } from '@helix/protocol';
import { parseJson, type Db } from '../storage/db.ts';

export function taskActivity(db: Db, task: string, availableModels: string[] = []): TaskActivity {
  const emittedAt = Date.now();
  const row = db.get<{ title: string; provider: string; model: string; status: string; created_at: string; updated_at: string }>('SELECT title, provider, model, status, created_at, updated_at FROM tasks WHERE id = ?', task);
  if (!row) throw new Error(`unknown task ${task}`);
  const ledger = db.all<{ id: string; agent: string | null; step: string | null; provider: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number | null; context_breakdown_json: string | null; tool_tokens_json: string | null; status: string }>('SELECT * FROM ledger_entries WHERE task = ?', task);
  const usage = (entries: typeof ledger): ActivityUsage => ({
    inputTokens: entries.reduce((n, e) => n + e.input_tokens, 0),
    outputTokens: entries.reduce((n, e) => n + e.output_tokens, 0),
    costUsd: entries.some((e) => e.cost_usd === null) ? null : entries.reduce((n, e) => n + e.cost_usd!, 0),
  });
  const composedArt = db.get<{ data_json: string }>("SELECT data_json FROM artifacts WHERE task = ? AND kind = 'context' ORDER BY rowid DESC LIMIT 1", task);
  const composedItems = parseJson<{ items?: Array<{ kind: string; ref: string; tokens: number }> }>(composedArt?.data_json, {}).items ?? [];
  const forkArt = db.get<{ data_json: string }>("SELECT data_json FROM artifacts WHERE task = ? AND kind = 'fork' ORDER BY rowid DESC LIMIT 1", task);
  const forkData = forkArt ? parseJson<{ task: string; checkpoint: string } | null>(forkArt.data_json, null) : null;
  const forkedFrom = forkData ? { task: forkData.task, checkpoint: forkData.checkpoint } : null;
  const calls = db.all<{ id: string; step: string; call_id: string; tool: string; status: string; checkpoint: string; summary: string | null; duration_ms: number | null }>('SELECT * FROM tool_calls WHERE task = ? ORDER BY rowid', task);
  const messages = db.all<{ step: string; parts_json: string }>("SELECT step, parts_json FROM messages WHERE task = ? AND role = 'assistant'", task);
  const agents: ActivityAgent[] = db.all<{ id: string; kind: string; model_role: string; state: string; parent: string | null; parent_call: string | null; started_at: string | null; ended_at: string | null }>('SELECT * FROM agents WHERE task = ? ORDER BY rowid', task).map((a) => ({
    id: a.id, parent: a.parent, parentCall: a.parent_call, kind: a.kind, role: a.model_role, status: a.state,
    startedAt: a.started_at ?? row.created_at, endedAt: a.ended_at,
    usage: usage(ledger.filter((e) => e.agent === a.id)), steps: [],
  }));
  const terminal = ['done', 'failed', 'cancelled'].includes(row.status);
  agents.unshift({ id: 'primary', parent: null, parentCall: null, kind: 'primary', role: 'coder', status: row.status, startedAt: row.created_at, endedAt: terminal ? row.updated_at : null, usage: usage(ledger.filter((e) => e.agent === 'primary')), steps: [] });
  for (const s of db.all<{ id: string; agent: string; idx: number; kind: string; status: string; started_at: string; ended_at: string | null; ledger_entry: string | null; detail_json: string | null }>('SELECT * FROM steps WHERE task = ? ORDER BY rowid', task)) {
    const entries = ledger.filter((e) => e.step === s.id);
    const l = entries.find((e) => e.id === s.ledger_entry);
    const parts = parseJson<Array<{ type: string; text?: string; id?: string; name?: string }>>(messages.find((m) => m.step === s.id)?.parts_json, []);
    const context = parseJson<Record<string, number>>(l?.context_breakdown_json, {});
    const toolTokens = parseJson<Record<string, number>>(l?.tool_tokens_json, {});
    const contextItems: ActivityContextItem[] = l ? [
      ...(s.agent === 'primary' ? composedItems.map((item) => ({ kind: item.kind, label: item.ref, tokens: item.tokens })) : []),
      ...Object.entries(context).filter(([, n]) => n > 0).map(([label, tokens]) => ({ kind: 'prompt', label, tokens })),
      ...Object.entries(toolTokens).filter(([, n]) => n > 0).map(([label, tokens]) => ({ kind: 'tool_result', label, tokens })),
    ] : [];
    const step: ActivityStep = {
      id: s.id, index: s.idx, kind: s.kind, status: s.status, startedAt: s.started_at, endedAt: s.ended_at,
      model: l ? `${l.provider}/${l.model}` : null, usage: usage(entries), context, contextItems,
      text: parseJson<{ text?: string }>(s.detail_json, {}).text ?? parts.filter((p) => p.type === 'text').map((p) => p.text).join(''),
      tools: calls.filter((c) => c.step === s.id).map((c) => ({ id: c.id, callId: c.call_id, tool: c.tool, status: c.status, checkpoint: c.checkpoint, summary: c.summary, durationMs: c.duration_ms })),
    };
    for (const p of parts.filter((p) => p.type === 'tool_call')) if (!step.tools.some((c) => c.callId === p.id)) step.tools.push({ id: p.id!, callId: p.id!, tool: p.name!, status: 'pending', checkpoint: '', summary: null, durationMs: null });
    agents.find((a) => a.id === s.agent)?.steps.push(step);
  }
  const budget = db.get<{ soft_usd: number | null; hard_usd: number | null; soft_tokens: number | null; hard_tokens: number | null }>("SELECT * FROM budgets WHERE scope = 'task' AND scope_id = ?", task);
  const currentRef = `${row.provider}/${row.model}`;
  const models = availableModels.includes(currentRef) ? availableModels : [currentRef, ...availableModels];
  return {
    task, title: row.title, status: row.status, provider: row.provider, model: row.model, availableModels: models,
    startedAt: row.created_at, endedAt: terminal ? row.updated_at : null, forkedFrom, emittedAt, usage: usage(ledger), agents,
    budget: budget ? { softUsd: budget.soft_usd, hardUsd: budget.hard_usd, softTokens: budget.soft_tokens, hardTokens: budget.hard_tokens } : null,
    leases: db.all<{ id: string; holder: string; tool_call: string; globs_json: string; mode: string; state: string; expires_at: string; heartbeat: string }>('SELECT * FROM activity_leases WHERE task = ? ORDER BY rowid', task).map((l) => ({ id: l.id, holder: l.holder, toolCall: l.tool_call, globs: parseJson(l.globs_json, []), mode: l.mode, state: l.state, expiresAt: l.expires_at, heartbeat: l.heartbeat })),
    checkpoints: db.all<{ id: string; step: string | null; at: string; files_json: string }>('SELECT * FROM checkpoints WHERE task = ? ORDER BY rowid', task).map((c) => ({ id: c.id, step: c.step, at: c.at, files: parseJson<Array<{ path: string }>>(c.files_json, []).map((f) => f.path) })),
    approvals: db.all<{ id: string; tool: string; status: string }>('SELECT id, tool, status FROM approvals WHERE task = ? ORDER BY rowid', task),
  };
}
