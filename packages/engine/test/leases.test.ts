import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { Db } from '../src/storage/db.ts';
import { LEASE_TTL_MS, LeaseManager, matchGlob } from '../src/dag/lease.ts';

test('matchGlob + LeaseManager: intersection, exclusive, heartbeat, expiry, release', () => {
  assert.ok(matchGlob('src/b/**', 'src/b/x/y.ts'));
  assert.ok(matchGlob('src/**/*.ts', 'src/a.ts') && matchGlob('src/**/*.ts', 'src/a/b.ts'));
  assert.ok(!matchGlob('src/*.ts', 'src/a/b.ts'));
  assert.ok(matchGlob('shared.txt', 'shared.txt') && !matchGlob('shared.txt', 'shared.txt.bak'));
  let now = 1_000_000;
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'helix-lease-')), 'x.sqlite'));
  const m = new LeaseManager(db, () => now);
  const a = m.acquire('A', ['src/b/**']);
  assert.ok(a.lease);
  const b = m.acquire('B', ['src/b/x.ts']);
  assert.equal(b.lease, null);
  assert.equal(b.conflict?.holder, 'A');
  assert.ok(m.acquire('C', ['src/c/**']).lease, 'disjoint globs coexist');
  assert.ok(m.acquire('A', ['src/b/y.ts']).lease, 'same holder may extend');
  assert.equal(m.acquire('D', ['docs/x.md'], 'exclusive').lease, null, 'exclusive conflicts with any live lease');
  now += LEASE_TTL_MS - 1000;
  assert.ok(m.heartbeat(a.lease!.id));
  now += 30_000;
  assert.equal(m.acquire('B', ['src/b/x.ts']).lease, null, 'heartbeat kept A alive');
  now += LEASE_TTL_MS + 1;
  assert.ok(!m.heartbeat(a.lease!.id), 'expired lease cannot be revived');
  const late = m.acquire('B', ['src/b/x.ts']);
  assert.ok(late.lease, 'expired leases are ignored');
  m.release(late.lease!.id);
  assert.equal(m.active().length, 0);
});

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('DAG leases + worktrees + merge agent', async () => {
  const fake = await startFakeProvider('gemini', ({ request }) => {
    const contents = JSON.stringify(request.body.contents);
    const responded = contents.includes('functionResponse');
    if (contents.includes('You are the merge agent')) {
      if (!responded) return { toolCalls: [{ name: 'write_file', args: { path: 'shared.txt', content: 'line1\nK change\nL change\nline3\n' } }] };
      return { text: 'resolved shared.txt' };
    }
    const node = contents.match(/You are DAG node '(\w+)'/)?.[1] ?? '?';
    const turns = (contents.match(/functionResponse/g) ?? []).length;
    const say = (text: string) => ({ text, usage: { input: 10, output: 2 } });
    switch (node) {
      case 'S': // shared mode: write outside the lease first
        if (turns === 0) return { toolCalls: [{ name: 'write_file', args: { path: 'src/other.txt', content: 'no\n' } }] };
        if (turns === 1) return { toolCalls: [{ name: 'write_file', args: { path: 'src/ok/a.txt', content: 'ok\n' } }] };
        return say('finished S');
      case 'X': case 'Y':
        if (!responded) return { toolCalls: [{ name: 'write_file', args: { path: `src/${node.toLowerCase()}/${node.toLowerCase()}.txt`, content: `${node}\n` } }], delayMs: 200 };
        return say(`finished ${node}`);
      case 'Z':
        if (turns === 0) return { toolCalls: [{ name: 'run_shell', args: { command: 'cat src/x/x.txt src/y/y.txt' } }] };
        if (turns === 1) return { toolCalls: [{ name: 'write_file', args: { path: 'src/z.txt', content: 'Z\n' } }] };
        return say('finished Z');
      case 'K': case 'L':
        if (!responded) return { toolCalls: [{ name: 'write_file', args: { path: 'shared.txt', content: `line1\n${node} change\nline3\n` } }], delayMs: node === 'K' ? 100 : 600 };
        return say(`finished ${node}`);
      case 'V':
        if (!responded) return { toolCalls: [{ name: 'run_shell', args: { command: 'mkdir -p src/v && echo v > src/v/v.txt && echo sneaky > outside.txt' } }] };
        return say('finished V');
      default:
        return say(`finished ${node}`);
    }
  });
  const home = mkdtempSync(join(tmpdir(), 'helix-wt-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'helix-wt-repo-'));
  writeFileSync(join(repo, 'shared.txt'), 'line1\nbase\nline3\n');
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const head = gitIn(repo, 'rev-parse', 'HEAD');
  const engine = new Engine({ home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false, mcp: false, recover: false, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  const opts = { model: 'gemini-3.8-flash', policyProfile: 'headless' as const, preapprove: ['all'], maxSteps: 6 };
  try {
    // shared mode: write tools confined to the lease
    const shared = mkdtempSync(join(tmpdir(), 'helix-lease-shared-'));
    mkdirSync(join(shared, 'src'));
    const s = await engine.dags.wait(engine.dags.run({ ...opts, workspacePath: shared, nodes: [{ id: 'S', goal: 'Write files.', writeSet: ['src/ok/**'] }] }).id, 30_000);
    assert.equal(s.status, 'done', JSON.stringify(s.nodes));
    assert.ok(!existsSync(join(shared, 'src/other.txt')), 'write outside the lease was refused');
    assert.ok(existsSync(join(shared, 'src/ok/a.txt')));
    const sTranscript = engine.runtime.transcript(s.nodes[0].task!).flatMap((m) => m.parts as Array<{ type: string; content?: string; isError?: boolean }>);
    assert.ok(sTranscript.some((p) => p.type === 'tool_result' && /lease violation: src\/other\.txt is outside this task's write lease \(src\/ok\/\*\*\)/.test(p.content ?? '')));
    assert.equal(engine.dags.leases.active().length, 0, 'lease released');

    // worktrees: disjoint nodes in parallel, dependent starts from the merged integration tip
    const d1 = await engine.dags.wait(engine.dags.run({
      ...opts, workspacePath: repo, isolation: 'worktree', concurrency: 2,
      nodes: [{ id: 'X', goal: 'Part X.', writeSet: ['src/x/**'] }, { id: 'Y', goal: 'Part Y.', writeSet: ['src/y/**'] }, { id: 'Z', goal: 'Combine.', deps: ['X', 'Y'], writeSet: ['src/z.txt'] }],
    }).id, 60_000);
    assert.equal(d1.status, 'done', JSON.stringify(d1.nodes.map((n) => [n.id, n.status, n.error])));
    assert.equal(d1.branch, `helix/${d1.id}`);
    const n1 = Object.fromEntries(d1.nodes.map((n) => [n.id, n]));
    assert.deepEqual(n1.X.merge?.changed, ['src/x/x.txt']);
    assert.equal(n1.X.branch, `helix/${d1.id}-X`);
    const cat = engine.runtime.transcript(n1.Z.task!).flatMap((m) => m.parts as Array<{ type: string; name?: string; content?: string }>).find((p) => p.type === 'tool_result' && p.name === 'run_shell');
    assert.match(cat?.content ?? '', /X\s+Y/, 'Z worktree contains X and Y merges');
    assert.equal(gitIn(repo, 'show', `${d1.branch}:src/z.txt`), 'Z');
    assert.equal(gitIn(repo, 'show', `${d1.branch}:src/x/x.txt`), 'X');

    // concurrent unleased edits to the same file → merge conflict → merger subagent
    const d2 = await engine.dags.wait(engine.dags.run({ ...opts, workspacePath: repo, isolation: 'worktree', concurrency: 2, nodes: [{ id: 'K', goal: 'Edit shared K.' }, { id: 'L', goal: 'Edit shared L.' }] }).id, 60_000);
    assert.equal(d2.status, 'done', JSON.stringify(d2.nodes.map((n) => [n.id, n.status, n.error, n.merge])));
    const n2 = Object.fromEntries(d2.nodes.map((n) => [n.id, n]));
    assert.deepEqual(n2.K.merge?.conflicts, [], 'first merge is clean');
    assert.deepEqual(n2.L.merge?.conflicts, ['shared.txt']);
    assert.ok(n2.L.merge?.mergerTask?.startsWith('task'));
    assert.equal(gitIn(repo, 'show', `${d2.branch}:shared.txt`), 'line1\nK change\nL change\nline3');
    const mergeCommit = gitIn(repo, 'rev-list', '--parents', '-n', '1', d2.branch!).split(' ');
    assert.equal(mergeCommit.length, 3, 'merge commit has two parents');

    // shell writes outside the lease are caught at commit; dependents blocked
    const d3 = await engine.dags.wait(engine.dags.run({ ...opts, workspacePath: repo, isolation: 'worktree', nodes: [{ id: 'V', goal: 'Part V.', writeSet: ['src/v/**'] }, { id: 'W', goal: 'After V.', deps: ['V'] }] }).id, 60_000);
    const n3 = Object.fromEntries(d3.nodes.map((n) => [n.id, n]));
    assert.equal(d3.status, 'failed');
    assert.match(n3.V.error ?? '', /lease violation: changed outside\.txt outside src\/v\/\*\*/);
    assert.equal(n3.W.status, 'blocked');
    assert.throws(() => gitIn(repo, 'show', `${d3.branch}:outside.txt`), 'violating node was not merged');

    assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head, 'user checkout HEAD untouched');
    assert.equal(gitIn(repo, 'status', '--porcelain'), '', 'user working tree clean');
    assert.equal(gitIn(repo, 'worktree', 'list').split('\n').length, 1, 'node and integration worktrees removed');
    assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'line1\nbase\nline3\n');
    assert.equal(engine.dags.leases.active().length, 0);
  } finally {
    await engine.close();
    await fake.close();
  }
});
