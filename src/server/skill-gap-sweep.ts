import { resolve } from "node:path";
import { githubNameOf } from "../auth/repo-url.js";
import { skillLibraryFor } from "../auth/repo-settings.js";
import { listAllRepos, type RepoRecord } from "../auth/repos.js";
import type { Config } from "../config.js";
import { userAccount } from "../engine/isolation.js";
import { loadRun, saveRun, type RunSummary } from "../engine/state.js";
import { withGhEnv } from "../github.js";
import { readFindings, type Finding } from "../monitor/findings.js";
import { repoGhIdentity } from "../queue/gh-identity.js";
import { GAP_SENTENCE, buildGapLedger, gapLinkSentence, gapLinksFor, gapLedgerFile, openGapIssues, readGapLedger, unknownTopicIds, writeGapLedger, type GapLedger } from "../skills/gap-issues.js";
import { gapSignals } from "../skills/gap-signals.js";
import { readNewestEffect, type EffectRead } from "../skills/evaluation-store.js";
import { improveSignals, libraryNamesOf, mergeLibrary, publishedLibrarySkills, type LibSkill } from "../skills/improve.js";
import { sourceQualifiedId } from "../skills/normalize.js";
import { discoverSkills } from "../skills/registry.js";
import { readSkillSelections, SELECTIONS_FILE } from "../skills/selections.js";
import { readSources, SOURCES_FILE } from "../skills/sources.js";
import { storeFor, type StoryStore } from "../stories/store.js";

// The sweeper for skill gaps (#776): an hourly in-process tick (and a kick when a run stops for skills). It turns the runs and the
// monitor's findings into signals, opens at most the allowed issues in the skill library, writes the ledger and links the runs that
// stopped for a missing skill. It never resumes a run (the watcher does) and never removes a link. Logs name no repository or path.

export const GAP_TICK_MS = 3_600_000;
export const GAP_RUN_LIMIT = 500;
export const GAP_LOG = "skill-gaps: ";
export const GAP_NOT_LIBRARY = "the repository for skill gaps is not marked as a skill library; no issue is opened";
export const GAP_NO_SIGN_IN = "the repository for skill gaps has no usable GitHub sign-in (an administrator's repository record with its own token or app is needed); no issue is opened";
export const GAP_LIST_CUT = "the issue list of the skill library is too long to check for duplicates; no issue is opened";
export const GAP_FAILED = "the skill gap check failed; nothing more was opened";

/** What names the skills of the library: the selections of the authoring source (name, digest) and how the import qualifies an id. */
export interface LibraryInput { names: readonly string[]; digests: ReadonlyMap<string, string>; qualify: (name: string) => string }

/** The selections of the source whose repository is `repo`, read from the source and selection files of the working folder. Never throws; no source: nothing. */
export function libraryInputFromFiles(repo: string, cwd: string = process.cwd(), today: string = new Date().toISOString().slice(0, 10)): LibraryInput {
  const none: LibraryInput = { names: [], digests: new Map(), qualify: (n) => n };
  try {
    const src = readSources(resolve(cwd, SOURCES_FILE));
    if (src.state !== "ok") return none;
    const want = repo.toLowerCase();
    const source = src.manifest.sources.find((x) => x.status === "enabled" && githubNameOf(x.repository)?.toLowerCase() === want);
    if (!source) return none;
    const qualify = (name: string) => sourceQualifiedId({ source: source.id, repositoryKey: source.repositoryKey }, name);
    const sel = readSkillSelections(resolve(cwd, SELECTIONS_FILE), today);
    if (sel.state !== "ok") return { ...none, qualify };
    const mine = sel.manifest.selections.filter((x) => x.source === source.id);
    return { names: mine.map((x) => x.skill), digests: new Map(mine.map((x) => [x.digest, x.skill])), qualify };
  } catch {
    return none;
  }
}

/** A registry entry as the sweeper reads it; improve signals need the key, digest, version and lifecycle too. */
export type SweepSkill = Parameters<typeof gapSignals>[0]["skills"][number] & Partial<Pick<LibSkill, "key" | "version" | "digest" | "lifecycle">>;

export interface SignedIn { run<T>(fn: () => Promise<T>): Promise<T>; dispose(): void }

export interface SkillGapSweeperDeps {
  config: () => Pick<Config, "skills">;
  /** The runs to look at (not running, recent). */
  runs: () => RunSummary[];
  findings?: () => Pick<Finding, "detector" | "about" | "repo" | "gone">[];
  /** The skills of the registry now. */
  skills?: () => readonly SweepSkill[];
  /** The newest effect record of a skill digest (default: the stored one). */
  effects?: (id: string, digest: string) => EffectRead;
  /** The names of the library's skills (default: the selections of the source of the authoring repository). */
  libraryNames?: (repo: string) => LibraryInput;
  repos?: () => readonly RepoRecord[];
  /** The GitHub sign-in of the record; rejects when there is none. */
  signIn?: (rec: RepoRecord) => Promise<SignedIn>;
  store?: (repo: string) => Pick<StoryStore, "listAll" | "create" | "createLabelIfMissing">;
  /** Queued or active. */
  isBusy: (runId: string) => boolean;
  load?: (runId: string) => RunSummary | undefined;
  save?: (run: RunSummary) => void;
  log: (line: string) => void;
  now?: () => number;
  ledgerFile?: string;
}

export interface SkillGapSweeper { tick(): Promise<void>; kick(): void; stop(): void }

export function skillGapSweeper(d: SkillGapSweeperDeps): SkillGapSweeper {
  const now = d.now ?? Date.now;
  const file = d.ledgerFile ?? gapLedgerFile();
  const load = d.load ?? (() => undefined);
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const said = new Set<string>();
  const say = (line: string) => { try { d.log(GAP_LOG + line); } catch { /* a failing log must not stop the sweeper */ } };
  const sayOnce = (line: string) => { if (!said.has(line)) { said.add(line); say(line); } };

  const signIn = d.signIn ?? (async (rec: RepoRecord): Promise<SignedIn> => {
    const id = repoGhIdentity(rec.id, { config: d.config as () => Config });
    try {
      if (id.usesHostLogin()) throw new Error("host login");
      const session = await id.prepare();
      return { run: (fn) => withGhEnv(session, fn), dispose: () => id.dispose() };
    } catch (e) {
      id.dispose();
      throw e;
    }
  });

  /** The administrator's record of the skill library, or a fixed sentence why there is none. */
  function recordFor(repo: string): { rec: RepoRecord } | { problem: string } {
    const records = (d.repos ?? listAllRepos)();
    if (!skillLibraryFor(repo, records)) return { problem: GAP_NOT_LIBRARY };
    const want = githubNameOf(`https://github.com/${repo}`);
    const rec = records.find((r) => githubNameOf(r.url) === want && r.settings?.kind === "skill-library" && !userAccount(r.owner));
    return rec ? { rec } : { problem: GAP_NO_SIGN_IN };
  }

  /** Links the runs that stopped for unknown skills with a ledger entry. Each run is read again and checked in one synchronous section. */
  function link(runs: readonly RunSummary[], ledger: GapLedger): number {
    let linked = 0;
    for (const r of runs) {
      try {
        if (r.status !== "stopped" || r.skillPlan?.action !== "stop" || !unknownTopicIds(r).length || d.isBusy(r.runId)) continue;
        const fresh = load(r.runId);
        if (!fresh || fresh.status !== "stopped" || fresh.skillPlan?.action !== "stop" || d.isBusy(fresh.runId)) continue;
        const links = gapLinksFor(unknownTopicIds(fresh), ledger);
        if (!links.length) continue;
        const have = new Set((fresh.skillGap ?? []).map((l) => l.topic));
        if (links.every((l) => have.has(l.topic))) continue;
        const all = [...(fresh.skillGap ?? []).filter((l) => !links.some((n) => n.topic === l.topic)), ...links];
        const strip = (t: string | undefined) => (t ?? "").replace(new RegExp(` ?${GAP_SENTENCE}.*$`), "");
        const sentence = gapLinkSentence(all);
        fresh.skillGap = all;
        fresh.reason = `${strip(fresh.reason)} ${sentence}`.trim();
        fresh.skillPlan = { ...fresh.skillPlan, reason: `${strip(fresh.skillPlan.reason)} ${sentence}`.trim() };
        (d.save ?? saveRun)(fresh);
        linked++;
      } catch {
        // one unreadable run must not stop the others
      }
    }
    return linked;
  }

  async function body(): Promise<void> {
    const cfg = d.config().skills.authoring;
    if (!cfg?.repository) return;
    const found = recordFor(cfg.repository);
    if ("problem" in found) return sayOnce(found.problem);
    const runs = d.runs();
    const skills = d.skills?.() ?? [];
    // the names `skill-write` published are remembered in the ledger, so a skill is known before it is imported
    const old = readGapLedger(file, cfg.repository);
    const merged = mergeLibrary(old.library ?? {}, publishedLibrarySkills(runs, cfg.repository), now());
    if (merged.changed) {
      try { writeGapLedger({ ...old, repository: cfg.repository.toLowerCase(), library: merged.library }, file); } catch { /* the next tick tries again */ }
    }
    const lib = libraryNamesOf({ ...(d.libraryNames ?? libraryInputFromFiles)(cfg.repository), ledger: Object.keys(merged.library) });
    const installed = skills.filter((s): s is SweepSkill & LibSkill => typeof s.key === "string" && typeof s.digest === "string" && typeof s.version === "string");
    const signals = [
      ...gapSignals({ now: now(), runs, findings: d.findings?.() ?? [], skills }),
      ...improveSignals({ now: now(), runs, skills: installed, lib, effect: d.effects ?? ((id, digest) => readNewestEffect(id, digest)) }),
    ];
    if (!signals.length) return;
    let session: SignedIn;
    try {
      session = await signIn(found.rec);
    } catch {
      return sayOnce(GAP_NO_SIGN_IN);
    }
    try {
      const store = (d.store ?? storeFor)(cfg.repository);
      const r = await session.run(() => openGapIssues({ store, signals, label: cfg.label, maxOpen: cfg.max_open, maxPerDay: cfg.max_per_day, now: now() }));
      if (stopped) return;
      if (r.cut) return sayOnce(GAP_LIST_CUT);
      const reasons = new Map<string, number>();
      for (const s of r.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
      const left = [...reasons].map(([k, n]) => `${n} ${k}`).join(", ");
      if (r.made.length || r.skipped.length) say(`opened ${r.made.length}${left ? `, skipped ${left}` : ""}`);
      if (r.failed) say(GAP_FAILED);
      writeGapLedger(buildGapLedger(cfg.repository, r.byTopic, now(), merged.library), file);
      link(runs, readGapLedger(file, cfg.repository));
    } catch {
      say(GAP_FAILED);
    } finally {
      session.dispose();
    }
  }

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const p: Promise<void> = body()
      .catch(() => say(GAP_FAILED))
      .finally(() => {
        if (inFlight === p) inFlight = undefined;
      });
    inFlight = p;
    return p;
  };
  return {
    tick,
    kick() { void tick(); },
    stop() { stopped = true; },
  };
}

/** The default readers for the server: loads a run from its folder and reads the monitor's findings. */
export const gapDefaults = (runsDir: string) => ({
  load: (id: string) => loadRun(runsDir, id),
  findings: () => readFindings().findings,
  skills: (config: Pick<Config, "skills">) => discoverSkills(config.skills).skills,
});
