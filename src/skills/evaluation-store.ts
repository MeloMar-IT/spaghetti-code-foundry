import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import type { EvaluationRecord } from "./evaluation.js";
import { EVALUATION_STORE_LIMITS, EVALUATIONS_DIR } from "./evaluation-rules.js";
import { byteCmp } from "./import-plan.js";
import { readRegular } from "./package.js";
import { SKILL_ID_RE } from "./schema.js";
import { approvedRefProblem, shownValue } from "./sources.js";

// The evaluation records of staged skills: <data folder>/skill-evaluations/<source>/<commit>/<id>--<10-digit sequence>.json.
// Never inside the quarantine, so a staged import still reads as valid. A record is written to a .tmp- file (0600, synced) and
// published with an exclusive link to the next free sequence number; an earlier record is never replaced. The sequence, not the
// clock, tells which record is the newest. Folders are 0700 and are checked for links, mode and realpath, like the quarantine.
// Reading never creates anything and fails closed: an unreadable newest record is reported, never skipped for an older one.

const L = EVALUATION_STORE_LIMITS;
const TMP_PREFIX = ".tmp-";
const SEQ_RE = /^(\d{10})\.json$/;
const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Test hooks: the exclusive link that publishes a record, and the resolver of the containment check. */
export const evaluationStoreSettings: { link: (from: string, to: string) => void; realpath: (p: string) => string } = {
  link: linkSync,
  realpath: realpathSync,
};

export class EvaluationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationStoreError";
  }
}

export const evaluationsDir = (source: string, commit: string, home = dataHome()): string => join(home, EVALUATIONS_DIR, source, commit);
export const recordFileName = (id: string, seq: number): string => `${id}--${String(seq).padStart(10, "0")}.json`;

const enoent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const codeOf = (e: unknown): string => {
  const c = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof c === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(c) ? c : "error";
};
const nameOk = (source: string, commit: string, id?: string): boolean =>
  SKILL_ID_RE.test(source) && approvedRefProblem(commit) === undefined && COMMIT_RE.test(commit) && (id === undefined || SKILL_ID_RE.test(id));

/** An existing folder must be a plain 0700 folder; a missing one is made when `create` is set, else "none". Nothing is ever changed. */
function plainDir(path: string, label: string, create: boolean): "ok" | "none" {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (!enoent(e)) throw e;
    if (!create) return "none";
    mkdirSync(path, { mode: 0o700 });
    return "ok";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new EvaluationStoreError(`${label} is not a plain folder`);
  if ((st.mode & 0o777) !== 0o700) throw new EvaluationStoreError(`${label} must have mode 0700; nothing was changed`);
  return "ok";
}

/** Walks (and with `create`, makes) skill-evaluations/<parts…> below the real data folder. Undefined: a folder is missing. */
function chain(realHome: string, parts: string[], create: boolean): string | undefined {
  let cur = realHome;
  const shown: string[] = [EVALUATIONS_DIR];
  cur = join(cur, EVALUATIONS_DIR);
  if (plainDir(cur, EVALUATIONS_DIR, create) === "none") return undefined;
  for (const p of parts) {
    cur = join(cur, p);
    shown.push(shownValue(p.length > 12 && COMMIT_RE.test(p) ? p.slice(0, 12) : p));
    if (plainDir(cur, shown.join("/"), create) === "none") return undefined;
  }
  return cur;
}

interface Listed { seq: number; name: string }
/** The records of one skill in a folder, lowest sequence first. Other names are ignored. */
function listRecords(dir: string, id: string): Listed[] {
  const names = readdirSync(dir);
  if (names.length > L.files) throw new EvaluationStoreError("the evaluation folder holds too many files");
  const mine: Listed[] = [];
  const prefix = `${id}--`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = SEQ_RE.exec(name.slice(prefix.length));
    if (m) mine.push({ seq: Number(m[1]), name });
  }
  return mine.sort((a, b) => a.seq - b.seq || byteCmp(a.name, b.name));
}

/** Writes and publishes one record. The record must come from parseEvaluationRecord. */
export function writeEvaluationRecord(record: EvaluationRecord, opts: { home?: string } = {}): { file: string; seq: number } {
  const { id, source, commit } = record.candidate;
  if (!nameOk(source, commit, id)) throw new EvaluationStoreError("the record names a source, skill or commit that cannot be stored");
  const text = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(text) > L.recordBytes) throw new EvaluationStoreError("the record is too large to store");
  const home = opts.home ?? dataHome();
  const dir = evaluationsDir(source, commit, home);
  let result: { file: string; seq: number } | undefined;

  const write = () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const realHome = realpathSync(home);
    const made = chain(realHome, [source, commit], true)!;
    if (evaluationStoreSettings.realpath(made) !== made) throw new EvaluationStoreError("the evaluation folder is not inside the data folder");
    const tmp = join(made, TMP_PREFIX + randomBytes(8).toString("hex"));
    let fd: number | undefined = openSync(tmp, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      const bytes = Buffer.from(text);
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      for (let i = 0; i < L.linkTries; i++) {
        const last = listRecords(made, id).at(-1)?.seq ?? 0;
        const seq = last + 1;
        if (seq > 9_999_999_999) throw new EvaluationStoreError("the evaluation folder is full");
        const name = recordFileName(id, seq);
        try {
          evaluationStoreSettings.link(tmp, join(made, name));
        } catch (e) {
          if (codeOf(e) === "EEXIST") continue;
          throw e;
        }
        result = { file: name, seq };
        return;
      }
      throw new EvaluationStoreError("the evaluation folder is busy; try again");
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // gone, or left for the next look: readers ignore it
      }
    }
  };

  try {
    claimHomeWrite(
      dir,
      write,
      10_000,
      (kind) => new EvaluationStoreError(kind === "busy" ? "the data folder is locked by another scf process; try again in a moment" : "the data folder moved; restart scf"),
    );
  } catch (e) {
    if (e instanceof EvaluationStoreError) throw e;
    throw new EvaluationStoreError(`the evaluation folder cannot be written (${codeOf(e)})`);
  }
  return result!;
}

// --- read only below this line ---

export type StoredRecordRead = { state: "none" } | { state: "invalid"; problem: string } | { state: "ok"; raw: unknown; file: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The parsed JSON of a record file, or why it cannot be used. */
function readRecordFile(path: string): { raw: unknown } | { problem: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return { problem: `cannot be read (${codeOf(e)})` };
  }
  if (st.isSymbolicLink()) return { problem: "is a link" };
  if (!st.isFile()) return { problem: "is not a regular file" };
  if ((st.mode & 0o777) !== 0o600) return { problem: "has the wrong mode" };
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, L.recordBytes);
  } catch (e) {
    return { problem: `cannot be read (${codeOf(e)})` };
  }
  if (data === "link") return { problem: "is a link" };
  if (data === "other") return { problem: "is not a readable regular file" };
  if (data === "large") return { problem: "is too large" };
  try {
    return { raw: JSON.parse(Buffer.from(data).toString("utf8")) as unknown };
  } catch {
    return { problem: "is not valid JSON" };
  }
}

const shownFile = (source: string, commit: string, name: string) => `${EVALUATIONS_DIR}/${source}/${commit.slice(0, 12)}/${shownValue(name)}`;

/** The newest record (highest sequence) of one skill of one import. A record that cannot be read is reported, never skipped. */
export function readNewestRecord(source: string, commit: string, id: string, opts: { home?: string } = {}): StoredRecordRead {
  if (!nameOk(source, commit, id)) return { state: "invalid", problem: "the source, skill or commit is not a valid name" };
  try {
    const home = opts.home ?? dataHome();
    let realHome: string;
    try {
      realHome = realpathSync(home);
    } catch (e) {
      if (enoent(e)) return { state: "none" };
      throw e;
    }
    const dir = chain(realHome, [source, commit], false);
    if (dir === undefined) return { state: "none" };
    const newest = listRecords(dir, id).at(-1);
    if (!newest) return { state: "none" };
    const label = shownFile(source, commit, newest.name);
    const read = readRecordFile(join(dir, newest.name));
    if ("problem" in read) return { state: "invalid", problem: `the record ${label} ${read.problem}` };
    const c = isObj(read.raw) && isObj(read.raw.candidate) ? read.raw.candidate : undefined;
    if (!c || c.id !== id || c.source !== source || c.commit !== commit) return { state: "invalid", problem: `the record ${label} is of another skill, source or commit` };
    return { state: "ok", raw: read.raw, file: label };
  } catch (e) {
    if (e instanceof EvaluationStoreError) return { state: "invalid", problem: e.message };
    return { state: "invalid", problem: `the evaluation folder cannot be read (${codeOf(e)})` };
  }
}

interface Found { raw: Record<string, unknown>; at: string; seq: number; folder: string; file: string }

/**
 * The newest record of the skill `id` with package digest `digest`, anywhere under skill-evaluations/. Registered skills carry
 * no source or commit, so every folder is searched. In each folder the newest record of the digest wins; a newer record that
 * cannot be read makes the lookup invalid. The winners of different folders are compared by time; a tie is ambiguous and
 * also invalid.
 */
export function findNewestRecordOf(id: string, digest: string, opts: { home?: string } = {}): StoredRecordRead {
  if (!SKILL_ID_RE.test(id)) return { state: "invalid", problem: "the skill is not a valid name" };
  try {
    const home = opts.home ?? dataHome();
    let realHome: string;
    try {
      realHome = realpathSync(home);
    } catch (e) {
      if (enoent(e)) return { state: "none" };
      throw e;
    }
    const root = chain(realHome, [], false);
    if (root === undefined) return { state: "none" };
    const found: Found[] = [];
    let seen = 0;
    for (const source of readdirSync(root).sort(byteCmp)) {
      if (!SKILL_ID_RE.test(source)) continue;
      const sdir = chain(realHome, [source], false);
      if (sdir === undefined) continue;
      for (const commit of readdirSync(sdir).sort(byteCmp)) {
        if (!COMMIT_RE.test(commit)) continue;
        const cdir = chain(realHome, [source, commit], false);
        if (cdir === undefined) continue;
        // Newest first; the first record of this digest is the winner of the folder and older ones are never read. A newer
        // record that cannot be read could be of this digest, so it fails the lookup.
        for (const rec of listRecords(cdir, id).reverse()) {
          if (++seen > L.files) return { state: "invalid", problem: "the evaluation folders hold too many records" };
          const label = shownFile(source, commit, rec.name);
          const read = readRecordFile(join(cdir, rec.name));
          if ("problem" in read) return { state: "invalid", problem: `the record ${label} ${read.problem}` };
          const raw = read.raw;
          const c = isObj(raw) && isObj(raw.candidate) ? raw.candidate : undefined;
          if (!isObj(raw) || !c || c.id !== id || c.source !== source || c.commit !== commit || typeof raw.evaluatedAt !== "string") {
            return { state: "invalid", problem: `the record ${label} is of another skill, source or commit` };
          }
          if (c.digest === digest) {
            found.push({ raw, at: raw.evaluatedAt, seq: rec.seq, folder: `${source}/${commit}`, file: label });
            break;
          }
        }
      }
    }
    if (found.length === 0) return { state: "none" };
    // One winner per folder (the highest sequence), then the latest time among the winners.
    const best = found.reduce((a, b) => (byteCmp(b.at, a.at) > 0 ? b : a));
    if (found.some((f) => f !== best && f.at === best.at)) {
      return { state: "invalid", problem: `two records of ${id} have the same time; the newest is ambiguous` };
    }
    return { state: "ok", raw: best.raw, file: best.file };
  } catch (e) {
    if (e instanceof EvaluationStoreError) return { state: "invalid", problem: e.message };
    return { state: "invalid", problem: `the evaluation folder cannot be read (${codeOf(e)})` };
  }
}
