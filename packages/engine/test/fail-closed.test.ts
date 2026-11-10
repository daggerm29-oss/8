// R0.2 acceptance (SEC-1, SEC-2, FR-19, F-SBX-1; architecture §16.2, §25.5): the Engine fails closed when no isolating
// sandbox backend exists, and `local-os` light mode runs only for a workspace the user marked trusted, with an audit event
// and a permanent `workbench.status` isolation indicator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcErrorCode, RpcPeer, type RpcError } from '@helix/protocol';
import { startFakeProvider, type FakeScript, type FakeTurn } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import { LocalSandbox, SandboxUnavailableError, resolveBackend, sandboxStatus } from '../src/sandbox/sandbox.ts';
import { localOsTool } from '../src/sandbox/localos.ts';
import { buildRootfs, containerRuntime, describeContainerProbe, resetContainerProbe } from '../src/sandbox/container.ts';

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

for (const cleanupWorks of [true, false]) {
  test(`rootless Podman probe: mapped-UID cleanup ${cleanupWorks ? 'succeeds without escaping EACCES' : 'fails closed when namespace cleanup fails'}`, () => {
    const require = createRequire(import.meta.url);
    const fs = require('node:fs') as typeof import('node:fs');
    const cp = require('node:child_process') as typeof import('node:child_process');
    const originalRm = fs.rmSync;
    const originalSpawn = cp.spawnSync;
    const bin = tmp('helix-probe-bin-');
    writeFileSync(join(bin, 'podman'), '');
    const dirs = new Set<string>();
    const cleaned = new Set<string>();
    const cleanupCalls: string[][] = [];
    fs.rmSync = (...args: Parameters<typeof fs.rmSync>) => {
      const dir = String(args[0]);
      if (dirs.has(dir) && !cleaned.has(dir)) throw Object.assign(new Error('mapped-UID rootfs is inaccessible'), { code: 'EACCES' });
      return originalRm(...args);
    };
    cp.spawnSync = ((cli: string, args: string[]) => {
      assert.equal(cli, 'podman');
      let status = 0;
      if (args[0] === 'unshare') {
        cleanupCalls.push(args);
        const dir = args.at(-1)!;
        assert.ok(dirs.has(dir), 'cleanup stays inside a freshly created probe directory');
        assert.deepEqual(args.slice(0, -1), ['unshare', 'rm', '-rf', '--']);
        if (cleanupWorks) {
          originalRm(dir, { recursive: true, force: true });
          cleaned.add(dir);
        } else status = 1;
      } else if (args[0] === 'run' && args[1] === '--help') {
        return { pid: 1, output: [null, '      --no-hostname   Do not create /etc/hostname\n', ''], stdout: '      --no-hostname   Do not create /etc/hostname\n', stderr: '', status: 0, signal: null };
      } else if (args.includes('run')) {
        const ws = args[args.indexOf('-w') + 1];
        const dir = join(ws, '..');
        dirs.add(dir);
        assert.ok(args.includes('--read-only'));
        assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
        assert.equal(args[args.indexOf('--network') + 1], 'none');
        writeFileSync(join(ws, 'probe'), 'ok');
      } else assert.equal(args[0], 'info');
      return { pid: 1, output: [null, 'true\n', ''], stdout: 'true\n', stderr: '', status, signal: null };
    }) as typeof cp.spawnSync;
    syncBuiltinESMExports();
    try {
      withEnv({ PATH: bin, HELIX_CONTAINER_CLI: 'podman', HELIX_CONTAINER_RUNTIME: 'crun', HELIX_SANDBOX_IMAGE: undefined }, () => {
        resetContainerProbe();
        const runtime = containerRuntime();
        assert.equal(runtime?.cli ?? null, cleanupWorks ? 'podman' : null);
        assert.ok(dirs.size > 0);
        assert.equal(cleanupCalls.length, dirs.size);
        if (cleanupWorks) for (const dir of dirs) assert.equal(existsSync(dir), false, 'no probe directory is leaked');
      });
    } finally {
      fs.rmSync = originalRm;
      cp.spawnSync = originalSpawn;
      syncBuiltinESMExports();
      resetContainerProbe();
      for (const dir of dirs) originalRm(dir, { recursive: true, force: true });
      originalRm(bin, { recursive: true, force: true });
    }
  });
}

// CI run 42818386074 (ubuntu-24.04, Podman 4.9.3): every candidate exited 125 with `unknown flag: --no-hostname`.
for (const podman of [{ version: '4.9.3', noHostname: false }, { version: '5.6.1', noHostname: true }]) {
  test(`rootless Podman ${podman.version} probe: --no-hostname only when supported; isolation flags kept; rejection reason reported`, () => {
    const require = createRequire(import.meta.url);
    const cp = require('node:child_process') as typeof import('node:child_process');
    const originalSpawn = cp.spawnSync;
    const bin = tmp('helix-probe-bin-');
    writeFileSync(join(bin, 'podman'), '');
    const runs: string[][] = [];
    const help = `Options:\n      --no-hosts      Do not create /etc/hosts\n${podman.noHostname ? '      --no-hostname   Do not create /etc/hostname\n' : ''}      --read-only     Make containers root filesystem read-only\n`;
    const reply = (status: number, stdout: string, stderr = '') => ({ pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null });
    let helpText = help;
    cp.spawnSync = ((cli: string, args: string[]) => {
      assert.equal(cli, 'podman');
      if (args[0] === 'run' && args[1] === '--help') return reply(0, helpText);
      if (args[0] === 'info') return reply(0, 'true\n');
      if (args[0] === 'unshare') return reply(0, '');
      if (args.includes('run')) {
        runs.push(args);
        if (args.includes('--no-hostname') && !podman.noHostname) return reply(125, '', "Error: unknown flag: --no-hostname\nSee 'podman run --help'\n");
        writeFileSync(join(args[args.indexOf('-w') + 1], 'probe'), 'ok');
        return reply(0, '');
      }
      return reply(1, '');
    }) as typeof cp.spawnSync;
    syncBuiltinESMExports();
    try {
      withEnv({ PATH: bin, HELIX_CONTAINER_CLI: 'podman', HELIX_CONTAINER_RUNTIME: 'crun', HELIX_SANDBOX_IMAGE: undefined }, () => {
        resetContainerProbe();
        const runtime = containerRuntime();
        assert.equal(runtime?.cli, 'podman', describeContainerProbe());
        assert.equal(runtime?.noHostname, podman.noHostname);
        const args = runs[0];
        assert.equal(args.includes('--no-hostname'), podman.noHostname);
        for (const flag of ['--read-only', '--no-hosts', '--init']) assert.ok(args.includes(flag), flag);
        assert.equal(args[args.indexOf('--network') + 1], 'none');
        assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
        assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
        assert.equal(args[args.indexOf('--userns') + 1], 'keep-id');
        assert.ok(args.filter((a) => a.startsWith('type=bind,') && !a.endsWith(',ro')).every((m) => /dst=\/tmp$|dst=.*\/ws$/.test(m)), 'only scratch and workspace are writable');
      });
      // Forcing the Podman-5-only flag on Podman 4 reproduces the CI failure: fail closed, with Podman's own error surfaced.
      if (!podman.noHostname) {
        withEnv({ PATH: bin, HELIX_CONTAINER_CLI: 'podman', HELIX_CONTAINER_RUNTIME: 'crun', HELIX_SANDBOX_IMAGE: undefined, HELIX_SANDBOX_PROVIDER: 'local-container' }, () => {
          helpText = `${help}      --no-hostname   (mis-detected)\n`;
          resetContainerProbe();
          assert.equal(containerRuntime(), null);
          assert.match(describeContainerProbe(), /rejected \(exit=125\)\n\s+Error: unknown flag: --no-hostname/);
          assert.throws(() => resolveBackend(), (e: Error) => e instanceof SandboxUnavailableError && /unknown flag: --no-hostname/.test(e.message));
        });
      }
    } finally {
      cp.spawnSync = originalSpawn;
      syncBuiltinESMExports();
      resetContainerProbe();
      rmSync(bin, { recursive: true, force: true });
    }
  });
}

// CI run 42821213020 (Podman 4.9.3): a 0700 mkdtemp rootfs under the `:O` overlay root denied exec of /run/podman-init.
test('local-container rootfs skeleton is 0755 and holds only empty mountpoints and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
  try {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    buildRootfs(root, ['/usr', '/etc', '/opt']);
    assert.equal(statSync(root).mode & 0o777, 0o755);
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        assert.ok(e.isDirectory() || e.isSymbolicLink(), `unexpected host content ${join(d, e.name)}`);
        if (e.isDirectory()) walk(join(d, e.name));
      }
    };
    walk(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
