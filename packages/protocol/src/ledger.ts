import type { LedgerTotals } from './index.ts';
export const LEDGER_DIMENSIONS = ['agent', 'task', 'tool', 'provider', 'model'] as const;
export type LedgerDimension = typeof LEDGER_DIMENSIONS[number];
export type LedgerGroup = LedgerTotals & { key: string; unknownCostCalls: number; attributedToolTokens: number };
export type LedgerDashboard = {
  totals: LedgerTotals;
  unknownCostCalls: number;
  groups: Record<LedgerDimension, LedgerGroup[]>;
  entries: number;
};
export type TraceSpan = {
  spanId: string; traceId: string; parentSpanId?: string; name: string; durationMs: number;
  statusCode: number; statusMessage?: string; attributes: Record<string, string | number | boolean>;
  events: { name: string; timeNs: string; attributes?: Record<string, string | number | boolean> }[];
};
