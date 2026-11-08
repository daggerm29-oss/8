/**
 * tree-sitter symbol extractor (§12.1). Grammars come prebuilt from `@vscode/tree-sitter-wasm` and are loaded
 * once at module load (top-level await), so `extract()` stays synchronous. The syntax tree is walked into the
 * §11.3 symbol model. If the package or a grammar cannot load, `treeSitterSymbols` returns null and the caller
 * falls back to the heuristic extractor.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ExtractedSymbol, Lang } from './extract.ts';

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  parent: TsNode | null;
  namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null;
}
interface TsParser { setLanguage(l: unknown): void; parse(text: string): { rootNode: TsNode; delete(): void } | null }

const GRAMMARS: Partial<Record<Lang, string>> = { ts: 'tsx', js: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java' };
const parsers = new Map<Lang, TsParser>();

try {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@vscode/tree-sitter-wasm');
  const mod = require('@vscode/tree-sitter-wasm') as { Parser: { init(): Promise<void>; new (): TsParser }; Language: { load(path: string): Promise<unknown> } };
  await mod.Parser.init();
  for (const [lang, grammar] of Object.entries(GRAMMARS) as Array<[Lang, string]>) {
    try {
      const language = await mod.Language.load(join(dirname(entry), `tree-sitter-${grammar}.wasm`));
      const parser = new mod.Parser();
      parser.setLanguage(language);
      parsers.set(lang, parser);
    } catch { /* grammar unavailable: heuristic fallback for this language */ }
  }
} catch { /* runtime unavailable: heuristic fallback for all languages */ }

export function treeSitterAvailable(lang: Lang): boolean {
  return parsers.has(lang);
}

type Kind = ExtractedSymbol['kind'];
interface Found { kind: Kind; name: string; exported: boolean; node: TsNode; sigNode?: TsNode; qualifier?: string }

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
  return null;
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
        line: (found.sigNode ?? child).startPosition.row + 1, endLine: child.endPosition.row + 1, signature: signature(found), exported: found.exported,
      };
      symbols.push(sym);
      walk(child, CONTAINERS.has(sym.kind) || lang === 'py' ? sym : parent);
    }
  };
  try { walk(tree.rootNode, undefined); } finally { tree.delete(); }
  return symbols;
}
