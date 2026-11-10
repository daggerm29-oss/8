import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * `local-os` light mode (F-SBX-1, SEC-1, architecture §16.2): bubblewrap on Linux, Seatbelt (`sandbox-exec`) on macOS.
 * Faster and weaker than `local-container`: no seccomp filter, no separate rootfs image. It is only ever used for a
 * workspace the user explicitly marked trusted with light mode (`workspace.trust`); it is never auto-selected.
 */
export interface LocalOsTool {
  kind: 'bwrap' | 'seatbelt';
  exe: string;
  /** Wrapper argv that runs before the tool (Linux: `setpriv` to drop inherited ambient capabilities bwrap rejects). */
  prefix: string[];
  /** bwrap only: a fresh /proc could be mounted (otherwise /proc stays absent, like `local-unshare`). */
  proc: boolean;
}

/** Strict PATH lookup (no hidden fallback dirs), so "not on PATH" really means unavailable. */
export function which(bin: string, path = process.env.PATH ?? ''): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const dir of path.split(delimiter)) if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  return null;
}

const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];

export interface BwrapSpec {
  roPaths: string[];
  workspace: string;
  scratch: string;
  cwd: string;
  proc: boolean;
  /** `--new-session` (blocks TIOCSTI injection); off for the interactive PTY so job control keeps working. */
  newSession: boolean;
}

/**
 * bwrap flags: every namespace unshared (user, pid, net, ipc, uts, cgroup), all capabilities dropped, empty tmpfs root with
 * the toolchain read-only, the workspace read-write at its host path, a private /tmp, and nothing else (SEC-2, §25.5).
 */
export function bwrapFlags(s: BwrapSpec): string[] {
  const a = ['--unshare-all', '--die-with-parent', '--cap-drop', 'ALL', '--hostname', 'helix'];
  if (s.newSession) a.push('--new-session');
  for (const p of s.roPaths) if (existsSync(p)) a.push('--ro-bind', p, p);
  for (const l of ROOT_LINKS) {
    if (s.roPaths.includes(l)) continue;
    try {
      const st = lstatSync(l);
      if (st.isSymbolicLink()) a.push('--symlink', readlinkSync(l), l);
      else if (st.isDirectory()) a.push('--ro-bind', l, l);
    } catch { /* absent on this distro */ }
  }
  a.push('--dev', '/dev');
  if (s.proc) a.push('--proc', '/proc');
  // The tmpfs root is remounted read-only last, as in the other backends; /tmp and the workspace are separate rw mounts.
  a.push('--bind', s.scratch, '/tmp', '--bind', s.workspace, s.workspace, '--remount-ro', '/', '--chdir', s.cwd);
  return a;
}

/** Full argv (`[cmd, ...args]`) to run `bash -c <command>` under bwrap. */
export function bwrapArgv(t: LocalOsTool, s: BwrapSpec, command: string): string[] {
  return [...t.prefix, t.exe, ...bwrapFlags(s), '--', 'bash', '-c', command];
}

const sbStr = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface SeatbeltSpec {
  roPaths: string[];
  workspace: string;
  scratch: string;
}

/**
 * Seatbelt profile: deny by default; read the system toolchain, the declared read-only paths, the workspace and the
 * private scratch dir; write only the workspace and scratch; no network except loopback (the egress forwarder and
 * exposed-port bridges) and Unix sockets inside scratch. The user's home is never readable unless it contains the workspace,
 * and then only the workspace subtree.
 */
export function seatbeltProfile(s: SeatbeltSpec): string {
  const system = ['/usr', '/bin', '/sbin', '/System', '/Library', '/opt', '/private/etc', '/private/var/db/timezone', '/dev', '/etc', '/var/select', '/private/var/select'];
  const read = [...new Set([...system, ...s.roPaths])].map((p) => `(subpath ${sbStr(p)})`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm ipc-posix-sem)',
    '(allow file-read-metadata)',
    '(allow file-read-data (literal "/"))',
    `(allow file-read* ${read} (subpath ${sbStr(s.workspace)}) (subpath ${sbStr(s.scratch)}))`,
    `(allow file-write* (subpath ${sbStr(s.workspace)}) (subpath ${sbStr(s.scratch)}) (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (literal "/dev/dtracehelper"))`,
    '(allow file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    '(deny network*)',
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    `(allow network* (local unix-socket (subpath ${sbStr(s.scratch)})) (remote unix-socket (subpath ${sbStr(s.scratch)})))`,
  ].join('\n');
}

/** Full argv to run `bash -c <command>` under Seatbelt. */
export function seatbeltArgv(t: LocalOsTool, s: SeatbeltSpec, command: string): string[] {
  return [...t.prefix, t.exe, '-p', seatbeltProfile(s), '/bin/bash', '-c', command];
}

const probes = new Map<string, LocalOsTool | null>();

/** The light-mode tool for this host, or null. Cached per PATH. Probed by actually running `true` inside it. */
export function localOsTool(): LocalOsTool | null {
  const key = `${process.platform}\0${process.env.PATH ?? ''}`;
  if (probes.has(key)) return probes.get(key)!;
  let found: LocalOsTool | null = null;
  if (process.platform === 'darwin') {
    const exe = which('sandbox-exec');
    if (exe) {
      const t: LocalOsTool = { kind: 'seatbelt', exe, prefix: [], proc: false };
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'helix-sb-probe-')));
      try {
        const r = spawnSync(exe, ['-p', seatbeltProfile({ roPaths: [], workspace: scratch, scratch }), '/bin/bash', '-c', 'true'], { stdio: 'ignore', timeout: 10_000 });
        if (r.status === 0) found = t;
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
  } else if (process.platform === 'linux') {
    const exe = which('bwrap');
    if (exe) {
      const setpriv = which('setpriv');
      const prefixes: string[][] = [[]];
      if (setpriv) prefixes.push([setpriv, '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--']);
      const ws = mkdtempSync(join(tmpdir(), 'helix-bw-probe-'));
      try {
        outer: for (const prefix of prefixes) {
          for (const proc of [true, false]) {
            const argv = bwrapArgv({ kind: 'bwrap', exe, prefix, proc }, { roPaths: ['/usr', '/etc'], workspace: ws, scratch: ws, cwd: ws, proc, newSession: true }, 'test -d /usr/bin');
            const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 10_000 });
            if (r.status === 0) { found = { kind: 'bwrap', exe, prefix, proc }; break outer; }
          }
        }
      } finally { rmSync(ws, { recursive: true, force: true }); }
    }
  }
  probes.set(key, found);
  return found;
}
