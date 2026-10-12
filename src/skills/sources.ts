import { lstatSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseRepoUrl, RepoError } from "../auth/repo-url.js";
import { credentialProblem } from "./credential-scan.js";
import { readRegular } from "./package.js";
import { relativePathProblem, SKILL_ID_RE } from "./schema.js";

export const SOURCES_FILE = "skill-sources.yaml";
export const MAX_SOURCES_BYTES = 262144;
export const MAX_SOURCES = 200;
export const SOURCE_STATUSES = ["enabled", "disabled", "quarantined", "retired"] as const;
/** Adapters know how a library is laid out. "agent-skills": folders with a SKILL.md. */
export const SOURCE_ADAPTERS = ["agent-skills"] as const;
export const SOURCE_TRUST_TIERS = ["first-party", "verified", "community"] as const;
export const SOURCE_CADENCES = ["manual", "daily", "weekly", "monthly"] as const;
export const SOURCE_LICENCES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0", "CC-BY-4.0", "Unlicense"] as const;

export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type SourceTrustTier = (typeof SOURCE_TRUST_TIERS)[number];

export interface SkillLibrarySource {
  id: string;
  /** Normalised https URL. */
  repository: string;
  /** Equal for every way of writing the repository, e.g. github.com/example/skills. */
  repositoryKey: string;
  status: SourceStatus;
  reason?: string;
  ref: { track?: string; approved?: string };
  paths: string[];
  adapter: (typeof SOURCE_ADAPTERS)[number];
  trust: SourceTrustTier;
  licence: { allow: string[] };
  update: { cadence: (typeof SOURCE_CADENCES)[number] };
  owner: string;
}
export interface SourcesManifest {
  schema: 1;
  sources: SkillLibrarySource[];
}
export interface SourceProblem {
  where: string;
  message: string;
}
export type SourcesRead = { state: "none" } | { state: "invalid"; problems: SourceProblem[] } | { state: "ok"; manifest: SourcesManifest };

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** True when the text holds a control, format or line-separator character. */
export const hasUnsafeChar = (s: string): boolean => UNSAFE.test(s);
const UNSAFE_G = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TRACK_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const OWNER_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const SHOWN_MAX = 80;

const escapeUnsafe = (s: string) => s.replace(UNSAFE_G, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
const list = (a: readonly string[]) => a.join(", ");

/** The one way to make a problem: nothing in it is credential-like or unsafe to print. */
function problem(where: string, message: string): SourceProblem {
  const rule = credentialProblem(message);
  const m = rule ? `holds what looks like a credential (${rule})` : message;
  return { where: escapeUnsafe(where), message: escapeUnsafe(m) };
}

/** A value from the file, safe to print: hidden when it looks like a credential, unsafe characters escaped, cut to 80. */
export function shownValue(value: string): string {
  if (credentialProblem(value)) return "(hidden)";
  const s = escapeUnsafe(value);
  return s.length > SHOWN_MAX ? s.slice(0, SHOWN_MAX) + "…" : s;
}

/** Undefined for a full commit id, else why it cannot name an approved release. */
export function approvedRefProblem(ref: string): string | undefined {
  if (COMMIT_RE.test(ref)) return undefined;
  return 'must be a full commit id (40 or 64 hex digits). A branch or tag such as "main" can move: put it in ref.track';
}

/** Undefined for a branch or tag name that git accepts, else the reason. */
export function trackRefProblem(ref: string): string | undefined {
  if (COMMIT_RE.test(ref)) return "is a commit id; put it in ref.approved";
  const bad = "is not a branch or tag name git accepts";
  if (!TRACK_RE.test(ref)) return bad;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.endsWith(".")) return bad;
  if (ref.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))) return bad;
  return undefined;
}

/** Undefined for an upstream folder path, else the reason. "." is the repository root. */
export function sourcePathProblem(path: string): string | undefined {
  if (path === ".") return undefined;
  if (path.length > 200) return "is longer than 200 characters";
  if (/[*?[\]{}]/.test(path)) return "globs are not allowed; list each folder";
  if (relativePathProblem(path)) return "path leaves the repository or is not a plain relative path";
  if (path.split("/").some((s) => s.toLowerCase() === ".git")) return "path leaves the repository or is not a plain relative path";
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks parsed YAML. Never throws. No problem holds a credential-like value or a control character. */
export function parseSources(raw: unknown): { manifest?: SourcesManifest; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  if (!isObject(raw)) {
    add("file", "must be a map with schema and sources");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (k !== "schema" && k !== "sources") add("file", `unknown key "${shownValue(k)}"`);
  if (raw.schema !== 1) add("schema", "schema must be 1");
  const entries = raw.sources;
  if (!Array.isArray(entries) || entries.length < 1) {
    add("sources", "must be a list with at least one source");
    return { problems };
  }
  if (entries.length > MAX_SOURCES) {
    add("sources", `must hold at most ${MAX_SOURCES} sources`);
    return { problems };
  }

  const out: SkillLibrarySource[] = [];
  const ids = new Map<string, number>();
  entries.forEach((e, i) => {
    const base = `sources[${i}]`;
    if (!isObject(e)) {
      add(base, "must be a map");
      return;
    }
    let tag = base;
    const idRaw = e.id;
    if (typeof idRaw === "string" && SKILL_ID_RE.test(idRaw) && !credentialProblem(idRaw)) tag = `${base} (${idRaw})`;
    const err = (field: string, message: string) => add(field ? `${tag} ${field}` : tag, message);

    /** A text value: undefined (and a problem) when it is missing, not text, unsafe or credential-like. */
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
      if (UNSAFE.test(v)) {
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
    const known = <T extends string>(v: string | undefined, field: string, set: readonly T[], msg: string): T | undefined => {
      if (v === undefined) return undefined;
      if ((set as readonly string[]).includes(v)) return v as T;
      err(field, msg);
      return undefined;
    };
    const keys = (o: Record<string, unknown>, allowed: string[], field: string) => {
      for (const k of Object.keys(o)) if (!allowed.includes(k)) err(field, `unknown key "${shownValue(k)}"`);
    };
    const sub = (v: unknown, field: string): Record<string, unknown> | undefined => {
      if (v === undefined) {
        err(field, "is required");
        return undefined;
      }
      if (!isObject(v)) {
        err(field, "must be a map");
        return undefined;
      }
      return v;
    };

    keys(e, ["id", "repository", "status", "reason", "ref", "paths", "adapter", "trust", "licence", "update", "owner"], "");

    // id
    const id = text(idRaw, "id");
    if (id !== undefined) {
      if (!SKILL_ID_RE.test(id)) err("id", "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)");
      else if (ids.has(id)) err("id", `id "${shownValue(id)}" is already used by sources[${ids.get(id)}]`);
      else ids.set(id, i);
    }

    // repository
    let repository: string | undefined;
    let repositoryKey: string | undefined;
    const repo = text(e.repository, "repository");
    if (repo !== undefined) {
      const why = "must be an https:// address of a git repository, like https://github.com/owner/name";
      if (!repo.startsWith("https://")) err("repository", why);
      else {
        try {
          const p = parseRepoUrl(repo);
          if (p.scheme !== "https" || p.url.includes("@")) err("repository", why);
          else {
            repository = p.url;
            repositoryKey = p.key;
          }
        } catch (x) {
          err("repository", x instanceof RepoError ? x.message : why);
        }
      }
    }

    // status and reason
    const status = known(text(e.status, "status"), "status", SOURCE_STATUSES, `must be one of ${list(SOURCE_STATUSES)}`);
    const reasonRaw = text(e.reason, "reason", false);
    let reason: string | undefined;
    if (reasonRaw !== undefined) {
      const r = reasonRaw.trim();
      if (r.length < 1 || r.length > 300) err("reason", "must be 1 to 300 characters");
      else reason = r;
    }
    if (status === "enabled" && e.reason !== undefined) err("reason", "an enabled source has no reason");
    if (status && status !== "enabled" && e.reason == null) err("reason", `a ${status} source needs a reason`);

    // update
    let cadence: SkillLibrarySource["update"]["cadence"] | undefined;
    const upd = sub(e.update, "update");
    if (upd) {
      keys(upd, ["cadence"], "update");
      cadence = known(text(upd.cadence, "update.cadence"), "update.cadence", SOURCE_CADENCES, `must be one of ${list(SOURCE_CADENCES)}`);
    }

    // ref
    const ref: { track?: string; approved?: string } = {};
    const refObj = e.ref === undefined ? {} : isObject(e.ref) ? e.ref : undefined;
    if (!refObj) err("ref", "must be a map");
    else {
      keys(refObj, ["track", "approved"], "ref");
      const approved = text(refObj.approved, "ref.approved", false);
      if (approved !== undefined) {
        const why = approvedRefProblem(approved);
        if (why) err("ref.approved", why);
        else ref.approved = approved;
      }
      const track = text(refObj.track, "ref.track", false);
      if (track !== undefined) {
        const why = trackRefProblem(track);
        if (why) err("ref.track", why);
        else ref.track = track;
      }
      if (status === "enabled" && refObj.approved == null) err("ref.approved", "an enabled source needs ref.approved");
      if (cadence && cadence !== "manual" && refObj.track == null) {
        err("ref.track", `cadence "${cadence}" needs ref.track (the branch or tag to watch)`);
      }
    }

    // paths
    const paths: string[] = [];
    if (!Array.isArray(e.paths) || e.paths.length < 1 || e.paths.length > 20) {
      err("paths", e.paths === undefined ? "is required" : "must be a list of 1 to 20 folders");
    } else {
      e.paths.forEach((pv, j) => {
        const p = text(pv, `paths[${j}]`);
        if (p === undefined) return;
        const why = sourcePathProblem(p);
        if (why) err(`paths[${j}]`, why);
        else paths.push(p);
      });
      const seen = new Set<string>();
      for (const p of paths) {
        if (seen.has(p)) err("paths", `"${shownValue(p)}" is listed twice`);
        seen.add(p);
      }
      if (paths.includes(".") && paths.length > 1) err("paths", '"." (the root) must be alone');
      for (const a of paths) {
        for (const b of paths) {
          if (a !== b && a !== "." && b !== "." && a.startsWith(b + "/")) err("paths", `"${shownValue(a)}" is inside "${shownValue(b)}"`);
        }
      }
    }

    // adapter, trust
    const adapterRaw = text(e.adapter, "adapter");
    const adapter = known(adapterRaw, "adapter", SOURCE_ADAPTERS, `unknown adapter "${shownValue(adapterRaw ?? "")}"; known: ${list(SOURCE_ADAPTERS)}`);
    const trust = known(text(e.trust, "trust"), "trust", SOURCE_TRUST_TIERS, `must be one of ${list(SOURCE_TRUST_TIERS)}`);

    // licence
    const allow: string[] = [];
    const lic = sub(e.licence, "licence");
    if (lic) {
      keys(lic, ["allow"], "licence");
      if (!Array.isArray(lic.allow) || lic.allow.length < 1 || lic.allow.length > 20) {
        err("licence.allow", lic.allow === undefined ? "is required" : "must be a list of 1 to 20 licences");
      } else {
        lic.allow.forEach((lv, j) => {
          const l = text(lv, `licence.allow[${j}]`);
          if (l === undefined) return;
          if (!(SOURCE_LICENCES as readonly string[]).includes(l)) {
            err(`licence.allow[${j}]`, `"${shownValue(l)}" is not an accepted licence; accepted: ${list(SOURCE_LICENCES)}`);
          } else if (allow.includes(l)) err(`licence.allow[${j}]`, `"${l}" is listed twice`);
          else allow.push(l);
        });
      }
    }

    // owner
    const owner = text(e.owner, "owner");
    if (owner !== undefined && !OWNER_RE.test(owner)) err("owner", "must be a GitHub user or team like @octocat or @acme/skills");

    if (id !== undefined && repository && repositoryKey && status && cadence && adapter && trust && owner !== undefined && OWNER_RE.test(owner)) {
      out.push({
        id,
        repository,
        repositoryKey,
        status,
        ...(reason !== undefined ? { reason } : {}),
        ref,
        paths,
        adapter,
        trust,
        licence: { allow },
        update: { cadence },
        owner,
      });
    }
  });
  if (problems.length) return { problems };
  return { manifest: { schema: 1, sources: out }, problems };
}

/** The ones an importer or update check may use: only `enabled`. */
export function usableSources(m: SourcesManifest): SkillLibrarySource[] {
  return m.sources.filter((s) => s.status === "enabled");
}

const fail = (message: string): SourcesRead => ({ state: "invalid", problems: [problem("file", message)] });

/** Reads the file safely (no links, no special files, size limit), then parseSources. No message repeats a path or file content. */
export function readSources(path: string, maxBytes = MAX_SOURCES_BYTES): SourcesRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
    return c === "ENOENT" ? { state: "none" } : fail(`cannot be read (${c.replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40)})`);
  }
  if (st.isSymbolicLink()) return fail("is a symbolic link");
  if (!st.isFile()) return fail("is not a readable regular file");
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, maxBytes);
  } catch (e) {
    return fail(`cannot be read (${String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40)})`);
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
  const r = parseSources(doc);
  return r.manifest ? { state: "ok", manifest: r.manifest } : { state: "invalid", problems: r.problems };
}
