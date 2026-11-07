import { readSse } from '@helix/protocol';
import { MCP_PROTOCOL_VERSION, type McpCallResult, type McpToolInfo } from './client.ts';

/**
 * MCP client over streamable HTTP (F-MCP-1 part 2, Arch §14.2). Each JSON-RPC message is a POST to the
 * server URL with `Accept: application/json, text/event-stream`; the response is either a JSON body or an
 * SSE stream that carries the matching response (and possibly server notifications/requests first).
 * `Mcp-Session-Id` from the initialize response is echoed on every later request and DELETEd on close.
 */
export interface McpHttpOptions {
  url: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface RpcMessage { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

export class McpHttpClient {
  private nextId = 1;
  private sessionId?: string;
  private negotiatedVersion?: string;
  private closed = false;
  private connected = false;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;

  private readonly o: McpHttpOptions;

  constructor(o: McpHttpOptions) {
    this.o = o;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.o.headers ?? {}) };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.negotiatedVersion) h['mcp-protocol-version'] = this.negotiatedVersion;
    return h;
  }

  private get fetchFn(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  async connect(): Promise<void> {
    const init = await this.request<{ protocolVersion: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string } }>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'helix-engine', version: '0.1.0' },
    });
    this.negotiatedVersion = init.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.serverInfo = init.serverInfo;
    this.capabilities = init.capabilities ?? {};
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, AbortSignal.timeout(this.o.requestTimeoutMs ?? 60_000));
    this.connected = true;
  }

  private async post(msg: RpcMessage, signal: AbortSignal): Promise<Response> {
    if (this.closed) throw new Error('MCP client is closed');
    const res = await this.fetchFn(this.o.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg), signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid && msg.method === 'initialize') this.sessionId = sid;
    if (res.status === 404 && this.sessionId) throw new Error('MCP session expired (HTTP 404)');
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  async request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    const timeoutMs = this.o.requestTimeoutMs ?? 60_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await this.post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, combined);
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream') && res.body) {
        for await (const ev of readSse(res.body, combined)) {
          if (!ev.data) continue;
          const reply = await this.handleIncoming(JSON.parse(ev.data) as RpcMessage | RpcMessage[], id);
          if (reply !== undefined) return unwrap<T>(reply);
        }
        throw new Error(`MCP stream ended without a response to '${method}'`);
      }
      const body = (await res.json()) as RpcMessage | RpcMessage[];
      const reply = await this.handleIncoming(body, id);
      if (reply === undefined) throw new Error(`MCP response to '${method}' is missing`);
      return unwrap<T>(reply);
    } catch (e) {
      if (timeout.aborted) {
        this.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }, AbortSignal.timeout(2000)).catch(() => {});
        throw new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`);
      }
      if (signal?.aborted) {
        this.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } }, AbortSignal.timeout(2000)).catch(() => {});
        throw new Error('aborted');
      }
      throw e;
    }
  }

  /** Returns the response for `id` if present; answers server→client requests with method-not-found. */
  private async handleIncoming(body: RpcMessage | RpcMessage[], id: number): Promise<RpcMessage | undefined> {
    let found: RpcMessage | undefined;
    for (const m of Array.isArray(body) ? body : [body]) {
      if (m.method !== undefined) {
        if (m.id !== undefined) await this.post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `client does not support ${m.method}` } }, AbortSignal.timeout(5000)).catch(() => {});
        continue;
      }
      if (m.id === id) found = m;
    }
    return found;
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
    return this.connected && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;
    await this.fetchFn(this.o.url, { method: 'DELETE', headers: { ...(this.o.headers ?? {}), 'mcp-session-id': this.sessionId }, signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
}

function unwrap<T>(m: RpcMessage): T {
  if (m.error) throw new Error(`MCP error ${m.error.code}: ${m.error.message}`);
  return m.result as T;
}
