import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startFakeProvider } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { McpManager, activatedTools, globMatch, searchTools, toolPermitted } from '../src/mcp/manager.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { classify, evaluate } from '../src/policy/policy.ts';

const SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

/** Streamable-HTTP MCP server fake: requires the session id after initialize; tools/call answers over SSE. */
async function startHttpMcp() {
  const log: Array<{ method: string; rpc?: string; session?: string; protocol?: string; auth?: string }> = [];
  const SESSION = 'sess-123';
  const tools = [
    { name: 'get_issue', description: 'Fetch an issue', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { name: 'delete_repo', description: 'Delete a repository', inputSchema: { type: 'object', properties: {} } },
  ];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const session = req.headers['mcp-session-id'] as string | undefined;
    const entry = { method: req.method!, session, protocol: req.headers['mcp-protocol-version'] as string | undefined, auth: req.headers.authorization };
    if (req.method === 'DELETE') { log.push(entry); res.writeHead(204).end(); return; }
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    log.push({ ...entry, rpc: msg.method ?? `response:${msg.id}` });
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-mcp', version: '2' } } }));
      return;
    }
    if (session !== SESSION) { res.writeHead(400).end('missing session'); return; }
    if (msg.id === undefined || msg.method === undefined) { res.writeHead(202).end(); return; }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }));
      return;
    }
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' })}\n\n`);
      const { name, arguments: args } = msg.params;
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] } })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, log, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('glob, allow/deny lists, tool search ranking, activation parsing', () => {
  assert.ok(globMatch('get_*', 'get_issue'));
  assert.ok(!globMatch('get_*', 'forget_issue'));
  assert.ok(globMatch('a.b', 'a.b') && !globMatch('a.b', 'axb'), 'dots are literal');
  assert.ok(toolPermitted({}, 'x'));
  assert.ok(!toolPermitted({ denyTools: ['delete_*'] }, 'delete_repo'));
  assert.ok(toolPermitted({ allowTools: ['get_*', 'create_issue'] }, 'create_issue'));
  assert.ok(!toolPermitted({ allowTools: ['get_*'] }, 'create_issue'));
  assert.ok(!toolPermitted({ allowTools: ['*'], denyTools: ['get_issue'] }, 'get_issue'), 'deny wins');
  const hits = searchTools([
    { name: 'mcp__gh__create_issue', description: 'Create a GitHub issue' },
    { name: 'mcp__gh__list_pulls', description: 'List pull requests' },
    { name: 'mcp__fs__read', description: 'Read a file; mentions issue tracking' },
  ], 'create issue');
  assert.equal(hits[0].name, 'mcp__gh__create_issue');
  assert.ok(!hits.some((h) => h.name === 'mcp__gh__list_pulls'));
  assert.deepEqual([...activatedTools(['- mcp__a__x: one\n- mcp__b__y: two\nThese tools are now available to call.', 'No MCP tools match'])], ['mcp__a__x', 'mcp__b__y']);
});

test('streamable HTTP transport: session id, SSE responses, filters, alwaysAllow persisted to mcp.json', async () => {
  const srv = await startHttpMcp();
  const home = mkdtempSync(join(tmpdir(), 'helix-mcp-http-'));
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ servers: { gh: { url: srv.url, headers: { Authorization: 'Bearer t0k' }, trust: 'trusted', denyTools: ['delete_*'] } } }));
  const registry = new ToolRegistry();
  const mgr = new McpManager({ home, registry });
  try {
    const [s] = await mgr.start();
    assert.equal(s.state, 'connected', s.error);
    assert.equal(s.transport, 'http');
    assert.equal(s.serverInfo?.name, 'http-mcp');
    assert.deepEqual(s.tools.map((t) => t.name), ['get_issue', 'create_issue']);
    assert.deepEqual(s.filtered, ['delete_repo']);
    assert.ok(!registry.has('mcp__gh__delete_repo'), 'denied tools are never registered');

    const out = await registry.run('mcp__gh__create_issue', { title: 'bug' }, { signal: new AbortController().signal } as never);
    assert.equal(out.content, 'create_issue:{"title":"bug"}', 'response found after a notification and a server request in the SSE stream');
    assert.ok(srv.log.some((l) => l.rpc === 'response:srv-1'), 'server→client request answered');
    const after = srv.log.filter((l) => l.rpc && l.rpc !== 'initialize');
    assert.ok(after.every((l) => l.session === 'sess-123' && l.protocol && l.auth === 'Bearer t0k'), 'session, protocol version and auth header on every later request');

    assert.equal(classify('mcp__gh__get_issue', {}).actionClass, 'read');
    assert.equal(evaluate({ tool: 'mcp__gh__create_issue', args: {}, profile: 'interactive' }).verdict, 'ask');
    assert.deepEqual(mgr.alwaysAllow('mcp__gh__create_issue'), { server: 'gh', tool: 'create_issue' });
    assert.equal(evaluate({ tool: 'mcp__gh__create_issue', args: {}, profile: 'interactive' }).verdict, 'allow');
    assert.equal(evaluate({ tool: 'mcp__gh__create_issue', args: {}, profile: 'headless' }).verdict, 'allow');
    assert.equal(evaluate({ tool: 'mcp__gh__create_issue', args: {}, profile: 'plan' }).verdict, 'deny', 'always-allow never overrides Plan Mode');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).servers.gh.alwaysAllow, ['create_issue']);
    assert.equal(mgr.alwaysAllow('read_file'), null);
  } finally {
    await mgr.close();
    await srv.close();
  }
  assert.ok(srv.log.some((l) => l.method === 'DELETE' && l.session === 'sess-123'), 'session terminated on close');

  const mgr2 = new McpManager({ home, registry: new ToolRegistry() });
  try {
    const srv2 = await startHttpMcp();
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ servers: { gh: { url: srv2.url, alwaysAllow: ['create_*'] } } }));
    const [s2] = await mgr2.start();
    assert.equal(s2.tools.find((t) => t.name === 'create_issue')?.alwaysAllow, true, 'alwaysAllow globs load from config');
    await mgr2.close();
    await srv2.close();
  } finally {
    await mgr2.close();
  }
});

test('tool search: MCP tools hidden above the threshold, activated by tool_search for later turns', async () => {
  const seen: string[][] = [];
  const fake = await startFakeProvider('gemini', ({ request, index }) => {
    seen.push((request.body.tools ?? []).flatMap((t: { functionDeclarations?: Array<{ name: string }> }) => (t.functionDeclarations ?? []).map((f) => f.name)));
    if (index === 0) return { toolCalls: [{ name: 'tool_search', args: { query: 'echo text' } }], usage: { input: 10, output: 5 } };
    if (index === 1) return { toolCalls: [{ name: 'mcp__fake__echo', args: { text: 'via search' } }], usage: { input: 10, output: 5 } };
    return { text: 'done', usage: { input: 10, output: 2 } };
  });
  const home = mkdtempSync(join(tmpdir(), 'helix-ts-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'helix-ts-repo-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.js'), 'export const a = 1;\n');
  const engine = new Engine({
    home, env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url }, indexing: false, retry: { baseDelayMs: 1, maxDelayMs: 2 },
    mcpServers: { fake: { command: process.execPath, args: [SERVER], trust: 'trusted' } }, mcpToolSearchThreshold: 2,
  });
  try {
    await engine.mcpReady;
    assert.ok(engine.mcp.toolSearchEnabled);
    const t = engine.runtime.create({ workspacePath: repo, goal: 'echo something', model: 'gemini-3.8-flash', policyProfile: 'headless' });
    engine.runtime.start(t.id);
    const done = await engine.runtime.wait(t.id, 20000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.ok(seen[0].includes('tool_search') && !seen[0].some((n) => n.startsWith('mcp__')), 'turn 1: MCP tools hidden');
    assert.ok(seen[1].includes('mcp__fake__echo') && !seen[1].includes('mcp__fake__record'), 'turn 2: only the matched tools activated');
    const transcript = engine.runtime.transcript(t.id) as Array<{ parts: Array<{ type: string; name?: string; content?: string }> }>;
    const echo = transcript.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'mcp__fake__echo');
    assert.equal(echo?.content, 'echo: via search');
  } finally {
    await engine.close();
    await fake.close();
  }
});
