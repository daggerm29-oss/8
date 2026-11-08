import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { LocalSandbox } from '../sandbox/sandbox.ts';
import { prefixedId } from '../util/ids.ts';

export interface PreciseTarget { path: string; line: number; name: string }
export interface PreciseRef { path: string; line: number; isDefinition: boolean }

/**
 * Runs inside the sandbox (F-IDX-2 tier 2, §11.4): a TypeScript language service over the workspace project
 * (tsconfig.json at the root, else every TS/JS file) answers `findReferences` for each target definition.
 * Input/output travel through env and stdout so nothing is written into the workspace.
 */
const SCRIPT = String.raw`
const fs = require('fs'), path = require('path');
const A = JSON.parse(process.env.HELIX_PRECISE_ARGS);
const ts = require(A.ts);
const root = process.cwd();
let files = [], options = { allowJs: true, noEmit: true };
const cfg = path.join(root, 'tsconfig.json');
if (fs.existsSync(cfg)) {
  const p = ts.parseJsonConfigFileContent(ts.readConfigFile(cfg, ts.sys.readFile).config, ts.sys, root);
  files = p.fileNames; options = { ...p.options, allowJs: p.options.allowJs ?? true, noEmit: true };
} else {
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (/\.(c|m)?(t|j)sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(f);
  } };
  walk(root);
}
const host = {
  getScriptFileNames: () => files, getScriptVersion: () => '1', getCurrentDirectory: () => root, getCompilationSettings: () => options,
  getScriptSnapshot: (f) => ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)) : undefined,
  getDefaultLibFileName: ts.getDefaultLibFilePath, fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
const out = [];
for (const t of A.targets) {
  const file = path.join(root, t.path);
  const sf = ls.getProgram().getSourceFile(file);
  if (!sf) { out.push(null); continue; }
  const lineStart = sf.getPositionOfLineAndCharacter(t.line - 1, 0);
  const lineText = sf.text.slice(lineStart, sf.text.indexOf('\n', lineStart) === -1 ? undefined : sf.text.indexOf('\n', lineStart));
  const m = new RegExp('(?<![\\w$])' + t.name.replace(/[$]/g, '\\$') + '(?![\\w$])').exec(lineText);
  if (!m) { out.push(null); continue; }
  const refs = [];
  for (const group of ls.findReferences(file, lineStart + m.index) ?? []) for (const r of group.references) {
    const rel = path.relative(root, r.fileName);
    if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules')) continue;
    const rsf = ls.getProgram().getSourceFile(r.fileName);
    refs.push({ path: rel.split(path.sep).join('/'), line: rsf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1, isDefinition: !!r.isDefinition });
  }
  out.push(refs);
}
process.stdout.write(JSON.stringify(out));
`;

/** The workspace's own TypeScript when installed, else the one the Engine can resolve; null = no precise tier. */
export function typescriptFor(root: string): string | null {
  const local = join(root, 'node_modules', 'typescript', 'lib', 'typescript.js');
  if (existsSync(local)) return local;
  try {
    return createRequire(import.meta.url).resolve('typescript');
  } catch {
    return null;
  }
}

/**
 * Precise references for TS/JS definitions via a language service in a fresh contained sandbox (no network;
 * the Engine-resolved TypeScript package is bind-mounted read-only). Returns null per target that could not
 * be resolved, or null overall when no TypeScript is available or the process fails.
 */
export async function preciseReferences(root: string, targets: PreciseTarget[], opts: { timeoutMs?: number; forceProcess?: boolean } = {}): Promise<Array<PreciseRef[] | null> | null> {
  if (!targets.length) return [];
  const ts = typescriptFor(root);
  if (!ts) return null;
  const pkgDir = dirname(dirname(ts));
  const sandbox = new LocalSandbox(prefixedId('sbx'), root, { forceProcess: opts.forceProcess, roPaths: pkgDir.startsWith(root + '/') ? [] : [pkgDir] });
  try {
    const r = await sandbox.exec('node -e "eval(process.env.HELIX_PRECISE_SCRIPT)"', {
      timeoutMs: opts.timeoutMs ?? 60_000, maxOutputBytes: 4 * 1024 * 1024,
      env: { HELIX_PRECISE_SCRIPT: SCRIPT, HELIX_PRECISE_ARGS: JSON.stringify({ ts, targets }) },
    });
    if (r.exitCode !== 0 || r.truncated) return null;
    return JSON.parse(r.stdout) as Array<PreciseRef[] | null>;
  } catch {
    return null;
  } finally {
    sandbox.destroy();
  }
}
