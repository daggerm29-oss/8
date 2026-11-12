/**
 * Retrieval eval harness (plan §15.3, R1.12): Recall@10, MRR and tokens per recall point for the hybrid retrieval
 * engine, with and without the rerank, graph-neighborhood and dependency-expansion stages.
 *
 * A suite is a directory holding `repo/` (the codebase to index) and `queries.json`
 * (`{ queries: [{ id, query, relevant: [paths] }] }`). Recall@10 and MRR are computed over the ranked results
 * (expansion items are context, not ranked results). Tokens per recall point = mean packed tokens per query
 * (ranked results plus expansion) divided by Recall@10 expressed in points (0-100).
 *
 * Run: node --disable-warning=ExperimentalWarning evals/retrieval-eval.ts --suite fixtures/retrieval/smoke
 * Exit code 1 when the full pipeline's Recall@10 is below the baseline, or a stage never appears in `why`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Db } from '../packages/engine/src/storage/db.ts';
import { WorkspaceIndex, type SearchOptions } from '../packages/engine/src/index/index.ts';

interface Query { id: string; query: string; relevant: string[] }
interface Config { name: string; opts: SearchOptions }
interface Summary { config: string; recallAt10: number; mrr: number; tokensPerRecallPoint: number | null; meanTokens: number; p95Ms: number; why: Record<string, number> }

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUDGET = 4000;

const CONFIGS: Config[] = [
  { name: 'baseline', opts: {} },
  { name: '+rerank', opts: { rerank: 'auto' } },
  { name: '+graph', opts: { graph: true } },
  { name: '+expand', opts: { expand: true, tokenBudget: BUDGET } },
  { name: 'full', opts: { rerank: 'auto', graph: true, expand: true, tokenBudget: BUDGET } },
];

const { values } = parseArgs({ options: { suite: { type: 'string' }, out: { type: 'string' } } });
if (!values.suite) {
  console.error('usage: node evals/retrieval-eval.ts --suite <dir containing repo/ and queries.json>');
  process.exit(2);
}
const suiteDir = [resolve(process.cwd(), values.suite), resolve(ROOT, values.suite)].find((d) => existsSync(join(d, 'queries.json')));
if (!suiteDir) {
  console.error(`suite not found: ${values.suite}`);
  process.exit(2);
}
const queries = (JSON.parse(readFileSync(join(suiteDir, 'queries.json'), 'utf8')) as { queries: Query[] }).queries;

const index = new WorkspaceIndex(new Db(':memory:'), 'retrieval-eval', join(suiteDir, 'repo'));
index.update();

const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)];

function run(config: Config): Summary {
  let recall = 0;
  let reciprocalRank = 0;
  let tokens = 0;
  const latencies: number[] = [];
  const why: Record<string, number> = {};
  for (const q of queries) {
    const started = performance.now();
    const hits = index.search(q.query, { limit: 10, ...config.opts });
    latencies.push(performance.now() - started);
    const ranked = hits.filter((h) => !h.why.some((w) => w.startsWith('expand:')));
    const rankedPaths = ranked.map((h) => h.path);
    recall += q.relevant.filter((p) => rankedPaths.includes(p)).length / q.relevant.length;
    const firstRelevant = rankedPaths.findIndex((p) => q.relevant.includes(p));
    if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
    tokens += hits.reduce((n, h) => n + h.tokens, 0);
    for (const w of new Set(hits.flatMap((h) => h.why))) why[w] = (why[w] ?? 0) + 1;
  }
  const recallAt10 = recall / queries.length;
  return {
    config: config.name,
    recallAt10: Number(recallAt10.toFixed(4)),
    mrr: Number((reciprocalRank / queries.length).toFixed(4)),
    tokensPerRecallPoint: recallAt10 > 0 ? Number((tokens / queries.length / (recallAt10 * 100)).toFixed(2)) : null,
    meanTokens: Math.round(tokens / queries.length),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
    why,
  };
}

const summaries = CONFIGS.map(run);
const baseline = summaries[0];
const full = summaries.at(-1)!;

console.log(`retrieval-eval  suite=${values.suite}  queries=${queries.length}  chunks=${index.counts().chunks}`);
console.log(`${'config'.padEnd(10)} ${'Recall@10'.padStart(10)} ${'MRR'.padStart(7)} ${'tok/recall-pt'.padStart(14)} ${'mean tok'.padStart(9)} ${'p95 ms'.padStart(8)}`);
for (const s of summaries) console.log(`${s.config.padEnd(10)} ${s.recallAt10.toFixed(3).padStart(10)} ${s.mrr.toFixed(3).padStart(7)} ${String(s.tokensPerRecallPoint ?? 'n/a').padStart(14)} ${String(s.meanTokens).padStart(9)} ${s.p95Ms.toFixed(1).padStart(8)}`);
console.log(`why (queries with the label in the full pipeline): ${Object.entries(full.why).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);

const failures: string[] = [];
if (full.recallAt10 < baseline.recallAt10) failures.push(`Recall@10 with rerank+graph+expansion (${full.recallAt10}) is lower than without (${baseline.recallAt10})`);
for (const [label, test] of [['rerank', (w: string) => w === 'rerank'], ['graph-neighborhood retriever', (w: string) => w.startsWith('graph')], ['dependency expansion', (w: string) => w.startsWith('expand:')]] as const) {
  if (!Object.keys(full.why).some(test)) failures.push(`${label} never appears in \`why\``);
}

const resultsDir = join(ROOT, 'evals', 'results');
mkdirSync(resultsDir, { recursive: true });
const outPath = values.out ? resolve(values.out) : join(resultsDir, `retrieval-eval-${suiteDir.split('/').at(-1)}.json`);
writeFileSync(outPath, `${JSON.stringify({ suite: values.suite, queries: queries.length, tokenBudget: BUDGET, summaries, failures }, null, 2)}\n`);

if (failures.length) {
  console.log(`RETRIEVAL EVAL: FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`RETRIEVAL EVAL: PASS  Recall@10 ${baseline.recallAt10} -> ${full.recallAt10}  MRR ${baseline.mrr} -> ${full.mrr}  (${outPath.replace(`${ROOT}/`, '')})`);
