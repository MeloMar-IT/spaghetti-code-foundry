const SINCE_RE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** The time of a `since` value in ms: an ISO date, with or without a time. Undefined for any other text and for a date that does not exist. */
export function sinceMs(v: string): number | undefined {
  const m = SINCE_RE.exec(v);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-30 would be moved to March; refuse it.
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}
