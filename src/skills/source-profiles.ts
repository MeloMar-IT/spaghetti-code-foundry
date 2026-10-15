import { lstatSync } from "node:fs";
import { parseDocument } from "yaml";
import { credentialProblem } from "./credential-scan.js";
import { readRegular } from "./package.js";
import { SKILL_ID_RE } from "./schema.js";
import { hasUnsafeChar, MAX_SOURCES_BYTES, type SourceProblem } from "./sources.js";
import type { ToolNeed } from "./tool-policy.js";

export const PROFILES_FILE = "skill-source-profiles.yaml";
export const MAX_PROFILE_SOURCES = 200;
export const MAX_PROFILE_SKILLS = 100;
export const MAX_PROFILE_CAPABILITIES = 32;
export const MAX_PROFILE_LIST = 16;
export const PROFILE_CLASSES = ["portable", "vendor"] as const;
export const PROFILE_TOOLS = ["shell", "network", "write"] as const satisfies readonly ToolNeed[];
export type ProfileClass = (typeof PROFILE_CLASSES)[number];
export type ProfileTool = (typeof PROFILE_TOOLS)[number];

export interface SkillProfile {
  name: string;
  class: ProfileClass;
  capabilities: string[];
  high_risk: string[];
  requires: { config: string[]; tools: ProfileTool[]; connectors: string[]; live_services: string[] };
  evaluations: string[];
}
export interface SourceProfile {
  id: string;
  skills: SkillProfile[];
}
export interface SourceProfiles {
  schema: 1;
  exclusive: string[];
  sources: SourceProfile[];
}
export type SourceProfilesRead =
  | { state: "none" }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "ok"; profiles: SourceProfiles };

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const URL_USERINFO_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]*@/;
const SHOWN_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Longest text any field may hold; longer text is refused before the (slower) URL check. */
const MAX_TEXT = 64;
const SLUG_MESSAGE = "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)";
const UNSAFE_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const escapeUnsafe = (s: string) => s.replace(UNSAFE_G, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

/** The one way to make a problem: nothing in it is credential-like or unsafe to print. */
function problem(where: string, message: string): SourceProblem {
  const rule = credentialProblem(message);
  const m = rule ? `holds what looks like a credential (${rule})` : message;
  return { where: escapeUnsafe(where), message: escapeUnsafe(m) };
}

/** A key or name from the file, shown only when it is plain and not credential-like. */
function shownName(v: string): string {
  return SHOWN_NAME_RE.test(v) && !credentialProblem(v) ? v : "(hidden)";
}

const listText = (a: readonly string[]) => a.join(", ");

/** Checks parsed YAML. Never throws. No problem holds a credential-like value, a URL with user info or a control character. */
export function parseSourceProfiles(raw: unknown): { profiles?: SourceProfiles; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  if (!isObject(raw)) {
    add("file", "must be a map with schema and sources");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (!["schema", "sources", "exclusive"].includes(k)) add("file", `unknown key "${shownName(k)}"`);
  if (raw.schema !== 1) add("schema", "schema must be 1");

  /** A text value: undefined (and a problem) when it is missing, not text, unsafe, credential-like or a URL with user info. */
  const text = (v: unknown, where: string, required = true): string | undefined => {
    if (v === undefined) {
      if (required) add(where, "is required");
      return undefined;
    }
    if (v === null) {
      add(where, "must not be blank; give a value or remove the key");
      return undefined;
    }
    if (typeof v !== "string") {
      add(where, typeof v === "number" || typeof v === "boolean" ? "must be text; put it in quotes" : "must be text");
      return undefined;
    }
    if (hasUnsafeChar(v)) {
      add(where, "holds a control or invisible character");
      return undefined;
    }
    const rule = credentialProblem(v);
    if (rule) {
      add(where, `holds what looks like a credential (${rule})`);
      return undefined;
    }
    if (v.length > MAX_TEXT) {
      add(where, `must be at most ${MAX_TEXT} characters`);
      return undefined;
    }
    if (URL_USERINFO_RE.test(v)) {
      add(where, "holds a URL with user info");
      return undefined;
    }
    return v;
  };

  const slugList = (v: unknown, where: string, max: number, required: boolean, at?: number[]): string[] => {
    if (v === undefined) {
      if (required) add(where, "is required");
      return [];
    }
    if (!Array.isArray(v) || (required && v.length === 0) || v.length > max) {
      add(where, `must be a list of ${required ? "1 to" : "at most"} ${max} lower-case slugs`);
      return [];
    }
    const out: string[] = [];
    v.forEach((item, k) => {
      const w = `${where}[${k}]`;
      const t = text(item, w);
      if (t === undefined) return;
      if (!SKILL_ID_RE.test(t)) add(w, SLUG_MESSAGE);
      else if (out.includes(t)) add(w, `"${t}" is listed twice`);
      else {
        out.push(t);
        at?.push(k);
      }
    });
    return out;
  };

  /** A list of names: a slug or an environment variable name, never a value. */
  const nameList = (v: unknown, where: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_PROFILE_LIST) {
      add(where, `must be a list of at most ${MAX_PROFILE_LIST} names`);
      return [];
    }
    const out: string[] = [];
    v.forEach((item, k) => {
      const w = `${where}[${k}]`;
      const t = text(item, w);
      if (t === undefined) return;
      if (!SKILL_ID_RE.test(t) && !ENV_NAME_RE.test(t)) add(w, "must be a name (a lower-case slug or an environment variable name like DATABASE_URL), never a value");
      else if (out.includes(t)) add(w, "is listed twice");
      else out.push(t);
    });
    return out;
  };

  const exclusive = slugList(raw.exclusive, "exclusive", MAX_PROFILE_SOURCES, false);

  const entries = raw.sources;
  if (!Array.isArray(entries)) {
    add("sources", "must be a list of sources");
    return { problems };
  }
  if (entries.length > MAX_PROFILE_SOURCES) {
    add("sources", `must hold at most ${MAX_PROFILE_SOURCES} sources`);
    return { problems };
  }

  const out: SourceProfile[] = [];
  const ids = new Map<string, number>();
  const used = new Map<string, { class: ProfileClass; where: string }>();

  entries.forEach((e, i) => {
    const base = `sources[${i}]`;
    if (!isObject(e)) {
      add(base, "must be a map");
      return;
    }
    let tag = base;
    if (typeof e.id === "string" && SKILL_ID_RE.test(e.id) && !credentialProblem(e.id)) tag = `${base} (${e.id})`;
    for (const k of Object.keys(e)) if (!["id", "skills"].includes(k)) add(tag, `unknown key "${shownName(k)}"`);

    const id = text(e.id, `${tag} id`);
    if (id !== undefined) {
      if (!SKILL_ID_RE.test(id)) add(`${tag} id`, SLUG_MESSAGE);
      else if (ids.has(id)) add(`${tag} id`, `id "${id}" is already used by sources[${ids.get(id)}]`);
      else ids.set(id, i);
    }

    const skills: SkillProfile[] = [];
    const names = new Map<string, number>();
    if (e.skills === undefined) add(`${tag} skills`, "is required");
    else if (!Array.isArray(e.skills) || e.skills.length === 0 || e.skills.length > MAX_PROFILE_SKILLS) {
      add(`${tag} skills`, `must be a list of 1 to ${MAX_PROFILE_SKILLS} skills`);
    } else {
      e.skills.forEach((s, j) => {
        const sbase = `${tag} skills[${j}]`;
        if (!isObject(s)) {
          add(sbase, "must be a map");
          return;
        }
        let stag = sbase;
        if (typeof s.name === "string" && SKILL_ID_RE.test(s.name) && !credentialProblem(s.name)) stag = `${sbase} (${s.name})`;
        for (const k of Object.keys(s)) {
          if (!["name", "class", "capabilities", "high_risk", "requires", "evaluations"].includes(k)) add(stag, `unknown key "${shownName(k)}"`);
        }
        const name = text(s.name, `${stag} name`);
        if (name !== undefined) {
          if (!SKILL_ID_RE.test(name)) add(`${stag} name`, SLUG_MESSAGE);
          else if (names.has(name)) add(`${stag} name`, `name "${name}" is already used by skills[${names.get(name)}]`);
          else names.set(name, j);
        }

        let cls: ProfileClass | undefined;
        if (s.class === undefined) add(`${stag} class`, "is required");
        else if ((PROFILE_CLASSES as readonly unknown[]).includes(s.class)) cls = s.class as ProfileClass;
        else add(`${stag} class`, `must be one of ${listText(PROFILE_CLASSES)}`);

        const capAt: number[] = [];
        const riskAt: number[] = [];
        const capabilities = slugList(s.capabilities, `${stag} capabilities`, MAX_PROFILE_CAPABILITIES, true, capAt);
        const highRisk = slugList(s.high_risk, `${stag} high_risk`, MAX_PROFILE_CAPABILITIES, false, riskAt);
        highRisk.forEach((h, n) => {
          if (!capabilities.includes(h)) add(`${stag} high_risk[${riskAt[n]}]`, `"${h}" is not one of the skill's capabilities`);
        });
        if (cls) {
          capabilities.forEach((c, n) => {
            const k = capAt[n];
            const first = used.get(c);
            if (!first) used.set(c, { class: cls!, where: stag });
            else if (first.class !== cls) {
              add(`${stag} capabilities[${k}]`, `capability "${c}" is also used by a ${first.class} skill (${first.where}); portable and vendor skills need separate capability ids`);
            }
          });
        }

        const requires = { config: [] as string[], tools: [] as ProfileTool[], connectors: [] as string[], live_services: [] as string[] };
        const rw = `${stag} requires`;
        if (s.requires !== undefined) {
          if (!isObject(s.requires)) add(rw, "must be a map");
          else {
            const r = s.requires;
            for (const k of Object.keys(r)) if (!["config", "tools", "connectors", "live_services"].includes(k)) add(rw, `unknown key "${shownName(k)}"`);
            requires.config = nameList(r.config, `${rw} config`);
            requires.live_services = nameList(r.live_services, `${rw} live_services`);
            requires.connectors = slugList(r.connectors, `${rw} connectors`, MAX_PROFILE_LIST, false);
            if (r.tools !== undefined) {
              if (!Array.isArray(r.tools) || r.tools.length > MAX_PROFILE_LIST) add(`${rw} tools`, `must be a list of at most ${MAX_PROFILE_LIST} tools`);
              else {
                r.tools.forEach((item, k) => {
                  const w = `${rw} tools[${k}]`;
                  const t = text(item, w);
                  if (t === undefined) return;
                  if (!(PROFILE_TOOLS as readonly string[]).includes(t)) add(w, `unknown tool "${shownName(t)}"; allowed: ${listText(PROFILE_TOOLS)}`);
                  else if (requires.tools.includes(t as ProfileTool)) add(w, `"${t}" is listed twice`);
                  else requires.tools.push(t as ProfileTool);
                });
              }
            }
          }
        }
        const evaluations = slugList(s.evaluations, `${stag} evaluations`, MAX_PROFILE_LIST, false);

        if (name !== undefined && cls !== undefined) skills.push({ name, class: cls, capabilities, high_risk: highRisk, requires, evaluations });
      });
    }
    if (id !== undefined) out.push({ id, skills });
  });

  if (problems.length) return { problems };
  return { profiles: { schema: 1, exclusive, sources: out }, problems };
}

const fail = (message: string): SourceProfilesRead => ({ state: "invalid", problems: [problem("file", message)] });
const safeCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** Reads the file safely (no links, no special files, size limit), then parseSourceProfiles. No message repeats a path or file content. */
export function readSourceProfiles(path: string, maxBytes = MAX_SOURCES_BYTES): SourceProfilesRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
    return c === "ENOENT" ? { state: "none" } : fail(`cannot be read (${safeCode(e)})`);
  }
  if (st.isSymbolicLink()) return fail("is a symbolic link");
  if (!st.isFile()) return fail("is not a readable regular file");
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, maxBytes);
  } catch (e) {
    return fail(`cannot be read (${safeCode(e)})`);
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
  const r = parseSourceProfiles(doc);
  return r.profiles ? { state: "ok", profiles: r.profiles } : { state: "invalid", problems: r.problems };
}
