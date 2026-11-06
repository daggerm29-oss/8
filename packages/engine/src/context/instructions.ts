import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Project instructions (F-CTX-3, §13.5). Discovery order, later is more specific:
 * user `~/.helix/HELIX.md` → repo root `AGENTS.md` / `HELIX.md` → nested directory files on the
 * paths being edited. Files are read-only inputs; Helix never writes them.
 */
export const INSTRUCTION_FILES = ['AGENTS.md', 'HELIX.md'];
export const MAX_INSTRUCTION_CHARS = 12_000;

export interface InstructionSource {
  path: string;
  scope: 'user' | 'repo' | 'nested';
  chars: number;
  truncated: boolean;
}

export interface Instructions {
  text: string;
  sources: InstructionSource[];
  warnings: string[];
}

function readCapped(path: string, budget: number): { text: string; truncated: boolean } | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return null;
  if (raw.length <= budget) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, budget)}\n…[truncated]`, truncated: true };
}

export function loadInstructions(root: string, opts: { helixHome?: string; touchedPaths?: string[] } = {}): Instructions {
  const sources: InstructionSource[] = [];
  const warnings: string[] = [];
  const blocks: string[] = [];
  let budget = MAX_INSTRUCTION_CHARS;
  const add = (path: string, scope: InstructionSource['scope'], label: string) => {
    if (budget <= 200) return;
    const r = readCapped(path, budget);
    if (!r) return;
    budget -= r.text.length;
    sources.push({ path, scope, chars: r.text.length, truncated: r.truncated });
    if (r.truncated) warnings.push(`${label} exceeds the instruction budget and was truncated; split it into nested files`);
    blocks.push(`<instructions source="${label}">\n${r.text}\n</instructions>`);
  };
  if (opts.helixHome) add(join(opts.helixHome, 'HELIX.md'), 'user', '~/.helix/HELIX.md');
  for (const f of INSTRUCTION_FILES) add(join(root, f), 'repo', f);
  const nestedDirs = new Set<string>();
  for (const p of opts.touchedPaths ?? []) {
    let dir = dirname(join(root, p));
    while (dir.startsWith(root + sep)) {
      nestedDirs.add(dir);
      dir = dirname(dir);
    }
  }
  for (const dir of [...nestedDirs].sort((a, b) => a.length - b.length)) for (const f of INSTRUCTION_FILES) add(join(dir, f), 'nested', relative(root, join(dir, f)));
  return { text: blocks.join('\n\n'), sources, warnings };
}
