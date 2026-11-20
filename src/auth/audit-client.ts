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

const ONE_NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** True when the text holds no control, format, surrogate or line-break character (a stateless check). */
export const isPrintable = (s: string): boolean => !ONE_NOT_PRINTABLE.test(s);

/**
 * A service account's own audit line (#884), action `service-line`. The file format allows only `ok` and `failed`, so the
 * program's own result is the first word of the detail. Then come its code, its text (JSON-quoted, so it cannot pose as a
 * later part), the person it acts for and the client label, each as `; <name> <value>` and only when there is one:
 * `refused; code bad_signature; text "signature did not match"; acts for <id>; client tablet`.
 * The text is the program's claim: the Foundry checks only its shape.
 */
export const SERVICE_LINE_RESULTS = ["ok", "refused", "failed"] as const;
export type ServiceLineResult = (typeof SERVICE_LINE_RESULTS)[number];

export interface ServiceLineParts {
  result: ServiceLineResult;
  code?: string;
  text?: string;
  actsFor?: string;
  client?: string;
}

/** The base text of a `service-line-dropped` line: the account wrote more lines than its limit allows. */
export const SERVICE_DROPPED_TEXT = "over 120 lines a minute";

/** The detail of a `service-line` line. */
export function serviceLineDetail(p: ServiceLineParts): string {
  const parts: string[] = [p.result];
  if (p.code !== undefined) parts.push(`code ${p.code}`);
  if (p.text !== undefined) parts.push(`text ${JSON.stringify(p.text)}`);
  if (p.actsFor !== undefined) parts.push(`acts for ${p.actsFor}`);
  if (p.client !== undefined) parts.push(`client ${p.client}`);
  return parts.join("; ");
}

const SERVICE_LINE_RE = /^(ok|refused|failed)(?:; code ([a-z0-9_.-]{1,64}))?(?:; text ("(?:[^"\\]|\\.)*"))?(?:; acts for ([0-9A-Fa-f-]{36}))?(?:; client (.+))?$/;

/** The parts of a `service-line` detail, or undefined when it is not one. */
export function parseServiceLine(detail: string): ServiceLineParts | undefined {
  const m = SERVICE_LINE_RE.exec(detail);
  if (!m) return undefined;
  let text: string | undefined;
  if (m[3] !== undefined) {
    try {
      const v: unknown = JSON.parse(m[3]);
      if (typeof v !== "string") return undefined;
      text = v;
    } catch {
      return undefined;
    }
  }
  return {
    result: m[1] as ServiceLineResult,
    ...(m[2] !== undefined ? { code: m[2] } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(m[4] !== undefined ? { actsFor: m[4] } : {}),
    ...(m[5] !== undefined ? { client: m[5] } : {}),
  };
}

/** The client label of a `service-request`, `service-line` or `service-line-dropped` line, read back from its detail, or undefined. */
export function clientOf(r: Pick<AuditRecord, "action" | "detail">): string | undefined {
  if (r.detail === undefined) return undefined;
  if (r.action === "service-line") return parseServiceLine(r.detail)?.client;
  if (r.action !== "service-request" && r.action !== "service-line-dropped") return undefined;
  const d = r.detail;
  if (d.startsWith("client ")) return d.slice(7) || undefined;
  const at = d.indexOf("; client ");
  return at === -1 ? undefined : d.slice(at + 9) || undefined;
}
