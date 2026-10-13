import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { credentialProblem } from "./credential-scan.js";
import type { SkillSafety } from "./normalize.js";
import { canonicalJson, plainProblem } from "./normalize-values.js";
import { readRegular } from "./package.js";
import type { ScanFinding, ScanReport } from "./scan.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "./schema.js";
import { hasUnsafeChar, MAX_SOURCES_BYTES, shownValue, type SourceProblem } from "./sources.js";

// Reviewed exceptions for scanner findings, the disposition of every finding and the promotion gate. Pure except
// readScanExceptions (it reads one file). No clock: `today` is always a parameter. Nothing calls it yet.

export const SCAN_EXCEPTIONS_FILE = "skill-scan-exceptions.yaml";
export const MAX_SCAN_EXCEPTIONS = 200;
export const MAX_EXCEPTION_DAYS = 365;
export const SCAN_REPORT_HEADER = "scf-skill-scan-report-v1\n";
export const SCAN_DISPOSITIONS = ["open", "accepted", "expired", "review-required"] as const;
export type ScanDisposition = (typeof SCAN_DISPOSITIONS)[number];

interface ScanExceptionBase {
  finding: string;
  skill: string;
  digest: string;
  reason: string;
  owner: string;
  reviewed: string;
}
/** Exactly one of `expires` and `review`. */
export type ScanException = ScanExceptionBase & ({ expires: string; review?: never } | { review: "required"; expires?: never });
export interface ScanExceptions {
  schema: 1;
  exceptions: ScanException[];
}
export type ScanExceptionsRead =
  | { state: "none" }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "ok"; manifest: ScanExceptions };

export interface DecidedFinding {
  finding: ScanFinding;
  disposition: ScanDisposition;
  exception?: ScanException;
}
export interface DecidedReport {
  schema: 1;
  skill: string;
  digest: string;
  /** scanReportDigest of the report this was decided from. */
  report: string;
  findings: DecidedFinding[];
}

const FINDING_RE = /^[0-9a-f]{16}$/;
// same as OWNER_RE in sources.ts
const OWNER_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WILDCARD_RE = /[*?[\]{}]/;
const ENTRY_KEYS = ["finding", "skill", "digest", "reason", "owner", "reviewed", "expires", "review"];
const DAY_MS = 86400000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Days since 1970-01-01 for a real calendar date like 2026-10-13, else undefined. */
function dayNumber(s: unknown): number | undefined {
  if (typeof s !== "string" || !DATE_RE.test(s)) return undefined;
  const ms = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return undefined;
  return ms / DAY_MS;
}

/** The one way to make a problem: nothing in it is credential-like. */
function problem(where: string, message: string): SourceProblem {
  const rule = credentialProblem(message);
  return { where, message: rule ? `holds what looks like a credential (${rule})` : message };
}

interface EntryProblem {
  field: string;
  message: string;
}

/** Every per-entry rule. Reads only the named keys and Object.keys; ends on any input. */
function checkEntry(raw: unknown, today: number): { entry?: ScanException; problems: EntryProblem[] } {
  const problems: EntryProblem[] = [];
  const err = (field: string, message: string) => void problems.push({ field, message });
  if (!isObject(raw)) {
    err("", "must be a map");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (!ENTRY_KEYS.includes(k)) err("", `unknown key "${shownValue(k)}"`);

  const text = (field: string): string | undefined => {
    const v = raw[field];
    if (v === undefined) {
      err(field, "is required");
      return undefined;
    }
    if (v === null) {
      err(field, "must not be blank; give a value or remove the key");
      return undefined;
    }
    if (typeof v !== "string") {
      err(field, typeof v === "number" || typeof v === "boolean" ? "must be text; put it in quotes" : "must be text");
      return undefined;
    }
    if (hasUnsafeChar(v)) {
      err(field, "holds a control or invisible character");
      return undefined;
    }
    const rule = credentialProblem(v);
    if (rule) {
      err(field, `holds what looks like a credential (${rule})`);
      return undefined;
    }
    return v;
  };
  const matching = (field: string, re: RegExp, message: string): string | undefined => {
    const v = text(field);
    if (v === undefined) return undefined;
    if (WILDCARD_RE.test(v)) {
      err(field, "wildcards are not allowed; one entry names one finding of one package");
      return undefined;
    }
    if (!re.test(v)) {
      err(field, message);
      return undefined;
    }
    return v;
  };
  const date = (field: string): { value: string; day: number } | undefined => {
    const v = text(field);
    if (v === undefined) return undefined;
    const day = dayNumber(v);
    if (day === undefined) {
      err(field, "must be a date like 2026-10-13");
      return undefined;
    }
    return { value: v, day };
  };

  const finding = matching("finding", FINDING_RE, "must be a finding id (16 hex digits)");
  const skill = matching("skill", SKILL_ID_RE, "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)");
  const digest = matching("digest", SKILL_DIGEST_RE, "must be a package digest like sha256:<64 hex digits>");
  const reasonRaw = text("reason");
  let reason: string | undefined;
  if (reasonRaw !== undefined) {
    const r = reasonRaw.trim();
    if (r.length < 1 || r.length > 300) err("reason", "must be 1 to 300 characters");
    else reason = r;
  }
  const owner = text("owner");
  if (owner !== undefined && !OWNER_RE.test(owner)) err("owner", "must be a GitHub user or team like @octocat or @acme/skills");
  const reviewed = date("reviewed");
  if (reviewed && reviewed.day > today) err("reviewed", "must not be in the future");

  const hasExpires = raw.expires !== undefined;
  const hasReview = raw.review !== undefined;
  let expires: string | undefined;
  let review: "required" | undefined;
  if (hasExpires && hasReview) err("", "has both expires and review; keep one");
  else if (!hasExpires && !hasReview) err("", "needs expires (a date) or review: required");
  else if (hasExpires) {
    const e = date("expires");
    if (e) {
      if (reviewed && e.day < reviewed.day) err("expires", "must not be before reviewed");
      else if (reviewed && e.day - reviewed.day > MAX_EXCEPTION_DAYS) err("expires", `must be at most ${MAX_EXCEPTION_DAYS} days after reviewed`);
      else expires = e.value;
    }
  } else {
    const r = text("review");
    if (r !== undefined) {
      if (r === "required") review = "required";
      else err("review", 'must be "required"');
    }
  }

  if (problems.length || !finding || !skill || !digest || reason === undefined || owner === undefined || !reviewed) return { problems };
  const base = { finding, skill, digest, reason, owner, reviewed: reviewed.value };
  if (expires !== undefined) return { entry: { ...base, expires }, problems };
  if (review !== undefined) return { entry: { ...base, review }, problems };
  return { problems };
}

/** Checks parsed YAML. Never throws. No problem holds a credential-like value. */
export function parseScanExceptions(raw: unknown, today: string): { manifest?: ScanExceptions; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  const todayDay = dayNumber(today);
  if (todayDay === undefined) {
    add("today", "must be a date like 2026-10-13");
    return { problems };
  }
  const plain = plainProblem(raw);
  if (plain) {
    add("file", plain);
    return { problems };
  }
  if (!isObject(raw)) {
    add("file", "must be a map with schema and exceptions");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (k !== "schema" && k !== "exceptions") add("file", `unknown key "${shownValue(k)}"`);
  if (raw.schema !== 1) add("schema", "schema must be 1");
  const entries = raw.exceptions;
  if (!Array.isArray(entries)) {
    add("exceptions", "must be a list");
    return { problems };
  }
  if (entries.length > MAX_SCAN_EXCEPTIONS) {
    add("exceptions", `must hold at most ${MAX_SCAN_EXCEPTIONS} exceptions`);
    return { problems };
  }

  const out: ScanException[] = [];
  const seen = new Map<string, number>();
  entries.forEach((e, i) => {
    const base = `exceptions[${i}]`;
    let tag = base;
    const idRaw = isObject(e) ? e.finding : undefined;
    if (typeof idRaw === "string" && FINDING_RE.test(idRaw)) tag = `${base} (${idRaw})`;
    const r = checkEntry(e, todayDay);
    for (const p of r.problems) add(p.field ? `${tag} ${p.field}` : tag, p.message);
    if (!r.entry) return;
    const key = `${r.entry.finding}\0${r.entry.skill}\0${r.entry.digest}`;
    const first = seen.get(key);
    if (first !== undefined) add(tag, `is already listed by exceptions[${first}]`);
    else seen.set(key, i);
    out.push(r.entry);
  });
  if (problems.length) return { problems };
  return { manifest: { schema: 1, exceptions: out }, problems };
}

const fail = (message: string): ScanExceptionsRead => ({ state: "invalid", problems: [problem("file", message)] });
const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** Reads the file safely (no links, no special files, size limit), then parseScanExceptions. No message repeats a path or file content. */
export function readScanExceptions(path: string, today: string, maxBytes = MAX_SOURCES_BYTES): ScanExceptionsRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
    return c === "ENOENT" ? { state: "none" } : fail(`cannot be read (${errCode(e)})`);
  }
  if (st.isSymbolicLink()) return fail("is a symbolic link");
  if (!st.isFile()) return fail("is not a readable regular file");
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, maxBytes);
  } catch (e) {
    return fail(`cannot be read (${errCode(e)})`);
  }
  if (data === "link") return fail("is a symbolic link");
  if (data === "other") return fail("is not a readable regular file");
  if (data === "large") return fail(`is larger than ${maxBytes} bytes`);
  let doc: unknown;
  try {
    doc = parseYaml(Buffer.from(data).toString("utf8"), { maxAliasCount: 0 });
  } catch (e) {
    const x = e as { code?: unknown; linePos?: { line?: unknown; col?: unknown }[] };
    const code = typeof x.code === "string" && /^[A-Z_]{1,40}$/.test(x.code) ? x.code : undefined;
    const pos = x.linePos?.[0];
    if (code && pos && Number.isInteger(pos.line) && Number.isInteger(pos.col)) {
      return fail(`is not valid YAML (${code} at line ${pos.line}, column ${pos.col})`);
    }
    return fail("is not valid YAML");
  }
  const r = parseScanExceptions(doc, today);
  return r.manifest ? { state: "ok", manifest: r.manifest } : { state: "invalid", problems: r.problems };
}

/** A hash of the whole scan report, fed one finding at a time so the size of the report never matters. */
export function scanReportDigest(report: ScanReport): string {
  const h = createHash("sha256");
  h.update(SCAN_REPORT_HEADER);
  h.update(canonicalJson({ schema: report.schema, digest: report.digest }) + "\n");
  for (const f of report.findings) h.update(canonicalJson(f) + "\n");
  return "sha256:" + h.digest("hex");
}

/** One disposition per finding. Trusts no entry: one the parser would refuse takes no part. Secret findings are never accepted. */
export function applyExceptions(skill: string, report: ScanReport, exceptions: readonly ScanException[], today: string): DecidedReport {
  const todayDay = dayNumber(today);
  if (todayDay === undefined) throw new TypeError("today must be a date like 2026-10-13");
  if (typeof skill !== "string" || !SKILL_ID_RE.test(skill)) throw new TypeError("skill must be a package id");
  if (!Array.isArray(exceptions)) throw new TypeError("exceptions must be an array");
  const byFinding = new Map<string, ScanException>();
  for (const raw of exceptions) {
    const { entry } = checkEntry(raw, todayDay);
    if (!entry || entry.skill !== skill || entry.digest !== report.digest) continue;
    if (!byFinding.has(entry.finding)) byFinding.set(entry.finding, entry);
  }
  const findings: DecidedFinding[] = report.findings.map((finding) => {
    const entry = byFinding.get(finding.id);
    if (!entry || finding.category === "secret") return { finding, disposition: "open" };
    if (entry.review === "required") return { finding, disposition: "review-required", exception: entry };
    const expired = dayNumber(entry.expires)! < todayDay;
    return { finding, disposition: expired ? "expired" : "accepted", exception: entry };
  });
  return { schema: 1, skill, digest: report.digest, report: scanReportDigest(report), findings };
}

/** The high findings that are not accepted. An empty list means promotion is allowed. */
export function promotionBlockers(decided: DecidedReport): DecidedFinding[] {
  return decided.findings.filter((d) => d.finding.severity === "high" && d.disposition !== "accepted");
}

/** The record for the provenance. Throws a TypeError when the decided report no longer matches the scan report it came from. */
export function safetyProvenance(decided: DecidedReport): SkillSafety {
  const again = scanReportDigest({ schema: 1, digest: decided.digest, findings: decided.findings.map((d) => d.finding) });
  if (again !== decided.report) throw new TypeError("decided report does not match the scan report it was decided from");
  return {
    report: decided.report,
    findings: decided.findings.map((d) => {
      const e = d.exception;
      return {
        id: d.finding.id,
        severity: d.finding.severity,
        disposition: d.disposition,
        ...(e
          ? {
              exception: {
                owner: e.owner,
                reviewed: e.reviewed,
                ...(e.expires !== undefined ? { expires: e.expires } : {}),
                ...(e.review !== undefined ? { review: e.review } : {}),
                reason: e.reason,
              },
            }
          : {}),
      };
    }),
  };
}
