import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../storage/db.ts';
import { hexId } from '../util/ids.ts';
import type { Logger } from '../util/log.ts';

/** OpenTelemetry-compatible span model (W3C trace context ids, OTLP status codes, §26.1). */
export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3 } as const;
export const StatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;

type AttrValue = string | number | boolean;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startNs: bigint;
  endNs: bigint;
  statusCode: number;
  statusMessage?: string;
  attributes: Record<string, AttrValue>;
  events: Array<{ name: string; timeNs: string; attributes?: Record<string, AttrValue> }>;
}

export class Span {
  readonly record: SpanRecord;
  private readonly tracer: Tracer;
  private ended = false;
  constructor(tracer: Tracer, record: SpanRecord) {
    this.tracer = tracer;
    this.record = record;
  }
  setAttribute(key: string, value: AttrValue | undefined | null): this {
    if (value !== undefined && value !== null) this.record.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Record<string, AttrValue | undefined | null>): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }
  addEvent(name: string, attributes?: Record<string, AttrValue>): void {
    this.record.events.push({ name, timeNs: nowNs().toString(), attributes });
  }
  setStatus(code: number, message?: string): void {
    this.record.statusCode = code;
    this.record.statusMessage = message;
  }
  recordException(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.addEvent('exception', { 'exception.message': message, 'exception.type': error instanceof Error ? error.name : 'Error' });
    this.setStatus(StatusCode.ERROR, message);
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.record.endNs = nowNs();
    this.tracer.export(this.record);
  }
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
}

/**
 * Tracer storing spans in SQLite and optionally exporting OTLP/HTTP JSON to `HELIX_OTLP_ENDPOINT`
 * (e.g. http://localhost:4318/v1/traces). See IMPL-ADR-005 for why this is native rather than the OTel SDK.
 */
export class Tracer {
  private readonly db: Db;
  private readonly als = new AsyncLocalStorage<Span>();
  private readonly otlpEndpoint: string | null;
  private readonly serviceName: string;
  private readonly logger?: Logger;
  private otlpQueue: SpanRecord[] = [];
  private otlpTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, opts: { serviceName?: string; otlpEndpoint?: string | null; logger?: Logger } = {}) {
    this.db = db;
    this.serviceName = opts.serviceName ?? 'helix-engine';
    this.otlpEndpoint = opts.otlpEndpoint ?? process.env.HELIX_OTLP_ENDPOINT ?? null;
    this.logger = opts.logger;
  }

  startSpan(name: string, attributes: Record<string, AttrValue> = {}, kind: number = SpanKind.INTERNAL): Span {
    const parent = this.als.getStore();
    return new Span(this, {
      traceId: parent?.record.traceId ?? hexId(16),
      spanId: hexId(8),
      parentSpanId: parent?.record.spanId,
      name, kind, startNs: nowNs(), endNs: 0n, statusCode: StatusCode.UNSET, attributes: { ...attributes }, events: [],
    });
  }

  /** Runs fn inside a new active span; child spans started inside inherit the trace. */
  async withSpan<T>(name: string, attributes: Record<string, AttrValue>, fn: (span: Span) => Promise<T>, kind: number = SpanKind.INTERNAL): Promise<T> {
    const span = this.startSpan(name, attributes, kind);
    try {
      const result = await this.als.run(span, () => fn(span));
      if (span.record.statusCode === StatusCode.UNSET) span.setStatus(StatusCode.OK);
      return result;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  export(record: SpanRecord): void {
    try {
      this.db.run(
        'INSERT OR REPLACE INTO spans (span_id, trace_id, parent_span_id, name, kind, start_ns, end_ns, status_code, status_message, attributes_json, events_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        record.spanId, record.traceId, record.parentSpanId ?? null, record.name, record.kind, record.startNs.toString(), record.endNs.toString(),
        record.statusCode, record.statusMessage ?? null, JSON.stringify(record.attributes), JSON.stringify(record.events),
      );
    } catch (error) {
      this.logger?.warn('span export failed', { error: (error as Error).message });
    }
    if (this.otlpEndpoint) {
      this.otlpQueue.push(record);
      if (!this.otlpTimer) this.otlpTimer = setTimeout(() => void this.flushOtlp(), 1000);
    }
  }

  toOtlpJson(records: SpanRecord[]): unknown {
    const attr = (attrs: Record<string, AttrValue>) =>
      Object.entries(attrs).map(([key, v]) => ({
        key,
        value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
      }));
    return {
      resourceSpans: [{
        resource: { attributes: attr({ 'service.name': this.serviceName }) },
        scopeSpans: [{
          scope: { name: 'helix', version: '0.1.0' },
          spans: records.map((r) => ({
            traceId: r.traceId, spanId: r.spanId, parentSpanId: r.parentSpanId, name: r.name, kind: r.kind,
            startTimeUnixNano: r.startNs.toString(), endTimeUnixNano: r.endNs.toString(), attributes: attr(r.attributes),
            events: r.events.map((e) => ({ name: e.name, timeUnixNano: e.timeNs, attributes: attr(e.attributes ?? {}) })),
            status: { code: r.statusCode, message: r.statusMessage },
          })),
        }],
      }],
    };
  }

  async flushOtlp(): Promise<void> {
    if (this.otlpTimer) {
      clearTimeout(this.otlpTimer);
      this.otlpTimer = null;
    }
    if (!this.otlpEndpoint || this.otlpQueue.length === 0) return;
    const batch = this.otlpQueue;
    this.otlpQueue = [];
    try {
      await fetch(this.otlpEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.toOtlpJson(batch)) });
    } catch (error) {
      this.logger?.warn('otlp export failed', { error: (error as Error).message });
    }
  }

  async shutdown(): Promise<void> {
    await this.flushOtlp();
  }
}
