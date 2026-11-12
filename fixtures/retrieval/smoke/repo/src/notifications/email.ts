import { formatMoney } from '../util/format';
import type { Order, Receipt } from '../types';

export function sendReceipt(order: Order, receipt: Receipt): string {
  const body = `Thanks ${order.customer.email}! You paid ${formatMoney(receipt.total)} (payment ${receipt.paymentId}).`;
  console.log(`email to ${order.customer.email}: ${body}`);
  return body;
}
