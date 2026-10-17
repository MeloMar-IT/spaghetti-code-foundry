export interface RestockEvent {
  type: "restock";
  sku: string;
  quantity: number;
}

export interface SaleEvent {
  type: "sale";
  sku: string;
  quantity: number;
}

export type StockEvent = RestockEvent | SaleEvent;

export function parseStockEvent(input: unknown): StockEvent {
  return input as StockEvent;
}

export function applyEvent(stock: Map<string, number>, event: StockEvent): Map<string, number> {
  const next = new Map(stock);
  const have = next.get(event.sku) ?? 0;
  next.set(event.sku, event.type === "restock" ? have + event.quantity : have - event.quantity);
  return next;
}
