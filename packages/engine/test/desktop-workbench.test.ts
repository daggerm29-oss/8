import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.ts';
import { Db } from '../src/storage/db.ts';
import { desktopAsset } from '../src/workspace/desktop-assets.ts';
import { listProblems, recordTerminalProblems } from '../src/workspace/problems.ts';
import { RpcPeer, Methods } from '@helix/protocol';
import { streamTransport } from '@helix/protocol';
import { PassThrough } from 'node:stream';

test('desktop static asset resolver rejects traversal, secrets, non-assets and symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-assets-'));
  try {
    const assets = join(root, 'assets'); mkdirSync(assets);
    writeFileSync(join(assets, 'index.html'), 'workbench');
    writeFileSync(join(root, 'outside.js'), 'outside');
    writeFileSync(join(assets, '.env'), 'secret');
    symlinkSync(join(root, 'outside.js'), join(assets, 'escape.js'));
    assert.equal(desktopAsset(assets, '/desktop/index.html')?.type, 'text/html; charset=utf-8');
    for (const path of ['../outside.js', '%2e%2e/outside.js', 'escape.js', '.env', 'absent.js', '..\\outside.js']) assert.equal(desktopAsset(assets, `/desktop/${path}`), undefined, path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Problems isolates workspaces, redacts, persists, and clears terminal diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-problems-'));
  const file = join(root, 'state.sqlite');
  let db = new Db(file);
  try {
    recordTerminalProblems(db, 'a', 'tsc', 'src/a.ts(2,3): error TS2322: invalid value');
    assert.equal(listProblems(db, 'a')[0].line, 2);
    assert.deepEqual(listProblems(db, 'b'), []);
    db.close(); db = new Db(file);
    assert.equal(listProblems(db, 'a')[0].code, 'TS2322');
    recordTerminalProblems(db, 'a', 'tsc', '');
    assert.deepEqual(listProblems(db, 'a'), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('workspace.open registers a real directory without creating a task or requiring a provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-workspace-open-'));
  const repo = join(root, 'repo'); mkdirSync(repo); writeFileSync(join(repo, 'hello.ts'), 'export const hello = 1;');
  const engine = new Engine({ home: join(root, 'home'), env: {}, mcp: false, indexing: false, recover: false });
  const input = new PassThrough(); const output = new PassThrough();
  const client = new RpcPeer(streamTransport(output, input));
  engine.serveStdio(input, output);
  try {
    await client.request(Methods.initialize, { clientName: 'desktop-test', clientVersion: '0.1.0', protocolVersion: '0.1.0' });
    const workspace = await client.request<{ path: string }>(Methods.workspaceOpen, { workspacePath: repo });
    assert.equal(workspace.path, repo);
    assert.deepEqual(await client.request(Methods.taskList, {}), []);
    assert.deepEqual((await client.request<{ files: string[] }>(Methods.fsTree, { workspacePath: repo })).files, ['hello.ts']);
    assert.deepEqual(await client.request(Methods.problemsList, { workspacePath: repo }), []);
    await assert.rejects(client.request(Methods.workspaceOpen, { workspacePath: join(repo, 'hello.ts') }), /directory/);
    await assert.rejects(client.request(Methods.workspaceOpen, {}), /required/);
    await assert.rejects(client.request(Methods.problemsList, { workspacePath: root }), /unknown workspace/);
  } finally { client.close(); await engine.close(); rmSync(root, { recursive: true, force: true }); }
});
