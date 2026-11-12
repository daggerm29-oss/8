import { test } from 'node:test';
import { calculateSalesTax } from '../src/tax';

test('california tax', () => {
  calculateSalesTax({ id: 'o', customer: { id: 'c', email: 'a@b.c', region: 'CA' }, items: [] }, 100);
});
