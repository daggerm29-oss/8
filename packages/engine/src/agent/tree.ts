import type { Db } from '../storage/db.ts';

const ARGS_PREVIEW_CHARS = 2000;

export interface TreeToolCall {
  id: string; callId: string; tool: string; args: string; argsTruncated: boolean;
  status: string; summary: string | null; resultTokens: number | null; durationMs: number | null; cacheHit: boolean; at: string;
}
export interface TreeModelCall {
  id: string; role: string; provider: string; model: string; status: string; error: string | null;
  inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number | null; latencyMs: number | null;
}
export interface TreeStep {
  id: string; index: number; kind: string; status: string; startedAt: string; endedAt: string | null; durationMs: number | null;
  text: string; modelCalls: TreeModelCall[]; toolCalls: TreeToolCall[]; checkpoints: Array<{ id: string; files: string[]; at: string }>;
}
export interface TreeAgent { id: string; kind: string; role: string; state: string; steps: TreeStep[] }
export interface TaskTree { task: string; agents: TreeAgent[]; unattributedToolCalls: TreeToolCall[] }

type Part = { type: string; id?: string; text?: string };

/**
 * Agent → Step → (model calls, tool calls). Tool calls are linked to the step whose
 * assistant message issued them (by call id), so older tasks need no schema change.
 */
export function buildTaskTree(db: Db, task: string): TaskTree {
  const agentRows = db.all<{ id: string; kind: string; model_role: string; state: string }>('SELECT id, kind, model_role, state FROM agents WHERE task = ? ORDER BY rowid', task);
  const stepRows = db.all<{ id: string; agent: string; idx: number; kind: string; status: string; started_at: string; ended_at: string | null }>(
    'SELECT id, agent, idx, kind, status, started_at, ended_at FROM steps WHERE task = ? ORDER BY started_at, idx', task);
  const ledger = db.all<Record<string, unknown> & { step: string | null }>(
    `SELECT id, step, role, provider, model, status, error, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms
     FROM ledger_entries WHERE task = ? ORDER BY at`, task);
  const messages = db.all<{ step: string; parts_json: string }>(`SELECT step, parts_json FROM messages WHERE task = ? AND role = 'assistant' AND step IS NOT NULL ORDER BY id`, task);
  const toolRows = db.all<{ id: string; call_id: string; tool: string; args_json: string; status: string; summary: string | null; result_tokens: number | null; duration_ms: number | null; cache_hit: number; at: string }>(
    'SELECT id, call_id, tool, args_json, status, summary, result_tokens, duration_ms, cache_hit, at FROM tool_calls WHERE task = ? ORDER BY at, rowid', task);
  const checkpoints = db.all<{ id: string; step: string | null; files_json: string; at: string }>('SELECT id, step, files_json, at FROM checkpoints WHERE task = ? ORDER BY at', task);

  const steps = new Map<string, TreeStep>();
  for (const s of stepRows) {
    const end = s.ended_at ? Date.parse(s.ended_at) - Date.parse(s.started_at) : null;
    steps.set(s.id, { id: s.id, index: s.idx, kind: s.kind, status: s.status, startedAt: s.started_at, endedAt: s.ended_at, durationMs: end, text: '', modelCalls: [], toolCalls: [], checkpoints: [] });
  }
  for (const l of ledger) {
    const step = l.step ? steps.get(l.step) : undefined;
    if (!step) continue;
    step.modelCalls.push({
      id: String(l.id), role: String(l.role), provider: String(l.provider), model: String(l.model), status: String(l.status), error: (l.error as string | null) ?? null,
      inputTokens: Number(l.input_tokens), cachedInputTokens: Number(l.cached_input_tokens), outputTokens: Number(l.output_tokens), reasoningTokens: Number(l.reasoning_tokens),
      costUsd: (l.cost_usd as number | null) ?? null, latencyMs: (l.latency_ms as number | null) ?? null,
    });
  }
  const pendingByCallId = new Map<string, string[]>();
  for (const m of messages) {
    const step = steps.get(m.step);
    if (!step) continue;
    const parts = JSON.parse(m.parts_json) as Part[];
    step.text += parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
    for (const p of parts) {
      if (p.type !== 'tool_call' || !p.id) continue;
      const q = pendingByCallId.get(p.id) ?? [];
      q.push(step.id);
      pendingByCallId.set(p.id, q);
    }
  }
  const unattributed: TreeToolCall[] = [];
  for (const r of toolRows) {
    const tc: TreeToolCall = {
      id: r.id, callId: r.call_id, tool: r.tool, args: r.args_json.slice(0, ARGS_PREVIEW_CHARS), argsTruncated: r.args_json.length > ARGS_PREVIEW_CHARS,
      status: r.status, summary: r.summary, resultTokens: r.result_tokens, durationMs: r.duration_ms, cacheHit: Boolean(r.cache_hit), at: r.at,
    };
    const stepId = pendingByCallId.get(r.call_id)?.shift();
    const step = stepId ? steps.get(stepId) : undefined;
    if (step) step.toolCalls.push(tc);
    else unattributed.push(tc);
  }
  const ordered = [...steps.values()];
  for (const c of checkpoints) {
    const cp = { id: c.id, files: JSON.parse(c.files_json) as string[], at: c.at };
    const direct = c.step ? steps.get(c.step) : undefined;
    // Checkpoints are taken by write tools, after the step that issued them started.
    const owner = direct ?? ordered.filter((s) => s.startedAt <= c.at).at(-1);
    owner?.checkpoints.push(cp);
  }

  const agents: TreeAgent[] = agentRows.map((a) => ({ id: a.id, kind: a.kind, role: a.model_role, state: a.state, steps: [] }));
  for (const s of stepRows) {
    let agent = agents.find((a) => a.id === s.agent);
    if (!agent) {
      const role = steps.get(s.id)?.modelCalls[0]?.role ?? 'coder';
      agent = { id: s.agent, kind: s.agent, role, state: 'unknown', steps: [] };
      agents.push(agent);
    }
    agent.steps.push(steps.get(s.id)!);
  }
  return { task, agents: agents.filter((a) => a.steps.length), unattributedToolCalls: unattributed };
}
