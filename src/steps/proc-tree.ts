import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A process as `ps` shows it. `start` (the start time) tells a process from a later one that got the same pid. */
export interface ProcRow {
  pid: number;
  ppid: number;
  start: string;
}

const START = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2}:\d{2} \d{4}$/;
const PS_ARGS = ["-A", "-o", "pid=,ppid=,lstart="];

/** `ps -A -o pid=,ppid=,lstart=` → rows. Lines that do not fit are skipped. The start has its blanks collapsed (Linux pads the day). */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const start = m[3]!.replace(/\s+/g, " ");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || !START.test(start)) continue;
    rows.push({ pid, ppid, start });
  }
  return rows;
}

export const psPath = () => process.env.FACTORY_TEST_SLOT_PS || "ps";
export const psEnv = () => ({ ...process.env, LC_ALL: "C" });

/** Folder in a run folder where each running step process leaves an empty file named by its pid (all runs of a server share one pid). */
export const STEP_PIDS_DIR = "step-pids";

/**
 * Marks a step process of a run: `<run folder>/step-pids/<pid>`. The run folder is the one above `logs/` that holds `logFile`;
 * any other log file gets no mark. Best effort, never throws. Returns the function that removes the mark.
 */
export function markStep(logFile: string, pid: number): () => void {
  const logs = dirname(logFile);
  if (basename(logs) !== "logs") return () => {};
  const dir = join(dirname(logs), STEP_PIDS_DIR);
  const file = join(dir, String(pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "");
  } catch {
    return () => {};
  }
  return () => {
    try {
      rmSync(file, { force: true });
    } catch {
      // left behind: the reader checks the mark against the process table
    }
  };
}

/** Every process now; undefined when ps fails. Blocks: use it only when a step is being stopped. */
export function processTable(timeoutMs = 5000): ProcRow[] | undefined {
  try {
    const out = execFileSync(psPath(), PS_ARGS, { env: psEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parsePs(out);
  } catch {
    return undefined;
  }
}

export function processTableAsync(timeoutMs = 5000): Promise<ProcRow[] | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(psPath(), PS_ARGS, { env: psEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
        resolve(err ? undefined : parsePs(stdout));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Every descendant of `root` (not root itself), breadth first. */
export function descendants(rows: ProcRow[], root: number): ProcRow[] {
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const l = kids.get(r.ppid);
    if (l) l.push(r);
    else kids.set(r.ppid, [r]);
  }
  const seen = new Set<number>([root]);
  const out: ProcRow[] = [];
  const queue = [root];
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
      queue.push(k.pid);
    }
  }
  return out;
}

const never = (pid: number) => pid <= 1 || pid === process.pid;

/** Signals each row whose pid still has the same start time in `table` (read now when omitted). Never pid ≤ 1 or this process. Returns how many. */
export function signalRows(rows: ProcRow[], sig: NodeJS.Signals, table?: ProcRow[]): number {
  if (!rows.length) return 0;
  const now = table ?? processTable(2000);
  if (!now) return 0; // better to miss a process than to hit another one
  const starts = new Map(now.map((r) => [r.pid, r.start]));
  let n = 0;
  for (const r of rows) {
    if (never(r.pid) || starts.get(r.pid) !== r.start) continue;
    try {
      process.kill(r.pid, sig);
      n++;
    } catch {
      // already gone
    }
  }
  return n;
}

/** True when any of the processes answers signal 0. */
export function anyPidAlive(rows: ProcRow[]): boolean {
  for (const r of rows) {
    if (never(r.pid)) continue;
    try {
      process.kill(r.pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    }
  }
  return false;
}

/** One `pid ppid start` line per row; parsePs reads it back. */
export function formatRows(rows: ProcRow[]): string {
  return rows.map((r) => `${r.pid} ${r.ppid} ${r.start}\n`).join("");
}

export interface TrackerOptions {
  /** How often the descendants are noted (default 10 s). */
  everyMs?: number;
  /** Blocking table read, used when the step is stopped. */
  table?: () => ProcRow[] | undefined;
  tableAsync?: () => Promise<ProcRow[] | undefined>;
  /** Rows known from before. */
  remembered?: ProcRow[];
}

const key = (r: ProcRow) => `${r.pid} ${r.start}`;

/**
 * Remembers the descendants of a process while it runs, so those that left its process group
 * (or lost their parent) can still be stopped. A row counts only while its pid has the same start time.
 */
export class ProcessTracker {
  private known = new Map<string, ProcRow>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private polling = false;
  private rootStart: string | undefined;
  private rootGone = false;
  private readonly every: number;
  private readonly table: () => ProcRow[] | undefined;
  private readonly tableAsync: () => Promise<ProcRow[] | undefined>;

  constructor(
    private readonly root: number,
    o: TrackerOptions = {},
  ) {
    this.every = o.everyMs ?? 10_000;
    this.table = o.table ?? (() => processTable(2000));
    this.tableAsync = o.tableAsync ?? (() => processTableAsync());
    for (const r of o.remembered ?? []) this.known.set(key(r), { ...r });
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.poll(), this.every);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look at the process table. Skipped while another runs or after stop(). */
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const t = await this.tableAsync();
      if (t && !this.stopped) this.fold(t);
    } catch {
      // keep what is known
    } finally {
      this.polling = false;
    }
  }

  /**
   * The processes to stop besides the group. Call it before the group is signalled.
   * When the table cannot be read, the rows remembered so far are returned unchecked:
   * the caller must validate them against a fresh table before it signals them.
   */
  toStop(): ProcRow[] {
    const t = this.table();
    if (t) this.fold(t);
    return this.remembered();
  }

  remembered(): ProcRow[] {
    return [...this.known.values()].map((r) => ({ ...r }));
  }

  private fold(table: ProcRow[]): void {
    const now = new Map(table.map((r) => [key(r), r]));
    // the root counts only while it is the same process (its pid may be reused after it ended)
    const rootRow = table.find((r) => r.pid === this.root);
    if (!rootRow) this.rootGone = true;
    else if (this.rootStart === undefined) this.rootStart = rootRow.start;
    else if (rootRow.start !== this.rootStart) this.rootGone = true;
    const next = new Map<string, ProcRow>();
    for (const k of this.known.keys()) {
      const cur = now.get(k);
      if (cur && cur.pid !== this.root) next.set(k, cur);
    }
    const roots = [...next.values()].map((r) => r.pid);
    if (!this.rootGone) roots.push(this.root);
    for (const root of roots) {
      for (const d of descendants(table, root)) if (d.pid !== this.root) next.set(key(d), d);
    }
    this.known = next;
  }
}
