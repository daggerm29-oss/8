import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { JsonSchema } from '@helix/protocol';
import type { ToolRegistry } from '../tools/registry.ts';
import { registerToolClass, unregisterToolClass } from '../policy/policy.ts';
import { McpStdioClient, type McpCallResult, type McpToolInfo } from './client.ts';
import { McpHttpClient } from './http.ts';
import type { EgressProxy } from '../sandbox/egress.ts';

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
  /** TTL for caching read-only tool results (F-MCP-4); 0 disables. Default 60000. */
  cacheTtlMs?: number;
  /** Results longer than this are truncated and stored out of band. Default 20000. */
  maxResultChars?: number;
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
  private readonly cache = new Map<string, { at: number; out: { content: string; summary: string; dataRef?: string; truncated?: boolean } }>();
  /** Cache hit/miss counters (exposed for tests and `mcp.list` diagnostics). */
  readonly cacheStats = { hits: 0, misses: 0 };

  private readonly o: { home: string; registry: ToolRegistry; logger?: { info: (m: string, d?: Record<string, unknown>) => void; warn: (m: string, d?: Record<string, unknown>) => void }; config?: Record<string, McpServerConfig>; toolSearchThreshold?: number;
    /** Receives §26.5 audit records (server add, remove, trust change). Details never include headers, env values, or command arguments. */
    audit?: (topic: string, data: Record<string, unknown>) => void;
    /** Stdio servers egress through this proxy with tool identity `mcp:<server>` (§16.5 per-tool allowlist). */
    egress?: EgressProxy };
  /** Registry names each connected server contributed, so removal and reconnect can unregister exactly those. */
  private readonly serverTools = new Map<string, string[]>();

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

  /** Persist a change to `$HELIX_HOME/mcp.json` (inline test configs are memory-only). */
  private updateFile(mutate: (servers: Record<string, McpServerConfig>) => void): void {
    if (this.o.config) return;
    const file = readMcpConfigFile(this.o.home);
    const key = file.servers ? 'servers' : file.mcpServers ? 'mcpServers' : 'servers';
    const servers = (file[key] ??= {});
    mutate(servers);
    writeMcpConfigFile(this.o.home, file);
  }

  private describe(name: string, c: McpServerConfig): Record<string, unknown> {
    const transport = c.url ? 'http' : 'stdio';
    let target = '';
    if (c.url) { try { target = new URL(c.url).origin; } catch { target = 'invalid-url'; } } else target = c.command ?? '';
    return { server: name, transport, target, trust: c.trust ?? 'untrusted', ...(c.args ? { argCount: c.args.length } : {}) };
  }

  private async disconnect(name: string): Promise<void> {
    await this.clients.get(name)?.close().catch(() => {});
    this.clients.delete(name);
    for (const exposed of this.serverTools.get(name) ?? []) { this.o.registry.unregister(exposed); unregisterToolClass(exposed); }
    this.serverTools.delete(name);
    for (const k of [...this.cache.keys()]) if (k.startsWith(`mcp__${name.replace(NAME_RE, '_')}__`)) this.cache.delete(k);
  }

  /** Add a server at runtime (user action): persisted, connected, and audited as `mcp.server_added` (§26.5). New servers are untrusted unless stated. */
  async addServer(name: string, config: McpServerConfig): Promise<McpServerStatus> {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,40}$/.test(name)) throw new Error('server name must be 1-40 characters of [a-zA-Z0-9_.-]');
    if (!config || (!config.command && !config.url)) throw new Error('an MCP server needs a command or a url');
    if (this.status.has(name)) throw new Error(`MCP server '${name}' already exists; remove it first`);
    const cfg: McpServerConfig = { ...config, trust: config.trust === 'trusted' ? 'trusted' : 'untrusted' };
    this.updateFile((servers) => { servers[name] = cfg; });
    await this.startServer(name, cfg);
    this.applyToolSearch();
    const status = this.status.get(name)!;
    this.o.audit?.('mcp.server_added', { ...this.describe(name, cfg), state: status.state, tools: status.tools.length, by: 'user' });
    return status;
  }

  /** Remove a server (user action): disconnect it, drop its tools and config, and audit `mcp.server_removed`. */
  async removeServer(name: string): Promise<{ removed: true; tools: number }> {
    const status = this.status.get(name);
    if (!status) throw new Error(`unknown MCP server '${name}'`);
    const cfg = this.configs.get(name) ?? {};
    await this.disconnect(name);
    this.status.delete(name);
    this.configs.delete(name);
    this.updateFile((servers) => { delete servers[name]; });
    this.o.audit?.('mcp.server_removed', { ...this.describe(name, cfg), state: status.state, tools: status.tools.length, by: 'user' });
    return { removed: true, tools: status.tools.length };
  }

  /** Change a server's trust (user action). Tool classes depend on trust, so the server reconnects; audited as `mcp.trust_changed`. */
  async setTrust(name: string, trust: 'trusted' | 'untrusted'): Promise<McpServerStatus> {
    if (trust !== 'trusted' && trust !== 'untrusted') throw new Error("trust must be 'trusted' or 'untrusted'");
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`unknown MCP server '${name}'`);
    const from = cfg.trust ?? 'untrusted';
    if (from === trust) return this.status.get(name)!;
    cfg.trust = trust;
    this.updateFile((servers) => { if (servers[name]) servers[name].trust = trust; });
    await this.disconnect(name);
    await this.startServer(name, cfg);
    this.applyToolSearch();
    this.o.audit?.('mcp.trust_changed', { ...this.describe(name, cfg), from, to: trust, by: 'user' });
    return this.status.get(name)!;
  }

  private async startServer(name: string, c: McpServerConfig): Promise<void> {
    if (c.enabled === false) { this.status.set(name, { name, state: 'disabled', tools: [] }); return; }
    this.configs.set(name, c);
    const transport = c.url ? 'http' as const : 'stdio' as const;
    if (!c.command && !c.url) { this.status.set(name, { name, state: 'failed', error: 'missing command or url', transport, tools: [] }); return; }
    const client: McpClient = c.url
      ? new McpHttpClient({ url: c.url, headers: c.headers, requestTimeoutMs: c.timeoutMs })
      : new McpStdioClient({
        command: c.command!, args: c.args, env: c.env, cwd: c.cwd, requestTimeoutMs: c.timeoutMs, egress: this.o.egress, tool: `mcp:${name}`,
        onStderr: (line) => this.o.logger?.info('mcp stderr', { server: name, line: line.slice(0, 500) }),
      });
    try {
      await client.connect();
      const tools = client.capabilities && !('tools' in client.capabilities) ? [] : await client.listTools();
      this.clients.set(name, client);
      const filtered = tools.filter((t) => !toolPermitted(c, t.name)).map((t) => t.name);
      const registered = tools.filter((t) => toolPermitted(c, t.name)).map((t) => this.registerTool(name, c, client, t)).filter((t): t is NonNullable<typeof t> => !!t);
      this.serverTools.set(name, registered.map((t) => t.exposedAs));
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
        const trusted = c.trust === 'trusted';
        const provenance = { source: 'mcp' as const, trust: trusted ? 'trusted' as const : 'untrusted' as const, taint: !trusted, origin: `mcp:${server}/${t.name}` };
        const ttl = c.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        const key = actionClass === 'read' && ttl > 0 ? `${exposedAs}\u0000${stableJson(args)}` : null;
        const hit = key ? this.cache.get(key) : undefined;
        if (key && hit && Date.now() - hit.at < ttl) {
          this.cacheStats.hits++;
          return { ...hit.out, summary: `${hit.out.summary} (cached)`, provenance };
        }
        if (key) this.cacheStats.misses++;
        if (!client.running) return { content: `MCP server '${server}' is not running`, isError: true, provenance };
        const r = await client.callTool(t.name, args, ctx.signal);
        const isError = r.isError === true;
        const norm = this.normalize(formatResult(r), c.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS, isError);
        const content = trusted ? norm.content : wrapUntrusted(norm.content, provenance.origin);
        const out = { content, summary: `${server}/${t.name}: ${isError ? 'error: ' : ''}${norm.firstLine}${norm.truncated ? ' (truncated)' : ''}`, ...(norm.dataRef ? { dataRef: norm.dataRef, truncated: true } : {}) };
        if (key && !isError) {
          this.cache.set(key, { at: Date.now(), out });
          if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
        }
        return { ...out, isError, provenance };
      },
    });
    return { name: t.name, exposedAs, actionClass, ...(alwaysAllow ? { alwaysAllow } : {}), description: t.description };
  }

  /** Truncate oversized results, keeping the full text in `$HELIX_HOME/mcp-results/` (F-MCP-4). */
  private normalize(text: string, max: number, isError: boolean): { content: string; firstLine: string; truncated: boolean; dataRef?: string } {
    const firstLine = (text.split('\n').find((l) => l.trim()) ?? '').slice(0, 160);
    if (text.length <= max) return { content: text, firstLine, truncated: false };
    const id = `mcpres_${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
    const dir = join(this.o.home, 'mcp-results');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.txt`), text, { mode: 0o600 });
    if (!this.o.registry.has(READ_RESULT)) this.o.registry.register(readResultTool(dir));
    registerToolClass(READ_RESULT, 'read', 'stored MCP result page');
    const head = text.slice(0, max);
    return { content: `${head}\n[truncated${isError ? ' error' : ''}: showing ${max} of ${text.length} chars; call ${READ_RESULT} with {"id":"${id}","offset":${max}} for more]`, firstLine, truncated: true, dataRef: id };
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
export const READ_RESULT = 'mcp_read_result';
export const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_MAX_RESULT_CHARS = 20_000;
const UNTRUSTED_TAG = 'untrusted-tool-output';

/** Provenance-tagged block for untrusted output (F-MCP-5); a forged closing tag inside is neutralized. */
export function wrapUntrusted(content: string, origin: string): string {
  const safe = content.replace(new RegExp(`<(/?)${UNTRUSTED_TAG}`, 'gi'), `<$1${UNTRUSTED_TAG}-escaped`);
  return `<${UNTRUSTED_TAG} source="${origin}">\n${safe}\n</${UNTRUSTED_TAG}>`;
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

function readResultTool(dir: string) {
  return {
    spec: {
      name: READ_RESULT,
      description: 'Read more of a truncated MCP tool result by id (from a "[truncated ...]" note).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 50000 } }, required: ['id'] } as unknown as JsonSchema,
    },
    run: async (args: Record<string, unknown>) => {
      const id = String(args.id);
      if (!/^mcpres_[a-f0-9]{16}$/.test(id)) return { content: `invalid result id '${id}'`, isError: true };
      const path = join(dir, `${id}.txt`);
      if (!existsSync(path)) return { content: `no stored result '${id}'`, isError: true };
      const text = readFileSync(path, 'utf8');
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const length = typeof args.length === 'number' ? args.length : DEFAULT_MAX_RESULT_CHARS;
      const page = text.slice(offset, offset + length);
      const end = offset + page.length;
      return { content: `${page}${end < text.length ? `\n[${end} of ${text.length} chars; next offset ${end}]` : `\n[end of result, ${text.length} chars]`}`, summary: `${id} ${offset}-${end}/${text.length}` };
    },
  };
}
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
