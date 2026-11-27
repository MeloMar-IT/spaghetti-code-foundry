// No test process may outlive the suite. This module has no vitest import: tests/global-setup.ts loads it too.
//  - the stubborn fixture (ignores SIGTERM) and the registry that SIGKILLs it after a test
//  - what the suite owns, and which of it is still alive (the check at the end of the suite)
import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A stubborn fixture ends by itself after this long, so a missed cleanup cannot run for hours. */
export const STUBBORN_SECONDS = 120;

/**
 * A shell script that ignores SIGTERM, writes its group to `<pidFile>.pgid` and then its pid to `pidFile`, and loops until
 * the deadline by the clock. It has no single quote, so it can stand inside `sh -c '…'`. The paths come from the tests only.
 */
export function stubbornScript(pidFile: string): string {
  if (/['"$`\\\n]/.test(pidFile)) throw new Error(`a pid file path with a shell character: ${pidFile}`);
  return `trap "" TERM; ps -o pgid= -p $$ > "${pidFile}.pgid"; echo $$ > "${pidFile}"; end=$(( $(date +%s) + ${STUBBORN_SECONDS} )); while [ "$(date +%s)" -lt "$end" ]; do sleep 0.1; done`;
}
/** The arguments for `sh`. The tag is the shell's `$0`, so `ps` shows it. */
export const stubbornArgs = (pidFile: string, tag: string): string[] => ["-c", stubbornScript(pidFile), tag];
/** The same as one shell command. */
export const stubbornShell = (pidFile: string, tag: string): string => `sh -c '${stubbornScript(pidFile)}' ${tag}`;

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  /** The start time: tells a process from a later one with the same pid. */
  start: string;
  command: string;
}

export function parsePsRows(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+[\d:]+\s+\d{4})(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4]!, start: m[5]!.replace(/\s+/g, " "), command: (m[6] ?? "").trimEnd() });
  }
  return rows;
}

const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="];
const PS_OPTS = () => ({ env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" as const });

/** Every process now, without the `ps` that reads them; undefined when ps fails. */
export function processRows(): PsRow[] | undefined {
  const r = spawnSync("ps", PS_ARGS, PS_OPTS());
  return r.status === 0 ? parsePsRows(r.stdout).filter((p) => p.pid !== r.pid) : undefined;
}

/**
 * Reads the process table, trying again when a read fails. Throws when every try fails: a check that cannot see the
 * processes must not pass.
 */
export async function listWithRetry(list: () => PsRow[] | undefined, tries = 3, waitMs = 500): Promise<PsRow[]> {
  for (let i = 1; ; i++) {
    const rows = list();
    if (rows) return rows;
    if (i >= tries) throw new Error(`ps failed ${tries} times: the processes started by the tests cannot be checked`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** The same without the commands (`command` is empty): cheaper, for following the processes while the tests run. */
export function processRowsAsync(): Promise<PsRow[] | undefined> {
  return new Promise((done) => {
    const c = execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], PS_OPTS(), (err, stdout) => done(err ? undefined : parsePsRows(stdout).filter((p) => p.pid !== c.pid)));
  });
}

const keyOf = (r: PsRow) => `${r.pid} ${r.start}`;

/**
 * What a suite owns: the processes that descend from `root` (the main vitest process). A process stays owned after its
 * parents are gone, and so does the group of an owned group leader, also after that leader has ended. The direct children
 * of the root (the vitest workers and tools of vitest itself) are never reported; everything below them is.
 * Feed it the process table often: a process is known only once it was seen.
 */
export class Owned {
  private known = new Map<string, { direct: boolean }>();
  private groups = new Set<number>();

  constructor(private readonly root: number) {}

  fold(rows: PsRow[]): void {
    const present = new Set(rows.map(keyOf));
    for (const k of this.known.keys()) if (!present.has(k)) this.known.delete(k);
    // a group with no member left is forgotten: its number may be used again by a stranger
    const used = new Set(rows.map((r) => r.pgid));
    for (const g of this.groups) if (!used.has(g)) this.groups.delete(g);
    const parents = new Map<number, boolean>(); // pid → is the root or a direct child of it
    for (const r of rows) {
      const k = this.known.get(keyOf(r));
      if (k) parents.set(r.pid, k.direct);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const r of rows) {
        if (r.pid === this.root || this.known.has(keyOf(r))) continue;
        const direct = r.ppid === this.root;
        if (!direct && !parents.has(r.ppid) && !this.groups.has(r.pgid)) continue;
        this.known.set(keyOf(r), { direct });
        parents.set(r.pid, direct);
        changed = true;
      }
      for (const r of rows) {
        if (r.pgid === r.pid && this.known.get(keyOf(r))?.direct === false && !this.groups.has(r.pgid)) {
          this.groups.add(r.pgid);
          changed = true;
        }
      }
    }
  }

  has(r: PsRow): boolean {
    return this.known.get(keyOf(r))?.direct === false;
  }
}

/** The live rows that are the suite's: owned, or with this run's tag in the command. Never a zombie, `self` or its ancestors. */
export function strayRows(rows: PsRow[], o: { tag: string; owned: Pick<Owned, "has">; self: number }): PsRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const mine = new Set<number>([o.self]);
  for (let p = byPid.get(o.self)?.ppid; p !== undefined && p > 0 && !mine.has(p); p = byPid.get(p)?.ppid) mine.add(p);
  return rows.filter((r) => r.pid > 1 && !r.stat.startsWith("Z") && !mine.has(r.pid) && (o.owned.has(r) || r.command.includes(o.tag)));
}

export const formatStrays = (rows: PsRow[]): string => rows.map((r) => `  pid ${r.pid} (parent ${r.ppid}): ${r.command.slice(0, 200)}`).join("\n");

function pgidOf(pid: number): number | undefined {
  const r = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  const n = Number(r.stdout?.trim());
  return r.status === 0 && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
const readNumber = (file: string): number | undefined => {
  try {
    const text = readFileSync(file, "utf8");
    const n = Number(text.trim());
    return text.endsWith("\n") && Number.isSafeInteger(n) && n > 1 ? n : undefined; // without the newline it is half written
  } catch {
    return undefined;
  }
};
const sigkill = (target: number) => {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // already gone
  }
};

/**
 * The processes of one test that must not outlive it. The group of each is noted as soon as the process is known, so the
 * whole group can still be killed after its leader has ended. `kill()` belongs in `afterEach` (or `onTestFinished`).
 */
export class Watched {
  private pids = new Set<number>();
  private groups = new Set<number>();
  private files = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private own: number | undefined;

  /** A running process. Its group is killed too, unless it shares the group of the test process. */
  pid(pid: number, group = pgidOf(pid)): void {
    if (pid <= 1 || pid === process.pid) return;
    this.pids.add(pid);
    if (group !== undefined) this.group(group);
  }

  /** The group of a process spawned with `detached` (its pid). Never group 0 or 1, or the test's own. */
  group(pgid: number): void {
    this.own ??= pgidOf(process.pid);
    if (this.own !== undefined && pgid > 1 && pgid !== this.own) this.groups.add(pgid);
  }

  /** A file a process writes its pid to (and a newline). It is read as soon as it is there, and at the latest by `kill()`. */
  file(path: string): void {
    this.files.add(path);
    this.timer ??= setInterval(() => this.read(), 25);
    this.timer.unref();
  }

  private read(): void {
    for (const f of this.files) {
      const pid = readNumber(f);
      if (pid === undefined) continue;
      this.files.delete(f);
      let group: number | undefined;
      try {
        group = Number(readFileSync(`${f}.pgid`, "utf8").trim()) || undefined; // the stubborn fixture writes it itself
      } catch {
        // another fixture: ask ps
      }
      this.pid(pid, group ?? pgidOf(pid));
    }
    if (!this.files.size) this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** SIGKILL for every group first, then for every pid. Never throws. */
  kill(): void {
    this.read();
    this.stop();
    for (const g of this.groups) sigkill(-g);
    for (const p of this.pids) sigkill(p);
    this.files.clear();
    this.groups.clear();
    this.pids.clear();
  }
}
