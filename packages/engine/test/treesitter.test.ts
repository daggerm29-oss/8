import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, extractHeuristic, langOf, type Lang } from '../src/index/extract.ts';
import { TREE_SITTER_LANGS } from '../src/index/treesitter.ts';

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

test('heuristic fallback: languages without a grammar keep the heuristic extractor', () => {
  assert.equal(extract('md', '# Title\n').parser, 'heuristic');
  assert.equal(extract('yaml', 'a: 1\n').parser, 'heuristic');
});

const SNIPPETS: Record<string, [string, string[]]> = {
  ts: ['export class Cart {\n  add(x: number) {\n    return x;\n  }\n}\nfunction t() {}\n', ['class:Cart:1-5', 'method:Cart.add:2-4', 'function:t:6-6']],
  js: ['class Cart {\n  add(x) { return x; }\n}\nexport const f = () => 1;\n', ['class:Cart:1-3', 'method:Cart.add:2-2', 'function:f:4-4']],
  py: ['class Cart:\n    def add(self, x):\n        return x\n\ndef top():\n    pass\n', ['class:Cart:1-3', 'method:Cart.add:2-3', 'function:top:5-6']],
  go: ['package m\n\nfunc Top() {\n}\n\ntype Cart struct {\n\tn int\n}\n', ['function:Top:3-4', 'struct:Cart:6-8']],
  rs: ['pub struct Cart;\nimpl Cart {\n    pub fn add(&self) {}\n}\n', ['struct:Cart:1-1', 'class:Cart:2-4', 'method:Cart.add:3-3']],
  java: ['public class Cart {\n  public int add(int x) {\n    return x;\n  }\n}\n', ['class:Cart:1-5', 'method:Cart.add:2-4']],
  cs: ['namespace N {\npublic class Shop {\n  public void Open(int n) {\n  }\n}\ninterface IShop {}\nenum E { A }\nstruct P {}\n}\n', ['class:Shop:2-5', 'method:Shop.Open:3-4', 'interface:IShop:6-6', 'enum:E:7-7', 'struct:P:8-8']],
  kt: ['class Shop {\n  fun open(n: Int): Int {\n    return n\n  }\n}\ninterface Api\nobject Single {}\nprivate fun top() {}\n', ['class:Shop:1-5', 'method:Shop.open:2-4', 'interface:Api:6-6', 'class:Single:7-7', 'function:top:8-8']],
  rb: ['module M\n  class Shop\n    def open(n)\n      n\n    end\n  end\nend\ndef top; end\n', ['class:M:1-7', 'class:M.Shop:2-6', 'method:M.Shop.open:3-5', 'function:top:8-8']],
  php: ['<?php\nclass Shop {\n  public function open($n) {\n  }\n}\ninterface I {}\nfunction top() {}\n', ['class:Shop:2-5', 'method:Shop.open:3-4', 'interface:I:6-6', 'function:top:7-7']],
  swift: ['class Shop {\n  func open(n: Int) -> Int {\n    return n\n  }\n}\nprotocol P {}\nstruct S {}\nfunc top() {}\n', ['class:Shop:1-5', 'method:Shop.open:2-4', 'interface:P:6-6', 'struct:S:7-7', 'function:top:8-8']],
  c: ['struct P { int x; };\nint add(int a,\n  int b) {\n  return a + b;\n}\nstatic void hidden(void) {}\n', ['struct:P:1-1', 'function:add:2-5', 'function:hidden:6-6']],
  cpp: ['namespace n {\nclass Shop {\n public:\n  void open(int n) {}\n};\n}\nint top() { return 0; }\nvoid Shop::close() {\n}\n', ['class:Shop:2-5', 'method:Shop.open:4-4', 'function:top:7-7', 'method:Shop.close:8-9']],
  scala: ['object Shop {\n  def open(n: Int): Int = {\n    n\n  }\n}\nclass A\ntrait T\n', ['class:Shop:1-5', 'method:Shop.open:2-4', 'class:A:6-6', 'trait:T:7-7']],
  dart: ['class Shop {\n  int open(int n) {\n    return n;\n  }\n}\nint top() {\n  return 0;\n}\n', ['class:Shop:1-5', 'method:Shop.open:2-4', 'function:top:6-8']],
  lua: ['local function helper(x)\n  return x\nend\nfunction M.open(n)\n  return n\nend\n', ['function:helper:1-3', 'method:M.open:4-6']],
  sh: ['build() {\n  echo hi\n}\nfunction clean {\n  rm x\n}\n', ['function:build:1-3', 'function:clean:4-6']],
  ex: ['defmodule Shop do\n  def open(n) do\n    n\n  end\n  defp hidden(x), do: x\nend\n', ['class:Shop:1-6', 'method:Shop.open:2-4', 'method:Shop.hidden:5-5']],
  zig: ['const Shop = struct {\n    pub fn open(n: i32) i32 {\n        return n;\n    }\n};\nfn top() void {}\n', ['struct:Shop:1-5', 'method:Shop.open:2-4', 'function:top:6-6']],
  ml: ['let add a b =\n  a + b\n\nmodule Shop = struct\n  let open_ n = n\nend\ntype t = int\n', ['function:add:1-2', 'struct:Shop:4-6', 'method:Shop.open_:5-5', 'type:t:7-7']],
};

test('tree-sitter: one snippet in each of the 20 §12.4 languages parses with correct symbol ranges (F-IDX-1)', () => {
  assert.equal(TREE_SITTER_LANGS.length, 20);
  assert.deepEqual([...TREE_SITTER_LANGS].sort(), Object.keys(SNIPPETS).sort());
  for (const [lang, [src, expected]] of Object.entries(SNIPPETS)) {
    const e = extract(lang as Lang, src);
    assert.equal(e.parser, 'tree-sitter', `${lang} grammar loaded`);
    assert.deepEqual(fmt(lang as Lang, src), expected, lang);
  }
  const vis = (lang: Lang, src: string) => Object.fromEntries(extract(lang, src).symbols.map((s) => [s.name, s.exported]));
  assert.deepEqual(vis('kt', SNIPPETS.kt[0]), { Shop: true, open: true, Api: true, Single: true, top: false });
  assert.deepEqual(vis('c', SNIPPETS.c[0]), { P: true, add: true, hidden: false });
  assert.deepEqual(vis('ex', SNIPPETS.ex[0]), { Shop: true, open: true, hidden: false });
  for (const ext of ['a.cs', 'a.kt', 'a.rb', 'a.php', 'a.swift', 'a.c', 'a.h', 'a.cpp', 'a.scala', 'a.dart', 'a.lua', 'a.sh', 'a.ex', 'a.zig', 'a.ml']) assert.ok(langOf(ext), ext);
});
