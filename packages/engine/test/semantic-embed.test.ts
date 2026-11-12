import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { Ledger } from '../src/models/ledger.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { identifierTerms } from '../src/index/extract.ts';
import { embed, EMBED_MODEL } from '../src/index/embed.ts';
import { geminiEmbedder, hashEmbedder, localSemanticEmbedder, type Embedder } from '../src/index/embedders.ts';

const FILES: Record<string, string> = {
  'src/text.ts': `
export function toLower(s: string): string {
  return s.toLowerCase();
}
export function strip(s: string): string {
  return s.replace(/^\\s+|\\s+$/g, '');
}
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function padLeft(s: string, width: number): string {
  return s.padStart(width, '0');
}
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function isEmail(s: string): boolean {
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s);
}
`,
  'src/lists.ts': `
export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
export function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
export function flatten<T>(xs: T[][]): T[] {
  return xs.reduce((acc, row) => acc.concat(row), [] as T[]);
}
export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
export function shuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of xs) (out[key(x)] ??= []).push(x);
  return out;
}
export function zip<A, B>(a: A[], b: B[]): Array<[A, B]> {
  return a.map((x, i) => [x, b[i]]);
}
`,
  'src/time.ts': `
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / 86_400_000);
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
export function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}
`,
  'src/fn.ts': `
export function debounce<A extends unknown[]>(fn: (...a: A) => void, wait: number): (...a: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...a) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), wait);
  };
}
export function memoize<A, R>(fn: (a: A) => R): (a: A) => R {
  const cache = new Map<A, R>();
  return (a) => {
    if (!cache.has(a)) cache.set(a, fn(a));
    return cache.get(a) as R;
  };
}
export function once<R>(fn: () => R): () => R {
  let done = false;
  let value: R;
  return () => (done ? value : ((done = true), (value = fn())));
}
export function compose<T>(...fns: Array<(x: T) => T>): (x: T) => T {
  return (x) => fns.reduceRight((acc, f) => f(acc), x);
}
`,
  'src/math.ts': `
export function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function randomInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
export function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
`,
  'src/objects.ts': `
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
`,
};

/** Paraphrase queries that share no identifier word with the target function (verified below). */
const PAIRS: Array<{ query: string; target: string }> = [
  { query: 'make a string lowercase', target: 'toLower' },
  { query: 'remove whitespace from both ends', target: 'strip' },
  { query: 'split a list into groups of equal size', target: 'chunk' },
  { query: 'get rid of repeated entries in an array', target: 'dedupe' },
  { query: 'check whether a number has no divisors besides one and itself', target: 'isPrime' },
  { query: 'pause execution for a while', target: 'sleep' },
  { query: 'only call a function once the calls stop arriving', target: 'debounce' },
  { query: 'turn a title into a url friendly string', target: 'slugify' },
  { query: 'count of 24 hour periods separating two moments', target: 'daysBetween' },
  { query: 'make an independent copy of a nested object', target: 'deepClone' },
];

function workspace(files: Record<string, string> = FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'helix-semantic-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const db = new Db(':memory:');
  const index = new WorkspaceIndex(db, 'ws', dir);
  index.update();
  return { dir, db, index };
}

/** Number of pairs whose target function ranks in the top 3 chunks by vector similarity alone. */
async function top3Hits(index: WorkspaceIndex, embedder: Embedder): Promise<{ hits: number; ranks: Record<string, number> }> {
  const queries = await embedder.embed(PAIRS.map((p) => p.query), 'query');
  let hits = 0;
  const ranks: Record<string, number> = {};
  PAIRS.forEach((pair, i) => {
    const ranked = index.vectorSearch(embedder.id, queries.vectors[i], { limit: 10 });
    const rank = ranked.findIndex((h) => h.symbol === pair.target) + 1;
    ranks[pair.target] = rank;
    if (rank >= 1 && rank <= 3) hits++;
  });
  return { hits, ranks };
}

test('fixture pairs: no query word is an identifier word of the target (name or body)', () => {
  const stop = new Set(['a', 'the', 'of', 'in', 'to', 'into', 'from', 'for', 'and', 'once', 'whether', 'has', 'no', 'one', 'it']);
  const typeKeywords = new Set(['string', 'number', 'boolean', 'void', 'function']); // language syntax, not domain identifiers
  for (const { query, target } of PAIRS) {
    const bodyStart = Object.values(FILES).join('\n').indexOf(`function ${target}`);
    assert.ok(bodyStart >= 0, `${target} exists in the fixture`);
    const body = Object.values(FILES).join('\n').slice(bodyStart).split(/\n}\n/)[0];
    const identifierWords = new Set(identifierTerms(body).split(' '));
    const shared = query.toLowerCase().split(/\W+/).filter((w) => w && !stop.has(w) && !typeKeywords.has(w) && identifierWords.has(w));
    assert.deepEqual(shared, [], `"${query}" must not share identifier words with ${target}`);
  }
});

test('semantic model: paraphrases rank the target in top 3 for >= 8/10 pairs where helix-local-hash-v1 scores <= 3/10', async () => {
  const { index } = workspace();
  const hashRun = await index.embedPending(hashEmbedder);
  assert.equal(hashRun.kind, 'lexical');
  const lexical = await top3Hits(index, hashEmbedder);

  const model = localSemanticEmbedder();
  const run = await index.embedPending(model);
  assert.equal(run.error, undefined);
  assert.equal(run.kind, 'semantic');
  const semantic = await top3Hits(index, model);
  console.log(`[semantic-embed] local=${semantic.hits}/10 hash=${lexical.hits}/10 ranks=${JSON.stringify(semantic.ranks)}`);

  assert.ok(semantic.hits >= 8, `semantic top-3 ${semantic.hits}/10 ranks ${JSON.stringify(semantic.ranks)}`);
  assert.ok(lexical.hits <= 3, `helix-local-hash-v1 top-3 ${lexical.hits}/10 ranks ${JSON.stringify(lexical.ranks)}`);
});

test('hybrid search: semantic vectors add a `vector` retriever; the hash fallback is labeled `vector:lexical`', async () => {
  const { index } = workspace();
  const model = localSemanticEmbedder();
  await index.embedPending(model);
  const q = await index.queryEmbedding(model, 'make a string lowercase');
  const withSemantic = index.search('make a string lowercase', { limit: 5, semantic: q });
  assert.ok(withSemantic.slice(0, 3).some((h) => h.symbol === 'toLower' && h.why.includes('vector')), JSON.stringify(withSemantic.map((h) => [h.symbol, h.why])));
  const offline = index.search('make a string lowercase', { limit: 5 });
  assert.ok(offline.every((h) => !h.why.includes('vector')), 'without a semantic embedder nothing is labeled as semantic');
  assert.ok(offline.some((h) => h.why.includes('vector:lexical')), 'the offline fallback is labeled lexical');
});

test('ledger: each embedding call is an `embedder` row with tokens and cost; a priced provider costs tokens x price', async () => {
  const { index, db } = workspace();
  const ledger = new Ledger(db);
  const local = await index.embedPending(localSemanticEmbedder(), { ledger, task: 'task_1' });
  const rows = db.all<{ role: string; provider: string; model: string; input_tokens: number; cost_usd: number; usage_source: string; task: string }>("SELECT role, provider, model, input_tokens, cost_usd, usage_source, task FROM ledger_entries WHERE role = 'embedder'");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.provider === 'helix-local' && r.model.startsWith('local:') && r.input_tokens > 0 && r.cost_usd === 0 && r.task === 'task_1'));
  assert.equal(rows.reduce((n, r) => n + r.input_tokens, 0), local.inputTokens);

  const reported: number[] = [];
  const providerStub = (async (_url: string, init: { body: string }) => {
    const requests = (JSON.parse(init.body) as { requests: unknown[] }).requests;
    const promptTokenCount = requests.length * 100;
    reported.push(promptTokenCount);
    return { ok: true, status: 200, json: async () => ({ embeddings: requests.map(() => ({ values: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) })), usageMetadata: { promptTokenCount } }) };
  }) as unknown as typeof fetch;
  const run = await index.embedPending(geminiEmbedder({ apiKey: 'test-key', fetchFn: providerStub }), { ledger });
  const gemini = db.all<{ input_tokens: number; cost_usd: number; usage_source: string }>("SELECT input_tokens, cost_usd, usage_source FROM ledger_entries WHERE role = 'embedder' AND provider = 'gemini'");
  const tokens = reported.reduce((a, b) => a + b, 0);
  assert.equal(gemini.reduce((n, r) => n + r.input_tokens, 0), tokens);
  assert.ok(gemini.every((r) => r.usage_source === 'provider'));
  assert.ok(Math.abs(gemini.reduce((n, r) => n + r.cost_usd, 0) - (tokens * 0.2) / 1_000_000) < 1e-12);
  assert.ok(Math.abs((run.costUsd ?? NaN) - (tokens * 0.2) / 1_000_000) < 1e-12);
  assert.ok(ledger.totals({}).costUsd > 0);
});

test('lazy embedding: open files first, then recency x import centrality; identical chunks embed once; resumable', async () => {
  const files: Record<string, string> = {
    'src/core.ts': 'export function core() {\n  return 1;\n}\n',
    'src/a.ts': "import { core } from './core';\nexport function a() {\n  return core();\n}\n",
    'src/b.ts': "import { core } from './core';\nexport function b() {\n  return core() + 1;\n}\n",
    'src/old-leaf.ts': 'export function oldLeaf() {\n  return 3;\n}\n',
    'src/open-me.ts': 'export function openMe() {\n  return 4;\n}\n',
    'src/dup-1.ts': 'export function twin() {\n  return 5;\n}\n',
    'src/dup-2.ts': 'export function twin() {\n  return 5;\n}\n',
  };
  const { dir, index } = workspace(files);
  const longAgo = new Date(Date.now() - 400 * 86_400_000);
  utimesSync(join(dir, 'src/old-leaf.ts'), longAgo, longAgo);
  const seen: string[] = [];
  const stub: Embedder = {
    ...hashEmbedder,
    id: 'stub:lazy',
    provider: 'stub',
    async embed(texts) {
      seen.push(...texts);
      const result = await hashEmbedder.embed(texts, 'document');
      return result;
    },
  };
  const first = await index.embedPending(stub, { openFiles: ['src/open-me.ts'], maxChunks: 3 });
  assert.equal(first.order[0], 'src/open-me.ts', 'open files come first');
  assert.equal(first.order[1], 'src/core.ts', 'then the most imported (central) recent file');
  assert.equal(index.pendingChunks('stub:lazy'), first.pending - 3, 'only the budgeted chunks were embedded');

  const rest = await index.embedPending(stub, { openFiles: ['src/open-me.ts'] });
  assert.equal(rest.pending, first.pending - 3);
  assert.equal(rest.order.at(-1), 'src/old-leaf.ts', 'stale leaf files are embedded last');
  assert.equal(index.pendingChunks('stub:lazy'), 0);
  assert.equal(seen.filter((t) => t.includes('function twin')).length, 1, 'identical chunks in two files are embedded once (content-hash dedupe)');
  assert.equal(seen.length, new Set(seen).size);
  const again = await index.embedPending(stub);
  assert.deepEqual([again.pending, again.embedded], [0, 0], 'a second run has nothing pending');
});

test('failing embedder: the run stops with an error row, and search keeps working without vectors', async () => {
  const { index, db } = workspace();
  const ledger = new Ledger(db);
  const broken: Embedder = { ...hashEmbedder, id: 'broken:model', provider: 'broken', kind: 'semantic', async embed() { throw new Error('provider unavailable'); } };
  const run = await index.embedPending(broken, { ledger });
  assert.equal(run.error, 'provider unavailable');
  assert.equal(run.embedded, 0);
  const row = db.get<{ status: string; role: string; error: string }>("SELECT status, role, error FROM ledger_entries WHERE provider = 'broken'");
  assert.deepEqual([row?.status, row?.role, row?.error], ['error', 'embedder', 'provider unavailable']);
  const hits = index.search('debounce a function', { limit: 3 });
  assert.equal(hits[0].symbol, 'debounce');
  assert.ok(!hits.some((h) => h.why.includes('vector')));
});

test('lexical fallback keeps its model id and is not reported as semantic', async () => {
  assert.equal(hashEmbedder.kind, 'lexical');
  assert.equal(hashEmbedder.id, EMBED_MODEL);
  const [v] = (await hashEmbedder.embed(['hello world'], 'query')).vectors;
  assert.equal(v.length, embed('hello world').length);
});

test('live gemini-embedding-2 (needs GEMINI_API): paraphrases rank in top 3 for >= 8/10 pairs; usage and cost reach the ledger', { skip: process.env.GEMINI_API ? false : 'GEMINI_API not set (A-live)' }, async () => {
  const { index, db } = workspace();
  const ledger = new Ledger(db);
  const provider = geminiEmbedder({ apiKey: process.env.GEMINI_API as string });
  const run = await index.embedPending(provider, { ledger });
  assert.equal(run.error, undefined);
  const result = await top3Hits(index, provider);
  console.log(`[semantic-embed] gemini-embedding-2 top3=${result.hits}/10 ranks=${JSON.stringify(result.ranks)} tokens=${run.inputTokens} costUsd=${run.costUsd}`);
  assert.ok(result.hits >= 8, JSON.stringify(result.ranks));
  const row = db.get<{ n: number; tokens: number; cost: number; src: string }>("SELECT COUNT(*) AS n, SUM(input_tokens) AS tokens, SUM(cost_usd) AS cost, MIN(usage_source) AS src FROM ledger_entries WHERE role = 'embedder' AND provider = 'gemini'");
  assert.ok(row!.n >= 1 && row!.tokens === run.inputTokens && row!.cost > 0 && row!.src === 'provider');
});
