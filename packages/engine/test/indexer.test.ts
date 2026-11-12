import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { blake3Hex } from '../src/index/hash.ts';
import { HelixIgnore } from '../src/index/ignore.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'helix-idx-'));
  mkdirSync(join(dir, 'src/a'), { recursive: true });
  mkdirSync(join(dir, 'src/b'), { recursive: true });
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'generated'));
  writeFileSync(join(dir, 'src/a/alpha.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  writeFileSync(join(dir, 'src/b/beta.ts'), 'export function beta(): number {\n  return 2;\n}\n');
  writeFileSync(join(dir, 'generated/out.ts'), 'export function generatedThing(): number {\n  return 3;\n}\n');
  writeFileSync(join(dir, 'docs/guide.md'), '# Deploying the widget\n\nRun the widget deploy script.\n\n## Rollback procedure\n\nRevert the release.\n');
  writeFileSync(join(dir, '.helixignore'), '# generated code\ngenerated/\n*.snap.ts\n');
  writeFileSync(join(dir, 'src/a/x.snap.ts'), 'export const snapshotValue = 1;\n');
  return dir;
}

const open = (dir: string) => new WorkspaceIndex(new Db(':memory:'), 'ws', dir);
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

test('blake3: matches the official test vectors', () => {
  assert.equal(blake3Hex(''), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.equal(blake3Hex('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
});

test('.helixignore: patterns, negation, directory-only', () => {
  const ig = new HelixIgnore('# c\ngenerated/\n*.snap.ts\n/root-only.ts\n!keep.snap.ts\nsrc/**/tmp\n');
  assert.equal(ig.ignores('generated/out.ts'), true);
  assert.equal(ig.ignores('src/generated/x.ts'), true);
  assert.equal(ig.ignores('src/a/x.snap.ts'), true);
  assert.equal(ig.ignores('keep.snap.ts'), false);
  assert.equal(ig.ignores('root-only.ts'), true);
  assert.equal(ig.ignores('src/root-only.ts'), false);
  assert.equal(ig.ignores('src/a/b/tmp/f.ts'), true);
  assert.equal(ig.ignores('src/a/alpha.ts'), false);
});

test('indexer: .helixignore paths absent, secrets absent, Markdown docs indexed, BLAKE3 hashes', () => {
  const dir = fixture();
  writeFileSync(join(dir, '.env'), 'TOKEN=abc\n');
  const idx = open(dir);
  idx.update();
  const paths = (idx as unknown as { db: Db }).db.all<{ path: string; hash: string }>('SELECT path, hash FROM idx_files WHERE ws = ?', 'ws');
  const names = paths.map((p) => p.path).sort();
  assert.deepEqual(names, ['docs/guide.md', 'src/a/alpha.ts', 'src/b/beta.ts']);
  assert.ok(paths.every((p) => /^[0-9a-f]{64}$/.test(p.hash)));
  assert.equal(paths.find((p) => p.path === 'src/a/alpha.ts')!.hash, blake3Hex('export function alpha(): number {\n  return 1;\n}\n'));
  assert.equal(idx.findSymbol('generatedThing', 5).length, 0);
  assert.ok(idx.search('rollback procedure', { limit: 3 }).some((h) => h.path === 'docs/guide.md'));
  assert.ok(idx.findSymbol('Rollback procedure', 5).some((s) => s.path === 'docs/guide.md' && s.kind === 'heading'));
});

test('indexer: Merkle root changes only along the edited path', () => {
  const dir = fixture();
  const idx = open(dir);
  idx.update();
  const before = idx.merkle();
  assert.equal(idx.merkleRoot(), before.get(''));
  writeFileSync(join(dir, 'src/a/alpha.ts'), 'export function alpha(): number {\n  return 100;\n}\n');
  idx.update();
  const after = idx.merkle();
  for (const changed of ['', 'src', 'src/a']) assert.notEqual(after.get(changed), before.get(changed), changed);
  for (const same of ['src/b', 'docs']) assert.equal(after.get(same), before.get(same), same);
  rmSync(join(dir, 'src/a/alpha.ts'));
  idx.update();
  assert.notEqual(idx.merkleRoot(), after.get(''));
});

test('indexer: unchanged tree keeps the same Merkle root (content-addressed, order independent)', () => {
  const dir = fixture();
  const a = open(dir);
  a.update();
  const b = open(dir);
  b.update();
  assert.equal(a.merkleRoot(), b.merkleRoot());
});

test('indexer: watcher re-indexes a saved file without a manual call, and drops deleted/ignored ones', async () => {
  const dir = fixture();
  const idx = open(dir);
  idx.update();
  const watcher = idx.watch();
  try {
    writeFileSync(join(dir, 'src/b/beta.ts'), 'export function betaRenamedBySave(): number {\n  return 2;\n}\n');
    assert.ok(await until(() => idx.findSymbol('betaRenamedBySave', 3).length === 1), 'save re-indexed');
    assert.equal(idx.findSymbol('beta', 5).filter((s) => s.name === 'beta').length, 0);

    writeFileSync(join(dir, 'src/b/new.ts'), 'export function brandNewFn(): void {}\n');
    assert.ok(await until(() => idx.findSymbol('brandNewFn', 3).length === 1), 'new file indexed');

    rmSync(join(dir, 'src/b/new.ts'));
    assert.ok(await until(() => idx.findSymbol('brandNewFn', 3).length === 0), 'deleted file dropped');

    writeFileSync(join(dir, 'generated/more.ts'), 'export function ignoredByWatch(): void {}\n');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(idx.findSymbol('ignoredByWatch', 3).length, 0);
  } finally {
    watcher.close();
  }
});

test('indexer: incremental update after save is fast (F-IDX-1 AC2, 300 ms p95)', () => {
  const dir = fixture();
  for (let i = 0; i < 200; i++) writeFileSync(join(dir, 'src/b', `f${i}.ts`), `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`);
  const idx = open(dir);
  idx.update();
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, 'src/b/f7.ts'), `export function f7(x: number): number {\n  return x + ${1000 + i};\n}\n`);
    const t = performance.now();
    idx.update(['src/b/f7.ts']);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)]! < 300, `p95 ${times[Math.floor(times.length * 0.95)]}ms`);
});
