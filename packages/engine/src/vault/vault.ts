import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { AuthContext } from '@helix/protocol';
import { globalRedactor } from '../util/redact.ts';
import { helixHome } from '../util/log.ts';
import { NoKeychain, type Keychain } from './keychain.ts';

/**
 * Host paths the Engine never reads on behalf of tools (§25.5), explicitly including the Codex
 * credential cache (§7.4, ADR-020) and Helix's own state directory.
 */
export function hostPathDenylist(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  const p = platform === 'win32' ? win32 : posix;
  const rel = [
    '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.docker', '.kube',
    '.config/gcloud', '.config/gh', '.config/google-chrome', '.config/chromium', '.mozilla', '.password-store',
    'Library/Keychains', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Cookies',
    ...(platform === 'win32' ? WINDOWS_DENY : []),
  ];
  return [...rel.map((r) => p.resolve(home, r)), p.resolve(home, helixHome())];
}

/** Windows credential stores, DPAPI master keys, and browser profiles (relative to the user profile). */
const WINDOWS_DENY = [
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
  'AppData/Roaming/Microsoft/Vault', 'AppData/Local/Microsoft/Vault', 'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Microsoft/Edge/User Data', 'AppData/Roaming/Mozilla', 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud',
];

export function isDeniedHostPath(absPath: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): boolean {
  const p = platform === 'win32' ? win32 : posix;
  const norm = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const target = norm(p.resolve(absPath));
  return hostPathDenylist(platform, home).some((d) => {
    const denied = norm(d);
    return target === denied || target.startsWith(denied + p.sep);
  });
}

interface ProviderEnv {
  keys: string[];
  baseUrl: string;
}

const PROVIDER_ENV: Record<string, ProviderEnv> = {
  gemini: { keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API'], baseUrl: 'HELIX_GEMINI_BASE_URL' },
  openai: { keys: ['OPENAI_API_KEY'], baseUrl: 'HELIX_OPENAI_BASE_URL' },
};

export type KeySource = 'env' | 'keychain' | null;

/**
 * Vault (F-AUTH-1, §8.1). Provider keys resolve from the Engine's environment first, then the OS
 * keychain. They are held in memory only, never written to Helix's own storage, never placed in a
 * sandbox environment, and every value is registered with the redactor so it cannot reach logs,
 * transcripts, or tool output. The OAuth broker is later work (IMPL-ADR-010).
 */
export class Vault {
  private readonly env: NodeJS.ProcessEnv;
  readonly keychain: Keychain;
  private readonly cache = new Map<string, string | undefined>();

  constructor(env: NodeJS.ProcessEnv = process.env, keychain: Keychain = new NoKeychain()) {
    this.env = env;
    this.keychain = keychain;
    for (const p of Object.values(PROVIDER_ENV)) for (const k of p.keys) globalRedactor.register(env[k]);
  }

  private envKey(provider: string): string | undefined {
    return PROVIDER_ENV[provider]?.keys.map((k) => this.env[k]).find((v) => v && v.length > 0);
  }

  private keychainKey(provider: string): string | undefined {
    if (!this.cache.has(provider)) {
      let value: string | undefined;
      try { value = this.keychain.get(`provider:${provider}`); } catch { value = undefined; }
      globalRedactor.register(value);
      this.cache.set(provider, value);
    }
    return this.cache.get(provider);
  }

  providerAuth(provider: string): AuthContext {
    const spec = PROVIDER_ENV[provider];
    if (!spec) return {};
    const apiKey = this.envKey(provider) ?? this.keychainKey(provider);
    const baseUrl = this.env[spec.baseUrl] || undefined;
    return { apiKey, baseUrl };
  }

  keySource(provider: string): KeySource {
    if (this.envKey(provider)) return 'env';
    return this.keychainKey(provider) ? 'keychain' : null;
  }

  status(): { keychain: Keychain['kind']; providers: Array<{ id: string; source: KeySource }> } {
    return { keychain: this.keychain.kind, providers: Object.keys(PROVIDER_ENV).map((id) => ({ id, source: this.keySource(id) })) };
  }

  setProviderKey(provider: string, key: string): void {
    if (!PROVIDER_ENV[provider]) throw new Error(`unknown provider: ${provider}`);
    const value = typeof key === 'string' ? key.trim() : '';
    if (!value) throw new Error('key must be a non-empty string');
    globalRedactor.register(value);
    this.keychain.set(`provider:${provider}`, value);
    this.cache.set(provider, value);
  }

  deleteProviderKey(provider: string): void {
    if (!PROVIDER_ENV[provider]) throw new Error(`unknown provider: ${provider}`);
    this.keychain.delete(`provider:${provider}`);
    this.cache.set(provider, undefined);
  }

  isConfigured(provider: string): boolean {
    return Boolean(this.providerAuth(provider).apiKey);
  }

  /** Names of secret-bearing environment variables that must never be forwarded to a sandbox. */
  static secretEnvNames(): string[] {
    return Object.values(PROVIDER_ENV).flatMap((p) => p.keys);
  }
}
