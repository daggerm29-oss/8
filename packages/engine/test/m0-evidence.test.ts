import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '@helix/provider-conformance';
import { providerEvidence, runCli } from '../../../evals/m0-evidence.ts';
import { Engine } from '../src/engine.ts';

const price = { inputPerM: 0.30, cachedInputPerM: 0.03, outputPerM: 2.50, asOf: '2026-11-10' };
const row = { id: 'live-usage', provider: 'gemini', model: 'gemini-3.5-flash-lite', status: 'ok', usage_source: 'provider', provider_response_id: 'response-id', input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_tokens: 20, cost_usd: 0.000496, provider_usage_json: JSON.stringify({ promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 80, thoughtsTokenCount: 20, serviceTier: 'standard' }) };

test('G0.1 evidence independently reconciles raw provider tokens and published standard pricing', () => {
  const result = providerEvidence([row], () => price)[0];
  assert.equal(result.pass, true);
  assert.equal(result.expected?.costUsd, 0.000496);
  assert.deepEqual(result.deltaPct, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 });
  assert.equal(providerEvidence([{ ...row, input_tokens: 1020 }], () => price)[0].pass, false);
  assert.equal(providerEvidence([{ ...row, cost_usd: 0.00051 }], () => price)[0].pass, false);
});

test('G0.1 evidence rejects unknown pricing, null cost, estimated usage and missing raw responses', () => {
  const unpriced = providerEvidence([row], () => null)[0];
  assert.equal(unpriced.pass, false);
  assert.equal(unpriced.expected?.costUsd, null);
  assert.equal(unpriced.deltaPct?.costUsd, null);
  assert.equal(providerEvidence([{ ...row, cost_usd: null }], () => price)[0].pass, false);
  assert.equal(providerEvidence([{ ...row, usage_source: 'estimate' }], () => price)[0].pass, false);
  assert.equal(providerEvidence([{ ...row, provider_usage_json: null }], () => price)[0].pass, false);
});

test('G0.1 CLI helper resumes a persisted task in a distinct real Engine process (A-local fake only)', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-eval-cli-fixture-'));
  const home = mkdtempSync(join(tmpdir(), 'helix-eval-cli-home-'));
  cpSync(fileURLToPath(new URL('../../../fixtures/m0/js-calc', import.meta.url)), dir, { recursive: true });
  const turns = [
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }] },
    { text: 'Fixed subtract.' },
  ];
  const fake = await startFakeProvider('gemini', ({ index }) => turns[Math.min(index, turns.length - 1)]);
  const oldEnv = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, HELIX_GEMINI_BASE_URL: process.env.HELIX_GEMINI_BASE_URL };
  let engine: Engine | undefined;
  try {
    process.env.GEMINI_API_KEY = fake.apiKey;
    process.env.HELIX_GEMINI_BASE_URL = fake.url;
    engine = new Engine({ home, mcp: false });
    const priorId = engine.id;
    const task = engine.runtime.create({ workspacePath: dir, goal: 'Fix subtract.', provider: 'gemini', model: 'gemini-3.5-flash-lite', verifyCommand: 'node --test "test/*.test.js"', start: false });
    await engine.close();
    engine = undefined;
    const result = await runCli(['resume', task.id], home, 45_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.equal(result.summary?.status, 'done');
    engine = new Engine({ home, recover: false, mcp: false });
    const owners = engine.db.all<{ owner_engine: string }>('SELECT owner_engine FROM sandboxes WHERE labels_json LIKE ?', `%${task.id}%`);
    assert.ok(owners.length > 0 && owners.every((owner) => owner.owner_engine !== priorId));
    const events = engine.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE task = ? AND topic = 'task.resumed'", task.id);
    assert.ok(events.some((event) => JSON.parse(event.data_json).previousOwner === null), 'a persisted task created with start:false has no previous execution owner');
  } finally {
    await engine?.close();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fake.close();
  }
});
