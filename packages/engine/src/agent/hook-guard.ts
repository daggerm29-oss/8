import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Write-permission enforcement for hooks (F-AGT-5, §9.7). Hooks run inside the task sandbox, which already confines
 * them to the workspace and a private scratch directory; this guard narrows the workspace part to the hook's declared
 * `permissions.write` globs. Files are fingerprinted before the hook runs; any file the hook created, modified or
 * deleted outside its declared globs is rolled back and reported as denied. `.git` and `node_modules` are not tracked.
 */

export interface HookPermissions { write?: string[] }
export interface DeniedWrite { path: string; change: 'created' | 'modified' | 'deleted'; restored: boolean }

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILES = 50_000;
const MAX_BACKUP_BYTES = 1024 * 1024;

interface Entry { sig: string; backup?: string }
export interface Snapshot { root: string; files: Map<string, Entry>; backupDir: string }

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$(){}|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function takeSnapshot(root: string, withBackups = true): Snapshot {
  const backupDir = mkdtempSync(join(tmpdir(), 'helix-hook-guard-'));
  const files = new Map<string, Entry>();
  const walk = (dir: string, rel: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (files.size >= MAX_FILES) return;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(abs, r);
        continue;
      }
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { files.set(r, { sig: `link:${readlinkSync(abs)}` }); continue; }
      if (!st.isFile()) continue;
      const entry: Entry = { sig: `${st.size}:${st.mtimeMs}` };
      if (withBackups && st.size <= MAX_BACKUP_BYTES) {
        entry.backup = join(backupDir, String(files.size));
        copyFileSync(abs, entry.backup);
      }
      files.set(r, entry);
    }
  };
  walk(root, '');
  return { root, files, backupDir };
}

/** Compare against the snapshot, roll back every change outside `permissions.write`, and discard the snapshot. */
export function enforceWrites(snap: Snapshot, permissions: HookPermissions | undefined): DeniedWrite[] {
  const allowed = (permissions?.write ?? []).map(globToRegExp);
  const after = takeSnapshot(snap.root, false);
  const denied: DeniedWrite[] = [];
  try {
    const consider = (path: string, change: DeniedWrite['change']) => {
      if (allowed.some((re) => re.test(path))) return;
      const abs = join(snap.root, path);
      const before = snap.files.get(path);
      let restored = false;
      try {
        if (change === 'created') { rmSync(abs, { force: true }); restored = true; }
        else if (before?.backup) { mkdirSync(dirname(abs), { recursive: true }); copyFileSync(before.backup, abs); restored = true; }
      } catch { /* reported as not restored */ }
      denied.push({ path, change, restored });
    };
    for (const [path, entry] of after.files) {
      const before = snap.files.get(path);
      if (!before) consider(path, 'created');
      else if (before.sig !== entry.sig) consider(path, 'modified');
    }
    for (const path of snap.files.keys()) if (!after.files.has(path)) consider(path, 'deleted');
  } finally {
    rmSync(snap.backupDir, { recursive: true, force: true });
    rmSync(after.backupDir, { recursive: true, force: true });
  }
  return denied.sort((a, b) => a.path.localeCompare(b.path));
}
