// The pure helpers of the limits of an account (stored and shown only; the server does not enforce them yet). users.js re-exports them.

const text = (s) => String(s ?? "").trim();

export const LIMIT_FIELDS = [
  { key: "maxConcurrent", label: "Runs at the same time" },
  { key: "maxRunsPerDay", label: "Runs per day" },
  { key: "dailyBudgetUsd", label: "Daily budget (USD)" },
];
const LIMIT_TEXT = {
  maxConcurrent: (v) => `${v} at a time`,
  maxRunsPerDay: (v) => `${v} runs a day`,
  dailyBudgetUsd: (v) => `$${v} a day`,
};

/** The limits that apply to an account: `[{ key, text, override }]`, an own value wins over the default. Empty means no limits. */
export function limitParts(limits, id) {
  const own = limits?.users?.[id] ?? {};
  const defaults = limits?.defaults ?? {};
  return LIMIT_FIELDS.flatMap(({ key }) => {
    const override = own[key] !== undefined;
    const v = override ? own[key] : defaults[key];
    return v === undefined ? [] : [{ key, text: LIMIT_TEXT[key](v), override }];
  });
}

/** Reads the three input texts: `{ problem }` or `{ values }` (a missing key is empty = no limit). */
export function readLimits(input) {
  const values = {};
  for (const { key, label } of LIMIT_FIELDS) {
    const t = text(input[key]);
    if (!t) continue;
    if (key === "dailyBudgetUsd") {
      const n = Number(t);
      if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t) || !Number.isFinite(n) || n <= 0) return { problem: "Daily budget must be a number above 0, or empty." };
      values[key] = n;
    } else {
      const n = Number(t);
      if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < 1) return { problem: `${label} must be a whole number of 1 or more, or empty.` };
      values[key] = n;
    }
  }
  return { values };
}

/** Only the keys that differ: a number to set, null to clear. {} means no change. */
export function limitsPatch(current, values) {
  const patch = {};
  for (const { key } of LIMIT_FIELDS) {
    if (values[key] !== undefined) {
      if (values[key] !== current?.[key]) patch[key] = values[key];
    } else if (current?.[key] !== undefined) patch[key] = null;
  }
  return patch;
}
