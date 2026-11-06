import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Minimal MCP client over stdio (F-MCP-1, Arch §14.1): newline-delimited JSON-RPC 2.0, `initialize` →
 * `notifications/initialized`, paginated `tools/list`, `tools/call`. Streamable HTTP lands next (§14.2).
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpStdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
  /** stderr lines from the server (logged, never parsed as protocol). */
  onStderr?: (line: string) => void;
}

/** Env passed to MCP servers: a minimal allowlist plus the server's own config — never the Engine's provider keys. */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'NODE_OPTIONS'];

export class McpStdioClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private exited = false;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;

  private readonly o: McpStdioOptions;

  constructor(o: McpStdioOptions) {
    this.o = o;
  }

  async connect(): Promise<void> {
    const env: Record<string, string> = {};
    for (const k of INHERITED_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, this.o.env ?? {});
    const proc = spawn(this.o.command, this.o.args ?? [], { cwd: this.o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    const spawned = new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', (e) => { this.exited = true; reject(new Error(`failed to start MCP server '${this.o.command}': ${e.message}`)); });
    });
    proc.on('exit', (code, signal) => {
      this.exited = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited (${signal ?? code})`)); }
      this.pending.clear();
    });
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr! }).on('line', (line) => this.o.onStderr?.(line));
    await spawned;
    const init = await this.request<{ protocolVersion: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string } }>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'helix-engine', version: '0.1.0' },
    });
    this.serverInfo = init.serverInfo;
    this.capabilities = init.capabilities ?? {};
    this.notify('notifications/initialized');
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string } };
    try { msg = JSON.parse(trimmed); } catch { this.o.onStderr?.(`[non-JSON stdout] ${trimmed.slice(0, 200)}`); return; }
    if (msg.method !== undefined) {
      // Server→client requests (sampling, roots, elicitation) are not supported yet: answer with method-not-found.
      if (msg.id !== undefined) this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
      return;
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  private write(obj: unknown): void {
    if (this.exited || !this.proc?.stdin?.writable) throw new Error('MCP server is not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.o.requestTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' }); } catch { /* server gone */ }
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        try { this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' }); } catch { /* server gone */ }
        reject(new Error('aborted'));
      }, { once: true });
      try { this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{ tools: McpToolInfo[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return this.request<McpCallResult>('tools/call', { name, arguments: args }, signal);
  }

  get running(): boolean {
    return !!this.proc && !this.exited;
  }

  async close(): Promise<void> {
    if (!this.proc || this.exited || this.proc.exitCode !== null || this.proc.pid === undefined) return;
    const proc = this.proc;
    const gone = new Promise<void>((r) => { proc.once('exit', () => r()); proc.once('error', () => r()); });
    proc.stdin?.end();
    const kill = setTimeout(() => proc.kill('SIGTERM'), 1000);
    const hard = setTimeout(() => proc.kill('SIGKILL'), 3000);
    await gone;
    clearTimeout(kill);
    clearTimeout(hard);
  }
}
