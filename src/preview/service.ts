import { rm } from "node:fs/promises";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";
import { checkoutPreview, killCheckouts, type CheckoutResult, type PreviewSource } from "./checkout.js";
import { PREVIEW_PATH, type PREVIEW_VERSIONS } from "./config.js";
import { PreviewRunner, type PreviewInfo, type PreviewReason, type PreviewState } from "./runner.js";

export type PreviewVersion = (typeof PREVIEW_VERSIONS)[number];
export type PreviewViewReason = PreviewReason | "no-config" | "no-access" | "no-branch" | "checkout-failed";

export interface PreviewView {
  state: PreviewState;
  version?: PreviewVersion;
  runId?: string;
  reason?: PreviewViewReason;
  detail?: string;
  url?: string;
  output?: string;
  startedAt?: string;
  readyAt?: string;
  endedAt?: string;
}

/** Works out one place to clone from, when it is called. `refused` is a plain sentence: this source cannot be used. */
export type SourceFactory = (signal: AbortSignal) => Promise<PreviewSource | { refused: string }>;

export interface PreviewJob {
  repoId: string;
  version: PreviewVersion;
  runId?: string;
  branch: string;
  sources: SourceFactory[];
}

export interface PreviewServiceOptions {
  runner?: PreviewRunner;
  dataDir?: () => string;
  checkout?: typeof checkoutPreview;
  log?: (m: string) => void;
  now?: () => number;
}

export const previewDir = (dataDir: string, repoId: string): string => join(dataDir, "previews", repoId);

const STOP_WAIT_MS = 5000;

interface Slot {
  gen: number;
  abort: AbortController;
  /** The newest job (a start or a stop); it never rejects. */
  done: Promise<void>;
  /** Every `runner.stop` made so far: the process is gone when this has settled. */
  stopped: Promise<unknown>;
  phase: "checkout" | "runner" | "failed" | "stopped";
  /** The runner has made the entry of this job. */
  entry: boolean;
  job?: PreviewJob;
  startedAt: number;
  endedAt?: number;
  reason?: PreviewViewReason;
  detail?: string;
}

const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());

export class PreviewService {
  readonly runner: PreviewRunner;
  private slots = new Map<string, Slot>();
  private dataDir: () => string;
  private checkout: typeof checkoutPreview;
  private log: (m: string) => void;
  private now: () => number;

  constructor(o: PreviewServiceOptions = {}) {
    this.runner = o.runner ?? new PreviewRunner();
    this.dataDir = o.dataDir ?? dataHome;
    this.checkout = o.checkout ?? checkoutPreview;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    // the entry of a start is made after the old one has ended: from then on the runner tells the state
    this.runner.on("state", (i: PreviewInfo) => {
      const s = this.slots.get(i.projectId);
      if (s && s.phase === "runner" && i.state === "starting") s.entry = true;
    });
  }

  /** Cancels what runs or is being checked out for this repository, and keeps what must end before the folder may go. */
  private begin(repoId: string): { slot: Slot; gen: number; before: Promise<unknown> } {
    let slot = this.slots.get(repoId);
    if (!slot) {
      slot = { gen: 0, abort: new AbortController(), done: Promise.resolve(), stopped: Promise.resolve(), phase: "stopped", entry: false, startedAt: this.now() };
      this.slots.set(repoId, slot);
    }
    slot.gen++;
    slot.abort.abort();
    slot.abort = new AbortController();
    const stop = this.runner.stop(repoId).catch(() => undefined);
    const before = Promise.all([slot.done, slot.stopped, stop]);
    slot.stopped = Promise.all([slot.stopped, stop]);
    return { slot, gen: slot.gen, before };
  }

  /** Synchronous: cancels the old work, records "starting" and runs the checkout and the start in the background. */
  start(job: PreviewJob): PreviewView {
    const { slot, gen, before } = this.begin(job.repoId);
    const signal = slot.abort.signal;
    Object.assign(slot, { phase: "checkout", entry: false, job, startedAt: this.now(), endedAt: undefined, reason: undefined, detail: undefined });
    const mine = () => slot.gen === gen;
    const fail = (reason: PreviewViewReason, detail: string) => {
      if (!mine()) return;
      Object.assign(slot, { phase: "failed", reason, detail, endedAt: this.now() });
    };
    slot.done = (async () => {
      try {
        await before;
        if (!mine()) return;
        const dir = previewDir(this.dataDir(), job.repoId);
        await rm(dir, { recursive: true, force: true });
        if (!mine()) return;
        const result = await this.fetch(job, dir, signal, mine);
        if (!mine() || !result) return;
        if ("problem" in result) return fail(result.reason, result.problem);
        const text = result.config;
        if (result.configProblem) return fail("bad-config", result.configProblem);
        if (text === undefined) return fail("no-config", `${PREVIEW_PATH} is not on the branch ${job.branch}`);
        slot.phase = "runner";
        try {
          await this.runner.start(job.repoId, dir, text);
        } catch (e) {
          this.log(`preview: could not start (${(e as Error).name})`);
          fail("exited", "the preview could not be started; see the server log");
        }
      } catch (e) {
        this.log(`preview: job failed (${(e as Error).name})`);
        fail("checkout-failed", "the project could not be checked out");
      }
    })();
    return this.view(job.repoId);
  }

  /** Tries the sources in order; the next one only when the earlier gave nothing. */
  private async fetch(job: PreviewJob, dir: string, signal: AbortSignal, mine: () => boolean): Promise<(Extract<CheckoutResult, { ok: true }>) | { problem: string; reason: PreviewViewReason } | undefined> {
    let last: "refused" | "no-source" | "no-branch" = "no-source";
    let refusal = "";
    let sawNoBranch = false;
    for (const factory of job.sources) {
      const source = await factory(signal);
      if (!mine()) return undefined;
      if ("refused" in source) {
        last = "refused";
        refusal = source.refused;
        continue;
      }
      const r = await this.checkout({ source, branch: job.branch, dir, signal });
      if (!mine()) return undefined;
      if (r.ok) return r;
      // a failed checkout (timeout, corrupt repository) is final: an older copy of the branch is never served instead
      if (r.reason === "checkout-failed") return { reason: "checkout-failed", problem: r.detail };
      last = r.reason;
      if (r.reason === "no-branch") sawNoBranch = true;
      // "checkout-failed" has returned above: a failed checkout is final
    }
    if (last === "refused") return { reason: "no-access", problem: refusal };
    if (sawNoBranch) return { reason: "no-branch", problem: `the branch ${job.branch} is not in the project` };
    return { reason: "checkout-failed", problem: "the project could not be checked out" };
  }

  view(repoId: string, withOutput = false): PreviewView {
    const s = this.slots.get(repoId);
    if (!s || (s.phase === "stopped" && !s.job)) return { state: "stopped" };
    const head: PreviewView = { state: "starting", ...(s.job ? { version: s.job.version } : {}), ...(s.job?.runId ? { runId: s.job.runId } : {}) };
    if (s.phase === "stopped") return { ...head, state: "stopped", reason: "stopped", startedAt: iso(s.startedAt), ...(s.endedAt ? { endedAt: iso(s.endedAt) } : {}) };
    if (s.phase === "checkout" || (s.phase === "runner" && !s.entry)) return { ...head, startedAt: iso(s.startedAt) };
    if (s.phase === "failed") return { ...head, state: "failed", reason: s.reason, detail: s.detail, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt) };
    const i = this.runner.get(repoId);
    if (!i) return { ...head, startedAt: iso(s.startedAt) };
    const out: PreviewView = {
      ...head,
      state: i.state,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.detail ? { detail: i.detail } : {}),
      ...(i.url ? { url: i.url } : {}),
      startedAt: iso(i.startedAt),
      ...(i.readyAt !== undefined ? { readyAt: iso(i.readyAt) } : {}),
      ...(i.endedAt !== undefined ? { endedAt: iso(i.endedAt) } : {}),
    };
    if (withOutput) out.output = this.runner.output(repoId);
    return out;
  }

  /** Stops the preview and removes its folder once the work and the process have ended. */
  async stop(repoId: string): Promise<PreviewView> {
    const { slot, gen, before } = this.begin(repoId);
    Object.assign(slot, { phase: "stopped", entry: false, endedAt: this.now() });
    slot.done = (async () => {
      try {
        await before;
        if (slot.gen === gen) await rm(previewDir(this.dataDir(), repoId), { recursive: true, force: true });
      } catch (e) {
        this.log(`preview: cleanup failed (${(e as Error).name})`);
      }
    })();
    await slot.done;
    return this.view(repoId);
  }

  /** Resolves when the newest job is ready, failed or stopped. */
  async settled(repoId: string): Promise<PreviewView> {
    for (;;) {
      const s = this.slots.get(repoId);
      if (!s) return this.view(repoId);
      const d = s.done;
      await d;
      if (s.done === d) return this.view(repoId);
    }
  }

  /** Stops everything. The part before the first await is synchronous (kills checkouts, signals the processes). Never rejects. */
  async stopAll(): Promise<void> {
    for (const s of this.slots.values()) {
      s.gen++;
      s.abort.abort();
      s.abort = new AbortController();
      s.phase = "stopped";
      s.endedAt = this.now();
    }
    killCheckouts();
    const processes = this.runner.stopAll().catch(() => undefined);
    // the folders go when the work and the processes have ended
    const waits: Promise<unknown>[] = [processes];
    for (const [id, s] of this.slots) {
      const gen = s.gen;
      waits.push(Promise.all([s.done, processes]).then(() => (s.gen === gen ? rm(previewDir(this.dataDir(), id), { recursive: true, force: true }) : undefined)));
    }
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((r) => (timer = setTimeout(r, STOP_WAIT_MS)));
    try {
      await Promise.race([Promise.allSettled(waits), bound]);
    } finally {
      clearTimeout(timer);
    }
  }
}
