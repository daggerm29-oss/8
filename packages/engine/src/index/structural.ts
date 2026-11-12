/**
 * Structural (AST pattern) search (FR-9, §12.2). Patterns use ast-grep-style syntax: ordinary code in the target
 * language where `$NAME` matches one syntax node (repeats must match identical text), `$_` matches any one node,
 * and `$$$NAME` / `$$$` match any run of sibling nodes (call arguments, statements). The shorthand
 * `call(callee, arg, ...)` (with `_` for any one argument and `...` for any run) compiles to the same thing.
 * The pattern is parsed with the target language's tree-sitter grammar and matched against each file's tree.
 */
import type { Lang } from './extract.ts';
import { treeSitterAvailable, withTree, type SyntaxNode } from './treesitter.ts';

export interface StructuralMatch {
  path: string;
  line: number;
  endLine: number;
  text: string;
  captures: Record<string, string>;
}

const META = /\$\$\$([A-Za-z_][A-Za-z0-9_]*)?|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const SINGLE = '__mv_';
const MULTI = '__mvv_';

/** `call(fetch, _, ...)` → `fetch($_, $$$)`; any other text is already a code pattern. */
export function expandShorthand(pattern: string): string {
  const m = /^\s*call\(\s*([\s\S]*)\)\s*$/.exec(pattern);
  if (!m) return pattern;
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1]!) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim() || parts.length) parts.push(cur.trim());
  const [callee = '', ...args] = parts;
  const conv = (s: string) => (s === '_' ? '$_' : s === '...' ? '$$$' : s);
  return `${conv(callee)}(${args.map(conv).join(', ')})`;
}

const isComment = (n: SyntaxNode) => n.type.includes('comment');
const kids = (n: SyntaxNode) => n.namedChildren.filter((c) => !isComment(c));
const wsFree = (s: string) => s.replace(/\s+/g, '');

/** The node's own tokens: its text with every named child removed (operators, keywords, punctuation). */
function skeleton(n: SyntaxNode): string {
  let out = '';
  let at = n.startIndex;
  for (const c of n.namedChildren) {
    out += n.text.slice(at - n.startIndex, c.startIndex - n.startIndex);
    at = c.endIndex;
  }
  return wsFree(out + n.text.slice(at - n.startIndex));
}

type Binds = Map<string, string>;

function metaName(n: SyntaxNode): { multi: boolean; name: string } | null {
  if (n.namedChildren.length) return null;
  if (n.text.startsWith(MULTI)) return { multi: true, name: n.text.slice(MULTI.length) };
  if (n.text.startsWith(SINGLE)) return { multi: false, name: n.text.slice(SINGLE.length) };
  return null;
}

function bind(binds: Binds, name: string, text: string): boolean {
  if (name === '' || name === '_') return true;
  const prev = binds.get(name);
  if (prev === undefined) { binds.set(name, text); return true; }
  return wsFree(prev) === wsFree(text);
}

function matchNode(p: SyntaxNode, t: SyntaxNode, binds: Binds): boolean {
  const meta = metaName(p);
  if (meta && !meta.multi) return bind(binds, meta.name, t.text);
  if (p.type !== t.type) return false;
  const pk = kids(p);
  if (!pk.length) return t.namedChildren.length === 0 ? wsFree(p.text) === wsFree(t.text) : false;
  const variadic = pk.some((c) => metaName(c)?.multi);
  if (!variadic && skeleton(p) !== skeleton(t)) return false;
  return matchList(pk, kids(t), 0, 0, binds);
}

function matchList(pk: SyntaxNode[], tk: SyntaxNode[], i: number, j: number, binds: Binds): boolean {
  if (i === pk.length) return j === tk.length;
  const meta = metaName(pk[i]!);
  if (meta?.multi) {
    for (let end = tk.length; end >= j; end--) {
      const snapshot = new Map(binds);
      const text = tk.slice(j, end).map((n) => n.text).join(', ');
      if (bind(binds, meta.name, text) && matchList(pk, tk, i + 1, end, binds)) return true;
      binds.clear();
      for (const [k, v] of snapshot) binds.set(k, v);
    }
    return false;
  }
  if (j >= tk.length) return false;
  const snapshot = new Map(binds);
  if (matchNode(pk[i]!, tk[j]!, binds) && matchList(pk, tk, i + 1, j + 1, binds)) return true;
  binds.clear();
  for (const [k, v] of snapshot) binds.set(k, v);
  return false;
}

/** Parses the pattern with the language grammar and returns a matcher, or null if it is not one expression/statement. */
function compile(pattern: string, lang: Lang): ((root: SyntaxNode, emit: (n: SyntaxNode, captures: Record<string, string>) => void) => void) | null {
  const source = expandShorthand(pattern).replace(META, (_m, multi: string | undefined, single: string | undefined) => (single !== undefined ? `${SINGLE}${single}` : `${MULTI}${multi ?? ''}`));
  // Parse inside a snapshot of the tree: keep only plain data so the tree can be freed.
  const frozen = withTree(lang, source, (root) => {
    const top = kids(root);
    if (top.length !== 1) return null;
    let node = top[0]!;
    const inner = kids(node);
    if (node.type.endsWith('statement') && inner.length === 1 && node.text.replace(/;\s*$/, '') === inner[0]!.text) node = inner[0]!;
    return clone(node);
  });
  if (!frozen) return null;
  return (root, emit) => {
    const walk = (n: SyntaxNode) => {
      if (n.type === frozen.type) {
        const binds: Binds = new Map();
        if (matchNode(frozen as unknown as SyntaxNode, n, binds)) emit(n, Object.fromEntries(binds));
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(root);
  };
}

interface Frozen { type: string; text: string; startIndex: number; endIndex: number; namedChildren: Frozen[] }
function clone(n: SyntaxNode): Frozen {
  return { type: n.type, text: n.text, startIndex: n.startIndex, endIndex: n.endIndex, namedChildren: n.namedChildren.map(clone) };
}

export interface StructuralFile { path: string; lang: Lang; text: string }

export function structuralSearch(files: Iterable<StructuralFile>, pattern: string, opts: { lang?: Lang; limit?: number } = {}): { matches: StructuralMatch[]; error?: string } {
  const limit = opts.limit ?? 100;
  const compiled = new Map<Lang, ReturnType<typeof compile>>();
  const matches: StructuralMatch[] = [];
  let compiledAny = false;
  for (const f of files) {
    if (opts.lang && f.lang !== opts.lang) continue;
    if (!treeSitterAvailable(f.lang)) continue;
    if (!compiled.has(f.lang)) compiled.set(f.lang, compile(pattern, f.lang));
    const matcher = compiled.get(f.lang);
    if (!matcher) continue;
    compiledAny = true;
    withTree(f.lang, f.text, (root) => {
      matcher(root, (n, captures) => {
        if (matches.length < limit) matches.push({ path: f.path, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1, text: n.text.length > 300 ? `${n.text.slice(0, 300)}…` : n.text, captures });
      });
    });
    if (matches.length >= limit) break;
  }
  if (!compiledAny && !matches.length) return { matches, error: 'pattern must parse as a single expression or statement in the target language' };
  return { matches };
}
