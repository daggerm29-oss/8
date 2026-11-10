import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ProviderError, type ProviderAdapter } from '@helix/protocol';
import { GeminiAdapter } from '@helix/provider-gemini';
import { OpenAIAdapter } from '@helix/provider-openai';
import { startFakeProvider, type FakeScript, type FakeServer } from '@helix/provider-conformance';
import { Db } from '../src/storage/db.ts';
import { EventBus } from '../src/events/bus.ts';
import { Tracer } from '../src/obs/tracing.ts';
import { Ledger, costOf } from '../src/models/ledger.ts';
import { BudgetExceededError, ModelGateway } from '../src/models/gateway.ts';
import { Vault, isDeniedHostPath } from '../src/vault/vault.ts';
import { globalRedactor } from '../src/util/redact.ts';

function setup(fake: FakeServer, opts: { breaker?: { threshold: number; cooldownMs: number }; maxRetries?: number } = {}) {
  const db = new Db(':memory:');
  const bus = new EventBus(db, { flushMs: 1 });
  const ledger = new Ledger(db, bus);
  const env = fake.kind === 'gemini' ? { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url } : { OPENAI_API_KEY: fake.apiKey, HELIX_OPENAI_BASE_URL: fake.url };
  const gateway = new ModelGateway({
    adapters: [new GeminiAdapter(), new OpenAIAdapter()], vault: new Vault(env), ledger, tracer: new Tracer(db, { otlpEndpoint: null }),
    retry: { maxRetries: opts.maxRetries ?? 2, baseDelayMs: 1, maxDelayMs: 5 }, breaker: opts.breaker,
  });
  db.run('INSERT INTO workspace (id, path, created_at) VALUES (?, ?, ?)', 'ws1', '/tmp/ws1', new Date().toISOString());
  return { db, bus, ledger, gateway };
}

const userMsg = (text: string) => ({ messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text }] }] });

test('F-MDL-1 AC1 / FR-5: one standalone provider package plugs into the public gateway without agent-core changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-provider-package-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@fixture/standalone-provider', version: '1.0.0', type: 'module', exports: './index.mjs' }));
  writeFileSync(join(dir, 'index.mjs'), `export default class StandaloneProvider {
    id = 'standalone'; defaultModel = 'fixture';
    bundledModels() { return [{ id: 'fixture', provider: this.id, displayName: 'Fixture', status: 'stable', contextWindow: 4096, maxOutput: 128, modalities: { input: ['text'], output: ['text'] }, tools: { supported: false, parallel: false, strictSchema: false, dialect: 'other' }, caching: { kind: 'none' }, pricing: { inputPerM: 1, outputPerM: 2, asOf: 'fixture' }, origin: 'bundled' }]; }
    async listModels() { return this.bundledModels(); }
    async countTokens() { return { inputTokens: 3, exact: false }; }
    normalizeError(error) { return error; }
    normalizeUsage(raw) { return { ...raw, source: 'provider', raw }; }
    async *stream(request, auth, signal) {
      signal.throwIfAborted();
      const message = { role: 'assistant', parts: [{ type: 'text', text: 'standalone package response' }] };
      yield { type: 'text_delta', text: message.parts[0].text };
      yield { type: 'done', message, finishReason: 'stop', responseId: 'standalone-1', usage: this.normalizeUsage({ inputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 0 }) };
    }
  }`);
  const { default: StandaloneProvider } = await import(pathToFileURL(join(dir, 'index.mjs')).href);
  const adapter: ProviderAdapter = new StandaloneProvider();
  const db = new Db(':memory:');
  const ledger = new Ledger(db);
  const gateway = new ModelGateway({ adapters: [adapter], vault: new Vault({}), ledger, tracer: new Tracer(db, { otlpEndpoint: null }) });
  try {
    assert.deepEqual((await gateway.listModels('standalone')).map((m) => m.id), ['fixture']);
    const result = await gateway.call({ provider: 'standalone', model: 'fixture', role: 'coder', task: 'package-proof', agent: 'primary', request: userMsg('hello') });
    assert.equal(result.message.parts[0].type === 'text' && result.message.parts[0].text, 'standalone package response');
    assert.equal(gateway.reconcile({ task: 'package-proof' }).ok, true);
    assert.equal(ledger.entries({ task: 'package-proof' })[0].provider, 'standalone');
  } finally { db.close(); }
});

test('verified Gemini 3.5 Flash-Lite Standard reference pricing includes thinking output and cached-input discount', () => {
  const price = new GeminiAdapter().bundledModels().find((m) => m.id === 'gemini-3.5-flash-lite')!.pricing;
  assert.ok(price);
  assert.match(price.note!, /ai\.google\.dev\/gemini-api\/docs\/pricing/);
  assert.equal(costOf(price, { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 }), 0.496);
  assert.equal(new GeminiAdapter().bundledModels().find((m) => m.id === 'gemini-3.6-flash')!.pricing, null);
});

test('costOf applies cached-input pricing and returns null for unknown prices', () => {
  const pricing = { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 10, asOf: 'x' };
  assert.equal(costOf(pricing, { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 }), 0.5 + 0.05 + 1);
  assert.equal(costOf(null, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }), null);
});

for (const kind of ['gemini', 'openai'] as const) {
  const model = kind === 'gemini' ? 'gemini-3.8-flash' : 'gpt-5-mini';

  test(`[${kind}] gateway ledger totals reconcile exactly with provider-reported usage`, async () => {
    const usages = [{ input: 1000, cached: 200, output: 50, reasoning: 10 }, { input: 1500, cached: 900, output: 80, reasoning: 0 }, { input: 2100, output: 120 }];
    const fake = await startFakeProvider(kind, ({ index }) => ({ text: `answer ${index}`, usage: usages[index] }));
    try {
      const { gateway, ledger, bus } = setup(fake);
      const seen: unknown[] = [];
      bus.subscribe('ledger.entry', (e) => void seen.push(e.data));
      for (let i = 0; i < 3; i++) {
        const r = await gateway.call({ provider: kind, model, role: 'coder', request: userMsg(`q${i}`), ws: 'ws1', task: 't1' });
        assert.equal(r.usage.source, 'provider');
        assert.ok((r.costUsd ?? 0) > 0);
      }
      const t = ledger.totals({ task: 't1' });
      assert.deepEqual(
        { calls: t.calls, input: t.inputTokens, cached: t.cachedInputTokens, output: t.outputTokens, reasoning: t.reasoningTokens },
        { calls: fake.reported.calls, input: fake.reported.input, cached: fake.reported.cached, output: fake.reported.output, reasoning: fake.reported.reasoning },
      );
      assert.equal(t.providerReportedCalls, 3);
      assert.equal(t.estimatedCalls, 0);
      const manifest = gateway.manifest(kind, model)!;
      const expected = usages.reduce((sum, u) => sum + (costOf(manifest.pricing, { inputTokens: u.input, cachedInputTokens: u.cached ?? 0, outputTokens: u.output }) ?? 0), 0);
      assert.ok(Math.abs(t.costUsd - expected) < 1e-12);
      assert.equal(seen.length, 3);
    } finally {
      await fake.close();
    }
  });
}

test('gateway retries transient errors with backoff and records each attempt', async () => {
  const script: FakeScript = ({ index }) => (index === 0 ? { error: { status: 503, body: { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } } } : { text: 'ok', usage: { input: 10, output: 2 } });
  const fake = await startFakeProvider('gemini', script);
  try {
    const { gateway, db } = setup(fake);
    const r = await gateway.call({ provider: 'gemini', model: 'gemini-3.8-flash', role: 'coder', request: userMsg('x'), task: 't2' });
    assert.equal(r.attempts, 2);
    const rows = db.all<{ status: string }>('SELECT status FROM ledger_entries WHERE task = ? ORDER BY rowid', 't2');
    assert.deepEqual(rows.map((x) => x.status), ['error', 'ok']);
  } finally {
    await fake.close();
  }
});

test('gateway does not retry auth errors; circuit breaker opens after repeated failures', async () => {
  const fake = await startFakeProvider('openai', () => ({ error: { status: 500, body: { error: { message: 'boom', type: 'server_error', code: null } } } }));
  try {
    const { gateway } = setup(fake, { breaker: { threshold: 2, cooldownMs: 60_000 }, maxRetries: 0 });
    await assert.rejects(gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('a') }), (e: ProviderError) => e.kind === 'transient');
    await assert.rejects(gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('b') }), (e: ProviderError) => e.kind === 'transient');
    const before = fake.requests.length;
    await assert.rejects(gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('c') }), (e: ProviderError) => /circuit open/.test(e.message));
    assert.equal(fake.requests.length, before, 'open breaker must not reach the provider');

    const auth = new ModelGateway({ adapters: [new OpenAIAdapter()], vault: new Vault({ OPENAI_API_KEY: 'bad-key-000000000', HELIX_OPENAI_BASE_URL: fake.url }), ledger: new Ledger(new Db(':memory:')), tracer: new Tracer(new Db(':memory:'), { otlpEndpoint: null }), retry: { baseDelayMs: 1 } });
    const n = fake.requests.length;
    await assert.rejects(auth.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('d') }), (e: ProviderError) => e.kind === 'auth');
    assert.equal(fake.requests.length, n + 1, 'auth errors are not retried');
  } finally {
    await fake.close();
  }
});

test('hard budget blocks the call before it reaches the provider; soft threshold emits an audit event', async () => {
  const fake = await startFakeProvider('openai', () => ({ text: 'ok', usage: { input: 400_000, output: 1000 } }));
  try {
    const { gateway, ledger, bus } = setup(fake);
    const events: string[] = [];
    bus.subscribe('budget.*', (e) => void events.push((e.data as { kind: string }).kind));
    ledger.setBudget({ scope: 'task', scopeId: 't3', softUsd: 0.05, hardUsd: 0.2 });
    await gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('first'), ws: 'ws1', task: 't3' }); // ~$0.102
    await gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('second'), ws: 'ws1', task: 't3' }); // soft crossed
    const before = fake.requests.length;
    await assert.rejects(gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('third'), ws: 'ws1', task: 't3' }), BudgetExceededError);
    assert.equal(fake.requests.length, before);
    assert.ok(events.includes('soft_threshold'));
    assert.ok(events.includes('hard_block'));
    ledger.setBudget({ scope: 'task', scopeId: 't4', hardTokens: 10 });
    await assert.rejects(gateway.call({ provider: 'openai', model: 'gpt-5-mini', role: 'coder', request: userMsg('tok'), task: 't4' }), BudgetExceededError);
  } finally {
    await fake.close();
  }
});

test('vault never exposes keys: host denylist covers Codex credentials and keys are redacted', () => {
  assert.ok(isDeniedHostPath(join(homedir(), '.codex', 'auth.json')));
  assert.ok(isDeniedHostPath(join(homedir(), '.ssh', 'id_ed25519')));
  assert.ok(!isDeniedHostPath('/tmp/project/src/index.ts'));
  const v = new Vault({ OPENAI_API_KEY: 'test-openai-secret-value-xyz' });
  assert.equal(v.providerAuth('openai').apiKey, 'test-openai-secret-value-xyz');
  assert.ok(!globalRedactor.redact('key=test-openai-secret-value-xyz').includes('secret-value'));
  assert.ok(Vault.secretEnvNames().includes('GEMINI_API_KEY'));
});

test('gemini 429s: per-minute limits stay retryable, daily quotas become non-retryable plan_limit', async () => {
  const { geminiHttpError } = await import('@helix/provider-gemini');
  const body = (desc: string, delay: string) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `You exceeded your current quota. ${desc}`, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } });
  const minute = geminiHttpError(429, body('Generate content requests per minute limit exceeded on Free Tier.', '39s'));
  assert.equal(minute.kind, 'rate_limit');
  assert.ok(minute.retryable);
  const day = geminiHttpError(429, body('Generate content requests per day limit exceeded on Free Tier.', '62749s'));
  assert.equal(day.kind, 'plan_limit');
  assert.ok(!day.retryable);
});

test('gateway logs capability degradations and records them on the model.call span (F-MDL-1 AC3)', async () => {
  const fake = await startFakeProvider('openai', () => ({ toolCalls: [{ name: 'read_file', args: { path: 'a' } }, { name: 'read_file', args: { path: 'b' } }] }));
  try {
    const db = new Db(':memory:');
    const bus = new EventBus(db, { flushMs: 1 });
    const tracer = new Tracer(db, { otlpEndpoint: null });
    const logged: Array<{ msg: string; f?: Record<string, unknown> }> = [];
    const logger = { info: (msg: string, f?: Record<string, unknown>) => void logged.push({ msg, f }), warn: () => {}, error: () => {}, debug: () => {} } as unknown as import('../src/util/log.ts').Logger;
    const { OPENAI_MODELS } = await import('@helix/provider-openai');
    const serialOnly = new OpenAIAdapter({ models: OPENAI_MODELS.map((m) => ({ ...m, tools: { ...m.tools, parallel: false } })) });
    const gateway = new ModelGateway({ adapters: [serialOnly], vault: new Vault({ OPENAI_API_KEY: fake.apiKey, HELIX_OPENAI_BASE_URL: fake.url }), ledger: new Ledger(db, bus), tracer, logger });
    const seen: string[] = [];
    const r = await gateway.call({
      provider: 'openai', model: 'gpt-5-mini', role: 'coder', task: 't1', onEvent: (e) => { if (e.type === 'notice') seen.push(e.feature); },
      request: { ...userMsg('read'), tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] },
    });
    assert.equal(r.message.parts.filter((p) => p.type === 'tool_call').length, 1);
    assert.deepEqual(seen, ['parallel_tool_calls']);
    assert.deepEqual(logged.filter((l) => l.msg === 'capability degraded').map((l) => l.f?.feature), ['parallel_tool_calls']);
    const row = db.get<{ events_json: string }>("SELECT events_json FROM spans WHERE name = 'model.call'");
    assert.ok(row && JSON.parse(row.events_json).some((e: { name: string }) => e.name === 'capability.degraded'), row?.events_json);
    assert.equal(fake.requests.at(-1)!.body.parallel_tool_calls, false);
  } finally {
    await fake.close();
  }
});
