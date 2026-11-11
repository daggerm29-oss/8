import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalSandbox, SandboxUnavailableError } from '../sandbox/sandbox.ts';

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

export class McpStdioClient {
  private proc?: ChildProcess;
  private sandbox?: LocalSandbox;
  private ownedRoot?: string;
  private stop?: () => void;
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
    try { await this.connectContained(); }
    catch (error) { await this.close(); throw error; }
  }

  private async connectContained(): Promise<void> {
    if (this.sandbox) throw new Error('MCP client is already connected');
    const root = this.o.cwd ?? (this.ownedRoot = mkdtempSync(join(tmpdir(), 'helix-mcp-root-')));
    this.sandbox = new LocalSandbox(`mcp-${randomUUID()}`, root);
    if (this.sandbox.isolation !== 'full') throw new SandboxUnavailableError('MCP stdio requires full per-server filesystem and network isolation');
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const command = 'exec ' + [this.o.command, ...(this.o.args ?? [])].map(quote).join(' ');
    const session = await this.sandbox.openStdio(command, { env: this.o.env });
    const proc = session.process;
    this.proc = proc;
    this.stop = session.kill;
    proc.on('exit', (code, signal) => {
      this.exited = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited (${signal ?? code})`)); }
      this.pending.clear();
    });
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr! }).on('line', (line) => this.o.onStderr?.(line));
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
    this.exited = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP client closed')); }
    this.pending.clear();
    this.proc?.stdin?.end();
    this.stop?.();
    try { await this.sandbox?.stopProcesses(); }
    finally {
      this.sandbox?.destroy();
      this.proc = undefined;
      this.sandbox = undefined;
      this.stop = undefined;
      if (this.ownedRoot) { rmSync(this.ownedRoot, { recursive: true, force: true }); this.ownedRoot = undefined; }
    }
  }
}
