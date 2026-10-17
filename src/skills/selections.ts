import { lstatSync } from "node:fs";
import { parseDocument } from "yaml";
import { catalogueDescriptionProblem } from "./catalogue-description.js";
import { credentialProblem } from "./credential-scan.js";
import { NORMALIZE_LIMITS } from "./normalize-rules.js";
import { readRegular } from "./package.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "./schema.js";
import { hasUnsafeChar, MAX_SOURCES_BYTES, OWNER_RE, shownValue, type SourceProblem } from "./sources.js";

// Reviewed skill selections: which skills of a source are chosen, with scope, product, SDK and what each needs.
// Pure except readSkillSelections (it reads one file). It grants nothing; no run reads it. A `catalogue_description` reaches runs only through a published release. Called by `scf skills selections check` (cli.ts).

export const SELECTIONS_FILE = "skill-selections.yaml";
export const MAX_SELECTIONS = 500;
export const MAX_VERSION_CHARS = 64;
export const MAX_SELECTION_CAPABILITIES = 32;
export const SELECTION_SCOPES = ["portable", "provider"] as const;
export type SelectionScope = (typeof SELECTION_SCOPES)[number];
/** Key in `requires` → connector prefix. */
export const REQUIRES_KINDS = { clis: "cli", mcp: "mcp", credentials: "credential", services: "service" } as const;
export type RequiresKind = keyof typeof REQUIRES_KINDS;

export interface SkillSelection {
  source: string;
  skill: string;
  digest: string;
  scope: SelectionScope;
  /** Only for scope "provider". */
  provider?: string;
  product?: { name: string; version: string };
  sdk?: { name: string; language: string; version: string };
  category: string;
  capabilities: string[];
  /** Always all four lists. What the agent itself must call or reach during a run; it grants nothing. */
  requires: Record<RequiresKind, string[]>;
  owner: string;
  reviewed: string;
  /** A short description for the catalogue instead of the package's own; at most 160 characters. Tied to `digest`. */
  catalogueDescription?: string;
}
export interface SkillSelections {
  schema: 1;
  selections: SkillSelection[];
}
export type SkillSelectionsRead =
  | { state: "none" }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "ok"; manifest: SkillSelections };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WILDCARD_RE = /[*?[\]{}]/;
const SDK_NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/:+-]{0,127}$/;
const ENTRY_KEYS = ["source", "skill", "digest", "scope", "provider", "product", "sdk", "category", "capabilities", "requires", "owner", "reviewed", "catalogue_description"];
const MAX_NODES = 200000;
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

/** A fixed reason why a parsed YAML value cannot be checked, or undefined. Bounded: ends on cycles, depth and size. Sized for 500 entries. */
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

/** Every per-entry rule. Ends on any input. */
function checkEntry(raw: unknown, today: number): { entry?: SkillSelection; problems: EntryProblem[] } {
  const problems: EntryProblem[] = [];
  const err = (field: string, message: string) => void problems.push({ field, message });
  if (!isObject(raw)) {
    err("", "must be a map");
    return { problems };
  }
  const keys = (o: Record<string, unknown>, allowed: string[], field: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(field, `unknown key "${shownValue(k)}"`);
  };
  keys(raw, ENTRY_KEYS, "");

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
  const matching = (v: unknown, field: string, re: RegExp, message: string, required = true): string | undefined => {
    const t = text(v, field, required);
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
  const slug = (v: unknown, field: string, required = true) => matching(v, field, SKILL_ID_RE, SLUG_MESSAGE, required);
  const version = (v: unknown, field: string): string | undefined => {
    const t = text(v, field);
    if (t === undefined) return undefined;
    if (t.trim().length < 1 || t.length > MAX_VERSION_CHARS) {
      err(field, `must be text of 1 to ${MAX_VERSION_CHARS} characters`);
      return undefined;
    }
    if (/[*?]/.test(t)) {
      err(field, "wildcards are not allowed; name a version or a range");
      return undefined;
    }
    return t;
  };
  const sub = (v: unknown, field: string, required: boolean, allowed: string[]): Record<string, unknown> | undefined => {
    if (v === undefined) {
      if (required) err(field, "is required");
      return undefined;
    }
    if (!isObject(v)) {
      err(field, "must be a map");
      return undefined;
    }
    keys(v, allowed, field);
    return v;
  };
  const slugList = (v: unknown, field: string, max: number, min: number): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      err(field, "must be a list");
      return undefined;
    }
    if (v.length < min || v.length > max) {
      err(field, `must hold ${min === 0 ? "at most" : `${min} to`} ${max} names`);
      return undefined;
    }
    const out: string[] = [];
    let ok = true;
    v.forEach((item, i) => {
      const s = slug(item, `${field}[${i}]`);
      if (s === undefined) ok = false;
      else out.push(s);
    });
    return ok ? out : undefined;
  };

  const source = slug(raw.source, "source");
  const skill = slug(raw.skill, "skill");
  const digest = matching(raw.digest, "digest", SKILL_DIGEST_RE, "must be a package digest like sha256:<64 hex digits>");
  let scope: SelectionScope | undefined;
  const scopeText = text(raw.scope, "scope");
  if (scopeText !== undefined) {
    if (scopeText === "portable" || scopeText === "provider") scope = scopeText;
    else err("scope", 'must be "portable" or "provider"');
  }
  const provider = slug(raw.provider, "provider", false);
  if (scope === "provider" && raw.provider === undefined) err("provider", "is required for scope provider");
  if (scope === "portable" && raw.provider !== undefined) err("provider", "is not allowed for scope portable");

  let product: SkillSelection["product"];
  const p = sub(raw.product, "product", scope === "provider", ["name", "version"]);
  if (p) {
    const name = slug(p.name, "product.name");
    const ver = version(p.version, "product.version");
    if (name !== undefined && ver !== undefined) product = { name, version: ver };
  }
  let sdk: SkillSelection["sdk"];
  const s = sub(raw.sdk, "sdk", scope === "provider", ["name", "language", "version"]);
  if (s) {
    const name = matching(s.name, "sdk.name", SDK_NAME_RE, "must be a package name of 1 to 128 characters (letters, digits, @ . _ / : + -)");
    const language = slug(s.language, "sdk.language");
    const ver = version(s.version, "sdk.version");
    if (name !== undefined && language !== undefined && ver !== undefined) sdk = { name, language, version: ver };
  }
  const category = slug(raw.category, "category");

  let capabilities: string[] | undefined;
  if (raw.capabilities === undefined) err("capabilities", "is required");
  else {
    capabilities = slugList(raw.capabilities, "capabilities", MAX_SELECTION_CAPABILITIES, 1);
    if (capabilities) {
      const seenCap = new Set<string>();
      capabilities.forEach((c, i) => {
        if (seenCap.has(c)) err(`capabilities[${i}]`, `"${c}" is listed twice`);
        seenCap.add(c);
      });
    }
  }

  const requires: Record<RequiresKind, string[]> = { clis: [], mcp: [], credentials: [], services: [] };
  let requiresOk = true;
  const r = sub(raw.requires, "requires", false, Object.keys(REQUIRES_KINDS));
  if (raw.requires !== undefined && !r) requiresOk = false;
  if (r) {
    const first = new Map<string, string>();
    let total = 0;
    for (const kind of Object.keys(REQUIRES_KINDS) as RequiresKind[]) {
      const before = problems.length;
      const names = slugList(r[kind], `requires.${kind}`, NORMALIZE_LIMITS.connectors, 0);
      if (problems.length > before) requiresOk = false;
      if (!names) continue;
      names.forEach((n, i) => {
        const where = `requires.${kind}[${i}]`;
        const was = first.get(n);
        if (was !== undefined) {
          err(where, `"${n}" is already listed in ${was}`);
          requiresOk = false;
        } else first.set(n, where);
        if (`${REQUIRES_KINDS[kind]}-${n}`.length > 64) {
          err(where, `is too long: "${REQUIRES_KINDS[kind]}-${n}" must be at most 64 characters`);
          requiresOk = false;
        }
      });
      total += names.length;
      requires[kind] = names;
    }
    if (total > NORMALIZE_LIMITS.connectors) {
      err("requires", `must hold at most ${NORMALIZE_LIMITS.connectors} names in total`);
      requiresOk = false;
    }
  }

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

  const catalogueDescription = text(raw.catalogue_description, "catalogue_description", false);
  if (catalogueDescription !== undefined) {
    const why = catalogueDescriptionProblem(catalogueDescription);
    if (why) err("catalogue_description", why);
  }

  if (problems.length || !requiresOk || !source || !skill || !digest || !scope || !category || !capabilities || !owner || !reviewed) return { problems };
  const entry: SkillSelection = {
    source,
    skill,
    digest,
    scope,
    ...(provider !== undefined ? { provider } : {}),
    ...(product ? { product } : {}),
    ...(sdk ? { sdk } : {}),
    category,
    capabilities,
    requires,
    owner,
    reviewed,
    ...(catalogueDescription !== undefined ? { catalogueDescription } : {}),
  };
  return { entry, problems };
}

/** Checks parsed YAML. Never throws. No problem holds a credential-like value or a control character. */
export function parseSkillSelections(raw: unknown, today: string): { manifest?: SkillSelections; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  try {
    const todayDay = dayNumber(today);
    if (todayDay === undefined) {
      add("today", "must be a date like 2026-10-13");
      return { problems };
    }
    if (!isObject(raw)) {
      add("file", "must be a map with schema and selections");
      return { problems };
    }
    for (const k of Object.keys(raw)) if (k !== "schema" && k !== "selections") add("file", `unknown key "${shownValue(k)}"`);
    if (raw.schema !== 1) add("schema", "schema must be 1");
    const entries = raw.selections;
    if (!Array.isArray(entries)) {
      add("selections", "must be a list");
      return { problems };
    }
    if (entries.length > MAX_SELECTIONS) {
      add("selections", `must hold at most ${MAX_SELECTIONS} selections`);
      return { problems };
    }
    const plain = plainProblem(raw);
    if (plain) {
      add("file", plain);
      return { problems };
    }

    const out: SkillSelection[] = [];
    const seen = new Map<string, number>();
    entries.forEach((e, i) => {
      const base = `selections[${i}]`;
      let tag = base;
      if (isObject(e) && typeof e.source === "string" && typeof e.skill === "string") {
        const ok = (s: string) => SKILL_ID_RE.test(s) && !credentialProblem(s);
        if (ok(e.source) && ok(e.skill)) tag = `${base} (${e.source}/${e.skill})`;
      }
      const r = checkEntry(e, todayDay);
      for (const p of r.problems) add(p.field ? `${tag} ${p.field}` : tag, p.message);
      if (!r.entry) return;
      const key = `${r.entry.source}\0${r.entry.skill}`;
      const first = seen.get(key);
      if (first !== undefined) add(tag, `is already listed by selections[${first}]`);
      else seen.set(key, i);
      out.push(r.entry);
    });
    if (problems.length) return { problems };
    return { manifest: { schema: 1, selections: out }, problems };
  } catch {
    return { problems: [problem("file", "cannot be checked")] };
  }
}

const fail = (message: string): SkillSelectionsRead => ({ state: "invalid", problems: [problem("file", message)] });
const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** Reads the file safely (no links, no special files, size limit), then parseSkillSelections. No message repeats a path or file content. */
export function readSkillSelections(path: string, today: string, maxBytes = MAX_SOURCES_BYTES): SkillSelectionsRead {
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
  const r = parseSkillSelections(doc, today);
  return r.manifest ? { state: "ok", manifest: r.manifest } : { state: "invalid", problems: r.problems };
}

/** The connector slugs a selection needs, sorted, each once. Throws a TypeError for a name that is not a slug. */
export function selectionConnectors(selection: Pick<SkillSelection, "requires">): string[] {
  const out = new Set<string>();
  for (const kind of Object.keys(REQUIRES_KINDS) as RequiresKind[]) {
    for (const name of selection.requires?.[kind] ?? []) {
      const slug = `${REQUIRES_KINDS[kind]}-${name}`;
      if (typeof name !== "string" || !SKILL_ID_RE.test(name) || !SKILL_ID_RE.test(slug)) throw new TypeError("requires holds a name that is not a connector slug");
      out.add(slug);
    }
  }
  return [...out].sort();
}
