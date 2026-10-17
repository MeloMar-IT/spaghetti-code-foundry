/**
 * percentOf(cents, percent): `percent` per cent of `cents`, rounded half up to a whole cent.
 * Throws a RangeError unless `cents` is a whole number of 0 or more and `percent` is a whole number from 0 to 100.
 */
export function percentOf(cents, percent) {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError("cents must be a whole number of 0 or more");
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError("percent must be a whole number from 0 to 100");
  return Math.floor((cents * percent + 50) / 100);
}

/** formatCents(750) is "7.50". */
export function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
