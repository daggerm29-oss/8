import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadTaskFile } from './task-file.ts';
import { Methods, Notifications, PROTOCOL_VERSION, RpcPeer, streamTransport, type HelixEvent, type TaskSummary } from '@helix/protocol';

const USAGE = `helix — Helix coding agent CLI (M1)

Usage:
  helix -p "<goal>" [options]     run a task headlessly and exit when it finishes
  helix run <task.yaml> [options] run a YAML task headlessly (CLI flags override file values)
                                 exit: 0 success, 1 engine error, 2 gate failure/usage, 3 budget stop
  helix tasks                     list recent tasks
  helix resume <task-id>          resume an interrupted task and wait for it
  helix ledger <task-id>          show token/cost ledger totals for a task
  helix checkpoints <task-id>     list shadow checkpoints written by a task
  helix restore <task-id> [cp]    undo a task's edits (from checkpoint cp onward; default: all)
  helix plan <task-id>            print the plan artifact of a Plan Mode task
  helix search "<query>"          hybrid code search over the workspace index
  helix symbols <name>            find symbol definitions in the workspace index
  helix impact <symbol|file>      callers, affected files and covering tests (code graph)
  helix mcp list                  MCP servers, connection state and tools
  helix mcp add <name> -- <cmd> [args...]   add a stdio MCP server to $HELIX_HOME/mcp.json
  helix mcp add <name> --url <url> [--header K=V]   add a streamable HTTP MCP server
  helix mcp remove <name>         remove an MCP server from mcp.json
  helix mcp trust <name> <trusted|untrusted>   change an MCP server's trust (reconnects it)
  helix audit verify              verify the audit hash chain (exit 1 and the first broken row if tampered)
  helix audit export [--category <c>]   print the audit log as JSONL (§26.5 record shape)
  helix trace <task-id>           print a task's span tree (tokens, latency, tool I/O refs)

Options:
  -C, --cwd <dir>         workspace directory (default: current directory)
  --verify <command>      verification command (or "auto" to infer gates; .helix/verify.json is used when omitted)
  --provider <id>         gemini | openai (default: first configured provider)
  -m, --model <id>        model id (default: provider default)
  --role <r=p/m[,fb...]>  bind a model role, e.g. summarizer=gemini/gemini-3.5-flash-lite or coder=gemini/a,openai/b; repeatable
                          (roles: planner coder explorer reviewer debugger summarizer embedder completion router;
                          also $HELIX_HOME/models.json, .helix/models.json, org policy $HELIX_HOME/policy.json)
  --max-steps <n>         model turn limit (default 40)
  --budget <usd>          hard USD budget for the task
  --allow <class>         preapprove an action class in headless mode (network, destructive) or tool:<name>; repeatable
  --trusted               (mcp add) trust the server's readOnlyHint annotations
  --plan                  Plan Mode: read-only investigation that produces a plan artifact
  --json                  print the final task summary as JSON
  -q, --quiet             do not stream progress to stderr
`;

/** `--role role=provider/model[,fallback...]` → task roles override (validated by the Engine). */
function roleFlags(flags: string[]): Record<string, { primary: string; fallbacks: string[] }> | undefined {
  if (!flags.length) return undefined;
  const out: Record<string, { primary: string; fallbacks: string[] }> = {};
  for (const f of flags) {
    const eq = f.indexOf('=');
    const [primary, ...fallbacks] = (eq > 0 ? f.slice(eq + 1) : '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!primary) throw new Error(`--role expects role=provider/model, got '${f}'`);
    out[f.slice(0, eq).trim()] = { primary, fallbacks };
  }
  return out;
}

function enginePath(): string {
  return fileURLToPath(new URL('./main.ts', import.meta.resolve('@helix/engine')));
}

/** Spawn a private Engine over stdio (§5.7: the CLI is a thin JSON-RPC client). */
async function connect(topics: string[]): Promise<{ peer: RpcPeer; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', enginePath(), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const peer = new RpcPeer(streamTransport(child.stdout!, child.stdin!));
  await peer.request(Methods.initialize, { clientName: 'helix-cli', clientVersion: '0.1.0', protocolVersion: PROTOCOL_VERSION, topics }, 30_000);
  const stop = async () => {
    child.stdin!.end();
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));
  };
  return { peer, stop };
}

function render(e: HelixEvent): string | null {
  const d = e.data as Record<string, any>;
  switch (e.topic) {
    case 'task.status': return `● ${d.status}${d.error ? ` — ${d.error}` : ''}`;
    case 'task.resumed': return '↻ resumed after engine restart';
    case 'agent.message': return `${d.text ? `◆ ${String(d.text).trim().slice(0, 400)}` : ''}${d.toolCalls?.length ? `${d.text ? '\n' : ''}  → ${d.toolCalls.join(', ')}` : ''}` || null;
    case 'tool.result': return `  ${d.verdict === 'deny' ? '✗ denied' : d.isError ? '!' : '✓'} ${d.summary ?? d.tool}`;
    case 'verify.gate': return `  gate ${d.gate} (${d.kind}${d.required ? '' : ', optional'}): ${d.passed ? 'passed' : `failed (exit ${d.exitCode})`} in ${d.durationMs} ms`;
    case 'verify.result': return `  verify #${d.attempt}: ${d.passed ? 'passed' : `failed (exit ${d.exitCode})${d.diagnostics?.length ? ` · ${d.diagnostics.length} diagnostics: ${d.diagnostics.slice(0, 3).map((x: any) => `${x.file ?? '?'}:${x.line ?? '?'} ${x.message}`.slice(0, 120)).join(' | ')}` : ''}`}`;
    case 'model.fallback': return `  ⇢ ${d.role}: ${d.from} failed (${d.kind}), falling back to ${d.to}`;
    case 'context.compacted': return `  ⌁ compacted messages ${d.from}–${d.upTo - 1} (${d.source}): ${d.tokensBefore} → ${d.tokensAfter} tokens${d.error ? ` · ${d.error}` : ''}`;
    case 'context.composed': return `  ⌁ context: ${d.items?.length ?? 0} items, ${d.usedTokens}/${d.budgetTokens} tokens${d.index ? ` · index ${d.index.files} files/${d.index.symbols} symbols (${d.index.indexed} reindexed)` : ''}`;
    case 'artifact.created': return `  ▣ ${d.kind} artifact ${d.artifactId}`;
    case 'approval.requested': return `  ? approval needed for ${d.tool} (${d.actionClass})`;
    case 'git.push': return `  ⇡ git push ${d.decision}: ${d.target}`;
    case 'deploy.requested': return `  ⇡ deploy ${d.decision}: ${d.target}`;
    default: return null;
  }
}

/**
 * Events can arrive before `task.create` returns the id (ISSUE-006, e.g. `context.composed`), so the
 * listener is installed right after connecting and buffers until `follow(id)` names the task.
 */
function eventFollower(peer: RpcPeer) {
  let taskId: string | null = null;
  let buffered: HelixEvent[] = [];
  const print = (e: HelixEvent) => {
    const line = render(e);
    if (line) process.stderr.write(`${line}\n`);
  };
  peer.onNotification(Notifications.event, (params) => {
    const e = params as HelixEvent;
    if (taskId === null) { if (buffered.length < 1000) buffered.push(e); return; }
    if (e.task === taskId) print(e);
  });
  return {
    follow(id: string) {
      taskId = id;
      for (const e of buffered) if (e.task === id) print(e);
      buffered = [];
    },
  };
}

async function runAndWait(peer: RpcPeer, summary: TaskSummary, opts: { quiet: boolean; json: boolean }, follower?: ReturnType<typeof eventFollower>): Promise<number> {
  if (!opts.quiet) {
    process.stderr.write(`helix task ${summary.id} · ${summary.provider}/${summary.model} · ${summary.workspacePath}\n`);
    (follower ?? eventFollower(peer)).follow(summary.id);
  }
  const final = await peer.request<TaskSummary & { ledger: { calls: number; inputTokens: number; outputTokens: number; costUsd: number } }>(Methods.taskWait, { id: summary.id });
  if (opts.json) process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
  else {
    process.stdout.write(`${final.status === 'done' ? final.result : `Task ${final.status}: ${final.error ?? ''}`}\n`);
    if (!opts.quiet) process.stderr.write(`— ${final.status} · ${final.stepCount} steps · ${final.ledger.calls} model calls · ${final.ledger.inputTokens} in / ${final.ledger.outputTokens} out tokens · $${final.ledger.costUsd.toFixed(4)}\n`);
  }
  if (final.status === 'done') return 0;
  if (/BudgetExceededError:/.test(final.error ?? '')) return 3;
  if (/^verification failed \d+ times:/.test(final.error ?? '')) return 2;
  return 1;
}

async function printPlan(peer: RpcPeer, task: string): Promise<boolean> {
  const arts = await peer.request<Array<{ id: string; data: any }>>(Methods.artifactList, { task, kind: 'plan' });
  const plan = arts.at(-1)?.data;
  if (!plan) {
    process.stderr.write('no plan artifact for this task\n');
    return false;
  }
  const lines = [`Plan: ${plan.goal}`, '', 'Affected files:', ...plan.affectedFiles.map((f: any) => `  - ${f.path} — ${f.reason}${f.evidence ? ` [${f.evidence}]` : ''}`), '', 'Steps:',
    ...plan.steps.map((s: any) => `  ${s.id}. ${s.description}${s.writeSet?.length ? ` (writes ${s.writeSet.join(', ')})` : ''}${s.dependsOn?.length ? ` after ${s.dependsOn.join(', ')}` : ''}`),
    '', 'Verification:', ...plan.verification.map((v: string) => `  - ${v}`)];
  if (plan.risks?.length) lines.push('', 'Risks:', ...plan.risks.map((r: string) => `  - ${r}`));
  if (plan.openQuestions?.length) lines.push('', 'Open questions:', ...plan.openQuestions.map((q: string) => `  - ${q}`));
  process.stdout.write(`${lines.join('\n')}\n`);
  return true;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      prompt: { type: 'string', short: 'p' }, cwd: { type: 'string', short: 'C' }, verify: { type: 'string' }, provider: { type: 'string' },
      model: { type: 'string', short: 'm' }, 'max-steps': { type: 'string' }, budget: { type: 'string' }, allow: { type: 'string', multiple: true },
      json: { type: 'boolean' }, plan: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
      url: { type: 'string' }, header: { type: 'string', multiple: true }, trusted: { type: 'boolean' }, role: { type: 'string', multiple: true }, category: { type: 'string' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || (!values.prompt && !cmd)) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  if (cmd === 'mcp' && (arg === 'add' || arg === 'remove' || arg === 'trust')) return mcpEdit(arg, positionals.slice(2), values);
  if (cmd === 'run' && (!arg || positionals.length !== 2 || values.prompt)) throw new Error('usage: helix run <task.yaml> [options]');
  const fileTask = cmd === 'run' ? loadTaskFile(arg) : undefined;
  for (const key of ['max-steps', 'budget'] as const) {
    if (values[key] !== undefined && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0 || (key === 'max-steps' && (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) === 0)))) throw new Error(`invalid --${key}`);
  }
  const opts = { quiet: Boolean(values.quiet), json: Boolean(values.json) };
  const { peer, stop } = await connect(opts.quiet ? [] : ['task.*', 'agent.*', 'tool.*', 'verify.*', 'approval.*', 'context.*', 'artifact.*', 'model.fallback']);
  const follower = opts.quiet ? undefined : eventFollower(peer);
  try {
    if (values.prompt || fileTask) {
      const summary = await peer.request<TaskSummary>(Methods.taskCreate, {
        ...fileTask,
        workspacePath: values.cwd ? resolve(values.cwd) : fileTask?.workspacePath ?? process.cwd(), goal: values.prompt ?? fileTask!.goal,
        verifyCommand: values.verify ?? fileTask?.verifyCommand, provider: values.provider ?? fileTask?.provider, model: values.model ?? fileTask?.model,
        maxSteps: values['max-steps'] !== undefined ? Number(values['max-steps']) : fileTask?.maxSteps, budgetUsd: values.budget !== undefined ? Number(values.budget) : fileTask?.budgetUsd,
        policyProfile: values.plan ? 'plan' : fileTask?.policyProfile ?? 'headless', preapprove: values.allow ?? fileTask?.preapprove ?? [], roles: roleFlags(values.role ?? []) ?? fileTask?.roles,
      });
      const code = await runAndWait(peer, summary, opts, follower);
      if (values.plan && !opts.json) await printPlan(peer, summary.id);
      return code;
    }
    if (cmd === 'tasks') {
      const list = await peer.request<TaskSummary[]>(Methods.taskList, { limit: 20 });
      for (const t of list) process.stdout.write(`${t.id}  ${t.status.padEnd(10)} ${t.updatedAt}  ${t.title}\n`);
      return 0;
    }
    if (cmd === 'resume' && arg) {
      const summary = await peer.request<TaskSummary>(Methods.taskGet, { id: arg });
      if (!['done', 'failed', 'cancelled'].includes(summary.status)) await peer.request(Methods.taskResume, { id: arg });
      return await runAndWait(peer, summary, opts, follower);
    }
    if (cmd === 'ledger' && arg) {
      process.stdout.write(`${JSON.stringify(await peer.request(Methods.ledgerQuery, { task: arg }), null, 2)}\n`);
      return 0;
    }
    const ws = resolve(values.cwd ?? process.cwd());
    if (cmd === 'checkpoints' && arg) {
      for (const c of await peer.request<Array<{ id: string; seq: number; at: string; files: Array<{ path: string; created: boolean }> }>>(Methods.checkpointList, { task: arg }))
        process.stdout.write(`${String(c.seq).padStart(3)}  ${c.id}  ${c.at}  ${c.files.map((f) => `${f.created ? '+' : '~'}${f.path}`).join(' ')}\n`);
      return 0;
    }
    if (cmd === 'restore' && arg) {
      const r = await peer.request<{ restored: string[]; deleted: string[]; restoreId: string }>(Methods.checkpointRestore, { task: arg, checkpoint: positionals[2] });
      process.stdout.write(`${r.restoreId}: restored ${r.restored.length} file(s)${r.restored.length ? ` (${r.restored.join(', ')})` : ''}, deleted ${r.deleted.length}${r.deleted.length ? ` (${r.deleted.join(', ')})` : ''}\n`);
      return 0;
    }
    if (cmd === 'plan' && arg) return (await printPlan(peer, arg)) ? 0 : 1;
    if (cmd === 'search' && arg) {
      for (const h of await peer.request<Array<{ path: string; startLine: number; endLine: number; symbol: string | null; why: string[]; score: number }>>(Methods.indexSearch, { workspacePath: ws, query: arg, limit: 10 }))
        process.stdout.write(`${h.path}:${h.startLine}-${h.endLine}${h.symbol ? `  ${h.symbol}` : ''}  [${h.why.join('+')}] ${h.score}\n`);
      return 0;
    }
    if (cmd === 'symbols' && arg) {
      for (const s of await peer.request<Array<{ path: string; line: number; kind: string; qualifiedName: string; signature: string }>>(Methods.indexSymbols, { workspacePath: ws, name: arg }))
        process.stdout.write(`${s.path}:${s.line}  ${s.kind} ${s.qualifiedName}  — ${s.signature}\n`);
      return 0;
    }
    if (cmd === 'impact' && arg) {
      const r = await peer.request<{ kind: string; definitions: Array<{ qualifiedName: string; path: string; line: number }>; callers: Array<{ path: string; line: number; caller: string; calls: string; depth: number }>; affectedFiles: string[]; tests: string[] }>(Methods.indexImpact, { workspacePath: ws, target: arg });
      if (r.kind === 'unknown') { process.stdout.write(`no symbol or indexed file named '${arg}'\n`); return 1; }
      for (const d of r.definitions) process.stdout.write(`def  ${d.qualifiedName}  ${d.path}:${d.line}\n`);
      for (const c of r.callers) process.stdout.write(`${'  '.repeat(c.depth)}${c.path}:${c.line}  ${c.caller || '(top level)'} -> ${c.calls}\n`);
      process.stdout.write(`affected: ${r.affectedFiles.join(', ') || '(none)'}\ntests: ${r.tests.join(', ') || '(none)'}\n`);
      return 0;
    }
    if (cmd === 'audit' && arg === 'verify') {
      const v = await peer.request<{ ok: boolean; rows: number; brokenAt: number | null; head: string; categories: Record<string, number> }>(Methods.auditVerify, {});
      if (values.json) process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
      else process.stdout.write(v.ok ? `audit chain ok: ${v.rows} rows, head ${v.head.slice(0, 16)}… (${Object.entries(v.categories).map(([k, n]) => `${k} ${n}`).join(', ') || 'empty'})\n` : `audit chain BROKEN at row ${v.brokenAt} of ${v.rows}\n`);
      return v.ok ? 0 : 1;
    }
    if (cmd === 'audit' && arg === 'export') {
      process.stdout.write((await peer.request<{ jsonl: string }>(Methods.auditExport, { category: values.category })).jsonl);
      return 0;
    }
    if (cmd === 'trace' && arg) {
      const { spans } = await peer.request<{ spans: Array<{ spanId: string; parentSpanId?: string; name: string; durationMs: number; statusCode: number; attributes: Record<string, string | number | boolean> }> }>(Methods.traceGet, { task: arg });
      if (values.json) { process.stdout.write(`${JSON.stringify(spans, null, 2)}\n`); return spans.length ? 0 : 1; }
      const kids = (id?: string) => spans.filter((x) => x.parentSpanId === id);
      const line = (x: (typeof spans)[number]) => {
        const a = x.attributes;
        const tokens = a['usage.input_tokens'] !== undefined ? ` ${a['usage.input_tokens']} in/${a['usage.output_tokens'] ?? 0} out` : '';
        const what = a.tool ?? a.gate ?? a['step.kind'] ?? a.retriever ?? a['sandbox.provider'] ?? '';
        return `${x.name}${what ? ` ${what}` : ''}${tokens} ${x.durationMs.toFixed(1)} ms${x.statusCode === 2 ? ' ERROR' : ''}${a.outcome ? ` [${a.outcome}]` : ''}`;
      };
      const walk = (x: (typeof spans)[number], depth: number): void => { process.stdout.write(`${'  '.repeat(depth)}${line(x)}\n`); for (const c of kids(x.spanId)) walk(c, depth + 1); };
      for (const r of spans.filter((x) => !x.parentSpanId)) walk(r, 0);
      if (!spans.length) { process.stderr.write('no trace for this task\n'); return 1; }
      return 0;
    }
    if (cmd === 'mcp' && (arg === 'list' || arg === undefined)) {
      const servers = await peer.request<Array<{ name: string; state: string; transport?: string; error?: string; tools: Array<{ name: string; actionClass: string; alwaysAllow?: boolean }>; filtered?: string[] }>>(Methods.mcpList, {});
      if (values.json) { process.stdout.write(`${JSON.stringify(servers, null, 2)}\n`); return 0; }
      if (!servers.length) process.stdout.write('no MCP servers configured (helix mcp add <name> -- <command>)\n');
      for (const s of servers) {
        process.stdout.write(`${s.name}  ${s.state}${s.transport ? ` (${s.transport})` : ''}  ${s.tools.length} tools${s.error ? `  — ${s.error}` : ''}\n`);
        for (const t of s.tools) process.stdout.write(`  ${t.name}  [${t.actionClass}${t.alwaysAllow ? ', always allow' : ''}]\n`);
        if (s.filtered?.length) process.stdout.write(`  filtered: ${s.filtered.join(', ')}\n`);
      }
      return 0;
    }
    process.stdout.write(USAGE);
    return 2;
  } finally {
    await stop();
  }
}

/** `helix mcp add|remove|trust` go through the Engine so each change is audited (§26.5) and the server is (dis)connected. */
async function mcpEdit(action: 'add' | 'remove' | 'trust', rest: string[], values: { url?: string; header?: string[]; trusted?: boolean }): Promise<number> {
  const [name, ...command] = rest;
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) { process.stderr.write('helix mcp: a server name ([A-Za-z0-9_.-]) is required\n'); return 2; }
  if (action === 'add' && !values.url && !command.length) { process.stderr.write('helix mcp add: pass --url <url> or -- <command> [args...]\n'); return 2; }
  if (action === 'trust' && !['trusted', 'untrusted'].includes(command[0])) { process.stderr.write('helix mcp trust: pass <name> <trusted|untrusted>\n'); return 2; }
  const { peer, stop } = await connect([]);
  try {
    if (action === 'remove') await peer.request(Methods.mcpRemove, { name });
    else if (action === 'trust') await peer.request(Methods.mcpTrust, { name, trust: command[0] });
    else {
      const headers = Object.fromEntries((values.header ?? []).map((h) => { const i = h.indexOf('='); return [h.slice(0, i), h.slice(i + 1)]; }).filter(([k]) => k));
      const status = await peer.request<{ state: string; error?: string; tools: unknown[] }>(Methods.mcpAdd, values.url
        ? { name, url: values.url, ...(Object.keys(headers).length ? { headers } : {}), ...(values.trusted ? { trust: 'trusted' } : {}) }
        : { name, command: command[0], args: command.slice(1), ...(values.trusted ? { trust: 'trusted' } : {}) });
      process.stdout.write(`added MCP server '${name}' (${status.state}${status.error ? `: ${status.error}` : `, ${status.tools.length} tools`})\n`);
      return 0;
    }
    process.stdout.write(action === 'remove' ? `removed MCP server '${name}'\n` : `MCP server '${name}' is now ${command[0]}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`helix mcp ${action}: ${(e as Error).message}\n`);
    return 1;
  } finally {
    await stop();
  }
}

if (import.meta.main) {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: Error) => {
    process.stderr.write(`helix: ${error.message}\n`);
    process.exit(1);
  });
}
