import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';

const SHARED = 'export function clamp(value: number, low: number, high: number) {\n  return Math.min(high, Math.max(low, value));\n}\n';

test('vectors: subword retrieval without BM25 overlap, content-addressed dedupe, incremental, secrets never embedded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-vec-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/lexer.ts'), 'export function tokenizeSource(input: string): string[] {\n  return input.split(/\\s+/).filter(Boolean);\n}\n');
  writeFileSync(join(dir, 'src/invoice.ts'), 'export function renderInvoice(total: number): string {\n  return `Total: ${total}`;\n}\n');
  writeFileSync(join(dir, 'src/a.ts'), SHARED);
  writeFileSync(join(dir, 'src/b.ts'), SHARED);
  writeFileSync(join(dir, '.env'), 'TOKEN=hunter2\n');

  const db = new Db(':memory:');
  db.run(`INSERT INTO workspace (id, path, created_at) VALUES ('ws1', ?, 'now')`, dir);
  const idx = new WorkspaceIndex(db, 'ws1', dir);
  idx.update();

  const hits = idx.search('tokenization routine');
  assert.equal(hits[0]?.path, 'src/lexer.ts', JSON.stringify(hits.map((h) => [h.path, h.why])));
  assert.equal(hits[0].symbol, 'tokenizeSource');
  assert.deepEqual(hits[0].why, ['vector'], 'no BM25 term overlap: only the vector retriever finds it');

  const shared = db.all<{ hash: string }>(`SELECT hash FROM idx_vectors WHERE ws = 'ws1' AND path IN ('src/a.ts', 'src/b.ts') AND symbol = 'clamp'`);
  assert.equal(shared.length, 2);
  assert.equal(shared[0].hash, shared[1].hash, 'identical chunks share one content hash');
  const embeddings = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idx_embeddings')!.n;
  const vectors = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM idx_vectors WHERE ws = 'ws1'`)!.n;
  assert.equal(embeddings, vectors - 1, `${embeddings} embeddings for ${vectors} chunks`);
  assert.equal(idx.embedded, embeddings);

  const before = idx.embedded;
  assert.equal(idx.update().indexed, 0);
  assert.equal(idx.embedded, before, 'unchanged files embed nothing new');

  assert.ok(!db.get(`SELECT 1 FROM idx_vectors WHERE path = '.env'`), '.env never embedded');
  assert.equal(db.get<{ model: string }>('SELECT model FROM idx_embeddings LIMIT 1')!.model, 'helix-local-hash-v1');
});
