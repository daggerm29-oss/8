import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalSandbox } from '../src/sandbox/sandbox.ts';
import { toWslPath, wslFromEnv } from '../src/sandbox/wsl.ts';
import { detectKeychain } from '../src/vault/keychain.ts';
import { isDeniedHostPath } from '../src/vault/vault.ts';

function writeShim(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/** Fake `wsl.exe`: logs argv + WSLENV, then runs the program in --cd with only WSLENV-listed vars (like WSL does). */
const WSL_SHIM = `
const fs = require('fs');
const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(__dirname + '/argv.log', JSON.stringify({ argv: a, wslenv: process.env.WSLENV }) + '\\n');
let i = 0, cd = '/';
if (a[i] === '-d') i += 2;
if (a[i] === '--cd') { cd = a[i + 1]; i += 2; }
if (a[i++] !== '--exec') process.exit(90);
const env = { PATH: '/usr/local/bin:/usr/bin:/bin' };
for (const item of (process.env.WSLENV || '').split(':').filter(Boolean)) { const n = item.split('/')[0]; if (process.env[n] !== undefined) env[n] = process.env[n]; }
const r = spawnSync(a[i], a.slice(i + 1), { cwd: cd, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

/** Fake `powershell.exe`: decodes -EncodedCommand, emulates the Credential Manager ops on a JSON file, logs argv + script. */
const PS_SHIM = `
const fs = require('fs');
const a = process.argv.slice(2);
const script = Buffer.from(a[a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify({ argv: a, script }) + '\\n');
const op = /# helix-op: (\\w+)/.exec(script)[1];
const target = (/TargetName='([^']+)'/.exec(script) || /Cred(?:Read|Delete)\\('([^']+)'/.exec(script))[1];
const store = fs.existsSync(process.env.SHIM_STORE) ? JSON.parse(fs.readFileSync(process.env.SHIM_STORE, 'utf8')) : {};
if (op === 'set') { if (!script.includes('CredWrite')) process.exit(91); store[target] = fs.readFileSync(0, 'utf8'); }
else if (op === 'get') { if (!(target in store)) process.exit(1); process.stdout.write(store[target]); }
else if (op === 'delete') delete store[target];
fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store));
`;

test('toWslPath maps drive and \\\\wsl$ paths, rejects the rest (NFR-6)', () => {
  assert.equal(toWslPath('C:\\Users\\A B\\proj'), '/mnt/c/Users/A B/proj');
  assert.equal(toWslPath('d:/work/app/'), '/mnt/d/work/app');
  assert.equal(toWslPath('E:\\'), '/mnt/e');
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\ann\\proj'), '/home/ann/proj');
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\ann'), '/home/ann');
  assert.equal(toWslPath('/home/ann/proj'), '/home/ann/proj');
  for (const bad of ['proj\\src', '\\\\server\\share\\x', '//server/share']) assert.throws(() => toWslPath(bad), /cannot map/, bad);
  assert.deepEqual(wslFromEnv({}, 'win32'), { exe: 'wsl.exe', distro: undefined });
  assert.equal(wslFromEnv({}, 'linux'), null);
  assert.deepEqual(wslFromEnv({ HELIX_SANDBOX_PROVIDER: 'wsl', HELIX_WSL_EXE: '/x/wsl', HELIX_WSL_DISTRO: 'Deb' }, 'linux'), { exe: '/x/wsl', distro: 'Deb' });
});

test('wsl sandbox provider: wsl.exe argv, env via WSLENV without secrets, timeout, PTY (NFR-6)', async () => {
  const shimDir = mkdtempSync(join(tmpdir(), 'helix-wsl-'));
  const log = join(shimDir, 'argv.log');
  const exe = writeShim(shimDir, 'wsl.exe', WSL_SHIM);
  const root = mkdtempSync(join(tmpdir(), 'helix-wslws-'));
  const sbx = new LocalSandbox('sbx_wsl', root, { wsl: { exe, distro: 'Ubuntu-24.04' } });
  try {
    assert.deepEqual({ provider: sbx.info().provider, network: sbx.info().network, fs: sbx.info().fsIsolation }, { provider: 'wsl', network: true, fs: false });
    const r = await sbx.exec('echo "$FOO|${GEMINI_API_KEY:-none}|$HELIX_SANDBOX|$HOME|$PWD"', { env: { FOO: 'bar', GEMINI_API_KEY: 'leak-me' } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), `bar|none|sbx_wsl|/tmp|${sbx.root}`);
    const first = JSON.parse(readFileSync(log, 'utf8').split('\n')[0]) as { argv: string[]; wslenv: string };
    assert.deepEqual(first.argv.slice(0, 7), ['-d', 'Ubuntu-24.04', '--cd', sbx.root, '--exec', 'bash', '-c']);
    const names = first.wslenv.split(':');
    for (const n of ['FOO/u', 'HELIX_SANDBOX/u', 'HOME/u', 'CI/u']) assert.ok(names.includes(n), `${n} in ${first.wslenv}`);
    assert.ok(!names.some((n) => n.startsWith('PATH') || n.startsWith('GEMINI')), first.wslenv);

    const slow = await sbx.exec('sleep 30', { timeoutMs: 500 });
    assert.equal(slow.timedOut, true);
    assert.ok(slow.durationMs < 5000, `killed promptly (${slow.durationMs} ms)`);

    let out = '';
    const exited = new Promise<void>((resolve) => {
      const pty = sbx.pty({ onData: (d) => { out += d; }, onExit: () => resolve() });
      pty.write('echo pty-$HELIX_SANDBOX-$((6*7))\n');
      const t = setInterval(() => { if (/pty-sbx_wsl-42/.test(out)) { clearInterval(t); pty.kill(); } }, 50);
      setTimeout(() => { clearInterval(t); pty.kill(); }, 10_000);
    });
    await exited;
    assert.match(out, /pty-sbx_wsl-42/, 'PTY shell runs inside the WSL program');
    assert.ok(readFileSync(log, 'utf8').includes('exec script -qfec'), 'PTY allocated by script inside WSL');
  } finally {
    sbx.destroy();
  }
});

test('Windows Credential Manager keychain: secret on stdin, never argv (F-AUTH-1, NFR-6)', () => {
  const shimDir = mkdtempSync(join(tmpdir(), 'helix-ps-'));
  writeShim(shimDir, 'powershell.exe', PS_SHIM);
  const env = { PATH: `${shimDir}:${dirname(process.execPath)}`, SHIM_LOG: join(shimDir, 'log'), SHIM_STORE: join(shimDir, 'store.json') };
  const kc = detectKeychain(env, 'win32');
  assert.equal(kc.kind, 'windows-credential-manager');
  assert.equal(kc.get('provider:gemini'), undefined);
  const secret = "AIza-win'secret\"$x";
  kc.set('provider:gemini', secret);
  assert.equal(kc.get('provider:gemini'), secret);
  assert.deepEqual(JSON.parse(readFileSync(env.SHIM_STORE, 'utf8')), { 'helix:provider:gemini': secret });
  kc.delete('provider:gemini');
  assert.equal(kc.get('provider:gemini'), undefined);
  const logText = readFileSync(env.SHIM_LOG, 'utf8');
  assert.ok(!logText.includes('win\'secret'), 'secret absent from argv and script');
  assert.equal(detectKeychain({ PATH: '/nonexistent' }, 'win32').kind, 'none');
});

test('Windows host denylist covers credential stores, case-insensitively (§25.5, NFR-6)', () => {
  const home = 'C:\\Users\\ann';
  assert.equal(isDeniedHostPath('c:\\users\\ANN\\appdata\\roaming\\microsoft\\credentials\\x', 'win32', home), true);
  assert.equal(isDeniedHostPath('C:\\Users\\ann\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data', 'win32', home), true);
  assert.equal(isDeniedHostPath('C:\\Users\\ann\\.SSH\\id_ed25519', 'win32', home), true);
  assert.equal(isDeniedHostPath('C:\\Users\\ann\\proj\\src\\a.ts', 'win32', home), false);
  assert.equal(isDeniedHostPath('C:\\Users\\ann\\AppData\\Roaming\\Microsoft\\CredentialsX', 'win32', home), false);
  assert.equal(isDeniedHostPath('/home/ann/.SSH/x', 'linux', '/home/ann'), false, 'POSIX stays case-sensitive');
  assert.equal(isDeniedHostPath('/home/ann/.ssh/x', 'linux', '/home/ann'), true);
});
