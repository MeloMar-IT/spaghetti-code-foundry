import type { Writable } from "node:stream";

export interface Row {
  sku: string;
  quantity: number;
}

export function formatRow(row: Row): string {
  return `${row.sku},${row.quantity}\n`;
}

export async function writeReport(rows: AsyncIterable<Row>, out: Writable): Promise<void> {
  let text = "sku,quantity\n";
  for await (const row of rows) text += formatRow(row);
  out.end(text);
}
