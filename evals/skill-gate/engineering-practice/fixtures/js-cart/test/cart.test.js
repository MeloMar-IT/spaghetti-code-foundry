import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal, receiptLines } from "../src/cart.js";

const a = { sku: "a", priceCents: 250, quantity: 2 };
const b = { sku: "b", priceCents: 100, quantity: 1 };

test("adds up different products", () => {
  assert.equal(cartTotal([a, b]), 600);
});

test("an empty cart costs nothing", () => {
  assert.equal(cartTotal([]), 0);
});

test("prints one line per product", () => {
  assert.deepEqual(receiptLines([a, b]), ["2 x a 5.00", "1 x b 1.00"]);
});

test("refuses two prices for one product", () => {
  assert.throws(() => cartTotal([a, { ...a, priceCents: 300 }]), RangeError);
});
