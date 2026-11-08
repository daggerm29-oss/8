/**
 * Symbol + import extractor (F-IDX-1, §12.1). Symbols for TS/JS/Python/Go/Rust/Java come from tree-sitter
 * (`treesitter.ts`); other languages, or a missing WASM runtime, use the heuristic line-oriented regexes below
 * (IMPL-ADR-014), with ranges from brace matching or indentation. Imports always use the regexes. Both produce
 * the §11.3 symbol model; callers never depend on how symbols were found.
 */
import { treeSitterSymbols } from './treesitter.ts';

export type Lang = 'ts' | 'js' | 'py' | 'go' | 'rs' | 'java' | 'kt' | 'md' | 'json' | 'yaml' | 'css' | 'html' | 'sh' | 'text';

export interface ExtractedSymbol {
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const' | 'struct' | 'trait' | 'heading';
  name: string;
  qualifiedName: string;
  line: number;
  endLine: number;
  signature: string;
  exported: boolean;
}

export interface Extraction {
  symbols: ExtractedSymbol[];
  imports: string[];
  parser: 'tree-sitter' | 'heuristic';
}

const EXT: Record<string, Lang> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
  md: 'md', mdx: 'md', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'yaml', css: 'css', scss: 'css', html: 'html', sh: 'sh', bash: 'sh', sql: 'text', txt: 'text',
};

export function langOf(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return EXT[ext] ?? null;
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /[._-](test|spec)\.\w+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
}

/** Split identifiers into searchable terms: `getUserById` → `get user by id`, `snake_case` → `snake case`. */
export function identifierTerms(text: string): string {
  const out = new Set<string>();
  for (const id of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    for (const part of id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[_\s]+/)) if (part.length > 1) out.add(part.toLowerCase());
  }
  return [...out].join(' ');
}

interface Rule { re: RegExp; kind: ExtractedSymbol['kind']; exported?: (m: RegExpExecArray, line: string) => boolean }

const exportedJs = (_m: RegExpExecArray, line: string) => /^\s*export\b/.test(line);
const RULES: Partial<Record<Lang, Rule[]>> = {
  ts: [
    { re: /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', exported: exportedJs },
    { re: /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: exportedJs },
    { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', exported: exportedJs },
    { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type', exported: exportedJs },
    { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', exported: exportedJs },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function', exported: exportedJs },
    { re: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/, kind: 'const', exported: () => true },
    { re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|override\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b|new\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/, kind: 'method', exported: () => false },
  ],
  py: [
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', exported: (m) => !m[1].startsWith('_') },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', exported: (m) => !m[1].startsWith('_') },
  ],
  go: [
    { re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method', exported: (m) => /^[A-Z]/.test(m[1]) },
    { re: /^func\s+([A-Za-z_]\w*)/, kind: 'function', exported: (m) => /^[A-Z]/.test(m[1]) },
    { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'struct', exported: (m) => /^[A-Z]/.test(m[1]) },
    { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface', exported: (m) => /^[A-Z]/.test(m[1]) },
    { re: /^type\s+([A-Za-z_]\w*)\s+/, kind: 'type', exported: (m) => /^[A-Z]/.test(m[1]) },
  ],
  rs: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', exported: (_m, l) => /^\s*pub\b/.test(l) },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', exported: (_m, l) => /^\s*pub\b/.test(l) },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', exported: (_m, l) => /^\s*pub\b/.test(l) },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', exported: (_m, l) => /^\s*pub\b/.test(l) },
    { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_]\w*)/, kind: 'class', exported: () => false },
  ],
  java: [
    { re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|record)\s+([A-Za-z_]\w*)/, kind: 'class', exported: (_m, l) => /\bpublic\b/.test(l) },
    { re: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/, kind: 'interface', exported: (_m, l) => /\bpublic\b/.test(l) },
    { re: /^\s+(?:public\s+|private\s+|protected\s+)(?:static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/, kind: 'method', exported: (_m, l) => /\bpublic\b/.test(l) },
  ],
};
RULES.js = RULES.ts;
RULES.kt = RULES.java;

const IMPORT_RES: Partial<Record<Lang, RegExp[]>> = {
  ts: [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g],
  py: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*(?:import\s+)?"([\w./-]+)"\s*$/gm],
  rs: [/^\s*use\s+([\w:]+)/gm],
  java: [/^\s*import\s+([\w.]+);/gm],
};
IMPORT_RES.js = IMPORT_RES.ts;
IMPORT_RES.kt = IMPORT_RES.java;

function braceEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && i < start + 2000; i++) {
    const l = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    for (const ch of l) {
      if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && /;\s*$/.test(l)) return i;
    if (!opened && i - start > 3) return start;
  }
  return opened ? Math.min(lines.length - 1, start + 2000) : start;
}

function indentEnd(lines: string[], start: number): number {
  const base = /^\s*/.exec(lines[start])![0].length;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^\s*/.exec(lines[i])![0].length <= base) break;
    end = i;
  }
  return end;
}

export function extract(lang: Lang, text: string): Extraction {
  const tree = treeSitterSymbols(lang, text);
  return tree ? { symbols: tree, imports: extractImports(lang, text), parser: 'tree-sitter' } : extractHeuristic(lang, text);
}

function extractImports(lang: Lang, text: string): string[] {
  const imports = new Set<string>();
  for (const re of IMPORT_RES[lang] ?? []) for (const m of text.matchAll(re)) imports.add(m[1]);
  return [...imports];
}

export function extractHeuristic(lang: Lang, text: string): Extraction {
  const lines = text.split('\n');
  const symbols: ExtractedSymbol[] = [];
  if (lang === 'md') {
    lines.forEach((l, i) => {
      const m = /^(#{1,3})\s+(.+)$/.exec(l);
      if (m) symbols.push({ kind: 'heading', name: m[2].trim(), qualifiedName: m[2].trim(), line: i + 1, endLine: i + 1, signature: l.trim(), exported: true });
    });
    for (let s = 0; s < symbols.length; s++) symbols[s].endLine = (symbols[s + 1]?.line ?? lines.length + 1) - 1;
    return { symbols, imports: [], parser: 'heuristic' };
  }
  const rules = RULES[lang];
  if (rules) {
    const stack: ExtractedSymbol[] = [];
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inBlockComment) { if (line.includes('*/')) inBlockComment = false; continue; }
      if (/^\s*\/\*/.test(line) && !line.includes('*/')) { inBlockComment = true; continue; }
      if (/^\s*(\/\/|#(?!\[)|\*)/.test(line)) continue;
      for (const rule of rules) {
        const m = rule.re.exec(line);
        if (!m) continue;
        while (stack.length && stack[stack.length - 1].endLine < i + 1) stack.pop();
        const parent = stack[stack.length - 1];
        if (rule.kind === 'method' && !parent && lang !== 'go') break;
        const endIdx = lang === 'py' ? indentEnd(lines, i) : braceEnd(lines, i);
        const kind = lang === 'py' && rule.kind === 'function' && parent?.kind === 'class' ? 'method' : rule.kind;
        const goReceiver = lang === 'go' && rule.kind === 'method' ? /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)/.exec(line)?.[1] : undefined;
        const sym: ExtractedSymbol = {
          kind, name: m[1], qualifiedName: goReceiver ? `${goReceiver}.${m[1]}` : parent ? `${parent.qualifiedName}.${m[1]}` : m[1], line: i + 1, endLine: endIdx + 1,
          signature: line.trim().replace(/\s*\{\s*$/, '').slice(0, 200), exported: rule.exported ? rule.exported(m, line) : false,
        };
        symbols.push(sym);
        if (['class', 'interface', 'struct', 'trait', 'enum'].includes(kind) || lang === 'py') stack.push(sym);
        break;
      }
    }
  }
  return { symbols, imports: extractImports(lang, text), parser: 'heuristic' };
}
