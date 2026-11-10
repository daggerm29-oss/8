/**
 * M0 exit criteria against a LIVE provider (plan §12 M0):
 *   (1) the agent fixes a seeded failing test in 3 fixture repos inside the sandbox;
 *   (2) ledger tokens and cost reconcile with provider-reported usage within 1%.
 *   (3) an Engine restart after a persisted live tool result resumes without duplicating completed calls.
 * Full acceptance requires all three fixtures in local-container; subset runs are diagnostic only.
 *
 * Run: node --disable-warning=ExperimentalWarning evals/m0-exit.ts [--provider gemini] [--model gemini-3.8-flash]
 * Requires GEMINI_API_KEY (or GEMINI_API / GOOGLE_API_KEY) or OPENAI_API_KEY in the environment.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { providerEvidence, runCli } from './m0-evidence.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Engine } from '../packages/engine/src/engine.ts';

// --models a,b,c assigns one model per fixture (useful on free tiers with per-model daily quotas).
const { values } = parseArgs({ options: { provider: { type: 'string', default: 'gemini' }, model: { type: 'string' }, models: { type: 'string' }, fixtures: { type: 'string' } } });
const perFixture = values.models?.split(',').map((m) => m.trim()).filter(Boolean) ?? [];
const FIXTURES = fileURLToPath(new URL('../fixtures/m0/', import.meta.url));
const SPECS = [
  { name: 'js-calc', verify: 'node --test "test/*.test.js"' },
  { name: 'py-strings', verify: 'python3 -m unittest -q' },
  { name: 'ts-inventory', verify: 'node --test "test/*.test.ts"' },
];

function fileHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  function visit(dir: string, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const key = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${key}/`);
      else if (entry.isFile()) out[key] = createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex');
    }
  }
  visit(root);
  return out;
}

const results = [];
const only = values.fixtures?.split(',');
const selectedModel = values.model ?? (values.provider === 'gemini' ? 'gemini-3.5-flash-lite' : undefined);
let restartResumed = false;
for (const spec of SPECS.filter((s) => !only || only.includes(s.name))) {
  const home = mkdtempSync(join(tmpdir(), 'helix-eval-'));
  let engine = new Engine({ home });
  try {
    if (!engine.vault.isConfigured(values.provider!)) throw new Error(`provider ${values.provider} has no configured authentication`);
    const dir = mkdtempSync(join(tmpdir(), `helix-live-${spec.name}-`));
    cpSync(join(FIXTURES, spec.name), dir, { recursive: true });
    const started = Date.now();
    const before = fileHashes(dir);
    const baselineSandbox = engine.runtime.sandboxFor(dir, 'eval-baseline');
    let baseline;
    try { baseline = { backend: baselineSandbox.info(), result: await baselineSandbox.exec(spec.verify, { timeoutMs: 30_000 }) }; }
    finally { baselineSandbox.destroy(); }
    if (baseline.backend.provider !== 'local-container' || baseline.result.exitCode === 0 || baseline.result.exitCode === null || baseline.result.timedOut) throw new Error('fixture must begin with a genuine failing test in local-container');
    const model = perFixture[SPECS.indexOf(spec)] ?? selectedModel;
    const goal = 'The test suite in this repository is failing. Find the bug in the source code and fix it. Do not modify tests.';
    let completedBeforeRestart: Array<{ id: string; call_id: string; checkpoint: string }> = [];
    let taskId: string;
    let cli: Awaited<ReturnType<typeof runCli>>;
    let previousEngineId: string | null = null;
    if (!restartResumed) {
      const task = engine.runtime.create({ workspacePath: dir, goal, provider: values.provider, model, verifyCommand: spec.verify, maxSteps: 25, budgetUsd: 1, start: false });
      taskId = task.id;
      previousEngineId = engine.id;
      let unsubscribe = () => {};
      let timer: NodeJS.Timeout;
      const boundary = new Promise<'tool' | 'terminal'>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('live task did not reach a restart boundary in 120s')), 120_000);
        unsubscribe = engine.bus.subscribe('**', (event) => {
          if (event.task !== task.id) return;
          if (event.topic === 'tool.result') {
            clearTimeout(timer); unsubscribe();
            completedBeforeRestart = engine.db.all<{ id: string; call_id: string; checkpoint: string }>("SELECT id, call_id, checkpoint FROM tool_calls WHERE task = ? AND status IN ('ok','error','denied')", task.id);
            void engine.close().then(() => resolve('tool'), reject);
          } else if (event.topic === 'task.status' && ['done', 'failed', 'cancelled'].includes((event.data as { status: string }).status)) {
            clearTimeout(timer); unsubscribe(); resolve('terminal');
          }
        });
      });
      engine.runtime.start(task.id);
      try {
        if (await boundary !== 'tool') throw new Error('task finished before a completed-tool restart boundary');
        cli = await runCli(['resume', task.id], home);
        engine = new Engine({ home, recover: false });
        const owners = engine.db.all<{ owner_engine: string }>('SELECT DISTINCT owner_engine FROM sandboxes WHERE labels_json LIKE ?', `%${task.id}%`);
        const resumed = engine.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE task = ? AND topic = 'task.resumed'", task.id);
        restartResumed = resumed.some((row) => JSON.parse(row.data_json).previousOwner === previousEngineId) && owners.some((row) => row.owner_engine !== previousEngineId);
      } finally { clearTimeout(timer!); unsubscribe(); }
    } else {
      await engine.close();
      cli = await runCli(['-p', goal, '-C', dir, '--verify', spec.verify, '--provider', values.provider!, ...(model ? ['-m', model] : []), '--max-steps', '25', '--budget', '1'], home);
      engine = new Engine({ home, recover: false });
      if (!cli.summary) throw new Error(`CLI returned no summary: ${cli.stderr}`);
      taskId = cli.summary.id;
    }
    const done = engine.runtime.summary(taskId);
    const after = fileHashes(dir);
    const tests = Object.keys(before).filter((path) => /(^|\/)(test[^/]*|[^/]*\.test\.[^/]+)$/.test(path) || path.startsWith('test/'));
    const testsUnchanged = tests.length > 0 && tests.every((path) => before[path] === after[path]);
    const sourceChanged = Object.keys(before).some((path) => !tests.includes(path) && before[path] !== after[path]);
    const verifySandbox = engine.runtime.sandboxFor(dir, 'eval-verify');
    let finalVerification;
    try { finalVerification = { backend: verifySandbox.info(), result: await verifySandbox.exec(spec.verify, { timeoutMs: 30_000 }) }; }
    finally { verifySandbox.destroy(); }
    const sandboxes = engine.db.all<{ id: string; provider: string; state: string; owner_engine: string }>('SELECT id, provider, state, owner_engine FROM sandboxes WHERE labels_json LIKE ?', `%${taskId}%`);
    const insideContainer = sandboxes.length > 0 && sandboxes.every((s) => s.provider === 'local-container' && s.state === 'destroyed') && finalVerification.backend.provider === 'local-container';
    const completedCallsNotRepeated = completedBeforeRestart.every((call) => {
      const rows = engine.db.all<{ id: string; checkpoint: string; status: string }>('SELECT id, checkpoint, status FROM tool_calls WHERE task = ? AND call_id = ?', taskId, call.call_id);
      const events = engine.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE task = ? AND topic = 'tool.result'", taskId).filter((row) => JSON.parse(row.data_json).callId === call.call_id);
      return events.length === 1 && rows.length === 1 && rows[0].id === call.id && rows[0].checkpoint === call.checkpoint && ['ok','error','denied'].includes(rows[0].status);
    });
    const reconciliation = engine.gateway.reconcile({ task: taskId });
    const entries = engine.ledger.entries({ task: taskId });
    const providerResponses = providerEvidence(entries, (provider, model) => engine.gateway.manifest(provider, model)?.pricing);
    const result = {
      fixture: spec.name, status: done.status, model: done.model, steps: done.stepCount, verifyAttempts: done.verifyAttempts, seconds: Math.round((Date.now() - started) / 1000),
      taskId, cli, baseline, finalVerification, before, after, testsUnchanged, sourceChanged,
      ledger: engine.ledger.totals({ task: taskId }), reconciliation, providerResponses, attempts: entries,
      reconciled: reconciliation.ok && providerResponses.length > 0 && providerResponses.every((response) => response.pass), sandboxes, insideContainer,
      restartedAfterLiveTool: completedBeforeRestart.length > 0, completedBeforeRestart, completedCallsNotRepeated,
      engines: engine.db.all('SELECT id, pid, started_at, stopped_at FROM engine_instances ORDER BY started_at'),
      resumeEvents: engine.db.all("SELECT topic, data_json FROM events WHERE task = ? AND topic = 'task.resumed'", taskId),
      toolCalls: engine.db.all('SELECT id, call_id, tool, status, checkpoint FROM tool_calls WHERE task = ? ORDER BY at, rowid', taskId), error: done.error ?? null,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = { fixture: spec.name, status: 'harness_error', model: perFixture[SPECS.indexOf(spec)] ?? values.model ?? null, reconciled: false, insideContainer: false, completedCallsNotRepeated: false, error: String(error) };
    results.push(result);
    console.error(JSON.stringify(result));
    break;
  } finally { await engine.close(); }
}
const pass = results.length === 3 && restartResumed && results.every((r) => 'cli' in r && r.cli?.code === 0 && !r.cli.timedOut && r.status === 'done' && r.reconciled && r.insideContainer && r.completedCallsNotRepeated && r.testsUnchanged && r.sourceChanged && r.finalVerification.result.exitCode === 0);
mkdirSync(fileURLToPath(new URL('./results/', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL(`./results/m0-exit-${values.provider}-${values.models ? 'multi' : values.model ?? 'default'}-${new Date().toISOString().replace(/[:.]/g, '-')}${only ? `-${only.join('+')}` : ''}.json`, import.meta.url)), JSON.stringify({ at: new Date().toISOString(), pass, restartResumed, pricingBasis: 'Published Standard paid-tier USD/token reference valuation, not a provider invoice or an assertion about account billing; unknown prices stay null and fail the gate.', results }, null, 2));
console.log(pass ? 'M0 LIVE EXIT: PASS' : 'M0 LIVE EXIT: FAIL');
process.exit(pass ? 0 : 1);
