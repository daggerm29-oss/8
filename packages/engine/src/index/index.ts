import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { blake3Hex, merkleTree } from './hash.ts';
import { HelixIgnore } from './ignore.ts';
import { dirname, join, normalize, relative } from 'node:path';
import type { Db } from '../storage/db.ts';
import { extract, identifierTerms, isTestPath, langOf, type Lang } from './extract.ts';
import { extractRefs } from './graph.ts';
import { extractDomain, type ConfigKey, type DbTable, type Route } from './domain.ts';
import { dot, embed, EMBED_DIM, EMBED_MODEL, fromBlob, toBlob } from './embed.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.turbo', '.cache', 'vendor']);
const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|.*\.pem|id_[a-z0-9]+|.*\.key|credentials\.json|.*secret.*\.json)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const WINDOW = 60;
const RRF_K = 60;
const VECTOR_MIN_SIM = 0.08;

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  score: number;
  why: string[];
  preview: string;
}

export interface SymbolHit {
  name: string;
  qualifiedName: string;
  kind: string;
  path: string;
  line: number;
  endLine: number;
  signature: string;
  exported: boolean;
}

export interface ImpactCaller {
  path: string;
  line: number;
  caller: string;
  calls: string;
  depth: number;
}

export interface ImpactReport {
  target: string;
  kind: 'symbol' | 'file' | 'unknown';
  definitions: SymbolHit[];
  callers: ImpactCaller[];
  /** Files that may need changes or re-verification, most direct first (excludes the definition files). */
  affectedFiles: string[];
  tests: string[];
  precision: 'heuristic' | 'precise';
}

export interface PlanImpactReport {
  changedFiles: string[];
  changedSymbols: string[];
  directDependents: string[];
  transitiveDependents: { depth: number; count: number; top: string[] };
  coveringTests: string[];
  uncoveredChangedFiles: string[];
  /** Dependent files (depth ≤ 2) that the plan does not list; candidates the plan may have missed. */
  dependentsNotInPlan: string[];
  riskScore: number;
  riskTerms: Array<{ term: string; value: number; weight: number; contribution: number }>;
  precision: 'heuristic';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface IndexStats {
  files: number;
  indexed: number;
  removed: number;
  unchanged: number;
  symbols: number;
  durationMs: number;
}

/**
 * Workspace index v0 (F-IDX-1, F-IDX-4 subset; §11.1–11.3, §11.6). Content-hash incremental: unchanged
 * files are skipped, changed files have their symbols, imports, and FTS5 chunks replaced in one
 * transaction. Retrieval fuses BM25 (FTS5), local-vector, symbol-name, and path retrievers with RRF(k=60) and
 * returns symbol-aligned slices with `why[]` provenance.
 */
export class WorkspaceIndex {
  private readonly db: Db;
  readonly ws: string;
  readonly root: string;
  /** New embedding rows written by this instance (dedupe check). */
  embedded = 0;

  constructor(db: Db, ws: string, root: string) {
    this.db = db;
    this.ws = ws;
    this.root = root;
  }

  generation(): number {
    return this.db.get<{ gen: number }>('SELECT gen FROM idx_generation WHERE ws = ?', this.ws)?.gen ?? 0;
  }

  /** Candidate files: `git ls-files` (respects .gitignore) when available, otherwise a filtered walk. */
  private listFiles(): string[] {
    const git = existsSync(join(this.root, '.git'))
      ? spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: this.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      : null;
    let files: string[];
    if (git && git.status === 0) files = git.stdout.split('\0').filter(Boolean);
    else {
      files = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.') && e.name !== '.github') { if (e.isDirectory() || SECRET_FILE.test(e.name)) continue; }
          if (SKIP_DIRS.has(e.name)) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) files.push(relative(this.root, p));
          if (files.length > 50_000) return;
        }
      };
      walk(this.root);
    }
    return this.indexable(files);
  }

  /** Drops skip-dirs, secret files, unknown languages, and `.helixignore` paths (FR-11). */
  private indexable(files: string[]): string[] {
    const ignore = HelixIgnore.load(this.root);
    return files.filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)) && !SECRET_FILE.test(f) && langOf(f) !== null && !ignore.ignores(f));
  }

  /** Merkle tree over the indexed files: directory path ('' is the root) → BLAKE3 hash. */
  merkle(): Map<string, string> {
    return merkleTree(this.db.all<{ path: string; hash: string }>('SELECT path, hash FROM idx_files WHERE ws = ?', this.ws));
  }

  merkleRoot(): string {
    return this.merkle().get('') ?? '';
  }

  /**
   * File watcher (F-IDX-1): re-indexes only the saved paths after a short debounce. A change to `.helixignore`
   * triggers a full pass. Returns a handle whose `close()` stops watching.
   */
  watch(onUpdate?: (stats: IndexStats) => void, debounceMs = 25): { close(): void } {
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    let full = false;
    const flush = () => {
      timer = undefined;
      const paths = [...pending];
      pending.clear();
      const wasFull = full;
      full = false;
      try {
        const stats = wasFull ? this.update() : this.update(paths);
        if (stats.indexed || stats.removed) onUpdate?.(stats);
      } catch { /* a racing delete or rename is picked up by the next event */ }
    };
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(this.root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const rel = String(name).split('\\').join('/');
        if (rel === '.helixignore') full = true;
        else if (rel === '.git' || rel.startsWith('.git/') || rel.split('/').some((s) => SKIP_DIRS.has(s))) return;
        else pending.add(rel);
        timer ??= setTimeout(flush, debounceMs);
      });
    } catch {
      return { close() {} };
    }
    return { close: () => { if (timer) clearTimeout(timer); watcher.close(); } };
  }

  /** Re-indexes the workspace, or only `paths` (workspace-relative) when given. */
  update(paths?: string[]): IndexStats {
    const started = performance.now();
    const subset = paths ? new Set(paths) : null;
    const files = subset ? this.indexable([...subset]) : this.listFiles();
    const known = new Map(this.db.all<{ path: string; hash: string }>('SELECT path, hash FROM idx_files WHERE ws = ?', this.ws).map((r) => [r.path, r.hash]));
    const stats: IndexStats = { files: files.length, indexed: 0, removed: 0, unchanged: 0, symbols: 0, durationMs: 0 };
    const present = new Set<string>();
    const work: Array<{ path: string; hash: string; text: string; lang: Lang; size: number }> = [];
    for (const path of files) {
      const abs = join(this.root, path);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) continue;
      present.add(path);
      const hash = blake3Hex(buf);
      if (known.get(path) === hash) { stats.unchanged++; continue; }
      work.push({ path, hash, text: buf.toString('utf8'), lang: langOf(path)!, size: st.size });
    }
    const removed = [...known.keys()].filter((p) => !present.has(p) && (!subset || subset.has(p)));
    if (work.length || removed.length) {
      this.db.transaction(() => {
        for (const p of [...removed, ...work.map((w) => w.path)]) this.drop(p);
        for (const w of work) stats.symbols += this.add(w.path, w.hash, w.text, w.lang, w.size);
        this.db.run('INSERT INTO idx_generation (ws, gen) VALUES (?, 1) ON CONFLICT(ws) DO UPDATE SET gen = gen + 1', this.ws);
      });
    }
    stats.indexed = work.length;
    stats.removed = removed.length;
    stats.durationMs = Math.round(performance.now() - started);
    return stats;
  }

  private drop(path: string): void {
    this.db.run('DELETE FROM idx_files WHERE ws = ? AND path = ?', this.ws, path);
    this.db.run('DELETE FROM idx_symbols WHERE ws = ? AND path = ?', this.ws, path);
    this.db.run('DELETE FROM idx_imports WHERE ws = ? AND path = ?', this.ws, path);
    this.db.run('DELETE FROM idx_chunks WHERE ws = ? AND path = ?', this.ws, path);
    this.db.run('DELETE FROM idx_refs WHERE ws = ? AND path = ?', this.ws, path);
    this.db.run('DELETE FROM idx_vectors WHERE ws = ? AND path = ?', this.ws, path);
    for (const t of ['idx_routes', 'idx_tables', 'idx_config']) this.db.run(`DELETE FROM ${t} WHERE ws = ? AND path = ?`, this.ws, path);
  }

  private add(path: string, hash: string, text: string, lang: Lang, size: number): number {
    const lines = text.split('\n');
    const { symbols, imports } = extract(lang, text);
    this.db.run('INSERT INTO idx_files (ws, path, hash, lang, size, lines, is_test, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', this.ws, path, hash, lang, size, lines.length, isTestPath(path) ? 1 : 0, new Date().toISOString());
    for (const s of symbols) this.db.run('INSERT INTO idx_symbols (ws, path, kind, name, qualified_name, line, end_line, signature, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', this.ws, path, s.kind, s.name, s.qualifiedName, s.line, s.endLine, s.signature, s.exported ? 1 : 0);
    for (const r of extractRefs(lang, text, symbols)) this.db.run('INSERT INTO idx_refs (ws, path, line, name, caller) VALUES (?, ?, ?, ?, ?)', this.ws, path, r.line, r.name, r.caller);
    const domain = extractDomain(path, lang, text);
    for (const r of domain.routes) this.db.run('INSERT INTO idx_routes (ws, path, line, method, route, handler, framework) VALUES (?, ?, ?, ?, ?, ?, ?)', this.ws, path, r.line, r.method, r.path, r.handler, r.framework);
    for (const t of domain.tables) this.db.run('INSERT INTO idx_tables (ws, path, line, name, source, columns_json) VALUES (?, ?, ?, ?, ?, ?)', this.ws, path, t.line, t.name, t.source, JSON.stringify(t.columns));
    for (const c of domain.config) this.db.run('INSERT INTO idx_config (ws, path, line, key, kind) VALUES (?, ?, ?, ?, ?)', this.ws, path, c.line, c.key, c.kind);
    for (const spec of imports) this.db.run('INSERT INTO idx_imports (ws, path, spec, resolved) VALUES (?, ?, ?, ?)', this.ws, path, spec, this.resolveImport(path, spec, lang));
    // Chunks: one per top-level symbol (methods stay inside their class chunk unless the class is huge), windows for the gaps.
    const tops = symbols.filter((s) => s.kind !== 'method' || s.endLine - s.line > 80).sort((a, b) => a.line - b.line);
    const covered: Array<[number, number, string | null]> = [];
    let cursor = 1;
    for (const s of tops) {
      if (s.line < cursor) continue;
      if (s.line > cursor) covered.push([cursor, s.line - 1, null]);
      const end = Math.max(s.line, Math.min(s.endLine, s.line + 200));
      covered.push([s.line, end, s.qualifiedName]);
      cursor = end + 1;
    }
    if (cursor <= lines.length) covered.push([cursor, lines.length, null]);
    const header = `${path} ${identifierTerms(path)}`;
    for (const [a, b, sym] of covered) {
      for (let start = a; start <= b; start += WINDOW * (sym ? 4 : 1)) {
        const end = Math.min(b, start + (sym ? WINDOW * 4 : WINDOW) - 1);
        const body = lines.slice(start - 1, end).join('\n');
        if (!body.trim()) continue;
        this.db.run('INSERT INTO idx_chunks (ws, path, start_line, end_line, symbol, terms, body) VALUES (?, ?, ?, ?, ?, ?, ?)', this.ws, path, start, end, sym ?? '', `${header} ${identifierTerms(`${sym ?? ''} ${body}`)}`, body);
        this.addVector(path, start, end, sym ?? '', body);
      }
    }
    return symbols.length;
  }

  /** Content-addressed embedding: identical (symbol, body) chunks share one vector across files and workspaces. */
  private addVector(path: string, start: number, end: number, symbol: string, body: string): void {
    const text = `${symbol}\n${body}`;
    const hash = createHash('sha256').update(`${EMBED_MODEL}\0${text}`).digest('hex');
    if (!this.db.get('SELECT 1 FROM idx_embeddings WHERE hash = ?', hash)) {
      this.db.run('INSERT INTO idx_embeddings (hash, model, dim, vec) VALUES (?, ?, ?, ?)', hash, EMBED_MODEL, EMBED_DIM, toBlob(embed(`${identifierTerms(path)} ${text}`)));
      this.embedded++;
    }
    this.db.run('INSERT INTO idx_vectors (ws, path, start_line, end_line, symbol, hash) VALUES (?, ?, ?, ?, ?, ?)', this.ws, path, start, end, symbol, hash);
  }

  private resolveImport(from: string, spec: string, lang: Lang): string | null {
    if (lang === 'ts' || lang === 'js') {
      if (!spec.startsWith('.')) return null;
      const base = normalize(join(dirname(from), spec));
      const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
      for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${base}/index.ts`, `${base}/index.js`]) if (existsSync(join(this.root, c)) && statSync(join(this.root, c)).isFile()) return c;
      return null;
    }
    if (lang === 'py') {
      const p = spec.replace(/^\.+/, '').replace(/\./g, '/');
      for (const c of [`${p}.py`, `${p}/__init__.py`, join(dirname(from), `${p}.py`)]) if (p && existsSync(join(this.root, c))) return normalize(c);
    }
    return null;
  }

  findSymbol(name: string, limit = 20): SymbolHit[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT name, qualified_name, kind, path, line, end_line, signature, exported FROM idx_symbols
       WHERE ws = ? AND (name = ? OR qualified_name = ? OR name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\')
       ORDER BY (name = ? OR qualified_name = ?) DESC, exported DESC, length(name) ASC LIMIT ?`,
      this.ws, name, name, `%${name.replace(/[%_\\]/g, '\\$&')}%`, `%${name.replace(/[%_\\]/g, '\\$&')}`, name, name, limit,
    );
    return rows.map((r) => ({ name: String(r.name), qualifiedName: String(r.qualified_name), kind: String(r.kind), path: String(r.path), line: Number(r.line), endLine: Number(r.end_line), signature: String(r.signature), exported: Boolean(r.exported) }));
  }

  /** Files that import `path` (reverse import edges, depth 1). */
  dependents(path: string): string[] {
    return this.db.all<{ path: string }>('SELECT DISTINCT path FROM idx_imports WHERE ws = ? AND resolved = ?', this.ws, path).map((r) => r.path);
  }

  /**
   * Impact analysis v0 (F-IDX-3, §11.5): who calls `target` (a symbol name or a file path), transitively up
   * to `depth`, plus importing files and covering tests. Name-based call edges are narrowed to the
   * definition file and its importers for languages with resolved imports (ts/js/py).
   */
  impact(target: string, opts: { depth?: number; limit?: number } = {}): ImpactReport {
    const maxDepth = Math.min(Math.max(opts.depth ?? 2, 1), 4);
    const limit = opts.limit ?? 60;
    const isFile = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idx_files WHERE ws = ? AND path = ?', this.ws, target)!.n > 0;
    const defs = isFile
      ? this.db.all<Record<string, unknown>>(`SELECT name, qualified_name, kind, path, line, end_line, signature, exported FROM idx_symbols WHERE ws = ? AND path = ? AND kind != 'heading' AND (exported = 1 OR kind IN ('class','function')) ORDER BY line`, this.ws, target)
        .map((r) => ({ name: String(r.name), qualifiedName: String(r.qualified_name), kind: String(r.kind), path: String(r.path), line: Number(r.line), endLine: Number(r.end_line), signature: String(r.signature), exported: Boolean(r.exported) }))
      : this.findSymbol(target, 40).filter((h) => h.name === target || h.qualifiedName === target || h.qualifiedName.endsWith(`.${target}`));
    const report: ImpactReport = { target, kind: isFile ? 'file' : defs.length ? 'symbol' : 'unknown', definitions: defs, callers: [], affectedFiles: [], tests: [], precision: 'heuristic' };
    if (!defs.length && !isFile) return report;
    const langOfPath = (p: string) => this.db.get<{ lang: string }>('SELECT lang FROM idx_files WHERE ws = ? AND path = ?', this.ws, p)?.lang;
    const scopeFor = (defPath: string): Set<string> | null => ['ts', 'js', 'py'].includes(langOfPath(defPath) ?? '') ? new Set([defPath, ...this.dependents(defPath)]) : null;
    const seen = new Set<string>();
    let frontier = defs.map((d) => ({ name: d.name, path: d.path, qualified: d.qualifiedName }));
    for (let depth = 1; depth <= maxDepth && frontier.length && report.callers.length < limit; depth++) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        const scope = scopeFor(f.path);
        for (const r of this.db.all<{ path: string; line: number; caller: string }>('SELECT path, line, caller FROM idx_refs WHERE ws = ? AND name = ? ORDER BY path, line LIMIT 500', this.ws, f.name)) {
          if (scope && !scope.has(r.path)) continue;
          if (r.path === f.path && r.caller === f.qualified) continue;
          const key = `${r.path}:${r.line}:${f.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          report.callers.push({ path: r.path, line: r.line, caller: r.caller, calls: f.qualified, depth });
          if (r.caller) {
            const callerName = r.caller.split('.').at(-1)!;
            if (!next.some((n) => n.name === callerName && n.path === r.path)) next.push({ name: callerName, path: r.path, qualified: r.caller });
          }
          if (report.callers.length >= limit) break;
        }
      }
      frontier = next;
    }
    const defFiles = new Set(isFile ? [target] : defs.map((d) => d.path));
    const files = new Set<string>();
    for (const c of report.callers) files.add(c.path);
    for (const p of defFiles) for (const d of this.dependents(p)) files.add(d);
    for (const p of defFiles) files.delete(p);
    const testSet = new Set<string>();
    for (const p of [...defFiles, ...files]) {
      if (isTestPath(p)) testSet.add(p);
      for (const t of this.coveringTests(p)) testSet.add(t);
    }
    report.affectedFiles = [...files].filter((f) => !isTestPath(f));
    report.tests = [...testSet];
    return report;
  }

  /**
   * Replaces the heuristic callers of a symbol report with precise depth-1 references (F-IDX-2):
   * `refs[i]` belongs to `report.definitions[i]`; a null entry keeps that definition's heuristic callers.
   */
  withPreciseCallers(report: ImpactReport, refs: Array<Array<{ path: string; line: number; isDefinition: boolean }> | null>): ImpactReport {
    if (report.kind !== 'symbol' || !refs.some(Boolean)) return report;
    const callers: ImpactCaller[] = [];
    report.definitions.forEach((d, i) => {
      const own = refs[i];
      const calls = `${d.qualifiedName} (${d.path}:${d.line})`;
      if (!own) {
        callers.push(...report.callers.filter((c) => c.depth === 1 && c.calls === d.qualifiedName).map((c) => ({ ...c, calls })));
        return;
      }
      for (const r of own) {
        if (r.isDefinition || (r.path === d.path && r.line === d.line)) continue;
        if (callers.some((c) => c.path === r.path && c.line === r.line && c.calls === calls)) continue;
        callers.push({ path: r.path, line: r.line, caller: this.enclosing(r.path, r.line), calls, depth: 1 });
      }
    });
    const defFiles = new Set(report.definitions.map((d) => d.path));
    const files = new Set(callers.map((c) => c.path).filter((p) => !defFiles.has(p)));
    const tests = new Set<string>();
    for (const p of [...defFiles, ...files]) {
      if (isTestPath(p)) tests.add(p);
      for (const t of this.coveringTests(p)) tests.add(t);
    }
    return { ...report, callers, affectedFiles: [...files].filter((f) => !isTestPath(f)), tests: [...tests], precision: 'precise' };
  }

  /**
   * Impact Report for a plan's change set (§11.5, minimal): changed symbols, reverse-import dependents (depth 1
   * and 2), covering tests, uncovered files, and an explainable risk score
   * `1·log2(1+dependents) + 1·publicApiChange + 2·uncoveredRatio`. Paths not in the index are ignored.
   */
  planImpact(paths: string[]): PlanImpactReport {
    const changed = [...new Set(paths)].filter((p) => this.db.get('SELECT 1 AS ok FROM idx_files WHERE ws = ? AND path = ?', this.ws, p));
    const changedSet = new Set(changed);
    const changedSymbols = this.db.all<{ q: string; path: string; exported: number }>(
      `SELECT qualified_name AS q, path, exported FROM idx_symbols WHERE ws = ? AND kind != 'heading' AND (exported = 1 OR kind IN ('class','function')) AND path IN (${changed.map(() => '?').join(',') || "''"}) ORDER BY path, line`,
      this.ws, ...changed,
    );
    const direct = new Set<string>();
    for (const p of changed) for (const d of this.dependents(p)) if (!changedSet.has(d)) direct.add(d);
    const second = new Set<string>();
    for (const p of direct) for (const d of this.dependents(p)) if (!changedSet.has(d) && !direct.has(d)) second.add(d);
    const covering = new Map<string, string[]>();
    for (const p of changed) {
      if (isTestPath(p)) { covering.set(p, [p]); continue; }
      const closure = new Set([p, ...this.dependents(p)]);
      for (const d of [...closure]) for (const dd of this.dependents(d)) closure.add(dd);
      const t = new Set<string>();
      for (const c of closure) { if (isTestPath(c)) t.add(c); for (const x of this.coveringTests(c)) t.add(x); }
      covering.set(p, [...t]);
    }
    const tests = new Set<string>([...covering.values()].flat());
    for (const p of [...direct, ...second]) if (isTestPath(p)) tests.add(p);
    const nonTest = changed.filter((p) => !isTestPath(p));
    const uncovered = nonTest.filter((p) => !covering.get(p)!.length);
    const dependents = [...direct, ...second].filter((p) => !isTestPath(p));
    const terms = [
      { term: 'log2(1+dependents)', value: Math.log2(1 + dependents.length), weight: 1 },
      { term: 'publicApiChange', value: changedSymbols.some((s) => s.exported) ? 1 : 0, weight: 1 },
      { term: 'uncoveredRatio', value: nonTest.length ? uncovered.length / nonTest.length : 0, weight: 2 },
    ].map((t) => ({ ...t, value: round2(t.value), contribution: round2(t.value * t.weight) }));
    return {
      changedFiles: changed,
      changedSymbols: changedSymbols.slice(0, 40).map((s) => `${s.q} (${s.path})`),
      directDependents: [...direct].filter((p) => !isTestPath(p)),
      transitiveDependents: { depth: 2, count: dependents.length, top: dependents.slice(0, 20) },
      coveringTests: [...tests],
      uncoveredChangedFiles: uncovered,
      dependentsNotInPlan: dependents,
      riskScore: round2(terms.reduce((s, t) => s + t.contribution, 0)),
      riskTerms: terms,
      precision: 'heuristic',
    };
  }

  /** Innermost indexed symbol containing `line` ('' = top level). */
  private enclosing(path: string, line: number): string {
    return this.db.get<{ q: string }>(
      `SELECT qualified_name AS q FROM idx_symbols WHERE ws = ? AND path = ? AND kind != 'heading' AND line <= ? AND end_line >= ? ORDER BY end_line - line ASC LIMIT 1`,
      this.ws, path, line, line,
    )?.q ?? '';
  }

  /** Test files that import a file (static `tests` edges heuristic, §11.5). */
  coveringTests(path: string): string[] {
    return this.db.all<{ path: string }>('SELECT DISTINCT i.path FROM idx_imports i JOIN idx_files f ON f.ws = i.ws AND f.path = i.path WHERE i.ws = ? AND i.resolved = ? AND f.is_test = 1', this.ws, path).map((r) => r.path);
  }

  /** Hybrid retrieval: BM25 + symbol + path retrievers fused with RRF; deterministic query planning (§11.6). */
  search(query: string, opts: { limit?: number; pathPrefix?: string } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    const identifiers = [...new Set(query.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])];
    const isIdentifierQuery = identifiers.some((i) => /[a-z][A-Z]|_|\$/.test(i)) || /[.:]{1,2}\w/.test(query);
    const terms = [...new Set(identifierTerms(query).split(' ').filter((t) => t.length > 2 && !STOP.has(t)))];
    const pathSeeds = [...new Set(query.match(/[\w./-]+\.\w{1,5}/g) ?? [])];
    const lists: Array<{ name: string; weight: number; hits: Array<{ key: string; path: string; start: number; end: number; symbol: string | null; body?: string }> }> = [];
    const prefix = opts.pathPrefix ? `${opts.pathPrefix.replace(/\/$/, '')}/%` : '%';

    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      const rows = this.db.all<{ path: string; start_line: number; end_line: number; symbol: string; body: string }>(
        `SELECT path, start_line, end_line, symbol, body FROM idx_chunks WHERE idx_chunks MATCH ? AND ws = ? AND path LIKE ? ORDER BY bm25(idx_chunks, 0, 0, 0, 0, 4.0, 1.0, 1.5) LIMIT 50`,
        `{terms body symbol}: (${match})`, this.ws, prefix,
      );
      lists.push({ name: 'bm25', weight: isIdentifierQuery ? 0.8 : 1.2, hits: rows.map((r) => ({ key: `${r.path}:${r.start_line}`, path: r.path, start: Number(r.start_line), end: Number(r.end_line), symbol: r.symbol || null, body: r.body })) });
    }
    if (terms.length) {
      const q = embed(query);
      const rows = this.db.all<{ path: string; start_line: number; end_line: number; symbol: string; vec: Uint8Array }>(
        `SELECT v.path, v.start_line, v.end_line, v.symbol, e.vec FROM idx_vectors v JOIN idx_embeddings e ON e.hash = v.hash WHERE v.ws = ? AND v.path LIKE ? AND e.model = ?`, this.ws, prefix, EMBED_MODEL,
      );
      const scored = rows.map((r) => ({ r, sim: dot(q, fromBlob(r.vec)) })).filter((x) => x.sim >= VECTOR_MIN_SIM).sort((a, b) => b.sim - a.sim).slice(0, 50);
      lists.push({ name: 'vector', weight: isIdentifierQuery ? 0.5 : 1.0, hits: scored.map(({ r }) => ({ key: `${r.path}:${r.start_line}`, path: r.path, start: Number(r.start_line), end: Number(r.end_line), symbol: r.symbol || null })) });
    }
    if (identifiers.length) {
      const hits: (typeof lists)[number]['hits'] = [];
      for (const id of identifiers.slice(0, 8)) for (const s of this.findSymbol(id, 5)) if (s.path.startsWith(opts.pathPrefix ?? '')) hits.push({ key: `sym:${s.path}:${s.line}`, path: s.path, start: s.line, end: Math.min(s.endLine, s.line + 120), symbol: s.qualifiedName });
      lists.push({ name: 'symbol', weight: isIdentifierQuery ? 1.5 : 0.8, hits });
    }
    if (pathSeeds.length) {
      const hits: (typeof lists)[number]['hits'] = [];
      for (const seed of pathSeeds) for (const f of this.db.all<{ path: string; lines: number }>('SELECT path, lines FROM idx_files WHERE ws = ? AND path LIKE ? LIMIT 5', this.ws, `%${seed}`)) hits.push({ key: `path:${f.path}`, path: f.path, start: 1, end: Math.min(f.lines, 80), symbol: null });
      lists.push({ name: 'path', weight: 1.5, hits });
    }

    // RRF fusion; overlapping slices in the same file merge their scores (dedupe, §13.2 step 3).
    const fused = new Map<string, { path: string; start: number; end: number; symbol: string | null; score: number; why: Set<string>; body?: string }>();
    for (const list of lists) {
      list.hits.forEach((h, rank) => {
        const existing = [...fused.values()].find((f) => f.path === h.path && h.start <= f.end && h.end >= f.start);
        const add = list.weight / (RRF_K + rank + 1);
        if (existing) {
          existing.score += add;
          existing.why.add(list.name);
          if (h.symbol && !existing.symbol) { existing.symbol = h.symbol; existing.start = h.start; existing.end = h.end; }
        } else fused.set(h.key, { ...h, score: add, why: new Set([list.name]) });
      });
    }
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((f) => ({ path: f.path, startLine: f.start, endLine: f.end, symbol: f.symbol, score: Number(f.score.toFixed(5)), why: [...f.why], preview: this.slice(f.path, f.start, Math.min(f.end, f.start + 40)) }));
  }

  /** Domain map (§11.7): routes, DB tables, and config keys with their defining file:line. */
  domain(): { routes: Array<Route & { file: string }>; tables: Array<DbTable & { file: string }>; config: Array<ConfigKey & { file: string }> } {
    return {
      routes: this.db.all<{ path: string; line: number; method: string; route: string; handler: string; framework: string }>('SELECT path, line, method, route, handler, framework FROM idx_routes WHERE ws = ? ORDER BY route, method', this.ws)
        .map((r) => ({ file: r.path, line: Number(r.line), method: r.method, path: r.route, handler: r.handler, framework: r.framework })),
      tables: this.db.all<{ path: string; line: number; name: string; source: string; columns_json: string }>('SELECT path, line, name, source, columns_json FROM idx_tables WHERE ws = ? ORDER BY name', this.ws)
        .map((t) => ({ file: t.path, line: Number(t.line), name: t.name, source: t.source as DbTable['source'], columns: JSON.parse(t.columns_json) as string[] })),
      config: this.db.all<{ path: string; line: number; key: string; kind: string }>('SELECT path, line, key, kind FROM idx_config WHERE ws = ? ORDER BY key, path', this.ws)
        .map((c) => ({ file: c.path, line: Number(c.line), key: c.key, kind: 'env' as const })),
    };
  }

  slice(path: string, start: number, end: number): string {
    const abs = join(this.root, path);
    if (!existsSync(abs)) return '';
    return readFileSync(abs, 'utf8').split('\n').slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
  }

  /** Compact repo map: files with their exported/top-level symbols, most-imported files first. */
  repoMap(maxChars = 4000): string {
    const files = this.db.all<{ path: string; is_test: number; fan_in: number }>(
      `SELECT f.path, f.is_test, (SELECT COUNT(*) FROM idx_imports i WHERE i.ws = f.ws AND i.resolved = f.path) AS fan_in FROM idx_files f
       WHERE f.ws = ? AND f.lang NOT IN ('json','yaml','text','css','html') ORDER BY f.is_test ASC, fan_in DESC, f.path ASC LIMIT 400`, this.ws,
    );
    const out: string[] = [];
    let used = 0;
    for (const f of files) {
      const syms = this.db.all<{ kind: string; qualified_name: string }>(`SELECT kind, qualified_name FROM idx_symbols WHERE ws = ? AND path = ? AND kind != 'heading' ORDER BY line LIMIT 12`, this.ws, f.path);
      const line = `${f.path}${f.is_test ? ' [test]' : ''}${syms.length ? `: ${syms.map((s) => `${s.kind === 'function' || s.kind === 'method' ? '' : `${s.kind} `}${s.qualified_name}`).join(', ')}` : ''}`;
      if (used + line.length > maxChars) { out.push(`… ${files.length - out.length} more files`); break; }
      out.push(line);
      used += line.length + 1;
    }
    return out.join('\n');
  }

  counts(): { files: number; symbols: number; chunks: number } {
    return {
      files: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idx_files WHERE ws = ?', this.ws)!.n,
      symbols: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idx_symbols WHERE ws = ?', this.ws)!.n,
      chunks: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idx_chunks WHERE ws = ?', this.ws)!.n,
    };
  }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'but', 'fix', 'bug', 'test', 'tests', 'failing', 'make', 'should', 'when', 'into', 'all', 'any', 'can', 'its', 'has', 'have', 'does', 'how', 'where', 'what', 'which', 'pass', 'passes', 'suite', 'code']);
