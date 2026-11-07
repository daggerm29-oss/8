import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import { FileConflictError, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from '../src/workspace/files.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-fs-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), '');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
  return root;
}

test('files: tree filters secrets/deps; read confines to the workspace', () => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), 'helix-out-'));
  writeFileSync(join(outside, 'host.txt'), 'host secret');
  symlinkSync(join(outside, 'host.txt'), join(root, 'link.txt'));
  const tree = listWorkspaceFiles(root);
  assert.equal(tree.source, 'walk');
  assert.ok(tree.files.includes('src/a.js') && tree.files.includes('README.md'));
  assert.ok(!tree.files.includes('.env'));
  assert.ok(!tree.files.some((f) => f.startsWith('node_modules')));
  assert.equal(readWorkspaceFile(root, 'src/a.js').content, 'export const a = 1;\n');
  assert.equal(readWorkspaceFile(root, 'bin.dat').binary, true);
  assert.throws(() => readWorkspaceFile(root, '../' + outside.split('/').pop() + '/host.txt'), /outside the workspace|no such file/);
  assert.throws(() => readWorkspaceFile(root, 'link.txt'), /outside the workspace/);
  assert.throws(() => readWorkspaceFile(root, '.env'), /secret/);
  assert.throws(() => readWorkspaceFile(root, 'src'), /not a file/);
  const big = readWorkspaceFile(root, 'README.md', 3);
  assert.equal(big.truncated, true);
  assert.equal(big.content, '# h');
});

test('files: write is confined, hash-checked (conflicts), atomic, and refuses secrets/.git', () => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), 'helix-out-'));
  symlinkSync(outside, join(root, 'escape'));
  mkdirSync(join(root, '.git'));
  const f = readWorkspaceFile(root, 'src/a.js');
  assert.match(f.hash ?? '', /^[0-9a-f]{64}$/);
  const w = writeWorkspaceFile(root, 'src/a.js', 'export const a = 2;\n', f.hash);
  assert.equal(readFileSync(join(root, 'src/a.js'), 'utf8'), 'export const a = 2;\n');
  assert.equal(w.created, false);
  assert.equal(readWorkspaceFile(root, 'src/a.js').hash, w.hash);
  assert.throws(() => writeWorkspaceFile(root, 'src/a.js', 'stale', f.hash), FileConflictError, 'old hash must conflict');
  assert.throws(() => writeWorkspaceFile(root, 'src/new.js', 'x', 'abc'), FileConflictError, 'non-null base for a missing file conflicts');
  assert.equal(writeWorkspaceFile(root, 'src/new.js', 'x', null).created, true);
  assert.throws(() => writeWorkspaceFile(root, 'src/new.js', 'y', null), FileConflictError, 'null base for an existing file conflicts');
  assert.throws(() => writeWorkspaceFile(root, '.env', 'X=1', null), /not writable/);
  assert.throws(() => writeWorkspaceFile(root, '.git/config', 'x', null), /not writable/);
  assert.throws(() => writeWorkspaceFile(root, 'escape/pwn.txt', 'x', null), /outside the workspace/);
  assert.throws(() => writeWorkspaceFile(root, '../pwn.txt', 'x', null), /outside the workspace/);
  assert.throws(() => writeWorkspaceFile(root, '/etc/passwd', 'x', null), /relative path/);
  assert.throws(() => writeWorkspaceFile(root, 'nope/dir/a.js', 'x', null), /directory does not exist/);
  assert.equal(existsSync(join(outside, 'pwn.txt')), false);
  assert.deepEqual(readdirSync(join(root, 'src')).filter((n) => n.includes('.tmp')), [], 'no temp files left');
});

test('engine: fs.tree/fs.read/terminal.run over WS for known workspaces only, with streamed output and kill', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const root = repo();
  const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  try {
    const { port, token } = await engine.serve({ ui: true });
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/`);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const peer = new RpcPeer(wsTransport(ws));
    const chunks: Array<{ runId: string; stream: string; text: string }> = [];
    peer.onNotification('terminal.output', (p: unknown) => chunks.push(p as never));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });

    await assert.rejects(peer.request(Methods.fsTree, { workspacePath: root }), /unknown workspace/);
    await assert.rejects(peer.request(Methods.terminalRun, { workspacePath: root, command: 'echo hi' }), /unknown workspace/);
    engine.index(root);

    const tree = await peer.request(Methods.fsTree, { workspacePath: root }) as { files: string[] };
    assert.ok(tree.files.includes('src/a.js') && !tree.files.includes('.env'));
    const file = await peer.request(Methods.fsRead, { workspacePath: root, path: 'src/a.js' }) as { content: string; hash: string };
    assert.match(file.content, /export const a/);
    await assert.rejects(peer.request(Methods.fsRead, { workspacePath: root, path: '/etc/passwd' }), /outside the workspace/);
    const saved = await peer.request(Methods.fsWrite, { workspacePath: root, path: 'src/a.js', content: 'export const a = 3;\n', baseHash: file.hash }) as { hash: string };
    assert.equal(readFileSync(join(root, 'src/a.js'), 'utf8'), 'export const a = 3;\n');
    await assert.rejects(peer.request(Methods.fsWrite, { workspacePath: root, path: 'src/a.js', content: 'x', baseHash: file.hash }), /changed on disk/);
    await assert.rejects(peer.request(Methods.fsWrite, { workspacePath: root, path: '.env', content: 'x', baseHash: null }), /not writable/);
    assert.ok(saved.hash);
    engine.bus.flush();
    assert.ok(engine.db.all<{ topic: string }>(`SELECT topic FROM audit_log WHERE topic = 'workspace.file_written'`).length >= 1, 'user edits are audited');

    const r = await peer.request(Methods.terminalRun, { workspacePath: root, command: 'echo out-line; echo err-line 1>&2; cat src/a.js; exit 3', runId: 'run_t1' }, 30_000) as { exitCode: number; runId: string };
    assert.equal(r.runId, 'run_t1');
    assert.equal(r.exitCode, 3);
    const utf = await peer.request(Methods.terminalRun, { workspacePath: root, command: "printf '\\342\\234\\224 ok\\n'" }, 30_000) as { truncated: boolean; exitCode: number };
    assert.equal(utf.exitCode, 0);
    assert.equal(utf.truncated, false, 'multi-byte output must not be reported as truncated');
    const mine = chunks.filter((c) => c.runId === 'run_t1');
    assert.match(mine.filter((c) => c.stream === 'stdout').map((c) => c.text).join(''), /out-line[\s\S]*export const a/);
    assert.match(mine.filter((c) => c.stream === 'stderr').map((c) => c.text).join(''), /err-line/);

    const long = peer.request(Methods.terminalRun, { workspacePath: root, command: 'sleep 20', runId: 'run_t2' }, 30_000) as Promise<{ killed: boolean; durationMs: number }>;
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(await peer.request(Methods.terminalKill, { runId: 'run_t2' }), { killed: true });
    const k = await long;
    assert.equal(k.killed, true);
    assert.ok(k.durationMs < 10_000);

    // F-TRM-1 PTY: real tty, interactive input, Ctrl-C reaches the foreground job, exit is reported.
    let ptyOut = '';
    let ptyExit: { ptyId: string; exitCode: number | null } | undefined;
    peer.onNotification('pty.output', (p: unknown) => { ptyOut += (p as { data: string }).data; });
    peer.onNotification('pty.exit', (p: unknown) => { ptyExit = p as never; });
    const until = async (re: RegExp, ms = 15_000) => { const end = Date.now() + ms; while (!re.test(ptyOut)) { if (Date.now() > end) throw new Error(`pty timeout waiting for ${re}; got: ${JSON.stringify(ptyOut.slice(-400))}`); await new Promise((r) => setTimeout(r, 50)); } };
    await assert.rejects(peer.request(Methods.ptyOpen, { workspacePath: '/nonexistent-helix' }), /no such workspace|unknown workspace/);
    const { ptyId } = await peer.request(Methods.ptyOpen, { workspacePath: root, cols: 90, rows: 20 }) as { ptyId: string };
    await until(/helix:\S*[$#] /);
    await peer.request(Methods.ptyWrite, { ptyId, data: '[ -t 0 ] && echo "TTY=yes $TERM $(stty size)"\r' });
    await until(/TTY=yes xterm-256color 20 90/);
    await peer.request(Methods.ptyWrite, { ptyId, data: 'sleep 30; echo NOT_INTERRUPTED\r' });
    await new Promise((r) => setTimeout(r, 400));
    await peer.request(Methods.ptyWrite, { ptyId, data: '\x03' });
    await peer.request(Methods.ptyWrite, { ptyId, data: 'echo AFTER_$((6*7))\r' });
    await until(/AFTER_42/);
    assert.doesNotMatch(ptyOut, /\rNOT_INTERRUPTED|\nNOT_INTERRUPTED/, "Ctrl-C interrupted the foreground sleep");
    await peer.request(Methods.ptyWrite, { ptyId, data: 'exit 5\r' });
    const end = Date.now() + 10_000;
    while (!ptyExit && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ptyExit, { ptyId, exitCode: 5 });
    await assert.rejects(peer.request(Methods.ptyWrite, { ptyId, data: 'x' }), /no such terminal/);
    ws.close();
  } finally {
    await engine.close();
  }
});
