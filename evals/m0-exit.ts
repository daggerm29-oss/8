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
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const results = [];
const only = values.fixtures?.split(',');
let restartResumed = false;
for (const spec of SPECS.filter((s) => !only || only.includes(s.name))) {
  const home = mkdtempSync(join(tmpdir(), 'helix-eval-'));
  let engine = new Engine({ home });
  try {
    if (!engine.vault.isConfigured(values.provider!)) throw new Error(`provider ${values.provider} has no configured authentication`);
    const dir = mkdtempSync(join(tmpdir(), `helix-live-${spec.name}-`));
    cpSync(join(FIXTURES, spec.name), dir, { recursive: true });
    const started = Date.now();
    const task = engine.runtime.create({ workspacePath: dir, goal: 'The test suite in this repository is failing. Find the bug in the source code and fix it.', provider: values.provider, model: perFixture[SPECS.indexOf(spec)] ?? values.model, verifyCommand: spec.verify, maxSteps: 25, budgetUsd: 1, start: false });
    let completedBeforeRestart: string[] = [];
    if (!restartResumed) {
      let unsubscribe = () => {};
      let timer: NodeJS.Timeout;
      const boundary = new Promise<'tool' | 'terminal'>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('live task did not reach a restart boundary in 120s')), 120_000);
        unsubscribe = engine.bus.subscribe('**', (event) => {
          if (event.task !== task.id) return;
          if (event.topic === 'tool.result') {
            clearTimeout(timer); unsubscribe();
            completedBeforeRestart = engine.db.all<{ call_id: string }>('SELECT call_id FROM tool_calls WHERE task = ?', task.id).map((r) => r.call_id);
            void engine.close().then(() => resolve('tool'), reject);
          } else if (event.topic === 'task.status' && ['done', 'failed', 'cancelled'].includes((event.data as { status: string }).status)) {
            clearTimeout(timer); unsubscribe(); resolve('terminal');
          }
        });
      });
      engine.runtime.start(task.id);
      try {
        if (await boundary === 'tool') {
          engine = new Engine({ home });
          restartResumed = engine.runtime.isRunning(task.id);
        }
      } finally { clearTimeout(timer!); unsubscribe(); }
    } else engine.runtime.start(task.id);
    const done = await engine.runtime.wait(task.id, 180_000);
    const sandboxes = engine.db.all<{ provider: string; state: string }>('SELECT provider, state FROM sandboxes WHERE labels_json LIKE ?', `%${task.id}%`);
    const insideContainer = sandboxes.length > 0 && sandboxes.every((s) => s.provider === 'local-container' && s.state === 'destroyed');
    const completedCallsNotRepeated = completedBeforeRestart.every((call) => engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tool_calls WHERE task = ? AND call_id = ?', task.id, call)?.n === 1);
    const reconciliation = engine.gateway.reconcile({ task: task.id });
    const result = {
      fixture: spec.name, status: done.status, model: done.model, steps: done.stepCount, verifyAttempts: done.verifyAttempts, seconds: Math.round((Date.now() - started) / 1000),
      ledger: done.ledger, reconciliation, reconciled: reconciliation.ok && reconciliation.groups.length > 0 && reconciliation.groups.every((g) => g.ledger.costUsd !== null && g.providerReported.costUsd !== null), sandboxes, insideContainer,
      restartedAfterLiveTool: completedBeforeRestart.length > 0, completedCallsNotRepeated, error: done.error ?? null,
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
const pass = results.length === 3 && restartResumed && results.every((r) => r.status === 'done' && r.reconciled && r.insideContainer && r.completedCallsNotRepeated);
mkdirSync(fileURLToPath(new URL('./results/', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL(`./results/m0-exit-${values.provider}-${values.models ? 'multi' : values.model ?? 'default'}-${new Date().toISOString().replace(/[:.]/g, '-')}${only ? `-${only.join('+')}` : ''}.json`, import.meta.url)), JSON.stringify({ at: new Date().toISOString(), pass, restartResumed, results }, null, 2));
console.log(pass ? 'M0 LIVE EXIT: PASS' : 'M0 LIVE EXIT: FAIL');
process.exit(pass ? 0 : 1);
