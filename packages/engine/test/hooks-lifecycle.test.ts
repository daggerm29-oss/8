import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { loadHooks } from '../src/agent/skills.ts';

type HookDecl = { event: string; match?: string; run: string; permissions?: { write?: string[] } };

function repo(hooks: HookDecl[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helix-hooks-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Helix Test');
  git('config', 'user.email', 'test@helix.local');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  mkdirSync(join(dir, '.helix'), { recursive: true });
  writeFileSync(join(dir, '.helix/hooks.json'), JSON.stringify({ hooks }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
const head = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const stage = (dir: string) => { writeFileSync(join(dir, 'a.txt'), `${Math.random()}\n`); execFileSync('git', ['add', '-A'], { cwd: dir }); };
const newEngine = (extra: Record<string, unknown> = {}) => new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), mcp: false, ...extra } as never);

test('pre_commit: a non-zero exit blocks the commit and a zero exit lets it through', async () => {
  const dir = repo([{ event: 'pre_commit', run: 'if [ -e .helix/allow ]; then echo "hook: ok"; else echo "hook: lint failed"; exit 1; fi' }]);
  const engine = newEngine();
  try {
    const before = head(dir);
    stage(dir);
    await assert.rejects(() => engine.runtime.commit(dir, 'blocked change'), /commit blocked by pre_commit hook .* \(exit 1\)[\s\S]*hook: lint failed/);
    assert.equal(head(dir), before, 'no commit was created');

    writeFileSync(join(dir, '.helix/allow'), '');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const c = await engine.runtime.commit(dir, 'allowed change');
    assert.equal(c.subject, 'allowed change');
    assert.notEqual(head(dir), before);
  } finally {
    await engine.close();
  }
});

test('hook permissions: a write outside the declared globs is denied, rolled back and blocks the commit', async () => {
  const dir = repo([{
    event: 'pre_commit', permissions: { write: ['gen/**'] },
    run: 'mkdir -p gen && echo fine > gen/ok.txt && echo evil > evil.txt && echo tampered > a.txt; echo done',
  }]);
  const engine = newEngine();
  try {
    stage(dir);
    const original = readFileSync(join(dir, 'a.txt'), 'utf8');
    const before = head(dir);
    await assert.rejects(() => engine.runtime.commit(dir, 'x'), /commit blocked by pre_commit hook .* \(denied write\)[\s\S]*modified a\.txt, created evil\.txt/);
    assert.equal(existsSync(join(dir, 'evil.txt')), false, 'created file removed');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), original, 'modified file restored byte-for-byte');
    assert.equal(readFileSync(join(dir, 'gen/ok.txt'), 'utf8'), 'fine\n', 'declared path is kept');
    assert.equal(head(dir), before);
  } finally {
    await engine.close();
  }
});

test('hook permissions: a hook with no declaration may not write the workspace; a declared write passes', async () => {
  const dir = repo([
    { event: 'pre_commit', run: 'echo x > undeclared.txt' },
  ]);
  const engine = newEngine();
  try {
    stage(dir);
    await assert.rejects(() => engine.runtime.commit(dir, 'x'), /\(denied write\)[\s\S]*created undeclared\.txt/);
    assert.equal(existsSync(join(dir, 'undeclared.txt')), false);
    writeFileSync(join(dir, '.helix/hooks.json'), JSON.stringify({ hooks: [{ event: 'pre_commit', run: 'echo x > declared.txt', permissions: { write: ['declared.txt'] } }] }));
    execFileSync('git', ['add', '-A'], { cwd: dir });
    assert.equal((await engine.runtime.commit(dir, 'ok')).subject, 'ok');
  } finally {
    await engine.close();
  }
});

test('hooks.json: permissions must be workspace-relative globs', () => {
  const dir = repo([{ event: 'session_start', run: 'true', permissions: { write: ['../escape'] } }]);
  assert.throws(() => loadHooks(dir), /permissions\.write must be an array of workspace-relative globs/);
});

test('session_start: runs once per session, not once per turn', async () => {
  const dir = repo([{ event: 'session_start', run: 'echo started >> .helix/starts.txt; echo "ctx"', permissions: { write: ['.helix/starts.txt'] } }]);
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'run_shell', args: { command: 'echo one' } }], usage: { input: 100, output: 5 } },
    { toolCalls: [{ name: 'run_shell', args: { command: 'echo two' } }], usage: { input: 120, output: 5 } },
    { text: 'done', usage: { input: 140, output: 5 } },
  ];
  let i = 0;
  const fake = await startFakeProvider('gemini', () => turns[Math.min(i++, turns.length - 1)]);
  const engine = newEngine({ env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } });
  try {
    const starts = () => readFileSync(join(dir, '.helix/starts.txt'), 'utf8').trim().split('\n');
    const t = engine.runtime.create({ workspacePath: dir, goal: 'say done', preapprove: ['exec', 'write'] });
    const s = await engine.runtime.wait(t.id, 60_000);
    assert.equal(s.status, 'done', s.error ?? '');
    assert.equal(i, 3, 'three model turns');
    assert.deepEqual(starts(), ['started'], 'one session_start run across three turns');
    const arts = engine.runtime.artifacts(t.id, 'hook_output').map((a) => a.data as { event: string });
    assert.equal(arts.filter((a) => a.event === 'session_start').length, 1);

    const t2 = engine.runtime.create({ workspacePath: dir, goal: 'say done again', preapprove: ['exec', 'write'] });
    assert.equal((await engine.runtime.wait(t2.id, 60_000)).status, 'done');
    assert.deepEqual(starts(), ['started', 'started'], 'a new session runs it once more');
  } finally {
    await engine.close();
    await fake.close();
  }
});
