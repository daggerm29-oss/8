import type { WorkspaceIndex } from '../index/index.ts';
import type { Instructions } from './instructions.ts';

/**
 * Budgeted context assembler v0 (F-CTX-1, §13.1–13.2). Builds the task's static/session block once at
 * task start: project instructions, a repo map, and the top retrieval slices for the goal, each kind
 * filled greedily within a quota of the overall budget, unused quota flowing to the next kind. The
 * composed block is persisted with the task so the prompt prefix stays byte-stable across turns and
 * across Engine restarts (cache-friendly, §13.2 step 5).
 */
export interface ContextItem {
  kind: 'instructions' | 'repo_map' | 'file_slice';
  ref: string;
  tokens: number;
  why: string[];
  score?: number;
}

export interface ComposedContext {
  text: string;
  items: ContextItem[];
  budgetTokens: number;
  usedTokens: number;
  warnings: string[];
}

export interface AssembleInput {
  goal: string;
  index?: WorkspaceIndex;
  instructions?: Instructions;
  /** Total tokens for the composed block (default 6000). */
  budgetTokens?: number;
}

/** Calibrated chars/token estimate for code-heavy text (§13.3); 5% safety margin applied. */
export const estimateTokens = (text: string): number => Math.ceil((text.length / 3.6) * 1.05);

const QUOTAS = { instructions: 0.3, repo_map: 0.25, file_slice: 0.45 } as const;

export function assembleContext(input: AssembleInput): ComposedContext {
  const budget = input.budgetTokens ?? 6000;
  const items: ContextItem[] = [];
  const sections: string[] = [];
  const warnings = [...(input.instructions?.warnings ?? [])];
  let carry = 0;
  let used = 0;

  const instr = input.instructions?.text ?? '';
  {
    const quota = Math.floor(budget * QUOTAS.instructions) + carry;
    const t = estimateTokens(instr);
    if (instr && t <= quota) {
      sections.push(`# Project instructions\nFollow these repository instructions; they override general defaults.\n${instr}`);
      for (const s of input.instructions!.sources) items.push({ kind: 'instructions', ref: s.path, tokens: Math.ceil(s.chars / 4), why: [s.scope] });
      used += t;
      carry = quota - t;
    } else {
      if (instr) warnings.push(`instructions (${t} tokens) exceed quota ${quota}; omitted`);
      carry = quota;
    }
  }

  if (input.index) {
    const quota = Math.floor(budget * QUOTAS.repo_map) + carry;
    const map = input.index.repoMap(quota * 4);
    const t = estimateTokens(map);
    if (map) {
      sections.push(`# Repository map (path: symbols)\n${map}`);
      items.push({ kind: 'repo_map', ref: 'index', tokens: t, why: ['index'] });
      used += t;
    }
    carry = Math.max(0, quota - t);

    const sliceQuota = Math.floor(budget * QUOTAS.file_slice) + carry;
    let sliceUsed = 0;
    const slices: string[] = [];
    for (const hit of input.index.search(input.goal, { limit: 8 })) {
      const block = `## ${hit.path}:${hit.startLine}-${hit.endLine}${hit.symbol ? ` (${hit.symbol})` : ''} [${hit.why.join('+')}]\n${hit.preview}`;
      const t2 = estimateTokens(block);
      if (sliceUsed + t2 > sliceQuota) continue;
      slices.push(block);
      sliceUsed += t2;
      items.push({ kind: 'file_slice', ref: `${hit.path}:${hit.startLine}-${hit.endLine}`, tokens: t2, why: hit.why, score: hit.score });
    }
    if (slices.length) {
      sections.push(`# Possibly relevant code (retrieved for the goal; verify before relying on it)\n${slices.join('\n\n')}`);
      used += sliceUsed;
    }
  }

  return { text: sections.join('\n\n'), items, budgetTokens: budget, usedTokens: used, warnings };
}
