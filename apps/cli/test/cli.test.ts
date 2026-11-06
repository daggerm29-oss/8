import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
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

test('helix prints usage and exits 2 without a prompt', async () => {
  const r = await run([], { HELIX_HOME: mkdtempSync(join(tmpdir(), 'helix-cli-home-')) });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Usage:/);
});
