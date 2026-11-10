// R0.2 acceptance (SEC-1, SEC-2, FR-19, F-SBX-1; architecture §16.2, §25.5): the Engine fails closed when no isolating
// sandbox backend exists, and `local-os` light mode runs only for a workspace the user marked trusted, with an audit event
// and a permanent `workbench.status` isolation indicator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcErrorCode, RpcPeer, type RpcError } from '@helix/protocol';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import { LocalSandbox, SandboxUnavailableError, resolveBackend, sandboxStatus } from '../src/sandbox/sandbox.ts';
import { localOsTool } from '../src/sandbox/localos.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const UI = fileURLToPath(new URL('../ui/', import.meta.url));
const MODEL = 'gemini-3.8-flash';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const scripted = (turns: FakeTurn[]): FakeScript => ({ index }) => turns[Math.min(index, turns.length - 1)];

/** Every isolation tool Helix could use. A PATH without them leaves no isolating backend (and no light-mode tool). */
const ISOLATION_TOOLS = new Set(['unshare', 'podman', 'docker', 'runsc', 'bwrap', 'sandbox-exec', 'nsenter', 'setpriv']);

/** A PATH that mirrors the current one (bash, git, node, coreutils, …) minus every isolation tool. */
function pathWithoutIsolation(): string {
  const bin = tmp('helix-noiso-bin-');
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (seen.has(name) || ISOLATION_TOOLS.has(name)) continue;
      seen.add(name);
      try { symlinkSync(join(dir, name), join(bin, name)); } catch { /* unreadable entry */ }
    }
  }
  return bin;
}

/** Records every child process the Engine tries to start (ESM named imports included, via syncBuiltinESMExports). */
function spySpawns() {
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;
  const original = Object.fromEntries(names.map((n) => [n, cp[n]])) as Record<(typeof names)[number], (...a: unknown[]) => unknown>;
  const started: string[] = [];
  const attempted: string[] = [];
  for (const n of names) {
    (cp as unknown as Record<string, unknown>)[n] = (...args: unknown[]) => {
      const label = `${n} ${String(args[0])}`;
      attempted.push(label);
      const r = original[n](...args) as { pid?: number; error?: Error } | undefined;
      // A process started unless spawn failed outright (ENOENT etc. leaves no pid / sets error).
      if (n === 'spawnSync' ? !(r as { error?: Error }).error : n.endsWith('Sync') ? true : !!(r as { pid?: number })?.pid) started.push(label);
      return r;
    };
  }
  syncBuiltinESMExports();
  return {
    started, attempted,
    reset() { started.length = 0; attempted.length = 0; },
    restore() { for (const n of names) (cp as unknown as Record<string, unknown>)[n] = original[n]; syncBuiltinESMExports(); },
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  const restore = () => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); };
  let r: T;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r instanceof Promise) return r.finally(restore) as T;
  restore();
  return r;
}

async function connect(engine: Engine): Promise<{ peer: RpcPeer; sock: WebSocket }> {
  const { port, token } = await engine.serve({ ui: false });
  const sock = await new Promise<WebSocket>((resolve, reject) => { const s = new WebSocket(`ws://127.0.0.1:${port}/`); s.once('open', () => resolve(s)); s.once('error', reject); });
  const peer = new RpcPeer(wsTransport(sock));
  await peer.request(Methods.initialize, { clientName: 'fail-closed-test', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token, topics: ['sandbox.*', 'workspace.*'] });
  return { peer, sock };
}

function workspace(): string {
  const dir = tmp('helix-fc-ws-');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  return dir;
}

async function rejectsUnavailable(p: Promise<unknown>, what: string): Promise<RpcError> {
  const err = await p.then(() => assert.fail(`${what} must be refused`), (e: RpcError) => e);
  assert.equal(err.code, RpcErrorCode.SandboxUnavailable, `${what}: ${err.message}`);
  assert.deepEqual(err.data, { code: 'sandbox_unavailable' }, what);
  return err;
}

test('`local-process` provider no longer exists (grep -r local-process src → 0 hits)', () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/local-process|forceProcess/.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(SRC);
  assert.deepEqual(hits, []);
});

test('no isolating backend: task.create returns sandbox_unavailable and no child process is spawned', async () => {
  const noIso = pathWithoutIsolation();
  await withEnv({ PATH: noIso, HELIX_SANDBOX_PROVIDER: undefined, HELIX_CONTAINER_CLI: undefined, HELIX_WSL_DISTRO: undefined }, async () => {
    const st = sandboxStatus();
    assert.deepEqual({ backend: st.backend, isolation: st.isolation }, { backend: null, isolation: 'none' });
    assert.match(st.reason ?? '', /no isolating sandbox backend/);
    assert.throws(() => resolveBackend(), SandboxUnavailableError);
    assert.throws(() => new LocalSandbox('sbx_fc', workspace()), (e: unknown) => e instanceof SandboxUnavailableError && e.code === 'sandbox_unavailable');

    const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: 'k', HELIX_GEMINI_BASE_URL: 'http://127.0.0.1:9' }, recover: false, mcp: false, indexing: false });
    const spy = spySpawns();
    try {
      const { peer, sock } = await connect(engine);
      const ws = workspace();
      spy.reset();
      const err = await rejectsUnavailable(peer.request(Methods.taskCreate, { workspacePath: ws, goal: 'fix the test', provider: 'gemini', model: MODEL }), 'task.create');
      assert.match(err.message, /agent processes are refused/);
      assert.deepEqual(spy.started, [], `no child process may start; attempted: ${spy.attempted.join(' | ')}`);
      assert.equal(engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n, 0, 'no task row is created');
      assert.equal(engine.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sandboxes')!.n, 0, 'no sandbox row is created');

      // The other agent-process entry points fail closed too (terminal, PTY, dev server).
      await rejectsUnavailable(peer.request(Methods.terminalRun, { workspacePath: ws, command: 'echo unisolated > leak.txt' }), 'terminal.run');
      await rejectsUnavailable(peer.request(Methods.ptyOpen, { workspacePath: ws }), 'pty.open');
      writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "require(\'fs\').writeFileSync(\'leak.txt\',\'x\')"' } }));
      await rejectsUnavailable(peer.request(Methods.previewStart, { workspacePath: ws }), 'preview.start');
      assert.equal(existsSync(join(ws, 'leak.txt')), false, 'nothing ran on the host');
      assert.deepEqual(spy.started, [], `no child process may start; attempted: ${spy.attempted.join(' | ')}`);

      const status = await peer.request(Methods.workbenchStatus, { workspacePath: ws }) as { isolation: string; backend: string | null; reason: string };
      assert.equal(status.isolation, 'none');
      assert.equal(status.backend, null);
      const init = await peer.request(Methods.sandboxCheck, {}) as { available: string[]; default: string | null };
      assert.deepEqual(init.available, []);
      assert.equal(init.default, null);

      // Trusting the repo with light mode does not fall back to anything else when the light-mode tool is missing too.
      await peer.request(Methods.workspaceTrust, { workspacePath: ws, trusted: true, lightMode: true });
      const light = await rejectsUnavailable(peer.request(Methods.taskCreate, { workspacePath: ws, goal: 'x', provider: 'gemini', model: MODEL }), 'task.create (light mode, no bwrap)');
      assert.match(light.message, /local-os light mode/);
      assert.deepEqual(spy.started, []);

      // Positive control: the spy sees ESM-imported spawns, so the empty lists above are meaningful.
      const { spawnSync } = await import('node:child_process');
      spawnSync('true');
      assert.deepEqual(spy.started, ['spawnSync true']);
      sock.close();
    } finally {
      spy.restore();
      await engine.close();
    }
  });
});

test('forced or environment-selected backends never silently fall back', async () => {
  const noIso = pathWithoutIsolation();
  await withEnv({ PATH: noIso, HELIX_WSL_DISTRO: undefined }, () => {
    for (const forced of ['local-container', 'local-unshare', 'local-os', 'local-process', 'none']) {
      withEnv({ HELIX_SANDBOX_PROVIDER: forced }, () => assert.throws(() => resolveBackend(), SandboxUnavailableError, forced));
    }
  });
  // `local-os` is never accepted from the environment, even where bwrap works: light mode is a per-workspace user decision.
  await withEnv({ HELIX_SANDBOX_PROVIDER: 'local-os' }, () => assert.throws(() => resolveBackend(), /never by environment/));
  // A sandbox cannot be built on local-os without the light-mode opt-in.
  assert.throws(() => new LocalSandbox('sbx_x', workspace(), { backend: 'local-os' }), SandboxUnavailableError);
});

test('trusted-repo local-os opt-in runs, emits sandbox.light_mode audit event, and workbench.status reports isolation "light"', { skip: localOsTool() ? false : 'bubblewrap/Seatbelt not usable on this host' }, async () => {
  const ws = workspace();
  const fake = await startFakeProvider('gemini', scripted([
    { toolCalls: [{ name: 'run_shell', args: { command: 'echo "sbx=$HELIX_SANDBOX"; ls /home >/dev/null 2>&1 && echo home-visible || echo home-hidden; echo light > light.txt' } }], usage: { input: 100, output: 10 } },
    { text: 'Ran in light mode.', usage: { input: 200, output: 10 } },
  ]));
  const engine = new Engine({ home: tmp('helix-home-'), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, recover: false, mcp: false, indexing: false, retry: { baseDelayMs: 1, maxDelayMs: 5 }, taskRetryScale: 0.001 });
  try {
    const { peer, sock } = await connect(engine);
    const before = await peer.request(Methods.workbenchStatus, { workspacePath: ws }) as { isolation: string; workspace: { trusted: boolean; lightMode: boolean } };
    assert.notEqual(before.isolation, 'light', 'untrusted workspaces never get light mode');
    assert.deepEqual({ trusted: before.workspace.trusted, lightMode: before.workspace.lightMode }, { trusted: false, lightMode: false });

    await assert.rejects(peer.request(Methods.workspaceTrust, { workspacePath: ws, trusted: false, lightMode: true }), /lightMode requires trusted/);
    // Trusted without light mode keeps full isolation.
    const trustedOnly = await peer.request(Methods.workspaceTrust, { workspacePath: ws, trusted: true }) as { isolation: string };
    assert.notEqual(trustedOnly.isolation, 'light');

    const status = await peer.request(Methods.workspaceTrust, { workspacePath: ws, trusted: true, lightMode: true }) as { isolation: string; backend: string; workspace: { trusted: boolean; lightMode: boolean; trustedAt: string } };
    assert.equal(status.isolation, 'light');
    assert.equal(status.backend, 'local-os');
    assert.ok(status.workspace.trusted && status.workspace.lightMode && status.workspace.trustedAt);
    const wb = await peer.request(Methods.workbenchStatus, { workspacePath: ws }) as { isolation: string };
    assert.equal(wb.isolation, 'light');

    const created = await peer.request(Methods.taskCreate, { workspacePath: ws, goal: 'run in light mode', provider: 'gemini', model: MODEL, policyProfile: 'headless' }) as { id: string };
    const done = await engine.runtime.wait(created.id, 60_000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(readFileSync(join(ws, 'light.txt'), 'utf8'), 'light\n', 'the shell command ran');
    const out = engine.runtime.transcript(created.id).flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
    assert.ok(out && out.type === 'tool_result' && /sbx=sbx_/.test(out.content) && /home-hidden/.test(out.content), out && out.type === 'tool_result' ? out.content : 'no tool result');

    const sbx = engine.db.get<{ provider: string }>('SELECT provider FROM sandboxes WHERE labels_json LIKE ?', `%${created.id}%`)!;
    assert.equal(sbx.provider, 'local-os');
    engine.bus.flush();
    const audit = engine.db.all<{ topic: string; data_json: string }>('SELECT topic, data_json FROM audit_log ORDER BY id');
    const lightEvents = audit.filter((a) => a.topic === 'sandbox.light_mode');
    assert.ok(lightEvents.length >= 1, `sandbox.light_mode audited; topics: ${audit.map((a) => a.topic).join(',')}`);
    const ev = JSON.parse(lightEvents[0].data_json) as { workspacePath: string; tool: string };
    assert.equal(ev.tool, localOsTool()!.kind);
    assert.ok(audit.some((a) => a.topic === 'workspace.trust_changed' && JSON.parse(a.data_json).lightMode === true), 'the opt-in itself is audited');
    assert.equal(engine.bus.verifyAuditChain(), null, 'audit chain verifies');

    // Revoking trust returns the workspace to full isolation.
    const revoked = await peer.request(Methods.workspaceTrust, { workspacePath: ws, trusted: false }) as { isolation: string; workspace: { trusted: boolean } };
    assert.notEqual(revoked.isolation, 'light');
    assert.equal(revoked.workspace.trusted, false);
    sock.close();
  } finally {
    await engine.close();
    await fake.close();
  }
});

test('workbench shows a permanent isolation indicator fed by workbench.status', () => {
  const html = readFileSync(join(UI, 'index.html'), 'utf8');
  const js = readFileSync(join(UI, 'app.js'), 'utf8');
  assert.match(html, /<header class="topbar">[\s\S]*id="isolation-status"[\s\S]*<\/header>/, 'indicator lives in the always-visible top bar');
  assert.match(js, /rpc\.call\('workbench\.status'/);
  assert.match(js, /rpc\.call\('workspace\.trust'/);
  assert.match(js, /LIGHT MODE/);
  assert.match(js, /'sandbox\.\*'/);
});

test('light-mode trust survives an Engine restart (stored per workspace)', async () => {
  const home = tmp('helix-home-');
  const ws = workspace();
  mkdirSync(join(ws, 'src'));
  const a = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  a.runtime.setWorkspaceTrust(ws, { trusted: true, lightMode: true });
  await a.close();
  const b = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
  try {
    assert.deepEqual({ ...b.runtime.workspaceTrust(ws), at: 'x' }, { trusted: true, lightMode: true, at: 'x', by: 'user' });
  } finally {
    await b.close();
  }
});
