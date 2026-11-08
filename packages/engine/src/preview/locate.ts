import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { WorkspaceIndex } from '../index/index.ts';
import type { ElementCard } from './browser.ts';

export interface SourceLocation {
  path: string;
  line: number;
  col?: number;
  strategy: 'attribute' | 'text';
  /** 0..1 (§18.6); below CONFIRM_BELOW the UI asks the user to confirm the file. */
  confidence: number;
  needsConfirm: boolean;
  /** Component chain from `data-helix-loc` ancestors, outermost first (`path:line`). */
  chain: string[];
}

export const CONFIRM_BELOW = 0.9;

/** `path:line[:col]` → workspace-relative location; null when the path escapes `root` or does not exist. */
export function parseLoc(root: string, loc: string): { path: string; line: number; col?: number } | null {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(loc.trim());
  if (!m) return null;
  const abs = resolve(root, m[1]);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs)) return null;
  return { path: rel.split('\\').join('/'), line: Number(m[2]), ...(m[3] ? { col: Number(m[3]) } : {}) };
}

const located = (s: SourceLocation): SourceLocation => ({ ...s, confidence: Math.round(s.confidence * 100) / 100, needsConfirm: s.confidence < CONFIRM_BELOW });

/**
 * Map an element card to source (§18.6). Strategy 1: compile-time `data-helix-loc` attribute.
 * Strategy 4 (fallback): literal text search in the index, ranked by className overlap near the match.
 */
export function mapElementToSource(card: ElementCard, index: WorkspaceIndex): SourceLocation | null {
  const root = index.root;
  const chain = card.locChain.map((l) => parseLoc(root, l)).filter((l) => l !== null).map((l) => `${l.path}:${l.line}`);
  if (card.loc) {
    const at = parseLoc(root, card.loc);
    if (at) return located({ ...at, strategy: 'attribute', confidence: card.locOnElement ? 1 : 0.9, needsConfirm: false, chain });
  }
  const needle = card.text.slice(0, 60).trim();
  if (needle.length < 3) return null;
  index.update();
  const candidates = [...new Set(index.search(needle, { limit: 30 }).map((h) => h.path))];
  const matches: Array<{ path: string; line: number; classHits: number }> = [];
  for (const path of candidates) {
    let lines: string[];
    try { lines = readFileSync(resolve(root, path), 'utf8').split('\n'); } catch { continue; }
    const i = lines.findIndex((l) => l.includes(needle));
    if (i < 0) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
    matches.push({ path, line: i + 1, classHits: card.classes.filter((c) => near.includes(c)).length });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.classHits - a.classHits);
  const best = matches[0];
  const ambiguous = matches.length > 1 && matches[1].classHits === best.classHits;
  const confidence = Math.min(0.8, 0.5 + 0.1 * Math.min(best.classHits, 3)) - (ambiguous ? 0.2 : 0);
  return located({ path: best.path, line: best.line, strategy: 'text', confidence, needsConfirm: true, chain });
}

/** Prompt context for select-and-instruct: element card + source slice (+ chain). */
export function elementContext(card: ElementCard, src: SourceLocation | null, index: WorkspaceIndex): string {
  const out = ['Selected element in the preview:',
    `- ${card.tag} role=${card.role}${card.name ? ` name="${card.name}"` : ''}${card.id ? ` id=${card.id}` : ''}`,
    `- classes: ${card.classes.join(' ') || '(none)'}`,
    `- box: ${card.box.x},${card.box.y} ${card.box.w}x${card.box.h}; style: color ${card.style.color}, background ${card.style.background}, font-size ${card.style.fontSize}, padding ${card.style.padding}, display ${card.style.display}`];
  if (!src) { out.push('- source: unknown (search for it)'); return out.join('\n'); }
  out.push(`- source: ${src.path}:${src.line} (via ${src.strategy}, confidence ${src.confidence}${src.needsConfirm ? ', unconfirmed' : ''})`);
  if (src.chain.length > 1) out.push(`- component chain: ${src.chain.join(' > ')}`);
  const slice = index.slice(src.path, Math.max(1, src.line - 5), src.line + 10);
  if (slice) out.push(`Source slice ${src.path}:`, '```', slice, '```');
  return out.join('\n');
}
