import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dependency gate v0 (F-REV-3, §16.7): before a shell package install runs, resolve each requested
 * package to a version (registry metadata) and query OSV for known vulnerabilities. Vulnerable →
 * workspace policy (`.helix/deps.json` `{"onVulnerable": "deny"|"ask"|"allow"}`, default deny).
 * OSV unreachable → ask. No license, typosquat, age, or install-script checks yet.
 */

export type Ecosystem = 'npm' | 'PyPI';
export interface PackageRef { ecosystem: Ecosystem; name: string; version?: string }
export interface Vuln { id: string; summary: string; aliases: string[] }
export interface DepFinding { ecosystem: Ecosystem; name: string; version: string | null; vulns: Vuln[]; error?: string }
export interface DepDecision { verdict: 'allow' | 'ask' | 'deny'; reason: string; findings: DepFinding[] }

const NPM_INSTALL = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)(?=\s|$)(.*)$/;
const PIP_INSTALL = /(?:^|\s)(?:(?:uv\s+)?pip3?|python3?\s+-m\s+pip)\s+install(?=\s|$)(.*)$/;
/** Any other package-manager install we do not parse; fail closed (ask) rather than letting it run unchecked. */
const OTHER_INSTALL = /(?:^|\s)(?:npx|pnpx|bunx|pipx|poetry|pdm|conda|gem|cargo|go|composer)\s+(?:install|add|get)(?=\s|$)|(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:dlx|exec)(?=\s|$)/;
/** npm/pip flags that consume the next token as a value. */
const NPM_VALUE_FLAGS = new Set(['--registry', '--prefix', '--tag', '--cache', '-C', '--dir', '--filter', '-F']);
const PIP_VALUE_FLAGS = new Set(['-i', '--index-url', '--extra-index-url', '-t', '--target', '--prefix', '-f', '--find-links', '-c', '--constraint']);

export interface ParsedInstalls {
  packages: PackageRef[];
  /** Install operations that were detected but could not be resolved to checkable packages. */
  unsupported: string[];
}

/** Split a shell command into simple commands on `&&`, `||`, `;`, `|`, `&` and newlines. */
function segments(command: string): string[] {
  const noRedirects = command.replace(/\d*>&\d+|&>>?\s*\S+|\d*>>?\s*\S+|<\s*\S+/g, ' ');
  return noRedirects.split(/&&|\|\||[;|&\n]/).map((s) => s.replace(/["']/g, '').trim()).filter(Boolean);
}

function dedupe(packages: PackageRef[]): PackageRef[] {
  const seen = new Set<string>();
  return packages.filter((p) => { const k = `${p.ecosystem}:${p.name}@${p.version ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function lockedVersions(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(root, 'package-lock.json');
  if (!existsSync(file)) return out;
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    for (const [k, v] of Object.entries(lock.packages ?? {})) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
      if (m && v?.version) out.set(m[1], v.version);
    }
    for (const [k, v] of Object.entries(lock.dependencies ?? {})) if (v?.version && !out.has(k)) out.set(k, v.version);
  } catch { /* unreadable lockfile → fall back to package.json ranges */ }
  return out;
}

function manifestDeps(root: string | undefined, unsupported: string[], op: string): PackageRef[] {
  if (!root || !existsSync(join(root, 'package.json'))) { unsupported.push(`${op} (no package.json to inspect)`); return []; }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const locked = lockedVersions(root);
  return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).map(([name, range]) => {
    const v = locked.get(name) ?? /^[\^~=]?(\d+\.\d+\.\d+[\w.+-]*)$/.exec(range.trim())?.[1];
    return { ecosystem: 'npm' as const, name, ...(v ? { version: v } : {}) };
  });
}

function pipSpec(t: string): PackageRef | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:==([\w.+-]+)|(?:[<>=!~]=?[\w.*+-]+,?)*)?$/.exec(t);
  return m ? { ecosystem: 'PyPI', name: m[1], ...(m[2] ? { version: m[2] } : {}) } : null;
}

function requirementsFile(root: string | undefined, file: string, unsupported: string[], seen = new Set<string>()): PackageRef[] {
  const path = root ? join(root, file) : file;
  if (!root || !existsSync(path)) { unsupported.push(`pip install -r ${file} (file not found)`); return []; }
  if (seen.has(path)) return [];
  seen.add(path);
  const out: PackageRef[] = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').replace(/;.*$/, '').trim().replace(/\s+/g, '');
    if (!line) continue;
    const nested = /^(?:-r|--requirement)=?(.+)$/.exec(line);
    if (nested) { out.push(...requirementsFile(root, join(file, '..', nested[1]), unsupported, seen)); continue; }
    if (/^(?:-c|--constraint|-i|--index-url|--extra-index-url|-f|--find-links|--hash)/.test(line)) continue;
    const p = pipSpec(line);
    if (p) out.push(p); else unsupported.push(`requirement '${line}' in ${file}`);
  }
  return out;
}

function npmSpec(token: string): PackageRef | null {
  if (/^[./~]|^(file|git|https?|link|workspace):/.test(token)) return null;
  const at = token.lastIndexOf('@');
  const [name, range] = at > 0 ? [token.slice(0, at), token.slice(at + 1)] : [token, ''];
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name)) return null;
  const version = /^\d+\.\d+\.\d+[\w.+-]*$/.test(range) ? range : undefined;
  return { ecosystem: 'npm', name, ...(version ? { version } : {}) };
}

/**
 * Every install operation in a (possibly chained) shell command. Bare `npm install` / `npm ci` check
 * package.json deps (versions from package-lock.json when present); `pip install -r` reads the file.
 * Installs that cannot be resolved to packages are reported in `unsupported` so the gate fails closed.
 */
export function parseInstalls(command: string, root?: string): ParsedInstalls {
  const packages: PackageRef[] = [];
  const unsupported: string[] = [];
  for (const seg of segments(command)) {
    const npm = NPM_INSTALL.exec(seg);
    if (npm) {
      const tokens = npm[1].trim().split(/\s+/).filter(Boolean);
      const specs: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        if (NPM_VALUE_FLAGS.has(tokens[i])) { i++; continue; }
        if (!tokens[i].startsWith('-')) specs.push(tokens[i]);
      }
      if (!specs.length) { packages.push(...manifestDeps(root, unsupported, seg)); continue; }
      for (const s of specs) {
        const p = npmSpec(s);
        if (p) packages.push(p); else unsupported.push(`${s} (local, git or URL package)`);
      }
      continue;
    }
    const pip = PIP_INSTALL.exec(seg);
    if (pip) {
      const tokens = pip[1].trim().split(/\s+/).filter(Boolean);
      let found = false;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const req = /^(?:-r|--requirement)(?:=(.+))?$/.exec(t);
        if (req) { const file = req[1] ?? tokens[++i]; found = true; if (file) packages.push(...requirementsFile(root, file, unsupported)); else unsupported.push(seg); continue; }
        if (PIP_VALUE_FLAGS.has(t)) { i++; continue; }
        if (t === '-e' || t === '--editable') { found = true; unsupported.push(`${t} ${tokens[++i] ?? ''} (editable install)`.trim()); continue; }
        if (t.startsWith('-')) continue;
        found = true;
        const p = /[/\\:]|\.whl$|\.tar\.gz$|\.zip$/.test(t) ? null : pipSpec(t);
        if (p) packages.push(p); else unsupported.push(`${t} (local, VCS or URL package)`);
      }
      if (!found) unsupported.push(seg);
      continue;
    }
    if (OTHER_INSTALL.test(seg)) unsupported.push(seg);
  }
  return { packages: dedupe(packages), unsupported };
}

/** Packages named by an install command (see `parseInstalls`). */
export function parseInstall(command: string, root?: string): PackageRef[] {
  return parseInstalls(command, root).packages;
}

export interface DepGateOptions {
  osvUrl?: string;
  npmRegistryUrl?: string;
  pypiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class DepGate {
  private readonly cache = new Map<string, Vuln[]>();
  private readonly osv: string;
  private readonly npm: string;
  private readonly pypi: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: DepGateOptions = {}) {
    this.osv = (o.osvUrl ?? 'https://api.osv.dev').replace(/\/$/, '');
    this.npm = (o.npmRegistryUrl ?? 'https://registry.npmjs.org').replace(/\/$/, '');
    this.pypi = (o.pypiUrl ?? 'https://pypi.org').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 8000;
  }

  private async json(url: string, body?: unknown): Promise<any> {
    const res = await this.f(url, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  }

  private async resolve(p: PackageRef): Promise<string> {
    if (p.version) return p.version;
    if (p.ecosystem === 'npm') return String((await this.json(`${this.npm}/${p.name.replace('/', '%2F')}/latest`)).version);
    return String((await this.json(`${this.pypi}/pypi/${encodeURIComponent(p.name)}/json`)).info.version);
  }

  async check(packages: PackageRef[]): Promise<DepFinding[]> {
    return Promise.all(packages.map(async (p): Promise<DepFinding> => {
      let version: string | null = null;
      try {
        version = await this.resolve(p);
        const key = `${p.ecosystem}:${p.name}@${version}`;
        let vulns = this.cache.get(key);
        if (!vulns) {
          const r = await this.json(`${this.osv}/v1/query`, { package: { name: p.name, ecosystem: p.ecosystem }, version });
          vulns = ((r?.vulns ?? []) as Array<{ id: string; summary?: string; details?: string; aliases?: string[] }>).map((v) => ({ id: v.id, summary: (v.summary ?? v.details ?? '').slice(0, 160), aliases: v.aliases ?? [] }));
          this.cache.set(key, vulns);
        }
        return { ecosystem: p.ecosystem, name: p.name, version, vulns };
      } catch (error) {
        return { ecosystem: p.ecosystem, name: p.name, version, vulns: [], error: (error as Error).message };
      }
    }));
  }

  async decide(command: string, root: string): Promise<DepDecision | null> {
    const { packages, unsupported } = parseInstalls(command, root);
    if (!packages.length && !unsupported.length) return null;
    const findings = await this.check(packages);
    const onVulnerable = workspacePolicy(root);
    const vulnerable = findings.filter((f) => f.vulns.length);
    const failed = findings.filter((f) => f.error);
    if (vulnerable.length) {
      const list = vulnerable.map((f) => `${f.name}@${f.version}: ${f.vulns.map((v) => `${v.id}${v.aliases[0] ? ` (${v.aliases[0]})` : ''} ${v.summary}`.trim()).join('; ')}`).join(' | ');
      return { verdict: onVulnerable, reason: `dependency gate: known vulnerabilities (OSV) in ${list}. Pick a fixed version`, findings };
    }
    if (failed.length) return { verdict: 'ask', reason: `dependency gate: could not check ${failed.map((f) => `${f.name} (${f.error})`).join(', ')} against OSV`, findings };
    if (unsupported.length) return { verdict: 'ask', reason: `dependency gate: cannot check these installs: ${unsupported.join('; ')}`, findings };
    return { verdict: 'allow', reason: `dependency gate: no known vulnerabilities in ${findings.map((f) => `${f.name}@${f.version}`).join(', ')}`, findings };
  }
}

function workspacePolicy(root: string): 'allow' | 'ask' | 'deny' {
  const file = join(root, '.helix/deps.json');
  if (!existsSync(file)) return 'deny';
  const v = (JSON.parse(readFileSync(file, 'utf8')) as { onVulnerable?: string }).onVulnerable;
  return v === 'allow' || v === 'ask' ? v : 'deny';
}
