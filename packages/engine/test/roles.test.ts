import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { ModelPolicyError, parseRef, parseRoleFlags, policyVerdict, resolveRoles, type RoleLayers } from '../src/models/roles.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const base = { provider: 'gemini', model: 'base-model' };
const str = (r: { provider: string; model: string }) => `${r.provider}/${r.model}`;

test('parseRef + flags', () => {
  assert.deepEqual(parseRef('gemini/gemini-x'), { provider: 'gemini', model: 'gemini-x' });
  assert.deepEqual(parseRef('openai:gpt-5-mini'), { provider: 'openai', model: 'gpt-5-mini' });
  assert.deepEqual(parseRef('bare', 'gemini'), { provider: 'gemini', model: 'bare' });
  assert.throws(() => parseRef('bare'), ModelPolicyError);
  assert.throws(() => parseRef(''), ModelPolicyError);
  assert.deepEqual(parseRoleFlags(['coder=gemini/a,openai/b']), { coder: { primary: 'gemini/a', fallbacks: ['openai/b'] } });
  assert.throws(() => parseRoleFlags(['wizard=gemini/a']), /unknown role/);
});

test('resolution order: task > workspace > user; unset roles inherit coder; policy deny + forced', () => {
  const layers: RoleLayers = { user: { coder: 'gemini/user-coder', summarizer: 'gemini/user-sum' }, workspace: { coder: { primary: 'gemini/ws-coder', fallbacks: ['openai/ws-fb'] } } };
  let r = resolveRoles(base, layers);
  assert.equal(r.coder.chain.map(str).join(','), 'gemini/ws-coder,openai/ws-fb');
  assert.equal(r.coder.source, 'workspace');
  assert.equal(str(r.summarizer.chain[0]), 'gemini/user-sum');
  assert.equal(r.summarizer.source, 'user');
  assert.equal(r.reviewer.chain.map(str).join(','), 'gemini/ws-coder,openai/ws-fb', 'unset role inherits coder');
  assert.equal(r.reviewer.source, 'default');

  r = resolveRoles(base, layers, {}, true);
  assert.equal(str(r.coder.chain[0]), 'gemini/base-model', 'explicit task model overrides coder');
  assert.equal(r.coder.source, 'task');
  r = resolveRoles(base, layers, { summarizer: 'cheap' });
  assert.equal(str(r.summarizer.chain[0]), 'gemini/cheap', 'bare model gets the base provider');

  r = resolveRoles(base, { ...layers, policy: { denyProviders: ['openai'], forced: { planner: 'gemini/forced-planner' } } }, { planner: 'gemini/task-planner' });
  assert.equal(r.coder.chain.map(str).join(','), 'gemini/ws-coder');
  assert.match(r.coder.dropped[0].reason, /denied by org policy/);
  assert.equal(str(r.planner.chain[0]), 'gemini/forced-planner');
  assert.equal(r.planner.source, 'policy');

  assert.equal(policyVerdict({ provider: 'gemini', model: 'gemini-pro' }, { allowModels: ['gemini/*-flash*'] })?.includes('allow list'), true);
  assert.equal(policyVerdict({ provider: 'gemini', model: 'gemini-3-flash' }, { allowModels: ['gemini/*-flash*'], denyModels: ['gemini/gemini-3-*'] })?.includes('denied'), true, 'deny wins over allow');
  assert.equal(policyVerdict({ provider: 'gemini', model: 'gemini-3-flash' }, { allowModels: ['gemini/*-flash*'] }), null);
  assert.throws(() => resolveRoles(base, layers, { wizard: 'x' } as never), /unknown role/);
});

function isSummarizer(body: any): boolean {
  return JSON.stringify(body?.systemInstruction ?? '').includes('You compress the earlier part');
}

test('e2e: summarizer uses its own model, coder falls back on 5xx, ledger records role per entry, policy blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-roles-'));
  cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
  mkdirSync(join(dir, '.helix'), { recursive: true });
  writeFileSync(join(dir, '.helix', 'models.json'), JSON.stringify({ roles: { summarizer: 'gemini/gemini-sum', coder: { primary: 'gemini/gemini-broken', fallbacks: ['gemini/gemini-3.8-flash'] } } }));
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  writeFileSync(join(home, 'policy.json'), JSON.stringify({ models: { denyModels: ['gemini/*-forbidden'] } }));
  const coder: FakeTurn[] = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/calc.js' } }], usage: { input: 900, output: 30 } },
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }], usage: { input: 1400, output: 60 } },
    { toolCalls: [{ name: 'run_shell', args: { command: 'node --test "test/*.test.js"' } }], usage: { input: 1900, output: 30 } },
    { text: 'Fixed subtract.', usage: { input: 2300, output: 20 } },
  ];
  const seen: Array<{ model: string; summarizer: boolean }> = [];
  let coderTurns = 0;
  const fake = await startFakeProvider('gemini', ({ request }) => {
    const body = request.body as any;
    seen.push({ model: body.__model, summarizer: isSummarizer(body) });
    if (body.__model === 'gemini-broken') return { error: { status: 503, body: { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } } };
    if (isSummarizer(body)) return { text: JSON.stringify({ decisions: ['s'], factsLearned: [], filesTouched: [], openQuestions: [], failingChecks: [], userPreferences: [] }), usage: { input: 200, output: 30 } };
    return coder[Math.min(coderTurns++, coder.length - 1)];
  });
  const engine = new Engine({
    home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url },
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, breaker: { threshold: 100 }, taskRetryScale: 0.001, mcp: false,
    compaction: { triggerTokens: 1, keepRecentTurns: 1, minSliceTokens: 0 },
  } as never);
  try {
    const t = engine.runtime.create({ workspacePath: dir, goal: 'Fix the failing subtract test.', verifyCommand: 'node --test "test/*.test.js"', preapprove: ['exec', 'write'] });
    assert.equal(t.model, 'gemini-broken', 'task model = coder primary from workspace config');
    const s = await engine.runtime.wait(t.id, 60_000);
    assert.equal(s.status, 'done', s.error ?? '');
    assert.match(readFileSync(join(dir, 'src/calc.js'), 'utf8'), /return a - b;/);

    assert.ok(seen.some((x) => x.summarizer), 'compaction ran');
    assert.ok(seen.filter((x) => x.summarizer).every((x) => x.model === 'gemini-sum'), 'summarizer calls go to the summarizer model');
    assert.ok(seen.filter((x) => !x.summarizer && x.model !== 'gemini-broken').every((x) => x.model === 'gemini-3.8-flash'));

    const entries = engine.ledger.entries({ task: t.id }) as Array<{ role: string; model: string; status: string }>;
    assert.ok(entries.length > 0 && entries.every((e) => typeof e.role === 'string' && e.role.length > 0), 'every ledger entry has a role');
    assert.ok(entries.some((e) => e.role === 'summarizer' && e.model === 'gemini-sum'));
    assert.ok(entries.some((e) => e.role === 'coder' && e.model === 'gemini-broken' && e.status === 'error'));
    assert.ok(entries.some((e) => e.role === 'coder' && e.model === 'gemini-3.8-flash' && e.status === 'ok'));

    engine.bus.flush();
    const fallbacks = engine.db.all<{ data_json: string }>(`SELECT data_json FROM events WHERE task = ? AND topic = 'model.fallback'`, t.id);
    assert.ok(fallbacks.length >= 1, 'fallback event recorded');
    assert.match(fallbacks[0].data_json, /gemini\/gemini-broken/);

    const roles = engine.runtime.artifacts(t.id, 'roles')[0].data as any;
    assert.equal(roles.summarizer.source, 'workspace');

    const tree = engine.runtime.tree(t.id);
    assert.ok(tree.length >= 4, 'one node per step');
    assert.deepEqual(tree.map((s) => s.idx), [...tree.keys()], 'steps in order');
    const allTools = tree.flatMap((s) => s.toolCalls.map((c) => c.tool));
    for (const name of ['read_file', 'edit_file', 'run_shell']) assert.ok(allTools.includes(name), `tree has ${name}`);
    const allCalls = tree.flatMap((s) => s.modelCalls);
    assert.equal(allCalls.length, entries.length, 'every ledger entry is attached to a step');
    assert.ok(allCalls.some((c) => c.model === 'gemini/gemini-broken' && c.status !== 'ok' && c.error));

    const models = engine.runtime.models(t.id);
    assert.equal(models.roles.coder.chain.length, 2);
    const coderBroken = models.usage.find((u) => u.role === 'coder' && u.model === 'gemini/gemini-broken');
    assert.ok(coderBroken && coderBroken.errors === coderBroken.calls && coderBroken.calls >= 1);
    assert.ok(models.usage.some((u) => u.role === 'summarizer' && u.model === 'gemini/gemini-sum'));
    assert.ok(models.fallbacks.length >= 1 && models.fallbacks[0].from === 'gemini/gemini-broken');

    assert.throws(() => engine.runtime.create({ workspacePath: dir, goal: 'x', model: 'gemini-forbidden', start: false }), /no allowed model for role 'coder'.*denied by org policy/);
  } finally {
    await engine.close();
    await fake.close();
  }
});
