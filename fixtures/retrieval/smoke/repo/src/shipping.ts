import type { Order } from './types';

export function quoteShipping(order: Order): number {
  const units = order.items.reduce((n, item) => n + item.quantity, 0);
  return units > 10 ? 0 : 4.99 + units * 0.75;
}
