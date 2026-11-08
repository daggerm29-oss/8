import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';

const SECRET = 'AIzaKeychainTestSecret-7f3a9c';

/** Fake libsecret `secret-tool`: JSON-file store, logs its argv so the test can prove the secret never travels there. */
function shim(dir: string): void {
  const script = `#!/usr/bin/env node
const fs = require('fs');
const [cmd, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const store = fs.existsSync(process.env.SHIM_STORE) ? JSON.parse(fs.readFileSync(process.env.SHIM_STORE, 'utf8')) : {};
const attrs = rest.filter((a) => !a.startsWith('--'));
const key = attrs.join('|');
if (cmd === 'store') {
  const secret = fs.readFileSync(0, 'utf8');
  store[key] = secret;
  fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store));
} else if (cmd === 'lookup') {
  if (!(key in store)) process.exit(1);
  process.stdout.write(store[key]);
} else if (cmd === 'clear') {
  delete store[key];
  fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store));
} else process.exit(2);
`;
  writeFileSync(join(dir, 'secret-tool'), script);
  chmodSync(join(dir, 'secret-tool'), 0o755);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function connect(engine: Engine): Promise<{ peer: RpcPeer; sock: WebSocket }> {
  const { port, token } = await engine.serve({ ui: false });
  const sock = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(wsTransport(sock));
  await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
  return { peer, sock };
}

test('provider keys live in the OS keychain, never in Helix storage (F-AUTH-1)', { skip: process.platform !== 'linux' && 'libsecret shim is Linux-only' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const shimDir = mkdtempSync(join(tmpdir(), 'helix-shim-'));
  shim(shimDir);
  const env = { PATH: `${shimDir}:${dirname(process.execPath)}`, SHIM_STORE: join(shimDir, 'store.json'), SHIM_LOG: join(shimDir, 'argv.log') };
  const opts = { home, recover: false, mcp: false, indexing: false } as const;

  const first = new Engine({ ...opts, env });
  const { peer, sock } = await connect(first);
  try {
    assert.deepEqual(await peer.request(Methods.vaultStatus, {}), { keychain: 'libsecret', providers: [{ id: 'gemini', source: null }, { id: 'openai', source: null }] });
    await assert.rejects(peer.request(Methods.vaultSetKey, { provider: 'acme', key: 'x' }), /unknown provider/);
    await assert.rejects(peer.request(Methods.vaultSetKey, { provider: 'gemini', key: '  ' }), /non-empty/);
    const set = await peer.request(Methods.vaultSetKey, { provider: 'gemini', key: SECRET });
    assert.deepEqual(set, { ok: true, provider: 'gemini', source: 'keychain' });
    assert.ok(!JSON.stringify(await peer.request(Methods.vaultStatus, {})).includes(SECRET), 'status never returns the key');
    assert.equal(first.vault.providerAuth('gemini').apiKey, SECRET);
  } finally {
    sock.close();
    await first.close();
  }

  const store = JSON.parse(readFileSync(env.SHIM_STORE, 'utf8')) as Record<string, string>;
  assert.equal(store['service|helix|account|provider:gemini'], SECRET, 'stored under service=helix account=provider:gemini');
  assert.ok(!readFileSync(env.SHIM_LOG, 'utf8').includes(SECRET), 'secret travels on stdin, never argv');
  for (const f of filesUnder(home)) assert.ok(!readFileSync(f).includes(SECRET), `key leaked into ${f}`);

  const second = new Engine({ ...opts, env });
  try {
    assert.equal(second.vault.providerAuth('gemini').apiKey, SECRET, 'a fresh Engine resolves the key from the keychain');
    assert.equal(second.vault.keySource('gemini'), 'keychain');
    assert.equal(second.vault.isConfigured('gemini'), true);
  } finally {
    await second.close();
  }

  const withEnv = new Engine({ ...opts, env: { ...env, GEMINI_API_KEY: 'env-wins' } });
  try {
    assert.equal(withEnv.vault.providerAuth('gemini').apiKey, 'env-wins', 'environment overrides the keychain');
    assert.equal(withEnv.vault.keySource('gemini'), 'env');
  } finally {
    await withEnv.close();
  }

  const third = new Engine({ ...opts, env });
  const c3 = await connect(third);
  try {
    assert.deepEqual(await c3.peer.request(Methods.vaultDeleteKey, { provider: 'gemini' }), { ok: true, provider: 'gemini', source: null });
    assert.equal(third.vault.providerAuth('gemini').apiKey, undefined);
  } finally {
    c3.sock.close();
    await third.close();
  }
  assert.deepEqual(JSON.parse(readFileSync(env.SHIM_STORE, 'utf8')), {}, 'delete clears the keychain entry');

  const bare = new Engine({ ...opts, home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: {} });
  const c4 = await connect(bare);
  try {
    assert.equal((await c4.peer.request(Methods.vaultStatus, {}) as { keychain: string }).keychain, 'none');
    await assert.rejects(c4.peer.request(Methods.vaultSetKey, { provider: 'gemini', key: SECRET }), /no OS keychain available/);
    assert.ok(!existsSync(join(bare.home, 'keys.json')));
  } finally {
    c4.sock.close();
    await bare.close();
  }
});
