import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Methods, Notifications, PROTOCOL_VERSION, RpcPeer, streamTransport, type HelixEvent, type TaskSummary } from '@helix/protocol';

const USAGE = `helix — Helix coding agent CLI (M0)

Usage:
  helix -p "<goal>" [options]     run a task headlessly and exit when it finishes
  helix tasks                     list recent tasks
  helix resume <task-id>          resume an interrupted task and wait for it
  helix ledger <task-id>          show token/cost ledger totals for a task

Options:
  -C, --cwd <dir>         workspace directory (default: current directory)
  --verify <command>      verification command; the task succeeds only if it exits 0
  --provider <id>         gemini | openai (default: first configured provider)
  -m, --model <id>        model id (default: provider default)
  --max-steps <n>         model turn limit (default 40)
  --budget <usd>          hard USD budget for the task
  --allow <class>         preapprove an action class in headless mode (network, destructive); repeatable
  --json                  print the final task summary as JSON
  -q, --quiet             do not stream progress to stderr
`;

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
    case 'verify.result': return `  verify #${d.attempt}: ${d.passed ? 'passed' : `failed (exit ${d.exitCode})`}`;
    case 'approval.requested': return `  ? approval needed for ${d.tool} (${d.actionClass})`;
    default: return null;
  }
}

async function runAndWait(peer: RpcPeer, summary: TaskSummary, opts: { quiet: boolean; json: boolean }): Promise<number> {
  if (!opts.quiet) {
    peer.onNotification(Notifications.event, (params) => {
      const e = params as HelixEvent;
      if (e.task !== summary.id) return;
      const line = render(e);
      if (line) process.stderr.write(`${line}\n`);
    });
    process.stderr.write(`helix task ${summary.id} · ${summary.provider}/${summary.model} · ${summary.workspacePath}\n`);
  }
  const final = await peer.request<TaskSummary & { ledger: { calls: number; inputTokens: number; outputTokens: number; costUsd: number } }>(Methods.taskWait, { id: summary.id });
  if (opts.json) process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
  else {
    process.stdout.write(`${final.status === 'done' ? final.result : `Task ${final.status}: ${final.error ?? ''}`}\n`);
    if (!opts.quiet) process.stderr.write(`— ${final.status} · ${final.stepCount} steps · ${final.ledger.calls} model calls · ${final.ledger.inputTokens} in / ${final.ledger.outputTokens} out tokens · $${final.ledger.costUsd.toFixed(4)}\n`);
  }
  return final.status === 'done' ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      prompt: { type: 'string', short: 'p' }, cwd: { type: 'string', short: 'C' }, verify: { type: 'string' }, provider: { type: 'string' },
      model: { type: 'string', short: 'm' }, 'max-steps': { type: 'string' }, budget: { type: 'string' }, allow: { type: 'string', multiple: true },
      json: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || (!values.prompt && !cmd)) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const opts = { quiet: Boolean(values.quiet), json: Boolean(values.json) };
  const { peer, stop } = await connect(opts.quiet ? [] : ['task.*', 'agent.*', 'tool.*', 'verify.*', 'approval.*']);
  try {
    if (values.prompt) {
      const summary = await peer.request<TaskSummary>(Methods.taskCreate, {
        workspacePath: resolve(values.cwd ?? process.cwd()), goal: values.prompt, verifyCommand: values.verify, provider: values.provider, model: values.model,
        maxSteps: values['max-steps'] ? Number(values['max-steps']) : undefined, budgetUsd: values.budget ? Number(values.budget) : undefined,
        policyProfile: 'headless', preapprove: values.allow ?? [],
      });
      return await runAndWait(peer, summary, opts);
    }
    if (cmd === 'tasks') {
      const list = await peer.request<TaskSummary[]>(Methods.taskList, { limit: 20 });
      for (const t of list) process.stdout.write(`${t.id}  ${t.status.padEnd(10)} ${t.updatedAt}  ${t.title}\n`);
      return 0;
    }
    if (cmd === 'resume' && arg) {
      const summary = await peer.request<TaskSummary>(Methods.taskGet, { id: arg });
      if (!['done', 'failed', 'cancelled'].includes(summary.status)) await peer.request(Methods.taskResume, { id: arg });
      return await runAndWait(peer, summary, opts);
    }
    if (cmd === 'ledger' && arg) {
      process.stdout.write(`${JSON.stringify(await peer.request(Methods.ledgerQuery, { task: arg }), null, 2)}\n`);
      return 0;
    }
    process.stdout.write(USAGE);
    return 2;
  } finally {
    await stop();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: Error) => {
    process.stderr.write(`helix: ${error.message}\n`);
    process.exit(1);
  });
}
