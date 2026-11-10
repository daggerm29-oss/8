import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandbox, availableBackends, type SandboxBackend } from '../src/sandbox/sandbox.ts';
import { Engine } from '../src/engine.ts';
import { Vault } from '../src/vault/vault.ts';
import { describeContainerProbe } from '../src/sandbox/container.ts';

/**
 * Sandbox backend conformance (F-SBX-1, SEC-2, architecture §16.1/§16.2). Every case runs against every backend
 * in HELIX_SANDBOX_BACKENDS (default: local-container,local-unshare). A listed backend that is unavailable
 * fails its cases; it is never skipped silently.
 */
const BACKENDS = (process.env.HELIX_SANDBOX_BACKENDS ?? 'local-container,local-unshare').split(',').map((s) => s.trim()).filter(Boolean) as SandboxBackend[];
const available = new Set(availableBackends());
const HOST_HOME = homedir();
const CANARY = join(HOST_HOME, '.helix-conformance-canary');
const SSH_DIR = join(HOST_HOME, '.ssh');
const SSH_KEY = join(SSH_DIR, 'id_helix_conformance');
const createdSsh = !existsSync(SSH_DIR);
writeFileSync(CANARY, 'HOST-HOME-CANARY\n');
mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
writeFileSync(SSH_KEY, 'FAKE-PRIVATE-KEY-CANARY\n', { mode: 0o600 });
after(() => {
  rmSync(CANARY, { force: true });
  rmSync(SSH_KEY, { force: true });
  if (createdSsh) rmSync(SSH_DIR, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helix-conf-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'export const x = 1;\n');
  return dir;
}

function sandbox(backend: SandboxBackend, id: string, opts: ConstructorParameters<typeof LocalSandbox>[2] = {}): LocalSandbox {
  assert.ok(available.has(backend), `backend ${backend} is not available on this host (available: ${[...available].join(', ') || 'none'})${backend === 'local-container' ? `\ncontainer probe:\n${describeContainerProbe()}` : ''}`);
  // `local-os` is only constructible with the trusted-repo light-mode opt-in (R0.2); the Engine passes it from workspace.trust.
  const sbx = new LocalSandbox(id, workspace(), { ...opts, backend, lightMode: backend === 'local-os' });
  assert.equal(sbx.provider, backend);
  return sbx;
}

for (const backend of BACKENDS) {
  test(`[${backend}] reports backend info`, (t) => {
    const sbx = sandbox(backend, `conf_info_${backend}`);
    try {
      const info = sbx.info();
      assert.equal(info.fsIsolation, true);
      assert.equal(info.network, false);
      if (backend === 'local-container') {
        assert.ok(info.container, 'container info present');
        t.diagnostic(`backend=${backend} cli=${info.container!.cli} runtime=${info.container!.runtime} gvisor=${info.container!.gvisor} proc=${info.container!.proc} seccomp=${info.container!.seccomp} image=${info.container!.image ?? 'host-toolchain-rootfs'}`);
      } else if (backend === 'local-os') {
        assert.equal(info.isolation, 'light');
        assert.ok(info.localOs, 'local-os info present');
        t.diagnostic(`backend=${backend} tool=${info.localOs!.tool} proc=${info.localOs!.proc} isolation=light`);
      } else t.diagnostic(`backend=${backend} runtime=unshare gvisor=false`);
    } finally {
      sbx.destroy();
    }
  });

  test(`[${backend}] exec: cwd, exit code, stdout/stderr`, async () => {
    const sbx = sandbox(backend, `conf_exec_${backend}`);
    try {
      const r = await sbx.exec('pwd; echo out; echo err >&2; exit 7', { cwd: 'src' });
      assert.equal(r.exitCode, 7);
      assert.equal(r.stdout, `${join(sbx.root, 'src')}\nout\n`);
      assert.equal(r.stderr, 'err\n');
      const node = await sbx.exec(`node -e "console.log('node-' + (6*7))"`);
      assert.equal(node.stdout.trim(), 'node-42', node.stderr);
    } finally {
      sbx.destroy();
    }
  });

  test(`[${backend}] env scrub: provider keys and vault secrets never cross, HOME is private`, async () => {
    process.env.GEMINI_API_KEY = 'conf-secret-gemini-123456789';
    process.env.OPENAI_API_KEY = 'conf-secret-openai-123456789';
    const secretNames = Vault.secretEnvNames();
    const sbx = sandbox(backend, `conf_env_${backend}`);
    try {
      const r = await sbx.exec(`echo "g=\${GEMINI_API_KEY:-unset} o=\${OPENAI_API_KEY:-unset} home=$HOME"; env | cut -d= -f1 | sort`, { env: { EXTRA_OK: '1' } });
      assert.match(r.stdout, /g=unset o=unset home=\/tmp/);
      assert.ok(!r.stdout.includes('conf-secret'));
      assert.ok(r.stdout.includes('EXTRA_OK'));
      for (const name of secretNames) assert.ok(!new RegExp(`^${name}$`, 'm').test(r.stdout), `${name} leaked`);
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      sbx.destroy();
    }
  });

  test(`[${backend}] mounts: workspace rw, toolchain ro, host home and SSH keys unreadable`, async () => {
    const outside = mkdtempSync(join(tmpdir(), 'helix-conf-secret-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET');
    const sbx = sandbox(backend, `conf_mnt_${backend}`);
    try {
      const home = await sbx.exec(`ls ${HOST_HOME}; echo "ls=$?"; cat ${HOST_HOME}/.ssh/id_*; echo "ssh=$?"; cat ${CANARY}; echo "canary=$?"`);
      assert.match(home.stdout, /ls=[1-9]/, 'ls $HOME (host) fails inside');
      assert.match(home.stdout, /ssh=[1-9]/, 'cat ~/.ssh/id_* (host) fails inside');
      assert.match(home.stdout, /canary=[1-9]/);
      assert.ok(!home.stdout.includes('FAKE-PRIVATE-KEY-CANARY') && !home.stdout.includes('HOST-HOME-CANARY'));
      const r = await sbx.exec(`cat ${join(outside, 'secret.txt')}; echo "outside=$?"; (echo x > /usr/helix-x) 2>&1; echo "usr=$?"; (echo x > /helix-root-x) 2>&1; echo "root=$?"; echo ws > src/new.txt; echo tmp > /tmp/t && cat /tmp/t; cat src/a.js`);
      assert.ok(!r.stdout.includes('TOP-SECRET'));
      assert.match(r.stdout, /outside=[1-9]/);
      assert.match(r.stdout, /Read-only file system/);
      assert.match(r.stdout, /usr=[1-9]/);
      assert.match(r.stdout, /root=[1-9]/);
      assert.match(r.stdout, /^tmp$/m);
      assert.ok(r.stdout.includes('export const x = 1;'));
      assert.equal(readFileSync(join(sbx.root, 'src', 'new.txt'), 'utf8'), 'ws\n');
    } finally {
      sbx.destroy();
    }
  });

  test(`[${backend}] timeouts kill every process and output is capped`, async () => {
    const sbx = sandbox(backend, `conf_to_${backend}`);
    try {
      const t = await sbx.exec('(sleep 2; touch survivor) & sleep 30; echo never', { timeoutMs: 500 });
      assert.equal(t.timedOut, true);
      assert.ok(t.durationMs < 5000, `took ${t.durationMs}ms`);
      assert.ok(!t.stdout.includes('never'));
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(existsSync(join(sbx.root, 'survivor')), false, 'background child was killed with the command');
      const big = await sbx.exec('yes helix | head -c 500000', { maxOutputBytes: 1000 });
      assert.equal(big.truncated, true);
      assert.ok(big.stdout.length <= 1000);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const c = await sbx.exec('sleep 30', { signal: ac.signal, timeoutMs: 60_000 });
      assert.ok(c.durationMs < 5000, `cancel took ${c.durationMs}ms`);
      assert.notEqual(c.exitCode, 0);
    } finally {
      sbx.destroy();
    }
  });

  test(`[${backend}] no direct network egress`, async () => {
    const sbx = sandbox(backend, `conf_net_${backend}`);
    try {
      const r = await sbx.exec(`node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log('ERR',e.code);process.exit(3)})"`, { timeoutMs: 15_000 });
      assert.ok(!r.stdout.includes('CONNECTED'));
      assert.equal(r.exitCode, 3, r.stdout + r.stderr);
    } finally {
      sbx.destroy();
    }
  });

  test(`[${backend}] egress only via the Engine proxy (allowlist enforced)`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-conf-home-'));
    const engine = new Engine({ home, env: {}, recover: false, mcp: false, indexing: false });
    const sbx = sandbox(backend, `conf_egress_${backend}`, { egress: engine.egress });
    engine.index(sbx.root);
    try {
      assert.equal(sbx.info().egressProxy, true);
      const code = (host: string, extra = '') => `curl -sS -m 20 ${extra} -o /dev/null -w 'code=%{http_code}\\n' https://${host}/ 2>&1; echo "exit=$?"`;
      const ok = await sbx.exec(code('registry.npmjs.org'), { timeoutMs: 60_000 });
      assert.match(ok.stdout, /code=200/, ok.stdout + ok.stderr);
      const bad = await sbx.exec(code('example.com'), { timeoutMs: 60_000 });
      assert.doesNotMatch(bad.stdout, /exit=0/);
      const direct = await sbx.exec(code('registry.npmjs.org', "--noproxy '*'"), { timeoutMs: 60_000 });
      assert.doesNotMatch(direct.stdout, /exit=0/, 'no route out except the proxy');
    } finally {
      sbx.destroy();
      await engine.close?.();
    }
  });

  test(`[${backend}] PTY: interactive shell on a real terminal`, async () => {
    const sbx = sandbox(backend, `conf_pty_${backend}`);
    try {
      let out = '';
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`pty timed out; output: ${JSON.stringify(out)}`)), 20_000);
        const p = sbx.pty({ cols: 80, rows: 24, onData: (d) => {
          out += d;
          if (out.includes('pty-42') && out.includes('tty=yes')) p.write('exit\r');
        }, onExit: (code) => { clearTimeout(timer); resolve(code); } });
        setTimeout(() => p.write('echo pty-$((6*7)); [ -t 0 ] && echo tty=yes\r'), 500);
      });
      assert.match(out, /pty-42/);
      assert.match(out, /tty=yes/);
      assert.equal(exit, 0);
    } finally {
      sbx.destroy();
    }
  });
}
