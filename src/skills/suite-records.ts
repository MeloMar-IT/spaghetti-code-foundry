import { lstatSync } from "node:fs";
import { parseDocument } from "yaml";
import { credentialProblem } from "./credential-scan.js";
import { EFFECT_ACCEPTS } from "./evaluation-rules.js";
import { NORMALIZE_LIMITS } from "./normalize-rules.js";
import { readRegular } from "./package.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "./schema.js";
import { hasUnsafeChar, MAX_SOURCES_BYTES, OWNER_RE, shownValue, type SourceProblem } from "./sources.js";
import { SUITE_LIMITS, SUITES, type SuiteName, type SuiteRecord } from "./suite-rules.js";
import { PLAIN_VERSION_RE } from "./technology-rules.js";

// Reviewed evaluation records: which suite a skill passed or failed, at which digest. Pure except readSuiteRecords (it reads one file).
// The file grants nothing; `scf skills promote check` reads it (cli.ts). Same shape and safety rules as selections.ts.

export const EVALUATIONS_FILE = "skill-evaluations.yaml";
export interface SuiteRecords {
  schema: 1;
  evaluations: SuiteRecord[];
  effect_decisions: EffectDecision[];
}
/** An owner's decision to promote a skill whose effect is "no measurable effect" or was never measured. Tied to one digest. */
export interface EffectDecision {
  skill: string;
  digest: string;
  accept: (typeof EFFECT_ACCEPTS)[number];
  owner: string;
  reviewed: string;
  note: string;
}
export type SuiteRecordsRead = { state: "none" } | { state: "invalid"; problems: SourceProblem[] } | { state: "ok"; manifest: SuiteRecords };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WILDCARD_RE = /[*?[\]{}]/;
const ENTRY_KEYS = ["source", "skill", "digest", "suite", "result", "project", "owner", "reviewed", "note"];
// 500 entries of up to 8 project versions are about 20,000 values; the shared limit of 2,000 would refuse them.
const MAX_NODES = 100000;
const DAY_MS = 86400000;
const SLUG_MESSAGE = "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)";
const UNSAFE_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function dayNumber(s: unknown): number | undefined {
  if (typeof s !== "string" || !DATE_RE.test(s)) return undefined;
  const ms = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return undefined;
  return ms / DAY_MS;
}

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

/** The text readers every entry check shares. `err` collects the problems. */
function fieldReaders(err: (field: string, message: string) => void) {
  const text = (v: unknown, field: string, required = true): string | undefined => {
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
  const matching = (v: unknown, field: string, re: RegExp, message: string): string | undefined => {
    const t = text(v, field);
    if (t === undefined) return undefined;
    if (WILDCARD_RE.test(t)) {
      err(field, "wildcards are not allowed; one entry names one skill");
      return undefined;
    }
    if (!re.test(t)) {
      err(field, message);
      return undefined;
    }
    return t;
  };
  return { text, matching };
}

/** The owner, reviewed and note checks both entry kinds share. */
function ownerReviewed(
  raw: Record<string, unknown>,
  today: number,
  err: (field: string, message: string) => void,
  text: (v: unknown, field: string, required?: boolean) => string | undefined,
  noteRequired: boolean,
) {
  const owner = text(raw.owner, "owner");
  if (owner !== undefined && !OWNER_RE.test(owner)) err("owner", "must be a GitHub user or team like @octocat or @acme/skills");
  const reviewedText = text(raw.reviewed, "reviewed");
  let reviewed: string | undefined;
  if (reviewedText !== undefined) {
    const day = dayNumber(reviewedText);
    if (day === undefined) err("reviewed", "must be a date like 2026-10-13");
    else if (day > today) err("reviewed", "must not be in the future");
    else reviewed = reviewedText;
  }
  const note = text(raw.note, "note", noteRequired);
  if (note !== undefined && (note.trim().length < 1 || note.length > SUITE_LIMITS.noteChars)) {
    err("note", `must be text of 1 to ${SUITE_LIMITS.noteChars} characters`);
  }
  return { owner, reviewed, note };
}

const DECISION_KEYS = ["skill", "digest", "accept", "owner", "reviewed", "note"];

/** The rules of one effect decision. Ends on any input. */
function checkDecision(raw: unknown, today: number): { entry?: EffectDecision; problems: EntryProblem[] } {
  const problems: EntryProblem[] = [];
  const err = (field: string, message: string) => void problems.push({ field, message });
  if (!isObject(raw)) {
    err("", "must be a map");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (!DECISION_KEYS.includes(k)) err("", `unknown key "${shownValue(k)}"`);
  const { text, matching } = fieldReaders(err);
  const skill = matching(raw.skill, "skill", SKILL_ID_RE, SLUG_MESSAGE);
  const digest = matching(raw.digest, "digest", SKILL_DIGEST_RE, "must be a package digest like sha256:<64 hex digits>");
  let accept: EffectDecision["accept"] | undefined;
  const acceptText = text(raw.accept, "accept");
  if (acceptText !== undefined) {
    if ((EFFECT_ACCEPTS as readonly string[]).includes(acceptText)) accept = acceptText as EffectDecision["accept"];
    else err("accept", 'must be "no-effect" or "not-measured"');
  }
  const { owner, reviewed, note } = ownerReviewed(raw, today, err, text, true);
  if (problems.length || !skill || !digest || !accept || !owner || !reviewed || note === undefined) return { problems };
  return { entry: { skill, digest, accept, owner, reviewed, note }, problems };
}

/** Every per-entry rule. Ends on any input. */
function checkEntry(raw: unknown, today: number): { entry?: SuiteRecord; problems: EntryProblem[] } {
  const problems: EntryProblem[] = [];
  const err = (field: string, message: string) => void problems.push({ field, message });
  if (!isObject(raw)) {
    err("", "must be a map");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (!ENTRY_KEYS.includes(k)) err("", `unknown key "${shownValue(k)}"`);
  const { text, matching } = fieldReaders(err);

  const source = matching(raw.source, "source", SKILL_ID_RE, SLUG_MESSAGE);
  const skill = matching(raw.skill, "skill", SKILL_ID_RE, SLUG_MESSAGE);
  const digest = matching(raw.digest, "digest", SKILL_DIGEST_RE, "must be a package digest like sha256:<64 hex digits>");
  let suite: SuiteName | undefined;
  const suiteText = text(raw.suite, "suite");
  if (suiteText !== undefined) {
    if ((SUITES as readonly string[]).includes(suiteText)) suite = suiteText as SuiteName;
    else err("suite", `must be one of ${SUITES.join(", ")}`);
  }
  let result: SuiteRecord["result"] | undefined;
  const resultText = text(raw.result, "result");
  if (resultText !== undefined) {
    if (resultText === "passed" || resultText === "failed") result = resultText;
    else err("result", 'must be "passed" or "failed"');
  }

  let project: SuiteRecord["project"];
  if (raw.project === undefined) {
    if (suite === "compatibility") err("project", "is required for the compatibility suite");
  } else if (suite === "messaging-semantics") {
    err("project", "is not allowed for the messaging-semantics suite");
  } else if (!isObject(raw.project)) {
    err("project", "must be a map of technology name to version");
  } else {
    const names = Object.keys(raw.project);
    if (names.length < 1 || names.length > SUITE_LIMITS.project) {
      err("project", `must hold 1 to ${SUITE_LIMITS.project} technologies`);
    } else {
      const list: { name: string; version: string }[] = [];
      let ok = true;
      for (const name of names) {
        const field = `project.${shownValue(name)}`;
        if (!SKILL_ID_RE.test(name) || credentialProblem(name)) {
          err(field, SLUG_MESSAGE);
          ok = false;
          continue;
        }
        const v = text(raw.project[name], field);
        if (v === undefined) ok = false;
        else if (!PLAIN_VERSION_RE.test(v)) {
          err(field, "must be a plain version like 4.1.0");
          ok = false;
        } else list.push({ name, version: v });
      }
      if (ok) project = list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
  }

  const { owner, reviewed, note } = ownerReviewed(raw, today, err, text, false);

  if (problems.length || !source || !skill || !digest || !suite || !result || !owner || !reviewed) return { problems };
  return {
    entry: {
      source, skill, digest, suite, result, ...(project ? { project } : {}), owner, reviewed,
      ...(note !== undefined ? { note } : {}),
    },
    problems,
  };
}

/** Checks parsed YAML. Never throws. No problem holds a credential-like value or a control character. */
export function parseSuiteRecords(raw: unknown, today: string): { manifest?: SuiteRecords; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  try {
    const todayDay = dayNumber(today);
    if (todayDay === undefined) {
      add("today", "must be a date like 2026-10-13");
      return { problems };
    }
    if (!isObject(raw)) {
      add("file", "must be a map with schema and evaluations");
      return { problems };
    }
    for (const k of Object.keys(raw)) if (k !== "schema" && k !== "evaluations" && k !== "effect_decisions") add("file", `unknown key "${shownValue(k)}"`);
    if (raw.schema !== 1) add("schema", "schema must be 1");
    const entries = raw.evaluations;
    if (!Array.isArray(entries)) {
      add("evaluations", "must be a list");
      return { problems };
    }
    if (entries.length > SUITE_LIMITS.records) {
      add("evaluations", `must hold at most ${SUITE_LIMITS.records} evaluations`);
      return { problems };
    }
    const rawDecisions = raw.effect_decisions;
    if (rawDecisions !== undefined) {
      if (!Array.isArray(rawDecisions)) {
        add("effect_decisions", "must be a list");
        return { problems };
      }
      if (rawDecisions.length > SUITE_LIMITS.records) {
        add("effect_decisions", `must hold at most ${SUITE_LIMITS.records} decisions`);
        return { problems };
      }
    }
    const plain = plainProblem(raw);
    if (plain) {
      add("file", plain);
      return { problems };
    }

    const out: SuiteRecord[] = [];
    const seen = new Map<string, number>();
    entries.forEach((e, i) => {
      const base = `evaluations[${i}]`;
      let tag = base;
      if (isObject(e) && typeof e.source === "string" && typeof e.skill === "string") {
        const ok = (s: string) => SKILL_ID_RE.test(s) && !credentialProblem(s);
        if (ok(e.source) && ok(e.skill)) tag = `${base} (${e.source}/${e.skill})`;
      }
      const r = checkEntry(e, todayDay);
      for (const p of r.problems) add(p.field ? `${tag} ${p.field}` : tag, p.message);
      if (!r.entry) return;
      const key = `${r.entry.source}\0${r.entry.skill}\0${r.entry.suite}`;
      const first = seen.get(key);
      if (first !== undefined) add(tag, `is already listed by evaluations[${first}]`);
      else seen.set(key, i);
      out.push(r.entry);
    });
    const decisions: EffectDecision[] = [];
    const seenDecisions = new Map<string, number>();
    (Array.isArray(rawDecisions) ? (rawDecisions as unknown[]) : []).forEach((e, i) => {
      const base = `effect_decisions[${i}]`;
      let tag = base;
      if (isObject(e) && typeof e.skill === "string" && SKILL_ID_RE.test(e.skill) && !credentialProblem(e.skill)) tag = `${base} (${e.skill})`;
      const r = checkDecision(e, todayDay);
      for (const p of r.problems) add(p.field ? `${tag} ${p.field}` : tag, p.message);
      if (!r.entry) return;
      const key = `${r.entry.skill}\0${r.entry.digest}\0${r.entry.accept}`;
      const first = seenDecisions.get(key);
      if (first !== undefined) add(tag, `is already listed by effect_decisions[${first}]`);
      else seenDecisions.set(key, i);
      decisions.push(r.entry);
    });
    if (problems.length) return { problems };
    return { manifest: { schema: 1, evaluations: out, effect_decisions: decisions }, problems };
  } catch {
    return { problems: [problem("file", "cannot be checked")] };
  }
}

const fail = (message: string): SuiteRecordsRead => ({ state: "invalid", problems: [problem("file", message)] });
const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** Reads the file safely (no links, no special files, size limit), then parseSuiteRecords. No message repeats a path or file content. */
export function readSuiteRecords(path: string, today: string, maxBytes = MAX_SOURCES_BYTES): SuiteRecordsRead {
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
  const r = parseSuiteRecords(doc, today);
  return r.manifest ? { state: "ok", manifest: r.manifest } : { state: "invalid", problems: r.problems };
}
