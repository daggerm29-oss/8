/**
 * Context metrics eval (R1.15, F-CTX-1 / F-CTX-2, architecture §13.2 and §13.4), LIVE provider:
 *   1. Stable-prefix ratio: over every HTS-lite task, the share of input tokens served from the provider prompt
 *      cache on turns 2..n (cached_input_tokens / input_tokens from the ledger) must be >= 90%.
 *   2. Long-horizon success: the `longHorizon` subset runs with and without compaction; success with compaction
 *      must be within 2 percentage points of success without it.
 *
 * Needs HTS-lite (R1.39): `evals/hts-lite/manifest.json` = { tasks: [{ id, fixture, goal, verifyCommand?, acceptCommand, longHorizon? }] }
 * where `fixture` is a directory relative to the repo root and `acceptCommand` is the hidden acceptance test run
 * in the workspace after the agent finishes. Exit codes: 0 pass, 1 fail, 2 blocked (no HTS-lite or no provider key).
 *
 * Run: set -a; . ./.env.development.local; set +a; node --disable-warning=ExperimentalWarning evals/context-metrics.ts [--model gemini-3.5-flash-lite] [--limit N]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Engine } from '../packages/engine/src/engine.ts';

const { values } = parseArgs({ options: { provider: { type: 'string', default: 'gemini' }, model: { type: 'string', default: 'gemini-3.5-flash-lite' }, limit: { type: 'string' } } });
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST = join(ROOT, 'evals/hts-lite/manifest.json');
const RESULTS = join(ROOT, 'evals/results');
const PREFIX_MIN = 0.9;
const DROP_MAX_PP = 2;

interface HtsTask { id: string; fixture: string; goal: string; verifyCommand?: string; acceptCommand: string; longHorizon?: boolean }
interface RunResult { id: string; compaction: boolean; status: string; accepted: boolean; calls: number; inputTokens: number; cachedInputTokens: number; laterInput: number; laterCached: number; compactions: number }

if (!existsSync(MANIFEST)) {
  console.error('BLOCKED: evals/hts-lite/manifest.json not found (HTS-lite is R1.39)');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tasks: HtsTask[] };
const tasks = manifest.tasks.slice(0, values.limit ? Number(values.limit) : undefined);
if (!tasks.length) {
  console.error('BLOCKED: HTS-lite manifest has no tasks');
  process.exit(2);
}

async function runTask(t: HtsTask, compaction: boolean): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), `helix-ctx-${t.id}-`));
  cpSync(join(ROOT, t.fixture), dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Helix Eval');
  git('config', 'user.email', 'eval@helix.local');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-ctx-home-')), mcp: false, compaction: { enabled: compaction } });
  try {
    if (!engine.vault.isConfigured(values.provider!)) {
      console.error(`BLOCKED: provider ${values.provider} has no API key in the environment`);
      process.exit(2);
    }
    const task = engine.runtime.create({
      workspacePath: dir, goal: t.goal, provider: values.provider, model: values.model, verifyCommand: t.verifyCommand,
      policyProfile: 'headless', preapprove: ['all'], maxSteps: 60, budgetUsd: 2,
    });
    const done = await engine.runtime.wait(task.id, 1_800_000);
    const calls = engine.db.all<{ input: number; cached: number }>(
      `SELECT input_tokens AS input, cached_input_tokens AS cached FROM ledger_entries WHERE task = ? AND status = 'ok' ORDER BY at, rowid`, task.id);
    const later = calls.slice(1);
    const accept = spawnSync(t.acceptCommand, { cwd: dir, shell: true, encoding: 'utf8', timeout: 600_000 });
    return {
      id: t.id, compaction, status: done.status, accepted: done.status === 'done' && accept.status === 0, calls: calls.length,
      inputTokens: calls.reduce((n, c) => n + c.input, 0), cachedInputTokens: calls.reduce((n, c) => n + c.cached, 0),
      laterInput: later.reduce((n, c) => n + c.input, 0), laterCached: later.reduce((n, c) => n + c.cached, 0),
      compactions: engine.runtime.artifacts(task.id, 'compaction').length,
    };
  } finally {
    await engine.close();
  }
}

const sum = (rs: RunResult[], k: 'laterInput' | 'laterCached') => rs.reduce((n, r) => n + r[k], 0);
const rate = (rs: RunResult[]) => (rs.length ? rs.filter((r) => r.accepted).length / rs.length : 0);

const withCompaction: RunResult[] = [];
for (const t of tasks) withCompaction.push(await runTask(t, true));
const longTasks = tasks.filter((t) => t.longHorizon);
const withoutCompaction: RunResult[] = [];
for (const t of longTasks) withoutCompaction.push(await runTask(t, false));

const prefixRatio = sum(withCompaction, 'laterInput') ? sum(withCompaction, 'laterCached') / sum(withCompaction, 'laterInput') : 0;
const longWith = withCompaction.filter((r) => longTasks.some((t) => t.id === r.id));
const dropPp = (rate(withoutCompaction) - rate(longWith)) * 100;
const checks = {
  stablePrefixRatioAtLeast90: prefixRatio >= PREFIX_MIN,
  longHorizonCompactionWithin2pp: longTasks.length > 0 && dropPp <= DROP_MAX_PP,
};
const pass = Object.values(checks).every(Boolean);
const result = {
  at: new Date().toISOString(), pass, provider: values.provider, model: values.model, tasks: tasks.length, longHorizonTasks: longTasks.length,
  stablePrefixRatio: prefixRatio, longHorizon: { successWithCompaction: rate(longWith), successWithoutCompaction: rate(withoutCompaction), dropPp },
  checks, runs: [...withCompaction, ...withoutCompaction],
};
mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, `context-metrics-${values.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(pass ? 'CONTEXT METRICS: PASS' : 'CONTEXT METRICS: FAIL');
process.exit(pass ? 0 : 1);
