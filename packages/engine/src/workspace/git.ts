import { execFileSync } from 'node:child_process';

/** Host-side git never runs repository hooks or fsmonitor (§20.1, SEC-1). */
const SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'];

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', [...SAFE_CONFIG, ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.stdout || err.message).trim().split('\n').slice(0, 5).join('\n')}`);
  }
}

export interface GitFileStatus { path: string; index: string; worktree: string }
export interface GitStatus { isRepo: boolean; branch: string | null; head: string | null; files: GitFileStatus[] }

export function gitStatus(root: string): GitStatus {
  try { git(root, ['rev-parse', '--git-dir']); } catch { return { isRepo: false, branch: null, head: null, files: [] }; }
  const out = git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const entries = out.split('\0').filter(Boolean);
  let branch: string | null = null;
  const files: GitFileStatus[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.startsWith('## ')) { branch = e.slice(3).replace(/^No commits yet on /, '').split('...')[0]; continue; }
    files.push({ index: e[0], worktree: e[1], path: e.slice(3) });
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  let head: string | null = null;
  try { head = git(root, ['rev-parse', '--short', 'HEAD']).trim(); } catch { /* no commits yet */ }
  return { isRepo: true, branch, head, files };
}

export function gitDiff(root: string): { staged: string; unstaged: string } {
  return { staged: git(root, ['diff', '--cached', '--no-color', '--no-ext-diff']), unstaged: git(root, ['diff', '--no-color', '--no-ext-diff']) };
}

export function gitStageAll(root: string): GitStatus {
  git(root, ['add', '-A']);
  return gitStatus(root);
}

export function gitCommit(root: string, message: string): { sha: string; subject: string } {
  const msg = typeof message === 'string' ? message.trim() : '';
  if (!msg) throw new Error('commit message is required');
  if (!gitStatus(root).files.some((f) => f.index !== ' ' && f.index !== '?')) throw new Error('nothing staged to commit (use "Stage all" first)');
  git(root, ['commit', '--no-verify', '-q', '-m', msg]);
  return { sha: git(root, ['rev-parse', '--short', 'HEAD']).trim(), subject: msg.split('\n')[0] };
}
