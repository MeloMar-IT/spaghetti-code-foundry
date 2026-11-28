/**
 * "Depends on" issues in other repositories ("owner/name#12"): which of them still hold a story. Only a GitHub repository the
 * watcher's account added to the Foundry counts, and its issue is read with that repository's own sign-in, never the watcher's.
 */
import { findOwnedRepo, type RepoRecord } from "../auth/repos.js";
import { errorLine } from "../errors.js";
import { restIssue, withGhEnv, type RestIssue } from "../github.js";
import { crossDependencies, crossState, type CrossState, type DoneRule } from "./deps.js";
import type { RepoGhIdentity } from "./gh-identity.js";

/** Issues of other repositories read at most per check; the others hold their story until a later check. */
export const CROSS_READS_PER_CHECK = 20;
/** Time limit of one read. */
export const CROSS_READ_MS = 20_000;

export const NO_OWN_SIGN_IN = "the repository has no sign-in of its own";

/** An issue of another repository that holds a story. */
export interface CrossBlocker {
  repo: string;
  issue: number;
  /** It was closed as not planned: only the owner can sort that out. */
  notPlanned?: true;
  /** (method none) Its repository has no sign-in of its own: only the owner can sort that out. */
  noSignIn?: true;
}

export interface CrossDepOptions {
  /** The watcher's repository ("owner/name"): a reference to it is not a cross reference. */
  selfRepo: string;
  /** The watcher's account; without one no repository counts. */
  owner: string | undefined;
  rule: () => DoneRule;
  /** The sign-in of a stored repository (kept by the caller). */
  identity: (repoId: string) => RepoGhIdentity | undefined;
  /** A line for Recent activity. */
  act: (msg: string) => void;
  /** A warning line for the log. */
  warn: (msg: string) => void;
  find?: (owner: string, name: string) => RepoRecord | undefined;
  read?: (repo: string, issue: number, timeoutMs: number) => Promise<RestIssue | undefined>;
  cap?: number;
}

type Lookup = { kind: "skip" } | { kind: "refused"; why: string; noSignIn?: true } | { kind: "ok"; rec: RepoRecord };
type Result = { state: CrossState; closed?: true } | { failed: string };
type CrossRef = { repo: string; issue: number };

const keyOf = (repo: string, issue: number) => `${repo.toLowerCase()}#${issue}`;

/** One per watcher. `startCheck(bodies)` at the start of every check. */
export class CrossDeps {
  private lookups = new Map<string, Lookup>();
  private results = new Map<string, Promise<Result>>();
  private said = new Set<string>();
  /**
   * Refusals already written to the log, kept across checks: "story|reference" → the reason and the check that last saw it.
   * An entry goes when the reference resolves another way, or when the last whole check did not look at it.
   */
  private refusals = new Map<string, { why: string; seen: number }>();
  private capSaid = false;
  /** The number of the check that runs (1 for the first). */
  private serial = 0;
  /** The check in which each reference last got a read slot (absent: never). */
  private lastSlot = new Map<string, number>();
  /** The references that are read in this check. */
  private slots = new Set<string>();
  private readonly find: (owner: string, name: string) => RepoRecord | undefined;
  private readonly read: (repo: string, issue: number, timeoutMs: number) => Promise<RestIssue | undefined>;
  private readonly cap: number;

  constructor(private o: CrossDepOptions) {
    this.find = o.find ?? findOwnedRepo;
    this.read = o.read ?? restIssue;
    this.cap = o.cap ?? CROSS_READS_PER_CHECK;
  }

  /**
   * Starts a check. `bodies` are the issues this check looks at: their references get the read slots (at most `cap`),
   * the ones read longest ago first, so that no reference is starved by the others. Nothing is kept from earlier checks
   * (a reopened issue holds again), except which refusals the log has told already, and a reference without a slot holds its story for this check.
   */
  startCheck(bodies: readonly { number: number; body?: string }[] = []): void {
    this.lookups.clear();
    this.results.clear();
    this.said.clear();
    // Forget a refusal only when no look at it happened in the whole last check: a story found late in a check still counts.
    for (const [k, e] of this.refusals) if (e.seen < this.serial) this.refusals.delete(k);
    this.capSaid = false;
    this.serial++;
    this.slots = this.plan(bodies);
  }

  private plan(bodies: readonly { body?: string }[]): Set<string> {
    const self = this.o.selfRepo.toLowerCase();
    const refs = new Map<string, CrossRef>();
    for (const b of bodies) {
      for (const r of crossDependencies(b.body ?? "")) {
        if (r.repo.toLowerCase() === self) continue;
        const k = keyOf(r.repo, r.issue);
        if (!refs.has(k)) refs.set(k, r);
      }
    }
    const waiting = [...refs.entries()].filter(([, r]) => this.lookup(r.repo).kind === "ok").map(([k]) => k);
    waiting.sort((a, b) => (this.lastSlot.get(a) ?? 0) - (this.lastSlot.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    const slots = new Set(waiting.slice(0, this.cap));
    for (const k of slots) this.lastSlot.set(k, this.serial);
    return slots;
  }

  /**
   * The cross references of an issue that still hold it, sorted. `alive` throws when the check must stop (the watcher was
   * stopped, the check given up): it runs after the sign-in is prepared and after the read, and its error is passed on as it is.
   */
  async blockers(issue: { number: number; body?: string }, markedOnly: boolean, alive: () => void = () => {}): Promise<CrossBlocker[]> {
    const refs = crossDependencies(issue.body ?? "", { markedOnly });
    const self = this.o.selfRepo.toLowerCase();
    const out: CrossBlocker[] = [];
    for (const ref of refs) {
      if (ref.repo.toLowerCase() === self) continue;
      const name = `${ref.repo}#${ref.issue}`;
      const look = this.lookup(ref.repo);
      const rk = `${issue.number}|${keyOf(ref.repo, ref.issue)}`;
      if (look.kind !== "refused") this.refusals.delete(rk);
      if (look.kind === "skip") {
        this.once("act", `#${issue.number}: ${name} is not a repository of the Foundry; not waited for`);
        continue;
      }
      if (look.kind === "refused") {
        const was = this.refusals.get(rk);
        this.refusals.set(rk, { why: look.why, seen: this.serial });
        if (was?.why !== look.why) this.o.warn(`#${issue.number}: ${name} could not be read: ${look.why}`);
        out.push({ repo: ref.repo, issue: ref.issue, ...(look.noSignIn ? { noSignIn: true as const } : {}) });
        continue;
      }
      const r = await this.result(look.rec, ref.repo, ref.issue, alive);
      alive(); // also for a result another call read: a stopped check goes no further
      if ("failed" in r) {
        this.once("warn", `#${issue.number}: ${name} could not be read: ${r.failed}`);
        out.push({ repo: ref.repo, issue: ref.issue });
      } else if (r.state === "not_planned") out.push({ repo: ref.repo, issue: ref.issue, notPlanned: true });
      else if (r.state === "open") out.push({ repo: ref.repo, issue: ref.issue });
    }
    return out;
  }

  /**
   * The cross references of an issue that count as done because their issue is closed as completed. Only what `blockers()`
   * read in this check: nothing is asked of GitHub here.
   */
  async completed(issue: { body?: string }, markedOnly: boolean): Promise<CrossRef[]> {
    const out: CrossRef[] = [];
    for (const ref of crossDependencies(issue.body ?? "", { markedOnly })) {
      const r = await this.results.get(keyOf(ref.repo, ref.issue))?.catch(() => undefined);
      if (r && "state" in r && r.state === "done" && r.closed) out.push(ref);
    }
    return out;
  }

  private once(kind: "act" | "warn", msg: string) {
    if (this.said.has(msg)) return;
    this.said.add(msg);
    this.o[kind](msg);
  }

  private lookup(repo: string): Lookup {
    const k = repo.toLowerCase();
    let l = this.lookups.get(k);
    if (l) return l;
    if (!this.o.owner) l = { kind: "skip" };
    else {
      try {
        const rec = this.find(this.o.owner, repo);
        if (!rec || rec.owner !== this.o.owner) l = { kind: "skip" };
        else if (rec.method === "none") l = { kind: "refused", why: NO_OWN_SIGN_IN, noSignIn: true };
        else l = { kind: "ok", rec };
      } catch (e) {
        l = { kind: "refused", why: errorLine((e as Error).message) };
      }
    }
    this.lookups.set(k, l);
    return l;
  }

  /** Each issue is read once per check, and only when it has a slot in this check. A rejection is the `alive()` error. */
  private result(rec: RepoRecord, repo: string, issue: number, alive: () => void): Promise<Result> {
    const k = keyOf(repo, issue);
    let p = this.results.get(k);
    if (p) return p;
    if (!this.slots.has(k)) {
      if (!this.capSaid) {
        this.capSaid = true;
        this.o.warn(`issues of other repositories: at most ${this.cap} are read per check; the others wait for the next check`);
      }
      p = Promise.resolve({ failed: `not read in this check: at most ${this.cap} issues of other repositories are read per check` });
    } else {
      p = this.readOne(rec, repo, issue, alive);
    }
    this.results.set(k, p);
    return p;
  }

  private async readOne(rec: RepoRecord, repo: string, issue: number, alive: () => void): Promise<Result> {
    const id = this.o.identity(rec.id);
    if (!id) return { failed: "its sign-in is not available here" };
    let session;
    try {
      session = await id.prepare();
    } catch (e) {
      alive();
      return { failed: errorLine((e as Error).message) };
    }
    alive(); // a stopped watcher does not start the read
    let got: RestIssue | undefined;
    try {
      got = await withGhEnv(session, () => this.read(repo, issue, CROSS_READ_MS));
    } catch (e) {
      alive(); // a stopped watcher's check ends here, without a read failure
      return { failed: errorLine((e as Error).message) };
    }
    alive();
    if (!got) return { failed: "GitHub does not know it" };
    return { state: crossState(got, this.o.rule()), ...(String(got.state).toLowerCase() === "closed" ? { closed: true as const } : {}) };
  }
}
