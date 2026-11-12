import { GRAPH_OPS, type GraphOp } from '../index/index.ts';
import type { Lang } from '../index/extract.ts';
import { preciseReferences } from '../index/precise.ts';
import type { Tool, ToolContext } from './registry.ts';

const TS_JS = /\.(c|m)?(t|j)sx?$/;

/** Runs one index lookup inside a `retrieval.query` span (§26.1) when the task is traced. */
async function retrieve<T>(ctx: Pick<ToolContext, 'trace'>, retriever: string, query: string, fn: () => T | Promise<T>, count: (r: T) => number): Promise<T> {
  if (!ctx.trace) return fn();
  return ctx.trace('retrieval.query', { retriever, query: query.slice(0, 200) }, async (span) => {
    const r = await fn();
    span.setAttributes({ results: count(r) });
    return r;
  });
}

/** Index-backed read tools (F-IDX-1/F-IDX-4). They return nothing useful if the task has no index. */
export const findSymbol: Tool = {
  spec: {
    name: 'find_symbol',
    description: 'Find where a function, class, method, type, or constant is defined (from the code index). Faster and more precise than text search for identifiers. Returns path:line, kind, and signature; also lists files that import the defining file.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, description: 'Symbol name or qualified name, e.g. Inventory.total' } }, required: ['name'] },
  },
  async run(args, ctx) {
    const { index } = ctx;
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    const hits = await retrieve(ctx, 'symbol', String(args.name), () => { index.update(); return index.findSymbol(String(args.name), 15); }, (h) => h.length);
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
  async run(args, ctx) {
    const { index } = ctx;
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    const hits = await retrieve(ctx, 'hybrid', String(args.query), () => { index.update(); return index.search(String(args.query), { limit: Number(args.limit ?? 6), pathPrefix: args.path ? String(args.path) : undefined }); }, (h) => h.length);
    if (!hits.length) return { content: 'no results', summary: `code_search: 0` };
    return {
      content: hits.map((h) => `## ${h.path}:${h.startLine}-${h.endLine}${h.symbol ? ` (${h.symbol})` : ''} [${h.why.join('+')}]\n${h.preview}`).join('\n\n'),
      summary: `code_search '${String(args.query).slice(0, 40)}': ${hits.length}`,
    };
  },
};

export const domainMap: Tool = {
  spec: {
    name: 'domain_map',
    description: 'List the app domain from the code index: HTTP routes (method, path, handler), database tables (with columns), and environment/config keys (names only), each with file:line. Use to find the handler for an endpoint, where a table is defined, or which env vars the app reads.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['routes', 'tables', 'config', 'all'], description: 'Which section to list (default all)' } } },
  },
  async run(args, ctx) {
    const { index } = ctx;
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    const kind = String(args.kind ?? 'all');
    const d = await retrieve(ctx, 'domain', kind, () => { index.update(); return index.domain(); }, (x) => x.routes.length + x.tables.length + x.config.length);
    const sections: string[] = [];
    if (kind === 'all' || kind === 'routes') sections.push(`## Routes (${d.routes.length})\n${d.routes.map((r) => `${r.method} ${r.path} → ${r.handler}  [${r.framework}] ${r.file}:${r.line}`).join('\n') || '(none)'}`);
    if (kind === 'all' || kind === 'tables') sections.push(`## Tables (${d.tables.length})\n${d.tables.map((t) => `${t.name} (${t.columns.join(', ')})  [${t.source}] ${t.file}:${t.line}`).join('\n') || '(none)'}`);
    if (kind === 'all' || kind === 'config') sections.push(`## Config keys (${d.config.length})\n${d.config.map((c) => `${c.key}  ${c.file}:${c.line}`).join('\n') || '(none)'}`);
    return { content: sections.join('\n\n'), summary: `domain_map ${kind}: ${d.routes.length} routes, ${d.tables.length} tables, ${d.config.length} keys` };
  },
};

export const impactTool: Tool = {
  spec: {
    name: 'impact',
    description: 'Impact analysis from the code graph: given a symbol name or a file path, lists call sites (transitively, with depth), importing files, and tests that cover them. Use before changing a function signature or behavior to find everything that may break.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', minLength: 1, description: 'Symbol name (e.g. Inventory.total) or workspace-relative file path' }, depth: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['target'] },
  },
  async run(args, ctx) {
    const { index, sandbox } = ctx;
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    let r = await retrieve(ctx, 'graph', String(args.target), () => { index.update(); return index.impact(String(args.target), { depth: args.depth === undefined ? 2 : Number(args.depth) }); }, (x) => x.callers.length);
    if (r.kind === 'unknown') return { content: `no symbol or indexed file named '${args.target}'`, summary: `impact ${args.target}: unknown` };
    const tsDefs = r.kind === 'symbol' && r.definitions.length <= 8 && r.definitions.every((d) => TS_JS.test(d.path));
    if (tsDefs) {
      const refs = await preciseReferences(index.root, r.definitions.map((d) => ({ path: d.path, line: d.line, name: d.name })), { lightMode: sandbox.isolation === 'light' });
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

export const structuralSearchTool: Tool = {
  spec: {
    name: 'structural_search',
    description: 'AST-pattern search over indexed files (ast-grep style). Matches code structure, not text, so comments, strings and look-alikes are ignored. Pattern is code with metavariables ($A one node, $$$ARGS many), or the shorthand call(fetch, _). Example: call(fetch, _) or $A.then($B). Returns path:line and captured nodes.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, lang: { type: 'string', description: 'Optional language to restrict to, ts, js, py, go' }, path: { type: 'string', description: 'Optional directory prefix' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['pattern'] },
  },
  async run(args, ctx) {
    const { index } = ctx;
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    const r = await retrieve(ctx, 'structural', String(args.pattern), () => { index.update(); return index.structural(String(args.pattern), { lang: args.lang ? (String(args.lang) as Lang) : undefined, pathPrefix: args.path ? String(args.path) : undefined, limit: Number(args.limit ?? 50) }); }, (x) => x.matches.length);
    if (r.error) return { content: `invalid pattern: ${r.error}`, isError: true };
    if (!r.matches.length) return { content: 'no matches', summary: `structural_search ${args.pattern}: 0` };
    const lines = r.matches.map((m) => {
      const caps = Object.entries(m.captures);
      return `${m.path}:${m.line}${m.endLine > m.line ? `-${m.endLine}` : ''}  ${m.text.split('\n')[0].slice(0, 160)}${caps.length ? `\n    ${caps.map(([k, v]) => `${k}=${v.slice(0, 60)}`).join('  ')}` : ''}`;
    });
    return { content: lines.join('\n'), summary: `structural_search ${args.pattern}: ${r.matches.length}` };
  },
};

export const graphQueryTool: Tool = {
  spec: {
    name: 'graph_query',
    description: 'Deterministic code-graph query. op: definitions | references | callers | callees (target = symbol name), dependents (reverse import closure of a file), importers (files importing a file or module specifier), tests (tests covering a symbol or file). Use for exact sets, e.g. callers of X, tests covering F, files importing M.',
    inputSchema: { type: 'object', properties: { op: { type: 'string', enum: [...GRAPH_OPS] }, target: { type: 'string', minLength: 1 }, depth: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['op', 'target'] },
  },
  async run(args, ctx) {
    const { index } = ctx;
    if (!index) return { content: 'code index unavailable for this task; use search', isError: true };
    const op = String(args.op) as GraphOp;
    if (!GRAPH_OPS.includes(op)) return { content: `unknown op '${op}'; use one of ${GRAPH_OPS.join(', ')}`, isError: true };
    const r = await retrieve(ctx, 'graph', `${op} ${args.target}`, () => { index.update(); return index.graphQuery({ op, target: String(args.target), depth: args.depth === undefined ? undefined : Number(args.depth) }); }, (x) => x.items.length);
    if (!r.items.length) return { content: `no results for ${op} ${args.target}`, summary: `graph_query ${op} ${args.target}: 0` };
    return {
      content: `${op} ${r.target} (${r.precision}, ${r.items.length}):\n${r.items.slice(0, 100).map((i) => `  ${i.path}${i.line ? `:${i.line}` : ''}${i.symbol ? `  ${i.symbol}` : ''}`).join('\n')}`,
      summary: `graph_query ${op} ${args.target}: ${r.items.length}`,
    };
  },
};
