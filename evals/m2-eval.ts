/**
 * M2 eval (offline, roadmap "M2 eval"):
 *   1. MCP tool-definition tokens per model turn with 200 MCP tools (tool search on) ≤ 3000.
 *   2. Cost of a scripted MCP task with M2 defaults vs a baseline engine (tool search, cache and result truncation off) ≤ 50%.
 *   3. Element→source accuracy on a generated 24-target fixture page ≥ 95%.
 * The fake Gemini provider reports input tokens = full request size / 4, so the ledger prices both runs with the real manifest.
 *
 * Run: node --disable-warning=ExperimentalWarning evals/m2-eval.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '../packages/protocol/src/index.ts';
import { startFakeProvider, type FakeTurn } from '../packages/providers/conformance/src/index.ts';
import { Engine, wsTransport } from '../packages/engine/src/engine.ts';
import { findChrome } from '../packages/engine/src/preview/browser.ts';

type WebSocket = Parameters<typeof wsTransport>[0] & { once(ev: string, fn: (...a: unknown[]) => void): void; close(): void };
const { WebSocket } = createRequire(new URL('../packages/engine/package.json', import.meta.url))('ws') as { WebSocket: new (url: string) => WebSocket };
const MCP_SERVER = fileURLToPath(new URL('./fixtures/many-tools-mcp.mjs', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const MODEL = 'gemini-3.8-flash';
const TOOL_COUNT = 200;
const MCP_TOKEN_LIMIT = 3000;
const COST_RATIO_LIMIT = 0.5;
const E2S_LIMIT = 0.95;
const FORECAST = 'mcp__many__weather_get_forecast';
const MCP_META = new Set(['tool_search', 'mcp_read_result']);

const tokensOf = (v: unknown) => Math.ceil(JSON.stringify(v ?? '').length / 4);
type Decl = { name: string };

async function runMcpTask(mode: 'm2' | 'baseline') {
  const perTurn: Array<{ turn: number; declaredTools: number; mcpDeclared: number; mcpDefTokens: number; inputTokens: number }> = [];
  const steps: FakeTurn[] = [
    ...(mode === 'm2' ? [{ toolCalls: [{ name: 'tool_search', args: { query: 'weather forecast city' } }] }] : []),
    { toolCalls: [{ name: FORECAST, args: { city: 'Oslo' } }] },
    { toolCalls: [{ name: FORECAST, args: { city: 'Oslo' } }] },
    { text: 'Oslo will be mild with light wind and some rain in the afternoon.' },
  ];
  const fake = await startFakeProvider('gemini', ({ request, index }) => {
    const body = request.body as { tools?: Array<{ functionDeclarations?: Decl[] }> };
    const decls = (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
    const mcpDecls = decls.filter((d) => d.name.startsWith('mcp__') || MCP_META.has(d.name));
    const inputTokens = tokensOf(body);
    perTurn.push({ turn: index + 1, declaredTools: decls.length, mcpDeclared: mcpDecls.length, mcpDefTokens: tokensOf(mcpDecls), inputTokens });
    return { ...(steps[index] ?? { text: 'done' }), usage: { input: inputTokens, output: 40 } };
  });
  const repo = mkdtempSync(join(tmpdir(), `helix-m2-${mode}-`));
  writeFileSync(join(repo, 'README.md'), '# weather notes\n');
  const engine = new Engine({
    home: mkdtempSync(join(tmpdir(), `helix-m2-home-${mode}-`)),
    env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false, recover: false, retry: { baseDelayMs: 1, maxDelayMs: 2 },
    mcpServers: { many: { command: process.execPath, args: [MCP_SERVER], env: { TOOL_COUNT: String(TOOL_COUNT) }, trust: 'trusted', ...(mode === 'baseline' ? { cacheTtlMs: 0, maxResultChars: 10_000_000 } : {}) } },
    ...(mode === 'baseline' ? { mcpToolSearchThreshold: 100_000 } : {}),
  });
  try {
    const status = await engine.mcpReady;
    const registered = status.find((s) => s.name === 'many')?.tools.length ?? 0;
    const t = engine.runtime.create({ workspacePath: repo, goal: 'What is the weather forecast for Oslo?', model: MODEL, policyProfile: 'headless', maxSteps: 10 });
    engine.runtime.start(t.id);
    const done = await engine.runtime.wait(t.id, 60_000);
    const totals = engine.ledger.totals({ task: t.id });
    const forecastResults = engine.runtime.transcript(t.id).flatMap((m) => m.parts as Array<{ type: string; name?: string; content?: string }>)
      .filter((p) => p.type === 'tool_result' && p.name === FORECAST).map((p) => p.content?.length ?? 0);
    return {
      mode, status: done.status, error: done.error ?? null, registeredMcpTools: registered, toolSearch: engine.mcp.toolSearchEnabled,
      cacheHits: engine.mcp.cacheStats.hits, forecastResultChars: forecastResults, perTurn,
      totals: { calls: totals.calls, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: totals.costUsd },
    };
  } finally {
    await engine.close();
    await fake.close();
  }
}

type Target = { id: string; x: number; y: number; kind: 'attribute' | 'ancestor' | 'text'; path: string; line: number };

function buildE2sFixture() {
  const files: Record<string, string> = {};
  const html: string[] = [];
  const targets: Target[] = [];
  const words = ['amber', 'birch', 'cobalt', 'dune', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kelp', 'lagoon'];
  const pos = (i: number) => ({ left: 40 + (i % 4) * 300, top: 40 + Math.floor(i / 4) * 90 });
  let slot = 0;
  for (let i = 0; i < 12; i++) {
    const { left, top } = pos(slot++);
    const name = `Widget${i}`;
    files[`src/${name}.jsx`] = `export function ${name}() {\n  return (\n    <button className="w${i} btn">Action ${words[i]}</button>\n  );\n}\n`;
    html.push(`<button data-helix-loc="src/${name}.jsx:3:5" class="w${i} btn" style="position:absolute;left:${left}px;top:${top}px;width:200px;height:40px">Action ${words[i]}</button>`);
    targets.push({ id: name, x: left + 100, y: top + 20, kind: 'attribute', path: `src/${name}.jsx`, line: 3 });
  }
  for (let i = 0; i < 6; i++) {
    const { left, top } = pos(slot++);
    const name = `Card${i}`;
    files[`src/${name}.jsx`] = `export function ${name}() {\n  return (\n    <div className="card c${i}">\n      <span className="title">Card ${words[i]} title</span>\n    </div>\n  );\n}\n`;
    html.push(`<div data-helix-loc="src/${name}.jsx:3:5" class="card c${i}" style="position:absolute;left:${left}px;top:${top}px;width:240px;height:60px;padding:10px;box-sizing:border-box"><span class="title" style="display:inline-block;width:200px;height:30px">Card ${words[i]} title</span></div>`);
    targets.push({ id: name, x: left + 100, y: top + 25, kind: 'ancestor', path: `src/${name}.jsx`, line: 3 });
  }
  const sentences = ['Orders ship within two business days', 'Your trial converts to monthly billing', 'Invite teammates from the members page', 'Export reports as spreadsheet downloads', 'Archived projects stay readable forever', 'Support replies faster on weekdays'];
  for (let i = 0; i < 6; i++) {
    const { left, top } = pos(slot++);
    const name = `Note${i}`;
    files[`src/${name}.jsx`] = `export function ${name}() {\n  return (\n    <section>\n      <p className="note n${i}">${sentences[i]}</p>\n    </section>\n  );\n}\n`;
    html.push(`<p class="note n${i}" style="position:absolute;left:${left}px;top:${top}px;margin:0;width:260px">${sentences[i]}</p>`);
    targets.push({ id: name, x: left + 40, y: top + 8, kind: 'text', path: `src/${name}.jsx`, line: 4 });
  }
  files['page.html'] = `<!doctype html><title>Fixture</title><body style="margin:0;font:14px sans-serif">\n${html.join('\n')}\n</body>`;
  files['package.json'] = JSON.stringify({ name: 'e2s-eval', scripts: { dev: 'node server.js' } });
  files['server.js'] = `const html = require('fs').readFileSync(__dirname + '/page.html', 'utf8');\nrequire('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(html); }).listen(Number(process.env.PORT), '127.0.0.1');\n`;
  return { files, targets };
}

async function runElementSource() {
  if (!findChrome()) return { skipped: 'no Chrome/Chromium', total: 0, correct: 0, accuracy: 0, results: [] };
  const { files, targets } = buildE2sFixture();
  const root = mkdtempSync(join(tmpdir(), 'helix-m2-e2s-'));
  mkdirSync(join(root, 'src'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-m2-e2s-home-')), env: {}, recover: false, mcp: false, indexing: false });
  const results: Array<Target & { got: string | null; strategy: string | null; confidence: number | null; ok: boolean }> = [];
  try {
    engine.index(root);
    const { port, token } = await engine.serve({ ui: false });
    const sock = await new Promise<WebSocket>((res, rej) => { const s = new WebSocket(`ws://127.0.0.1:${port}/`); s.once('open', () => res(s)); s.once('error', rej); });
    const peer = new RpcPeer(wsTransport(sock));
    await peer.request(Methods.initialize, { clientName: 'm2-eval', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: [] });
    await peer.request(Methods.previewStart, { workspacePath: root }, 90_000);
    for (const t of targets) {
      const r = await peer.request(Methods.previewLocate, { workspacePath: root, x: t.x, y: t.y }, 30_000) as { source: { path: string; line: number; strategy: string; confidence: number } | null };
      const s = r.source;
      const ok = !!s && s.path === t.path && (t.kind === 'text' || s.line === t.line);
      results.push({ ...t, got: s ? `${s.path}:${s.line}` : null, strategy: s?.strategy ?? null, confidence: s?.confidence ?? null, ok });
    }
    sock.close();
  } finally {
    await engine.close();
  }
  const correct = results.filter((r) => r.ok).length;
  return { total: results.length, correct, accuracy: correct / results.length, results };
}

const started = Date.now();
const m2 = await runMcpTask('m2');
const baseline = await runMcpTask('baseline');
const e2s = await runElementSource();

const maxMcpDefTokens = Math.max(...m2.perTurn.map((p) => p.mcpDefTokens));
const baselineMaxMcpDefTokens = Math.max(...baseline.perTurn.map((p) => p.mcpDefTokens));
const costRatio = baseline.totals.costUsd > 0 ? m2.totals.costUsd / baseline.totals.costUsd : Infinity;
const checks = {
  mcpRegistered200: m2.registeredMcpTools === TOOL_COUNT && baseline.registeredMcpTools === TOOL_COUNT,
  tasksDone: m2.status === 'done' && baseline.status === 'done',
  mcpTokensPerTurn: maxMcpDefTokens <= MCP_TOKEN_LIMIT,
  costVsBaseline: costRatio <= COST_RATIO_LIMIT,
  elementSource: !('skipped' in e2s) && e2s.accuracy >= E2S_LIMIT,
};
const pass = Object.values(checks).every(Boolean);
const report = {
  eval: 'm2', at: new Date().toISOString(), model: MODEL, pass, checks, ms: Date.now() - started,
  mcp: { tools: TOOL_COUNT, limit: MCP_TOKEN_LIMIT, maxMcpDefTokensPerTurn: maxMcpDefTokens, baselineMaxMcpDefTokensPerTurn: baselineMaxMcpDefTokens },
  cost: { m2Usd: m2.totals.costUsd, baselineUsd: baseline.totals.costUsd, ratio: costRatio, limit: COST_RATIO_LIMIT, m2InputTokens: m2.totals.inputTokens, baselineInputTokens: baseline.totals.inputTokens },
  elementSource: { total: e2s.total, correct: e2s.correct, accuracy: e2s.accuracy, limit: E2S_LIMIT },
  runs: { m2, baseline }, e2sResults: e2s.results,
};
mkdirSync(RESULTS, { recursive: true });
const out = join(RESULTS, `m2-eval-${report.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));

console.log(`M2 EVAL: ${pass ? 'PASS' : 'FAIL'} (${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks)`);
console.log(`  MCP tool-definition tokens/turn @${TOOL_COUNT} tools: max ${maxMcpDefTokens} (limit ${MCP_TOKEN_LIMIT}); baseline ${baselineMaxMcpDefTokens}`);
console.log(`  Cost: M2 $${m2.totals.costUsd.toFixed(6)} vs baseline $${baseline.totals.costUsd.toFixed(6)} → ${(costRatio * 100).toFixed(1)}% (limit ${COST_RATIO_LIMIT * 100}%); input tokens ${m2.totals.inputTokens} vs ${baseline.totals.inputTokens}`);
console.log(`  Element→source: ${e2s.correct}/${e2s.total} = ${(e2s.accuracy * 100).toFixed(1)}% (limit ${E2S_LIMIT * 100}%)${'skipped' in e2s ? ` skipped: ${e2s.skipped}` : ''}`);
for (const r of e2s.results.filter((x) => !x.ok)) console.log(`    miss ${r.id} (${r.kind}): expected ${r.path}:${r.line}, got ${r.got ?? 'none'}`);
if (!checks.tasksDone) console.log(`  task status: m2=${m2.status} ${m2.error ?? ''} baseline=${baseline.status} ${baseline.error ?? ''}`);
console.log(`  result: ${out.slice(out.indexOf('evals/'))}`);
process.exit(pass ? 0 : 1);
