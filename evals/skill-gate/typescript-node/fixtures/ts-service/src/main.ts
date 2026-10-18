import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { loadConfig } from "./config.ts";

interface StockItem {
  sku: string;
  name: string;
  quantity: number;
}

const stock = new Map<string, StockItem>([
  ["a-100", { sku: "a-100", name: "Bolt", quantity: 40 }],
  ["b-200", { sku: "b-200", name: "Nut", quantity: 0 }],
  ["c-300", { sku: "c-300", name: "Washer", quantity: 12 }],
]);

export function parseStockEvent(body: string): StockItem {
  return JSON.parse(body) as StockItem;
}

export function writeReport(items: StockItem[], out: { write(s: string): void }): void {
  for (const item of items) {
    const line = `${item.sku}\t${item.name}\t${item.quantity}\n`;
    out.write(line);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const config = loadConfig(process.env);

createServer((req, res) => {
  const match = /^\/stock\/([^/]+)$/.exec(req.url ?? "");
  if (req.method !== "GET" || !match) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const item = stock.get(decodeURIComponent(match[1]!));
  if (!item) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  sendJson(res, 200, item);
}).listen(config.port, config.host);
