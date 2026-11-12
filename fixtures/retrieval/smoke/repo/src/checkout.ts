import { reserveStock } from './inventory';
import { chargeCard } from './payments/gateway';
import { computeSubtotal } from './pricing';
import { redeemPromoCode } from './promotions';
import { quoteShipping } from './shipping';
import { calculateSalesTax } from './tax';
import { sendReceipt } from './notifications/email';
import type { Order, Receipt } from './types';

export async function checkout(order: Order): Promise<Receipt> {
  for (const item of order.items) reserveStock(item.sku, item.quantity);
  const discounted = redeemPromoCode(order, computeSubtotal(order.items));
  const total = discounted + calculateSalesTax(order, discounted) + quoteShipping(order);
  const payment = await chargeCard(order.customer, total);
  const receipt: Receipt = { orderId: order.id, total, paymentId: payment.paymentId };
  sendReceipt(order, receipt);
  return receipt;
}
