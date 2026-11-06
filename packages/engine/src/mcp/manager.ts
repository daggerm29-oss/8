import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonSchema } from '@helix/protocol';
import type { ToolRegistry } from '../tools/registry.ts';
import { registerToolClass } from '../policy/policy.ts';
import { McpStdioClient, type McpCallResult, type McpToolInfo } from './client.ts';
import { McpHttpClient } from './http.ts';

type McpClient = McpStdioClient | McpHttpClient;

/**
 * MCP client manager (F-MCP-1, Arch §14.3). Reads `$HELIX_HOME/mcp.json`:
 *
 *   { "servers": { "<name>": { "command": "npx", "args": ["-y", "pkg"], "env": {}, "cwd": "…",
 *                              "trust": "untrusted" | "trusted", "enabled": true, "timeoutMs": 60000,
 *                              "allowTools": ["get_*"], "denyTools": ["delete_*"], "alwaysAllow": ["search"] },
 *                  "<remote>": { "url": "https://host/mcp", "headers": { "Authorization": "Bearer …" } } },
 *     "toolSearchThreshold": 30 }
 *
 * `allowTools`/`denyTools` take exact tool names or `*` globs; filtered tools are never registered.
 * `alwaysAllow` tools skip the approval prompt (still denied in Plan Mode). When more than
 * `toolSearchThreshold` MCP tools are registered they are hidden behind `tool_search` (F-MCP-2, X7).
 *
 * Each server tool is exposed to models as `mcp__<server>__<tool>`. Policy (F-MCP-3 v0): every MCP tool is
 * `network` (ask; denied in headless unless `--allow network` / `--allow tool:<name>`), except tools that a
 * *trusted* server annotates `readOnlyHint: true`, which are `read`. Untrusted servers' annotations are ignored.
 */
export interface McpServerConfig {
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  allowTools?: string[];
  denyTools?: string[];
  alwaysAllow?: string[];
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
  transport?: 'stdio' | 'http';
  tools: Array<{ name: string; exposedAs: string; actionClass: 'read' | 'network'; alwaysAllow?: boolean; description?: string }>;
  filtered?: string[];
}

export interface McpConfigFile {
  servers?: Record<string, McpServerConfig>;
  mcpServers?: Record<string, McpServerConfig>;
  toolSearchThreshold?: number;
}

export const DEFAULT_TOOL_SEARCH_THRESHOLD = 30;

export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** True when the tool passes the server's allow/deny lists (deny wins). */
export function toolPermitted(c: Pick<McpServerConfig, 'allowTools' | 'denyTools'>, tool: string): boolean {
  if (c.denyTools?.some((p) => globMatch(p, tool))) return false;
  if (c.allowTools && c.allowTools.length) return c.allowTools.some((p) => globMatch(p, tool));
  return true;
}

export function mcpConfigPath(home: string): string {
  return join(home, 'mcp.json');
}

export function readMcpConfigFile(home: string): McpConfigFile {
  const path = mcpConfigPath(home);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as McpConfigFile;
}

/** Atomic write of `$HELIX_HOME/mcp.json` (owner-only: it can hold auth headers). */
export function writeMcpConfigFile(home: string, cfg: McpConfigFile): void {
  const path = mcpConfigPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
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
  private readonly clients = new Map<string, McpClient>();
  private readonly status = new Map<string, McpServerStatus>();
  private readonly configs = new Map<string, McpServerConfig>();
  private toolSearchThreshold = DEFAULT_TOOL_SEARCH_THRESHOLD;

  private readonly o: { home: string; registry: ToolRegistry; logger?: { info: (m: string, d?: Record<string, unknown>) => void; warn: (m: string, d?: Record<string, unknown>) => void }; config?: Record<string, McpServerConfig>; toolSearchThreshold?: number };

  constructor(o: McpManager['o']) {
    this.o = o;
  }

  loadConfig(): Record<string, McpServerConfig> {
    if (this.o.toolSearchThreshold !== undefined) this.toolSearchThreshold = this.o.toolSearchThreshold;
    if (this.o.config) return this.o.config;
    try {
      const parsed = readMcpConfigFile(this.o.home);
      if (this.o.toolSearchThreshold === undefined && typeof parsed.toolSearchThreshold === 'number') this.toolSearchThreshold = parsed.toolSearchThreshold;
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
    this.applyToolSearch();
    return this.list();
  }

  /** Hide MCP tools behind `tool_search` when there are too many to send on every turn (F-MCP-2, X7). */
  private applyToolSearch(): void {
    const all = this.list().flatMap((s) => s.tools.map((t) => t.exposedAs));
    if (all.length <= this.toolSearchThreshold) return;
    for (const name of all) this.o.registry.defer(name);
    if (!this.o.registry.has(TOOL_SEARCH)) this.o.registry.register(toolSearchTool(this.o.registry));
    this.o.logger?.info('mcp tool search enabled', { tools: all.length, threshold: this.toolSearchThreshold });
  }

  get toolSearchEnabled(): boolean {
    return this.o.registry.has(TOOL_SEARCH);
  }

  /**
   * "Always allow" from an approval (F-MCP-3): mark the tool auto-approved now and persist it into the
   * server's `alwaysAllow` list in mcp.json (inline test configs are only updated in memory).
   */
  alwaysAllow(exposedAs: string): { server: string; tool: string } | null {
    for (const s of this.status.values()) {
      const t = s.tools.find((x) => x.exposedAs === exposedAs);
      if (!t) continue;
      t.alwaysAllow = true;
      registerToolClass(exposedAs, t.actionClass, `MCP tool ${s.name}/${t.name} (always allowed)`, { autoAllow: true });
      const c = this.configs.get(s.name);
      if (c) c.alwaysAllow = [...new Set([...(c.alwaysAllow ?? []), t.name])];
      if (!this.o.config) {
        const file = readMcpConfigFile(this.o.home);
        const servers = file.servers ?? file.mcpServers ?? {};
        if (servers[s.name]) {
          servers[s.name].alwaysAllow = [...new Set([...(servers[s.name].alwaysAllow ?? []), t.name])];
          writeMcpConfigFile(this.o.home, file);
        }
      }
      return { server: s.name, tool: t.name };
    }
    return null;
  }

  private async startServer(name: string, c: McpServerConfig): Promise<void> {
    if (c.enabled === false) { this.status.set(name, { name, state: 'disabled', tools: [] }); return; }
    this.configs.set(name, c);
    const transport = c.url ? 'http' as const : 'stdio' as const;
    if (!c.command && !c.url) { this.status.set(name, { name, state: 'failed', error: 'missing command or url', transport, tools: [] }); return; }
    const client: McpClient = c.url
      ? new McpHttpClient({ url: c.url, headers: c.headers, requestTimeoutMs: c.timeoutMs })
      : new McpStdioClient({
        command: c.command!, args: c.args, env: c.env, cwd: c.cwd, requestTimeoutMs: c.timeoutMs,
        onStderr: (line) => this.o.logger?.info('mcp stderr', { server: name, line: line.slice(0, 500) }),
      });
    try {
      await client.connect();
      const tools = client.capabilities && !('tools' in client.capabilities) ? [] : await client.listTools();
      this.clients.set(name, client);
      const filtered = tools.filter((t) => !toolPermitted(c, t.name)).map((t) => t.name);
      const registered = tools.filter((t) => toolPermitted(c, t.name)).map((t) => this.registerTool(name, c, client, t)).filter((t): t is NonNullable<typeof t> => !!t);
      this.status.set(name, { name, state: 'connected', transport, serverInfo: client.serverInfo, tools: registered, ...(filtered.length ? { filtered } : {}) });
      this.o.logger?.info('mcp server connected', { server: name, tools: registered.length });
    } catch (e) {
      await client.close().catch(() => {});
      this.status.set(name, { name, state: 'failed', error: (e as Error).message, transport, tools: [] });
      this.o.logger?.warn('mcp server failed', { server: name, error: (e as Error).message });
    }
  }

  private registerTool(server: string, c: McpServerConfig, client: McpClient, t: McpToolInfo) {
    const exposedAs = exposedName(server, t.name);
    if (this.o.registry.has(exposedAs)) { this.o.logger?.warn('mcp tool name collision', { server, tool: t.name, exposedAs }); return null; }
    const actionClass = c.trust === 'trusted' && t.annotations?.readOnlyHint === true ? 'read' as const : 'network' as const;
    const alwaysAllow = c.alwaysAllow?.some((p) => globMatch(p, t.name)) ?? false;
    registerToolClass(exposedAs, actionClass, `MCP tool ${server}/${t.name}${actionClass === 'read' ? ' (trusted read-only)' : ''}${alwaysAllow ? ' (always allowed)' : ''}`, { autoAllow: alwaysAllow });
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
    return { name: t.name, exposedAs, actionClass, ...(alwaysAllow ? { alwaysAllow } : {}), description: t.description };
  }

  list(): McpServerStatus[] {
    return [...this.status.values()];
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    for (const s of this.status.values()) if (s.state === 'connected') s.state = 'stopped';
  }
}

export const TOOL_SEARCH = 'tool_search';
const ACTIVATED_RE = /^- (mcp__[A-Za-z0-9_-]+):/gm;

/** Tool names a `tool_search` result activated (derived from the transcript, so it survives restarts). */
export function activatedTools(results: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of results) for (const m of r.matchAll(ACTIVATED_RE)) out.add(m[1]);
  return out;
}

export function searchTools(specs: Array<{ name: string; description: string }>, query: string, limit = 8): Array<{ name: string; description: string; score: number }> {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  return specs
    .map((s) => {
      const name = s.name.toLowerCase();
      const hay = `${name.replace(/_/g, ' ')} ${s.description.toLowerCase()}`;
      let score = 0;
      for (const t of terms) {
        if (name.split(/_+/).includes(t)) score += 3;
        else if (name.includes(t)) score += 2;
        else if (hay.includes(t)) score += 1;
      }
      if (name === query.toLowerCase()) score += 10;
      return { ...s, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function toolSearchTool(registry: ToolRegistry) {
  return {
    spec: {
      name: TOOL_SEARCH,
      description: 'Search the available MCP (external) tools by keyword. Matching tools become callable on your next turn. Use this before assuming a capability is missing.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords describing the capability, e.g. "create github issue"' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] } as unknown as JsonSchema,
    },
    run: async (args: Record<string, unknown>) => {
      const hits = searchTools(registry.deferredSpecs(), String(args.query), typeof args.limit === 'number' ? args.limit : 8);
      if (!hits.length) return { content: `No MCP tools match '${String(args.query)}'.`, summary: `tool_search: 0 matches` };
      return {
        content: `${hits.map((h) => `- ${h.name}: ${h.description.slice(0, 200)}`).join('\n')}\nThese tools are now available to call.`,
        summary: `tool_search: ${hits.length} match(es)`,
      };
    },
  };
}
