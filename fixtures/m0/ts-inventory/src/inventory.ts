export interface Item {
  sku: string;
  price: number;
  quantity: number;
}

export function totalValue(items: Item[]): number {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}

export function lowStock(items: Item[], threshold: number): string[] {
  return items.filter((item) => item.quantity < threshold).map((item) => item.sku);
}
