#!/usr/bin/env node
// Fake stdio MCP server for mcp.test.ts. Tools: echo (readOnly), record (writes MARKER_FILE), fail, slow. Paginates tools/list.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const tools = [
  { name: 'echo', description: 'Echo text back', annotations: { readOnlyHint: true }, inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' }, n: { type: ['integer', 'null'] } }, required: ['text'], additionalProperties: false } },
  { name: 'record', description: 'Append a line to the marker file', inputSchema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] } },
  { name: 'fail', description: 'Always returns a tool error', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stderr.write('fake-mcp starting\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    if (process.env.LEAK_CHECK && process.env.GEMINI_API_KEY) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'engine secret leaked into MCP env' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } });
  }
  if (msg.method === 'tools/list') {
    const page = msg.params?.cursor === 'p2' ? 1 : 0;
    return send({ jsonrpc: '2.0', id: msg.id, result: page === 0 ? { tools: tools.slice(0, 2), nextCursor: 'p2' } : { tools: tools.slice(2) } });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'echo') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
    if (name === 'record') { appendFileSync(process.env.MARKER_FILE, args.line + '\n'); return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'recorded' }] } }); }
    if (name === 'fail') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
    if (name === 'slow') return;
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
