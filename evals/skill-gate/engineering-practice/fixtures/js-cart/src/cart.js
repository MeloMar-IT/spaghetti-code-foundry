// Planned, not built yet: shipping.
//   src/shipping.js exports shippingCents(totalCents): 495 when the total is below 5000, and 0 from 5000 on.
//   A total that is not a whole number of 0 or more is a RangeError.
//   checkoutTotal(items, discountPercent = 0) in this file is cartTotal(items, discountPercent) plus the shipping of that total.
import { formatCents, percentOf } from "./money.js";

/** One line per sku, in the order the skus first appear. The quantities of a repeated sku are added. Two prices for one sku are a RangeError. */
export function mergeLines(items) {
  const lines = new Map();
  for (const item of items) {
    const line = lines.get(item.sku);
    if (line && line.priceCents !== item.priceCents) throw new RangeError(`two prices for ${item.sku}`);
    lines.set(item.sku, { sku: item.sku, priceCents: item.priceCents, quantity: item.quantity });
  }
  return [...lines.values()];
}

/** The total in cents after the discount. */
export function cartTotal(items, discountPercent = 0) {
  const subtotal = mergeLines(items).reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
  return subtotal - percentOf(subtotal, discountPercent);
}

/** One text line per sku: "3 x a 7.50". */
export function receiptLines(items) {
  return mergeLines(items).map((l) => `${l.quantity} x ${l.sku} ${formatCents(l.priceCents * l.quantity)}`);
}
