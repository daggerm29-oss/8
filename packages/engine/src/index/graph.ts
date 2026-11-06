import type { ExtractedSymbol, Lang } from './extract.ts';

/** A call-site reference: `name(` or `new Name` at `line`, inside the enclosing symbol `caller` ('' = top level). */
export interface Ref {
  name: string;
  line: number;
  caller: string;
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'yield', 'new', 'super', 'this', 'import', 'export',
  'def', 'class', 'print', 'elif', 'with', 'lambda', 'assert', 'not', 'and', 'or', 'in', 'is', 'del', 'except', 'raise',
  'fn', 'func', 'match', 'loop', 'impl', 'go', 'defer', 'select', 'sizeof', 'require', 'constructor', 'async', 'void', 'delete',
]);

const COMMENT: Partial<Record<Lang, RegExp>> = { py: /#.*$/, ts: /\/\/.*$/, js: /\/\/.*$/, go: /\/\/.*$/, rs: /\/\/.*$/, java: /\/\/.*$/, sh: /#.*$/ };
const CODE_LANGS = new Set<Lang>(['ts', 'js', 'py', 'go', 'rs', 'java', 'sh']);

/**
 * Heuristic call-site extractor for the code graph v0 (F-IDX-3, §11.5; IMPL-ADR-016). Name-based: a
 * reference is linked to a definition by name, narrowed by import edges at query time. tree-sitter /
 * SCIP (F-IDX-2) replace this with precise resolution behind the same `Ref` shape.
 */
export function extractRefs(lang: Lang, text: string, symbols: ExtractedSymbol[]): Ref[] {
  if (!CODE_LANGS.has(lang)) return [];
  const defs = symbols.filter((s) => s.kind !== 'heading').sort((a, b) => (a.line - b.line) || (b.endLine - a.endLine));
  const defLines = new Map<number, Set<string>>();
  for (const s of defs) (defLines.get(s.line) ?? defLines.set(s.line, new Set()).get(s.line)!).add(s.name);
  const enclosing = (line: number): string => {
    let best: ExtractedSymbol | null = null;
    for (const s of defs) if (s.line <= line && s.endLine >= line && (!best || s.endLine - s.line <= best.endLine - best.line)) best = s;
    return best?.qualifiedName ?? '';
  };
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  const comment = COMMENT[lang];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    if (comment) l = l.replace(comment, '');
    if (/^\s*(\*|\/\*)/.test(l)) continue;
    const line = i + 1;
    const own = defLines.get(line);
    for (const m of l.matchAll(/(?:\bnew\s+([A-Za-z_$][\w$]*))|(?:(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\()/g)) {
      const name = m[1] ?? m[2];
      if (!name || KEYWORDS.has(name)) continue;
      if (own?.has(name) && !m[1]) continue;
      const key = `${line}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ name, line, caller: enclosing(line) });
    }
  }
  return refs;
}
