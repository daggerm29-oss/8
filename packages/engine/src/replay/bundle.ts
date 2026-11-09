import {
  ProviderError,
  emptyUsage,
  type Message,
  type ModelManifest,
  type ModelRequest,
  type Part,
  type ProviderAdapter,
  type StreamEvent,
  type TokenCount,
  type Usage,
} from '@helix/protocol';
import type { Db } from '../storage/db.ts';
import { parseJson } from '../storage/db.ts';
import { globalRedactor } from '../util/redact.ts';

/**
 * Session replay (F-OBS-2, §26.4). A session bundle records every primary model turn (IR message,
 * role, ref, router reason, usage) and every tool call (normalized args, status, result) of a task,
 * in order. Modes: *inspect* = the bundle's timeline; *deterministic replay* = re-run the task loop
 * with model turns served by `ReplayAdapter` and tool results served from the recording (no network,
 * no tool side effects), stopping at the first divergence.
 */

export interface BundleModelTurn { index: number; role: string | null; ref: string | null; routerReason: string | null; usage: Pick<Usage, 'inputTokens' | 'outputTokens'> | null; message: Message }
export interface BundleToolCall { index: number; callId: string; tool: string; args: unknown; status: string; content: string; isError: boolean; provenance?: Extract<Part, { type: 'tool_result' }>['provenance'] }
export type TimelineEntry = { kind: 'model'; index: number; text: string; toolCalls: string[] } | { kind: 'tool'; index: number; tool: string; status: string };

export interface SessionBundle {
  version: 1;
  task: { id: string; goal: string; workspacePath: string; policyProfile: string; preapprove: string[]; status: string; result: string | null };
  models: BundleModelTurn[];
  tools: BundleToolCall[];
  timeline: TimelineEntry[];
}

/** Deterministic key order so recorded and replayed args compare by value. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function exportBundle(db: Db, taskId: string): SessionBundle {
  const t = db.get<{ id: string; goal: string; ws: string; policy_profile: string; preapprove_json: string; status: string; result: string | null }>('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) throw new Error(`unknown task ${taskId}`);
  const ws = db.get<{ path: string }>('SELECT path FROM workspace WHERE id = ?', t.ws)!.path;
  const rows = db.all<{ step: string | null; role: string; parts_json: string }>('SELECT step, role, parts_json FROM messages WHERE task = ? ORDER BY id', taskId);
  const status = new Map(db.all<{ call_id: string; status: string }>('SELECT call_id, status FROM tool_calls WHERE task = ?', taskId).map((r) => [r.call_id, r.status]));
  const models: BundleModelTurn[] = [];
  const tools: BundleToolCall[] = [];
  const timeline: TimelineEntry[] = [];
  const argsById = new Map<string, unknown>();
  for (const r of rows) {
    const parts = parseJson<Part[]>(r.parts_json, []);
    if (r.role === 'assistant' && r.step) {
      const led = db.get<{ role: string; provider: string; model: string; router_reason: string | null; input_tokens: number; output_tokens: number }>(
        'SELECT l.role, l.provider, l.model, l.router_reason, l.input_tokens, l.output_tokens FROM steps s JOIN ledger_entries l ON l.id = s.ledger_entry WHERE s.id = ?', r.step);
      const calls = parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      for (const c of calls) argsById.set(c.id, c.args);
      const index = models.length;
      models.push({
        index, role: led?.role ?? null, ref: led ? `${led.provider}/${led.model}` : null, routerReason: led?.router_reason ?? null,
        usage: led ? { inputTokens: led.input_tokens, outputTokens: led.output_tokens } : null, message: { role: 'assistant', parts },
      });
      timeline.push({ kind: 'model', index, text: parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('').slice(0, 300), toolCalls: calls.map((c) => c.name) });
    } else if (r.role === 'tool') {
      for (const p of parts) {
        if (p.type !== 'tool_result') continue;
        const index = tools.length;
        const st = status.get(p.callId) ?? (p.isError ? 'error' : 'ok');
        tools.push({ index, callId: p.callId, tool: p.name, args: argsById.get(p.callId) ?? null, status: st, content: p.content, isError: !!p.isError, ...(p.provenance ? { provenance: p.provenance } : {}) });
        timeline.push({ kind: 'tool', index, tool: p.name, status: st });
      }
    }
  }
  const bundle: SessionBundle = {
    version: 1,
    task: { id: t.id, goal: t.goal, workspacePath: ws, policyProfile: t.policy_profile, preapprove: parseJson<string[]>(t.preapprove_json, []), status: t.status, result: t.result },
    models, tools, timeline,
  };
  // Secrets are excluded by construction: every string passes the output redactor (known values + patterns).
  return JSON.parse(globalRedactor.redact(JSON.stringify(bundle))) as SessionBundle;
}

/** Serves recorded tool results in order; throws a divergence error on the first mismatch. */
export class ToolScript {
  private i = 0;
  served: Array<{ tool: string; status: string }> = [];
  private readonly recorded: BundleToolCall[];
  constructor(recorded: BundleToolCall[]) {
    this.recorded = recorded;
  }

  next(call: { name: string; args: unknown }, replayStatus: 'allowed' | 'denied'): Pick<BundleToolCall, 'content' | 'isError' | 'provenance'> & { summary: string } {
    const rec = this.recorded[this.i];
    const n = this.i + 1;
    if (!rec) throw new ReplayDivergence(`tool call ${n}: ${call.name} was called but the recording has only ${this.recorded.length} tool calls`);
    if (rec.tool !== call.name || canonical(rec.args) !== canonical(call.args)) {
      throw new ReplayDivergence(`tool call ${n}: expected ${rec.tool} ${canonical(rec.args)}, got ${call.name} ${canonical(call.args)}`);
    }
    if ((rec.status === 'denied') !== (replayStatus === 'denied')) {
      throw new ReplayDivergence(`tool call ${n}: ${call.name} was ${rec.status} in the recording but is ${replayStatus} now`);
    }
    this.i++;
    this.served.push({ tool: rec.tool, status: rec.status });
    return { content: rec.content, isError: rec.isError, provenance: rec.provenance, summary: `replayed ${rec.tool}` };
  }

  /** Recorded status of the next tool call (used to answer approvals during an interactive replay). */
  recordedStatus(): string | undefined { return this.recorded[this.i]?.status; }

  get remaining(): number { return this.recorded.length - this.i; }
}

export class ReplayDivergence extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDivergence';
  }
}

/** Provider that answers primary-agent turns from a recording, keyed by model id (one key per replay). */
export class ReplayAdapter implements ProviderAdapter {
  readonly id = 'replay';
  readonly defaultModel = 'replay';
  private readonly scripts = new Map<string, { turns: BundleModelTurn[]; i: number }>();

  load(key: string, turns: BundleModelTurn[]): void { this.scripts.set(key, { turns, i: 0 }); }
  served(key: string): number { return this.scripts.get(key)?.i ?? 0; }
  unload(key: string): void { this.scripts.delete(key); }

  bundledModels(): ModelManifest[] { return []; }
  async listModels(): Promise<ModelManifest[]> { return []; }
  async countTokens(): Promise<TokenCount> { return { inputTokens: 0, exact: false }; }
  normalizeError(error: unknown): ProviderError {
    return error instanceof ProviderError ? error : new ProviderError('replay', 'invalid_request', (error as Error)?.message ?? String(error));
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const s = this.scripts.get(req.model);
    if (!s) throw new ProviderError('replay', 'invalid_request', `no recording loaded for ${req.model}`);
    if (!req.tools?.length || req.toolChoice === 'none') throw new ProviderError('replay', 'invalid_request', 'replay serves recorded primary-agent turns only');
    const turn = s.turns[s.i];
    if (!turn) throw new ProviderError('replay', 'invalid_request', `replay diverged: model turn ${s.i + 1} requested but the recording has only ${s.turns.length}`);
    s.i++;
    const usage = { ...emptyUsage('provider'), inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 };
    const finishReason = turn.message.parts.some((p) => p.type === 'tool_call') ? 'tool_calls' : 'stop';
    yield { type: 'done', message: turn.message, usage, finishReason } as StreamEvent;
  }
}
