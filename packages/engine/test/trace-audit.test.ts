// R0.5 acceptance (NFR-10, F-OBS-1, F-OBS-3, SEC-9; architecture §26.1, §26.5): a scripted fake-model task yields the span tree
// task → agent.step → model.call | tool.call | gate.run | sandbox.exec | retrieval.query | snapshot.build, with token, latency and
// tool-I/O-ref attributes, and the audit log has an event for every §26.5 category and a hash chain that verifies.
// Fakes prove mechanics only: the provider is a local fake server and the browser used for snapshot.build is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer, type Message } from '@helix/protocol';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import { AUDIT_CATEGORIES, auditIntentOf } from '../src/events/audit.ts';
import { StatusCode, type StoredSpan } from '../src/obs/tracing.ts';
import { unshareAvailable } from '../src/sandbox/sandbox.ts';
import { CertAuthority } from '../src/sandbox/x509.ts';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/m0/js-calc', import.meta.url));
const MCP_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const VERIFY = 'node --test "test/*.test.js"';
const REAL_SECRET = 'real-secret-audit-5d1c';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

test('R0.10: unknown primary model costs stay unknown in tool spans and step records', async () => {
  const dir = tmp('helix-unpriced-tool-');
  cpSync(FIXTURE, dir, { recursive: true });
  const fake = await startFakeProvider('gemini', scripted([
    { toolCalls: [{ name: 'read_file', args: { path: 'src/calc.js' } }], usage: { input: 100, output: 10 } },
    { text: 'Read only.', usage: { input: 150, output: 5 } },
  ]));
  const engine = new Engine({ home: tmp('helix-unpriced-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, mcp: false });
  try {
    const task = engine.runtime.create({ workspacePath: dir, goal: 'Read the source.', provider: 'gemini', model: 'gemini-3.6-flash', verifyCommand: 'node -e 0' });
    const result = await engine.runtime.wait(task.id, 30_000);
    assert.equal(result.status, 'done');
    const spans = engine.tracer.spansForTask(task.id).filter((span) => span.name === 'tool.call');
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes['model.cost_known'], false);
    assert.equal(spans[0].attributes['model.cost_usd'], undefined);
    assert.equal(typeof spans[0].attributes['model.ledger.entry'], 'string');
    const steps = engine.runtime.steps(task.id).filter((step) => step.kind === 'model');
    assert.ok(steps.length > 0 && steps.every((step) => step.model?.costUsd === null));
    assert.equal(engine.gateway.reconcile({ task: task.id }).totals.ledger.costUsd, null);
  } finally { await engine.close(); await fake.close(); }
});

const GEMINI_TURNS: FakeTurn[] = [
  { toolCalls: [{ name: 'read_file', args: { path: 'src/calc.js' } }], usage: { input: 900, output: 30 } },
  { toolCalls: [{ name: 'code_search', args: { query: 'subtract' } }], usage: { input: 1200, cached: 700, output: 25 } },
  { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }], usage: { input: 1500, cached: 900, output: 60, reasoning: 12 } },
  { toolCalls: [{ name: 'run_shell', args: { command: 'echo traced' } }], usage: { input: 1700, cached: 1200, output: 20 } },
  { toolCalls: [{ name: 'run_shell', args: { command: 'git push origin feature-x' } }], usage: { input: 1800, cached: 1300, output: 22 } },
  { toolCalls: [{ name: 'run_shell', args: { command: 'pnpm publish --access public' } }], usage: { input: 1900, cached: 1400, output: 24 } },
  { toolCalls: [{ name: 'preview_snapshot', args: {} }], usage: { input: 2000, cached: 1500, output: 18 } },
  { text: 'Fixed subtract.', usage: { input: 2200, cached: 1700, output: 15 } },
];

const OPENAI_TURNS: FakeTurn[] = [
  { toolCalls: [{ name: 'run_shell', args: { command: 'echo approved-one' } }], usage: { input: 500, output: 20 } },
  { toolCalls: [{ name: 'run_shell', args: { command: 'echo denied-one' } }], usage: { input: 600, output: 20 } },
  { text: 'done', usage: { input: 700, output: 5 } },
];

const STUB_SNAPSHOT = {
  v: 1 as const, seq: 1, at: new Date().toISOString(),
  page: { url: 'http://127.0.0.1:9/', title: 'Stub', viewport: { w: 1280, h: 800 }, scroll: { y: 0, maxY: 0 } },
  ui: { tree: [], textDigest: 'abc' }, console: { newErrors: [], newWarnings: 0 }, network: { failed: [], slow: [], pending: 0 },
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('R0.5: scripted run produces the full span tree and one audit event per §26.5 category; the chain verifies and detects edits', { timeout: 300_000 }, async () => {
  const gemini = await startFakeProvider('gemini', scripted(GEMINI_TURNS));
  const openai = await startFakeProvider('openai', scripted(OPENAI_TURNS));

  // A local TLS upstream so a real proxy injection (credential use) happens.
  const upstreamCa = new CertAuthority('audit upstream CA');
  const seenAuth: string[] = [];
  const leaf = upstreamCa.leaf('api.example.test');
  const upstream = createServer({ key: leaf.key, cert: leaf.cert }, (q, r) => { seenAuth.push(String(q.headers.authorization)); q.resume(); r.end('ok\n'); });
  const upstreamPort = await new Promise<number>((res) => upstream.listen(0, '127.0.0.1', () => res((upstream.address() as { port: number }).port)));

  const home = tmp('helix-home-');
  const engine = new Engine({
    home, retry: { baseDelayMs: 1, maxDelayMs: 5 }, taskRetryScale: 0.001,
    env: { GEMINI_API_KEY: gemini.apiKey, HELIX_GEMINI_BASE_URL: gemini.url, OPENAI_API_KEY: openai.apiKey, HELIX_OPENAI_BASE_URL: openai.url },
    egressUpstream: { resolve: () => ({ host: '127.0.0.1', port: upstreamPort }), ca: upstreamCa.cert },
  });
  Object.assign(engine.browser, { available: () => true, snapshot: async () => STUB_SNAPSHOT });
  Object.assign(engine.devServers, { get: () => ({ url: 'http://127.0.0.1:9/', command: 'stub', port: 9 }) });
  const sock = await (async () => {
    const { port, token } = await engine.serve();
    const s = await new Promise<WebSocket>((resolve, reject) => { const w = new WebSocket(`ws://127.0.0.1:${port}/`); w.once('open', () => resolve(w)); w.once('error', reject); });
    const p = new RpcPeer(wsTransport(s));
    await p.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: [] });
    return { socket: s, peer: p };
  })();
  const { peer } = sock;
  try {
    // ---- Task 1: headless, verified, with retrieval, shell, denied push and publish, and a snapshot --------------------------------
    const repo = tmp('helix-trace-');
    cpSync(FIXTURE, repo, { recursive: true });
    const created = await peer.request<{ id: string }>(Methods.taskCreate, { workspacePath: repo, goal: 'The test suite is failing. Fix the bug.', provider: 'gemini', model: 'gemini-3.8-flash', verifyCommand: VERIFY });
    const done = await peer.request<{ status: string; error?: string }>(Methods.taskWait, { id: created.id, timeoutMs: 120_000 });
    assert.equal(done.status, 'done', done.error);
    const task1 = created.id;
    engine.bus.flush();

    const spans = engine.tracer.spansForTask(task1);
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const named = (n: string) => spans.filter((s) => s.name === n);
    const children = (s: StoredSpan) => spans.filter((c) => c.parentSpanId === s.spanId);

    // One trace, one root `task` span carrying the outcome and totals.
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, 'a single trace');
    const roots = spans.filter((s) => !s.parentSpanId);
    assert.equal(roots.length, 1);
    const root = roots[0];
    assert.equal(root.name, 'task');
    assert.equal(root.attributes['task.id'], task1);
    assert.equal(root.attributes['task.status'], 'done');
    assert.equal(root.statusCode, StatusCode.OK);
    const totals = engine.db.get<{ i: number; o: number; n: number }>('SELECT SUM(input_tokens) i, SUM(output_tokens) o, COUNT(*) n FROM ledger_entries WHERE task = ?', task1)!;
    assert.equal(root.attributes['usage.input_tokens'], totals.i);
    assert.equal(root.attributes['usage.output_tokens'], totals.o);
    assert.equal(root.attributes['usage.model_calls'], GEMINI_TURNS.length);
    for (const s of spans) if (s.parentSpanId) assert.ok(byId.has(s.parentSpanId), `${s.name} has its parent in the trace`);

    // Allowed parent → child edges of §26.1.
    const ALLOWED: Record<string, string[]> = {
      task: ['agent.step'], 'agent.step': ['model.call', 'tool.call', 'gate.run'],
      'tool.call': ['sandbox.exec', 'retrieval.query', 'snapshot.build'], 'gate.run': ['sandbox.exec'],
      'model.call': [], 'sandbox.exec': [], 'retrieval.query': [], 'snapshot.build': [],
    };
    for (const s of spans) {
      const parent = s.parentSpanId ? byId.get(s.parentSpanId)! : null;
      if (parent) assert.ok(ALLOWED[parent.name]?.includes(s.name), `${parent.name} → ${s.name} is not an allowed edge`);
    }
    for (const n of Object.keys(ALLOWED)) assert.ok(named(n).length >= 1, `at least one ${n} span`);

    // One agent.step span per model step, with tokens, latency, and cost matching the ledger; each owns exactly one model.call.
    const steps = engine.runtime.steps(task1);
    assert.equal(steps.length, GEMINI_TURNS.length);
    const modelSteps = named('agent.step').filter((s) => s.attributes['step.kind'] === 'model');
    assert.equal(modelSteps.length, steps.length, 'one agent.step span per step row');
    for (const step of steps) {
      const span = modelSteps.find((s) => s.attributes['step.id'] === step.id);
      assert.ok(span, `agent.step span for ${step.id}`);
      const ledger = engine.db.get<{ input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number | null }>(
        'SELECT l.input_tokens, l.cached_input_tokens, l.output_tokens, l.cost_usd FROM ledger_entries l JOIN steps s ON s.ledger_entry = l.id WHERE s.id = ?', step.id)!;
      assert.equal(span.attributes['usage.input_tokens'], ledger.input_tokens);
      assert.equal(span.attributes['usage.cached_input_tokens'], ledger.cached_input_tokens);
      assert.equal(span.attributes['usage.output_tokens'], ledger.output_tokens);
      assert.equal(span.attributes['usage.cost_usd'], ledger.cost_usd ?? undefined);
      assert.equal(typeof span.attributes.latency_ms, 'number');
      assert.ok((span.attributes.latency_ms as number) >= 0);
      const calls = children(span).filter((c) => c.name === 'model.call');
      assert.equal(calls.length, 1, 'one model.call per step');
      assert.equal(calls[0].attributes['usage.input_tokens'], ledger.input_tokens);
      assert.equal(calls[0].attributes['usage.output_tokens'], ledger.output_tokens);
      assert.equal(typeof calls[0].attributes.latency_ms, 'number');
      assert.equal(calls[0].attributes.provider, 'gemini');
      assert.equal(calls[0].attributes.outcome, 'ok');
      // The step's tool calls hang under that step, one tool.call span each.
      for (const tc of step.toolCalls) {
        const toolSpans: StoredSpan[] = children(span).filter((c) => c.name === 'tool.call' && c.attributes.call_id === tc.callId);
        assert.equal(toolSpans.length, 1, `one tool.call span for ${tc.tool}`);
      }
    }

    // One tool.call span per tool call row (denied ones too), with latency, policy decision, and I/O refs that resolve to the real I/O.
    const toolRows = engine.db.all<{ call_id: string; tool: string; args_json: string; status: string; result_tokens: number }>('SELECT call_id, tool, args_json, status, result_tokens FROM tool_calls WHERE task = ? ORDER BY at, rowid', task1);
    assert.equal(toolRows.length, GEMINI_TURNS.length - 1);
    assert.equal(named('tool.call').length, toolRows.length);
    // Fake-provider call ids repeat across turns, so rows, spans, and results are paired by order (all three are chronological).
    const results: string[] = [];
    for (const m of engine.runtime.transcript(task1) as Message[]) for (const p of m.parts) if (p.type === 'tool_result') results.push(p.content);
    const toolSpansInOrder = named('tool.call');
    assert.equal(results.length, toolRows.length);
    toolRows.forEach((row, i) => {
      const span = toolSpansInOrder[i];
      assert.ok(span, `span for ${row.tool}`);
      assert.equal(span.attributes.tool, row.tool);
      const owner = engine.db.get<{ step_id: string; ledger_entry: string; cost_usd: number | null; checkpoint: string; checkpoint_step: string }>(
        `SELECT tc.step AS step_id, s.ledger_entry, l.cost_usd, tc.checkpoint, c.step AS checkpoint_step FROM tool_calls tc JOIN steps s ON s.id = tc.step JOIN ledger_entries l ON l.id = s.ledger_entry JOIN checkpoints c ON c.id = tc.checkpoint WHERE tc.task = ? ORDER BY tc.at, tc.rowid LIMIT 1 OFFSET ?`, task1, i,
      );
      assert.ok(owner, 'primary tool row links durably to the generating step, ledger and checkpoint');
      assert.equal(span.attributes['model.step_id'], owner.step_id);
      assert.equal(span.attributes['model.ledger.entry'], owner.ledger_entry);
      assert.equal(span.attributes['model.cost_usd'], owner.cost_usd ?? undefined);
      assert.equal(span.attributes['model.cost_known'], owner.cost_usd !== null);
      assert.match(String(span.attributes['model.cost_basis']), /non-additive/);
      assert.equal(span.attributes['checkpoint.id'], owner.checkpoint);
      assert.equal(owner.checkpoint_step, owner.step_id);
      assert.equal(typeof span.attributes.latency_ms, 'number');
      assert.equal(span.attributes['policy.decision'], row.status === 'denied' ? 'deny' : 'allow');
      assert.equal(span.attributes.outcome, row.status === 'denied' ? 'denied' : row.status);
      assert.equal(span.attributes['tool.result_tokens'], row.result_tokens);
      assert.match(String(span.attributes['tool.input_ref']), /^blob:[a-f0-9]{64}$/);
      assert.match(String(span.attributes['tool.output_ref']), /^blob:[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(engine.blobs.getText(String(span.attributes['tool.input_ref']))), JSON.parse(row.args_json), 'input ref resolves to the tool arguments');
      assert.equal(engine.blobs.getText(String(span.attributes['tool.output_ref'])), results[i], 'output ref resolves to the tool result');
    });
    const denied = toolRows.filter((r) => r.status === 'denied').map((r) => r.tool);
    assert.equal(denied.length, 2, 'git push and publish were denied');

    // Nested spans: sandbox.exec under the shell tool call and under each gate, retrieval.query under code_search, snapshot.build under preview_snapshot.
    const toolSpan = (tool: string) => named('tool.call').find((s) => s.attributes.tool === tool)!;
    const shell = named('tool.call').find((s) => s.attributes.tool === 'run_shell' && s.attributes.outcome === 'ok')!;
    const exec = children(shell).filter((c) => c.name === 'sandbox.exec');
    assert.equal(exec.length, 1);
    assert.equal(exec[0].attributes.exit_code, 0);
    assert.equal(typeof exec[0].attributes['sandbox.provider'], 'string');
    assert.equal(children(toolSpan('code_search'))[0]?.name, 'retrieval.query');
    assert.equal(children(toolSpan('code_search'))[0]?.attributes.retriever, 'hybrid');
    assert.ok(Number(children(toolSpan('code_search'))[0]?.attributes.results) >= 1);
    assert.equal(children(toolSpan('preview_snapshot'))[0]?.name, 'snapshot.build');
    const verifyStep = named('agent.step').find((s) => s.attributes['step.kind'] === 'verify')!;
    const gate = children(verifyStep).find((c) => c.name === 'gate.run')!;
    assert.ok(gate);
    assert.equal(gate.attributes.passed, true);
    assert.equal(children(gate).filter((c) => c.name === 'sandbox.exec').length, 1);

    // `trace.get` serves the same tree over RPC (local trace viewer, §26.1).
    const rpc = await peer.request<{ spans: StoredSpan[] }>(Methods.traceGet, { task: task1 });
    assert.deepEqual(rpc.spans.map((s) => s.spanId), spans.map((s) => s.spanId));

    // ---- Task 2: interactive, one approval granted and one denied ----------------------------------------------------------------
    const repo2 = tmp('helix-trace-int-');
    cpSync(FIXTURE, repo2, { recursive: true });
    const t2 = await peer.request<{ id: string }>(Methods.taskCreate, { workspacePath: repo2, goal: 'run two commands', provider: 'openai', model: 'gpt-5-mini', policyProfile: 'interactive' });
    for (const approve of [true, false]) {
      let pending: { id: string } | undefined;
      for (let i = 0; i < 400 && !pending; i++) {
        pending = (engine.runtime.approvalList(t2.id) as Array<{ id: string; status: string }>).find((a) => a.status === 'pending');
        if (!pending) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(pending, 'an approval is pending');
      await peer.request(Methods.approvalRespond, { approvalId: pending.id, approved: approve });
    }
    assert.equal((await peer.request<{ status: string }>(Methods.taskWait, { id: t2.id, timeoutMs: 60_000 })).status, 'done');

    // ---- Direct actions for the remaining categories ----------------------------------------------------------------------------
    await peer.request(Methods.workspaceTrust, { workspacePath: repo, trusted: true, lightMode: false });
    await peer.request(Methods.workspaceTrust, { workspacePath: repo, trusted: false });
    await peer.request(Methods.budgetsSet, { scope: 'task', scopeId: task1, hardUsd: 5 });
    await peer.request(Methods.egressAllow, { workspacePath: repo, host: 'api.example.test' });
    await peer.request(Methods.secretsBind, { workspacePath: repo, name: 'API_TOKEN', injectHosts: ['api.example.test'], value: REAL_SECRET });
    let injected = false;
    if (unshareAvailable()) {
      const sbx = engine.runtime.sandboxFor(repo, 'sbx', { purpose: 'audit-test' });
      try {
        const r = await sbx.exec(`curl -sS -m 20 -H "Authorization: Bearer $API_TOKEN" https://api.example.test/v1/me; echo "exit=$?"`, { timeoutMs: 60_000 });
        injected = /ok[\s\S]*exit=0/.test(r.stdout);
      } finally { sbx.destroy(); }
      assert.ok(injected, 'the proxy injected the secret for the bound host');
      assert.deepEqual(seenAuth, [`Bearer ${REAL_SECRET}`]);
    }
    const added = await peer.request<{ state: string; tools: unknown[] }>(Methods.mcpAdd, { name: 'fake', command: process.execPath, args: [MCP_SERVER], env: { MARKER_FILE: join(home, 'marker.txt') } });
    assert.equal(added.state, 'connected');
    await peer.request(Methods.mcpTrust, { name: 'fake', trust: 'trusted' });
    await peer.request(Methods.mcpRemove, { name: 'fake' });
    assert.deepEqual(await peer.request(Methods.mcpList, {}), []);

    // ---- Audit coverage and the hash chain -----------------------------------------------------------------------------------------
    const verified = await peer.request<{ ok: boolean; rows: number; brokenAt: number | null; categories: Record<string, number> }>(Methods.auditVerify, {});
    assert.equal(verified.ok, true, `chain breaks at ${verified.brokenAt}`);
    assert.equal(verified.brokenAt, null);
    for (const category of AUDIT_CATEGORIES) assert.ok((verified.categories[category] ?? 0) >= 1, `audit has an event for category '${category}' (${JSON.stringify(verified.categories)})`);
    const topics = engine.db.all<{ topic: string }>('SELECT DISTINCT topic FROM audit_log').map((r) => r.topic);
    for (const t of ['approval.requested', 'approval.decided', 'policy.changed', 'workspace.trust_changed', 'secret.bound', 'git.push', 'deploy.requested', 'mcp.server_added', 'mcp.server_removed', 'mcp.trust_changed', 'budget.override']) assert.ok(topics.includes(t), `topic ${t} audited`);
    if (injected) assert.ok(topics.includes('secret.used'), 'credential use audited');
    const push = engine.db.get<{ decision: string; resource: string; actor: string }>(`SELECT decision, resource, actor FROM audit_log WHERE topic = 'git.push'`)!;
    assert.deepEqual({ decision: push.decision, resource: push.resource, actor: push.actor }, { decision: 'deny', resource: 'origin feature-x', actor: `agent:${task1}` });
    const decided = engine.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE topic = 'approval.decided' ORDER BY id`).map((r) => r.action);
    assert.deepEqual(decided, ['approved', 'denied']);

    // The export is JSONL in the §26.5 shape, covers every row, and never carries a secret value.
    const exported = (await peer.request<{ jsonl: string }>(Methods.auditExport, {})).jsonl;
    const lines = exported.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, verified.rows);
    for (const key of ['seq', 'at', 'actor', 'action', 'resource', 'decision', 'ruleId', 'details', 'prevHash', 'hash']) assert.ok(key in lines[0], `export has ${key}`);
    assert.deepEqual(lines.map((l) => l.seq), [...lines.map((l) => l.seq)].sort((a, b) => (a as number) - (b as number)));
    for (let i = 1; i < lines.length; i++) assert.equal(lines[i].prevHash, lines[i - 1].hash, 'export is a linked chain');
    assert.ok(!exported.includes(REAL_SECRET), 'no secret value in the audit export');
    assert.equal((await peer.request<{ jsonl: string }>(Methods.auditExport, { category: 'git_push' })).jsonl.trim().split('\n').length, 1);

    // Append-only: the database itself refuses edits and deletes.
    const target = engine.db.get<{ id: number; data_json: string; actor: string }>(`SELECT id, data_json, actor FROM audit_log WHERE topic = 'git.push'`)!;
    assert.throws(() => engine.db.run(`UPDATE audit_log SET data_json = ? WHERE id = ?`, '{"x":1}', target.id), /append-only/);
    assert.throws(() => engine.db.run(`DELETE FROM audit_log WHERE id = ?`, target.id), /append-only/);

    // Tamper with the file directly (triggers dropped, as an attacker with the SQLite file could): verify fails at exactly that row.
    engine.db.raw.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
    engine.db.run(`UPDATE audit_log SET data_json = ? WHERE id = ?`, target.data_json.replace('"decision":"deny"', '"decision":"allow"'), target.id);
    assert.notEqual(engine.db.get<{ data_json: string }>('SELECT data_json FROM audit_log WHERE id = ?', target.id)!.data_json, target.data_json, 'the edit changed the row');
    assert.equal(engine.bus.verifyAudit().brokenAt, target.id, 'edited details are detected at that row');
    engine.db.run(`UPDATE audit_log SET data_json = ? WHERE id = ?`, target.data_json, target.id);
    assert.equal(engine.bus.verifyAudit().ok, true, 'restored row verifies again');

    engine.db.run(`UPDATE audit_log SET actor = 'user' WHERE id = ?`, target.id);
    assert.equal(engine.bus.verifyAudit().brokenAt, target.id, 'the §26.5 record fields are covered by the hash');
    engine.db.run(`UPDATE audit_log SET actor = ? WHERE id = ?`, target.actor, target.id);

    const saved = engine.db.get<Record<string, unknown>>(`SELECT * FROM audit_log WHERE id = ?`, target.id)!;
    engine.db.run(`DELETE FROM audit_log WHERE id = ?`, target.id);
    assert.equal(engine.bus.verifyAudit().brokenAt, (engine.db.get<{ id: number }>('SELECT MIN(id) AS id FROM audit_log WHERE id > ?', target.id)!).id, 'a deleted row breaks the chain at the next row');
    const cols = Object.keys(saved);
    engine.db.run(`INSERT INTO audit_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => saved[c] as never));
    assert.equal(engine.bus.verifyAudit().ok, true);
  } finally {
    sock.socket.close();
    await engine.close();
    upstream.close();
    await gemini.close();
    await openai.close();
  }
});

test('audit: rows written before R0.5 (hash v1) still verify, and new rows chain onto them', () => {
  const engine = new Engine({ home: tmp('helix-home-'), recover: false, mcp: false, indexing: false });
  try {
    const GENESIS = '0'.repeat(64);
    const at = '2026-01-01T00:00:00.000Z';
    const hash = sha(`${GENESIS}|${at}|ws_old|task.status|evt_old|{"status":"done"}`);
    engine.db.run('INSERT INTO audit_log (at, ws, topic, event_id, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', at, 'ws_old', 'task.status', 'evt_old', '{"status":"done"}', GENESIS, hash);
    assert.equal(engine.bus.verifyAudit().ok, true);
    engine.bus.publish({ topic: 'budget.override', ws: 'engine', data: { scope: 'task', scopeId: 't', by: 'user' }, persist: 'audit' });
    const v = engine.bus.verifyAudit();
    assert.equal(v.ok, true);
    assert.equal(v.rows, 2);
    assert.deepEqual(v.categories, { legacy: 1, budget: 1 });
  } finally {
    void engine.close();
  }
});

test('audit intents: git push and deploy commands are recognised, other commands are not', () => {
  assert.deepEqual(auditIntentOf('run_shell', { command: 'git push origin main' }), { category: 'git_push', target: 'origin main' });
  assert.deepEqual(auditIntentOf('run_shell', { command: 'git -c x=y push --force' }), { category: 'git_push', target: 'default remote' });
  assert.equal(auditIntentOf('run_shell', { command: 'vercel deploy --prod' })?.category, 'deploy');
  assert.equal(auditIntentOf('run_shell', { command: 'pnpm publish' })?.category, 'deploy');
  assert.equal(auditIntentOf('run_shell', { command: 'kubectl apply -f x.yaml' })?.category, 'deploy');
  assert.equal(auditIntentOf('run_shell', { command: 'git status && echo push' }), null);
  assert.equal(auditIntentOf('read_file', { path: 'git push' }), null);
});
