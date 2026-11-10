import type { HelixEvent } from '@helix/protocol';
import type { Db } from '../storage/db.ts';
import { parseJson } from '../storage/db.ts';
import { sha256, ulid } from '../util/ids.ts';
import { auditFields } from './audit.ts';

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

interface AuditRow {
  id: number; at: string; ws: string; topic: string; event_id: string; data_json: string; prev_hash: string; hash: string; hash_v: number;
  category: string | null; actor: string | null; action: string | null; resource: string | null; decision: string | null; rule_id: string | null;
}

/** v1 rows (written before R0.5) committed to the event only; v2 rows also commit to the §26.5 record fields. */
function auditHash(version: number, prevHash: string, r: Pick<AuditRow, 'at' | 'ws' | 'topic' | 'event_id' | 'data_json' | 'category' | 'actor' | 'action' | 'resource' | 'decision' | 'rule_id'>): string {
  const base = `${prevHash}|${r.at}|${r.ws}|${r.topic}|${r.event_id}|`;
  if (version < 2) return sha256(`${base}${r.data_json}`);
  return sha256(`${base}${JSON.stringify([r.category, r.actor, r.action, r.resource, r.decision, r.rule_id])}|${r.data_json}`);
}

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
    const a = auditFields(event);
    const hash = auditHash(2, prevHash, { at: event.at, ws: event.ws, topic: event.topic, event_id: event.id, data_json: dataJson, category: a.category, actor: a.actor, action: a.action, resource: a.resource, decision: a.decision, rule_id: a.ruleId });
    this.db.run('INSERT INTO audit_log (at, ws, topic, event_id, data_json, prev_hash, hash, hash_v, category, actor, action, resource, decision, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?)',
      event.at, event.ws, event.topic, event.id, dataJson, prevHash, hash, a.category, a.actor, a.action, a.resource, a.decision, a.ruleId);
  }

  /** Verifies the audit hash chain; returns the id of the first broken row, or null if intact. */
  verifyAuditChain(): number | null {
    let prevHash = GENESIS;
    for (const row of this.db.all<AuditRow>('SELECT * FROM audit_log ORDER BY id')) {
      if (row.prev_hash !== prevHash || row.hash !== auditHash(row.hash_v, prevHash, row)) return row.id;
      prevHash = row.hash;
    }
    return null;
  }

  /** `audit.verify` (`helix audit verify`, §26.5): chain result plus per-category counts. */
  verifyAudit(): { ok: boolean; rows: number; brokenAt: number | null; head: string; categories: Record<string, number> } {
    this.flush();
    const brokenAt = this.verifyAuditChain();
    const rows = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0;
    const head = this.db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')?.hash ?? GENESIS;
    const categories = Object.fromEntries(this.db.all<{ category: string | null; n: number }>('SELECT category, COUNT(*) AS n FROM audit_log GROUP BY category').map((r) => [r.category ?? 'legacy', r.n]));
    return { ok: brokenAt === null, rows, brokenAt, head, categories };
  }

  /** JSONL export in the §26.5 record shape (SEC-9: exportable). Optionally one category or a time window. */
  exportAudit(opts: { category?: string; since?: string } = {}): string {
    this.flush();
    const where: string[] = [];
    const args: string[] = [];
    if (opts.category) { where.push('category = ?'); args.push(opts.category); }
    if (opts.since) { where.push('at >= ?'); args.push(opts.since); }
    const rows = this.db.all<AuditRow>(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`, ...args);
    return rows.map((r) => JSON.stringify({
      seq: r.id, at: r.at, actor: r.actor, action: r.action, resource: r.resource, decision: r.decision, ruleId: r.rule_id, category: r.category,
      ws: r.ws, topic: r.topic, eventId: r.event_id, details: parseJson(r.data_json, null), prevHash: r.prev_hash, hash: r.hash, hashVersion: r.hash_v,
    })).join('\n') + (rows.length ? '\n' : '');
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
