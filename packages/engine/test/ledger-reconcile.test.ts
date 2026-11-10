import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { ATTRIBUTION_FIELDS, attributeRequest, costOf } from '../src/models/ledger.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const SPECS = [
  { name: 'js-calc', verify: 'node --test "test/*.test.js"', file: 'src/calc.js', old: 'export function subtract(a, b) {\n  return a + b;', new: 'export function subtract(a, b) {\n  return a - b;' },
  { name: 'py-strings', verify: 'python3 -m unittest -q', file: 'strings_util.py', old: 'return "-".join(words)', new: 'return "-".join(w.lower() for w in words)' },
  { name: 'ts-inventory', verify: 'node --test "test/*.test.ts"', file: 'src/inventory.ts', old: 'i < items.length - 1', new: 'i < items.length' },
];
const PROVIDERS = [
  { kind: 'gemini' as const, model: 'gemini-3.8-flash' },
  { kind: 'openai' as const, model: 'gpt-5-mini' },
];
const RUNS = 2;
const TURNS = 5;

/** Varied usage shapes: cached input, reasoning, and turns where the fake derives usage from the request. */
function solver(spec: (typeof SPECS)[number], run: number): FakeTurn[] {
  const k = run + 1;
  return [
    { toolCalls: [{ name: 'run_shell', args: { command: spec.verify } }], usage: { input: 900 * k, output: 40 } },
    { toolCalls: [{ name: 'read_file', args: { path: spec.file } }], usage: { input: 1400 * k, cached: 800, output: 30 } },
    { toolCalls: [{ name: 'edit_file', args: { path: spec.file, old_string: spec.old, new_string: spec.new } }], usage: { input: 1900 * k, cached: 1300, output: 60 + run, reasoning: 20 } },
    { toolCalls: [{ name: 'run_shell', args: { command: spec.verify } }] },
    { text: `Fixed the bug in ${spec.file}.`, usage: { input: 2600 * k, cached: 2000, output: 25, reasoning: 7 * run } },
  ];
}

test('attributeRequest splits the prompt by kind and attributes tool-result tokens by tool', () => {
  const a = attributeRequest({
    system: 'x'.repeat(40),
    tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'u'.repeat(8) }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } }, { type: 'tool_call', id: 'c2', name: 'run_shell', args: { command: 'ls' } }] },
      { role: 'tool', parts: [
        { type: 'tool_result', callId: 'c1', name: 'read_file', content: 'f'.repeat(391), provenance: { source: 'repo', trust: 'untrusted', taint: true } },
        { type: 'tool_result', callId: 'c2', name: 'run_shell', content: 's'.repeat(31), provenance: { source: 'builtin', trust: 'trusted', taint: false } },
      ] },
    ],
  });
  assert.deepEqual(a.toolTokens, { read_file: 100, run_shell: 10 });
  assert.equal(a.contextBreakdown.system, 10);
  assert.equal(a.contextBreakdown.user, 2);
  assert.equal(a.contextBreakdown.tool_results, 110);
  assert.ok(a.contextBreakdown.tool_specs > 0 && a.contextBreakdown.tool_calls > 0);
});

test('R0.4: over 50 recorded provider responses, every ledger row is attributed and totals reconcile within 1%', { timeout: 600_000 }, async () => {
  const fakes = Object.fromEntries(await Promise.all(PROVIDERS.map(async (p) => {
    const turns = SPECS.flatMap((s) => Array.from({ length: RUNS }, (_, run) => solver(s, run))).flat();
    // Sequential tasks: turn i of the whole run maps to the i-th scripted response for this provider.
    return [p.kind, await startFakeProvider(p.kind, ({ index }) => turns[index])] as const;
  })));
  const engine = new Engine({
    home: mkdtempSync(join(tmpdir(), 'helix-home-')),
    env: { GEMINI_API_KEY: fakes.gemini.apiKey, HELIX_GEMINI_BASE_URL: fakes.gemini.url, OPENAI_API_KEY: fakes.openai.apiKey, HELIX_OPENAI_BASE_URL: fakes.openai.url },
    retry: { baseDelayMs: 1, maxDelayMs: 5 }, taskRetryScale: 0.001,
  });
  try {
    const tasks: string[] = [];
    for (const p of PROVIDERS) {
      for (const spec of SPECS) {
        for (let run = 0; run < RUNS; run++) {
          const dir = mkdtempSync(join(tmpdir(), `helix-rec-${spec.name}-`));
          cpSync(join(FIXTURES, spec.name), dir, { recursive: true });
          const created = engine.runtime.create({ workspacePath: dir, goal: 'The test suite is failing. Fix the bug.', provider: p.kind, model: p.model, verifyCommand: spec.verify });
          const done = await engine.runtime.wait(created.id, 120_000);
          assert.equal(done.status, 'done', `${p.kind}/${spec.name}#${run}: ${done.error ?? ''}`);
          tasks.push(created.id);
        }
      }
    }

    const responses = fakes.gemini.reported.calls + fakes.openai.reported.calls;
    assert.equal(responses, PROVIDERS.length * SPECS.length * RUNS * TURNS);
    assert.ok(responses >= 50, `${responses} provider responses`);

    // Every row: agent, task, tool, provider, model, role.
    const rows = engine.db.all<Record<string, string | null>>(`SELECT * FROM ledger_entries`);
    assert.equal(rows.length, responses);
    for (const r of rows) {
      for (const f of ATTRIBUTION_FIELDS) {
        const v = f === 'tool' ? r.tool_tokens_json : r[f];
        assert.ok(v !== null && v !== '', `row ${r.id} missing ${f}`);
      }
      assert.ok(tasks.includes(r.task!), 'row attributed to a task this test created');
      assert.equal(r.usage_source, 'provider');
    }
    // Tool attribution is real: after a run_shell / read_file result, the next prompt carries that tool's tokens.
    const toolNames = new Set(rows.flatMap((r) => Object.keys(JSON.parse(r.tool_tokens_json!))));
    assert.deepEqual([...toolNames].sort(), ['edit_file', 'read_file', 'run_shell']);
    assert.ok(rows.every((r) => JSON.parse(r.context_breakdown_json!).system > 0));

    // Ledger totals vs what the provider servers independently reported, per provider and overall.
    const expected = { input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 };
    for (const p of PROVIDERS) {
      const rep = fakes[p.kind].reported;
      const t = engine.db.get<Record<string, number>>(
        `SELECT SUM(input_tokens) i, SUM(cached_input_tokens) c, SUM(output_tokens) o, SUM(reasoning_tokens) r, SUM(cost_usd) usd FROM ledger_entries WHERE provider = ? AND status = 'ok'`, p.kind,
      )!;
      const reportedCost = costOf(engine.gateway.manifest(p.kind, p.model)!.pricing, { inputTokens: rep.input, cachedInputTokens: rep.cached, outputTokens: rep.output })!;
      const within = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 0.01 * b, `${p.kind} ${what}: ledger ${a} vs provider ${b}`);
      within(t.i, rep.input, 'input');
      within(t.c, rep.cached, 'cached');
      within(t.o, rep.output, 'output');
      within(t.r, rep.reasoning, 'reasoning');
      within(t.usd, reportedCost, 'cost');
      expected.input += rep.input;
      expected.cached += rep.cached;
      expected.output += rep.output;
      expected.reasoning += rep.reasoning;
      expected.cost += reportedCost;
    }
    const all = engine.ledger.totals({});
    assert.ok(Math.abs(all.inputTokens - expected.input) <= 0.01 * expected.input);
    assert.ok(Math.abs(all.outputTokens - expected.output) <= 0.01 * expected.output);
    assert.ok(Math.abs(all.costUsd - expected.cost) <= 0.01 * expected.cost, `cost ${all.costUsd} vs ${expected.cost}`);

    // The Engine's own reconciliation report (RPC ledger.reconcile) agrees.
    const report = engine.gateway.reconcile();
    assert.equal(report.ok, true, JSON.stringify(report, null, 1));
    assert.equal(report.providerReportedRows, responses);
    assert.deepEqual(report.missingAttribution, []);
    assert.equal(report.groups.length, 2);
    assert.ok(report.totals.maxDeltaPct <= 1);
    assert.notEqual(report.totals.ledger.costUsd, null);
    console.log(`[R0.4] ${responses} responses; ledger $${report.totals.ledger.costUsd!.toFixed(6)} vs provider $${expected.cost.toFixed(6)}; max delta ${report.totals.maxDeltaPct.toFixed(4)}%`);

    // Negative controls: unknown prices never become zero or pass the cost gate.
    const victim = rows[3].id;
    const originalCost = engine.db.get<{ cost_usd: number }>('SELECT cost_usd FROM ledger_entries WHERE id = ?', victim)!.cost_usd;
    engine.db.run('UPDATE ledger_entries SET cost_usd = NULL WHERE id = ?', victim);
    const unpriced = engine.gateway.reconcile();
    assert.equal(unpriced.ok, false);
    assert.deepEqual(unpriced.unpricedRows, [victim]);
    assert.equal(unpriced.totals.ledger.costUsd, null);
    engine.db.run('UPDATE ledger_entries SET cost_usd = ? WHERE id = ?', originalCost, victim);
    const noPrices = engine.ledger.reconcile({ normalizeUsage: (provider, raw) => engine.gateway.adapter(provider).normalizeUsage!(raw), pricing: () => null });
    assert.equal(noPrices.ok, false);
    assert.equal(noPrices.unpricedRows.length, responses);
    assert.equal(noPrices.totals.providerReported.costUsd, null);

    // Negative controls: the report must catch drift, attribution gaps, and estimate-only rows.
    engine.db.run('UPDATE ledger_entries SET input_tokens = input_tokens + 100000 WHERE id = ?', victim);
    const drift = engine.gateway.reconcile();
    assert.equal(drift.ok, false);
    assert.ok(drift.totals.maxDeltaPct > 1);
    engine.db.run('UPDATE ledger_entries SET input_tokens = input_tokens - 100000, agent = NULL WHERE id = ?', victim);
    const gap = engine.gateway.reconcile();
    assert.deepEqual(gap.missingAttribution, [{ id: victim, missing: ['agent'] }]);
    assert.equal(gap.ok, false);
    engine.db.run(`UPDATE ledger_entries SET agent = 'primary', usage_source = 'estimate' WHERE id = ?`, victim);
    const est = engine.gateway.reconcile();
    assert.deepEqual(est.estimatedRows, [victim]);
    assert.equal(est.ok, false);
  } finally {
    await engine.close();
    await fakes.gemini.close();
    await fakes.openai.close();
  }
});
