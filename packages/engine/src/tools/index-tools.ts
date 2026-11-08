import { preciseReferences } from '../index/precise.ts';
import type { Tool } from './registry.ts';

const TS_JS = /\.(c|m)?(t|j)sx?$/;

/** Index-backed read tools (F-IDX-1/F-IDX-4). They return nothing useful if the task has no index. */
export const findSymbol: Tool = {
  spec: {
    name: 'find_symbol',
    description: 'Find where a function, class, method, type, or constant is defined (from the code index). Faster and more precise than text search for identifiers. Returns path:line, kind, and signature; also lists files that import the defining file.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, description: 'Symbol name or qualified name, e.g. Inventory.total' } }, required: ['name'] },
  },
  async run(args, { index }) {
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    index.update();
    const hits = index.findSymbol(String(args.name), 15);
    if (!hits.length) return { content: `no symbol matching '${args.name}'`, summary: `find_symbol ${args.name}: 0` };
    const lines = hits.map((h) => {
      const deps = index.dependents(h.path);
      const tests = index.coveringTests(h.path);
      return `${h.path}:${h.line}-${h.endLine}  ${h.kind} ${h.qualifiedName}${h.exported ? ' (exported)' : ''}\n    ${h.signature}${deps.length ? `\n    imported by: ${deps.slice(0, 8).join(', ')}` : ''}${tests.length ? `\n    tests: ${tests.slice(0, 5).join(', ')}` : ''}`;
    });
    return { content: lines.join('\n'), summary: `find_symbol ${args.name}: ${hits.length}` };
  },
};

export const codeSearch: Tool = {
  spec: {
    name: 'code_search',
    description: 'Ranked semantic-ish code search over the index (BM25 + symbol + path, fused). Use natural language or identifiers, e.g. "where are discounts applied". Returns the best matching code slices with line numbers and why each matched.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2 }, path: { type: 'string', description: 'Optional directory prefix to restrict results' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
  },
  async run(args, { index }) {
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    index.update();
    const hits = index.search(String(args.query), { limit: Number(args.limit ?? 6), pathPrefix: args.path ? String(args.path) : undefined });
    if (!hits.length) return { content: 'no results', summary: `code_search: 0` };
    return {
      content: hits.map((h) => `## ${h.path}:${h.startLine}-${h.endLine}${h.symbol ? ` (${h.symbol})` : ''} [${h.why.join('+')}]\n${h.preview}`).join('\n\n'),
      summary: `code_search '${String(args.query).slice(0, 40)}': ${hits.length}`,
    };
  },
};

export const impactTool: Tool = {
  spec: {
    name: 'impact',
    description: 'Impact analysis from the code graph: given a symbol name or a file path, lists call sites (transitively, with depth), importing files, and tests that cover them. Use before changing a function signature or behavior to find everything that may break.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', minLength: 1, description: 'Symbol name (e.g. Inventory.total) or workspace-relative file path' }, depth: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['target'] },
  },
  async run(args, { index }) {
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    index.update();
    let r = index.impact(String(args.target), { depth: args.depth === undefined ? 2 : Number(args.depth) });
    if (r.kind === 'unknown') return { content: `no symbol or indexed file named '${args.target}'`, summary: `impact ${args.target}: unknown` };
    const tsDefs = r.kind === 'symbol' && r.definitions.length <= 8 && r.definitions.every((d) => TS_JS.test(d.path));
    if (tsDefs) {
      const refs = await preciseReferences(index.root, r.definitions.map((d) => ({ path: d.path, line: d.line, name: d.name })));
      if (refs) r = index.withPreciseCallers(r, refs);
    }
    const out = [
      r.precision === 'precise'
        ? `Impact of ${r.kind} ${r.target} (precise, TypeScript language service references; direct callers only, run impact on a caller to go deeper):`
        : `Impact of ${r.kind} ${r.target} (heuristic, name-based call edges):`,
      `definitions: ${r.definitions.slice(0, 10).map((d) => `${d.qualifiedName} @ ${d.path}:${d.line}`).join(', ') || '(none)'}`,
      `callers (${r.callers.length}):`,
      ...r.callers.slice(0, 40).map((c) => `  ${'  '.repeat(c.depth - 1)}${c.path}:${c.line} in ${c.caller || '(top level)'} -> ${c.calls}`),
      `affected files: ${r.affectedFiles.join(', ') || '(none)'}`,
      `tests: ${r.tests.join(', ') || '(none found)'}`,
    ];
    return { content: out.join('\n'), summary: `impact ${args.target}: ${r.callers.length} callers, ${r.affectedFiles.length} files, ${r.tests.length} tests` };
  },
};
