import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import type { Db } from '../storage/db.ts';
import { extract, identifierTerms, isTestPath, langOf, type Lang } from './extract.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.turbo', '.cache', 'vendor']);
const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|.*\.pem|id_[a-z0-9]+|.*\.key|credentials\.json|.*secret.*\.json)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const WINDOW = 60;
const RRF_K = 60;

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
 * transaction. Retrieval fuses BM25 (FTS5), symbol-name, and path retrievers with RRF(k=60) and
 * returns symbol-aligned slices with `why[]` provenance.
 */
export class WorkspaceIndex {
  private readonly db: Db;
  readonly ws: string;
  readonly root: string;

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
    return files.filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)) && !SECRET_FILE.test(f) && langOf(f) !== null);
  }

  update(): IndexStats {
    const started = performance.now();
    const files = this.listFiles();
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
      const hash = createHash('sha256').update(buf).digest('hex');
      if (known.get(path) === hash) { stats.unchanged++; continue; }
      work.push({ path, hash, text: buf.toString('utf8'), lang: langOf(path)!, size: st.size });
    }
    const removed = [...known.keys()].filter((p) => !present.has(p));
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
  }

  private add(path: string, hash: string, text: string, lang: Lang, size: number): number {
    const lines = text.split('\n');
    const { symbols, imports } = extract(lang, text);
    this.db.run('INSERT INTO idx_files (ws, path, hash, lang, size, lines, is_test, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', this.ws, path, hash, lang, size, lines.length, isTestPath(path) ? 1 : 0, new Date().toISOString());
    for (const s of symbols) this.db.run('INSERT INTO idx_symbols (ws, path, kind, name, qualified_name, line, end_line, signature, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', this.ws, path, s.kind, s.name, s.qualifiedName, s.line, s.endLine, s.signature, s.exported ? 1 : 0);
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
      }
    }
    return symbols.length;
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
