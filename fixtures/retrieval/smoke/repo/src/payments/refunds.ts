export async function refundPayment(paymentId: string): Promise<boolean> {
  const response = await fetch(`https://payments.example.com/v1/charges/${paymentId}/refund`, { method: 'POST' });
  return response.ok;
}
