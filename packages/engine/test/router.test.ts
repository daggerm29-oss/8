import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiAdapter } from '@helix/provider-gemini';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Db } from '../src/storage/db.ts';
import { EventBus } from '../src/events/bus.ts';
import { Tracer } from '../src/obs/tracing.ts';
import { Ledger } from '../src/models/ledger.ts';
import { ModelGateway } from '../src/models/gateway.ts';
import { Vault } from '../src/vault/vault.ts';
import { Engine } from '../src/engine.ts';
import { route, tierOf } from '../src/models/router.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const g = (model: string) => ({ provider: 'gemini', model });
const first = (d: { refs: Array<{ model: string }> }) => d.refs[0].model;
const userMsg = { messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'q' }] }] };

test('rule table: step type → tier over the role chain; escalation; open circuits last', () => {
  assert.deepEqual(['gemini-3.5-flash-lite', 'gpt-5-mini', 'gemini-3-flash', 'gemini-3-pro', 'claude-opus'].map(tierOf), ['S', 'S', 'M', 'L', 'L']);
  const chain = [g('g-pro'), g('g-flash'), g('g-flash-lite')];
  assert.equal(first(route({ step: 'summarize', chain })), 'g-flash-lite');
  assert.equal(first(route({ step: 'explore', chain })), 'g-flash-lite');
  assert.equal(first(route({ step: 'plan', chain })), 'g-pro');
  const edit = route({ step: 'edit', chain });
  assert.equal(first(edit), 'g-flash');
  assert.equal(edit.escalated, false);
  assert.match(edit.reason, /step=edit tier=M; pick gemini\/g-flash \[M\]/);
  const esc = route({ step: 'edit', chain, gateFailures: 1 });
  assert.equal(first(esc), 'g-pro');
  assert.match(esc.reason, /escalated M→L after failed gate \(1\)/);
  assert.equal(route({ step: 'plan', chain, gateFailures: 2 }).escalated, false, 'L cannot escalate further');
  const open = route({ step: 'edit', chain, isOpen: (r) => r.model === 'g-flash' });
  assert.deepEqual(open.refs.map((r) => r.model), ['g-pro', 'g-flash-lite', 'g-flash']);
  assert.match(open.reason, /circuit open: gemini\/g-flash/);
  assert.deepEqual(route({ step: 'edit', chain: [g('a'), g('b')] }).refs.map((r) => r.model), ['a', 'b'], 'same tier keeps configured order');
});

test('breaker: 5 consecutive failures, ≥50% errors in window, half-open after cooldown; router reason in ledger', async () => {
  let fail = true;
  let pattern: boolean[] | null = null;
  let calls = 0;
  const fake = await startFakeProvider('gemini', () => {
    calls++;
    const bad = pattern ? pattern.shift()! : fail;
    return bad ? { error: { status: 400, body: { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } } } } : { text: 'ok', usage: { input: 10, output: 2 } };
  });
  try {
    const db = new Db(':memory:');
    const ledger = new Ledger(db, new EventBus(db, { flushMs: 1 }));
    const gateway = new ModelGateway({
      adapters: [new GeminiAdapter()], vault: new Vault({ GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }), ledger, tracer: new Tracer(db, { otlpEndpoint: null }),
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, breaker: { threshold: 5, cooldownMs: 80, windowMs: 60_000, minCalls: 4 },
    });
    const call = (model: string) => gateway.call({ provider: 'gemini', model, role: 'coder', request: userMsg, task: 't1', routerReason: 'step=edit tier=M; pick test' });

    // Consecutive failures (window rate also trips at 4/4, so isolate the consecutive rule with a high minCalls model below).
    const g2 = new ModelGateway({
      adapters: [new GeminiAdapter()], vault: new Vault({ GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }), ledger, tracer: new Tracer(db, { otlpEndpoint: null }),
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, breaker: { threshold: 5, cooldownMs: 80, minCalls: 1000 },
    });
    for (let i = 0; i < 5; i++) {
      assert.equal(g2.isOpen('gemini', 'm-consec'), false, `closed before failure ${i + 1}`);
      await assert.rejects(g2.call({ provider: 'gemini', model: 'm-consec', role: 'coder', request: userMsg }), /bad/);
    }
    assert.equal(g2.isOpen('gemini', 'm-consec'), true, 'open after 5 consecutive failures');
    const before = calls;
    await assert.rejects(g2.call({ provider: 'gemini', model: 'm-consec', role: 'coder', request: userMsg }), /circuit open/);
    assert.equal(calls, before, 'open circuit does not reach the provider');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(g2.isOpen('gemini', 'm-consec'), false, 'half-open after cooldown');
    fail = false;
    const probe = await g2.call({ provider: 'gemini', model: 'm-consec', role: 'coder', request: userMsg });
    assert.equal(probe.message.parts[0].type, 'text');
    assert.equal(g2.isOpen('gemini', 'm-consec'), false, 'probe success closes it');

    // Error rate: ok, fail, ok, fail → 2/4 = 50% → open (consecutive count never exceeds 1).
    pattern = [false, true, false, true];
    await call('m-rate');
    await assert.rejects(call('m-rate'));
    await call('m-rate');
    assert.equal(gateway.isOpen('gemini', 'm-rate'), false, '1/3 errors stays closed');
    await assert.rejects(call('m-rate'));
    assert.equal(gateway.isOpen('gemini', 'm-rate'), true, '50% over the window opens');
    pattern = null;

    const reasons = db.all<{ router_reason: string | null; status: string }>(`SELECT router_reason, status FROM ledger_entries WHERE task = 't1'`);
    assert.equal(reasons.length, 4);
    assert.ok(reasons.every((r) => r.router_reason === 'step=edit tier=M; pick test'), 'ok and error entries carry the router reason');
  } finally {
    await fake.close();
  }
});

test('e2e: coder step routed to the M ref; after a failed gate the next step escalates to L with reason in ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-router-'));
  cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
  mkdirSync(join(dir, '.helix'), { recursive: true });
  writeFileSync(join(dir, '.helix', 'models.json'), JSON.stringify({ roles: { coder: { primary: 'gemini/gemini-mid', fallbacks: ['gemini/gemini-pro'] } } }));
  const pro: FakeTurn[] = [
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }], usage: { input: 900, output: 40 } },
    { text: 'Fixed subtract.', usage: { input: 1200, output: 10 } },
  ];
  let proTurns = 0;
  const fake = await startFakeProvider('gemini', ({ request }) => {
    const body = request.body as any;
    if (body.__model === 'gemini-mid') return { text: 'Looks fine to me.', usage: { input: 500, output: 10 } };
    return pro[Math.min(proTurns++, pro.length - 1)];
  });
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const engine = new Engine({ home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, taskRetryScale: 0.001, mcp: false } as never);
  try {
    const t = engine.runtime.create({ workspacePath: dir, goal: 'Fix the failing subtract test.', verifyCommand: 'node --test "test/*.test.js"', preapprove: ['exec', 'write'] });
    const s = await engine.runtime.wait(t.id, 60_000);
    assert.equal(s.status, 'done', s.error ?? '');
    assert.match(readFileSync(join(dir, 'src/calc.js'), 'utf8'), /return a - b;/);
    const entries = engine.ledger.entries({ task: t.id }) as Array<{ role: string; model: string; router_reason: string | null }>;
    const coder = entries.filter((e) => e.role === 'coder');
    assert.equal(coder[0].model, 'gemini-mid');
    assert.match(coder[0].router_reason ?? '', /^step=edit tier=M; pick gemini\/gemini-mid \[M\]$/);
    const after = coder.slice(1);
    assert.ok(after.length >= 2 && after.every((e) => e.model === 'gemini-pro'), `escalated steps use the L ref: ${after.map((e) => e.model)}`);
    assert.ok(after.every((e) => /escalated M→L after failed gate \(1\); pick gemini\/gemini-pro \[L\]/.test(e.router_reason ?? '')), after.map((e) => e.router_reason).join(' | '));
  } finally {
    await engine.close();
    await fake.close();
  }
});
