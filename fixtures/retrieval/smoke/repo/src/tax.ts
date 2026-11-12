import type { Money, Order } from './types';

const RATES: Record<string, number> = { CA: 0.0725, NY: 0.04, TX: 0.0625 };

export function calculateSalesTax(order: Order, taxableAmount: Money): Money {
  const rate = RATES[order.customer.region] ?? 0;
  return Math.round(taxableAmount * rate * 100) / 100;
}
