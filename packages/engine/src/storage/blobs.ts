import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { sha256 } from '../util/ids.ts';
import type { Db } from './db.ts';

export type BlobRef = `blob:${string}`;

const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';

/**
 * Content-addressed blob store (§21.3). Uses SHA-256 (BLAKE3 needs the Rust addon; see IMPL-ADR-004)
 * and zstd when the runtime supports it, else gzip. Writes are atomic (temp file + rename).
 */
export class BlobStore {
  private readonly dir: string;
  private readonly db: Db;

  constructor(dir: string, db: Db) {
    this.dir = dir;
    this.db = db;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  put(content: string | Buffer, owner?: { kind: string; id: string }): BlobRef {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = sha256(buf);
    const prefixDir = join(this.dir, hash.slice(0, 2));
    const file = join(prefixDir, hash);
    if (!existsSync(file)) {
      mkdirSync(prefixDir, { recursive: true, mode: 0o700 });
      const compressed = hasZstd ? Buffer.concat([Buffer.from('Z'), zlib.zstdCompressSync(buf)]) : Buffer.concat([Buffer.from('G'), zlib.gzipSync(buf)]);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, compressed, { mode: 0o600 });
      renameSync(tmp, file);
    }
    if (owner) this.db.run('INSERT OR IGNORE INTO blob_refs (hash, owner_kind, owner_id) VALUES (?, ?, ?)', hash, owner.kind, owner.id);
    return `blob:${hash}`;
  }

  get(ref: BlobRef | string): Buffer {
    const hash = ref.replace(/^blob:/, '');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid blob ref: ${ref}`);
    const raw = readFileSync(join(this.dir, hash.slice(0, 2), hash));
    const tag = raw.subarray(0, 1).toString();
    const body = raw.subarray(1);
    const out = tag === 'Z' ? zlib.zstdDecompressSync(body) : zlib.gunzipSync(body);
    if (sha256(out) !== hash) throw new Error(`blob integrity check failed: ${hash}`);
    return out;
  }

  getText(ref: BlobRef | string): string {
    return this.get(ref).toString('utf8');
  }
}
