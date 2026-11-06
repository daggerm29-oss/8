/**
 * Minimal unified diff (LCS over lines). Used by `checkpoint.diff` for the workbench diff view (F-UI-1).
 * Inputs above MAX_CELLS fall back to a whole-file replace hunk so the engine never does quadratic work
 * on large files; the Rust `helix-diff` addon replaces this later (§20.3).
 */
const MAX_CELLS = 4_000_000;

export interface FileDiff {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'unchanged';
  additions: number;
  deletions: number;
  patch: string;
}

function splitLines(s: string | null): string[] {
  if (s === null || s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number };

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i], a: i, b: i });
  if ((am.length + 1) * (bm.length + 1) > MAX_CELLS) {
    am.forEach((l, i) => ops.push({ t: '-', line: l, a: pre + i, b: pre }));
    bm.forEach((l, j) => ops.push({ t: '+', line: l, a: pre + am.length, b: pre + j }));
  } else {
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { ops.push({ t: ' ', line: am[i], a: pre + i, b: pre + j }); i++; j++; }
      else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { ops.push({ t: '-', line: am[i], a: pre + i, b: pre + j }); i++; }
      else { ops.push({ t: '+', line: bm[j], a: pre + i, b: pre + j }); j++; }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', line: a[a.length - suf + k], a: a.length - suf + k, b: b.length - suf + k });
  return ops;
}

export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): FileDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const status: FileDiff['status'] = before === null && after !== null ? 'added' : after === null && before !== null ? 'deleted' : before === after ? 'unchanged' : 'modified';
  const ops = status === 'unchanged' ? [] : lineOps(a, b);
  const additions = ops.filter((o) => o.t === '+').length;
  const deletions = ops.filter((o) => o.t === '-').length;
  const out: string[] = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) { k++; end = Math.min(ops.length - 1, changed[k] + context); }
    const slice = ops.slice(start, end + 1);
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    const aStart = slice[0].a + (aLen ? 1 : 0);
    const bStart = slice[0].b + (bLen ? 1 : 0);
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) out.push(o.t + o.line);
    k++;
    start = end;
  }
  return { path, status, additions, deletions, patch: changed.length ? out.join('\n') + '\n' : '' };
}
