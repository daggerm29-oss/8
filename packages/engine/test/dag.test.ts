import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { globsOverlap, planDag, type DagState } from '../src/dag/scheduler.ts';

test('globsOverlap + planDag validation and critical-path priority', () => {
  assert.ok(globsOverlap('src/b/**', 'src/b/e.ts'));
  assert.ok(globsOverlap('src/**', 'src/b/*.ts'));
  assert.ok(!globsOverlap('src/b/**', 'src/c/**'));
  assert.ok(!globsOverlap('src/a.ts', 'src/b.ts'));
  assert.ok(globsOverlap('src/a.ts', 'src/a.ts'));
  const p = planDag([{ id: 'a', goal: 'x' }, { id: 'b', goal: 'x', deps: ['a'] }, { id: 'c', goal: 'x', deps: ['b'] }, { id: 'z', goal: 'x' }]);
  assert.deepEqual([p.get('a'), p.get('b'), p.get('c'), p.get('z')], [3, 2, 1, 1]);
  assert.throws(() => planDag([{ id: 'a', goal: 'x', deps: ['b'] }, { id: 'b', goal: 'x', deps: ['a'] }]), /cycle/);
  assert.throws(() => planDag([{ id: 'a', goal: 'x', deps: ['a'] }]), /cycle/);
  assert.throws(() => planDag([{ id: 'a', goal: 'x', deps: ['nope'] }]), /unknown node 'nope'/);
  assert.throws(() => planDag([{ id: 'a', goal: 'x' }, { id: 'a', goal: 'y' }]), /duplicate/);
});

const FILE: Record<string, string> = { A: 'src/a.txt', B: 'src/b/b.txt', C: 'src/c/c.txt', E: 'src/b/e.ts', D: 'src/d.txt', P: 'p.txt', Q: 'q.txt', R: 'r.txt', G: 'g.txt', H: 'h.txt' };

test('DAG scheduler: parallel disjoint siblings, overlap serialized, briefs, priority, failure blocking, persistence', async () => {
  const briefs = new Map<string, string>();
  const fake = await startFakeProvider('gemini', ({ request }) => {
    const contents = JSON.stringify(request.body.contents);
    const node = contents.match(/You are DAG node '(\w+)'/)?.[1] ?? '?';
    if (!briefs.has(node)) briefs.set(node, contents);
    if (node === 'F') return { error: { status: 400, body: { error: { code: 400, message: 'invalid request for F', status: 'INVALID_ARGUMENT' } } } };
    if (!contents.includes('functionResponse')) return { toolCalls: [{ name: 'write_file', args: { path: FILE[node], content: `${node}\n` } }], delayMs: 400, usage: { input: 10, output: 5 } };
    return { text: `finished ${node}`, usage: { input: 10, output: 2 } };
  });
  const home = mkdtempSync(join(tmpdir(), 'helix-dag-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'helix-dag-repo-'));
  writeFileSync(join(repo, 'README.md'), '# dag\n');
  const env = { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url };
  const opts = { workspacePath: repo, model: 'gemini-3.8-flash', policyProfile: 'headless' as const, preapprove: ['all'], maxSteps: 4 };
  let engine = new Engine({ home, env, indexing: false, mcp: false, recover: false, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  let mainId = '';
  try {
    const started = engine.dags.run({
      ...opts, concurrency: 2,
      nodes: [
        { id: 'A', goal: 'Create the base file.', writeSet: ['src/a.txt'] },
        { id: 'B', goal: 'Build part B.', deps: ['A'], writeSet: ['src/b/**'] },
        { id: 'C', goal: 'Build part C.', deps: ['A'], writeSet: ['src/c/**'] },
        { id: 'E', goal: 'Add e.ts to part B.', deps: ['A'], writeSet: ['src/b/e.ts'] },
        { id: 'D', goal: 'Integrate B, C and E.', deps: ['B', 'C', 'E'], writeSet: ['src/d.txt'] },
      ],
    });
    mainId = started.id;
    assert.equal(started.status, 'running');
    const s = await engine.dags.wait(mainId, 60_000);
    const n = Object.fromEntries(s.nodes.map((x) => [x.id, x]));
    assert.equal(s.status, 'done', JSON.stringify(s.nodes.map((x) => [x.id, x.status, x.error])));
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      assert.equal(n[id].status, 'done');
      assert.equal(n[id].result, `finished ${id}`);
      assert.ok(existsSync(join(repo, FILE[id])), `${id} wrote its file`);
    }
    const span = (id: string) => [Date.parse(n[id].startedAt!), Date.parse(n[id].finishedAt!)] as const;
    const overlaps = (x: string, y: string) => span(x)[0] < span(y)[1] && span(y)[0] < span(x)[1];
    assert.ok(overlaps('B', 'C'), 'disjoint siblings ran concurrently');
    assert.ok(!overlaps('B', 'E'), 'overlapping write sets serialized');
    assert.ok(span('A')[1] <= span('B')[0] && span('D')[0] >= Math.max(span('B')[1], span('C')[1], span('E')[1]), 'deps respected');
    assert.equal(n.A.priority, 3);
    const brief = briefs.get('D')!;
    assert.match(brief, /Integrate B, C and E\./);
    assert.match(brief, /Only create or modify files matching: src\/d\.txt/);
    assert.match(brief, /- B: finished B/);
    assert.match(brief, /- C: finished C/);
    assert.ok(!briefs.get('B')!.includes('Build part C'), 'brief is the node goal, not other nodes / the parent transcript');

    const pri = await engine.dags.wait(engine.dags.run({ ...opts, concurrency: 1, nodes: [{ id: 'P', goal: 'Lone task.' }, { id: 'Q', goal: 'Start of chain.' }, { id: 'R', goal: 'End of chain.', deps: ['Q'] }] }).id, 60_000);
    const pn = Object.fromEntries(pri.nodes.map((x) => [x.id, x]));
    assert.equal(pri.status, 'done');
    assert.ok(Date.parse(pn.Q.startedAt!) < Date.parse(pn.P.startedAt!), 'critical-path node Q started before P');

    const fail = await engine.dags.wait(engine.dags.run({ ...opts, concurrency: 2, nodes: [{ id: 'F', goal: 'This one fails.' }, { id: 'G', goal: 'Depends on F.', deps: ['F'] }, { id: 'H', goal: 'Independent.' }] }).id, 60_000);
    const fn = Object.fromEntries(fail.nodes.map((x) => [x.id, x]));
    assert.equal(fail.status, 'failed');
    assert.equal(fn.F.status, 'failed');
    assert.equal(fn.G.status, 'blocked');
    assert.match(fn.G.error!, /blocked by F/);
    assert.equal(fn.G.task, null, 'blocked node never started');
    assert.equal(fn.H.status, 'done');

    assert.throws(() => engine.dags.run({ ...opts, nodes: [{ id: 'x', goal: 'g', deps: ['y'] }, { id: 'y', goal: 'g', deps: ['x'] }] }), /cycle/);
    assert.throws(() => engine.dags.run({ ...opts, nodes: [{ id: 'x', goal: 'g', deps: ['missing'] }] }), /unknown node/);
    assert.throws(() => engine.dags.run({ ...opts, nodes: [{ id: 'x', goal: 'g' }, { id: 'x', goal: 'h' }] }), /duplicate/);
  } finally {
    await engine.close();
  }
  engine = new Engine({ home, env, indexing: false, mcp: false, recover: false });
  try {
    const again: DagState = engine.dags.status(mainId);
    assert.equal(again.status, 'done');
    assert.deepEqual(again.nodes.map((x) => [x.id, x.status, x.result]), ['A', 'B', 'C', 'E', 'D'].map((id) => [id, 'done', `finished ${id}`]));
    assert.ok(again.nodes.every((x) => x.task?.startsWith('task')));
  } finally {
    await engine.close();
    await fake.close();
  }
});
