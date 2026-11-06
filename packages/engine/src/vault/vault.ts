import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { AuthContext } from '@helix/protocol';
import { globalRedactor } from '../util/redact.ts';
import { helixHome } from '../util/log.ts';

/**
 * Host paths the Engine never reads on behalf of tools (§25.5), explicitly including the Codex
 * credential cache (§7.4, ADR-020) and Helix's own state directory.
 */
export function hostPathDenylist(): string[] {
  const home = homedir();
  const rel = [
    '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.docker', '.kube',
    '.config/gcloud', '.config/gh', '.config/google-chrome', '.config/chromium', '.mozilla', '.password-store',
    'Library/Keychains', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Cookies',
  ];
  return [...rel.map((r) => resolve(home, r)), resolve(helixHome())];
}

export function isDeniedHostPath(absPath: string): boolean {
  const target = resolve(absPath);
  return hostPathDenylist().some((denied) => target === denied || target.startsWith(denied + sep));
}

interface ProviderEnv {
  keys: string[];
  baseUrl: string;
}

const PROVIDER_ENV: Record<string, ProviderEnv> = {
  gemini: { keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API'], baseUrl: 'HELIX_GEMINI_BASE_URL' },
  openai: { keys: ['OPENAI_API_KEY'], baseUrl: 'HELIX_OPENAI_BASE_URL' },
};

/**
 * Vault v0 (F-AUTH-1, §8.1). Provider keys come from the Engine's environment only and are held in
 * memory; they are never written to disk, never placed in a sandbox environment, and every value is
 * registered with the redactor so it cannot reach logs, transcripts, or tool output. OS keychain
 * storage and the OAuth broker are M1+/M2 work (IMPL-ADR-010).
 */
export class Vault {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    for (const p of Object.values(PROVIDER_ENV)) for (const k of p.keys) globalRedactor.register(env[k]);
  }

  providerAuth(provider: string): AuthContext {
    const spec = PROVIDER_ENV[provider];
    if (!spec) return {};
    const apiKey = spec.keys.map((k) => this.env[k]).find((v) => v && v.length > 0);
    const baseUrl = this.env[spec.baseUrl] || undefined;
    return { apiKey, baseUrl };
  }

  isConfigured(provider: string): boolean {
    return Boolean(this.providerAuth(provider).apiKey);
  }

  /** Names of secret-bearing environment variables that must never be forwarded to a sandbox. */
  static secretEnvNames(): string[] {
    return Object.values(PROVIDER_ENV).flatMap((p) => p.keys);
  }
}
