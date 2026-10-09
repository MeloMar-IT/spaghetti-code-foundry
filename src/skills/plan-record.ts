import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StoreError, dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import { acquireLock, releaseLock } from "../home-migrate.js";
import { readRegular } from "./package.js";
import {
  MAX_PLAN_RECORD_BYTES, PLAN_RECORD_KEEP, PlanRecordSchema, PurgedNoteSchema, compareCommentIds, planRecordKey, sameKey,
  type PlanRecord, type PlanRecordKey, type PlanRecordsRead,
} from "./plan-record-rules.js";

// The store of plan records: <data folder>/skill-plans/<owner>/<repo>/<issue>/<plan hash hex>.json, one file per plan,
// with the skill request of the plan. Written under its own lock (skill-plans.lock). Everything that is not exactly a
// record makes a read "invalid" (fail closed); nothing here is read from a comment.

export * from "./plan-record-rules.js";

const ROOT = "skill-plans";
const LOCK_NAME = "skill-plans.lock";
const PURGED_FILE = "purged.json";
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;

/** Test hook: how long a write waits for the lock. */
export const planStoreSettings = { waitMs: 2000 };

type Entry = { file: string; record: PlanRecord };
type Scan = { entries: Entry[]; purged?: { skills: string[]; at: string }; bad: string[] } | "invalid";

function withPlanLock(home: string, fn: () => void): void {
  const waitMs = planStoreSettings.waitMs;
  const lock = join(home, LOCK_NAME);
  const until = Date.now() + waitMs;
  claimHomeWrite(
    lock,
    () => {
      try {
        mkdirSync(home, { recursive: true, mode: 0o700 });
      } catch (e) {
        throw new StoreError("cannot-write", home, `cannot be created (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      let got: boolean;
      try {
        got = acquireLock(lock, Math.max(0, until - Date.now()));
      } catch (e) {
        throw new StoreError("cannot-write", lock, `cannot be locked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      if (!got) throw new StoreError("locked", lock, "is held by another scf process; try again, or delete this folder if no scf is running");
      try {
        fn();
      } finally {
        releaseLock(lock);
      }
    },
    waitMs,
    (kind, detail) =>
      kind === "busy"
        ? new StoreError("locked", detail, "is held by another scf process; try again in a moment")
        : new StoreError("cannot-write", home, `cannot be changed: the data folder moved to ${detail}; restart scf`),
  );
}

/** Exclusive create (never follows a link), mode 0600, then a rename. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(text, "utf8");
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}

const isRealDir = (p: string): boolean | undefined => {
  try {
    return lstatSync(p).isDirectory();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : false;
  }
};

/** The issue folder, walking every component without following links. "missing" from the first missing one. */
function issueDir(home: string, key: PlanRecordKey, create: boolean): string | "missing" | "invalid" {
  let dir = home;
  for (const part of [ROOT, key.owner, key.name, key.issue]) {
    dir = join(dir, part);
    const real = isRealDir(dir);
    if (real === false) return "invalid";
    if (real === undefined) {
      if (!create) return "missing";
      mkdirSync(dir, { mode: 0o700 });
    }
  }
  return dir;
}

function scanIssueDir(dir: string, key: PlanRecordKey): Scan {
  const out: Scan = { entries: [], bad: [] };
  if (isRealDir(dir) !== true) return "invalid";
  const gone = (p: string) => {
    try {
      lstatSync(p);
      return false;
    } catch {
      return true;
    }
  };
  const load = (name: string): unknown | "vanished" | "bad" => {
    const path = join(dir, name);
    const bytes = readRegular(path, MAX_PLAN_RECORD_BYTES);
    if (typeof bytes === "string") return bytes === "other" && gone(path) ? "vanished" : "bad";
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return "bad";
    }
  };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "invalid";
  }
  for (const name of names) {
    if (name.endsWith(".tmp")) continue;
    const json = name === PURGED_FILE || RECORD_FILE.test(name) ? load(name) : "bad";
    if (json === "vanished") continue;
    if (json === "bad") {
      out.bad.push(name);
      continue;
    }
    if (name === PURGED_FILE) {
      const n = PurgedNoteSchema.safeParse(json);
      if (n.success) out.purged = n.data;
      else out.bad.push(name);
      continue;
    }
    const r = PlanRecordSchema.safeParse(json);
    if (!r.success || r.data.planHash !== "sha256:" + name.slice(0, -5) || !sameKey(planRecordKey(r.data.repo, r.data.issue), key)) out.bad.push(name);
    else out.entries.push({ file: name, record: r.data });
  }
  return out;
}

const byCommentDesc = (a: Entry, b: Entry) => compareCommentIds(b.record.commentId, a.record.commentId);

export function readPlanRecords(repo: string, issue: string, opts: { home?: string } = {}): PlanRecordsRead {
  const key = planRecordKey(repo, issue);
  if (!key) return { records: [] };
  const dir = issueDir(opts.home ?? dataHome(), key, false);
  if (dir === "missing") return { records: [] };
  if (dir === "invalid") return "invalid";
  const scan = scanIssueDir(dir, key);
  if (scan === "invalid" || scan.bad.length) return "invalid";
  const ids = new Set(scan.entries.map((e) => BigInt(e.record.commentId)));
  if (ids.size !== scan.entries.length) return "invalid";
  const records = scan.entries.sort((a, b) => -byCommentDesc(a, b)).map((e) => e.record);
  return { records, ...(scan.purged ? { purged: scan.purged } : {}) };
}

export function writePlanRecord(record: PlanRecord, opts: { home?: string } = {}): void {
  const rec = PlanRecordSchema.parse(record);
  const key = planRecordKey(rec.repo, rec.issue);
  if (!key) throw new Error("the plan record has no valid repository or issue");
  const text = JSON.stringify(rec, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_PLAN_RECORD_BYTES) throw new Error("the plan record is too large");
  const home = opts.home ?? dataHome();
  withPlanLock(home, () => {
    const dir = issueDir(home, key, true);
    if (dir === "invalid" || dir === "missing") throw new StoreError("cannot-write", join(home, ROOT), "is not a plain folder");
    const name = rec.planHash.slice("sha256:".length) + ".json";
    writeAtomic(join(dir, name), text);
    const scan = scanIssueDir(dir, key);
    if (scan !== "invalid") {
      const others = scan.entries.filter((e) => e.file !== name);
      const same = others.filter((e) => compareCommentIds(e.record.commentId, rec.commentId) === 0);
      for (const e of same) rmSync(join(dir, e.file), { force: true });
      const rest = scan.entries.filter((e) => e.file === name || !same.includes(e)).sort(byCommentDesc);
      for (const e of rest.slice(PLAN_RECORD_KEEP)) rmSync(join(dir, e.file), { force: true });
    }
    rmSync(join(dir, PURGED_FILE), { force: true });
  });
}

const subdirs = (p: string): string[] => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** Removes the valid records older than `olderThanMs` and returns how many. Anything that is not a valid record stays. */
export function prunePlanRecords(o: { olderThanMs: number; dryRun?: boolean; home?: string }): number {
  const home = o.home ?? dataHome();
  const root = join(home, ROOT);
  const folders: { dir: string; key: PlanRecordKey }[] = [];
  for (const owner of isRealDir(root) === true ? subdirs(root) : [])
    for (const name of subdirs(join(root, owner)))
      for (const issue of subdirs(join(root, owner, name))) {
        const key = planRecordKey(`${owner}/${name}`, issue);
        if (key && key.owner === owner && key.name === name && key.issue === issue) folders.push({ dir: join(root, owner, name, issue), key });
      }
  const now = Date.now();
  const old = (r: PlanRecord) => now - Date.parse(r.createdAt) > o.olderThanMs;
  const sweep = (): number => {
    let count = 0;
    for (const { dir, key } of folders) {
      if (isRealDir(join(root, key.owner)) !== true || isRealDir(join(root, key.owner, key.name)) !== true) continue;
      const scan = scanIssueDir(dir, key);
      if (scan === "invalid") continue;
      const gone = scan.entries.filter((e) => old(e.record));
      if (!gone.length) continue;
      count += gone.length;
      if (o.dryRun) continue;
      for (const e of gone) rmSync(join(dir, e.file), { force: true });
      if (gone.length === scan.entries.length) {
        const skills = [...new Set(gone.flatMap((e) => e.record.request.skills.map((s) => s.id)))].sort();
        writeAtomic(join(dir, PURGED_FILE), JSON.stringify({ skills, at: new Date().toISOString() }, null, 2) + "\n");
      }
    }
    return count;
  };
  if (o.dryRun) return sweep();
  let n = 0;
  withPlanLock(home, () => {
    n = sweep();
  });
  return n;
}
