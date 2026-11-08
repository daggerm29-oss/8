/**
 * Domain extractors (F-IDX-5 minimal, §11.7): HTTP routes, DB tables, and config/env keys from source text.
 * Line-oriented heuristics per framework. Config values are never captured, only key names.
 */
import type { Lang } from './extract.ts';

export interface Route { method: string; path: string; handler: string; framework: string; line: number }
export interface DbTable { name: string; source: 'prisma' | 'drizzle' | 'sql'; columns: string[]; line: number }
export interface ConfigKey { key: string; kind: 'env'; line: number }
export interface Domain { routes: Route[]; tables: DbTable[]; config: ConfigKey[] }

const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** `app/api/users/[id]/route.ts` → `/api/users/[id]`; route groups `(x)` dropped. */
function nextRoutePath(path: string): string | null {
  const m = /(?:^|\/)(?:src\/)?app\/(.*?)(?:\/)?(route|page)\.(?:t|j)sx?$/.exec(path);
  if (!m) return null;
  return `/${m[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/')}`;
}

function routes(path: string, lang: Lang, text: string): Route[] {
  const out: Route[] = [];
  if (lang === 'ts' || lang === 'js') {
    const next = nextRoutePath(path);
    if (next && /\/route\.\w+$/.test(path)) {
      for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) out.push({ method: m[1], path: next, handler: m[1], framework: 'next', line: lineAt(text, m.index) });
    } else if (next && /export\s+default\b/.test(text)) {
      const m = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text);
      out.push({ method: 'GET', path: next, handler: m?.[1] ?? 'default', framework: 'next-page', line: m ? lineAt(text, m.index) : 1 });
    }
    for (const m of text.matchAll(/\b(app|router|server|fastify|api)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\3\s*(?:,\s*([A-Za-z_$][\w$.]*)\s*[,)])?/g)) {
      out.push({ method: m[2].toUpperCase(), path: m[4], handler: m[5] ?? '<inline>', framework: 'express', line: lineAt(text, m.index) });
    }
  }
  if (lang === 'py') {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      const fast = /^\s*@(\w+)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/.exec(l);
      const flask = /^\s*@(\w+)\.route\(\s*['"]([^'"]+)['"](?:.*methods\s*=\s*\[([^\]]*)\])?/.exec(l);
      if (!fast && !flask) return;
      const handler = lines.slice(i + 1, i + 6).map((n) => /^\s*(?:async\s+)?def\s+(\w+)/.exec(n)?.[1]).find(Boolean) ?? '<unknown>';
      if (fast) out.push({ method: fast[2].toUpperCase(), path: fast[3], handler, framework: 'fastapi', line: i + 1 });
      else for (const method of flask![3] ? [...flask![3].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase()) : ['GET']) out.push({ method, path: flask![2], handler, framework: 'flask', line: i + 1 });
    });
  }
  if (lang === 'go') {
    for (const m of text.matchAll(/\b(?:http|mux|\w+)\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"\s*,\s*([A-Za-z_][\w.]*)/g)) {
      const method = HTTP.includes(m[1]) ? m[1] : 'ANY';
      const [maybeMethod, maybePath] = m[2].includes(' ') ? m[2].split(/\s+/, 2) : [method, m[2]];
      out.push({ method: HTTP.includes(maybeMethod) ? maybeMethod : method, path: maybePath, handler: m[3], framework: HTTP.includes(m[1]) ? 'gin' : 'net/http', line: lineAt(text, m.index) });
    }
  }
  return out;
}

function sqlColumns(body: string): string[] {
  const cols: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; } else cur += ch;
  }
  cols.push(cur);
  return cols.map((c) => c.trim().split(/\s+/)[0]?.replace(/["`[\]]/g, '') ?? '').filter((c) => c && !/^(primary|foreign|constraint|unique|check|key|index)$/i.test(c));
}

function tables(path: string, lang: Lang, text: string): DbTable[] {
  const out: DbTable[] = [];
  if (path.endsWith('.prisma')) {
    for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const columns = m[2].split('\n').map((l) => /^\s*(\w+)\s+\w/.exec(l)?.[1]).filter((c): c is string => !!c);
      out.push({ name: m[1], source: 'prisma', columns, line: lineAt(text, m.index) });
    }
  }
  if (path.endsWith('.sql')) {
    for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)["`\]]?\s*\(/gi)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      for (; i < text.length && depth > 0; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
      out.push({ name: m[1], source: 'sql', columns: sqlColumns(text.slice(start, i - 1)), line: lineAt(text, m.index) });
    }
  }
  if (lang === 'ts' || lang === 'js') {
    for (const m of text.matchAll(/\b(?:pg|sqlite|mysql)Table\(\s*['"`](\w+)['"`]\s*,\s*\{([\s\S]*?)\}\s*[,)]/g)) {
      const columns = [...m[2].matchAll(/^\s*(\w+)\s*:/gm)].map((c) => c[1]);
      out.push({ name: m[1], source: 'drizzle', columns, line: lineAt(text, m.index) });
    }
  }
  return out;
}

const ENV_RES: Partial<Record<Lang, RegExp[]>> = {
  ts: [/\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g, /\bprocess\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)/g],
  py: [/\bos\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, /\bos\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /\bos\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g],
  go: [/\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g],
  rs: [/\benv::var\(\s*"([A-Z_][A-Z0-9_]*)"/g],
};
ENV_RES.js = ENV_RES.ts;

function config(lang: Lang, text: string): ConfigKey[] {
  const seen = new Map<string, ConfigKey>();
  for (const re of ENV_RES[lang] ?? []) for (const m of text.matchAll(re)) if (!seen.has(m[1])) seen.set(m[1], { key: m[1], kind: 'env', line: lineAt(text, m.index) });
  return [...seen.values()].sort((a, b) => a.line - b.line);
}

export function extractDomain(path: string, lang: Lang, text: string): Domain {
  return { routes: routes(path, lang, text), tables: tables(path, lang, text), config: config(lang, text) };
}
