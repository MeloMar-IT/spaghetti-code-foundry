// The weekly dependency check (flow deps-weekly): outdated Maven and npm dependencies, marked patch, minor or major,
// and security when npm audit lists the package. Pure logic; tools/deps-weekly runs the child processes and calls this.
import { AUDIT_TIMEOUT_MS, NPM_NAME, npmAuditEnv } from "../review/stories.js";
import { ACTIONS_LOST_NOTE, isSha, type ActionsFile } from "./actions.js";
import { PIP_NOT_SET_NOTE, SECRET_ENV, VERSION, gradleFromRun, goFromRun, isObj, oneLine, pipClass, pipFromRun, toolFailure, type EcosystemResult, type RawUpdate, type ToolRun } from "./ecosystems.js";
import { OSV_MISSING_NOTE, OSV_TOOLS, osvFromRun, osvKey } from "./osv.js";

export type DepTool = "maven" | "npm" | "gradle" | "pip" | "go" | "actions";
export type DepKind = "dependency" | "plugin" | "parent" | "action";
export type UpdateClass = "patch" | "minor" | "major";
export type CheckName = "maven" | "npm ci" | "npm outdated" | "npm audit" | "gradle" | "pip" | "go" | "osv-scanner" | "actions";
export interface DepUpdate { tool: DepTool; kind: DepKind; name: string; current: string; latest: string; class: UpdateClass; security: boolean }
export interface Advisory { package: string; severity: "info" | "low" | "moderate" | "high" | "critical"; title: string; url: string; fix: boolean }
export type { ToolRun };
export interface CheckResult { check: CheckName; ok: boolean; note?: string }
export interface DepsReport {
  version: 1; branch: string; commit: string; projects: DepTool[];
  updates: DepUpdate[]; advisories: Advisory[]; unlisted: Advisory[];
  checks: CheckResult[]; notes: string[]; unavailable: number; incomplete: number;
}
export type AuditAll = { checked: true; advisories: Advisory[] } | { checked: false; reason: string };

export { AUDIT_TIMEOUT_MS };
export const MAVEN_TIMEOUT_MS = 20 * 60_000;
export const NPM_CI_TIMEOUT_MS = 10 * 60_000;
export const NPM_OUTDATED_TIMEOUT_MS = 5 * 60_000;
export const TABLE_MAX = 100;
const REGISTRY = "--registry=https://registry.npmjs.org/";
export const MAVEN_ARGS = ["-B", "versions:display-dependency-updates", "versions:display-plugin-updates", "versions:display-parent-updates"];
export const NPM_OUTDATED_ARGS = ["outdated", "--json", REGISTRY, "--no-update-notifier"];
export const NPM_CI_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", REGISTRY, "--no-update-notifier"];
export const UP_TO_DATE = "All dependencies are up to date.";

const line = oneLine;
const MAVEN_NAME = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+){0,2}$/;
export { VERSION };
const ADVISORY_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/?=&%#:+-]*$/;
const npmName = (n: string) => n.length <= 214 && NPM_NAME.test(n);
const mavenName = (n: string) => n.length <= 200 && MAVEN_NAME.test(n);

/** Is this a plausible name of a dependency of that tool (the check that parsing applies)? */
export function isDepName(tool: DepTool, name: string): boolean {
  return typeof name === "string" && (tool === "maven" ? mavenName(name) : npmName(name));
}

/** The environment of the npm calls: no variable that looks like a credential, no npm setting, empty user and global config. */
export function depsNpmEnv(src: Record<string, string | undefined>, userConfig: string, globalConfig: string): Record<string, string> {
  const kept: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(src)) if (!SECRET_ENV.test(k)) kept[k] = v;
  return npmAuditEnv(kept, userConfig, globalConfig);
}

// ── versions ──
interface Version { nums: [number, number, number]; pre: string[]; suffix: string[] }
const PLAIN_TAG = /^(jre|android|final|release|ga|sp\d*)$/i;

export function parseVersion(v: string): Version | undefined {
  const s = String(v ?? "").trim().replace(/^[v=]+/, "").replace(/\+.*$/, "");
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(.*)$/.exec(s);
  if (!m) return undefined;
  const tag = m[4] ?? "";
  const plain = tag !== "" && PLAIN_TAG.test(tag);
  // Anything after the third number (Maven's 1.0.0.9) and any plain qualifier are compared part by part, numbers as numbers.
  const rest = `${plain ? `-${tag}` : ""}${m[5] ?? ""}`.toLowerCase();
  return {
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: tag && !plain ? tag.split(".") : [],
    suffix: rest.split(/[.-]+/).filter((p) => p !== ""),
  };
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
function comparePre(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return sign(Number(x) - Number(y));
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return sign(a.length - b.length);
}

/** -1, 0 or 1; a prerelease is lower than its release; build metadata is ignored. undefined when a version cannot be read. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return sign(x.nums[i]! - y.nums[i]!);
  if (x.pre.length === 0 && y.pre.length > 0) return 1;
  if (x.pre.length > 0 && y.pre.length === 0) return -1;
  const p = comparePre(x.pre, y.pre);
  if (p !== 0) return p;
  return comparePre(x.suffix, y.suffix);
}

/** The class of an update; undefined when latest is not higher. A version that cannot be read counts as major. */
export function classify(current: string, latest: string): UpdateClass | undefined {
  const c = compareVersions(current, latest);
  if (c === undefined) return current === latest ? undefined : "major";
  if (c >= 0) return undefined;
  const x = parseVersion(current)!;
  const y = parseVersion(latest)!;
  if (x.nums[0] !== y.nums[0]) return "major";
  if (x.nums[1] !== y.nums[1]) return "minor";
  return "patch";
}

// ── Maven ──
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const HEADING = /have newer versions|updates are available|has a newer version/i;
const ENTRY = /^\s+(\S+)\s+\.+\s+(?:\(from super-pom\)\s+)?(\S+)\s+->\s+(\S+)\s*$/;
const WRAPPED = /^\s+\.+\s+(?:\(from super-pom\)\s+)?(\S+)\s+->\s+(\S+)\s*$/;

/** The updates in the output of versions:display-dependency-updates, -plugin-updates and -parent-updates. */
export function parseMavenUpdates(text: string): { kind: DepKind; name: string; current: string; latest: string }[] {
  const lines = String(text ?? "").replace(ANSI, "").split(/\r?\n/).map((l) => l.replace(/^\[(?:INFO|WARNING|ERROR)\] ?/, ""));
  const out: { kind: DepKind; name: string; current: string; latest: string }[] = [];
  const seen = new Set<string>();
  let kind: DepKind | undefined;
  const add = (name: string, current: string, latest: string) => {
    if (!kind || !mavenName(name) || !VERSION.test(current) || !VERSION.test(latest)) return;
    const key = `${kind}\u0000${name}\u0000${current}\u0000${latest}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name, current, latest });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "" || !/^\s/.test(l)) {
      kind = undefined;
      if (l.trim() !== "" && HEADING.test(l)) kind = /parent/i.test(l) ? "parent" : /plugin/i.test(l) ? "plugin" : "dependency";
      continue;
    }
    if (!kind) continue;
    const m = ENTRY.exec(l);
    if (m) {
      add(m[1]!, m[2]!, m[3]!);
      continue;
    }
    const name = /^\s+(\S+)\s*$/.exec(l)?.[1];
    const w = name ? WRAPPED.exec(lines[i + 1] ?? "") : null;
    if (name && w) {
      add(name, w[1]!, w[2]!);
      i++;
    }
  }
  return out;
}

// ── npm ──
/** package name → version in package-lock.json (top-level packages only). */
export function lockedVersions(lockText: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  let j: unknown;
  try {
    j = JSON.parse(lockText ?? "");
  } catch {
    return map;
  }
  if (!isObj(j)) return map;
  const put = (name: string, entry: unknown) => {
    if (isObj(entry) && typeof entry.version === "string" && npmName(name) && VERSION.test(entry.version)) map.set(name, entry.version);
  };
  if (isObj(j.packages)) {
    for (const [k, e] of Object.entries(j.packages)) {
      const m = /^node_modules\/(.+)$/.exec(k);
      if (m && !m[1]!.includes("node_modules/")) put(m[1]!, e);
    }
  } else if (isObj(j.dependencies)) {
    for (const [k, e] of Object.entries(j.dependencies)) put(k, e);
  }
  return map;
}

export interface NpmOutdatedEntry { name: string; current: string; latest: string }
export type NpmOutdated = { ok: true; entries: NpmOutdatedEntry[]; notLocated: number } | { ok: false; reason: string };

export function parseNpmOutdated(text: string, locked: Map<string, string>): NpmOutdated {
  const t = String(text ?? "").trim();
  if (t === "") return { ok: true, entries: [], notLocated: 0 };
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return { ok: false, reason: "the output of npm outdated is not JSON" };
  }
  if (!isObj(j)) return { ok: false, reason: "the output of npm outdated is not JSON" };
  if (isObj(j.error)) return { ok: false, reason: `npm outdated failed: ${line(j.error.summary ?? j.error.code ?? "unknown error")}` };
  const entries: NpmOutdatedEntry[] = [];
  const seen = new Set<string>();
  let notLocated = 0;
  for (const [name, v] of Object.entries(j)) {
    if (!npmName(name)) continue;
    for (const e of Array.isArray(v) ? v : [v]) {
      if (!isObj(e) || typeof e.latest !== "string" || !VERSION.test(e.latest) || ["git", "linked", "exotic"].includes(e.latest)) continue;
      const current = typeof e.current === "string" && e.current !== "" ? e.current : locked.get(name);
      if (current === undefined) {
        notLocated++;
        continue;
      }
      if (!VERSION.test(current)) continue;
      const key = `${name}\u0000${current}\u0000${e.latest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, current, latest: e.latest });
    }
  }
  return { ok: true, entries, notLocated };
}

/** The advisories of `npm audit --json` (npm 7 and later), every severity. Every text is one safe line. */
export function parseNpmAuditAll(text: string): AuditAll {
  let j: unknown;
  try {
    j = JSON.parse(String(text ?? "").trim());
  } catch {
    return { checked: false, reason: "the output of npm audit is not JSON" };
  }
  if (!isObj(j)) return { checked: false, reason: "the output of npm audit is not JSON" };
  if (isObj(j.error)) return { checked: false, reason: `npm audit failed: ${line(j.error.summary ?? j.error.code ?? "unknown error")}` };
  if (!isObj(j.vulnerabilities)) return { checked: false, reason: "the npm audit report has an unknown form" };
  const rank = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 } as const;
  const found = new Map<string, Advisory>();
  // npm lists a package that depends on a vulnerable one with the name of that dependency (a string) in `via`.
  const indirect: { entry: string; via: string; fix: boolean }[] = [];
  for (const [entryName, entry] of Object.entries(j.vulnerabilities)) {
    if (!isObj(entry) || !Array.isArray(entry.via)) continue;
    const fix = entry.fixAvailable === true || isObj(entry.fixAvailable);
    for (const via of entry.via) {
      if (typeof via === "string") {
        if (npmName(via) && npmName(entryName) && via !== entryName) indirect.push({ entry: entryName, via, fix });
        continue;
      }
      if (!isObj(via) || typeof via.severity !== "string" || !(via.severity in rank)) continue;
      const pkg = typeof via.name === "string" ? via.name : entryName;
      if (!npmName(pkg)) continue;
      const title = line(via.title ?? "no title");
      const url = typeof via.url === "string" && via.url.length <= 300 && ADVISORY_URL.test(via.url) ? via.url : "";
      const key = `${pkg}\u0000${url || title}`;
      const old = found.get(key);
      if (old) old.fix = old.fix || fix;
      else found.set(key, { package: pkg, severity: via.severity as Advisory["severity"], title, url, fix });
    }
  }
  // The package that depends on a vulnerable one is itself affected: it gets the worst advisory of that dependency.
  const direct = [...found.values()];
  for (const { entry, via, fix } of indirect) {
    const hits = direct.filter((a) => a.package === via);
    if (hits.length === 0) continue;
    const worst = hits.reduce((a, b) => (rank[b.severity] > rank[a.severity] ? b : a));
    const key = `${entry}\u0000via ${via}`;
    if (found.has(key)) continue;
    found.set(key, { package: entry, severity: worst.severity, title: line(`depends on ${via}: ${worst.title}`), url: worst.url, fix: fix || hits.some((h) => h.fix) });
  }
  const advisories = [...found.values()].sort((a, b) => rank[b.severity] - rank[a.severity] || a.package.localeCompare(b.package));
  return { checked: true, advisories };
}

// ── from a run of a tool to a result ──
const failure = toolFailure;

export function auditAllFromRun(r: ToolRun): AuditAll {
  const code = r.error?.code;
  if (code === "ETIMEDOUT") return { checked: false, reason: `npm audit did not finish in ${AUDIT_TIMEOUT_MS / 1000} s` };
  if (code === "ENOBUFS") return { checked: false, reason: "the npm audit report is too large" };
  const f = failure("npm", r, AUDIT_TIMEOUT_MS);
  if (f) return { checked: false, reason: f };
  return parseNpmAuditAll(r.stdout ?? "");
}

export function mavenFromRun(r: ToolRun, cmd: string) {
  const none: ReturnType<typeof parseMavenUpdates> = [];
  const f = failure(cmd, r, MAVEN_TIMEOUT_MS);
  if (f) return { check: "maven" as const, ok: false, note: f, found: none };
  if (r.status !== 0) return { check: "maven" as const, ok: false, note: `Maven failed with exit code ${r.status ?? "none"} (for example no network)`, found: none };
  return { check: "maven" as const, ok: true, found: parseMavenUpdates(r.stdout ?? "") };
}

export function npmCiFromRun(r: ToolRun): CheckResult {
  const f = failure("npm ci", r, NPM_CI_TIMEOUT_MS);
  if (f) return { check: "npm ci", ok: false, note: f };
  if (r.status !== 0) return { check: "npm ci", ok: false, note: `npm ci failed with exit code ${r.status ?? "none"}; development dependencies may be missing` };
  return { check: "npm ci", ok: true };
}

export function npmOutdatedFromRun(r: ToolRun, locked: Map<string, string>): CheckResult & { entries: NpmOutdatedEntry[]; notLocated: number } {
  const bad = (note: string) => ({ check: "npm outdated" as const, ok: false, note, entries: [], notLocated: 0 });
  const f = failure("npm outdated", r, NPM_OUTDATED_TIMEOUT_MS);
  if (f) return bad(f);
  // npm outdated exits 1 when something is outdated; any other code is a failure, whatever it printed.
  if (r.status !== 0 && r.status !== 1) return bad(`npm outdated failed with exit code ${r.status ?? "none"}`);
  const p = parseNpmOutdated(r.stdout ?? "", locked);
  if (!p.ok) return bad(p.reason);
  return { check: "npm outdated", ok: true, entries: p.entries, notLocated: p.notLocated };
}

// ── the report ──
const ORDER: Record<UpdateClass, number> = { major: 0, minor: 1, patch: 2 };

export interface ReportInput {
  branch: string; commit: string;
  maven?: { run: ToolRun; cmd: string };
  npm?: { ci?: ToolRun; outdated: ToolRun; audit: AuditAll; lock?: string };
  gradle?: { run: ToolRun; cmd: string; report?: string };
  /** Without a run, FACTORY_PIP_BIN is not set: the packages of the runner would not be the project's, so pip is not run. */
  pip?: { run?: ToolRun; cmd: string };
  go?: { run: ToolRun; cmd: string };
  /** The run of osv-scanner; its findings mark the matching rows as security. */
  osv?: ToolRun;
  /** The result of the actions step; `unreadable`: the file is missing, corrupt or too large while the repository has workflows. */
  actions?: { file?: ActionsFile; unreadable?: boolean };
}

/** Compares at the precision the pin gives: @v4 against the release v4.2.0 is the same major. */
export function classifyPinned(current: string, latest: string): UpdateClass | undefined {
  const parts = /^v?(\d+(?:\.\d+)*)/.exec(current)?.[1]?.split(".").length;
  const m = /^v?(\d+(?:\.\d+)*)/.exec(latest);
  if (!parts || !m || parts >= 3) return classify(current, latest);
  return classify(current, m[1]!.split(".").slice(0, parts).join("."));
}

const SKIPPED_MAX = 8;
const PIN_VERSION = /^v?\d+(?:\.\d+){0,2}$/;
// A version comment that names all three numbers: the only one a SHA pin can be compared with.
const FULL_VERSION = /^v?\d+\.\d+\.\d+$/;

/**
 * The update rows of the pins; a pin that cannot be compared goes into `skipped`. Returns the number of pins lost to a failed lookup.
 * A SHA pin is up to date when its commit is the newest release's commit. Otherwise its version comes from the comment, and only a
 * full three-part comment counts: "# v4" names a floating major, not the commit it is pinned to.
 */
function actionRows(f: ActionsFile, rows: DepUpdate[], skipped: Set<string>): number {
  const seen = new Set<string>();
  let lost = 0;
  for (const pin of f.pins) {
    if (f.failed.includes(pin.repo)) {
      lost++;
      continue;
    }
    const sha = isSha(pin.ref);
    if (sha && f.releaseShas[pin.repo] === pin.ref) continue;
    const short = sha ? pin.ref.slice(0, 7) : pin.ref;
    const tag = f.releases[pin.repo];
    const current = sha ? (pin.comment && FULL_VERSION.test(pin.comment) ? pin.comment : undefined) : PIN_VERSION.test(pin.ref) ? pin.ref : undefined;
    if (!tag || current === undefined) {
      const where = tag ? `newest release ${tag}` : "no newest release known";
      skipped.add(`${pin.name}@${short} (${where}${sha && current === undefined ? "; its version is not known" : ""})`);
    } else if (!seen.has(`${pin.name}\u0000${current}`)) {
      seen.add(`${pin.name}\u0000${current}`);
      const c = classifyPinned(current, tag);
      if (c) rows.push({ tool: "actions", kind: "action", name: pin.name, current, latest: tag, class: c, security: false });
    }
  }
  return lost;
}

export function buildReport(i: ReportInput): DepsReport {
  const checks: CheckResult[] = [];
  const notes: string[] = [];
  const updates: DepUpdate[] = [];
  const projects: DepTool[] = [];
  let advisories: Advisory[] = [];
  let incomplete = 0;
  if (i.maven) {
    projects.push("maven");
    const m = mavenFromRun(i.maven.run, i.maven.cmd);
    checks.push({ check: m.check, ok: m.ok, ...(m.note ? { note: m.note } : {}) });
    for (const f of m.found) {
      const c = classify(f.current, f.latest);
      if (c) updates.push({ tool: "maven", ...f, class: c, security: false });
    }
  }
  if (i.npm) {
    projects.push("npm");
    if (i.npm.ci) {
      const ci = npmCiFromRun(i.npm.ci);
      checks.push(ci);
      if (!ci.ok) incomplete++;
    } else if (i.npm.lock === undefined) {
      notes.push("npm: there is no package-lock.json, so npm outdated sees only what is installed; development dependencies may be missing");
    }
    const o = npmOutdatedFromRun(i.npm.outdated, lockedVersions(i.npm.lock));
    checks.push({ check: o.check, ok: o.ok, ...(o.note ? { note: o.note } : {}) });
    incomplete += o.notLocated;
    if (o.notLocated > 0) notes.push(`npm outdated: ${o.notLocated} package${o.notLocated === 1 ? " has" : "s have"} no known installed version and ${o.notLocated === 1 ? "was" : "were"} left out`);
    const flagged = new Set<string>();
    if (i.npm.audit.checked) {
      advisories = i.npm.audit.advisories;
      for (const a of advisories) flagged.add(a.package);
      checks.push({ check: "npm audit", ok: true });
    } else checks.push({ check: "npm audit", ok: false, note: line(i.npm.audit.reason) });
    for (const e of o.entries) {
      const c = classify(e.current, e.latest);
      if (c) updates.push({ tool: "npm", kind: "dependency", ...e, class: c, security: flagged.has(e.name) });
    }
  }
  const ecosystems: [DepTool, { run?: ToolRun; cmd: string; report?: string } | undefined, (r: ToolRun, c: string, rep?: string) => EcosystemResult][] = [
    ["gradle", i.gradle, gradleFromRun], ["pip", i.pip, pipFromRun], ["go", i.go, goFromRun],
  ];
  for (const [tool, inp, from] of ecosystems) {
    if (!inp) continue;
    projects.push(tool);
    if (!inp.run) {
      // Only pip can lack a run: no project environment was configured.
      checks.push({ check: "pip", ok: false, note: PIP_NOT_SET_NOTE });
      continue;
    }
    const r = from(inp.run, inp.cmd, inp.report);
    checks.push({ check: tool as CheckName, ok: r.ok, ...(r.note ? { note: r.note } : {}) });
    incomplete += r.incomplete;
    if (r.incomplete > 0) notes.push(`${tool}: ${r.incomplete} ${r.incomplete === 1 ? "entry was" : "entries were"} not usable and left out`);
    for (const f of r.found) {
      const c = tool === "pip" ? pipClass(f.current, f.latest) : classify(f.current, f.latest);
      if (c) updates.push({ tool, kind: "dependency", ...(f as RawUpdate), class: c, security: false });
    }
  }
  if (i.actions?.unreadable) {
    projects.push("actions");
    checks.push({ check: "actions", ok: false, note: ACTIONS_LOST_NOTE });
  } else if (i.actions?.file && (i.actions.file.pins.length > 0 || i.actions.file.invalid > 0 || i.actions.file.failed.length > 0)) {
    const f = i.actions.file;
    projects.push("actions");
    const skipped = new Set<string>();
    incomplete += actionRows(f, updates, skipped) + skipped.size;
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const bad = [
      f.failed.length > 0 ? `the newest release of ${plural(f.failed.length, "action", "actions")} could not be looked up` : "",
      f.invalid > 0 ? `${plural(f.invalid, "workflow file was", "workflow files were")} not valid` : "",
    ].filter(Boolean);
    checks.push({ check: "actions", ok: bad.length === 0, ...(bad.length > 0 ? { note: bad.join("; ") } : {}) });
    if (skipped.size > 0) {
      const list = [...skipped];
      notes.push(`actions: not compared: ${list.slice(0, SKIPPED_MAX).join(", ")}${list.length > SKIPPED_MAX ? `, and ${list.length - SKIPPED_MAX} more` : ""}`);
    }
  }
  if (i.osv) {
    const o = osvFromRun(i.osv);
    if (!o.installed) notes.push(`osv-scanner: ${OSV_MISSING_NOTE}`);
    else {
      checks.push({ check: "osv-scanner", ok: o.ok, ...(o.note ? { note: o.note } : {}) });
      const hit = new Set<string>();
      for (const f of o.findings) for (const t of OSV_TOOLS[f.ecosystem] ?? []) hit.add(osvKey(t, f.name, f.version));
      for (const u of updates) if (hit.has(osvKey(u.tool, u.name, u.current))) u.security = true;
    }
  }
  updates.sort((a, b) => Number(b.security) - Number(a.security) || ORDER[a.class] - ORDER[b.class] || a.tool.localeCompare(b.tool) || a.name.localeCompare(b.name));
  const withRow = new Set(updates.filter((u) => u.tool === "npm").map((u) => u.name));
  const unlisted = advisories.filter((a) => !withRow.has(a.package));
  notes.unshift(...checks.filter((c) => !c.ok && c.note).map((c) => `${c.check}: ${c.note}`));
  const unavailable = checks.filter((c) => !c.ok && c.check !== "npm ci").length;
  return { version: 1, branch: i.branch, commit: i.commit, projects, updates, advisories, unlisted, checks, notes, unavailable, incomplete };
}

export function summaryLine(r: DepsReport): string {
  const sec = r.updates.filter((u) => u.security).length;
  return `Updates found: ${r.updates.length} (${sec} security). Tools not available: ${r.unavailable}. Incomplete: ${r.incomplete}.`;
}

export function reportText(r: DepsReport): string {
  const out: string[] = [];
  const at = r.branch ? ` ${r.branch}${r.commit ? ` (${r.commit.slice(0, 7)})` : ""}` : " the repository";
  out.push(`Dependencies of${at}:`);
  if (r.updates.length > 0) {
    const head = ["TOOL", "KIND", "NAME", "CURRENT", "LATEST", "CLASS", "SECURITY"];
    const rows = r.updates.slice(0, TABLE_MAX).map((u) => [u.tool, u.kind, u.name, u.current, u.latest, u.class, u.security ? "security" : ""]);
    const widths = head.map((h, c) => Math.max(h.length, ...rows.map((x) => x[c]!.length)));
    const fmt = (x: string[]) => x.map((v, c) => v.padEnd(widths[c]!)).join("  ").trimEnd();
    out.push(fmt(head), ...rows.map(fmt));
    if (r.updates.length > TABLE_MAX) out.push(`… and ${r.updates.length - TABLE_MAX} more in deps.json`);
  }
  if (r.unlisted.length > 0) {
    out.push("Vulnerable, no update row:");
    for (const a of r.unlisted) out.push(`- ${a.severity} ${a.package}: ${a.title}${a.url ? ` — ${a.url}` : ""} — ${a.fix ? "fix available" : "no fix available"}, no update available`);
  }
  for (const n of r.notes) out.push(`Note: ${n}`);
  if (r.projects.length === 0) out.push("No pom.xml, package.json, Gradle, Python or go.mod project, and no pinned GitHub Action, at the top of the repository: nothing to check.");
  else if (r.updates.length === 0 && r.advisories.length === 0) {
    out.push(r.unavailable === 0 && r.incomplete === 0 ? UP_TO_DATE : "No updates found by the checks that ran; some could not run or were incomplete (see the notes).");
  }
  out.push(summaryLine(r));
  return out.join("\n");
}

/** The branch and the commit the clone step printed. */
export function cloneInfo(out: string): { branch: string; commit: string } {
  const b = /^branch:\s*(\S+)\s*$/m.exec(out ?? "")?.[1] ?? "";
  const c = /^BASE:\s*([0-9a-f]{40})\s*$/m.exec(out ?? "")?.[1] ?? "";
  return { branch: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) ? b : "", commit: c };
}
