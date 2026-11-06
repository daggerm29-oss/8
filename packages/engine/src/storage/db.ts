import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * SQLite storage (§21). WAL mode, forward-only versioned migrations with a backup copy taken
 * before migrating. node:sqlite is synchronous, so all writes in this process are serialized,
 * which satisfies the single-writer rule of §21.1.
 */
export class Db {
  readonly path: string;
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  get schemaVersion(): number {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  private migrate(): void {
    const current = this.schemaVersion;
    const target = MIGRATIONS.length;
    if (current > target) throw new Error(`database schema v${current} is newer than this engine (v${target})`);
    if (current === target) return;
    if (current > 0 && this.path !== ':memory:' && existsSync(this.path)) {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      copyFileSync(this.path, `${this.path}.bak-v${current}-${Date.now()}`);
    }
    for (let v = current; v < target; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw new Error(`migration v${v + 1} failed: ${(error as Error).message}`);
      }
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
