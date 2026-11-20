import { NO_INSTALL, ShareReportSchema, type ShareReport } from "../src/metrics-share/report.js";

// The checks of the receiver (#890): pure functions with fixed reasons. A refusal never carries zod's messages or any
// part of the body, so nothing a client sent is echoed or logged.

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

export const REASONS = {
  tooLarge: "too_large",
  badContentType: "bad_content_type",
  badJson: "bad_json",
  badSchema: "bad_schema",
  badInstall: "bad_install",
  futureDay: "future_day",
  oldDay: "old_day",
  rateLimited: "rate_limited",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  notReady: "not_ready",
  internal: "internal_error",
} as const;
export type Reason = (typeof REASONS)[keyof typeof REASONS];

const INSTALL_RE = /^[0-9a-f]{32}$/;

/** A real install id: 32 lowercase hex characters, not the placeholder of 32 zeros. */
export const isInstallId = (s: unknown): s is string => typeof s === "string" && INSTALL_RE.test(s) && s !== NO_INSTALL;

/** The install id of a parsed body, when it is a real one. */
export function installOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const id = (body as { install?: unknown }).install;
  return isInstallId(id) ? id : undefined;
}

/** `application/json`, with or without parameters such as a charset. */
export function isJsonContentType(h: string | undefined): boolean {
  if (typeof h !== "string") return false;
  return h.split(";")[0]!.trim().toLowerCase() === "application/json";
}

export const todayUtc = (now: Date): string => now.toISOString().slice(0, 10);

const dayMs = (day: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day ? d.getTime() : undefined;
};

/** Days from today−7 to today (UTC) are taken; a date that does not exist is a schema failure. */
export function checkDay(day: string, now: Date): Reason | undefined {
  const ms = dayMs(day);
  if (ms === undefined) return REASONS.badSchema;
  const today = dayMs(todayUtc(now))!;
  if (ms > today) return REASONS.futureDay;
  if (ms < today - MAX_AGE_DAYS * DAY_MS) return REASONS.oldDay;
  return undefined;
}

export function checkReport(body: unknown, now: Date): { ok: true; report: ShareReport } | { ok: false; reason: Reason } {
  const parsed = ShareReportSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: REASONS.badSchema };
  const report = parsed.data;
  if (!isInstallId(report.install)) return { ok: false, reason: REASONS.badInstall };
  const day = checkDay(report.day, now);
  if (day) return { ok: false, reason: day };
  return { ok: true, report };
}
