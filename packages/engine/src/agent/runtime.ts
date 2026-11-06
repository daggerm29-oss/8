import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkspaceIndex } from '../index/index.ts';
import { loadInstructions } from '../context/instructions.ts';
import { assembleContext, type ComposedContext } from '../context/assembler.ts';
import { formatDiagnostics, parseDiagnostics } from '../diagnostics/parsers.ts';
import { ProviderError, type Message, type Part, type TaskCreateParams, type TaskStatus, type TaskSummary } from '@helix/protocol';
import type { Db } from '../storage/db.ts';
import { json, parseJson } from '../storage/db.ts';
import type { BlobStore } from '../storage/blobs.ts';
import type { EventBus } from '../events/bus.ts';
import type { ModelGateway } from '../models/gateway.ts';
import type { Ledger } from '../models/ledger.ts';
import type { Tracer } from '../obs/tracing.ts';
import type { Logger } from '../util/log.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { LocalSandbox } from '../sandbox/sandbox.ts';
import { evaluate, type PolicyProfile } from '../policy/policy.ts';
import { prefixedId } from '../util/ids.ts';
import { globalRedactor } from '../util/redact.ts';

export const MAX_VERIFY_ATTEMPTS = 3;
const TASK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const TERMINAL: TaskStatus[] = ['done', 'failed', 'cancelled'];

interface TaskRow {
  id: string; ws: string; title: string; goal: string; status: TaskStatus; provider: string; model: string; policy_profile: PolicyProfile;
  preapprove_json: string; verify_command: string | null; max_steps: number; step_count: number; verify_attempts: number;
  owner_engine: string | null; created_at: string; updated_at: string; result: string | null; error: string | null;
}

export interface RuntimeOptions {
  db: Db;
  bus: EventBus;
  gateway: ModelGateway;
  ledger: Ledger;
  tools: ToolRegistry;
  tracer: Tracer;
  engineId: string;
  blobs?: BlobStore;
  logger?: Logger;
  forceProcessSandbox?: boolean;
  /** Multiplier for task-level backoff delays (tests use a tiny value). */
  taskRetryScale?: number;
  /** Helix home, for user-level `HELIX.md` instructions (§13.5). */
  helixHome?: string;
  /** Build the code index + composed context at task start (default true). */
  indexing?: boolean;
  contextBudgetTokens?: number;
}

export interface CheckpointInfo {
  id: string;
  seq: number;
  at: string;
  files: Array<{ path: string; created: boolean }>;
}

const PLAN_TOOLS = ['read_file', 'list_dir', 'search', 'find_symbol', 'code_search', 'submit_plan'];

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function systemPrompt(root: string, verify: string | null, profile: PolicyProfile, context: string): string {
  const plan = profile === 'plan';
  return [
    'You are Helix, an autonomous coding agent working inside a sandboxed copy of a software repository.',
    `Workspace root: ${root}. All paths are relative to it. The sandbox has no network access.`,
    plan
      ? 'You are in PLAN MODE: you can only read. Investigate with find_symbol, code_search, read_file, list_dir, and search, then call submit_plan exactly once with a concrete, file-grounded plan. Do not attempt to edit files.'
      : 'Work methodically: locate code with find_symbol (definitions) and code_search (ranked slices) before falling back to search/list_dir, read only the ranges you need with read_file, make minimal targeted edits with edit_file, then run the tests with run_shell to confirm.',
    plan ? '' : 'Never weaken, skip, or delete tests to make them pass; fix the code under test.',
    verify && !plan ? `When you finish, Helix runs the verification command \`${verify}\`; the task only succeeds if it exits 0.` : '',
    'When the task is complete, reply with a short summary and do not call any more tools.',
    context ? `\n${context}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Task runtime (F-AGT-1, F-AGT-3/4 subset, §9.1–9.3, §30.1). The transcript in SQLite is the source of
 * truth: every model turn and every tool result is persisted before the next action, so the next action
 * is always derivable from the transcript alone. That is what makes `recover()` exact after an Engine
 * crash — interrupted tool calls are re-run, completed ones are never repeated, and a finished model
 * turn is never re-billed.
 */
export class TaskRuntime {
  private readonly o: RuntimeOptions;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly approvals = new Map<string, (approved: boolean) => void>();

  constructor(opts: RuntimeOptions) {
    this.o = opts;
  }

  private workspace(path: string): { id: string; path: string } {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`workspace path does not exist: ${path}`);
    const real = realpathSync(path);
    const row = this.o.db.get<{ id: string }>('SELECT id FROM workspace WHERE path = ?', real);
    if (row) return { id: row.id, path: real };
    const id = prefixedId('ws');
    this.o.db.run('INSERT INTO workspace (id, path, created_at) VALUES (?, ?, ?)', id, real, new Date().toISOString());
    return { id, path: real };
  }

  workspaceFor(path: string): { id: string; path: string } {
    return this.workspace(path);
  }

  private row(id: string): TaskRow {
    const r = this.o.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!r) throw new Error(`unknown task ${id}`);
    return r;
  }

  private wsPath(ws: string): string {
    return this.o.db.get<{ path: string }>('SELECT path FROM workspace WHERE id = ?', ws)!.path;
  }

  summary(id: string): TaskSummary & { ledger: ReturnType<Ledger['totals']>; verifyAttempts: number } {
    const r = this.row(id);
    return {
      id: r.id, workspaceId: r.ws, workspacePath: this.wsPath(r.ws), title: r.title, goal: r.goal, status: r.status, provider: r.provider, model: r.model,
      stepCount: r.step_count, createdAt: r.created_at, updatedAt: r.updated_at, result: r.result, error: r.error,
      verifyAttempts: r.verify_attempts, ledger: this.o.ledger.totals({ task: r.id }),
    };
  }

  list(limit = 50): TaskSummary[] {
    return this.o.db.all<{ id: string }>('SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?', limit).map((r) => this.summary(r.id));
  }

  transcript(id: string): Message[] {
    return this.o.db.all<{ role: Message['role']; parts_json: string; step: string | null }>('SELECT role, parts_json, step FROM messages WHERE task = ? ORDER BY id', id)
      .map((m) => ({ role: m.role, parts: parseJson<Part[]>(m.parts_json, []), meta: m.step ? { stepId: m.step } : undefined }));
  }

  create(p: TaskCreateParams): TaskSummary {
    if (!p.goal?.trim()) throw new Error('goal is required');
    const ws = this.workspace(p.workspacePath);
    const provider = p.provider ?? this.o.gateway.defaultProvider();
    const model = p.model ?? this.o.gateway.adapter(provider).defaultModel;
    const id = prefixedId('task');
    const now = new Date().toISOString();
    this.o.db.run(
      `INSERT INTO tasks (id, ws, title, goal, status, provider, model, policy_profile, preapprove_json, verify_command, max_steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ws.id, p.title ?? p.goal.slice(0, 80), p.goal, provider, model, p.policyProfile ?? 'headless', json(p.preapprove ?? []), p.verifyCommand ?? null, p.maxSteps ?? 40, now, now,
    );
    if (p.budgetUsd !== undefined) this.o.ledger.setBudget({ scope: 'task', scopeId: id, hardUsd: p.budgetUsd, softUsd: p.budgetUsd * 0.8 });
    this.addMessage(id, null, { role: 'user', parts: [{ type: 'text', text: p.goal }] });
    this.publish(id, ws.id, 'task.created', { title: p.title ?? p.goal.slice(0, 80), provider, model });
    if (p.start !== false) this.start(id);
    return this.summary(id);
  }

  private publish(task: string, ws: string, topic: string, data: unknown, persist: 'none' | 'log' | 'audit' = 'log'): void {
    this.o.bus.publish({ topic, ws, task, data, persist });
  }

  private addMessage(task: string, step: string | null, m: Message): void {
    const parts = m.parts.map((p) => (p.type === 'text' ? { ...p, text: globalRedactor.redact(p.text) } : p.type === 'tool_result' ? { ...p, content: globalRedactor.redact(p.content) } : p));
    this.o.db.run('INSERT INTO messages (task, step, role, parts_json, at) VALUES (?, ?, ?, ?, ?)', task, step, m.role, json(parts), new Date().toISOString());
  }

  private setStatus(id: string, status: TaskStatus, extra: { result?: string | null; error?: string | null } = {}): void {
    const r = this.row(id);
    this.o.db.run('UPDATE tasks SET status = ?, updated_at = ?, result = COALESCE(?, result), error = COALESCE(?, error), owner_engine = ? WHERE id = ?',
      status, new Date().toISOString(), extra.result ?? null, extra.error ?? null, TERMINAL.includes(status) ? null : this.o.engineId, id);
    this.publish(id, r.ws, 'task.status', { status, ...extra }, TERMINAL.includes(status) ? 'audit' : 'log');
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  start(id: string): void {
    if (this.running.has(id)) return;
    const r = this.row(id);
    if (TERMINAL.includes(r.status)) throw new Error(`task ${id} is ${r.status}`);
    const controller = new AbortController();
    const done = this.loop(id, controller.signal)
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        this.o.logger?.error('task failed', { task: id, error: error.message });
        this.setStatus(id, 'failed', { error: `${error.name}: ${error.message}` });
      })
      .finally(() => {
        this.running.delete(id);
        this.o.bus.flush();
      });
    this.running.set(id, { controller, done });
  }

  async wait(id: string, timeoutMs = 0): Promise<ReturnType<TaskRuntime['summary']>> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    while (Date.now() < deadline) {
      const run = this.running.get(id);
      if (run) {
        const remaining = deadline - Date.now();
        await (remaining === Infinity ? run.done : Promise.race([run.done, new Promise((r) => setTimeout(r, remaining))]));
      } else if (TERMINAL.includes(this.row(id).status)) break;
      else await new Promise((r) => setTimeout(r, 200));
      if (TERMINAL.includes(this.row(id).status)) break;
    }
    return this.summary(id);
  }

  async cancel(id: string): Promise<TaskSummary> {
    const run = this.running.get(id);
    if (run) {
      run.controller.abort();
      await run.done;
    }
    if (!TERMINAL.includes(this.row(id).status)) this.setStatus(id, 'cancelled');
    return this.summary(id);
  }

  approve(approvalId: string, approved: boolean, by = 'user'): void {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) throw new Error(`no pending approval ${approvalId}`);
    this.o.db.run('UPDATE approvals SET status = ?, decision_by = ? WHERE id = ?', approved ? 'approved' : 'denied', by, approvalId);
    this.approvals.delete(approvalId);
    resolve(approved);
  }

  /** Resume every non-terminal task not owned by a live engine (§30.1 crash recovery). */
  recover(): string[] {
    const rows = this.o.db.all<{ id: string; owner_engine: string | null }>(`SELECT id, owner_engine FROM tasks WHERE status IN ('planning','running','verifying','awaiting_approval')`);
    const resumed: string[] = [];
    for (const r of rows) {
      if (this.running.has(r.id)) continue;
      if (r.owner_engine && r.owner_engine !== this.o.engineId) {
        const owner = this.o.db.get<{ stopped_at: string | null; heartbeat_at: string; pid: number }>('SELECT stopped_at, heartbeat_at, pid FROM engine_instances WHERE id = ?', r.owner_engine);
        const alive = owner && !owner.stopped_at && Date.now() - Date.parse(owner.heartbeat_at) < 15_000 && pidAlive(owner.pid);
        if (alive) continue;
      }
      this.o.db.run(`UPDATE approvals SET status = 'expired' WHERE task = ? AND status = 'pending'`, r.id);
      this.publish(r.id, this.row(r.id).ws, 'task.resumed', { previousOwner: r.owner_engine }, 'audit');
      this.start(r.id);
      resumed.push(r.id);
    }
    return resumed;
  }

  async shutdown(): Promise<void> {
    const all = [...this.running.values()];
    for (const r of all) r.controller.abort();
    await Promise.allSettled(all.map((r) => r.done));
  }

  private pendingCalls(messages: Message[]): Array<Extract<Part, { type: 'tool_call' }>> {
    let i = messages.length - 1;
    const answered = new Set<string>();
    while (i >= 0 && messages[i].role === 'tool') {
      for (const p of messages[i].parts) if (p.type === 'tool_result') answered.add(p.callId);
      i--;
    }
    if (i < 0 || messages[i].role !== 'assistant') return [];
    return messages[i].parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call' && !answered.has(p.id));
  }

  /** Merge consecutive tool messages so each assistant turn is followed by exactly one tool turn. */
  private requestMessages(messages: Message[]): Message[] {
    const out: Message[] = [];
    for (const m of messages) {
      const prev = out[out.length - 1];
      if (m.role === 'tool' && prev?.role === 'tool') prev.parts = [...prev.parts, ...m.parts];
      else out.push({ role: m.role, parts: [...m.parts] });
    }
    return out;
  }

  private async loop(id: string, signal: AbortSignal): Promise<void> {
    const initial = this.row(id);
    const root = this.wsPath(initial.ws);
    const sandbox = new LocalSandbox(prefixedId('sbx'), root, { forceProcess: this.o.forceProcessSandbox });
    this.o.db.run('INSERT INTO sandboxes (id, provider, ws, owner_engine, state, created_at, labels_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sandbox.id, sandbox.provider, initial.ws, this.o.engineId, 'running', new Date().toISOString(), json({ task: id }));
    this.setStatus(id, 'running');
    const index = this.o.indexing === false ? undefined : new WorkspaceIndex(this.o.db, initial.ws, root);
    try {
      const context = this.composeContext(initial, root, index);
      while (!signal.aborted) {
        const t = this.row(id);
        const messages = this.transcript(id);
        const pending = this.pendingCalls(messages);
        const last = messages[messages.length - 1];
        if (pending.length) {
          await this.runTools(t, pending, sandbox, signal, index);
        } else if (last?.role === 'assistant') {
          if (await this.verify(t, last, sandbox, signal)) return;
        } else {
          if (t.step_count >= t.max_steps) {
            this.setStatus(id, 'failed', { error: `step limit reached (${t.max_steps})` });
            return;
          }
          await this.modelTurn(t, messages, root, signal, context);
        }
      }
    } finally {
      sandbox.destroy();
      this.o.db.run(`UPDATE sandboxes SET state = 'destroyed', destroyed_at = ? WHERE id = ?`, new Date().toISOString(), sandbox.id);
    }
  }

  /**
   * Compose the task's static context block once (F-CTX-1/F-CTX-3) and persist it as a `context` artifact,
   * so every turn — including turns after an Engine restart — sends a byte-identical prompt prefix.
   */
  private composeContext(t: TaskRow, root: string, index?: WorkspaceIndex): string {
    const existing = this.o.db.get<{ data_json: string }>(`SELECT data_json FROM artifacts WHERE task = ? AND kind = 'context'`, t.id);
    if (existing) return parseJson<ComposedContext>(existing.data_json, { text: '' } as ComposedContext).text;
    const started = performance.now();
    let stats;
    try {
      stats = index?.update();
    } catch (error) {
      this.o.logger?.warn('indexing failed; continuing without index', { task: t.id, error: (error as Error).message });
    }
    const instructions = loadInstructions(root, { helixHome: this.o.helixHome });
    const composed = assembleContext({ goal: t.goal, index: stats ? index : undefined, instructions, budgetTokens: this.o.contextBudgetTokens });
    this.saveArtifact(t.id, 'context', 'Composed context', composed);
    this.publish(t.id, t.ws, 'context.composed', {
      items: composed.items, usedTokens: composed.usedTokens, budgetTokens: composed.budgetTokens, warnings: composed.warnings,
      index: stats ? { ...stats, ...index!.counts() } : null, durationMs: Math.round(performance.now() - started),
    });
    return composed.text;
  }

  saveArtifact(task: string, kind: string, title: string, data: unknown): string {
    const id = prefixedId('art');
    this.o.db.run('INSERT INTO artifacts (id, task, kind, title, data_json, at) VALUES (?, ?, ?, ?, ?, ?)', id, task, kind, title, json(data), new Date().toISOString());
    return id;
  }

  artifacts(task: string, kind?: string): Array<{ id: string; kind: string; title: string; data: unknown; at: string }> {
    return this.o.db.all<{ id: string; kind: string; title: string; data_json: string; at: string }>(
      `SELECT id, kind, title, data_json, at FROM artifacts WHERE task = ? ${kind ? 'AND kind = ?' : ''} ORDER BY at, id`, ...(kind ? [task, kind] : [task]),
    ).map((r) => ({ id: r.id, kind: r.kind, title: r.title, data: parseJson(r.data_json, null), at: r.at }));
  }

  /** Shadow checkpoints for a task, oldest first (F-GIT-2, §20.3). */
  checkpoints(task: string): CheckpointInfo[] {
    return this.o.db.all<{ id: string; files_json: string; at: string }>('SELECT id, files_json, at FROM checkpoints WHERE task = ? ORDER BY rowid', task)
      .map((r, seq) => ({ id: r.id, seq, at: r.at, files: parseJson<Array<{ path: string; before: string | null }>>(r.files_json, []).map((f) => ({ path: f.path, created: f.before === null })) }));
  }

  /**
   * Restore the workspace to its state *before* checkpoint `target` (default: the first one, i.e. undo the
   * whole task). For each touched path the earliest pre-image at/after the target wins; files the agent
   * created are deleted. Writes are atomic (temp + rename) and the current content is saved first, so
   * a restore is itself undoable.
   */
  restore(task: string, target?: string): { restored: string[]; deleted: string[]; restoreId: string } {
    const r = this.row(task);
    if (this.running.has(task)) throw new Error(`task ${task} is running; cancel it before restoring`);
    const root = this.wsPath(r.ws);
    const all = this.o.db.all<{ id: string; files_json: string }>('SELECT id, files_json FROM checkpoints WHERE task = ? ORDER BY rowid', task);
    const from = target ? all.findIndex((c) => c.id === target) : 0;
    if (from < 0) throw new Error(`unknown checkpoint ${target}`);
    type Ref = Parameters<BlobStore['getText']>[0] | null;
    const preimage = new Map<string, Ref>();
    for (const c of all.slice(from)) for (const f of parseJson<Array<{ path: string; before: Ref }>>(c.files_json, [])) if (!preimage.has(f.path)) preimage.set(f.path, f.before);
    const restored: string[] = [];
    const deleted: string[] = [];
    const saved: Array<{ path: string; before: unknown }> = [];
    for (const [path, ref] of preimage) {
      const abs = join(root, path);
      if (!abs.startsWith(root + '/')) continue;
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      saved.push({ path, before: current === null ? null : this.o.blobs ? this.o.blobs.put(current, { kind: 'checkpoint', id: task }) : current });
      if (ref === null) {
        if (current !== null) { rmSync(abs, { force: true }); deleted.push(path); }
        continue;
      }
      const content = this.o.blobs ? this.o.blobs.getText(ref) : String(ref);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.helix-restore-${process.pid}`;
      writeFileSync(tmp, content);
      renameSync(tmp, abs);
      restored.push(path);
    }
    const restoreId = prefixedId('rst');
    this.o.db.run('INSERT INTO checkpoint_restores (id, task, target, files_json, at) VALUES (?, ?, ?, ?, ?)', restoreId, task, all[from]?.id ?? '', json(saved), new Date().toISOString());
    this.publish(task, r.ws, 'checkpoint.restored', { restoreId, target: all[from]?.id ?? null, restored, deleted }, 'audit');
    return { restored, deleted, restoreId };
  }

  private async modelTurn(t: TaskRow, messages: Message[], root: string, signal: AbortSignal, context = ''): Promise<void> {
    const stepId = prefixedId('step');
    const now = new Date().toISOString();
    this.o.db.run(`INSERT INTO steps (id, task, agent, idx, kind, status, started_at) VALUES (?, ?, 'primary', ?, 'model', 'running', ?)`, stepId, t.id, t.step_count, now);
    this.publish(t.id, t.ws, 'task.step', { stepId, index: t.step_count, kind: 'model' });
    const tools = this.o.tools.specs((name) => (t.policy_profile === 'plan' ? PLAN_TOOLS.includes(name) : name !== 'submit_plan'));
    const call = () => this.o.gateway.call({
      provider: t.provider, model: t.model, role: 'coder', ws: t.ws, task: t.id, agent: 'primary', step: stepId, signal,
      request: { system: systemPrompt(root, t.verify_command, t.policy_profile, context), messages: this.requestMessages(messages), tools, toolChoice: 'auto', maxOutputTokens: 8192 },
      onEvent: (e) => { if (e.type === 'text_delta') this.publish(t.id, t.ws, 'model.delta', { stepId, text: e.text }, 'none'); },
    });
    let result: Awaited<ReturnType<typeof call>>;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await call();
        break;
      } catch (error) {
        // The gateway already retried quickly; a sustained overload backs off at task level instead of failing the task.
        if (!(error instanceof ProviderError) || !error.retryable || attempt >= TASK_RETRY_DELAYS_MS.length || signal.aborted) {
          this.o.db.run(`UPDATE steps SET status = 'error', ended_at = ? WHERE id = ?`, new Date().toISOString(), stepId);
          throw error;
        }
        this.publish(t.id, t.ws, 'task.backoff', { stepId, kind: error.kind, delayMs: TASK_RETRY_DELAYS_MS[attempt] });
        await new Promise((r) => setTimeout(r, this.o.taskRetryScale === undefined ? TASK_RETRY_DELAYS_MS[attempt] : TASK_RETRY_DELAYS_MS[attempt] * this.o.taskRetryScale));
      }
    }
    this.o.db.transaction(() => {
      this.addMessage(t.id, stepId, result.message);
      this.o.db.run(`UPDATE steps SET status = 'done', ended_at = ?, ledger_entry = ? WHERE id = ?`, new Date().toISOString(), result.ledgerEntryId, stepId);
      this.o.db.run('UPDATE tasks SET step_count = step_count + 1, updated_at = ? WHERE id = ?', new Date().toISOString(), t.id);
    });
    const text = result.message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
    this.publish(t.id, t.ws, 'agent.message', { stepId, text, toolCalls: result.message.parts.filter((p) => p.type === 'tool_call').map((p) => (p as { name: string }).name), costUsd: result.costUsd });
  }

  private async runTools(t: TaskRow, calls: Array<Extract<Part, { type: 'tool_call' }>>, sandbox: LocalSandbox, signal: AbortSignal, index?: WorkspaceIndex): Promise<void> {
    const preapprove = parseJson<string[]>(t.preapprove_json, []);
    for (const call of calls) {
      if (signal.aborted) return;
      const decision = evaluate({ tool: call.name, args: call.args, profile: t.policy_profile, preapprove, sandboxHasNetwork: sandbox.info().network });
      let allowed = decision.verdict === 'allow';
      if (decision.verdict === 'ask') allowed = await this.ask(t, call, decision.actionClass, signal);
      const started = performance.now();
      const out = allowed
        ? await this.o.tracer.withSpan('tool.call', { tool: call.name, 'task.id': t.id, action_class: decision.actionClass }, () =>
            this.o.tools.run(call.name, call.args, {
              sandbox, signal, index,
              beforeWrite: (abs, prev) => this.checkpoint(t, sandbox, abs, prev),
              submitArtifact: t.policy_profile === 'plan' ? (kind, title, data) => {
                const artId = this.saveArtifact(t.id, kind, title, data);
                this.publish(t.id, t.ws, 'artifact.created', { artifactId: artId, kind, title });
                return artId;
              } : undefined,
            }))
        : { content: `denied by policy: ${decision.reason}`, isError: true, summary: `denied ${call.name}` };
      if (signal.aborted) return;
      const durationMs = Math.round(performance.now() - started);
      this.o.db.transaction(() => {
        this.o.db.run('INSERT INTO tool_calls (id, task, step, call_id, tool, args_json, status, summary, result_tokens, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          prefixedId('tc'), t.id, 'tools', call.id, call.name, json(call.args), allowed ? (out.isError ? 'error' : 'ok') : 'denied', out.summary ?? null, Math.ceil(out.content.length / 4), durationMs, new Date().toISOString());
        this.addMessage(t.id, null, { role: 'tool', parts: [{ type: 'tool_result', callId: call.id, name: call.name, content: out.content, isError: out.isError, provenance: { source: 'builtin', trust: 'trusted', taint: false } }] });
      });
      this.publish(t.id, t.ws, 'tool.result', { tool: call.name, callId: call.id, actionClass: decision.actionClass, verdict: allowed ? 'allow' : 'deny', isError: Boolean(out.isError), summary: out.summary, durationMs }, allowed ? 'log' : 'audit');
    }
  }

  private checkpoint(t: TaskRow, sandbox: LocalSandbox, abs: string, previous: string | null): void {
    const ref = previous === null ? null : this.o.blobs ? this.o.blobs.put(previous, { kind: 'checkpoint', id: t.id }) : previous;
    this.o.db.run('INSERT INTO checkpoints (id, task, step, files_json, at) VALUES (?, ?, ?, ?, ?)', prefixedId('ckpt'), t.id, null, json([{ path: sandbox.relative(abs), before: ref }]), new Date().toISOString());
  }

  private ask(t: TaskRow, call: Extract<Part, { type: 'tool_call' }>, actionClass: string, signal: AbortSignal): Promise<boolean> {
    const approvalId = prefixedId('appr');
    this.o.db.run(`INSERT INTO approvals (id, task, tool, args_json, action_class, status, at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, approvalId, t.id, call.name, json(call.args), actionClass, new Date().toISOString());
    this.setStatus(t.id, 'awaiting_approval');
    this.publish(t.id, t.ws, 'approval.requested', { approvalId, tool: call.name, args: call.args, actionClass }, 'audit');
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) this.setStatus(t.id, 'running');
        resolve(v);
      };
      const onAbort = () => {
        this.approvals.delete(approvalId);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvals.set(approvalId, done);
    });
  }

  /** Verification gate (§9.6 subset). Returns true when the task reached a terminal state. */
  private async verify(t: TaskRow, last: Message, sandbox: LocalSandbox, signal: AbortSignal): Promise<boolean> {
    const finalText = last.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('').trim();
    if (t.policy_profile === 'plan') {
      const plan = this.artifacts(t.id, 'plan').at(-1);
      if (plan) {
        this.setStatus(t.id, 'done', { result: finalText || `plan ${plan.id}` });
        return true;
      }
      const nudges = this.transcript(t.id).filter((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('[plan-mode]'))).length;
      if (nudges >= 2) {
        this.setStatus(t.id, 'failed', { error: 'plan mode finished without calling submit_plan' });
        return true;
      }
      this.addMessage(t.id, null, { role: 'user', parts: [{ type: 'text', text: '[plan-mode] You have not submitted a plan. Call submit_plan now with the plan grounded in the files you inspected.' }] });
      return false;
    }
    if (!t.verify_command) {
      this.setStatus(t.id, 'done', { result: finalText || '(no summary)' });
      return true;
    }
    this.setStatus(t.id, 'verifying');
    const r = await sandbox.exec(t.verify_command, { timeoutMs: 300_000, signal });
    if (signal.aborted) return true;
    const attempt = t.verify_attempts + 1;
    this.o.db.run('UPDATE tasks SET verify_attempts = ? WHERE id = ?', attempt, t.id);
    const output = `${r.stdout}\n${r.stderr}`;
    const diagnostics = r.exitCode === 0 ? [] : parseDiagnostics(t.verify_command, output, { root: sandbox.root });
    this.publish(t.id, t.ws, 'verify.result', { command: t.verify_command, exitCode: r.exitCode, attempt, passed: r.exitCode === 0, diagnostics }, 'audit');
    if (r.exitCode === 0) {
      this.setStatus(t.id, 'done', { result: finalText || 'verification passed' });
      return true;
    }
    if (attempt >= MAX_VERIFY_ATTEMPTS) {
      this.setStatus(t.id, 'failed', { error: `verification failed ${attempt} times: \`${t.verify_command}\` exit ${r.exitCode}` });
      return true;
    }
    // §9.5: structured diagnostics plus a short log tail, never the full log.
    const tail = output.trim().split('\n').slice(-40).join('\n').slice(-2500);
    const body = diagnostics.length ? `Diagnostics (${diagnostics.length}):\n${formatDiagnostics(diagnostics)}\n\nLog tail:\n${tail}` : output.trim().slice(-6000);
    this.addMessage(t.id, null, { role: 'user', parts: [{ type: 'text', text: `Verification failed (attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}): \`${t.verify_command}\` exited with ${r.exitCode ?? r.signal}.\n\n${body}\n\nFix the remaining problems, then finish with a summary.` }] });
    this.setStatus(t.id, 'running');
    return false;
  }
}
