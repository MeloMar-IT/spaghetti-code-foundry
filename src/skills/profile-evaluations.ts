import { lstatSync } from "node:fs";
import { parseDocument } from "yaml";
import { credentialProblem } from "./credential-scan.js";
import { NORMALIZE_LIMITS } from "./normalize-rules.js";
import { readRegular } from "./package.js";
import { dayNumber, MAX_EXCEPTION_DAYS } from "./scan-exceptions.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "./schema.js";
import { hasUnsafeChar, MAX_SOURCES_BYTES, OWNER_RE, shownValue, type SourceProblem } from "./sources.js";

// Reviewed evaluation records of a profiled skill: which kind of evaluation a skill passed or failed at which digest, by whom,
// and until when. Pure except readProfileEvaluations (it reads one file). The file grants nothing; `scf skills profiles evaluate`
// reads it. Same rules as scan-exceptions.ts. Not the suite records of skill-suites (suite-records.ts) and not the scored
// records of evaluation.ts: `report` may hold the digest of such a record.

export const PROFILE_EVALUATIONS_FILE = "skill-profile-evaluations.yaml";
export const MAX_PROFILE_EVALUATIONS = 500;
export const MAX_EVALUATION_DAYS = MAX_EXCEPTION_DAYS;
export const EVALUATION_VERDICTS = ["passed", "failed"] as const;

export interface ProfileEvaluationRecord {
  skill: string;
  digest: string;
  kind: string;
  verdict: (typeof EVALUATION_VERDICTS)[number];
  owner: string;
  reviewed: string;
  expires: string;
  report?: string;
}
export interface ProfileEvaluations {
  schema: 1;
  evaluations: ProfileEvaluationRecord[];
}
export type ProfileEvaluationsRead =
  | { state: "none" }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "ok"; manifest: ProfileEvaluations };

const WILDCARD_RE = /[*?[\]{}]/;
const ENTRY_KEYS = ["skill", "digest", "kind", "verdict", "owner", "reviewed", "expires", "report"];
// 500 records of 8 values are about 4,000 values; the shared limit of 2,000 would refuse them. Bounded for this format.
const MAX_NODES = MAX_PROFILE_EVALUATIONS * (ENTRY_KEYS.length + 2) + 100;
const SLUG_MESSAGE = "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)";
const UNSAFE_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The one way to make a problem: nothing in it is credential-like or unsafe to print. */
function problem(where: string, message: string): SourceProblem {
  const rule = credentialProblem(message);
  const m = rule ? `holds what looks like a credential (${rule})` : message;
  const esc = (s: string) => s.replace(UNSAFE_G, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
  return { where: esc(where), message: esc(m) };
}

/** A fixed reason why a parsed YAML value cannot be checked, or undefined. Bounded: ends on cycles, depth and size. */
function plainProblem(value: unknown): string | undefined {
  const seen = new Set<object>();
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | undefined => {
    if (++nodes > MAX_NODES) return `holds more than ${MAX_NODES} values`;
    if (v === null || typeof v === "boolean" || typeof v === "string") return undefined;
    if (typeof v === "number") return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)) ? undefined : "holds a number that cannot be kept";
    if (typeof v !== "object") return "holds a value of a type that cannot be kept";
    if (seen.has(v)) return "holds the same value twice (a YAML alias)";
    seen.add(v);
    if (depth > NORMALIZE_LIMITS.yamlDepth) return `is nested deeper than ${NORMALIZE_LIMITS.yamlDepth} levels`;
    if (Array.isArray(v)) {
      for (const item of v) {
        const p = walk(item, depth + 1);
        if (p) return p;
      }
      return undefined;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return "holds a value of a type that cannot be kept";
    for (const key of Object.keys(v)) {
      const p = walk((v as Record<string, unknown>)[key], depth + 1);
      if (p) return p;
    }
    return undefined;
  };
  return walk(value, 1);
}

interface EntryProblem {
  field: string;
  message: string;
}

/** Every per-record rule. Reads only the named keys and Object.keys; ends on any input. */
export function checkProfileEvaluation(raw: unknown, today: number): { entry?: ProfileEvaluationRecord; problems: EntryProblem[] } {
  const problems: EntryProblem[] = [];
  const err = (field: string, message: string) => void problems.push({ field, message });
  if (!isObject(raw)) {
    err("", "must be a map");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (!ENTRY_KEYS.includes(k)) err("", `unknown key "${shownValue(k)}"`);

  const text = (field: string, required = true): string | undefined => {
    const v = raw[field];
    if (v === undefined) {
      if (required) err(field, "is required");
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
  const matching = (field: string, re: RegExp, message: string, required = true): string | undefined => {
    const v = text(field, required);
    if (v === undefined) return undefined;
    if (WILDCARD_RE.test(v)) {
      err(field, "wildcards are not allowed; one record names one evaluation of one package");
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

  const skill = matching("skill", SKILL_ID_RE, SLUG_MESSAGE);
  const digest = matching("digest", SKILL_DIGEST_RE, "must be a package digest like sha256:<64 hex digits>");
  const kind = matching("kind", SKILL_ID_RE, SLUG_MESSAGE);
  let verdict: ProfileEvaluationRecord["verdict"] | undefined;
  const verdictText = text("verdict");
  if (verdictText !== undefined) {
    if (verdictText === "passed" || verdictText === "failed") verdict = verdictText;
    else err("verdict", 'must be "passed" or "failed"');
  }
  const owner = text("owner");
  if (owner !== undefined && !OWNER_RE.test(owner)) err("owner", "must be a GitHub user or team like @octocat or @acme/skills");
  const reviewed = date("reviewed");
  if (reviewed && reviewed.day > today) err("reviewed", "must not be in the future");
  let expires: string | undefined;
  const e = date("expires");
  if (e) {
    if (reviewed && e.day < reviewed.day) err("expires", "must not be before reviewed");
    else if (reviewed && e.day - reviewed.day > MAX_EVALUATION_DAYS) err("expires", `must be at most ${MAX_EVALUATION_DAYS} days after reviewed`);
    else expires = e.value;
  }
  const report = matching("report", SKILL_DIGEST_RE, "must be a digest like sha256:<64 hex digits>", false);

  if (problems.length || !skill || !digest || !kind || !verdict || owner === undefined || !reviewed || expires === undefined) return { problems };
  return { entry: { skill, digest, kind, verdict, owner, reviewed: reviewed.value, expires, ...(report !== undefined ? { report } : {}) }, problems };
}

/** Checks parsed YAML. Never throws. No problem holds a credential-like value or a control character. */
export function parseProfileEvaluations(raw: unknown, today: string): { manifest?: ProfileEvaluations; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  try {
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
      add("file", "must be a map with schema and evaluations");
      return { problems };
    }
    for (const k of Object.keys(raw)) if (k !== "schema" && k !== "evaluations") add("file", `unknown key "${shownValue(k)}"`);
    if (raw.schema !== 1) add("schema", "schema must be 1");
    const entries = raw.evaluations;
    if (!Array.isArray(entries)) {
      add("evaluations", "must be a list");
      return { problems };
    }
    if (entries.length > MAX_PROFILE_EVALUATIONS) {
      add("evaluations", `must hold at most ${MAX_PROFILE_EVALUATIONS} evaluations`);
      return { problems };
    }

    const out: ProfileEvaluationRecord[] = [];
    const seen = new Map<string, number>();
    entries.forEach((e, i) => {
      const base = `evaluations[${i}]`;
      let tag = base;
      if (isObject(e) && typeof e.skill === "string" && typeof e.kind === "string") {
        const ok = (s: string) => SKILL_ID_RE.test(s) && !credentialProblem(s);
        if (ok(e.skill) && ok(e.kind)) tag = `${base} (${e.skill}/${e.kind})`;
      }
      const r = checkProfileEvaluation(e, todayDay);
      for (const p of r.problems) add(p.field ? `${tag} ${p.field}` : tag, p.message);
      if (!r.entry) return;
      const key = `${r.entry.skill}\0${r.entry.digest}\0${r.entry.kind}`;
      const first = seen.get(key);
      if (first !== undefined) add(tag, `is already listed by evaluations[${first}]`);
      else seen.set(key, i);
      out.push(r.entry);
    });
    if (problems.length) return { problems };
    return { manifest: { schema: 1, evaluations: out }, problems };
  } catch {
    return { problems: [problem("file", "cannot be checked")] };
  }
}

const fail = (message: string): ProfileEvaluationsRead => ({ state: "invalid", problems: [problem("file", message)] });
const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** Reads the file safely (no links, no special files, size limit), then parseProfileEvaluations. No message repeats a path or file content. */
export function readProfileEvaluations(path: string, today: string, maxBytes = MAX_SOURCES_BYTES): ProfileEvaluationsRead {
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
    // logLevel "silent": the library must not print warnings, they repeat the source line (which may hold a credential).
    const parsed = parseDocument(Buffer.from(data).toString("utf8"), { logLevel: "silent" });
    if (parsed.errors.length) throw parsed.errors[0];
    doc = parsed.toJS({ maxAliasCount: 0 });
  } catch (e) {
    const x = e as { code?: unknown; linePos?: { line?: unknown; col?: unknown }[] };
    const code = typeof x.code === "string" && /^[A-Z_]{1,40}$/.test(x.code) ? x.code : undefined;
    const pos = x.linePos?.[0];
    if (code && pos && Number.isInteger(pos.line) && Number.isInteger(pos.col)) {
      return fail(`is not valid YAML (${code} at line ${pos.line}, column ${pos.col})`);
    }
    return fail("is not valid YAML");
  }
  const r = parseProfileEvaluations(doc, today);
  return r.manifest ? { state: "ok", manifest: r.manifest } : { state: "invalid", problems: r.problems };
}

/**
 * What the records say about one skill, kind and digest. Trusts no record: one the parser would refuse takes no part.
 * An exact digest match decides (failed, then expired, then passed); otherwise another digest of the same skill and kind
 * is `other-digest`.
 */
export function findProfileEvaluation(
  records: readonly ProfileEvaluationRecord[],
  skill: string,
  kind: string,
  digest: string,
  today: string,
): { state: "passed" | "not-recorded" | "failed" | "expired" | "other-digest" } {
  const todayDay = dayNumber(today);
  if (todayDay === undefined) throw new TypeError("today must be a date like 2026-10-13");
  const mine: ProfileEvaluationRecord[] = [];
  for (const raw of records) {
    const { entry } = checkProfileEvaluation(raw, todayDay);
    if (entry && entry.skill === skill && entry.kind === kind) mine.push(entry);
  }
  const exact = mine.filter((r) => r.digest === digest);
  if (exact.length > 0) {
    if (exact.some((r) => r.verdict === "failed")) return { state: "failed" };
    const valid = exact.filter((r) => dayNumber(r.expires)! >= todayDay);
    return { state: valid.length > 0 ? "passed" : "expired" };
  }
  return { state: mine.length > 0 ? "other-digest" : "not-recorded" };
}
