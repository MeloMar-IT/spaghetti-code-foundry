import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { allRunsDirs, dropIndexSlot, indexSlotOf, indexSlots, indexVersion, listAllRunIds, readIndexSlot, readIndexSlotAsync, runFile, type IndexSlot, type RunBrief, type RunIndexEntry } from "./state.js";

export const RUN_INDEX_REFRESH_MS = 5000;
export const RUN_INDEX_BATCH = 50;

export interface RunIndexOptions {
  /** False (the CLI, tests): every read looks at the files, as before. Default true. */
  live?: boolean;
  refreshMs?: number;
  batch?: number;
  /** Gives the event loop a turn (default: setImmediate). */
  yieldTurn?: () => Promise<void>;
}

const defaultYield = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/**
 * The runs folder as one small entry per run, kept in memory. It holds no data of its own: the entries live in the
 * store of state.ts, which this process's writes (`saveRun`, `rewriteRunMark`, `adoptRun`) update at once. `build()` and
 * `refresh()` read the files with fs/promises in batches and give the event loop a turn between batches.
 * A refresh picks up writes of other processes: it re-reads only run.json files whose time or size changed.
 */
export class RunIndex {
  readonly live: boolean;
  private readonly batch: number;
  private readonly refreshMs: number;
  private readonly yieldTurn: () => Promise<void>;
  private dirs: string[];
  private built = false;
  private building?: Promise<void>;
  private running = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private cache?: { key: string; entries: RunIndexEntry[]; byId: Map<string, RunIndexEntry> };

  constructor(readonly runsDir: string, o: RunIndexOptions = {}) {
    this.live = o.live !== false;
    this.batch = o.batch ?? RUN_INDEX_BATCH;
    this.refreshMs = o.refreshMs ?? RUN_INDEX_REFRESH_MS;
    this.yieldTurn = o.yieldTurn ?? defaultYield;
    this.dirs = [runsDir];
  }

  /** True once the first pass is done. Always true in sync mode. */
  get ready(): boolean {
    return !this.live || this.built;
  }

  /** Resolves when the index is ready (at once in sync mode). Lets request handlers wait without reading the files. */
  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : this.settle();
  }

  /** The first pass; when it ended incomplete (a folder could not be listed) one more pass is tried. `ready` tells the result. */
  private async settle(): Promise<void> {
    await this.build();
    if (this.built || this.stopped) return;
    await this.pass();
  }

  /** The first pass; a second call returns the same promise. */
  build(): Promise<void> {
    if (!this.live) return Promise.resolve();
    return (this.building ??= this.pass().then(() => undefined));
  }

  /** One pass over the folders. Never throws; skipped while another pass runs or after stop(). */
  async refresh(): Promise<void> {
    if (!this.live || !this.building) return; // before build() nothing is refreshed
    await this.pass();
  }

  /** Builds, then refreshes every `refreshMs`. */
  start(): void {
    if (!this.live || this.timer || this.stopped) return;
    void this.build();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async pass(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const dirs = allRunsDirs(this.runsDir);
      const wanted: { dir: string; id: string }[] = [];
      const seenIds = new Set<string>();
      const seenFiles = new Set<string>();
      let complete = true;
      for (const dir of dirs) {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
          continue;
        }
        for (const id of names) {
          seenFiles.add(runFile(join(dir, id)));
          if (!seenIds.has(id)) {
            seenIds.add(id);
            wanted.push({ dir, id });
          }
        }
      }
      // What was there before the pass: a slot written (or created) while we read is a different object and is kept.
      // A folder that left the list (a workspace removed) counts too: its slots are dropped below.
      const known = new Set([...this.dirs, ...dirs]);
      const before = new Map<string, IndexSlot>();
      for (const s of indexSlots()) if (known.has(s.runsDir)) before.set(runFile(join(s.runsDir, s.id)), s);
      for (let i = 0; i < wanted.length; i += this.batch) {
        if (i > 0) await this.yieldTurn();
        if (this.stopped) return;
        await Promise.all(wanted.slice(i, i + this.batch).map((w) => readIndexSlotAsync(w.dir, w.id)));
      }
      if (this.stopped) return;
      // A folder that could not be listed is not treated as empty: its runs stay as they were.
      if (complete) {
        for (const [file, slot] of before) {
          if (seenFiles.has(file)) continue;
          if (indexSlotOf(slot.runsDir, slot.id) === slot) dropIndexSlot(file);
        }
      }
      this.dirs = dirs;
      if (complete) this.built = true;
    } catch {
      // a pass that fails is tried again by the next refresh
    } finally {
      this.running = false;
    }
  }

  /** One entry per run, newest first. On a duplicate id the main runs folder wins. */
  entries(): RunIndexEntry[] {
    return this.view().entries;
  }

  /** The entry of one run id (the same rule as entries()); undefined when there is none. */
  entryOf(id: string): RunIndexEntry | undefined {
    if (!this.live) {
      for (const d of allRunsDirs(this.runsDir)) {
        const e = readIndexSlot(d, id)?.entry;
        if (e) return e;
      }
      return undefined;
    }
    return this.view().byId.get(id);
  }

  private view(): { entries: RunIndexEntry[]; byId: Map<string, RunIndexEntry> } {
    if (!this.live) {
      const entries = listAllRunIds(this.runsDir).flatMap((e) => readIndexSlot(e.runsDir, e.id)?.entry ?? []);
      return { entries, byId: new Map(entries.map((e) => [e.brief.dirName, e])) };
    }
    // The cache is keyed by the store's version and by the folder list: a folder that leaves the list changes the answer.
    const key = `${indexVersion()}\n${this.dirs.join("\n")}`;
    if (this.cache?.key === key) return this.cache;
    const order = new Map(this.dirs.map((d, i) => [d, i]));
    const best = new Map<string, IndexSlot>();
    for (const s of indexSlots()) {
      const rank = order.get(s.runsDir);
      if (rank === undefined || !s.entry) continue;
      const have = best.get(s.id);
      if (!have || rank < order.get(have.runsDir)!) best.set(s.id, s);
    }
    const sorted = [...best.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
    const entries = sorted.map(([, s]) => s.entry!);
    const byId = new Map(sorted.map(([id, s]) => [id, s.entry!]));
    this.cache = { key, entries, byId };
    return this.cache;
  }

  briefs(): RunBrief[] {
    return this.entries().map((e) => e.brief);
  }

  /** Total spend of runs that started today (local time): the rule of state.spentToday. */
  spentToday(now = new Date(), owner?: string): number {
    const day = now.toDateString();
    let total = 0;
    for (const e of this.entries().slice(0, 500)) {
      const started = new Date(e.brief.startedAt);
      if (started.toDateString() === day) {
        if (owner === undefined) total += e.totalCostUsd;
        else if (e.brief.owner === owner && Number.isFinite(e.totalCostUsd)) total += e.totalCostUsd;
      } else if (started < new Date(now.getTime() - 2 * 86_400_000)) break;
    }
    return total;
  }
}
