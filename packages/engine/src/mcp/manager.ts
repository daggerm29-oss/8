import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonSchema } from '@helix/protocol';
import type { ToolRegistry } from '../tools/registry.ts';
import { registerToolClass } from '../policy/policy.ts';
import { McpStdioClient, type McpCallResult, type McpToolInfo } from './client.ts';

/**
 * MCP client manager (F-MCP-1, Arch §14.3). Reads `$HELIX_HOME/mcp.json`:
 *
 *   { "servers": { "<name>": { "command": "npx", "args": ["-y", "pkg"], "env": {}, "cwd": "…",
 *                              "trust": "untrusted" | "trusted", "enabled": true, "timeoutMs": 60000 } } }
 *
 * Each server tool is exposed to models as `mcp__<server>__<tool>`. Policy (F-MCP-3 v0): every MCP tool is
 * `network` (ask; denied in headless unless `--allow network` / `--allow tool:<name>`), except tools that a
 * *trusted* server annotates `readOnlyHint: true`, which are `read`. Untrusted servers' annotations are ignored.
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  trust?: 'trusted' | 'untrusted';
  enabled?: boolean;
  timeoutMs?: number;
}

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'failed' | 'disabled' | 'stopped';
  error?: string;
  serverInfo?: { name?: string; version?: string };
  tools: Array<{ name: string; exposedAs: string; actionClass: 'read' | 'network'; description?: string }>;
}

const NAME_RE = /[^a-zA-Z0-9_-]/g;
const MAX_TOOL_NAME = 64;

export function exposedName(server: string, tool: string): string {
  return `mcp__${server.replace(NAME_RE, '_')}__${tool.replace(NAME_RE, '_')}`.slice(0, MAX_TOOL_NAME);
}

/** Reduce an arbitrary MCP input schema to the JSON-schema subset every provider adapter accepts. */
export function sanitizeSchema(s: unknown, depth = 0): JsonSchema {
  const src = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  const rawType = Array.isArray(src.type) ? (src.type as string[]).find((t) => t !== 'null') : src.type;
  const type = typeof rawType === 'string' ? rawType : src.properties ? 'object' : 'string';
  const out: Record<string, unknown> = { type };
  if (typeof src.description === 'string') out.description = src.description.slice(0, 1000);
  if (Array.isArray(src.enum) && src.enum.every((e) => typeof e === 'string')) out.enum = src.enum;
  if (typeof src.minimum === 'number') out.minimum = src.minimum;
  if (typeof src.maximum === 'number') out.maximum = src.maximum;
  if (type === 'object') {
    const props = (src.properties && typeof src.properties === 'object' ? src.properties : {}) as Record<string, unknown>;
    out.properties = depth > 6 ? {} : Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sanitizeSchema(v, depth + 1)]));
    if (Array.isArray(src.required)) out.required = (src.required as unknown[]).filter((r): r is string => typeof r === 'string' && r in props);
  }
  if (type === 'array') out.items = depth > 6 ? { type: 'string' } : sanitizeSchema(src.items ?? { type: 'string' }, depth + 1);
  return out as unknown as JsonSchema;
}

export function formatResult(r: McpCallResult): string {
  const parts = (r.content ?? []).map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
    if (c.type === 'resource_link') return `[resource link ${(c as { uri?: string }).uri ?? ''}]`;
    return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} content omitted]`;
  });
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return parts.join('\n') || '(empty result)';
}

export class McpManager {
  private readonly clients = new Map<string, McpStdioClient>();
  private readonly status = new Map<string, McpServerStatus>();

  private readonly o: { home: string; registry: ToolRegistry; logger?: { info: (m: string, d?: Record<string, unknown>) => void; warn: (m: string, d?: Record<string, unknown>) => void }; config?: Record<string, McpServerConfig> };

  constructor(o: McpManager['o']) {
    this.o = o;
  }

  loadConfig(): Record<string, McpServerConfig> {
    if (this.o.config) return this.o.config;
    const path = join(this.o.home, 'mcp.json');
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { servers?: Record<string, McpServerConfig>; mcpServers?: Record<string, McpServerConfig> };
      return parsed.servers ?? parsed.mcpServers ?? {};
    } catch (e) {
      this.o.logger?.warn('invalid mcp.json', { error: (e as Error).message });
      return {};
    }
  }

  /** Connect every enabled server concurrently; failures are recorded per server and never throw. */
  async start(): Promise<McpServerStatus[]> {
    const cfg = this.loadConfig();
    await Promise.all(Object.entries(cfg).map(([name, c]) => this.startServer(name, c)));
    return this.list();
  }

  private async startServer(name: string, c: McpServerConfig): Promise<void> {
    if (c.enabled === false) { this.status.set(name, { name, state: 'disabled', tools: [] }); return; }
    if (!c.command) { this.status.set(name, { name, state: 'failed', error: 'missing command', tools: [] }); return; }
    const client = new McpStdioClient({
      command: c.command, args: c.args, env: c.env, cwd: c.cwd, requestTimeoutMs: c.timeoutMs,
      onStderr: (line) => this.o.logger?.info('mcp stderr', { server: name, line: line.slice(0, 500) }),
    });
    try {
      await client.connect();
      const tools = client.capabilities && !('tools' in client.capabilities) ? [] : await client.listTools();
      this.clients.set(name, client);
      const registered = tools.map((t) => this.registerTool(name, c, client, t)).filter((t): t is NonNullable<typeof t> => !!t);
      this.status.set(name, { name, state: 'connected', serverInfo: client.serverInfo, tools: registered });
      this.o.logger?.info('mcp server connected', { server: name, tools: registered.length });
    } catch (e) {
      await client.close().catch(() => {});
      this.status.set(name, { name, state: 'failed', error: (e as Error).message, tools: [] });
      this.o.logger?.warn('mcp server failed', { server: name, error: (e as Error).message });
    }
  }

  private registerTool(server: string, c: McpServerConfig, client: McpStdioClient, t: McpToolInfo) {
    const exposedAs = exposedName(server, t.name);
    if (this.o.registry.has(exposedAs)) { this.o.logger?.warn('mcp tool name collision', { server, tool: t.name, exposedAs }); return null; }
    const actionClass = c.trust === 'trusted' && t.annotations?.readOnlyHint === true ? 'read' as const : 'network' as const;
    registerToolClass(exposedAs, actionClass, `MCP tool ${server}/${t.name}${actionClass === 'read' ? ' (trusted read-only)' : ''}`);
    const description = `[MCP ${server}] ${t.description ?? t.annotations?.title ?? t.name}`.slice(0, 1024);
    this.o.registry.register({
      spec: { name: exposedAs, description, inputSchema: sanitizeSchema(t.inputSchema ?? { type: 'object', properties: {} }) },
      run: async (args, ctx) => {
        if (!client.running) return { content: `MCP server '${server}' is not running`, isError: true };
        const r = await client.callTool(t.name, args, ctx.signal);
        const content = formatResult(r);
        return { content, isError: r.isError === true, summary: `${server}/${t.name}: ${content.split('\n')[0].slice(0, 120)}` };
      },
    });
    return { name: t.name, exposedAs, actionClass, description: t.description };
  }

  list(): McpServerStatus[] {
    return [...this.status.values()];
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    for (const s of this.status.values()) if (s.state === 'connected') s.state = 'stopped';
  }
}
