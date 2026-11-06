export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/** Incremental Server-Sent Events parser (WHATWG event-stream format). */
export class SseParser {
  private buffer = '';
  private event: string | undefined;
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let index: number;
    while ((index = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, index);
      const newlineLength = this.buffer.startsWith('\r\n', index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + newlineLength);
      const message = this.line(line);
      if (message) out.push(message);
    }
    return out;
  }

  end(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buffer.length > 0) {
      const message = this.line(this.buffer);
      this.buffer = '';
      if (message) out.push(message);
    }
    const final = this.line('');
    if (final) out.push(final);
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = undefined;
        return null;
      }
      const message: SseMessage = { event: this.event, data: this.data.join('\n'), id: this.id };
      this.event = undefined;
      this.data = [];
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return null;
  }
}

/** Reads an HTTP response body as SSE messages. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parser.push(decoder.decode(value, { stream: true }))) yield m;
    }
    for (const m of parser.push(decoder.decode())) yield m;
    for (const m of parser.end()) yield m;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
