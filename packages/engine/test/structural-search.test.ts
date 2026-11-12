import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { expandShorthand } from '../src/index/structural.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'helix-ast-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/api.ts'), [
    'export async function load(url: string) {',
    "  const a = await fetch('/api/a');", // 2: match
    '  const b = await fetch(url);', // 3: match
    "  const c = await fetch(url, { method: 'POST' });", // 4: two args, no match for call(fetch, _)
    '  const d = await window.fetch(url);', // 5: member call, no match
    "  // fetch('/commented')", // comment, no match
    "  const e = \"fetch('/in-a-string')\";", // string, no match
    '  return [a, b, c, d, e];',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'src/chain.ts'), [
    'export function run(p: Promise<number>, q: Promise<string>) {',
    '  p.then((n) => n + 1);', // 2
    '  q.then(String).catch(() => 0);', // 3 (then call)
    '  return p.finally(() => 1);',
    '}',
    'export const same = (x: number) => x + x;', // 6
    'export const diff = (x: number, y: number) => x + y;', // 7
    'export const mul = (x: number) => x * x;', // 8
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'src/client.py'), 'def go(u):\n    return fetch(u)\n');
  return dir;
}

const open = (dir: string) => {
  const idx = new WorkspaceIndex(new Db(':memory:'), 'ws', dir);
  idx.update();
  return idx;
};
const where = (r: { matches: Array<{ path: string; line: number }> }) => r.matches.map((m) => `${m.path}:${m.line}`).sort();

test('structural: shorthand call(fetch, _) expands to a code pattern', () => {
  assert.equal(expandShorthand('call(fetch, _)'), 'fetch($_)');
  assert.equal(expandShorthand('call(fetch, _, ...)'), 'fetch($_, $$$)');
  assert.equal(expandShorthand('call(api.get, "/x", ...)'), 'api.get("/x", $$$)');
  assert.equal(expandShorthand('foo($A)'), 'foo($A)');
});

test('structural: call(fetch, _) returns exactly the fixture call sites (no comments, strings, members, other arity)', () => {
  const idx = open(fixture());
  const r = idx.structural('call(fetch, _)', { lang: 'ts' });
  assert.deepEqual(where(r), ['src/api.ts:2', 'src/api.ts:3']);
  assert.equal(r.matches[0]!.text, "fetch('/api/a')");
});

test('structural: variadic arguments and any language', () => {
  const idx = open(fixture());
  assert.deepEqual(where(idx.structural('call(fetch, ...)', { lang: 'ts' })), ['src/api.ts:2', 'src/api.ts:3', 'src/api.ts:4']);
  assert.deepEqual(where(idx.structural('fetch($A)')), ['src/api.ts:2', 'src/api.ts:3', 'src/client.py:2']);
});

test('structural: ast-grep metavariables capture nodes and repeated names must match', () => {
  const idx = open(fixture());
  const thens = idx.structural('$A.then($B)', { lang: 'ts' });
  assert.deepEqual(where(thens), ['src/chain.ts:2', 'src/chain.ts:3']);
  assert.equal(thens.matches[0]!.captures.A, 'p');
  assert.equal(thens.matches[0]!.captures.B, '(n) => n + 1');
  assert.deepEqual(where(idx.structural('$A + $A', { lang: 'ts' })), ['src/chain.ts:6']);
  assert.deepEqual(where(idx.structural('$A * $A', { lang: 'ts' })), ['src/chain.ts:8']);
});

test('structural: limit, path prefix, and an unparsable pattern is reported', () => {
  const idx = open(fixture());
  assert.equal(idx.structural('fetch($$$)', { limit: 1 }).matches.length, 1);
  assert.deepEqual(where(idx.structural('fetch($A)', { pathPrefix: 'src/client' })), ['src/client.py:2']);
  assert.ok(idx.structural('const a = 1; const b = 2;', { lang: 'ts' }).error);
});
