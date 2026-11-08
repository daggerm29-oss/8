import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import { evaluate, forbiddenGitPush } from '../src/policy/policy.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(): string {
  const root = tmp('helix-git-');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.name', 'Helix Test');
  sh(root, 'config', 'user.email', 'test@helix.local');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  return root;
}

test('git safeguards: force-push and push to main are denied for agents even when preapproved (F-GIT-5)', () => {
  for (const cmd of ['git push --force', 'git push -f origin feature', 'git push --force-with-lease origin x', 'git push origin +feature', 'git push origin main', 'git push -u origin HEAD:main', 'cd x && git -C . push origin master', 'git push origin refs/heads/main']) {
    assert.ok(forbiddenGitPush(cmd), cmd);
    assert.equal(evaluate({ tool: 'run_shell', args: { command: cmd }, profile: 'headless', preapprove: ['all', 'tool:run_shell'] }).verdict, 'deny', cmd);
  }
  for (const cmd of ['git push origin helix/task-1', 'git status', 'git log --format=%f', 'git push -u origin feature-main']) assert.equal(forbiddenGitPush(cmd), null, cmd);
  assert.equal(evaluate({ tool: 'run_shell', args: { command: 'git push origin helix/task-1' }, profile: 'interactive', preapprove: ['destructive'] }).verdict, 'allow');
});

test('git panel RPCs: status, diff, stage all, commit; commit appears in git log (F-GIT-1)', async () => {
  const root = repo();
  const engine = new Engine({ home: tmp('helix-home-'), env: {}, recover: false, mcp: false, indexing: false });
  try {
    engine.runtime.create({ workspacePath: root, goal: 'git panel', provider: 'gemini', model: 'gemini-3.8-flash', start: false });
    const { port, token } = await engine.serve({ ui: false });
    const sock = await new Promise<WebSocket>((resolve, reject) => { const s = new WebSocket(`ws://127.0.0.1:${port}/`); s.once('open', () => resolve(s)); s.once('error', reject); });
    const peer = new RpcPeer(wsTransport(sock));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });

    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook-ran > hook.out\nexit 1\n', { mode: 0o755 });
    const st = await peer.request(Methods.gitStatus, { workspacePath: root }) as { branch: string; files: Array<{ path: string; index: string; worktree: string }> };
    assert.equal(st.branch, 'main');
    assert.deepEqual(st.files.map((f) => `${f.index}${f.worktree} ${f.path}`).sort(), [' M a.txt', '?? b.txt']);
    const diff = await peer.request(Methods.gitDiff, { workspacePath: root }) as { staged: string; unstaged: string };
    assert.match(diff.unstaged, /\+two/);
    assert.equal(diff.staged, '');

    await assert.rejects(peer.request(Methods.gitCommit, { workspacePath: root, message: 'x' }), /nothing staged/);
    const staged = await peer.request(Methods.gitStageAll, { workspacePath: root }) as { files: Array<{ index: string }> };
    assert.deepEqual(staged.files.map((f) => f.index).sort(), ['A', 'M']);
    await assert.rejects(peer.request(Methods.gitCommit, { workspacePath: root, message: '  ' }), /message is required/);
    const c = await peer.request(Methods.gitCommit, { workspacePath: root, message: 'Panel commit' }) as { sha: string };
    assert.match(sh(root, 'log', '--oneline', '-1'), new RegExp(`^${c.sha} Panel commit`));
    assert.equal(sh(root, 'status', '--porcelain'), '', 'hook did not run (no hook.out) and tree is clean');
    sock.close();
  } finally {
    await engine.close();
  }
});

test('agent run: git push --force and push to main are denied by policy (F-GIT-5)', async () => {
  const root = repo();
  const turns: FakeTurn[] = [
    { toolCalls: [{ name: 'run_shell', args: { command: 'git push --force origin helix/x' } }], usage: { input: 50, output: 5 } },
    { toolCalls: [{ name: 'run_shell', args: { command: 'git push origin main' } }], usage: { input: 60, output: 5 } },
    { text: 'Could not push.', usage: { input: 70, output: 5 } },
  ];
  const fake = await startFakeProvider('gemini', scripted(turns));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, retry: { baseDelayMs: 1, maxDelayMs: 5 }, mcp: false, indexing: false });
  try {
    const t = engine.runtime.create({ workspacePath: root, goal: 'push', provider: 'gemini', model: 'gemini-3.8-flash', policyProfile: 'headless', preapprove: ['all'], verifyCommand: 'node -e 0' });
    const done = await engine.runtime.wait(t.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    const results = engine.runtime.transcript(t.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as Array<{ content: string; isError?: boolean }>;
    assert.equal(results.length, 2);
    assert.match(results[0].content, /denied by policy: force-push is denied for agents/);
    assert.match(results[1].content, /denied by policy: push to the default branch is denied for agents/);
  } finally {
    await engine.close();
    await fake.close();
  }
});
