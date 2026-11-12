import type { Customer, Money } from '../types';

export interface PaymentResult {
  paymentId: string;
  approved: boolean;
}

export async function chargeCard(customer: Customer, amount: Money): Promise<PaymentResult> {
  const response = await fetch('https://payments.example.com/v1/charges', {
    method: 'POST',
    body: JSON.stringify({ customer: customer.id, amount }),
  });
  return (await response.json()) as PaymentResult;
}
