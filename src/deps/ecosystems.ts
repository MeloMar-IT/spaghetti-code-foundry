// The Gradle, pip and Go parts of the weekly dependency check, and the helpers every part shares. Pure logic: tools/deps-weekly runs the
// child processes and hands their output to these functions. Imports go one way: check.ts imports this file, never the other way round.
import { safeSentence } from "../failure.js";
import { redactTokens } from "../review/stories.js";

export interface ToolRun { stdout?: string | null; stderr?: string | null; status?: number | null; error?: { code?: string } | null }
export interface RawUpdate { name: string; current: string; latest: string }
/** What a parser makes of a tool's output: the updates, and how many entries it could not use. */
export type Parsed = { ok: true; found: RawUpdate[]; incomplete: number } | { ok: false; reason: string };
export interface EcosystemResult { ok: boolean; note?: string; found: RawUpdate[]; incomplete: number }

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;
export const SECRET_ENV = /token|auth|password|secret|^npm_config_/i;
/** One safe line of text: no tokens, no markup. */
export const oneLine = (t: unknown, max = 200) => safeSentence(redactTokens(String(t ?? "")), max);

export const GRADLE_TIMEOUT_MS = 20 * 60_000;
export const PIP_TIMEOUT_MS = 5 * 60_000;
export const GO_TIMEOUT_MS = 10 * 60_000;
export const GRADLE_MARKERS = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
export const PIP_MARKERS = ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile"];
export const GO_MARKERS = ["go.mod"];
export const GRADLE_REPORT = "build/dependencyUpdates/report.json";
export const GRADLE_REPORT_MAX = 32 * 1024 * 1024;
export const GRADLE_ARGS = [
  "--no-daemon", "--console=plain", "dependencyUpdates", "-Drevision=release", "-DoutputFormatter=json",
  "-DoutputDir=build/dependencyUpdates", "-DreportfileName=report",
];
export const PIP_ARGS = ["list", "--outdated", "--format", "json", "--index-url", "https://pypi.org/simple", "--disable-pip-version-check", "--no-input"];
export const GO_ARGS = ["list", "-m", "-u", "-json", "all"];
/** pip lists the packages of the environment it runs in; without FACTORY_PIP_BIN that is the runner's, so the check is incomplete. */
export const PIP_NOT_SET_NOTE = "FACTORY_PIP_BIN is not set, so the packages of the project's Python environment were not checked; point it at that environment's pip";

const GRADLE_NAME = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/;
const PIP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const GO_PATH = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,199}$/;

/** The failure of a tool that did not run or did not finish; undefined when it ran. */
export function toolFailure(name: string, r: ToolRun, limitMs: number): string | undefined {
  const code = r.error?.code;
  if (code === "ENOENT") return `${name} was not found`;
  if (code === "ETIMEDOUT") return `${name} did not finish in ${Math.round(limitMs / 60_000)} min`;
  if (code === "ENOBUFS") return `the output of ${name} is too large`;
  if (r.error) return `${name} could not run`;
  return undefined;
}

// ── environments ──
/** The environment of the Gradle, pip, Go and OSV calls: no variable that looks like a credential. */
export function depsToolEnv(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  return out;
}

/** pip: no user or site config, no index from the environment, no version check, no prompts. */
export function depsPipEnv(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(depsToolEnv(src))) if (!/^PIP_/i.test(k) && k !== "PYTHONSTARTUP") out[k] = v;
  return { ...out, PIP_CONFIG_FILE: "/dev/null", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" };
}

/** Go: the toolchain on the machine, never a downloaded one; go.mod may be completed in the throwaway clone. */
export function depsGoEnv(src: Record<string, string | undefined>): Record<string, string> {
  return { ...depsToolEnv(src), GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" };
}

// ── Gradle ──
/** The outdated dependencies of the JSON report of the versions plugin (com.github.ben-manes.versions). */
export function parseGradleReport(text: string): Parsed {
  let j: unknown;
  try {
    j = JSON.parse(String(text ?? "").trim());
  } catch {
    return { ok: false, reason: "the Gradle report is not JSON" };
  }
  if (!isObj(j)) return { ok: false, reason: "the Gradle report is not JSON" };
  const list = isObj(j.outdated) && Array.isArray(j.outdated.dependencies) ? j.outdated.dependencies : [];
  const found: RawUpdate[] = [];
  const seen = new Set<string>();
  let incomplete = isObj(j.unresolved) && typeof j.unresolved.count === "number" ? Math.max(0, Math.floor(j.unresolved.count)) : 0;
  for (const d of list) {
    if (!isObj(d)) continue;
    const group = typeof d.group === "string" ? d.group : "";
    const artifact = typeof d.name === "string" ? d.name : "";
    const name = group ? `${group}:${artifact}` : artifact;
    const a = isObj(d.available) ? d.available : {};
    const latest = [a.release, a.milestone, a.integration].find((v): v is string => typeof v === "string" && v !== "");
    if (name.length > 200 || !GRADLE_NAME.test(name) || typeof d.version !== "string" || !VERSION.test(d.version) || !latest || !VERSION.test(latest)) continue;
    const key = `${name}\u0000${d.version}\u0000${latest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name, current: d.version, latest });
  }
  incomplete = Math.min(incomplete, 100_000);
  return { ok: true, found, incomplete };
}

/** `report` is the text of the JSON report file the run wrote, when there is one. */
export function gradleFromRun(r: ToolRun, cmd: string, report?: string): EcosystemResult {
  const bad = (note: string): EcosystemResult => ({ ok: false, note, found: [], incomplete: 0 });
  const f = toolFailure(cmd, r, GRADLE_TIMEOUT_MS);
  if (f) return bad(f);
  if (/Task '?dependencyUpdates'? not found/i.test(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)) {
    return bad("the Gradle versions plugin (com.github.ben-manes.versions) is not applied; Gradle was skipped");
  }
  if (r.status !== 0) return bad(`Gradle failed with exit code ${r.status ?? "none"} (for example no network)`);
  if (report === undefined) return bad("Gradle wrote no report");
  const p = parseGradleReport(report);
  return p.ok ? { ok: true, found: p.found, incomplete: p.incomplete } : bad(p.reason);
}

// ── pip: PEP 440 ──
export interface PepKey { epoch: number; release: number[]; pre?: [number, number]; post?: number; dev?: number }
const PEP =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/;
const PRE_RANK: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

/** The parts of a PEP 440 version; undefined when it does not parse. The local part (+abc) is ignored. */
export function pep440Key(v: string): PepKey | undefined {
  const text = String(v ?? "").trim().toLowerCase();
  const m = PEP.exec(text);
  if (!m || text.length > 64) return undefined;
  const release = m[2]!.split(".").map(Number);
  while (release.length > 1 && release[release.length - 1] === 0) release.pop();
  const key: PepKey = { epoch: Number(m[1] ?? 0), release };
  if (m[3] !== undefined) key.pre = [PRE_RANK[m[3]]!, Number(m[4] || 0)];
  // An unmatched group is undefined; a keyword without a number ("1.0.post", "1.0.dev") is "" and counts as 0.
  if (m[5] !== undefined) key.post = Number(m[5]);
  else if (m[6] !== undefined) key.post = Number(m[6] || 0);
  if (m[7] !== undefined) key.dev = Number(m[7] || 0);
  return key;
}

function cmpNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1 in the order of PEP 440; undefined when a version does not parse. */
export function pep440Compare(a: string, b: string): number | undefined {
  const x = pep440Key(a);
  const y = pep440Key(b);
  if (!x || !y) return undefined;
  if (x.epoch !== y.epoch) return x.epoch < y.epoch ? -1 : 1;
  const r = cmpNums(x.release, y.release);
  if (r !== 0) return r;
  // A dev release of a plain version sorts below its pre-releases; a plain release sorts above them.
  const pre = (k: PepKey): [number, number] => (k.pre ?? (k.post === undefined && k.dev !== undefined ? [-1, 0] : [3, 0]));
  const p = cmpNums(pre(x), pre(y));
  if (p !== 0) return p;
  const post = cmpNums([x.post ?? -1], [y.post ?? -1]);
  if (post !== 0) return post;
  return cmpNums([x.dev ?? Infinity], [y.dev ?? Infinity]);
}

/** patch, minor or major from the release numbers (a new epoch is major); undefined when latest is not higher. */
export function pipClass(current: string, latest: string): "patch" | "minor" | "major" | undefined {
  const c = pep440Compare(current, latest);
  if (c === undefined || c >= 0) return undefined;
  const x = pep440Key(current)!;
  const y = pep440Key(latest)!;
  if (x.epoch !== y.epoch || (x.release[0] ?? 0) !== (y.release[0] ?? 0)) return "major";
  if ((x.release[1] ?? 0) !== (y.release[1] ?? 0)) return "minor";
  return "patch";
}

/** The entries of `pip list --outdated --format json`. */
export function parsePipOutdated(text: string): Parsed {
  let j: unknown;
  try {
    j = JSON.parse(String(text ?? "").trim() || "[]");
  } catch {
    return { ok: false, reason: "the output of pip is not JSON" };
  }
  if (!Array.isArray(j)) return { ok: false, reason: "the output of pip is not a list" };
  const found: RawUpdate[] = [];
  const seen = new Set<string>();
  let incomplete = 0;
  for (const e of j) {
    if (!isObj(e) || typeof e.name !== "string" || !PIP_NAME.test(e.name) || typeof e.version !== "string" || typeof e.latest_version !== "string") continue;
    if (pep440Key(e.version) === undefined || pep440Key(e.latest_version) === undefined) {
      incomplete++;
      continue;
    }
    const key = `${e.name}\u0000${e.version}\u0000${e.latest_version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name: e.name, current: e.version, latest: e.latest_version });
  }
  return { ok: true, found, incomplete };
}

export function pipFromRun(r: ToolRun, cmd: string): EcosystemResult {
  const bad = (note: string): EcosystemResult => ({ ok: false, note, found: [], incomplete: 0 });
  const f = toolFailure(cmd, r, PIP_TIMEOUT_MS);
  if (f) return bad(f);
  if (r.status !== 0) return bad(`pip failed with exit code ${r.status ?? "none"} (for example no network)`);
  const p = parsePipOutdated(r.stdout ?? "");
  return p.ok ? { ok: true, found: p.found, incomplete: p.incomplete } : bad(p.reason);
}

// ── Go ──
/** The top-level JSON objects in a stream (`go list -json` prints them one after another, not as a list). */
export function splitJsonStream(text: string): { items: string[]; truncated: boolean } {
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) items.push(text.slice(start, i + 1));
    }
  }
  return { items, truncated: depth > 0 || inString };
}

/** The direct modules with an update in the output of `go list -m -u -json all`. */
export function parseGoModules(text: string): Parsed {
  const s = splitJsonStream(String(text ?? ""));
  if (s.truncated) return { ok: false, reason: "the output of go list is cut off" };
  const found: RawUpdate[] = [];
  const seen = new Set<string>();
  let incomplete = 0;
  for (const item of s.items) {
    let m: unknown;
    try {
      m = JSON.parse(item);
    } catch {
      return { ok: false, reason: "the output of go list is not JSON" };
    }
    if (!isObj(m) || m.Main === true || m.Indirect === true || m.Replace !== undefined) continue;
    if (m.Error !== undefined) {
      incomplete++;
      continue;
    }
    const u = isObj(m.Update) ? m.Update : undefined;
    if (!u || typeof m.Path !== "string" || typeof m.Version !== "string" || typeof u.Version !== "string") continue;
    const current = m.Version.replace(/\+incompatible$/, "");
    const latest = u.Version.replace(/\+incompatible$/, "");
    if (!GO_PATH.test(m.Path) || !VERSION.test(current) || !VERSION.test(latest)) continue;
    const key = `${m.Path}\u0000${current}\u0000${latest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name: m.Path, current, latest });
  }
  return { ok: true, found, incomplete };
}

export function goFromRun(r: ToolRun, cmd: string): EcosystemResult {
  const bad = (note: string): EcosystemResult => ({ ok: false, note, found: [], incomplete: 0 });
  const f = toolFailure(cmd, r, GO_TIMEOUT_MS);
  if (f) return bad(f);
  if (r.status !== 0) return bad(`go failed with exit code ${r.status ?? "none"} (for example no network)`);
  const p = parseGoModules(r.stdout ?? "");
  return p.ok ? { ok: true, found: p.found, incomplete: p.incomplete } : bad(p.reason);
}
