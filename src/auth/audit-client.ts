import type { AuditRecord } from "./audit.js";

/**
 * The client label of a service request (#877): the optional `X-SCF-Client` header a program sends to say which of its devices
 * or clients made the request. It is a label the program picks, not proof of anything. It sits as the last part of the
 * `service-request` line's detail, `client <label>`, so the file format stays the same.
 */
export const CLIENT_MAX = 64;

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * A label as written to the log: non-printable characters removed, trimmed and cut to 64 characters (code points). Undefined
 * when nothing is left or the value is not a string; `hidden` when it holds what looks like a service token.
 */
export function cleanClient(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cut = Array.from(raw.replace(NOT_PRINTABLE, "").trim()).slice(0, CLIENT_MAX).join("").trim();
  if (!cut) return undefined;
  return /scf_svc_/i.test(cut) ? "hidden" : cut;
}

/** The client label of a `service-request` line, read back from its detail, or undefined. */
export function clientOf(r: Pick<AuditRecord, "action" | "detail">): string | undefined {
  if (r.action !== "service-request" || r.detail === undefined) return undefined;
  const d = r.detail;
  if (d.startsWith("client ")) return d.slice(7) || undefined;
  const at = d.indexOf("; client ");
  return at === -1 ? undefined : d.slice(at + 9) || undefined;
}
