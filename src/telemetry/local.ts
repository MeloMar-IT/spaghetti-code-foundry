import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";

/**
 * The local telemetry files: `<data folder>/telemetry/events-YYYY-MM-DD.jsonl`, one line per event, the day being the
 * UTC day of writing. The folder is 0700 and the files 0600. Nothing is written through a link, into a folder that
 * somebody else owns, or into a data folder that others can write to.
 */

export const TELEMETRY_DIR = "telemetry";
export const telemetryDir = (): string => join(dataHome(), TELEMETRY_DIR);
export const telemetryDay = (now: Date): string => now.toISOString().slice(0, 10);
export const telemetryFile = (day: string): string => join(telemetryDir(), `events-${day}.jsonl`);

const SAFE = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const DAY_MS = 86_400_000;
const FILE_NAME = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const UID = (): number | undefined => process.getuid?.();

/** True when the file belongs to `uid`. Without a uid (Windows) there is nothing to check. */
export function ownedByUs(st: { uid: number }, uid: number | undefined): boolean {
  return uid === undefined || st.uid === uid;
}

export class TelemetryWriter {
  private fd: number | undefined;
  private path: string | undefined;
  private needNewline = false;

  constructor(private readonly keepDays: () => number) {}

  /** Adds one line. Throws on any problem; the caller counts it as a dropped event. */
  write(line: string, now: Date = new Date()): void {
    const file = telemetryFile(telemetryDay(now));
    if (this.fd === undefined || this.path !== file) {
      this.close();
      this.open(file);
      sweepTelemetry(this.keepDays(), now);
    }
    const buf = Buffer.from(`${this.needNewline ? "\n" : ""}${line}\n`);
    try {
      if (writeSync(this.fd!, buf) !== buf.length) throw new Error("a short write");
      this.needNewline = false;
    } catch (e) {
      this.close();
      throw e;
    }
  }

  private open(file: string): void {
    const home = dataHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const h = lstatSync(home);
    if (!h.isDirectory() || !ownedByUs(h, UID()) || (h.mode & 0o022) !== 0) throw new Error("the data folder is not private to this user");
    const dir = telemetryDir();
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const before = lstatSync(dir);
    if (!before.isDirectory() || !ownedByUs(before, UID())) throw new Error("the telemetry folder is not a folder of this user");
    if (before.mode & 0o077) chmodSync(dir, 0o700);
    const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | SAFE, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || !ownedByUs(st, UID()) || st.dev !== before.dev) throw new Error("the telemetry file is not a plain file of this user");
      if (st.mode & 0o077) fchmodSync(fd, 0o600);
      const after = lstatSync(dir);
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("the telemetry folder was replaced");
      let torn = false;
      if (st.size > 0) {
        const last = Buffer.alloc(1);
        torn = readSync(fd, last, 0, 1, st.size - 1) !== 1 || last[0] !== 0x0a;
      }
      this.needNewline = torn;
    } catch (e) {
      try {
        closeSync(fd);
      } catch {
        // nothing more to do
      }
      throw e;
    }
    this.fd = fd;
    this.path = file;
  }

  /** Asks the system to put what was written on disk. Never throws. */
  flush(): void {
    try {
      if (this.fd !== undefined) fsyncSync(this.fd);
    } catch {
      // best effort
    }
  }

  /** Never throws. */
  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    this.path = undefined;
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // nothing more to do
    }
  }
}

/**
 * Removes `events-<day>.jsonl` plain files older than `keepDays` UTC days (30 keeps today and the 29 days before).
 * Nothing else is touched, and nothing through a link or a replaced folder. Returns how many were removed. Never throws.
 */
export function sweepTelemetry(keepDays: number, now: Date = new Date()): number {
  let removed = 0;
  try {
    const dir = telemetryDir();
    // the same rule as the writer: a data folder that is a link, or that others can write to, is not swept
    const h = lstatSync(dataHome());
    if (!h.isDirectory() || !ownedByUs(h, UID()) || (h.mode & 0o022) !== 0) return 0;
    const d = lstatSync(dir);
    if (!d.isDirectory() || !ownedByUs(d, UID())) return 0;
    const limit = Date.parse(telemetryDay(now)) - keepDays * DAY_MS;
    for (const name of readdirSync(dir)) {
      const day = FILE_NAME.exec(name)?.[1];
      if (!day || !(Date.parse(day) <= limit)) continue;
      try {
        const again = lstatSync(dir);
        if (again.dev !== d.dev || again.ino !== d.ino) return removed;
        const entry = join(dir, name);
        if (!lstatSync(entry).isFile()) continue;
        unlinkSync(entry);
        removed++;
      } catch {
        // one entry that cannot be removed does not stop the others
      }
    }
  } catch {
    // no folder, or not readable: nothing to sweep
  }
  return removed;
}
