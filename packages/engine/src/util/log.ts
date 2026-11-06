import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { globalRedactor } from './redact.ts';

export function helixHome(): string {
  return process.env.HELIX_HOME ?? join(homedir(), '.helix');
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON-lines logger with secret redaction (§26.3). */
export class Logger {
  private readonly file: string | null;
  private readonly minLevel: number;
  private readonly bindings: Record<string, unknown>;
  private readonly toStderr: boolean;

  constructor(opts: { dir?: string | null; level?: LogLevel; bindings?: Record<string, unknown>; stderr?: boolean } = {}) {
    this.minLevel = LEVELS[opts.level ?? ((process.env.HELIX_LOG_LEVEL as LogLevel) || 'info')];
    this.bindings = opts.bindings ?? {};
    this.toStderr = opts.stderr ?? process.env.HELIX_LOG_STDERR === '1';
    if (opts.dir === null) {
      this.file = null;
    } else {
      const dir = opts.dir ?? join(helixHome(), 'logs');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.file = join(dir, `engine-${new Date().toISOString().slice(0, 10)}.log`);
    }
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = Object.create(this) as Logger;
    (child as unknown as { bindings: Record<string, unknown> }).bindings = { ...this.bindings, ...bindings };
    return child;
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < this.minLevel) return;
    const line = globalRedactor.redact(JSON.stringify({ at: new Date().toISOString(), level, msg, ...this.bindings, ...fields }));
    if (this.file) {
      try {
        appendFileSync(this.file, line + '\n', { mode: 0o600 });
      } catch {
        // Logging must never crash the engine.
      }
    }
    if (this.toStderr) process.stderr.write(line + '\n');
  }

  debug(msg: string, f?: Record<string, unknown>): void {
    this.log('debug', msg, f);
  }
  info(msg: string, f?: Record<string, unknown>): void {
    this.log('info', msg, f);
  }
  warn(msg: string, f?: Record<string, unknown>): void {
    this.log('warn', msg, f);
  }
  error(msg: string, f?: Record<string, unknown>): void {
    this.log('error', msg, f);
  }
}
