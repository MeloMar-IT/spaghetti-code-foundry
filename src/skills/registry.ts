import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { dataHome } from "../auth/store.js";
import { addSkillPins, parseSkillKey, readSkillLock, SkillLockError, type SkillPin } from "./lock.js";
import { credentialProblem } from "./credential-scan.js";
import { quarantinePath } from "./import-stage.js";
import { loadSkillPackage, SkillPackageError, type SkillIssue } from "./package.js";
import { matchRelease, readRelease, releaseContentProblem, releaseProblemText, type ReleaseCheck, type ReleaseRead } from "./release.js";
import { listStoredReleases, releaseStorePath, storeSources, type StoreListing } from "./release-store.js";
import { verifyRelease } from "./release-verify.js";
import { SkillIntegrityError, SkillPinError, SkillSelectError, type SkillPinErrorCode, type SkillSelectCode } from "./registry-errors.js";
import { code, cut, packageBytes, personalAgentPath } from "./registry-util.js";
import { SKILL_DIGEST_RE, type SkillPackage } from "./schema.js";

export type SkillSourceKind = "admin" | "builtin" | "repository";
export interface SkillSource {
  kind: SkillSourceKind;
  /** `built-in`, `data folder`, `skills.roots[1]` or `repository`. Never a path. */
  label: string;
  root: string;
  /** A missing folder is not a problem. */
  optional: boolean;
  /** Set for an approved folder of the release store: its manifest must hold exactly this catalogue and version. */
  stored?: { catalogue: string; version: string };
}
export interface SkillSourceReport extends SkillSource {
  status: "ok" | "missing" | "unreadable" | "refused" | "disabled";
  packages: number;
  /** For administrator folders that could be listed. */
  release?: ReleaseCheck;
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
  kind: "shadowed" | "repository-disabled" | "revoked" | "unapproved-release" | "store-root" | "release-store";
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
  limits?: { skills?: number; bytes?: number };
}

export const BUILTIN_SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
export const MAX_SKILLS_PER_ROOT = 500;
/** Across all roots: packages kept, and bytes of package files kept in memory. */
export const MAX_SKILLS_TOTAL = 1000;
export const MAX_SKILL_BYTES_TOTAL = 64 * 1024 * 1024;

export { personalAgentPath };

/** Order: data folder, approved store releases (newest version first), skills.roots, built-in, repository. Store paths in skills.roots are skipped. */
function buildSources(skills: Config["skills"], opts: DiscoverOptions, listing: StoreListing): SkillSource[] {
  const home = opts.home ?? dataHome();
  const list: SkillSource[] = [{ kind: "admin", label: "data folder", root: join(home, "skills"), optional: true }];
  for (const s of storeSources(listing, skills.releases.approved).sources) list.push({ kind: "admin", optional: false, ...s });
  skills.roots.forEach((root, i) => {
    if (!releaseStorePath(root, home)) list.push({ kind: "admin", label: `skills.roots[${i}]`, root, optional: false });
  });
  if (skills.builtin) list.push({ kind: "builtin", label: "built-in", root: opts.builtinRoot ?? BUILTIN_SKILLS, optional: false });
  if (opts.repo) list.push({ kind: "repository", label: "repository", root: join(opts.repo, ".claude-factory", "skills"), optional: true });
  return list;
}

export function skillSources(skills: Config["skills"], opts: DiscoverOptions = {}): SkillSource[] {
  return buildSources(skills, opts, listStoredReleases(opts.home ?? dataHome()));
}

const TRUST: Record<SkillSourceKind, SkillTrust> = { admin: "approved", builtin: "builtin", repository: "unapproved" };

const refusal = (rel: ReleaseCheck) =>
  releaseProblemText(rel) +
  (rel.state === "none"
    ? ". Approve a release, or set skills.releases.allow_unreleased on a development install"
    : rel.state === "unsigned"
      ? '. Sign it with "scf skills release sign" and put key and signature in its skills.releases.approved entry'
      : "");

/** Administrator folders that are loaded without an approved release (development only). */
export function unreleasedSources(reg: Pick<SkillRegistry, "sources">): (SkillSourceReport & { release: ReleaseCheck })[] {
  return reg.sources.filter((r): r is SkillSourceReport & { release: ReleaseCheck } => r.kind === "admin" && !!r.release && r.release.state !== "approved" && r.packages > 0);
}

/** Reads every source and builds the registry. Never throws for a file system problem: it becomes a problem entry. Not cached. */
export function discoverSkills(skills: Config["skills"], opts: DiscoverOptions = {}): SkillRegistry {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? homedir();
  const home = opts.home ?? dataHome();
  const problems: SkillProblem[] = [];
  const notes: SkillNote[] = [];
  const reports: SkillSourceReport[] = [];
  const found: RegisteredSkill[] = [];
  /** `id@version` revoked by an approved schema-2 release, in any root: the security fix wins over every other copy. */
  const revokedKeys = new Map<string, string>();
  // Approved store releases are not held to the registry-wide limits (an old lock must stay valid, and they do not use up the room of the other roots). They are bounded by the approved list, MAX_SKILLS_PER_ROOT and verifyRelease.
  const budgets = { main: { n: 0, bytes: 0, stopped: false }, store: { n: 0, bytes: 0, stopped: false } };
  /** key + digest of packages already kept from an earlier store release: a later identical copy is not a duplicate. */
  const storeSeen = new Set<string>();

  const listing = listStoredReleases(home);
  const store = storeSources(listing, skills.releases.approved);
  for (const n of store.notes) notes.push({ kind: n.kind, label: "release store", text: n.text });
  skills.roots.forEach((root, i) => {
    if (releaseStorePath(root, home)) notes.push({ kind: "store-root", label: `skills.roots[${i}]`, text: `skills.roots[${i}] is inside the release store; published releases load through skills.releases.approved, so this entry is ignored. Remove it from skills.roots.` });
  });
  if (store.refused) problems.push({ kind: "root-refused", source: "admin", label: "release store", root: "release store", reason: store.refused });

  for (const src of buildSources(skills, opts, listing)) {
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
    if (quarantinePath(src.root, home)) {
      fail("root-refused", "refused", "the skill quarantine is never scanned");
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

    // Step 1 for an administrator folder: identity, before any package is read.
    let read: ReleaseRead | undefined;
    let rel: ReleaseCheck | undefined;
    const allow = skills.releases.allow_unreleased && !src.stored;
    const revokedIds = new Set<string>();
    if (src.kind === "admin") {
      read = readRelease(src.root);
      rel = report.release = matchRelease(read, skills.releases.approved, skills.releases.keys);
      // A store folder must hold exactly the schema-2 release its folder name says.
      if (src.stored) {
        const m = read.state === "ok" ? read.manifest : undefined;
        if (!m) {
          fail("root-refused", "refused", refusal(rel));
          continue;
        }
        if (m.schema !== 2 || m.catalogue !== src.stored.catalogue || m.version !== src.stored.version) {
          fail("root-refused", "refused", `the release folder does not hold ${src.stored.catalogue}@${src.stored.version}`);
          continue;
        }
      }
      // A broken schema-2 manifest is refused whatever allow_unreleased says.
      if (read.state === "invalid" && read.v2) {
        fail("root-refused", "refused", refusal(rel));
        continue;
      }
      // An approved release without a trusted signature is refused whatever allow_unreleased says.
      if (rel.state === "unsigned") {
        fail("root-refused", "refused", refusal(rel));
        continue;
      }
      // An empty folder without a manifest is not a problem.
      if (rel.state !== "approved" && !allow && !(rel.state === "none" && names.length === 0)) {
        fail("root-refused", "refused", refusal(rel));
        continue;
      }
      // Only an approved manifest can revoke: a writable folder cannot hide skills.
      if (read.state === "ok" && read.manifest.schema === 2 && rel.state === "approved") {
        for (const s of read.manifest.skills) {
          if (!s.revoked) continue;
          revokedIds.add(s.id);
          revokedKeys.set(`${s.id}@${s.version}`, `${read.manifest.catalogue}@${read.manifest.version} (${s.revoked.on})`);
        }
      }
    }
    const b = src.stored ? budgets.store : budgets.main;
    const mark = { found: found.length, ...b };
    let invalid = 0;
    let incomplete = false;

    if (names.length > MAX_SKILLS_PER_ROOT) {
      problems.push({ kind: "too-many", ...base, reason: `more than ${MAX_SKILLS_PER_ROOT} folders; the rest are not read` });
      names = names.slice(0, MAX_SKILLS_PER_ROOT);
      incomplete = true;
    }
    for (const name of names) {
      const dir = join(src.root, name);
      // A folder name that looks like a credential is not repeated in the problem list.
      const shown = credentialProblem(name) ? "(name not shown)" : name;
      const bad = (reason: string, issues?: SkillIssue[]) => {
        invalid++;
        problems.push({ kind: "invalid-package", ...base, package: shown, reason: cut(reason), ...(issues ? { issues } : {}) });
      };
      if (dirs.get(name)) {
        bad("symbolic link, not scanned");
        continue;
      }
      if (revokedIds.has(name)) continue;
      if (b.stopped) {
        incomplete = true;
        continue;
      }
      if (!src.stored && b.n >= (opts.limits?.skills ?? MAX_SKILLS_TOTAL) || b.bytes >= (opts.limits?.bytes ?? MAX_SKILL_BYTES_TOTAL)) {
        b.stopped = true;
        incomplete = true;
        problems.push({ kind: "too-many", ...base, reason: `the registry limit (${MAX_SKILLS_TOTAL} packages or ${MAX_SKILL_BYTES_TOTAL / 1048576} MiB) is reached; the rest are not read` });
        continue;
      }
      if (quarantinePath(dir, home)) {
        bad("the skill quarantine is never scanned");
        continue;
      }
      try {
        const pkg = loadSkillPackage(dir);
        if (!(src.stored && storeSeen.has(`${pkg.id}@${pkg.version}\0${pkg.digest}`))) {
          b.bytes += packageBytes(pkg);
          b.n++;
        }
        found.push({ key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: src.kind, label: src.label, dir, active: false, trust: TRUST[src.kind], pin: "unpinned", digest: pkg.digest, pkg });
        report.packages++;
      } catch (e) {
        if (e instanceof SkillPackageError) bad(e.issues.slice(0, 3).map((i) => `${i.path}: ${i.reason}`).join("; ") || "invalid package", e.issues);
        else bad(code(e));
      }
    }

    // Step 2: content, after the packages are read. A schema-2 release is always checked and always refused when it fails, whatever allow_unreleased says.
    if (read?.state === "ok" && rel && (rel.state === "approved" || read.manifest.schema === 2)) {
      const v2 = read.manifest.schema === 2;
      const listed = revokedIds.size ? { ...read.manifest, skills: read.manifest.skills.filter((s) => !revokedIds.has(s.id)) } : read.manifest;
      let reason = incomplete
        ? "could not be read completely (a limit was reached)"
        : invalid
          ? "holds a folder that is not a valid package"
          : releaseContentProblem(listed as typeof read.manifest, found.slice(mark.found));
      if (!reason && v2) {
        const v = verifyRelease(src.root, read);
        if (!v.ok) reason = v.reason;
      }
      if (reason) {
        rel = report.release = { ...rel, state: "mismatch", reason };
        if (!allow || v2) {
          found.length = mark.found;
          Object.assign(b, { n: mark.n, bytes: mark.bytes, stopped: mark.stopped });
          report.packages = 0;
          fail("root-refused", "refused", refusal(rel));
        }
      }
    }
    // An unchanged package that an earlier (newer) store release already provides is expected, not a duplicate; another digest stays one.
    if (src.stored) {
      for (const s of found.splice(mark.found)) {
        const k = `${s.key}\0${s.digest}`;
        if (storeSeen.has(k)) continue;
        storeSeen.add(k);
        found.push(s);
      }
    }
  }

  // Sources were visited in precedence order, so the first sight of a key wins.
  const byKey = new Map<string, RegisteredSkill>();
  for (const s of found) {
    if (revokedKeys.has(s.key)) continue;
    const have = byKey.get(s.key);
    if (have) {
      const other = have.digest !== s.digest ? " with another digest" : "";
      problems.push({ kind: "duplicate", source: s.source, label: s.label, root: s.label, package: s.id, reason: `${s.key} is already provided by ${have.label}${other}; this copy is ignored` });
      continue;
    }
    byKey.set(s.key, s);
  }
  for (const [key, by] of revokedKeys) notes.push({ kind: "revoked", label: "release", package: key.slice(0, key.lastIndexOf("@")), text: `${key} is revoked by ${by} and is not loaded.` });
  // Pins are looked up by key alone: the source does not matter, only the bytes.
  const lock = readSkillLock(home);
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
export function findSkill(reg: Pick<SkillRegistry, "skills" | "byKey">, id: string, version?: string): RegisteredSkill | undefined {
  if (version !== undefined) return reg.byKey.get(`${id}@${version}`);
  return reg.skills.find((s) => s.id === id && s.active);
}

export { SkillIntegrityError, SkillPinError, SkillSelectError };
export type { SkillPinErrorCode, SkillSelectCode };

/**
 * The gate for a run: the entry for this exact `id@version` if it is approved or built-in and its bytes match the pin.
 * Never falls back to another version or to the active entry. Used by `resolveSkills`.
 */
export function selectSkill(reg: Pick<SkillRegistry, "byKey" | "problems">, id: string, version: string): RegisteredSkill {
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
  return cachedSkillRegistryAt(skills, now, maxAgeMs, opts).registry;
}

/** Like cachedSkillRegistry, and says when the registry was really read (ms since the epoch). */
export function cachedSkillRegistryAt(skills: Config["skills"], now = Date.now(), maxAgeMs = 60_000, opts: DiscoverOptions = {}): { registry: SkillRegistry; at: number } {
  const key = JSON.stringify(skills) + "\0" + (opts.home ?? dataHome()) + "\0" + (opts.repo ?? "");
  if (cache && cache.key === key && now - cache.at >= 0 && now - cache.at < maxAgeMs) return { registry: cache.reg, at: cache.at };
  const reg = discoverSkills(skills, opts);
  cache = { key, at: now, reg };
  return { registry: reg, at: now };
}

export function clearSkillRegistryCache(): void {
  cache = undefined;
}
