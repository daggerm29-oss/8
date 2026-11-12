import { test } from 'node:test';
import { checkout } from '../src/checkout';

test('checkout returns a receipt', async () => {
  await checkout({ id: 'o1', customer: { id: 'c1', email: 'a@b.c', region: 'CA' }, items: [{ sku: 'sku-1', quantity: 1, unitPrice: 10 }] });
});
