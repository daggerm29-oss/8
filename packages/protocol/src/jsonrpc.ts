export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
  NotInitialized: -32002,
  Conflict: -32009,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface Transport {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

/** Newline-delimited JSON framing. Each message is a single line; embedded newlines are escaped by JSON.stringify. */
export class LineDecoder {
  private buffer = '';
  private readonly maxLineBytes: number;
  constructor(maxLineBytes = 64 * 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
  }
  push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = '';
      throw new RpcError(RpcErrorCode.InvalidRequest, 'message exceeds max frame size');
    }
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
}

export type RequestHandler = (params: unknown, context: { peer: RpcPeer }) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Bidirectional JSON-RPC 2.0 peer over any string transport. */
export class RpcPeer {
  private readonly transport: Transport;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly closeHandlers: Array<(reason?: string) => void> = [];

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage((raw) => this.receive(raw));
    transport.onClose((reason) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new RpcError(RpcErrorCode.InternalError, `connection closed${reason ? `: ${reason}` : ''}`));
      }
      this.pending.clear();
      for (const h of this.closeHandlers) h(reason);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(RpcErrorCode.InternalError, 'connection closed'));
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(RpcErrorCode.InternalError, `request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.transport.send(JSON.stringify(message));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.transport.send(JSON.stringify(message));
  }

  close(): void {
    this.transport.close();
  }

  private receive(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      this.sendResponse({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.ParseError, message: 'parse error' } });
      return;
    }
    if (!message || (message as { jsonrpc?: string }).jsonrpc !== '2.0') {
      this.sendResponse({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.InvalidRequest, message: 'invalid request' } });
      return;
    }
    if ('method' in message && typeof message.method === 'string') {
      if ('id' in message && message.id !== undefined && message.id !== null) {
        void this.dispatchRequest(message as JsonRpcRequest);
      } else {
        const set = this.notificationHandlers.get(message.method);
        if (set) for (const h of set) h(message.params);
      }
      return;
    }
    const response = message as JsonRpcResponse;
    if (response.id === null || response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.error) pending.reject(new RpcError(response.error.code, response.error.message, response.error.data));
    else pending.resolve(response.result);
  }

  private async dispatchRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendResponse({ jsonrpc: '2.0', id: request.id, error: { code: RpcErrorCode.MethodNotFound, message: `method not found: ${request.method}` } });
      return;
    }
    try {
      const result = await handler(request.params, { peer: this });
      this.sendResponse({ jsonrpc: '2.0', id: request.id, result: result ?? null });
    } catch (error) {
      const e = error instanceof RpcError ? error : new RpcError(RpcErrorCode.InternalError, error instanceof Error ? error.message : String(error));
      this.sendResponse({ jsonrpc: '2.0', id: request.id, error: { code: e.code, message: e.message, data: e.data } });
    }
  }

  private sendResponse(response: JsonRpcResponse): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify(response));
  }
}

/** Transport over a pair of Node streams using newline-delimited JSON (stdio mode, §22.1). */
export function streamTransport(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream): Transport {
  const decoder = new LineDecoder();
  const messageHandlers: Array<(m: string) => void> = [];
  const closeHandlers: Array<(r?: string) => void> = [];
  let closed = false;
  const fireClose = (reason?: string) => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(reason);
  };
  readable.setEncoding?.('utf8');
  readable.on('data', (chunk: string | Buffer) => {
    for (const line of decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
      for (const h of messageHandlers) h(line);
    }
  });
  readable.on('end', () => fireClose('stream ended'));
  readable.on('close', () => fireClose('stream closed'));
  readable.on('error', (e: Error) => fireClose(e.message));
  return {
    send(message) {
      if (closed) return;
      writable.write(message + '\n');
    },
    onMessage(h) {
      messageHandlers.push(h);
    },
    onClose(h) {
      closeHandlers.push(h);
    },
    close() {
      fireClose('closed locally');
      (writable as NodeJS.WritableStream & { end?: () => void }).end?.();
    },
  };
}
