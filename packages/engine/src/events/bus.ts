import type { HelixEvent } from '@helix/protocol';
import type { Db } from '../storage/db.ts';
import { parseJson } from '../storage/db.ts';
import { sha256, ulid } from '../util/ids.ts';

export type EventHandler = (event: HelixEvent) => void | Promise<void>;

export interface PublishInput<T = unknown> {
  topic: string;
  ws: string;
  task?: string;
  agent?: string;
  step?: string;
  causation?: string;
  data: T;
  persist?: 'none' | 'log' | 'audit';
}

/** Topic patterns: exact, `*` = one segment, trailing `**` = any remainder. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '**' || pattern === topic) return true;
  const p = pattern.split('.');
  const t = topic.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return true;
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

const GENESIS = '0'.repeat(64);

/**
 * In-process typed event bus (§23.2). `log` events are batched to SQLite (50 ms or 256 events);
 * `audit` events are written synchronously to a hash-chained audit_log.
 */
export class EventBus {
  private readonly db: Db;
  private readonly subscribers = new Set<{ pattern: string; handler: EventHandler }>();
  private readonly seqByWs = new Map<string, number>();
  private queue: HelixEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly flushMax: number;

  constructor(db: Db, opts: { flushMs?: number; flushMax?: number } = {}) {
    this.db = db;
    this.flushMs = opts.flushMs ?? 50;
    this.flushMax = opts.flushMax ?? 256;
  }

  private nextSeq(ws: string): number {
    let seq = this.seqByWs.get(ws);
    if (seq === undefined) {
      const row = this.db.get<{ seq: number }>('SELECT seq FROM event_seq WHERE ws = ?', ws);
      const persisted = this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM events WHERE ws = ?', ws);
      seq = Math.max(row?.seq ?? 0, persisted?.m ?? 0);
    }
    seq += 1;
    this.seqByWs.set(ws, seq);
    return seq;
  }

  publish<T>(input: PublishInput<T>): HelixEvent<T> {
    const event: HelixEvent<T> = {
      id: ulid(),
      topic: input.topic,
      ws: input.ws,
      task: input.task,
      agent: input.agent,
      step: input.step,
      at: new Date().toISOString(),
      seq: this.nextSeq(input.ws),
      causation: input.causation,
      data: input.data,
      persist: input.persist ?? 'log',
    };
    if (event.persist === 'audit') {
      this.writeEvents([event as HelixEvent]);
      this.appendAudit(event as HelixEvent);
    } else if (event.persist === 'log') {
      this.queue.push(event as HelixEvent);
      if (this.queue.length >= this.flushMax) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
    for (const sub of this.subscribers) {
      if (!topicMatches(sub.pattern, event.topic)) continue;
      try {
        const r = sub.handler(event as HelixEvent);
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined);
      } catch {
        // A faulty subscriber must not break publishers.
      }
    }
    return event;
  }

  subscribe(pattern: string, handler: EventHandler): () => void {
    const entry = { pattern, handler };
    this.subscribers.add(entry);
    return () => this.subscribers.delete(entry);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.writeEvents(batch);
  }

  private writeEvents(batch: HelixEvent[]): void {
    this.db.transaction(() => {
      for (const e of batch) {
        this.db.run(
          'INSERT INTO events (id, topic, ws, task, agent, step, at, seq, causation, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          e.id, e.topic, e.ws, e.task ?? null, e.agent ?? null, e.step ?? null, e.at, e.seq, e.causation ?? null, JSON.stringify(e.data ?? null),
        );
        this.db.run('INSERT INTO event_seq (ws, seq) VALUES (?, ?) ON CONFLICT(ws) DO UPDATE SET seq = MAX(seq, excluded.seq)', e.ws, e.seq);
      }
    });
  }

  private appendAudit(event: HelixEvent): void {
    const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash = prev?.hash ?? GENESIS;
    const dataJson = JSON.stringify(event.data ?? null);
    const hash = sha256(`${prevHash}|${event.at}|${event.ws}|${event.topic}|${event.id}|${dataJson}`);
    this.db.run('INSERT INTO audit_log (at, ws, topic, event_id, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', event.at, event.ws, event.topic, event.id, dataJson, prevHash, hash);
  }

  /** Verifies the audit hash chain; returns the id of the first broken row, or null if intact. */
  verifyAuditChain(): number | null {
    let prevHash = GENESIS;
    for (const row of this.db.all<{ id: number; at: string; ws: string; topic: string; event_id: string; data_json: string; prev_hash: string; hash: string }>('SELECT * FROM audit_log ORDER BY id')) {
      const expected = sha256(`${prevHash}|${row.at}|${row.ws}|${row.topic}|${row.event_id}|${row.data_json}`);
      if (row.prev_hash !== prevHash || row.hash !== expected) return row.id;
      prevHash = row.hash;
    }
    return null;
  }

  /** Replay persisted events after `afterSeq` for reconnecting clients (§23.2). */
  replay(ws: string, afterSeq: number, limit = 1000): HelixEvent[] {
    this.flush();
    return this.db
      .all<{ id: string; topic: string; ws: string; task: string | null; agent: string | null; step: string | null; at: string; seq: number; causation: string | null; data_json: string }>(
        'SELECT * FROM events WHERE ws = ? AND seq > ? ORDER BY seq LIMIT ?', ws, afterSeq, limit,
      )
      .map((r) => ({
        id: r.id, topic: r.topic, ws: r.ws, task: r.task ?? undefined, agent: r.agent ?? undefined, step: r.step ?? undefined,
        at: r.at, seq: r.seq, causation: r.causation ?? undefined, data: parseJson(r.data_json, null), persist: 'log' as const,
      }));
  }

  close(): void {
    this.flush();
    this.subscribers.clear();
  }
}
