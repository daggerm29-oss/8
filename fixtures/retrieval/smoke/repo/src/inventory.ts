const stock = new Map<string, number>([['sku-1', 20], ['sku-2', 0]]);

export class OutOfStockError extends Error {}

export function reserveStock(sku: string, quantity: number): void {
  const available = stock.get(sku) ?? 0;
  if (available < quantity) throw new OutOfStockError(`only ${available} of ${sku} left`);
  stock.set(sku, available - quantity);
}

export function releaseStock(sku: string, quantity: number): void {
  stock.set(sku, (stock.get(sku) ?? 0) + quantity);
}
