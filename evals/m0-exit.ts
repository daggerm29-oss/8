/**
 * M0 exit criteria against a LIVE provider (plan §12 M0):
 *   (1) the agent fixes a seeded failing test in 3 fixture repos inside the sandbox;
 *   (2) ledger totals reconcile with the provider-reported usage stored on each ledger row.
 * Criterion (3), engine restart resumes a task, is proven by packages/engine/test/agent.test.ts (SIGKILL test).
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

const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-eval-')) });
if (!engine.vault.isConfigured(values.provider!)) {
  console.error(`provider ${values.provider} has no API key in the environment`);
  process.exit(2);
}
const results = [];
const only = values.fixtures?.split(',');
for (const spec of SPECS.filter((s) => !only || only.includes(s.name))) {
  const dir = mkdtempSync(join(tmpdir(), `helix-live-${spec.name}-`));
  cpSync(join(FIXTURES, spec.name), dir, { recursive: true });
  const started = Date.now();
  const task = engine.runtime.create({ workspacePath: dir, goal: 'The test suite in this repository is failing. Find the bug in the source code and fix it.', provider: values.provider, model: perFixture[SPECS.indexOf(spec)] ?? values.model, verifyCommand: spec.verify, maxSteps: 25, budgetUsd: 1 });
  const done = await engine.runtime.wait(task.id, 600_000);
  const rows = engine.db.all<{ provider_usage_json: string | null; input_tokens: number; output_tokens: number }>(`SELECT provider_usage_json, input_tokens, output_tokens FROM ledger_entries WHERE task = ? AND status = 'ok'`, task.id);
  let rawIn = 0;
  let rawOut = 0;
  for (const r of rows) {
    const u = JSON.parse(r.provider_usage_json ?? '{}');
    rawIn += u.promptTokenCount ?? u.input_tokens ?? 0;
    rawOut += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) + (u.output_tokens ?? 0);
  }
  const l = done.ledger;
  const result = {
    fixture: spec.name, status: done.status, model: done.model, steps: done.stepCount, verifyAttempts: done.verifyAttempts, seconds: Math.round((Date.now() - started) / 1000),
    ledger: { calls: l.calls, inputTokens: l.inputTokens, outputTokens: l.outputTokens, costUsd: l.costUsd, providerReportedCalls: l.providerReportedCalls, estimatedCalls: l.estimatedCalls },
    providerRaw: { inputTokens: rawIn, outputTokens: rawOut },
    reconciled: rawIn === l.inputTokens && rawOut === l.outputTokens && l.estimatedCalls === 0,
    error: done.error ?? null,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await engine.close();
const pass = results.every((r) => r.status === 'done' && r.reconciled);
mkdirSync(fileURLToPath(new URL('./results/', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL(`./results/m0-exit-${values.provider}-${values.models ? 'multi' : values.model ?? 'default'}-${new Date().toISOString().replace(/[:.]/g, '-')}${only ? `-${only.join('+')}` : ''}.json`, import.meta.url)), JSON.stringify({ at: new Date().toISOString(), pass, results }, null, 2));
console.log(pass ? 'M0 LIVE EXIT: PASS' : 'M0 LIVE EXIT: FAIL');
process.exit(pass ? 0 : 1);
