import { createRequire } from 'node:module';

/** One file-tool operation (§16.3). Paths are absolute workspace paths already checked by `resolvePath` on the host. */
export type FileRequest =
  | { op: 'stat'; root: string; path: string }
  | { op: 'read'; root: string; path: string }
  | { op: 'write'; root: string; path: string; content: string }
  | { op: 'list'; root: string; path: string; depth: number }
  | { op: 'search'; root: string; path: string; pattern: string; glob?: string };

export interface FileStat { exists: boolean; dir: boolean; size: number }

export class FileOpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FileOpError';
    this.code = code;
  }
}

/**
 * File operations executed inside the sandbox against the sandbox's own view of the workspace (F-SBX-2, §16.3).
 * Every path is re-resolved inside the sandbox and must stay under the workspace root; reads and writes open the
 * final component with O_NOFOLLOW. A workspace symlink to a host file resolves to a path that is not mounted in
 * the sandbox, so it fails instead of reading host content. Plain CommonJS: it runs under the sandbox's Node.
 */
export const FILE_OPS_SOURCE = String.raw`
const fs = require('fs'), path = require('path'), cp = require('child_process');
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'target']);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const escape = (p) => Object.assign(new Error('path ' + p + ' is outside the workspace'), { code: 'EESCAPE' });
function within(root, p) { return p === root || p.startsWith(root + path.sep); }
function real(root, p) {
  let probe = p;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  let r;
  try { r = path.join(fs.realpathSync(probe), path.relative(probe, p)); } catch { throw escape(p); }
  if (!within(root, r)) throw escape(p);
  return r;
}
function search(root, dir, pattern, glob) {
  const args = ['--fixed-strings', '--line-number', '--no-heading', '--color=never', '--max-count=50', '--max-columns=300'];
  if (glob) args.push('--glob', glob);
  args.push('--', pattern, '.');
  try {
    return cp.execFileSync('rg', args, { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).slice(0, 100000);
  } catch (e) {
    if (e.code !== 'ENOENT') return String(e.stdout || '').slice(0, 100000);
  }
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name) || out.length >= 200) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size < 1000000) fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (l.includes(pattern)) out.push(path.relative(dir, p) + ':' + (i + 1) + ':' + l.slice(0, 300)); });
    }
  };
  walk(dir);
  return out.join('\n');
}
function helixFileOp(req) {
  const root = fs.realpathSync(req.root);
  const p = real(root, path.resolve(root, req.path));
  switch (req.op) {
    case 'stat': {
      try { const s = fs.statSync(p); return { exists: true, dir: s.isDirectory(), size: s.size }; } catch { return { exists: false, dir: false, size: 0 }; }
    }
    case 'read': {
      const fd = fs.openSync(p, fs.constants.O_RDONLY | NOFOLLOW);
      try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    }
    case 'write': {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      real(root, path.dirname(p));
      const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW, 0o644);
      try { fs.writeFileSync(fd, req.content); } finally { fs.closeSync(fd); }
      return true;
    }
    case 'list': {
      const out = [];
      const walk = (dir, level) => {
        if (out.length > 500) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (SKIP.has(e.name)) continue;
          out.push('  '.repeat(level) + e.name + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && level + 1 < req.depth) walk(path.join(dir, e.name), level + 1);
        }
      };
      walk(p, 0);
      return out;
    }
    case 'search': return search(root, p, req.pattern, req.glob);
    default: throw Object.assign(new Error('unknown file op ' + req.op), { code: 'EINVAL' });
  }
}
`;

/** Helper process: one JSON request on stdin, one `{ok, value | code, message}` JSON reply on stdout. */
export const FILE_HELPER_SOURCE = `${FILE_OPS_SOURCE}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  let out;
  try { out = { ok: true, value: helixFileOp(JSON.parse(buf)) }; } catch (e) { out = { ok: false, code: e.code || 'EIO', message: String(e.message) }; }
  process.stdout.write(JSON.stringify(out));
});
`;

let hostOp: ((req: FileRequest) => unknown) | null = null;

/** WSL only (partial isolation, R2.15): the same operations in the Engine process, with the same path checks. */
export function hostFileOp(req: FileRequest): unknown {
  hostOp ??= new Function('require', `${FILE_OPS_SOURCE}\nreturn helixFileOp;`)(createRequire(import.meta.url)) as (req: FileRequest) => unknown;
  try {
    return hostOp(req);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    throw new FileOpError(err.code ?? 'EIO', String(err.message));
  }
}
