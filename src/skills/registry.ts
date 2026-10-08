import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { dataHome } from "../auth/store.js";
import { addSkillPins, parseSkillKey, readSkillLock, SkillLockError, type SkillPin } from "./lock.js";
import { loadSkillPackage, SkillPackageError, type SkillIssue } from "./package.js";
import { SKILL_DIGEST_RE, type SkillPackage } from "./schema.js";

export type SkillSourceKind = "admin" | "builtin" | "repository";
export interface SkillSource {
  kind: SkillSourceKind;
  /** `built-in`, `data folder`, `skills.roots[1]` or `repository`. Never a path. */
  label: string;
  root: string;
  /** A missing folder is not a problem. */
  optional: boolean;
}
export interface SkillSourceReport extends SkillSource {
  status: "ok" | "missing" | "unreadable" | "refused" | "disabled";
  packages: number;
}
/** `approved`: administrator folders. `builtin`: ships with the release. `unapproved`: the repository, never selectable. */
export type SkillTrust = "approved" | "builtin" | "unapproved";
/** `unverified`: the lock cannot be read. */
export type SkillPinState = "pinned" | "unpinned" | "mismatch" | "unverified";
export interface SkillIntegrityFailure {
  id: string;
  version: string;
  source: SkillSourceKind;
  label: string;
  expected: string;
  actual: string;
}
export interface RegisteredSkill {
  key: string;
  id: string;
  version: string;
  source: SkillSourceKind;
  label: string;
  dir: string;
  active: boolean;
  shadowedBy?: string;
  trust: SkillTrust;
  pin: SkillPinState;
  digest: string;
  pkg: SkillPackage;
}
export interface SkillProblem {
  kind: "root-missing" | "root-unreadable" | "root-refused" | "invalid-package" | "duplicate" | "too-many" | "integrity" | "lock";
  source: SkillSourceKind;
  label: string;
  root: string;
  package?: string;
  reason: string;
  issues?: SkillIssue[];
  integrity?: SkillIntegrityFailure;
}
export interface SkillNote {
  kind: "shadowed" | "repository-disabled";
  label: string;
  package?: string;
  text: string;
}
export interface SkillRegistry {
  /** Every registered package, keyed by `id@version`. */
  byKey: ReadonlyMap<string, RegisteredSkill>;
  /** The same packages ordered by id, then source precedence, then version. */
  skills: RegisteredSkill[];
  problems: SkillProblem[];
  notes: SkillNote[];
  sources: SkillSourceReport[];
}
export interface DiscoverOptions {
  repo?: string;
  home?: string;
  builtinRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** The user's home folder (where ~/.claude and ~/.codex live). */
  userHome?: string;
  /** For tests: a lower registry-wide package limit. */
  limits?: { skills?: number };
}

export const BUILTIN_SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
export const MAX_SKILLS_PER_ROOT = 500;
/** Across all roots: packages kept, and bytes of package files kept in memory. */
export const MAX_SKILLS_TOTAL = 1000;
export const MAX_SKILL_BYTES_TOTAL = 64 * 1024 * 1024;

const PERSONAL = new Set([".claude", ".codex"]);

const inside = (p: string, base: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** The personal agent folders: the defaults and the ones the environment names, as written and as resolved. */
function personalRoots(env: NodeJS.ProcessEnv, userHome: string): string[] {
  const list = [join(userHome, ".claude"), join(userHome, ".codex")];
  if (env.CLAUDE_CONFIG_DIR) list.push(resolve(env.CLAUDE_CONFIG_DIR));
  if (env.CODEX_HOME) list.push(resolve(env.CODEX_HOME));
  return [...new Set(list.flatMap((p) => [p, real(p)].filter((x): x is string => !!x)))];
}

/** True for a path in a personal Claude or Codex folder: a `.claude`/`.codex` segment, or inside CLAUDE_CONFIG_DIR, CODEX_HOME or the default folders. Lexical, and also on the resolved path when it exists. */
export function personalAgentPath(p: string, env: NodeJS.ProcessEnv = process.env, userHome = homedir()): boolean {
  const abs = resolve(p);
  const forms = [abs, real(abs)].filter((x): x is string => !!x);
  const roots = personalRoots(env, userHome);
  return forms.some((f) => f.split(/[\\/]/).some((s) => PERSONAL.has(s)) || roots.some((r) => inside(f, r)));
}

export function skillSources(skills: Config["skills"], opts: DiscoverOptions = {}): SkillSource[] {
  const list: SkillSource[] = [{ kind: "admin", label: "data folder", root: join(opts.home ?? dataHome(), "skills"), optional: true }];
  skills.roots.forEach((root, i) => list.push({ kind: "admin", label: `skills.roots[${i}]`, root, optional: false }));
  if (skills.builtin) list.push({ kind: "builtin", label: "built-in", root: opts.builtinRoot ?? BUILTIN_SKILLS, optional: false });
  if (opts.repo) list.push({ kind: "repository", label: "repository", root: join(opts.repo, ".claude-factory", "skills"), optional: true });
  return list;
}

const TRUST: Record<SkillSourceKind, SkillTrust> = { admin: "approved", builtin: "builtin", repository: "unapproved" };

const code = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
const cut = (s: string) => (s.length > 300 ? s.slice(0, 299) + "…" : s);

function packageBytes(p: SkillPackage): number {
  let n = p.instructions.length;
  for (const list of Object.values(p.files)) for (const f of list) n += f.content.byteLength;
  return n;
}

/** Reads every source and builds the registry. Never throws for a file system problem: it becomes a problem entry. Not cached. */
export function discoverSkills(skills: Config["skills"], opts: DiscoverOptions = {}): SkillRegistry {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? homedir();
  const problems: SkillProblem[] = [];
  const notes: SkillNote[] = [];
  const reports: SkillSourceReport[] = [];
  const found: RegisteredSkill[] = [];
  let bytes = 0;
  let stopped = false;

  for (const src of skillSources(skills, opts)) {
    const report: SkillSourceReport = { ...src, status: "ok", packages: 0 };
    reports.push(report);
    const base = { source: src.kind, label: src.label, root: src.label };
    const fail = (kind: SkillProblem["kind"], status: SkillSourceReport["status"], reason: string) => {
      report.status = status;
      problems.push({ kind, ...base, reason });
    };

    if (src.kind === "repository" && !skills.repository) {
      report.status = "disabled";
      try {
        if (lstatSync(src.root).isDirectory()) notes.push({ kind: "repository-disabled", label: src.label, text: "The repository has skills, but skills.repository is off, so they are not loaded." });
      } catch {
        // nothing there
      }
      continue;
    }
    if (personalAgentPath(src.root, env, userHome)) {
      fail("root-refused", "refused", "personal agent folders are never scanned");
      continue;
    }
    let names: string[];
    const dirs = new Map<string, boolean>();
    try {
      let st;
      try {
        st = statSync(src.root);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          if (src.optional) report.status = "missing";
          else fail("root-missing", "missing", "the folder does not exist");
          continue;
        }
        throw e;
      }
      if (!st.isDirectory()) {
        fail("root-unreadable", "unreadable", "not a folder");
        continue;
      }
      const list = readdirSync(src.root, { withFileTypes: true });
      for (const d of list) {
        if (d.name.startsWith(".")) continue;
        if (d.isSymbolicLink()) dirs.set(d.name, true);
        else if (d.isDirectory()) dirs.set(d.name, false);
      }
      names = [...dirs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch (e) {
      fail("root-unreadable", "unreadable", code(e));
      continue;
    }

    if (names.length > MAX_SKILLS_PER_ROOT) {
      problems.push({ kind: "too-many", ...base, reason: `more than ${MAX_SKILLS_PER_ROOT} folders; the rest are not read` });
      names = names.slice(0, MAX_SKILLS_PER_ROOT);
    }
    for (const name of names) {
      const dir = join(src.root, name);
      const bad = (reason: string, issues?: SkillIssue[]) =>
        problems.push({ kind: "invalid-package", ...base, package: name, reason: cut(reason), ...(issues ? { issues } : {}) });
      if (dirs.get(name)) {
        bad("symbolic link, not scanned");
        continue;
      }
      if (stopped) continue;
      if (found.length >= (opts.limits?.skills ?? MAX_SKILLS_TOTAL) || bytes >= MAX_SKILL_BYTES_TOTAL) {
        stopped = true;
        problems.push({ kind: "too-many", ...base, reason: `the registry limit (${MAX_SKILLS_TOTAL} packages or ${MAX_SKILL_BYTES_TOTAL / 1048576} MiB) is reached; the rest are not read` });
        continue;
      }
      try {
        const pkg = loadSkillPackage(dir);
        bytes += packageBytes(pkg);
        found.push({ key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: src.kind, label: src.label, dir, active: false, trust: TRUST[src.kind], pin: "unpinned", digest: pkg.digest, pkg });
        report.packages++;
      } catch (e) {
        if (e instanceof SkillPackageError) bad(e.issues.slice(0, 3).map((i) => `${i.path}: ${i.reason}`).join("; ") || "invalid package", e.issues);
        else bad(code(e));
      }
    }
  }

  // Sources were visited in precedence order, so the first sight of a key wins.
  const byKey = new Map<string, RegisteredSkill>();
  for (const s of found) {
    const have = byKey.get(s.key);
    if (have) {
      problems.push({ kind: "duplicate", source: s.source, label: s.label, root: s.label, package: s.id, reason: `${s.key} is already provided by ${have.label}; this copy is ignored` });
      continue;
    }
    byKey.set(s.key, s);
  }
  // Pins are looked up by key alone: the source does not matter, only the bytes.
  const lock = readSkillLock(opts.home ?? dataHome());
  if (!lock.ok) problems.push({ kind: "lock", source: "admin", label: "skill lock", root: "skill lock", reason: `the skill lock ${lock.reason}; approved and built-in skills cannot be verified` });
  for (const s of byKey.values()) {
    if (s.trust === "unapproved") continue;
    if (!lock.ok) {
      s.pin = "unverified";
      continue;
    }
    const pin: SkillPin | undefined = lock.pins[s.key];
    if (!pin) continue;
    if (pin.digest === s.digest) {
      s.pin = "pinned";
      continue;
    }
    s.pin = "mismatch";
    const integrity: SkillIntegrityFailure = { id: s.id, version: s.version, source: s.source, label: s.label, expected: pin.digest, actual: s.digest };
    problems.push({
      kind: "integrity",
      source: s.source,
      label: s.label,
      root: s.label,
      package: s.id,
      reason: `${s.key} (${s.source}, ${s.label}) does not match its pin (pinned ${pin.digest}, actual ${s.digest})`,
      integrity,
    });
  }
  const winner = new Map<string, RegisteredSkill>();
  for (const s of byKey.values()) if (!winner.has(s.id)) winner.set(s.id, s);
  for (const s of byKey.values()) {
    const w = winner.get(s.id)!;
    if (s === w) s.active = true;
    else {
      s.shadowedBy = w.key;
      notes.push({ kind: "shadowed", label: s.label, package: s.id, text: `${s.key} (${s.label}) is shadowed by ${w.key} (${w.label}).` });
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Map order is discovery order: the precedence of the source, then the folder name.
  const skillsList = [...byKey.values()].map((s, i) => ({ s, i })).sort((a, b) => cmp(a.s.id, b.s.id) || a.i - b.i).map((x) => x.s);
  return { byKey, skills: skillsList, problems, notes, sources: reports };
}

/** The active entry of an id, or the exact `id@version`. */
export function findSkill(reg: SkillRegistry, id: string, version?: string): RegisteredSkill | undefined {
  if (version !== undefined) return reg.byKey.get(`${id}@${version}`);
  return reg.skills.find((s) => s.id === id && s.active);
}

export type SkillSelectCode = "unknown" | "unapproved" | "unverified" | "unpinned" | "mismatch";
export class SkillSelectError extends Error {
  constructor(
    public code: SkillSelectCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillSelectError";
  }
}
export class SkillIntegrityError extends SkillSelectError {
  constructor(public failure: SkillIntegrityFailure) {
    super("mismatch", `${failure.id}@${failure.version} does not match its pin (pinned ${failure.expected}, actual ${failure.actual})`);
    this.name = "SkillIntegrityError";
  }
}

/**
 * The gate for a run: the entry for this exact `id@version` if it is approved or built-in and its bytes match the pin.
 * Never falls back to another version or to the active entry. Nothing calls it yet.
 */
export function selectSkill(reg: SkillRegistry, id: string, version: string): RegisteredSkill {
  const s = version ? reg.byKey.get(`${id}@${version}`) : undefined;
  if (!s) throw new SkillSelectError("unknown", `no skill ${id}@${version}`);
  if (s.trust === "unapproved") throw new SkillSelectError("unapproved", `${s.key} comes from the repository and cannot be selected`);
  if (s.pin === "unverified") throw new SkillSelectError("unverified", `${s.key} cannot be verified: the skill lock cannot be read`);
  if (s.pin === "mismatch") {
    const failure = reg.problems.find((p) => p.kind === "integrity" && p.integrity?.id === s.id && p.integrity.version === s.version)?.integrity;
    throw new SkillIntegrityError(failure ?? { id: s.id, version: s.version, source: s.source, label: s.label, expected: "", actual: s.digest });
  }
  if (s.pin === "unpinned") throw new SkillSelectError("unpinned", `${s.key} is not pinned; run "scf skills pin ${s.key} ${s.digest}"`);
  return s;
}

export type SkillPinErrorCode = "bad-key" | "bad-digest" | "unknown" | "unapproved" | "digest-mismatch" | "already-pinned";
export class SkillPinError extends Error {
  constructor(
    public code: SkillPinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillPinError";
  }
}

export interface PinOptions {
  replace?: boolean;
  now?: Date;
  waitMs?: number;
}

function lockProblem(reg: SkillRegistry): void {
  const p = reg.problems.find((x) => x.kind === "lock");
  if (p) throw new SkillLockError("unreadable", p.reason);
}

/** Pins one listed skill. The digest must be the one of the entry in `reg`. A repository skill is never pinned. */
export function pinSkill(reg: SkillRegistry, key: string, digest: string, opts: PinOptions = {}): "pinned" | "unchanged" | "replaced" {
  if (!parseSkillKey(key)) throw new SkillPinError("bad-key", `${key} is not a skill key (id@version)`);
  if (!SKILL_DIGEST_RE.test(digest)) throw new SkillPinError("bad-digest", "the digest must be sha256: and 64 hex digits");
  const s = reg.byKey.get(key);
  if (!s) throw new SkillPinError("unknown", `no skill ${key} is listed`);
  if (s.trust === "unapproved") throw new SkillPinError("unapproved", `${key} comes from the repository and cannot be pinned`);
  if (s.digest !== digest) throw new SkillPinError("digest-mismatch", `${key} has the digest ${s.digest}, not the one given`);
  lockProblem(reg);
  const r = addSkillPins([{ key, digest }], opts);
  if (r.kept.length) throw new SkillPinError("already-pinned", `${key} is pinned with another digest; use --replace after you checked the package`);
  return r.added.length ? "pinned" : r.replaced.length ? "replaced" : "unchanged";
}

export interface BuiltinPinResult {
  pinned: string[];
  /** Built-in skills whose pin has another digest. They are not changed. */
  mismatched: string[];
}

/** Pins every built-in skill that has no pin. Never replaces a pin. Throws when the lock cannot be read. */
export function pinBuiltinSkills(reg: SkillRegistry, opts: PinOptions = {}): BuiltinPinResult {
  lockProblem(reg);
  const list = [...reg.byKey.values()].filter((s) => s.source === "builtin").map((s) => ({ key: s.key, digest: s.digest }));
  const r = addSkillPins(list, { now: opts.now, waitMs: opts.waitMs });
  return { pinned: r.added, mismatched: r.kept };
}

/** Pins the built-in skills when the server starts. Only logs: a problem here must not stop the server. */
export function pinBuiltinSkillsAtStart(skills: Config["skills"], log: (line: string) => void, opts: DiscoverOptions & { waitMs?: number } = {}): void {
  try {
    const r = pinBuiltinSkills(discoverSkills(skills, opts), { waitMs: opts.waitMs ?? 500 });
    if (r.pinned.length) log(`pinned the built-in skills: ${r.pinned.join(", ")}`);
    if (r.mismatched.length) log(`warning: these built-in skills do not match their pin and were not changed: ${r.mismatched.join(", ")}. Run "scf skills" to see both digests.`);
  } catch (e) {
    log(`warning: the built-in skills were not pinned: ${(e as Error).message}`);
  }
}

let cache: { key: string; at: number; reg: SkillRegistry } | undefined;

/** Like discoverSkills, kept for a minute: health asks every 30 seconds. */
export function cachedSkillRegistry(skills: Config["skills"], now = Date.now(), maxAgeMs = 60_000, opts: DiscoverOptions = {}): SkillRegistry {
  const key = JSON.stringify(skills) + "\0" + (opts.home ?? dataHome()) + "\0" + (opts.repo ?? "");
  if (cache && cache.key === key && now - cache.at >= 0 && now - cache.at < maxAgeMs) return cache.reg;
  const reg = discoverSkills(skills, opts);
  cache = { key, at: now, reg };
  return reg;
}

export function clearSkillRegistryCache(): void {
  cache = undefined;
}
