import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { formatRow, writeReport } from "../src/report.ts";
import { handleSignals } from "../src/shutdown.ts";
import { applyEvent } from "../src/stock.ts";

test("loadConfig uses the defaults", () => {
  assert.deepEqual(loadConfig({}), { host: "127.0.0.1", port: 8080 });
});

test("loadConfig reads PORT", () => {
  assert.equal(loadConfig({ PORT: "3000" }).port, 3000);
});

test("applyEvent adds a restock and subtracts a sale", () => {
  const stock = new Map([["A-1", 2]]);
  assert.equal(applyEvent(stock, { type: "restock", sku: "A-1", quantity: 3 }).get("A-1"), 5);
  assert.equal(applyEvent(stock, { type: "sale", sku: "A-1", quantity: 3 }).get("A-1"), -1);
});

test("formatRow ends the line", () => {
  assert.equal(formatRow({ sku: "A-1", quantity: 3 }), "A-1,3\n");
});

test("writeReport writes the header and the rows", async () => {
  let text = "";
  const out = new Writable({
    write(chunk, _enc, done) {
      text += String(chunk);
      done();
    },
  });
  async function* rows() {
    yield { sku: "A-1", quantity: 3 };
  }
  await writeReport(rows(), out);
  assert.equal(text, "sku,quantity\nA-1,3\n");
});

test("SIGTERM closes and exits 0 after the callback", () => {
  const listeners: Record<string, Array<() => void>> = {};
  const exits: number[] = [];
  let closes = 0;
  let callback: ((err?: Error) => void) | undefined;
  const proc = {
    on(signal: string, listener: () => void) {
      (listeners[signal] ??= []).push(listener);
      return proc;
    },
    exit(code: number) {
      exits.push(code);
    },
  };
  const server = {
    close(cb: (err?: Error) => void) {
      closes++;
      callback = cb;
      return server;
    },
  };
  handleSignals(proc, server);
  for (const listener of listeners.SIGTERM ?? []) listener();
  callback?.();
  assert.equal(closes, 1);
  assert.deepEqual(exits, [0]);
});
