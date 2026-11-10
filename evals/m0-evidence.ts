import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LedgerTotals, ModelManifest, TaskSummary } from '../packages/protocol/src/index.ts';

export async function runCli(args: string[], home: string, timeoutMs = 180_000): Promise<{ args: string[]; code: number | null; timedOut: boolean; stderr: string; summary: (TaskSummary & { ledger: LedgerTotals }) | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../apps/cli/src/main.ts', import.meta.url)), ...args, '--json'], { env: { ...process.env, HELIX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      let summary = null;
      try { summary = JSON.parse(stdout); } catch { /* An engine/CLI error may produce no final JSON. */ }
      resolve({ args, code, timedOut, stderr, summary });
    });
  });
}

export function providerEvidence(rows: Array<Record<string, unknown>>, pricingFor: (provider: string, model: string) => ModelManifest['pricing'] | undefined) {
  return rows.filter((row) => row.status === 'ok').map((row) => {
    const raw = row.provider_usage_json ? JSON.parse(String(row.provider_usage_json)) as Record<string, any> : null;
    const pricing = pricingFor(String(row.provider), String(row.model)) ?? null;
    const tokens = !raw ? null : row.provider === 'gemini' ? {
      inputTokens: (raw.promptTokenCount ?? 0) + (raw.toolUsePromptTokenCount ?? 0),
      cachedInputTokens: raw.cachedContentTokenCount ?? 0,
      outputTokens: (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0),
      reasoningTokens: raw.thoughtsTokenCount ?? 0,
    } : row.provider === 'openai' ? {
      inputTokens: raw.input_tokens ?? 0,
      cachedInputTokens: raw.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: raw.output_tokens ?? 0,
      reasoningTokens: raw.output_tokens_details?.reasoning_tokens ?? 0,
    } : null;
    const expectedCostUsd = tokens && pricing ? ((tokens.inputTokens - tokens.cachedInputTokens) * pricing.inputPerM + tokens.cachedInputTokens * (pricing.cachedInputPerM ?? pricing.inputPerM) + tokens.outputTokens * pricing.outputPerM) / 1_000_000 : null;
    const ledger = { inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens), reasoningTokens: Number(row.reasoning_tokens), costUsd: row.cost_usd === null ? null : Number(row.cost_usd) };
    const expected = tokens ? { ...tokens, costUsd: expectedCostUsd } : null;
    const deltas = expected ? Object.fromEntries(Object.entries(expected).map(([key, value]) => {
      const actual = ledger[key as keyof typeof ledger];
      return [key, value === null || actual === null ? null : actual === value ? 0 : Math.abs(actual - value) / Math.max(Math.abs(value), 1e-12) * 100];
    })) : null;
    const pass = row.usage_source === 'provider' && expectedCostUsd !== null && ledger.costUsd !== null && deltas !== null && Object.values(deltas).every((delta) => delta !== null && delta <= 1);
    return { id: row.id, provider: row.provider, model: row.model, responseId: row.provider_response_id, rawUsage: raw, pricing, ledger, expected, deltaPct: deltas, pass };
  });
}
