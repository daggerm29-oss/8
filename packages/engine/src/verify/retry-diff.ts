import { unifiedDiff, type FileDiff } from '../util/diff.ts';

/**
 * Minimal-retry check (F-AGT-3, Arch §9.5). After a gate fails, the next attempt's changes are compared with
 * the state the failing diagnostics were reported against. A hunk is "related" when it sits within
 * `LINE_WINDOW` lines of a diagnostic in the same file, or lives in a file that is a diagnostic's file or
 * its graph neighbour. Everything else is reported back so the agent can revert it.
 */
export const LINE_WINDOW = 5;

export interface DiagnosticSite {
  file?: string;
  line?: number;
}

export interface RetryHunk {
  path: string;
  startLine: number;
  endLine: number;
  related: boolean;
  reason: string;
}

export interface RetryDiffReport {
  /** False when no diagnostic names a file, so relatedness cannot be judged and nothing is flagged. */
  judged: boolean;
  files: string[];
  hunks: RetryHunk[];
  related: number;
  unrelated: number;
  /** Unified diffs (3 lines of context) of the retry, for the next prompt. */
  patches: FileDiff[];
}

const HUNK = /^@@ -(\d+),(\d+) \+\d+,\d+ @@/;

/** Old-side line ranges of each hunk in a zero-context patch. A pure insertion maps to the line it follows. */
export function hunkRanges(patch: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const line of patch.split('\n')) {
    const m = HUNK.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    out.push({ start, end: start + Math.max(Number(m[2]), 1) - 1 });
  }
  return out;
}

export function classifyRetryDiff(
  before: Map<string, string | null>,
  after: Map<string, string | null>,
  sites: DiagnosticSite[],
  neighbours: Set<string>,
): RetryDiffReport {
  const judged = sites.some((s) => s.file);
  const diagnosticFiles = new Set(sites.flatMap((s) => (s.file ? [s.file] : [])));
  const hunks: RetryHunk[] = [];
  const patches: FileDiff[] = [];
  const files: string[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(path) ?? null;
    const a = after.get(path) ?? null;
    if (b === a) continue;
    files.push(path);
    patches.push(unifiedDiff(path, b, a));
    const ranges = hunkRanges(unifiedDiff(path, b, a, 0).patch);
    const lines = sites.filter((s) => s.file === path && s.line !== undefined).map((s) => s.line!);
    const fileLevel = sites.some((s) => s.file === path && s.line === undefined);
    for (const r of ranges.length ? ranges : [{ start: 1, end: 1 }]) {
      let related = !judged;
      let reason = judged ? 'unrelated to the reported diagnostics' : 'no diagnostic location to compare against';
      if (judged) {
        if (lines.some((l) => l >= r.start - LINE_WINDOW && l <= r.end + LINE_WINDOW)) { related = true; reason = 'near a reported diagnostic'; }
        else if (fileLevel) { related = true; reason = 'file-level diagnostic'; }
        else if (!diagnosticFiles.has(path) && neighbours.has(path)) { related = true; reason = 'graph neighbour of a diagnostic file'; }
      }
      hunks.push({ path, startLine: r.start, endLine: r.end, related, reason });
    }
  }
  const related = hunks.filter((h) => h.related).length;
  return { judged, files, hunks, related, unrelated: hunks.length - related, patches };
}

/** Text appended to the retry prompt when the previous retry touched lines the diagnostics do not justify. */
export function minimalityNote(report: RetryDiffReport): string {
  const bad = report.hunks.filter((h) => !h.related);
  if (!report.judged || !bad.length) return '';
  const where = bad.map((h) => `${h.path}:${h.startLine}${h.endLine > h.startLine ? `-${h.endLine}` : ''}`).join(', ');
  return `[minimality] Your last attempt also changed lines that the reported diagnostics do not justify (${where}). Revert those edits unless they are required; each retry should change only what the diagnostics point to.`;
}

/** Bounded patch text for the prompt: whole files while they fit, then a count of what was left out. */
export function patchesForPrompt(patches: FileDiff[], maxChars = 3500): string {
  const parts: string[] = [];
  let used = 0;
  for (const p of patches) {
    if (!p.patch) continue;
    if (used + p.patch.length > maxChars) {
      parts.push(`(+ ${patches.length - parts.length} more changed file(s) not shown)`);
      break;
    }
    parts.push(p.patch.trimEnd());
    used += p.patch.length;
  }
  return parts.join('\n');
}
