export type Money = number;

export interface LineItem {
  sku: string;
  quantity: number;
  unitPrice: Money;
}

export interface Customer {
  id: string;
  email: string;
  region: string;
}

export interface Order {
  id: string;
  customer: Customer;
  items: LineItem[];
  promoCode?: string;
}

export interface Receipt {
  orderId: string;
  total: Money;
  paymentId: string;
}
