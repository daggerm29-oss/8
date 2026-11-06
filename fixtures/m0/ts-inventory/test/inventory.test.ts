import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowStock, totalValue, type Item } from '../src/inventory.ts';

const items: Item[] = [
  { sku: 'A', price: 2, quantity: 10 },
  { sku: 'B', price: 5, quantity: 1 },
  { sku: 'C', price: 1, quantity: 3 },
];

test('totalValue sums every item', () => assert.equal(totalValue(items), 28));
test('totalValue of empty list is 0', () => assert.equal(totalValue([]), 0));
test('lowStock lists skus under the threshold', () => assert.deepEqual(lowStock(items, 5), ['B', 'C']));
