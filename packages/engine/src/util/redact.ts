/**
 * Output secret scanner (§15.2 step 7, §25). Redacts known secret values registered by the vault
 * plus common credential shapes, so secrets never reach transcripts, logs, or the model.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED:google-key]'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED:github-token]'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, '[REDACTED:github-token]'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
];

export class Redactor {
  private readonly literals = new Set<string>();

  register(secret: string | undefined | null): void {
    if (secret && secret.length >= 8) this.literals.add(secret);
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const literal of this.literals) {
      if (out.includes(literal)) out = out.split(literal).join('[REDACTED:secret]');
    }
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.redactDeep(v);
      return out as T;
    }
    return value;
  }
}

export const globalRedactor = new Redactor();
