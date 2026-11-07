import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GateKind = 'typecheck' | 'lint' | 'test' | 'build' | 'custom';

/** One verification gate (F-AGT-4, §9.6). Gates run in order inside the task sandbox. */
export interface Gate {
  name: string;
  kind: GateKind;
  command: string;
  /** A failing required gate fails verification; optional gates are reported only. */
  required: boolean;
  timeoutMs: number;
  /** Diagnostic parser hint passed to parseDiagnostics (defaults to the command). */
  parser?: string;
  /** Used when the command contains `{{tests}}` but change-based selection found no tests (F-TST-1). */
  fallback?: string;
  /** With a baseline run, a failure whose diagnostics all pre-date the task does not block. */
  allowPreexisting?: boolean;
}

export interface GateConfig {
  source: 'command' | 'config' | 'inferred' | 'none';
  gates: Gate[];
  /** Run the gates once before the first edit and label diagnostics as pre-existing or new. */
  baseline?: boolean;
}

export const TESTS_PLACEHOLDER = '{{tests}}';

const shellQuote = (s: string) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Expands `{{tests}}` with the change-selected test files (§9.6, F-TST-1). An empty selection runs the
 * gate's `fallback` command, or the command with the placeholder removed (full suite).
 */
export function expandGateCommand(gate: Gate, selected: string[] | null): { command: string; selectedTests: string[] | null } {
  if (!gate.command.includes(TESTS_PLACEHOLDER)) return { command: gate.command, selectedTests: null };
  if (selected?.length) return { command: gate.command.split(TESTS_PLACEHOLDER).join(selected.map(shellQuote).join(' ')), selectedTests: selected };
  if (gate.fallback) return { command: gate.fallback, selectedTests: [] };
  return { command: gate.command.split(TESTS_PLACEHOLDER).join('').replace(/[ \t]{2,}/g, ' ').trim(), selectedTests: [] };
}

/** Line-independent identity of a diagnostic, so edits that shift lines do not make old failures look new. */
export function diagnosticKey(d: { file?: string; code?: string; message: string }): string {
  const msg = d.message.replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${d.file ?? ''}|${d.code ?? ''}|${msg}`;
}

export const VERIFY_CONFIG_PATH = '.helix/verify.json';
export const AUTO_VERIFY = 'auto';
const DEFAULT_TIMEOUT_MS = 300_000;
const KINDS: GateKind[] = ['typecheck', 'lint', 'test', 'build', 'custom'];

export class GateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateConfigError';
  }
}

/** Validates `.helix/verify.json`: `{ "gates": [{ "name", "command", "kind"?, "required"?, "timeoutMs"?, "parser"? }] }`. */
export function parseGateConfig(raw: unknown): Gate[] {
  const gates = (raw as { gates?: unknown })?.gates;
  if (!Array.isArray(gates) || gates.length === 0) throw new GateConfigError(`${VERIFY_CONFIG_PATH}: "gates" must be a non-empty array`);
  const names = new Set<string>();
  return gates.map((g, i) => {
    const o = g as Record<string, unknown>;
    if (typeof o?.command !== 'string' || !o.command.trim()) throw new GateConfigError(`${VERIFY_CONFIG_PATH}: gates[${i}].command must be a non-empty string`);
    const kind = (o.kind ?? 'custom') as GateKind;
    if (!KINDS.includes(kind)) throw new GateConfigError(`${VERIFY_CONFIG_PATH}: gates[${i}].kind must be one of ${KINDS.join(', ')}`);
    const name = typeof o.name === 'string' && o.name ? o.name : `${kind}-${i + 1}`;
    if (names.has(name)) throw new GateConfigError(`${VERIFY_CONFIG_PATH}: duplicate gate name '${name}'`);
    names.add(name);
    const timeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(o.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new GateConfigError(`${VERIFY_CONFIG_PATH}: gates[${i}].timeoutMs must be in (0, 3600000]`);
    if (o.fallback !== undefined && (typeof o.fallback !== 'string' || !o.fallback.trim())) throw new GateConfigError(`${VERIFY_CONFIG_PATH}: gates[${i}].fallback must be a non-empty string`);
    return {
      name, kind, command: o.command, required: o.required !== false, timeoutMs,
      ...(typeof o.parser === 'string' ? { parser: o.parser } : {}),
      ...(typeof o.fallback === 'string' ? { fallback: o.fallback } : {}),
      ...(o.allowPreexisting === true ? { allowPreexisting: true } : {}),
    };
  });
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Infers gates from common project manifests. Lint is optional by default (pre-existing lint debt is common). */
export function inferGates(root: string): Gate[] {
  const gates: Gate[] = [];
  const add = (name: string, kind: GateKind, command: string, required = true) => gates.push({ name, kind, command, required, timeoutMs: DEFAULT_TIMEOUT_MS });
  const pkg = readJson(join(root, 'package.json'));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const tc = ['typecheck', 'type-check', 'check-types', 'tsc'].find((s) => scripts[s]);
    if (tc) add('typecheck', 'typecheck', `npm run -s ${tc}`);
    else if (existsSync(join(root, 'tsconfig.json')) && existsSync(join(root, 'node_modules/.bin/tsc'))) add('typecheck', 'typecheck', 'node_modules/.bin/tsc --noEmit');
    if (scripts.lint) add('lint', 'lint', 'npm run -s lint', false);
    if (scripts.test && !/no test specified/.test(scripts.test)) add('test', 'test', 'npm test --silent');
  }
  if (existsSync(join(root, 'go.mod'))) {
    add('vet', 'typecheck', 'go vet ./...');
    add('test', 'test', 'go test ./...');
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    add('check', 'typecheck', 'cargo check --quiet --offline');
    add('test', 'test', 'cargo test --quiet --offline');
  }
  const py = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini'].some((f) => existsSync(join(root, f)));
  if (!gates.some((g) => g.kind === 'test') && (py || existsSync(join(root, 'tests')) || readdirSync(root).some((f) => /^test_.*\.py$/.test(f)))) {
    const pytest = existsSync(join(root, 'pytest.ini')) || /\[tool\.pytest/.test(existsSync(join(root, 'pyproject.toml')) ? readFileSync(join(root, 'pyproject.toml'), 'utf8') : '');
    add('test', 'test', pytest ? 'python3 -m pytest -q' : 'python3 -m unittest -q');
  }
  return gates;
}

/**
 * Resolves the gates for a task: an explicit verify command wins, then `.helix/verify.json`, then
 * (only when the command is `auto`) gates inferred from the project manifests.
 */
export function resolveGates(root: string, verifyCommand: string | null | undefined): GateConfig {
  if (verifyCommand && verifyCommand !== AUTO_VERIFY) {
    return { source: 'command', gates: [{ name: 'verify', kind: 'test', command: verifyCommand, required: true, timeoutMs: DEFAULT_TIMEOUT_MS }] };
  }
  const cfgPath = join(root, VERIFY_CONFIG_PATH);
  if (existsSync(cfgPath)) {
    const raw = readJson(cfgPath);
    if (!raw) throw new GateConfigError(`${VERIFY_CONFIG_PATH} is not valid JSON`);
    return { source: 'config', gates: parseGateConfig(raw), ...(raw.baseline === true ? { baseline: true } : {}) };
  }
  if (verifyCommand === AUTO_VERIFY) {
    const gates = inferGates(root);
    return { source: gates.length ? 'inferred' : 'none', gates };
  }
  return { source: 'none', gates: [] };
}

export function describeGates(cfg: GateConfig): string {
  if (!cfg.gates.length) return '';
  return cfg.gates.map((g) => `\`${g.command.split(TESTS_PLACEHOLDER).join('<tests covering your changes>')}\` (${g.kind}${g.required ? '' : ', optional'})`).join(', ');
}
