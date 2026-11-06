import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Methods, PROTOCOL_VERSION, RpcPeer } from '@helix/protocol';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine, wsTransport } from '../src/engine.ts';
import { McpManager, exposedName, sanitizeSchema } from '../src/mcp/manager.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { classify, evaluate } from '../src/policy/policy.ts';

const SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

test('sanitizeSchema + exposedName', () => {
  const s = sanitizeSchema({ $schema: 'x', type: 'object', properties: { a: { type: ['integer', 'null'] }, b: { type: 'array', items: { type: 'string' } } }, required: ['a', 'zz'], additionalProperties: false }) as unknown as Record<string, unknown>;
  assert.deepEqual(s, { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'array', items: { type: 'string' } } }, required: ['a'] });
  assert.equal(exposedName('my.server', 'do thing'), 'mcp__my_server__do_thing');
  assert.ok(exposedName('s', 'x'.repeat(100)).length <= 64);
});

test('McpManager: connect, paginated tools/list, call, errors, timeout, policy classes, env isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-mcp-'));
  const marker = join(dir, 'marker.txt');
  const registry = new ToolRegistry();
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'secret-should-not-leak';
  const mgr = new McpManager({
    home: dir, registry,
    config: {
      fake: { command: process.execPath, args: [SERVER], env: { MARKER_FILE: marker, LEAK_CHECK: '1' }, trust: 'trusted', timeoutMs: 500 },
      untrusted: { command: process.execPath, args: [SERVER], env: { MARKER_FILE: marker } },
      broken: { command: '/nonexistent/mcp-binary' },
      off: { command: 'x', enabled: false },
    },
  });
  try {
    const status = await mgr.start();
    const by = Object.fromEntries(status.map((s) => [s.name, s]));
    assert.equal(by.fake.state, 'connected', by.fake.error);
    assert.equal(by.fake.serverInfo?.name, 'fake-mcp');
    assert.deepEqual(by.fake.tools.map((t) => t.name), ['echo', 'record', 'fail', 'slow'], 'both tools/list pages loaded');
    assert.equal(by.broken.state, 'failed');
    assert.equal(by.off.state, 'disabled');

    assert.equal(classify('mcp__fake__echo', {}).actionClass, 'read', 'trusted readOnlyHint → read');
    assert.equal(classify('mcp__untrusted__echo', {}).actionClass, 'network', 'untrusted annotations ignored');
    assert.equal(classify('mcp__fake__record', {}).actionClass, 'network');
    assert.equal(evaluate({ tool: 'mcp__fake__record', args: {}, profile: 'headless' }).verdict, 'deny');
    assert.equal(evaluate({ tool: 'mcp__fake__record', args: {}, profile: 'headless', preapprove: ['tool:mcp__fake__record'] }).verdict, 'allow');
    assert.equal(evaluate({ tool: 'mcp__fake__echo', args: {}, profile: 'plan' }).verdict, 'allow');

    const ctx = { signal: new AbortController().signal } as never;
    const echo = await registry.run('mcp__fake__echo', { text: 'hi' }, ctx);
    assert.equal(echo.content, 'echo: hi');
    assert.ok(!echo.isError);
    assert.match((await registry.run('mcp__fake__echo', {}, ctx)).content, /args\.text is required/, 'sanitized schema still validates');
    const fail = await registry.run('mcp__fake__fail', {}, ctx);
    assert.equal(fail.isError, true);
    assert.equal(fail.content, 'boom');
    const slow = await registry.run('mcp__fake__slow', {}, ctx);
    assert.equal(slow.isError, true);
    assert.match(slow.content, /timed out/);
    await registry.run('mcp__fake__record', { line: 'one' }, ctx);
    assert.equal(readFileSync(marker, 'utf8'), 'one\n');
  } finally {
    await mgr.close();
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('engine: MCP tools reach the model; headless denies side-effecting MCP calls unless preapproved', async () => {
  const fake = await startFakeProvider('gemini', ({ index }) => (index % 2 === 0
    ? { toolCalls: [{ name: 'mcp__fake__record', args: { line: 'from-agent' } }], usage: { input: 10, output: 5 } }
    : { text: 'done', usage: { input: 10, output: 2 } }));
  const home = mkdtempSync(join(tmpdir(), 'helix-mcp-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'helix-mcp-repo-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.js'), 'export const a = 1;\n');
  const marker = join(home, 'marker.txt');
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ servers: { fake: { command: process.execPath, args: [SERVER], env: { MARKER_FILE: marker } } } }));
  const engine = new Engine({ home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  try {
    const { port, token } = await engine.serve();
    const ws = await new Promise<WebSocket>((resolve, reject) => { const s = new WebSocket(`ws://127.0.0.1:${port}/`); s.once('open', () => resolve(s)); s.once('error', reject); });
    const peer = new RpcPeer(wsTransport(ws));
    await peer.request(Methods.initialize, { clientName: 't', clientVersion: '0', protocolVersion: PROTOCOL_VERSION, token });
    const servers = await peer.request<Array<{ name: string; state: string; tools: unknown[] }>>(Methods.mcpList, {});
    assert.equal(servers[0].state, 'connected');
    assert.equal(servers[0].tools.length, 4);

    const denied = await peer.request<{ id: string }>(Methods.taskCreate, { workspacePath: repo, goal: 'record', model: 'gemini-3.8-flash', policyProfile: 'headless', start: true });
    assert.equal((await peer.request<{ status: string }>(Methods.taskWait, { id: denied.id, timeoutMs: 20000 })).status, 'done');
    assert.ok(!existsSync(marker), 'headless denied the MCP side effect');

    const allowed = await peer.request<{ id: string }>(Methods.taskCreate, { workspacePath: repo, goal: 'record', model: 'gemini-3.8-flash', policyProfile: 'headless', preapprove: ['tool:mcp__fake__record'], start: true });
    assert.equal((await peer.request<{ status: string }>(Methods.taskWait, { id: allowed.id, timeoutMs: 20000 })).status, 'done');
    assert.equal(readFileSync(marker, 'utf8'), 'from-agent\n');
    peer.close();
  } finally {
    await engine.close();
    await fake.close();
  }
});
