/**
 * Diagnostic parsers (F-TRM-2, §19.4). Deterministic parsers turn tool output into structured
 * `Diagnostic[]` so the verify loop (§9.5) can feed the model precise failures instead of raw logs.
 * Each parser reports a detection confidence; all parsers that detect run and results are deduped.
 */
export interface Diagnostic {
  source: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  severity: 'error' | 'warning';
  message: string;
  /** Short excerpt (expected/actual, traceback tail) — never the whole log. */
  detail?: string;
}

export interface DiagnosticParser {
  id: string;
  detect(command: string, output: string): number;
  parse(output: string): Diagnostic[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s: string) => s.replace(ANSI, '').replace(/\r/g, '');
const rel = (p: string) => p.replace(/^file:\/\//, '').replace(/^\.\//, '');

const tsc: DiagnosticParser = {
  id: 'tsc',
  detect: (cmd, out) => (/\btsc\b/.test(cmd) ? 0.9 : /error TS\d+:/.test(out) ? 0.8 : 0),
  parse(out) {
    const res: Diagnostic[] = [];
    const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$|^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/gm;
    for (const m of out.matchAll(re)) {
      if (m[1]) res.push({ source: 'tsc', file: rel(m[1]), line: +m[2], column: +m[3], severity: m[4] as 'error', code: m[5], message: m[6] });
      else res.push({ source: 'tsc', file: rel(m[7]), line: +m[8], column: +m[9], severity: m[10] as 'error', code: m[11], message: m[12] });
    }
    return res;
  },
};

/** node:test (spec + TAP reporters), which is also what `node --test` prints for TS fixtures. */
const nodeTest: DiagnosticParser = {
  id: 'node-test',
  detect: (cmd, out) => (/node\s+(--[\w-]+\s+)*--test/.test(cmd) ? 0.9 : /^not ok \d+ - |✖ .+\(\d/m.test(out) ? 0.6 : 0),
  parse(out) {
    const res: Diagnostic[] = [];
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const tap = /^\s*not ok \d+ - (.+)$/.exec(lines[i]);
      const spec = /^\s*✖ (.+?) \(\d[\d.]*m?s\)\s*$/.exec(lines[i]);
      const name = tap?.[1] ?? spec?.[1];
      if (!name || /^(failing tests|tests\b)/i.test(name)) continue;
      const block = lines.slice(i + 1, i + 40).join('\n');
      if (spec && !/Error|assert|expected|actual/i.test(block)) continue; // summary repeat of a parent suite
      const loc = /(?:location|at\s.*?\()?['(]?((?:\/|\.\/)?[\w./@-]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)/.exec(block);
      const msg = /(?:error|message):\s*['"|]?\s*(.+)/.exec(block)?.[1] ?? /(\w*Error[^\n]*)/.exec(block)?.[1] ?? 'test failed';
      const expected = /expected:\s*(.+)/.exec(block)?.[1];
      const actual = /actual:\s*(.+)/.exec(block)?.[1];
      res.push({
        source: 'node-test', severity: 'error', message: `${name}: ${msg.trim().replace(/^['"]|['"]$/g, '')}`,
        file: loc ? rel(loc[1]) : undefined, line: loc ? +loc[2] : undefined, column: loc ? +loc[3] : undefined,
        detail: expected || actual ? `expected ${expected?.trim()} · actual ${actual?.trim()}` : undefined,
      });
    }
    return res;
  },
};

const pytest: DiagnosticParser = {
  id: 'pytest',
  detect: (cmd, out) => (/\b(pytest|unittest)\b/.test(cmd) ? 0.9 : /^(FAIL|ERROR): |^FAILED .+::/m.test(out) ? 0.7 : 0),
  parse(out) {
    const res: Diagnostic[] = [];
    for (const m of out.matchAll(/^FAILED (\S+?)::(\S+)(?: - (.+))?$/gm)) res.push({ source: 'pytest', severity: 'error', file: m[1], message: `${m[2]}: ${m[3] ?? 'failed'}` });
    // unittest blocks: "FAIL: test_x (mod.Class.test_x)" … traceback … "AssertionError: ..."
    const blocks = out.split(/^={20,}$/m);
    for (const b of blocks) {
      const head = /^(FAIL|ERROR): (\S+) \(([^)]+)\)/m.exec(b);
      if (!head) continue;
      const frames = [...b.matchAll(/File "([^"]+)", line (\d+)/g)];
      const last = frames[frames.length - 1];
      const err = /^(\w+(?:Error|Exception)\b.*)$/m.exec(b)?.[1] ?? head[1];
      res.push({ source: 'unittest', severity: 'error', file: last ? rel(last[1]) : undefined, line: last ? +last[2] : undefined, message: `${head[2]} (${head[3]}): ${err}` });
    }
    return res;
  },
};

const eslint: DiagnosticParser = {
  id: 'eslint',
  detect: (cmd) => (/\beslint\b/.test(cmd) ? 0.9 : 0),
  parse(out) {
    const res: Diagnostic[] = [];
    let file: string | undefined;
    for (const line of out.split('\n')) {
      if (/^\S.*\.\w+$/.test(line) && !line.includes(' ')) file = rel(line.trim());
      const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$/.exec(line);
      if (m && file) res.push({ source: 'eslint', file, line: +m[1], column: +m[2], severity: m[3] as 'error', message: m[4], code: m[5] });
    }
    return res;
  },
};

const go: DiagnosticParser = {
  id: 'go',
  detect: (cmd) => (/\bgo (build|test|vet)\b/.test(cmd) ? 0.9 : 0),
  parse(out) {
    const res: Diagnostic[] = [];
    for (const m of out.matchAll(/^\s*([\w./-]+\.go):(\d+)(?::(\d+))?: (.+)$/gm)) res.push({ source: 'go', severity: 'error', file: rel(m[1]), line: +m[2], column: m[3] ? +m[3] : undefined, message: m[4] });
    for (const m of out.matchAll(/^--- FAIL: (\S+)/gm)) if (!res.some((d) => d.message.includes(m[1]))) res.push({ source: 'go', severity: 'error', message: `${m[1]} failed` });
    return res;
  },
};

/** Fallback: `path:line:col: message` and Python tracebacks (§19.4 unknown output). */
const generic: DiagnosticParser = {
  id: 'generic',
  detect: () => 0.1,
  parse(out) {
    const res: Diagnostic[] = [];
    for (const m of out.matchAll(/^((?:\.{0,2}\/)?[\w./@-]+\.\w{1,5}):(\d+):(?:(\d+):)?\s*(?:(error|warning)\s*:?\s*)?(.+)$/gm)) {
      if (/^(https?|node):/.test(m[1])) continue;
      res.push({ source: 'generic', file: rel(m[1]), line: +m[2], column: m[3] ? +m[3] : undefined, severity: (m[4] as 'error') ?? 'error', message: m[5].trim() });
    }
    const tb = /Traceback \(most recent call last\):([\s\S]+?)^(\w+(?:Error|Exception)\b.*)$/m.exec(out);
    if (tb) {
      const frames = [...tb[1].matchAll(/File "([^"]+)", line (\d+)/g)];
      const last = frames[frames.length - 1];
      res.push({ source: 'python', severity: 'error', file: last ? rel(last[1]) : undefined, line: last ? +last[2] : undefined, message: tb[2] });
    }
    return res;
  },
};

export const PARSERS: DiagnosticParser[] = [tsc, nodeTest, pytest, eslint, go, generic];

/** Parse output with every parser that detects it; the generic parser only runs when nothing else matched. */
export function parseDiagnostics(command: string, rawOutput: string, opts: { root?: string; limit?: number } = {}): Diagnostic[] {
  const output = clean(rawOutput);
  const ranked = PARSERS.map((p) => ({ p, c: p.detect(command, output) })).filter((x) => x.c > 0.2).sort((a, b) => b.c - a.c);
  let out: Diagnostic[] = [];
  for (const { p } of ranked) out.push(...p.parse(output));
  if (!out.length) out = generic.parse(output);
  const seen = new Set<string>();
  const root = opts.root ? `${opts.root.replace(/\/$/, '')}/` : null;
  return out
    .map((d) => (root && d.file?.startsWith(root) ? { ...d, file: d.file.slice(root.length) } : d))
    .filter((d) => {
      if (d.file && /node_modules|node:internal|^internal\//.test(d.file)) return false;
      const k = `${d.file}:${d.line}:${d.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, opts.limit ?? 30);
}

export function formatDiagnostics(diags: Diagnostic[]): string {
  return diags
    .map((d) => `- [${d.source}${d.code ? ` ${d.code}` : ''}] ${d.file ? `${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''} ` : ''}${d.message}${d.detail ? ` (${d.detail})` : ''}`)
    .join('\n');
}
