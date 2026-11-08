import { createHash } from 'node:crypto';
import { canonical } from '../replay/bundle.ts';

/**
 * Verification evidence artifact (F-UI-4, §5.6): machine-checkable assertions (what was checked,
 * expected vs actual, pass/fail) for each gate run, content-addressed by a sha256 over the canonical
 * body so it can be re-verified later and tampering is detectable.
 */

export interface Assertion {
  id: string;
  kind: 'exit_code';
  check: string;
  command: string;
  required: boolean;
  expected: number;
  actual: number | null;
  passed: boolean;
  diagnostics: number;
}

export interface VerificationEvidence {
  type: 'verification_evidence';
  attempt: number;
  passed: boolean;
  assertions: Assertion[];
  changedFiles: string[];
  hash: string;
}

export function evidenceHash(e: Omit<VerificationEvidence, 'hash'> | VerificationEvidence): string {
  const { hash: _ignored, ...body } = e as VerificationEvidence;
  return `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
}

export function buildEvidence(input: {
  attempt: number;
  passed: boolean;
  gates: Array<{ name: string; command: string; required: boolean; exitCode: number | null; passed: boolean; diagnostics: number }>;
  changedFiles: string[];
}): VerificationEvidence {
  const body: Omit<VerificationEvidence, 'hash'> = {
    type: 'verification_evidence', attempt: input.attempt, passed: input.passed, changedFiles: [...input.changedFiles].sort(),
    assertions: input.gates.map((g, i) => ({
      id: `a${i + 1}`, kind: 'exit_code', check: `gate '${g.name}' exits 0`, command: g.command, required: g.required,
      expected: 0, actual: g.exitCode, passed: g.passed, diagnostics: g.diagnostics,
    })),
  };
  return { ...body, hash: evidenceHash(body) };
}

export interface ReverifyResult {
  artifactId: string;
  hashOk: boolean;
  allPassed: boolean;
  matchesRecorded: boolean;
  assertions: Array<{ id: string; check: string; command: string; expected: number; recorded: number | null; now: number | null; passed: boolean; recordedPassed: boolean }>;
}

/** Re-run each assertion with `exec` and compare against the expected and the recorded values. */
export async function reverify(artifactId: string, e: VerificationEvidence, exec: (command: string) => Promise<{ exitCode: number | null }>): Promise<ReverifyResult> {
  const assertions: ReverifyResult['assertions'] = [];
  for (const a of e.assertions) {
    const r = await exec(a.command);
    assertions.push({ id: a.id, check: a.check, command: a.command, expected: a.expected, recorded: a.actual, now: r.exitCode, passed: r.exitCode === a.expected, recordedPassed: a.passed });
  }
  return {
    artifactId, hashOk: evidenceHash(e) === e.hash, allPassed: assertions.every((a) => a.passed),
    matchesRecorded: assertions.every((a) => a.passed === a.recordedPassed), assertions,
  };
}
