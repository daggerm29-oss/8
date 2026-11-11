import { LEDGER_DIMENSIONS, type LedgerDashboard, type LedgerDimension, type LedgerGroup } from '@helix/protocol';
import type { Db } from '../storage/db.ts';
import type { Ledger } from './ledger.ts';

export type LedgerFilter = { task?: string; ws?: string; since?: string };
export type LedgerRow = Record<string, string | number | null>;
export function validateLedgerFilter(filter: LedgerFilter): void {
  for (const field of ['task', 'ws', 'since'] as const) {
    const value = filter[field];
    if (value !== undefined && (typeof value !== 'string' || !value || value.length > 4096)) throw new Error(`invalid ledger ${field}`);
  }
}
export function ledgerRows(db: Db, filter: LedgerFilter = {}): LedgerRow[] {
  validateLedgerFilter(filter);
  const where: string[] = [];
  const params: string[] = [];
  for (const field of ['task', 'ws', 'since'] as const) {
    const value = filter[field];
    if (value !== undefined) {
      where.push(field === 'since' ? 'at >= ?' : `${field} = ?`); params.push(value);
    }
  }
  return db.all<LedgerRow>(`SELECT * FROM ledger_entries${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY at, id`, ...params).map((row) => ({ ...row }));
}
const zero = (key: string): LedgerGroup => ({ key, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, providerReportedCalls: 0, estimatedCalls: 0, unknownCostCalls: 0, attributedToolTokens: 0 });
function add(group: LedgerGroup, row: LedgerRow, weight = 1, toolTokens = 0) {
  group.calls += weight;
  for (const [property, column] of [['inputTokens', 'input_tokens'], ['cachedInputTokens', 'cached_input_tokens'], ['outputTokens', 'output_tokens'], ['reasoningTokens', 'reasoning_tokens'], ['costUsd', 'cost_usd']] as const) group[property] += Number(row[column] ?? 0) * weight;
  group.providerReportedCalls += row.usage_source === 'provider' ? weight : 0;
  group.estimatedCalls += row.usage_source === 'estimate' ? weight : 0;
  group.unknownCostCalls += row.cost_usd === null ? weight : 0;
  group.attributedToolTokens += toolTokens;
}
function numbers(json: string | number | null | undefined): Record<string, number> {
  const value: unknown = typeof json === 'string' ? JSON.parse(json) : {};
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0)) : {};
}
export function ledgerDashboard(db: Db, ledger: Ledger, filter: LedgerFilter = {}): LedgerDashboard {
  const rows = ledgerRows(db, filter);
  const maps = Object.fromEntries(LEDGER_DIMENSIONS.map((dimension) => [dimension, new Map<string, LedgerGroup>()])) as Record<LedgerDimension, Map<string, LedgerGroup>>;
  const get = (dimension: LedgerDimension, key: string) => {
    const map = maps[dimension];
    if (!map.has(key)) map.set(key, zero(key));
    return map.get(key)!;
  };
  for (const row of rows.filter((row) => row.status === 'ok')) {
    for (const dimension of ['agent', 'task', 'provider', 'model'] as const) add(get(dimension, String(row[dimension] ?? '(unattributed)')), row);
    const tools = Object.entries(numbers(row.tool_tokens_json));
    const toolTotal = tools.reduce((sum, [, tokens]) => sum + tokens, 0);
    const promptEstimate = Object.values(numbers(row.context_breakdown_json)).reduce((sum, tokens) => sum + tokens, 0);
    // Tool shares are prompt-attribution estimates, not extra tool charges; unattributed context retains the remainder.
    const denominator = Math.max(toolTotal, promptEstimate, Number(row.input_tokens), 1);
    for (const [name, tokens] of tools) add(get('tool', name), row, tokens / denominator, tokens);
    const remainder = 1 - toolTotal / denominator;
    if (remainder > 0) add(get('tool', '(unattributed)'), row, remainder);
  }
  return {
    totals: ledger.totals(filter), entries: rows.length,
    unknownCostCalls: rows.filter((row) => row.status === 'ok' && row.cost_usd === null).length,
    groups: Object.fromEntries(LEDGER_DIMENSIONS.map((dimension) => [dimension, [...maps[dimension].values()].sort((a, b) => a.key.localeCompare(b.key))])) as LedgerDashboard['groups'],
  };
}
export function exportLedger(db: Db, filter: LedgerFilter, format: 'json' | 'csv') {
  if (!['json', 'csv'].includes(format)) throw new Error('ledger export format must be json or csv');
  const entries = ledgerRows(db, filter);
  if (format === 'json') return { content: JSON.stringify(entries, null, 2) + '\n', mime: 'application/json', filename: 'helix-ledger.json' };
  const columns = entries.length ? Object.keys(entries[0]) : ['id', 'at', 'task', 'agent', 'provider', 'model', 'input_tokens', 'output_tokens', 'cost_usd'];
  const cell = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  // JSON-valued CSV cells preserve SQL nulls, types, embedded newlines and text beginning with spreadsheet formulas.
  const content = [columns.map(cell).join(','), ...entries.map((row) => columns.map((key) => cell(JSON.stringify(row[key] ?? null))).join(','))].join('\r\n') + '\r\n';
  return { content, mime: 'text/csv;charset=utf-8', filename: 'helix-ledger.csv' };
}
