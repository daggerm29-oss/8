import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeniedHostPath } from '../vault/vault.ts';

/** Same filters as the indexer: secrets are never listed or read through the workbench. */
export const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|.*\.pem|id_[a-z0-9]+|.*\.key|credentials\.json|.*secret.*\.json)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.turbo', '.cache', 'vendor']);
export const TREE_LIMIT = 5000;
export const READ_LIMIT = 512 * 1024;

export interface FileTree { root: string; files: string[]; truncated: boolean; source: 'git' | 'walk' }
export interface FileContent { path: string; size: number; binary: boolean; truncated: boolean; content: string }

/** Workspace file list for the Files view (F-UI-1): `git ls-files` when available, else a filtered walk. */
export function listWorkspaceFiles(root: string, limit = TREE_LIMIT): FileTree {
  const real = realpathSync(resolve(root));
  const git = existsSync(join(real, '.git'))
    ? spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: real, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : null;
  let files: string[];
  let source: FileTree['source'] = 'git';
  if (git && git.status === 0) files = git.stdout.split('\0').filter(Boolean);
  else {
    source = 'walk';
    files = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (files.length > limit) return;
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.isDirectory() && e.name !== '.github' && e.name !== '.helix')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) files.push(relative(real, p));
      }
    };
    walk(real);
  }
  files = files.filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)) && !SECRET_FILE.test(f)).sort();
  return { root: real, files: files.slice(0, limit), truncated: files.length > limit, source };
}

/** Read one workspace file, confined to the root (symlinks resolved), secrets and host denylist refused. */
export function readWorkspaceFile(root: string, path: string, limit = READ_LIMIT): FileContent {
  if (typeof path !== 'string' || !path) throw new Error('path is required');
  const base = realpathSync(resolve(root));
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  if (!existsSync(abs)) throw new Error(`no such file: ${path}`);
  const real = realpathSync(abs);
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`path '${path}' is outside the workspace`);
  const rel = relative(base, real);
  if (isDeniedHostPath(real) || SECRET_FILE.test(rel)) throw new Error(`path '${path}' is not readable (secret or denied)`);
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`'${path}' is not a file`);
  const n = Math.min(st.size, limit);
  const buf = Buffer.alloc(n);
  const fd = openSync(real, 'r');
  try { readSync(fd, buf, 0, n, 0); } finally { closeSync(fd); }
  const binary = buf.subarray(0, Math.min(n, 8000)).includes(0);
  return { path: rel, size: st.size, binary, truncated: st.size > limit, content: binary ? '' : buf.toString('utf8') };
}
