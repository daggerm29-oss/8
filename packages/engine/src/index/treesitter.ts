/**
 * tree-sitter symbol extractor (§12.1, §12.4). Grammars for the top 20 languages are prebuilt WASM:
 * `@vscode/tree-sitter-wasm` (TS/JS/Python/Go/Rust/Java/C#/C++/Ruby/PHP/Bash), `tree-sitter-wasms` (C, Kotlin,
 * Scala, Dart, Elixir, Zig, OCaml) and vendored `grammars/` builds (Swift 0.7.3, Lua 0.5.0: the `tree-sitter-wasms`
 * Swift build crashes V8's optimizing compiler and its Lua build misparses keywords on this runtime).
 * They load once at module load (top-level await), so `extract()` stays synchronous. If the package or a
 * grammar cannot load, `treeSitterSymbols` returns null and the caller falls back to the heuristic extractor.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractedSymbol, Lang } from './extract.ts';

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  parent: TsNode | null;
  namedChildren: TsNode[];
  nextNamedSibling: TsNode | null;
  childForFieldName(name: string): TsNode | null;
}
interface TsParser { setLanguage(l: unknown): void; parse(text: string): { rootNode: TsNode; delete(): void } | null }

type Source = 'vscode' | 'wasms' | 'vendored';
const GRAMMARS: Partial<Record<Lang, [Source, string]>> = {
  ts: ['vscode', 'tsx'], js: ['vscode', 'javascript'], py: ['vscode', 'python'], go: ['vscode', 'go'], rs: ['vscode', 'rust'], java: ['vscode', 'java'],
  cs: ['vscode', 'c-sharp'], cpp: ['vscode', 'cpp'], rb: ['vscode', 'ruby'], php: ['vscode', 'php'], sh: ['vscode', 'bash'],
  c: ['wasms', 'c'], kt: ['wasms', 'kotlin'], scala: ['wasms', 'scala'], dart: ['wasms', 'dart'], ex: ['wasms', 'elixir'], zig: ['wasms', 'zig'], ml: ['wasms', 'ocaml'],
  swift: ['vendored', 'swift'], lua: ['vendored', 'lua'],
};
/** The 20 languages of §12.4 with bundled grammars. */
export const TREE_SITTER_LANGS = Object.keys(GRAMMARS) as Lang[];
const parsers = new Map<Lang, TsParser>();

try {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@vscode/tree-sitter-wasm');
  const dirs: Record<Source, string> = {
    vscode: dirname(entry),
    wasms: (() => { try { return join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out'); } catch { return ''; } })(),
    vendored: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars'),
  };
  const mod = require('@vscode/tree-sitter-wasm') as { Parser: { init(): Promise<void>; new (): TsParser }; Language: { load(path: string): Promise<unknown> } };
  await mod.Parser.init();
  for (const [lang, [source, grammar]] of Object.entries(GRAMMARS) as Array<[Lang, [Source, string]]>) {
    try {
      const file = source === 'wasms' ? `tree-sitter-${grammar.replace('-', '_')}.wasm` : `tree-sitter-${grammar}.wasm`;
      const language = await mod.Language.load(join(dirs[source], file));
      const parser = new mod.Parser();
      parser.setLanguage(language);
      parsers.set(lang, parser);
    } catch { /* grammar unavailable: heuristic fallback for this language */ }
  }
} catch { /* runtime unavailable: heuristic fallback for all languages */ }

export function treeSitterAvailable(lang: Lang): boolean {
  return parsers.has(lang);
}

export type SyntaxNode = TsNode;

/** Parses `text` and passes the root node to `fn`; the tree is freed afterwards. Null when no grammar is available. */
export function withTree<T>(lang: Lang, text: string, fn: (root: SyntaxNode) => T): T | null {
  const parser = parsers.get(lang);
  const tree = parser?.parse(text);
  if (!tree) return null;
  try { return fn(tree.rootNode); } finally { tree.delete(); }
}

type Kind = ExtractedSymbol['kind'];
interface Found { kind: Kind; name: string; exported: boolean; node: TsNode; sigNode?: TsNode; qualifier?: string; startNode?: TsNode; endNode?: TsNode }

const CONTAINERS = new Set<Kind>(['class', 'interface', 'struct', 'trait', 'enum']);
const FN_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const upper = (s: string) => /^[A-Z]/.test(s);

function field(node: TsNode, name: string): string | undefined {
  return node.childForFieldName(name)?.text;
}

function jsExport(node: TsNode): TsNode | undefined {
  let n = node.parent;
  if (n && (n.type === 'lexical_declaration' || n.type === 'variable_declaration')) n = n.parent;
  return n?.type === 'export_statement' ? n : undefined;
}

function classify(lang: Lang, node: TsNode, parent: ExtractedSymbol | undefined): Found | null {
  const t = node.type;
  if (lang === 'ts' || lang === 'js') {
    const exp = jsExport(node);
    const base = { exported: !!exp, node, sigNode: exp };
    const name = field(node, 'name');
    if (t === 'function_declaration' || t === 'generator_function_declaration' || t === 'function_signature') return name ? { ...base, kind: 'function', name } : null;
    if (t === 'class_declaration' || t === 'abstract_class_declaration') return name ? { ...base, kind: 'class', name } : null;
    if (t === 'interface_declaration') return name ? { ...base, kind: 'interface', name } : null;
    if (t === 'type_alias_declaration') return name ? { ...base, kind: 'type', name } : null;
    if (t === 'enum_declaration') return name ? { ...base, kind: 'enum', name } : null;
    if (t === 'method_definition') return name && parent ? { kind: 'method', name, exported: false, node } : null;
    if (t === 'variable_declarator') {
      const id = node.childForFieldName('name');
      if (id?.type !== 'identifier') return null;
      const sigNode = exp ?? node.parent ?? undefined;
      if (FN_VALUES.has(node.childForFieldName('value')?.type ?? '')) return { kind: 'function', name: id.text, exported: !!exp, node, sigNode };
      if (exp && /^const\b/.test(node.parent?.text ?? '')) return { kind: 'const', name: id.text, exported: true, node, sigNode };
    }
    return null;
  }
  if (lang === 'py') {
    const name = field(node, 'name');
    if (!name) return null;
    if (t === 'class_definition') return { kind: 'class', name, exported: !name.startsWith('_'), node };
    if (t === 'function_definition') return { kind: parent?.kind === 'class' ? 'method' : 'function', name, exported: !name.startsWith('_'), node };
    return null;
  }
  if (lang === 'go') {
    if (t === 'function_declaration') { const name = field(node, 'name'); return name ? { kind: 'function', name, exported: upper(name), node } : null; }
    if (t === 'method_declaration') {
      const name = field(node, 'name');
      const recv = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)\s*$/.exec(field(node, 'receiver') ?? '')?.[1];
      return name ? { kind: 'method', name, exported: upper(name), node, qualifier: recv } : null;
    }
    if (t === 'type_spec' || t === 'type_alias') {
      const name = field(node, 'name');
      const ty = node.childForFieldName('type')?.type;
      const kind: Kind = ty === 'struct_type' ? 'struct' : ty === 'interface_type' ? 'interface' : 'type';
      return name ? { kind, name, exported: upper(name), node, sigNode: node.parent?.namedChildren.length === 1 ? node.parent : undefined } : null;
    }
    return null;
  }
  if (lang === 'rs') {
    const pub = node.namedChildren.some((c) => c.type === 'visibility_modifier');
    const name = field(node, 'name');
    if (t === 'function_item' || t === 'function_signature_item') return name ? { kind: parent && (parent.kind === 'class' || parent.kind === 'trait') ? 'method' : 'function', name, exported: pub, node } : null;
    if (t === 'struct_item') return name ? { kind: 'struct', name, exported: pub, node } : null;
    if (t === 'enum_item') return name ? { kind: 'enum', name, exported: pub, node } : null;
    if (t === 'trait_item') return name ? { kind: 'trait', name, exported: pub, node } : null;
    if (t === 'impl_item') {
      const ty = /^[\w:]*?([A-Za-z_]\w*)\s*(?:<.*)?$/s.exec(field(node, 'type') ?? '')?.[1];
      return ty ? { kind: 'class', name: ty, exported: false, node } : null;
    }
    return null;
  }
  if (lang === 'java') {
    const name = field(node, 'name');
    if (!name) return null;
    const pub = node.namedChildren.some((c) => c.type === 'modifiers' && /\bpublic\b/.test(c.text));
    if (t === 'class_declaration' || t === 'record_declaration') return { kind: 'class', name, exported: pub, node };
    if (t === 'interface_declaration') return { kind: 'interface', name, exported: pub, node };
    if (t === 'enum_declaration') return { kind: 'enum', name, exported: pub, node };
    if ((t === 'method_declaration' || t === 'constructor_declaration') && parent) return { kind: 'method', name, exported: pub, node };
    return null;
  }
  return classifyGeneric(lang, node, parent);
}

const NAME_CHILD = /^(identifier|type_identifier|simple_identifier|constant|name|word|field_identifier|value_name|module_name|type_constructor|alias)$/;

/** `name` field, else the first identifier-like named child. */
function nameOf(node: TsNode): string | undefined {
  return field(node, 'name') ?? node.namedChildren.find((c) => NAME_CHILD.test(c.type))?.text;
}

/** Innermost declarator name of a C/C++ function (`int *f(...)`, `Shop::close(...)`). */
function cDeclarator(node: TsNode): { name: string; qualifier?: string } | undefined {
  let d = node.childForFieldName('declarator');
  while (d && d.type !== 'function_declarator') d = d.childForFieldName('declarator');
  const id = d?.childForFieldName('declarator');
  if (!id) return undefined;
  if (id.type === 'qualified_identifier') {
    const scope = id.childForFieldName('scope')?.text;
    const name = id.childForFieldName('name')?.text;
    return name ? { name, qualifier: scope } : undefined;
  }
  return { name: id.text };
}

const hasModifier = (node: TsNode, re: RegExp) => node.namedChildren.some((c) => /modifier|visibility|storage_class/.test(c.type) && re.test(c.text));
const firstWord = (node: TsNode) => /^\s*(?:@\w+\s+|(?:public|private|internal|open|final|fileprivate|abstract|sealed|data|annotation|inner)\s+)*(\w+)/.exec(node.text)?.[1];

/** Table-driven §11.3 classification for the tier B/C languages of §12.4. */
function classifyGeneric(lang: Lang, node: TsNode, parent: ExtractedSymbol | undefined): Found | null {
  const t = node.type;
  const fnKind = (): Kind => (parent && CONTAINERS.has(parent.kind) ? 'method' : 'function');
  const name = () => nameOf(node);
  const make = (kind: Kind, n: string | undefined, exported: boolean, extra: Partial<Found> = {}): Found | null => (n ? { kind, name: n, exported, node, ...extra } : null);
  switch (lang) {
    case 'cs': {
      const pub = hasModifier(node, /^public$/);
      const kinds: Record<string, Kind> = { class_declaration: 'class', record_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', struct_declaration: 'struct', method_declaration: 'method', constructor_declaration: 'method' };
      return kinds[t] ? make(kinds[t], name(), pub) : null;
    }
    case 'kt': {
      const priv = /^\s*(private|internal)\b/.test(node.text);
      if (t === 'class_declaration') {
        const kw = /\benum\s+class\b/.test(node.text.split('{')[0]) ? 'enum' : firstWord(node);
        return make(kw === 'interface' ? 'interface' : kw === 'enum' ? 'enum' : 'class', name(), !priv);
      }
      if (t === 'object_declaration') return make('class', name(), !priv);
      if (t === 'function_declaration') return make(fnKind(), name(), !priv);
      return null;
    }
    case 'rb':
      if (t === 'module' || t === 'class') return make('class', name(), true);
      if (t === 'method' || t === 'singleton_method') return make(fnKind(), name(), true);
      return null;
    case 'php': {
      const pub = !hasModifier(node, /^(private|protected)$/);
      const kinds: Record<string, Kind> = { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'trait', enum_declaration: 'enum', function_definition: 'function', method_declaration: 'method' };
      return kinds[t] ? make(kinds[t], name(), pub) : null;
    }
    case 'swift': {
      const priv = /^\s*(private|fileprivate)\b/.test(node.text);
      if (t === 'class_declaration') {
        const kw = firstWord(node);
        return make(kw === 'struct' ? 'struct' : kw === 'enum' ? 'enum' : 'class', name(), !priv);
      }
      if (t === 'protocol_declaration') return make('interface', name(), !priv);
      if (t === 'function_declaration' || t === 'init_declaration') return make(fnKind(), t === 'init_declaration' ? 'init' : name(), !priv);
      return null;
    }
    case 'c':
    case 'cpp': {
      if (t === 'function_definition') {
        const d = cDeclarator(node);
        if (!d) return null;
        const isStatic = node.namedChildren.some((c) => c.type === 'storage_class_specifier' && c.text === 'static');
        return make(d.qualifier || (parent && CONTAINERS.has(parent.kind)) ? 'method' : 'function', d.name, !isStatic, d.qualifier ? { qualifier: d.qualifier } : {});
      }
      const body = node.childForFieldName('body');
      if (t === 'struct_specifier' && body) return make('struct', name(), true);
      if (t === 'enum_specifier' && body) return make('enum', name(), true);
      if (lang === 'cpp' && t === 'class_specifier' && body) return make('class', name(), true);
      return null;
    }
    case 'scala': {
      const priv = /^\s*private\b/.test(node.text);
      const kinds: Record<string, Kind> = { object_definition: 'class', class_definition: 'class', trait_definition: 'trait', enum_definition: 'enum' };
      if (kinds[t]) return make(kinds[t], name(), !priv);
      if (t === 'function_definition' || t === 'function_declaration') return make(fnKind(), name(), !priv);
      return null;
    }
    case 'dart': {
      if (t === 'class_definition' || t === 'enum_declaration' || t === 'mixin_declaration') {
        const n = name();
        return make(t === 'enum_declaration' ? 'enum' : 'class', n, !!n && !n.startsWith('_'));
      }
      if (t === 'function_signature') {
        const holder = node.parent?.type === 'method_signature' ? node.parent : node;
        const body = holder.nextNamedSibling?.type === 'function_body' ? holder.nextNamedSibling : undefined;
        const n = name();
        return make(fnKind(), n, !!n && !n.startsWith('_'), body ? { endNode: body, startNode: holder } : {});
      }
      return null;
    }
    case 'lua': {
      if (t !== 'function_declaration') return null;
      const n = node.childForFieldName('name');
      if (!n) return null;
      const local = /^\s*local\b/.test(node.text);
      if (n.type === 'dot_index_expression' || n.type === 'method_index_expression') {
        const parts = n.text.split(/[.:]/);
        return make('method', parts.pop(), !local, { qualifier: parts.join('.') });
      }
      return make('function', n.text, !local);
    }
    case 'sh':
      return t === 'function_definition' ? make('function', name(), true) : null;
    case 'ex': {
      if (t !== 'call') return null;
      const target = node.namedChildren[0];
      const args = node.namedChildren.find((c) => c.type === 'arguments');
      if (target?.type !== 'identifier' || !args) return null;
      const head = args.namedChildren[0];
      if (target.text === 'defmodule') return make('class', head?.text, true);
      if (['def', 'defp', 'defmacro', 'defmacrop'].includes(target.text)) {
        const n = head?.type === 'call' ? head.namedChildren[0]?.text : head?.type === 'binary_operator' ? head.namedChildren[0]?.namedChildren[0]?.text : head?.text;
        return make(parent && CONTAINERS.has(parent.kind) ? 'method' : 'function', n, !target.text.endsWith('p'));
      }
      return null;
    }
    case 'zig': {
      const pub = /^\s*pub\b/.test(node.text);
      if (t === 'function_declaration') return make(fnKind(), name(), pub);
      if (t === 'variable_declaration') {
        const value = node.namedChildren.find((c) => /^(struct|enum|union|opaque)_declaration$/.test(c.type));
        if (!value) return null;
        return make(value.type === 'enum_declaration' ? 'enum' : 'struct', name(), pub);
      }
      return null;
    }
    case 'ml': {
      if (t === 'let_binding') {
        const pattern = node.childForFieldName('pattern') ?? node.namedChildren[0];
        if (pattern?.type !== 'value_name') return null;
        const isFn = node.namedChildren.some((c) => c.type === 'parameter') || node.childForFieldName('body')?.type === 'fun_expression';
        return make(isFn ? (parent ? 'method' : 'function') : 'const', pattern.text, true, { startNode: node.parent?.type === 'value_definition' && node.parent.namedChildren[0] === node ? node.parent : undefined });
      }
      if (t === 'module_binding') return make('struct', name(), true, { startNode: node.parent?.type === 'module_definition' ? node.parent : undefined });
      if (t === 'type_binding') return make('type', name(), true, { startNode: node.parent?.type === 'type_definition' ? node.parent : undefined });
      return null;
    }
    default:
      return null;
  }
}

/** Declaration text up to its body (multi-line signatures collapsed to one line), else its first line. */
function signature(found: Found): string {
  const start = found.sigNode ?? found.node;
  const body = found.node.childForFieldName('body') ?? found.node.childForFieldName('value')?.childForFieldName('body');
  const head = body && body.startIndex > start.startIndex && body.startPosition.row - start.startPosition.row <= 10
    ? start.text.slice(0, body.startIndex - start.startIndex)
    : start.text.split('\n')[0];
  return head.replace(/\s+/g, ' ').replace(/[\s{:]*$/, '').replace(/\s*=>$/, ' =>').trim().slice(0, 200);
}

export function treeSitterSymbols(lang: Lang, text: string): ExtractedSymbol[] | null {
  const parser = parsers.get(lang);
  if (!parser) return null;
  const tree = parser.parse(text);
  if (!tree) return null;
  const symbols: ExtractedSymbol[] = [];
  const walk = (node: TsNode, parent: ExtractedSymbol | undefined): void => {
    for (const child of node.namedChildren) {
      const found = classify(lang, child, parent);
      if (!found) { walk(child, parent); continue; }
      const qualifier = found.qualifier ?? parent?.qualifiedName;
      const sym: ExtractedSymbol = {
        kind: found.kind, name: found.name, qualifiedName: qualifier ? `${qualifier}.${found.name}` : found.name,
        line: (found.sigNode ?? found.startNode ?? child).startPosition.row + 1, endLine: (found.endNode ?? child).endPosition.row + 1, signature: signature(found), exported: found.exported,
      };
      symbols.push(sym);
      walk(child, CONTAINERS.has(sym.kind) || lang === 'py' ? sym : parent);
    }
  };
  try { walk(tree.rootNode, undefined); } finally { tree.delete(); }
  return symbols;
}
