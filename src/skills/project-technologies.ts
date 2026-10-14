import { inside, normalizeModules } from "./integration-candidates.js";
import type { RepoProfile } from "./repo-profile.js";
import { compareSkillVersions, relativePathProblem } from "./schema.js";
import { PLAIN_VERSION_RE, SUPPORTED_LINES, TECHNOLOGY_ALIASES, TECHNOLOGY_NAMES, type TechnologyName } from "./technology-rules.js";
import { parsePartial, rangeAdmitsLine } from "./version-range.js";

// The Java, Spring and build tool versions of a project, from the findings of its repository profile, and whether the versions a
// skill declares fit a supported release line. Pure: no file system, no process, no clock.

export type SupportStatus = "supported" | "stale" | "unchecked" | "generic";
export interface ProjectTechnology { name: TechnologyName; version?: string }

const isName = (n: string): n is TechnologyName => (TECHNOLOGY_NAMES as readonly string[]).includes(n);

/** The canonical name for an alias (jdk is java); a name that is not an alias is returned unchanged. */
export function technologyName(name: string): string {
  return Object.hasOwn(TECHNOLOGY_ALIASES, name) ? TECHNOLOGY_ALIASES[name]! : name;
}

/**
 * A version as evidence: `.RELEASE`, `.Final` and `.GA` are dropped, other qualifiers are kept (`5.0.0.M1` is `5.0.0-M1`, `8.5-rc-1` is `8.5.0-rc-1`),
 * Java `1.8` is `8`. undefined: not a plain version, or one that cannot be compared safely.
 */
export function technologyVersion(name: TechnologyName, raw: string): string | undefined {
  if (!PLAIN_VERSION_RE.test(raw)) return undefined;
  const m = /^(\d+(?:\.\d+){0,2})(?:[.-](.+))?$/.exec(raw);
  if (!m) return undefined;
  const core = m[1]!;
  const qual = m[2];
  if (qual === undefined) {
    const old = name === "java" ? /^1\.(\d+)$/.exec(core) : null;
    return old ? old[1] : core;
  }
  if (/^\d+$/.test(qual)) return undefined; // a fourth numeric part
  if (/^(?:RELEASE|Final|GA)$/i.test(qual)) return core;
  if (name === "java") return undefined;
  const parts = core.split(".");
  while (parts.length < 3) parts.push("0");
  const v = `${parts.join(".")}-${qual}`;
  return parsePartial(v) ? v : undefined;
}

const MANIFESTS = new Set(["pom.xml", "build.gradle", "build.gradle.kts"]);
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const WRAPPERS: readonly { name: TechnologyName; suffix: string }[] = [
  { name: "maven", suffix: ".mvn/wrapper/maven-wrapper.properties" },
  { name: "gradle", suffix: "gradle/wrapper/gradle-wrapper.properties" },
];

/** Compares versions that may have fewer than three parts: 17 and 17.0.0 are equal. */
function compareVersions(a: string, b: string): number {
  const full = (v: string) => {
    const i = v.indexOf("-");
    const core = (i < 0 ? v : v.slice(0, i)).split(".");
    while (core.length < 3) core.push("0");
    return core.join(".") + (i < 0 ? "" : v.slice(i));
  };
  return compareSkillVersions(full(a), full(b)) || cmp(a, b);
}

/** What one build folder says about one technology: that it is used, and which version, if any. */
type Fact = { version?: string; overrides?: boolean };

/**
 * The technologies of the project, one entry per name and version. With `affectedModules` only the build folders in or above those
 * folders count; without, every build folder counts. A build folder inherits from the folders above it, nearest first. Modules that
 * differ give one entry per version (conflicting evidence); a name used without any readable version gives an entry without one.
 * Throws Error("invalid module path") for a module that fails relativePathProblem.
 */
export function projectTechnologies(profile: RepoProfile, opts: { affectedModules?: readonly string[] } = {}): ProjectTechnology[] {
  const modules = normalizeModules(opts.affectedModules);
  const folders = new Map<string, Map<TechnologyName, Fact>>();
  const note = (dir: string, name: TechnologyName, raw: string | undefined) => {
    const facts = folders.get(dir) ?? folders.set(dir, new Map()).get(dir)!;
    const fact = facts.get(name) ?? facts.set(name, {}).get(name)!;
    const v = raw === undefined ? undefined : technologyVersion(name, raw);
    if (v !== undefined && fact.version === undefined) fact.version = v;
    // A version that is declared but unreadable is an override: the folder does not inherit one from above.
    if (raw !== undefined && v === undefined) fact.overrides = true;
  };

  const usable = profile.findings
    .filter((f) => !relativePathProblem(f.path) && !/[\u0000-\u001f\u007f]/.test(f.path))
    .sort((a, b) => cmp(a.path, b.path) || cmp(a.name, b.name) || cmp(a.value ?? "", b.value ?? ""));
  const javaFiles: string[] = [];
  for (const f of usable) {
    if (f.kind === "language" && f.name === "java") javaFiles.push(f.path);
    if (f.kind === "dependency") {
      for (const w of WRAPPERS) {
        if (f.name === w.name && (f.path === w.suffix || f.path.endsWith(`/${w.suffix}`))) {
          note(f.path.slice(0, Math.max(0, f.path.length - w.suffix.length - 1)), w.name, f.value);
        }
      }
      if (!MANIFESTS.has(baseOf(f.path))) continue;
      const dir = dirOf(f.path);
      if (f.name === "java") note(dir, "java", f.value);
      else if (f.name === "org.springframework.boot" || f.name.startsWith("org.springframework.boot:")) note(dir, "spring-boot", f.value);
      else if (f.name.startsWith("org.springframework:")) note(dir, "spring-framework", f.value);
    } else if (f.kind === "manifest" && f.value === undefined && (f.name === "maven" || f.name === "gradle")) {
      note(dirOf(f.path), f.name, undefined);
    }
  }
  for (const [dir, facts] of folders) {
    if (facts.has("spring-boot")) note(dir, "spring-framework", undefined);
    if ((facts.has("maven") || facts.has("gradle")) && javaFiles.some((p) => inside(p, dir))) note(dir, "java", undefined);
  }

  const builds = [...folders.keys()];
  let targets: string[];
  if (modules.length === 0) targets = builds;
  else {
    const set = new Set<string>();
    for (const m of modules) {
      const below = builds.filter((b) => inside(b, m));
      if (below.length) for (const b of below) set.add(b);
      else {
        const above = builds.filter((b) => inside(m, b)).sort((a, b) => b.length - a.length)[0];
        if (above !== undefined) set.add(above);
      }
    }
    targets = [...set];
  }

  const found = new Map<TechnologyName, Set<string>>();
  for (const b of targets) {
    const chain = builds.filter((d) => inside(b, d)).sort((x, y) => y.length - x.length); // nearest first
    for (const name of TECHNOLOGY_NAMES) {
      let present = false;
      let version: string | undefined;
      for (const d of chain) {
        const fact = folders.get(d)!.get(name);
        if (!fact) continue;
        present = true;
        if (fact.version !== undefined) {
          version = fact.version;
          break;
        }
        if (fact.overrides) break;
      }
      if (present) (found.get(name) ?? found.set(name, new Set()).get(name)!).add(version ?? "");
    }
  }

  const out: ProjectTechnology[] = [];
  for (const name of TECHNOLOGY_NAMES) {
    const versions = [...(found.get(name) ?? [])];
    const real = versions.filter((v) => v !== "").sort(compareVersions);
    if (real.length) for (const version of real) out.push({ name, version });
    else if (versions.length) out.push({ name });
  }
  return out;
}

/**
 * Do the technologies a skill declares fit a supported release line (SUPPORTED_LINES)? `stale`: a declared version fits none.
 * `unchecked`: a declared range cannot be read. `generic`: it declares none of the five technologies.
 */
export function supportStatus(declared: readonly { name: string; version?: string }[]): SupportStatus {
  let seen = false;
  let stale = false;
  let unchecked = false;
  for (const d of declared) {
    const name = technologyName(d.name);
    if (!isName(name)) continue;
    seen = true;
    if (d.version === undefined) continue;
    const results = SUPPORTED_LINES[name].map((line) => rangeAdmitsLine(d.version!, line));
    if (results.includes(true)) continue;
    if (results.includes(undefined)) unchecked = true;
    else stale = true;
  }
  return !seen ? "generic" : stale ? "stale" : unchecked ? "unchecked" : "supported";
}
