import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, extractHeuristic, type Lang } from '../src/index/extract.ts';

const fmt = (lang: Lang, src: string, heuristic = false) =>
  (heuristic ? extractHeuristic(lang, src) : extract(lang, src)).symbols.map((s) => `${s.kind}:${s.qualifiedName}:${s.line}-${s.endLine}`);

test('tree-sitter: TS multi-line signature and one-line class methods', () => {
  const src = `export function total(
  items: number[],
  tax: number,
): number {
  return 0;
}
export class Cart { add(x: number) { return x; } clear() {} }
`;
  assert.equal(extract('ts', src).parser, 'tree-sitter');
  assert.deepEqual(fmt('ts', src), ['function:total:1-6', 'class:Cart:7-7', 'method:Cart.add:7-7', 'method:Cart.clear:7-7']);
  assert.ok(!fmt('ts', src, true).some((s) => s.startsWith('method:')), 'heuristic misses one-line methods');
  assert.equal(extract('ts', src).symbols[0].signature, 'export function total( items: number[], tax: number, ): number');
});

test('tree-sitter: broken TS still yields intact symbols', () => {
  const src = 'export function ok(a: number) {\n  return a.;\n}\nfunction half(x: number {\n  const y = ;\n  return x\n}\nexport class Later {\n  run() {\n    if (x > {\n    return 1;\n  }\n}\n';
  const syms = fmt('ts', src);
  assert.ok(syms.includes('function:ok:1-3'), syms.join(', '));
  assert.ok(syms.some((s) => s.startsWith('class:Later:')), syms.join(', '));
  assert.ok(syms.some((s) => s.startsWith('method:Later.run:')), syms.join(', '));
});

test('tree-sitter: decorated Python methods, Go, Rust impl methods, Java package-private methods', () => {
  const py = 'class Api:\n    @property\n    def name(self):\n        return 1\n\n    @staticmethod\n    def make(\n        a,\n        b,\n    ):\n        return 2\n';
  assert.equal(extract('py', py).parser, 'tree-sitter');
  assert.deepEqual(fmt('py', py), ['class:Api:1-11', 'method:Api.name:3-4', 'method:Api.make:7-11']);

  const go = 'package main\n\nfunc (s *Server[T]) Start(\n\tctx int,\n) error {\n\treturn nil\n}\n\ntype Server[T any] struct {\n\tx T\n}\n';
  assert.deepEqual(fmt('go', go), ['method:Server.Start:3-7', 'struct:Server:9-11']);

  const rs = 'pub struct W;\nimpl<T: Clone> std::fmt::Display for Wrap<T> {\n    fn fmt(&self) -> u8 {\n        let s = "}";\n        0\n    }\n}\npub fn after() {}\n';
  assert.deepEqual(fmt('rs', rs), ['struct:W:1-1', 'class:Wrap:2-7', 'method:Wrap.fmt:3-6', 'function:after:8-8']);

  const java = 'public class Shop {\n  void restock(int n) {\n  }\n  public Shop() {}\n}\n';
  assert.deepEqual(fmt('java', java), ['class:Shop:1-5', 'method:Shop.restock:2-3', 'method:Shop.Shop:4-4']);
  assert.ok(!fmt('java', java, true).includes('method:Shop.restock:2-3'), 'heuristic misses package-private method');
});

test('heuristic fallback: languages without a grammar (Kotlin) keep the heuristic extractor', () => {
  const kt = extract('kt', 'class Shop {\n  public fun open(): Unit {\n  }\n}\n');
  assert.equal(kt.parser, 'heuristic');
  assert.equal(extract('md', '# Title\n').parser, 'heuristic');
});
