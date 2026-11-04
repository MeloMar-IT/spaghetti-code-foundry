import type { RunSummary } from "../engine/state.js";
import { GAP_LIMITS, history, reviewKindsOfRun, runIds, timeOf, within } from "./gap-signals.js";
import type { EffectRead } from "./evaluation-store.js";
import type { RegisteredSkill } from "./registry.js";
import { compareSkillVersions, SKILL_ID_RE } from "./schema.js";

// Skill improvement (#777): which skill of the library does not help, keeps being overruled, or is quarantined, and the rule that
// decides whether a new version may be published. Pure: no file system, no clock (readers are injected), no GitHub. Only validated
// tokens leave this module (library names, `id@version` keys, run ids, finding kinds from the table).

export const IMPROVE_KINDS = ["effect", "review", "quarantine"] as const;
export type ImproveKind = (typeof IMPROVE_KINDS)[number];
export const IMPROVE_WINDOWS = { reviewDays: 14 } as const;
export const IMPROVE_THRESHOLDS = { reviewRuns: 3 } as const;
export const MAX_LIBRARY = 500;

export const improveKey = (name: string): string => `improve:${name}`;
export const improveMarker = (name: string): string => `<!-- scf skill-improve=${name} -->`;
export const IMPROVE_MARKER_RE = /<!-- scf skill-improve=([a-z0-9]+(?:-[a-z0-9]+)*) -->/;
export const IMPROVE_FAILED_RE = /<!-- scf skill-improve-failed run=([A-Za-z0-9-]+) -->/g;
export const improveFailedMarker = (runId: string): string => `<!-- scf skill-improve-failed run=${runId} -->`;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[0-9][0-9A-Za-z.+-]*$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

export interface ImproveSignal {
  /** `improve:<library name>` */
  topic: string;
  /** The library name: the folder `skills/<name>` of the authoring repository. */
  skill: string;
  /** The installed keys (`id@version`) the signals are about. */
  installed: string[];
  kinds: ImproveKind[];
  at: number;
  evidence: {
    runs: string[];
    findingKinds: string[];
    effect?: { verdict: "no-measurable-effect" | "harms"; with: { passed: number; runs: number }; without: { passed: number; runs: number } };
    state?: "quarantined";
  };
}

export type LibSkill = Pick<RegisteredSkill, "key" | "id" | "version" | "digest" | "active" | "lifecycle">;
/** Digest or installed id → library name. */
export interface LibraryNames { byDigest: ReadonlyMap<string, string>; byId: ReadonlyMap<string, string> }

/** From the names of the approved selections of the authoring source (with their digests) and the names the ledger knows. */
export function libraryNamesOf(i: { names: readonly string[]; digests: ReadonlyMap<string, string>; qualify: (name: string) => string; ledger: readonly string[] }): LibraryNames {
  const byDigest = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const [digest, name] of i.digests) if (SKILL_ID_RE.test(name)) byDigest.set(digest, name);
  for (const name of [...i.names, ...i.ledger]) {
    if (!SKILL_ID_RE.test(name)) continue;
    byId.set(name, name);
    try { byId.set(i.qualify(name), name); } catch { /* an unqualifiable name is known by its plain id only */ }
  }
  return { byDigest, byId };
}

const libNameOf = (s: Pick<LibSkill, "id" | "digest">, lib: LibraryNames): string | undefined => lib.byDigest.get(s.digest) ?? lib.byId.get(s.id);

/** The names of the library skills `skill-write` published (PUBLISHED: line) in `repo`. */
export function publishedLibrarySkills(runs: readonly RunSummary[], repo: string): string[] {
  const out = new Set<string>();
  for (const r of runs) {
    if (r.flow !== "skill-write" || r.vars?.github_repo?.trim().toLowerCase() !== repo.toLowerCase()) continue;
    const h = history(r);
    if (!h.some((x) => x.id === "publish" && /^PUBLISHED: [0-9a-f]{7,64}\s*$/m.test(String(x.output ?? "")))) continue;
    const pick = h.filter((x) => x.id === "pick").pop();
    const name = /^SKILL_NAME: ([a-z0-9-]+)\s*$/m.exec(String(pick?.output ?? ""))?.[1];
    if (name && SKILL_ID_RE.test(name)) out.add(name);
  }
  return [...out].sort();
}

/** Adds names to the ledger's `library` (name → ISO date). Keeps the newest `max`. */
export function mergeLibrary(old: Record<string, string>, names: readonly string[], now: number, max = MAX_LIBRARY): { library: Record<string, string>; changed: boolean } {
  const library: Record<string, string> = { ...old };
  let changed = false;
  for (const n of names) {
    if (!SKILL_ID_RE.test(n) || Object.hasOwn(library, n)) continue;
    library[n] = new Date(now).toISOString();
    changed = true;
  }
  const keys = Object.keys(library);
  if (keys.length > max) {
    for (const k of keys.sort((a, b) => (library[b]! < library[a]! ? -1 : library[b]! > library[a]! ? 1 : 0)).slice(max)) delete library[k];
    changed = true;
  }
  return { library, changed };
}

const one = (s: LibSkill, name: string, kind: ImproveKind, evidence: Partial<ImproveSignal["evidence"]> = {}, at = 0): ImproveSignal => ({
  topic: improveKey(name), skill: name, installed: [s.key], kinds: [kind], at, evidence: { runs: [], findingKinds: [], ...evidence },
});

/** Signal 1: the newest effect record of an installed library entry says no measurable effect, or harm. Every installed version is checked. */
export function effectImproveSignals(i: { skills: readonly LibSkill[]; lib: LibraryNames; effect: (id: string, digest: string) => EffectRead }): ImproveSignal[] {
  const out: ImproveSignal[] = [];
  for (const s of i.skills) {
    const name = libNameOf(s, i.lib);
    if (!name) continue;
    let read: EffectRead;
    try { read = i.effect(s.id, s.digest); } catch { continue; }
    if (read.state !== "ok") continue;
    const v = read.record.verdict;
    if (v.verdict !== "no-measurable-effect" && v.verdict !== "harms") continue;
    out.push(one(s, name, "effect", { effect: { verdict: v.verdict, with: { ...v.with }, without: { ...v.without } } }));
  }
  return out;
}

/** Signal 2: the same review finding kind in 3 or more distinct runs of 14 days that loaded the skill in a coder block. */
export function reviewImproveSignals(i: { now: number; runs: readonly RunSummary[]; skills: readonly LibSkill[]; lib: LibraryNames }): ImproveSignal[] {
  // library name → id → skills
  const idsOf = new Map<string, LibSkill[]>();
  for (const s of i.skills) {
    const name = libNameOf(s, i.lib);
    if (name) idsOf.set(name, [...(idsOf.get(name) ?? []), s]);
  }
  const by = new Map<string, { runs: Map<string, RunSummary>; installed: Set<string> }>();
  for (const r of i.runs) {
    if (!within(r, i.now, IMPROVE_WINDOWS.reviewDays)) continue;
    const kinds = reviewKindsOfRun(r);
    if (!kinds.size) continue;
    const loaded = new Set<string>();
    for (const h of history(r)) {
      if (h.skills?.role === "reviewer" || !Array.isArray(h.skills?.loaded)) continue;
      // the loaded keys are `id@version`: only the exact versions the coder had are implicated
      for (const k of h.skills.loaded) if (typeof k === "string") loaded.add(k);
    }
    for (const [name, list] of idsOf) {
      const hit = list.filter((s) => loaded.has(s.key));
      if (!hit.length) continue;
      for (const k of kinds) {
        const g = by.get(`${name}|${k}`) ?? { runs: new Map(), installed: new Set() };
        g.runs.set(r.runId, r);
        for (const s of hit) g.installed.add(s.key);
        by.set(`${name}|${k}`, g);
      }
    }
  }
  const out: ImproveSignal[] = [];
  for (const [key, g] of by) {
    if (g.runs.size < IMPROVE_THRESHOLDS.reviewRuns) continue;
    const [name, kind] = key.split("|") as [string, string];
    const runs = [...g.runs.values()];
    out.push({
      topic: improveKey(name), skill: name, installed: [...g.installed].sort(), kinds: ["review"], at: Math.max(0, ...runs.map(timeOf)),
      evidence: { runs: runIds(runs), findingKinds: [kind] },
    });
  }
  return out;
}

/** Signal 3: an installed library entry is quarantined (also an older version next to a healthy newer one). */
export function quarantineImproveSignals(i: { skills: readonly LibSkill[]; lib: LibraryNames }): ImproveSignal[] {
  const out: ImproveSignal[] = [];
  for (const s of i.skills) {
    const name = libNameOf(s, i.lib);
    if (name && s.lifecycle?.state === "quarantined") out.push(one(s, name, "quarantine", { state: "quarantined" }));
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** All three signals, detected per installed entry and merged per library name. */
export function improveSignals(i: { now: number; runs: readonly RunSummary[]; skills: readonly LibSkill[]; lib: LibraryNames; effect: (id: string, digest: string) => EffectRead }): ImproveSignal[] {
  const all = [...effectImproveSignals(i), ...reviewImproveSignals(i), ...quarantineImproveSignals(i)];
  const by = new Map<string, ImproveSignal>();
  for (const s of all) {
    const old = by.get(s.topic);
    if (!old) { by.set(s.topic, { ...s, installed: [...s.installed], kinds: [...s.kinds], evidence: { ...s.evidence, runs: [...s.evidence.runs], findingKinds: [...s.evidence.findingKinds] } }); continue; }
    old.installed = [...new Set([...old.installed, ...s.installed])].sort(cmp);
    old.kinds = IMPROVE_KINDS.filter((k) => old.kinds.includes(k) || s.kinds.includes(k));
    old.at = Math.max(old.at, s.at);
    old.evidence.runs = [...new Set([...old.evidence.runs, ...s.evidence.runs])].sort(cmp).slice(0, GAP_LIMITS.runs);
    old.evidence.findingKinds = [...new Set([...old.evidence.findingKinds, ...s.evidence.findingKinds])].sort(cmp).slice(0, GAP_LIMITS.kinds);
    old.evidence.effect ??= s.evidence.effect;
    old.evidence.state ??= s.evidence.state;
  }
  return [...by.values()].sort((a, b) => b.at - a.at || cmp(a.skill, b.skill));
}

// ---- the publish rule

export interface EffectSummary { id: string; version: string; verdict: string; with: { passed: number; runs: number }; without: { passed: number; runs: number } }

/** Reads the EFFECT line `effectLines()` prints (an `OLD ` prefix is allowed). */
export function parseEffectSummary(line: string): EffectSummary | undefined {
  const m = /^(?:OLD )?EFFECT ([^@\s]+)@(\S+) (\S+) \([^)]*\): with (\d+)\/(\d+), without (\d+)\/(\d+)/.exec(line.trim());
  if (!m) return undefined;
  return { id: m[1]!, version: m[2]!, verdict: m[3]!, with: { passed: Number(m[4]), runs: Number(m[5]) }, without: { passed: Number(m[6]), runs: Number(m[7]) } };
}

export type ImproveDecision = { publish: true } | { publish: false; why: "unreadable" | "new-does-not-help" | "not-comparable" | "not-better-than-old" };

/**
 * May the new version of a skill be published? It must help (against no skill) and score at least as well as the old version on the
 * same scenarios (equal number of runs with the skill). An old version that was offered on no scenario cannot be compared: the new
 * one then stands on its own verdict.
 */
export function improveDecision(next: EffectSummary | undefined, old: EffectSummary | undefined): ImproveDecision {
  if (!next || !old) return { publish: false, why: "unreadable" };
  if (next.verdict !== "helps" || next.with.runs <= 0) return { publish: false, why: "new-does-not-help" };
  if (old.with.runs === 0) return { publish: true };
  if (old.with.runs !== next.with.runs) return { publish: false, why: "not-comparable" };
  return next.with.passed >= old.with.passed ? { publish: true } : { publish: false, why: "not-better-than-old" };
}

// ---- the issue and its failures

const versionOf = (key: string): string => key.slice(key.lastIndexOf("@") + 1);
/** Orders two versions; a version that cannot be compared sorts lowest. */
function newerFirst(a: string, b: string): number {
  try {
    return compareSkillVersions(versionOf(b), versionOf(a));
  } catch {
    return 0;
  }
}

/**
 * The library name from the marker and the installed key an improvement is about: the highest version listed. The new version
 * is higher than all of them, so the highest affected one is the version the failed tries were about.
 */
export function improveTarget(body: string): { name: string; installed: string } | undefined {
  const m = IMPROVE_MARKER_RE.exec(body);
  if (!m || !SKILL_ID_RE.test(m[1]!)) return undefined;
  const keys = [...body.matchAll(/^- Installed: (.+)$/gm)]
    .flatMap((x) => [...x[1]!.matchAll(/`([^`\s]+)`/g)].map((k) => k[1]!))
    .filter((k) => KEY_RE.test(k));
  if (!keys.length) return undefined;
  const key = [...new Set(keys)].sort(newerFirst)[0]!;
  return { name: m[1]!, installed: key };
}

export const IMPROVE_STATES = ["active", "deprecated", "quarantined", "retired", "revoked", "release-revoked", "unknown"] as const;
export type ImproveState = (typeof IMPROVE_STATES)[number];
const TRANSITION_LINE_RE = /^#\d+ \S+ \S+ \S+ → ([a-z]+):/;
const ALLOW_RUN_LINE_RE = /^#\d+ \S+ \S+ allow-run /;

/**
 * The state of one installed version, from the text `scf skills lifecycle <key>` prints. A release revocation wins. Text that is not
 * understood (a problem, or a transition line that does not parse) is "unknown", so nothing is changed on a guess.
 */
export function improveStateOf(text: string): ImproveState {
  let state: ImproveState = "active";
  let seen = false;
  for (const line of text.split("\n")) {
    if (/^release \S+ revoked /.test(line)) return "release-revoked";
    if (line.startsWith("No lifecycle history for ")) { seen = true; continue; }
    const m = TRANSITION_LINE_RE.exec(line);
    if (m) {
      if (!(IMPROVE_STATES as readonly string[]).includes(m[1]!)) return "unknown";
      state = m[1] as ImproveState;
      seen = true;
      continue;
    }
    if (ALLOW_RUN_LINE_RE.test(line) || line.trim() === "") continue;
    return "unknown";
  }
  return seen ? state : "unknown";
}

/**
 * The failures of an improve issue: distinct run ids in comments that `isFoundry` accepts (the caller passes isFoundryComment from
 * src/github.ts: the marker and verified authorship), and the current run. Broken JSON: only the current run.
 */
export function improveFailures(commentsJson: string, thisRun: string, isFoundry: (c: { body: string; viewerDidAuthor?: boolean }) => boolean): number {
  const ids = new Set<string>();
  if (RUN_ID_RE.test(thisRun)) ids.add(thisRun);
  try {
    const j = JSON.parse(commentsJson) as { comments?: unknown };
    for (const c of Array.isArray(j?.comments) ? j.comments : []) {
      if (!c || typeof c.body !== "string" || !isFoundry({ body: c.body, viewerDidAuthor: c.viewerDidAuthor })) continue;
      for (const m of c.body.matchAll(IMPROVE_FAILED_RE)) if (RUN_ID_RE.test(m[1]!)) ids.add(m[1]!);
    }
  } catch { /* only the current run */ }
  return ids.size;
}
