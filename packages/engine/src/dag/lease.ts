import type { Db } from '../storage/db.ts';
import { json, parseJson } from '../storage/db.ts';
import { prefixedId } from '../util/ids.ts';

/**
 * Write leases (F-ORC-3 minimal, §10.4): `{id, holder, globs, mode, expiresAt, heartbeat}` in SQLite. Acquisition fails when
 * the globs intersect an unexpired lease of another holder (conservative static-prefix test). A lease without a heartbeat
 * for `ttlMs` (60 s) is expired and ignored. No trie, no holder pause on expiry.
 */
export interface Lease { id: string; holder: string; globs: string[]; mode: 'write' | 'exclusive'; heartbeatAt: number; expiresAt: number }

export const LEASE_TTL_MS = 60_000;
export const LEASE_HEARTBEAT_MS = 10_000;

const staticPrefix = (glob: string) => glob.replace(/^\.\//, '').split('*')[0];

/** Conservative overlap test: two globs may touch the same file when one static prefix is a prefix of the other. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a), pb = staticPrefix(b);
  const wa = a.includes('*'), wb = b.includes('*');
  if (!wa && !wb) return pa === pb;
  if (!wa) return pa.startsWith(pb);
  if (!wb) return pb.startsWith(pa);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export const writeSetsOverlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => globsOverlap(x, y)));

/** `*` matches within a path segment, `**` across segments. Paths are workspace-relative with `/`. */
export function matchGlob(glob: string, path: string): boolean {
  const g = glob.replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path.replace(/^\.\//, ''));
}

export const inWriteSet = (globs: string[], path: string) => globs.some((g) => matchGlob(g, path));

export class LeaseManager {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  active(): Lease[] {
    const t = this.now();
    return this.db.all<Record<string, string | number>>('SELECT * FROM leases WHERE expires_at > ?', t).map((r) => ({
      id: String(r.id), holder: String(r.holder), globs: parseJson<string[]>(r.globs_json, []), mode: r.mode as Lease['mode'], heartbeatAt: Number(r.heartbeat_at), expiresAt: Number(r.expires_at),
    }));
  }

  /** Returns the new lease, or null with the conflicting lease when the globs intersect another holder's unexpired lease. */
  acquire(holder: string, globs: string[], mode: Lease['mode'] = 'write'): { lease: Lease; conflict?: undefined } | { lease: null; conflict: Lease } {
    const conflict = this.active().find((l) => l.holder !== holder && (l.mode === 'exclusive' || mode === 'exclusive' || writeSetsOverlap(l.globs, globs)));
    if (conflict) return { lease: null, conflict };
    const t = this.now();
    const lease: Lease = { id: prefixedId('lease'), holder, globs, mode, heartbeatAt: t, expiresAt: t + LEASE_TTL_MS };
    this.db.run('INSERT INTO leases (id, holder, globs_json, mode, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', lease.id, holder, json(globs), mode, t, lease.expiresAt);
    return { lease };
  }

  heartbeat(id: string): boolean {
    const t = this.now();
    return this.db.run('UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND expires_at > ?', t, t + LEASE_TTL_MS, id, t).changes > 0;
  }

  release(id: string): void {
    this.db.run('DELETE FROM leases WHERE id = ?', id);
  }
}
