import type { Money } from '../types';

export function formatMoney(amount: Money): string {
  return `$${amount.toFixed(2)}`;
}
