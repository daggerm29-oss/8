#!/usr/bin/env node
// Fake stdio MCP server for evals/m2-eval.ts: TOOL_COUNT (default 200) tools across SaaS-like domains.
// `weather_get_forecast` is read-only and returns ~60k chars (exercises result truncation).
import { createInterface } from 'node:readline';

const DOMAINS = ['issues', 'pulls', 'files', 'calendar', 'mail', 'billing', 'crm', 'deploy', 'metrics', 'chat'];
const VERBS = ['list', 'get', 'create', 'update', 'delete', 'search', 'archive', 'export', 'import', 'sync', 'assign', 'comment', 'label', 'close', 'reopen', 'watch', 'unwatch', 'share', 'pin', 'audit'];
const count = Number(process.env.TOOL_COUNT ?? 200);

const tools = [{
  name: 'weather_get_forecast',
  description: 'Get the hourly weather forecast for a city',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
}];
for (let i = 0; tools.length < count; i++) {
  const domain = DOMAINS[i % DOMAINS.length];
  const verb = VERBS[Math.floor(i / DOMAINS.length) % VERBS.length];
  const n = Math.floor(i / (DOMAINS.length * VERBS.length));
  tools.push({
    name: `${domain}_${verb}${n ? `_${n}` : ''}`,
    description: `${verb[0].toUpperCase()}${verb.slice(1)} ${domain} records in the connected workspace. Supports pagination and filtering by owner, status and date range.`,
    annotations: { readOnlyHint: ['list', 'get', 'search', 'export', 'audit'].includes(verb) },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `The ${domain} record id` },
        owner: { type: 'string', description: 'Filter by owner login' },
        status: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
      },
      required: verb === 'list' || verb === 'search' ? [] : ['id'],
    },
  });
}

const forecast = (city) => {
  const rows = [];
  for (let h = 0; rows.join('\n').length < 60_000; h++) rows.push(`${city} +${String(h).padStart(3, '0')}h temp=${(12 + Math.sin(h / 4) * 6).toFixed(1)}C wind=${(h * 7) % 40}km/h rain=${(h * 13) % 100}% cloud=${(h * 31) % 100}% uv=${h % 9}`);
  return rows.join('\n');
};

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'many-tools', version: '1.0.0' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    const text = name === 'weather_get_forecast' ? forecast(String(args?.city ?? 'Oslo')) : `${name}: ok`;
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
