import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';

const BIN = fileURLToPath(new URL('../bin/helix', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../fixtures/m0/js-calc', import.meta.url));

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('helix -p fixes the fixture end to end over a spawned stdio engine and exits 0', async () => {
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/calc.js' } }], usage: { input: 800, output: 20 } },
    { toolCalls: [{ name: 'edit_file', args: { path: 'src/calc.js', old_string: 'export function subtract(a, b) {\n  return a + b;', new_string: 'export function subtract(a, b) {\n  return a - b;' } }], usage: { input: 1200, output: 40 } },
    { text: 'Fixed subtract().', usage: { input: 1500, output: 10 } },
  ];
  const fake = await startFakeProvider('gemini', ({ index }) => turns[Math.min(index, turns.length - 1)]);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'helix-cli-'));
    cpSync(FIXTURE, dir, { recursive: true });
    const env = { HELIX_HOME: mkdtempSync(join(tmpdir(), 'helix-cli-home-')), GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url };
    const r = await run(['-p', 'fix the failing test', '-C', dir, '--verify', 'node --test "test/*.test.js"', '--provider', 'gemini', '-m', 'gemini-3.8-flash', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.status, 'done');
    assert.equal(summary.result, 'Fixed subtract().');
    assert.equal(summary.ledger.calls, 3);
    assert.match(r.stderr, /verify #1: passed/);
    assert.ok(readFileSync(join(dir, 'src/calc.js'), 'utf8').includes('a - b'));
    const list = await run(['tasks'], env);
    assert.match(list.stdout, new RegExp(`${summary.id}\\s+done`));
  } finally {
    await fake.close();
  }
});

for (const mode of ['run', '-p'] as const) {
  for (const outcome of ['success', 'gate', 'budget'] as const) {
    test(`R0.7 golden ${mode} --json: ${outcome}`, { timeout: 60_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helix-cli-golden-'));
      const fake = await startFakeProvider('gemini', ({ index }) => outcome === 'gate' && index === 0
        ? { toolCalls: [{ name: 'write_file', args: { path: 'fail-gate', content: 'fail' } }], usage: { input: 100, output: 10 } }
        : { text: 'All done.', usage: { input: 100, output: 10 } });
      const env = { HELIX_HOME: mkdtempSync(join(tmpdir(), 'helix-cli-home-')), GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url };
      try {
        const taskFile = join(dir, 'task.yaml');
        writeFileSync(taskFile, `goal: Golden task\nworkspacePath: .\nprovider: gemini\nmodel: gemini-3.8-flash\n${outcome === 'gate' ? 'verifyCommand: test ! -f fail-gate\n' : ''}${outcome === 'budget' ? 'budgetUsd: 0\n' : ''}`);
        const args = mode === 'run' ? ['run', taskFile] : ['-p', 'Golden task', '-C', dir, '--provider', 'gemini', '-m', 'gemini-3.8-flash', ...(outcome === 'gate' ? ['--verify', 'test ! -f fail-gate'] : []), ...(outcome === 'budget' ? ['--budget', '0'] : [])];
        const result = await run([...args, '--json', '-q'], env);
        const summary = JSON.parse(result.stdout);
        const golden = JSON.stringify({ code: result.code, status: summary.status, result: summary.result, reason: summary.error?.startsWith('BudgetExceededError:') ? 'budget' : summary.error?.startsWith('verification failed') ? 'gate' : summary.error, goal: summary.goal, provider: summary.provider, model: summary.model, workspaceMatches: summary.workspacePath === dir });
        const expected = {
          success: '{"code":0,"status":"done","result":"All done.","reason":null,"goal":"Golden task","provider":"gemini","model":"gemini-3.8-flash","workspaceMatches":true}',
          gate: '{"code":2,"status":"failed","result":null,"reason":"gate","goal":"Golden task","provider":"gemini","model":"gemini-3.8-flash","workspaceMatches":true}',
          budget: '{"code":3,"status":"failed","result":null,"reason":"budget","goal":"Golden task","provider":"gemini","model":"gemini-3.8-flash","workspaceMatches":true}',
        }[outcome];
        assert.equal(golden, expected, result.stderr);
        assert.equal(result.stderr, '', 'quiet mode produces no progress output');
        if (outcome === 'budget') assert.equal(fake.requests.length, 0, 'hard budget enforced before provider call');
      } finally { await fake.close(); rmSync(dir, { recursive: true, force: true }); rmSync(env.HELIX_HOME, { recursive: true, force: true }); }
    });
  }
}

test('R0.7 YAML validation rejects interactive policy, duplicate keys and nonfinite budgets before starting engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-cli-invalid-'));
  try {
    for (const yaml of ['goal: x\npolicyProfile: interactive', 'goal: x\ngoal: y', 'goal: x\nbudgetUsd: .nan', 'goal: x\nunknown: true']) {
      const file = join(dir, 'task.yaml');
      writeFileSync(file, yaml);
      const r = await run(['run', file, '--json'], { HELIX_HOME: join(dir, 'home') });
      assert.notEqual(r.code, 0);
      assert.equal(r.stdout, '');
      assert.equal(existsSync(join(dir, 'home')), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R0.7 -p text output golden', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-cli-text-'));
  const fake = await startFakeProvider('gemini', () => ({ text: 'All done.' }));
  try {
    const r = await run(['-p', 'Golden task', '-C', dir, '--provider', 'gemini', '-m', 'gemini-3.8-flash', '-q'], { HELIX_HOME: join(dir, 'home'), GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url });
    assert.deepEqual(r, { code: 0, stdout: 'All done.\n', stderr: '' });
  } finally { await fake.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('helix prints usage and exits 2 without a prompt', async () => {
  const r = await run([], { HELIX_HOME: mkdtempSync(join(tmpdir(), 'helix-cli-home-')) });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Usage:/);
});

test('helix audit verify / export and helix trace: MCP changes are audited through the engine, the chain verifies, the span tree prints (R0.5)', async () => {
  const turns: FakeTurn[] = [{ text: 'Nothing to change.', usage: { input: 300, output: 5 } }];
  const fake = await startFakeProvider('gemini', ({ index }) => turns[Math.min(index, turns.length - 1)]);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'helix-cli-'));
    cpSync(FIXTURE, dir, { recursive: true });
    const env = { HELIX_HOME: mkdtempSync(join(tmpdir(), 'helix-cli-home-')), GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url, MARKER_FILE: join(dir, 'marker.txt') };
    const server = fileURLToPath(new URL('../../../packages/engine/test/fixtures/fake-mcp-server.mjs', import.meta.url));

    const added = await run(['mcp', 'add', 'fake', '--', process.execPath, server], env);
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /added MCP server 'fake' \(connected, \d+ tools\)/);
    assert.equal((await run(['mcp', 'trust', 'fake', 'trusted'], env)).code, 0);

    const run1 = await run(['-p', 'check it', '-C', dir, '--provider', 'gemini', '-m', 'gemini-3.8-flash', '--json', '-q'], env);
    assert.equal(run1.code, 0, run1.stderr);
    const task = JSON.parse(run1.stdout).id as string;

    const trace = await run(['trace', task], env);
    assert.equal(trace.code, 0, trace.stderr);
    assert.match(trace.stdout, /^task .* \[done\]$/m);
    assert.match(trace.stdout, /^ {2}agent\.step model .* \[ok\]$/m);
    assert.match(trace.stdout, /^ {4}model\.call .*\d+ in\/\d+ out .*\[ok\]$/m);

    assert.equal((await run(['mcp', 'remove', 'fake'], env)).code, 0);
    assert.equal((await run(['mcp', 'remove', 'fake'], env)).code, 1, 'removing an unknown server fails');

    const verify = await run(['audit', 'verify', '--json'], env);
    assert.equal(verify.code, 0, verify.stderr);
    const v = JSON.parse(verify.stdout);
    assert.equal(v.ok, true);
    assert.equal(v.categories.mcp, 3, 'add, trust change, remove');
    assert.ok(v.categories.policy >= 1);

    const exported = (await run(['audit', 'export', '--category', 'mcp'], env)).stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(exported.map((e) => e.action), ['server_added', 'trust_changed', 'server_removed']);
    assert.equal(exported[0].actor, 'user');
  } finally {
    await fake.close();
  }
});
