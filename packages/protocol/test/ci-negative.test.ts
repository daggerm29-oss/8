import { test } from 'node:test';
import assert from 'node:assert/strict';

test('R0.8 negative control: CI must reject a seeded failing assertion', () => {
  assert.fail('Intentional failure on scratch branch only; never merge this control branch.');
});
