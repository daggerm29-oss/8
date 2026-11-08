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

const NPM_INSTALL = /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b([^;&|]*)/;
const PIP_INSTALL = /\bpip3?\s+install\b([^;&|]*)/;

function npmSpec(token: string): PackageRef | null {
  if (/^[./~]|^(file|git|https?|link|workspace):/.test(token)) return null;
  const at = token.lastIndexOf('@');
  const [name, range] = at > 0 ? [token.slice(0, at), token.slice(at + 1)] : [token, ''];
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name)) return null;
  const version = /^\d+\.\d+\.\d+[\w.+-]*$/.test(range) ? range : undefined;
  return { ecosystem: 'npm', name, ...(version ? { version } : {}) };
}

/** Packages named by an install command; a bare `npm install` checks package.json pinned/caret deps. */
export function parseInstall(command: string, root?: string): PackageRef[] {
  const npm = NPM_INSTALL.exec(command);
  if (npm) {
    const tokens = npm[3].trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
    if (tokens.length) return tokens.map(npmSpec).filter((p): p is PackageRef => p !== null);
    if (!root || !existsSync(join(root, 'package.json'))) return [];
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).map(([name, range]) => {
      const v = /^[\^~=]?(\d+\.\d+\.\d+[\w.+-]*)$/.exec(range.trim())?.[1];
      return { ecosystem: 'npm' as const, name, ...(v ? { version: v } : {}) };
    });
  }
  const pip = PIP_INSTALL.exec(command);
  if (pip) {
    return pip[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-') && !/[/\\]|\.txt$|\.whl$/.test(t)).flatMap((t) => {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:==([\w.+-]+))?$/.exec(t);
      return m ? [{ ecosystem: 'PyPI' as const, name: m[1], ...(m[2] ? { version: m[2] } : {}) }] : [];
    });
  }
  return [];
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
    const packages = parseInstall(command, root);
    if (!packages.length) return null;
    const findings = await this.check(packages);
    const onVulnerable = workspacePolicy(root);
    const vulnerable = findings.filter((f) => f.vulns.length);
    const failed = findings.filter((f) => f.error);
    if (vulnerable.length) {
      const list = vulnerable.map((f) => `${f.name}@${f.version}: ${f.vulns.map((v) => `${v.id}${v.aliases[0] ? ` (${v.aliases[0]})` : ''} ${v.summary}`.trim()).join('; ')}`).join(' | ');
      return { verdict: onVulnerable, reason: `dependency gate: known vulnerabilities (OSV) in ${list}. Pick a fixed version`, findings };
    }
    if (failed.length) return { verdict: 'ask', reason: `dependency gate: could not check ${failed.map((f) => `${f.name} (${f.error})`).join(', ')} against OSV`, findings };
    return { verdict: 'allow', reason: `dependency gate: no known vulnerabilities in ${findings.map((f) => `${f.name}@${f.version}`).join(', ')}`, findings };
  }
}

function workspacePolicy(root: string): 'allow' | 'ask' | 'deny' {
  const file = join(root, '.helix/deps.json');
  if (!existsSync(file)) return 'deny';
  const v = (JSON.parse(readFileSync(file, 'utf8')) as { onVulnerable?: string }).onVulnerable;
  return v === 'allow' || v === 'ask' ? v : 'deny';
}
