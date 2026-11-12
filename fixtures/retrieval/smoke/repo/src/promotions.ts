import { applyDiscount } from './pricing';
import type { Money, Order } from './types';

interface PromoRule {
  code: string;
  percentOff: number;
  expiresAt: number;
}

const RULES: PromoRule[] = [
  { code: 'SPRING10', percentOff: 10, expiresAt: Date.parse('2027-05-01') },
  { code: 'VIP25', percentOff: 25, expiresAt: Date.parse('2030-01-01') },
];

export function redeemPromoCode(order: Order, subtotal: Money): Money {
  const rule = RULES.find((r) => r.code === order.promoCode && r.expiresAt > Date.now());
  return rule ? applyDiscount(subtotal, rule.percentOff) : subtotal;
}
