import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { RpcPeer, Methods, PROTOCOL_VERSION, LEDGER_DIMENSIONS } from '@helix/protocol';
import { Engine, wsTransport } from '../src/engine.ts';
import { ledgerDashboard, ledgerRows, exportLedger } from '../src/models/ledger-dashboard.ts';

function csvRows(text: string) {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if (char === '\r' && text[i + 1] === '\n' && !quoted) { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += char;
  }
  const [headers, ...values] = rows;
  return values.map((fields) => Object.fromEntries(fields.map((value, i) => [headers[i], JSON.parse(value)])));
}
test('R1.6: real SQLite/RPC dashboard reconciles every dimension; scoped CSV/JSON exports round-trip every row without truncation', async () => {
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-ledger-home-')), indexing: false, mcp: false, env: {} });
  const repo = mkdtempSync(join(tmpdir(), 'helix-ledger-work-'));
  const other = mkdtempSync(join(tmpdir(), 'helix-ledger-other-'));
  const task = engine.runtime.create({ workspacePath: repo, goal: 'Ledger acceptance', start: false });
  const task2 = engine.runtime.create({ workspacePath: other, goal: 'Outside workspace', start: false });
  const ws = engine.runtime.workspaceFor(repo).id;
  const usage = { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 3, source: 'provider' as const };
  for (let i = 0; i < 251; i++) engine.ledger.record({ ws, task: task.id, agent: i % 2 ? 'primary' : '=SUM(1,2)\n"agent"', role: 'coder', provider: i % 2 ? 'gemini' : 'openai', model: i % 2 ? 'model-a' : 'model-b', usage, latencyMs: i, status: 'ok', toolTokens: { read_file: 20, run_shell: 10 }, contextBreakdown: { system: 50, tool_results: 30, user: 20 } }, { inputPerM: 1, outputPerM: 2, asOf: '2026-11-11' });
  engine.ledger.record({ ws, task: task.id, role: 'coder', provider: 'unpriced', model: 'unknown', usage, latencyMs: 1, status: 'ok', toolTokens: {} }, undefined);
  engine.ledger.record({ ws, task: task.id, role: 'coder', provider: 'gemini', model: 'model-a', usage, latencyMs: 1, status: 'error' }, undefined);
  engine.ledger.record({ ws: engine.runtime.workspaceFor(other).id, task: task2.id, role: 'coder', provider: 'other', model: 'other', usage, latencyMs: 1, status: 'ok' }, { inputPerM: 99, outputPerM: 99, asOf: '2026-11-11' });
  let peer: RpcPeer | undefined;
  let socket: WebSocket | undefined;
  try {
    const dashboard = ledgerDashboard(engine.db, engine.ledger, { ws });
    assert.equal(dashboard.entries, 253); assert.equal(dashboard.totals.calls, 252); assert.equal(dashboard.unknownCostCalls, 1);
    for (const dimension of LEDGER_DIMENSIONS) {
      for (const field of Object.keys(dashboard.totals) as (keyof typeof dashboard.totals)[]) {
        const sum = dashboard.groups[dimension].reduce((total, row) => total + row[field], 0);
        assert.ok(Math.abs(sum - dashboard.totals[field]) < 1e-8, `${dimension}.${field}: ${sum} vs ${dashboard.totals[field]}`);
      }
    }
    assert.equal(dashboard.groups.tool.find((g) => g.key === 'read_file')?.attributedToolTokens, 5020);
    const expected = ledgerRows(engine.db, { ws });
    assert.deepEqual(JSON.parse(exportLedger(engine.db, { ws }, 'json').content), expected);
    assert.deepEqual(csvRows(exportLedger(engine.db, { ws }, 'csv').content), expected);
    assert.deepEqual(csvRows(exportLedger(engine.db, { task: 'absent' }, 'csv').content), []);
    assert.throws(() => exportLedger(engine.db, { ws }, 'xml' as 'csv'), /format/);
    assert.throws(() => ledgerRows(engine.db, { task: 42 as unknown as string }), /invalid/);
    assert.deepEqual(ledgerRows(engine.db, { task: "' OR 1=1 --" }), []);
    const { port, token } = await engine.serve();
    socket = await new Promise<WebSocket>((resolve, reject) => { const socket = new WebSocket(`ws://127.0.0.1:${port}/`); socket.on('open', () => resolve(socket)); socket.on('error', reject); });
    peer = new RpcPeer(wsTransport(socket));
    await peer.request(Methods.initialize, { clientName: 'ledger-test', clientVersion: '0.1', protocolVersion: PROTOCOL_VERSION, token });
    const actual = await peer.request(Methods.ledgerDashboard, { workspacePath: repo });
    assert.deepEqual(actual, dashboard);
    const queried = await peer.request<{ totals: unknown; entries: unknown[] }>(Methods.ledgerQuery, { workspacePath: repo, entries: true });
    assert.deepEqual(queried.totals, dashboard.totals); assert.deepEqual(queried.entries, expected);
    const exported = await peer.request<{ content: string }>(Methods.ledgerExport, { workspacePath: repo, format: 'json' });
    assert.deepEqual(JSON.parse(exported.content), expected);
    await assert.rejects(peer.request(Methods.ledgerExport, { workspacePath: repo, format: 'xml' }), /format/);
    await assert.rejects(peer.request(Methods.ledgerDashboard, { task: 42 }), /invalid/);
  } finally { socket?.close(); peer?.close(); await engine.close(); }
});
