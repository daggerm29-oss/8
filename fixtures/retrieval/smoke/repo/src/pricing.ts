import type { LineItem, Money } from './types';

export function computeSubtotal(items: LineItem[]): Money {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function applyDiscount(subtotal: Money, percentOff: number): Money {
  return Math.max(0, subtotal - subtotal * (percentOff / 100));
}
