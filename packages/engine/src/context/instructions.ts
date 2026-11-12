import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Project instructions (F-CTX-3, FR-30, §13.5). Files are read-only inputs; Helix never writes them.
 *
 * Precedence, lowest to highest (later is more specific and wins when instructions conflict):
 *   1. global:  `~/.helix/HELIX.md`
 *   2. root:    `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc|md` (imported), then `AGENTS.md`, then `HELIX.md`
 *   3. nested:  the same five kinds in each directory of the paths being edited, shallow to deep
 * Within one directory the Helix-native files outrank the imported ones, so a migrated repository can keep its
 * old files and still override them with `AGENTS.md` or `HELIX.md`. The composed text lists sources in this order.
 *
 * Cursor rules follow Cursor's own scoping: `alwaysApply: true` or no front matter applies always; `globs` apply
 * when a path being edited matches; a rule with only a description is agent-requested, so it is listed by
 * `explainInstructions` but not loaded into the static prompt block (keeps the prefix cache-stable).
 */
export const INSTRUCTION_FILES = ['AGENTS.md', 'HELIX.md'];
export const MAX_INSTRUCTION_CHARS = 12_000;

export type InstructionOrigin = 'helix' | 'agents' | 'claude' | 'cursor';
export type InstructionScope = 'user' | 'repo' | 'nested';

export const PRECEDENCE_ORDER = [
  { rank: 1, scope: 'user', files: ['~/.helix/HELIX.md'] },
  { rank: 2, scope: 'repo', files: ['CLAUDE.md', '.cursorrules', '.cursor/rules/*.mdc', 'AGENTS.md', 'HELIX.md'] },
  { rank: 3, scope: 'nested', files: ['<dir>/CLAUDE.md', '<dir>/.cursorrules', '<dir>/.cursor/rules/*.mdc', '<dir>/AGENTS.md', '<dir>/HELIX.md'] },
] as const;
export const CONFLICT_RULE = 'Sources are listed from lowest to highest precedence; when two instructions conflict, the later source wins.';

export interface InstructionSource {
  path: string;
  scope: InstructionScope;
  origin: InstructionOrigin;
  /** Position in the precedence order (0 = lowest). */
  rank: number;
  chars: number;
  truncated: boolean;
}

export interface Instructions {
  text: string;
  sources: InstructionSource[];
  warnings: string[];
}

export interface InstructionExplanation {
  conflictRule: string;
  precedence: typeof PRECEDENCE_ORDER;
  /** Every candidate file that exists, lowest to highest precedence. */
  sources: Array<{ rank: number; path: string; scope: InstructionScope; origin: InstructionOrigin; applied: boolean; reason: string }>;
  /** Paths of the applied sources in the order they appear in the prompt. */
  order: string[];
}

interface Entry {
  abs: string;
  label: string;
  scope: InstructionScope;
  origin: InstructionOrigin;
  rank: number;
  body: string;
  applies: boolean;
  reason: string;
}

interface Options { helixHome?: string; touchedPaths?: string[] }

function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const raw = readFileSync(path, 'utf8').trim();
  return raw || null;
}

function capped(text: string, budget: number): { text: string; truncated: boolean } {
  return text.length <= budget ? { text, truncated: false } : { text: `${text.slice(0, budget)}\n…[truncated]`, truncated: true };
}

/** Minimal front matter reader for `.mdc` rules: `description`, `globs` (comma list, inline array or `- item` list), `alwaysApply`. */
export function parseRule(raw: string): { body: string; hasFrontMatter: boolean; alwaysApply: boolean; globs: string[]; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { body: raw.trim(), hasFrontMatter: false, alwaysApply: false, globs: [], description: '' };
  const globs: string[] = [];
  let alwaysApply = false;
  let description = '';
  let listKey = '';
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey === 'globs') { globs.push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = kv[1];
    const value = kv[2].trim();
    if (kv[1] === 'alwaysApply') alwaysApply = value === 'true';
    else if (kv[1] === 'description') description = unquote(value);
    else if (kv[1] === 'globs' && value) globs.push(...value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean));
  }
  return { body: match[2].trim(), hasFrontMatter: true, alwaysApply, globs, description };
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); if (end > i) { re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = end; } else re += '\\{'; }
    else re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function directoryEntries(dir: string, root: string, scope: InstructionScope, rankBase: number, touched: string[]): Entry[] {
  const out: Entry[] = [];
  const rel = (p: string) => relative(root, p).split(sep).join('/');
  const rankOf = (slot: number) => rankBase * 10 + slot;
  const claude = readText(join(dir, 'CLAUDE.md'));
  if (claude) out.push({ abs: join(dir, 'CLAUDE.md'), label: rel(join(dir, 'CLAUDE.md')), scope, origin: 'claude', rank: rankOf(0), body: claude, applies: true, reason: 'imported CLAUDE.md (always applies)' });
  const legacy = readText(join(dir, '.cursorrules'));
  if (legacy) out.push({ abs: join(dir, '.cursorrules'), label: rel(join(dir, '.cursorrules')), scope, origin: 'cursor', rank: rankOf(1), body: legacy, applies: true, reason: 'imported .cursorrules (always applies)' });
  const rulesDir = join(dir, '.cursor', 'rules');
  if (existsSync(rulesDir) && statSync(rulesDir).isDirectory()) {
    const projectRelative = (p: string) => relative(dir, join(root, p)).split(sep).join('/');
    for (const name of readdirSync(rulesDir).filter((n) => /\.(mdc|md)$/.test(n)).sort()) {
      const raw = readText(join(rulesDir, name));
      if (!raw) continue;
      const rule = parseRule(raw);
      let applies = true;
      let reason = 'imported Cursor rule without front matter (always applies)';
      if (rule.hasFrontMatter && rule.alwaysApply) reason = 'imported Cursor rule, alwaysApply';
      else if (rule.hasFrontMatter && rule.globs.length) {
        const hit = touched.map(projectRelative).find((p) => rule.globs.some((g) => globToRegExp(g).test(p)));
        applies = hit !== undefined;
        reason = hit !== undefined ? `imported Cursor rule, globs matched ${hit}` : `imported Cursor rule scoped to ${rule.globs.join(', ')}; no path being edited matches`;
      } else if (rule.hasFrontMatter) { applies = false; reason = 'imported Cursor rule is agent-requested (description only); not loaded into the static prompt'; }
      if (!rule.body) continue;
      out.push({ abs: join(rulesDir, name), label: rel(join(rulesDir, name)), scope, origin: 'cursor', rank: rankOf(2), body: rule.body, applies, reason });
    }
  }
  const agents = readText(join(dir, 'AGENTS.md'));
  if (agents) out.push({ abs: join(dir, 'AGENTS.md'), label: rel(join(dir, 'AGENTS.md')), scope, origin: 'agents', rank: rankOf(3), body: agents, applies: true, reason: 'AGENTS.md (always applies)' });
  const helix = readText(join(dir, 'HELIX.md'));
  if (helix) out.push({ abs: join(dir, 'HELIX.md'), label: rel(join(dir, 'HELIX.md')), scope, origin: 'helix', rank: rankOf(4), body: helix, applies: true, reason: 'HELIX.md (always applies)' });
  return out;
}

function discover(root: string, opts: Options): Entry[] {
  const touched = opts.touchedPaths ?? [];
  const entries: Entry[] = [];
  if (opts.helixHome) {
    const body = readText(join(opts.helixHome, 'HELIX.md'));
    if (body) entries.push({ abs: join(opts.helixHome, 'HELIX.md'), label: '~/.helix/HELIX.md', scope: 'user', origin: 'helix', rank: 0, body, applies: true, reason: 'user HELIX.md (always applies)' });
  }
  entries.push(...directoryEntries(root, root, 'repo', 1, touched));
  const nestedDirs = new Set<string>();
  for (const p of touched) {
    let dir = dirname(join(root, p));
    while (dir.startsWith(root + sep)) { nestedDirs.add(dir); dir = dirname(dir); }
  }
  [...nestedDirs].sort((a, b) => a.length - b.length || a.localeCompare(b)).forEach((dir, depth) => entries.push(...directoryEntries(dir, root, 'nested', 2 + depth, touched)));
  return entries.sort((a, b) => a.rank - b.rank);
}

/** Spends the character budget on native Helix/AGENTS files first, then on imports, and emits lowest to highest precedence. */
function resolve(root: string, opts: Options): { entries: Entry[]; kept: Map<Entry, { text: string; truncated: boolean }>; warnings: string[] } {
  const entries = discover(root, opts);
  const kept = new Map<Entry, { text: string; truncated: boolean }>();
  const warnings: string[] = [];
  let budget = MAX_INSTRUCTION_CHARS;
  const imported = (e: Entry) => e.origin === 'claude' || e.origin === 'cursor';
  for (const e of [...entries.filter((x) => !imported(x)), ...entries.filter(imported)]) {
    if (!e.applies) continue;
    if (budget <= 200) { e.applies = false; e.reason = `${e.reason}; omitted because the instruction budget is used up`; continue; }
    const c = capped(e.body, budget);
    budget -= c.text.length;
    kept.set(e, c);
    if (c.truncated) warnings.push(`${e.label} exceeds the instruction budget and was truncated; split it into nested files`);
  }
  return { entries, kept, warnings };
}

export function loadInstructions(root: string, opts: Options = {}): Instructions {
  const { entries, kept, warnings } = resolve(root, opts);
  const sources: InstructionSource[] = [];
  const blocks: string[] = [];
  for (const e of entries) {
    const c = kept.get(e);
    if (!c) continue;
    sources.push({ path: e.abs, scope: e.scope, origin: e.origin, rank: e.rank, chars: c.text.length, truncated: c.truncated });
    const attr = e.origin === 'claude' || e.origin === 'cursor' ? ` origin="${e.origin}"` : '';
    blocks.push(`<instructions source="${e.label}"${attr}>\n${c.text}\n</instructions>`);
  }
  return { text: blocks.join('\n\n'), sources, warnings };
}

/** `context.explain`: which instruction files exist, in precedence order, which were applied and why (FR-30). */
export function explainInstructions(root: string, opts: Options = {}): InstructionExplanation {
  const { entries } = resolve(root, opts);
  return {
    conflictRule: CONFLICT_RULE,
    precedence: PRECEDENCE_ORDER,
    sources: entries.map((e) => ({ rank: e.rank, path: e.label, scope: e.scope, origin: e.origin, applied: e.applies, reason: e.reason })),
    order: entries.filter((e) => e.applies).map((e) => e.label),
  };
}
