import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';

test('users reach structural and graph queries through the engine API (FR-9)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'helix-index-rpc-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/money.ts'), 'export function toCents(x: number): number {\n  return Math.round(x * 100);\n}\n');
  writeFileSync(join(root, 'src/cart.ts'), "import { toCents } from './money';\nexport function total(xs: number[]): number {\n  return xs.reduce((s, x) => s + toCents(x), 0);\n}\nexport async function load() {\n  return fetch('/api/cart');\n}\n");
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: {}, recover: false, mcp: false, indexing: false });
  const { port, token } = await engine.serve({ ui: false });
  const sock = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(wsTransport(sock));
  try {
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
    const structural = await peer.request(Methods.indexStructural, { workspacePath: root, pattern: 'call(fetch, _)' }) as { matches: Array<{ path: string; line: number }> };
    assert.deepEqual(structural.matches.map((m) => [m.path, m.line]), [['src/cart.ts', 6]]);
    const callers = await peer.request(Methods.indexGraph, { workspacePath: root, op: 'callers', target: 'toCents' }) as { items: Array<{ path: string; symbol?: string }> };
    assert.deepEqual(callers.items.map((i) => `${i.path}:${i.symbol}`), ['src/cart.ts:total']);
    const search = await peer.request(Methods.indexSearch, { workspacePath: root, query: 'convert dollars to cents' }) as Array<{ symbol: string | null; why: string[] }>;
    assert.ok(search.some((h) => h.symbol === 'toCents'));
  } finally {
    sock.close();
    await engine.close();
  }
});
