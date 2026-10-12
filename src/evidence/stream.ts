import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { secretRedactor, type Redactor } from "../credentials/redact.js";
import { appendLiveLog } from "../engine/state.js";
import { canonicalJson, eventHash } from "./canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "./chain.js";
import { EvidenceEventSchema, type EvidenceEvent } from "./schema.js";
import { EVIDENCE_EVENT_VERSION, EVIDENCE_EVENTS_FILE, EVIDENCE_INCOMPLETE_FILE } from "./version.js";

/**
 * The event stream of a run: `evidence.jsonl` in the run folder, one event per line, only appended.
 * Every line is in the canonical form and carries the hash of the line before it and its own (see chain.ts).
 *
 * Writing evidence can never fail a run: `append` does not throw. The first problem is reported once (to the live log
 * of the run) and the stream stops for good: a mark (`evidence.incomplete`) is left in the run folder, and no later
 * start of the run continues the stream. So a stream is whole up to its last line or it has stopped; it never goes on
 * after a hole, and a run whose stream stopped never gets a manifest.
 *
 * Stored secrets are hidden in every event before it is written (the same filter as for logs: credentials/redact.ts).
 * When that filter cannot be used, the stream stops as after any other problem.
 */

/** True when the stream of this run stopped after a problem (see EVIDENCE_INCOMPLETE_FILE). */
export function evidenceIncomplete(runDir: string): boolean {
  try {
    lstatSync(join(runDir, EVIDENCE_INCOMPLETE_FILE));
    return true;
  } catch (e) {
    // only "it is not there" means whole; a mark that cannot be looked at counts as there
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function markIncomplete(runDir: string): void {
  try {
    closeSync(openSync(join(runDir, EVIDENCE_INCOMPLETE_FILE), constants.O_WRONLY | constants.O_CREAT | SAFE, 0o600));
  } catch {
    // the folder is gone or cannot be written: there is nothing to continue either
  }
}

type Envelope = "version" | "id" | "seq" | "runId" | "time" | "prevHash" | "hash";
type Body<E> = E extends unknown ? Omit<E, Envelope> : never;
/** An event without the fields the stream gives it. */
export type EvidenceEventBody = Body<EvidenceEvent>;

/** The id of the event at one place of the stream: the same for the same place, always. */
export const evidenceEventId = (seq: number): string => `ev-${String(seq).padStart(6, "0")}`;

// One open that never follows a link and never waits for a pipe: a step may have put one where the file should be.
const SAFE = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

class StreamProblem extends Error {}

/** The redactor for the stored secrets. A store that cannot be read is a problem of the stream: nothing is written unchecked. */
function redactorOrProblem(): Redactor {
  try {
    return secretRedactor();
  } catch {
    throw new StreamProblem("the stored credentials cannot be read, so an event cannot be checked for secrets");
  }
}

/** The value with every stored secret hidden in its texts (not in the names of its fields). */
function redactValue(r: Redactor, value: unknown, depth = 0): unknown {
  if (typeof value === "string") return r.redact(value);
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(r, v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(r, v, depth + 1)]));
}

/** The bytes of a plain file; undefined when there is none. Throws for a link, a pipe or a folder. */
export function readPlainBytes(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | SAFE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new StreamProblem("not a plain file");
    return readAll(fd, st.size);
  } finally {
    closeSync(fd);
  }
}

function readAll(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = readSync(fd, buf, got, size - got, got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** The SHA-256 and size of a plain file, read in pieces; undefined when it is missing or is not a plain file. */
export function hashPlainFile(path: string): { sha256: string; bytes: number } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | SAFE);
    if (!fstatSync(fd).isFile()) return undefined;
    const hash = createHash("sha256");
    const buf = Buffer.alloc(1 << 16);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, bytes);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
    return { sha256: hash.digest("hex"), bytes };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Why a write did not happen, without any value of the event or path of the machine. */
function reasonOf(e: unknown): string {
  if (e instanceof StreamProblem) return e.message;
  if (e instanceof ZodError) return `an event was not valid (${[...new Set(e.issues.map((i) => i.path.map(String).join(".") || "(root)"))].slice(0, 5).join(", ")})`;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return `the file could not be written (${typeof code === "string" ? code : "error"})`;
}

export class EvidenceStream {
  readonly file: string;
  /** The `seq` of the next event. */
  private next = 0;
  /** The size the file has when only this object wrote since it was read; -1: not read yet. */
  private size = -1;
  /** The `hash` of the last event; null before the first. */
  private last: string | null = null;
  private stopped = false;

  constructor(
    readonly runDir: string,
    readonly runId: string,
    private readonly report: (line: string) => void = (line) => appendLiveLog(runDir, line),
  ) {
    this.file = join(runDir, EVIDENCE_EVENTS_FILE);
  }

  /** True after the first problem: nothing more is written by this object. */
  get hasStopped(): boolean {
    return this.stopped;
  }

  /** Adds one event as one line and returns it; undefined when it was not written. Never throws. */
  append(body: EvidenceEventBody, time: string = new Date().toISOString()): EvidenceEvent | undefined {
    if (this.stopped) return undefined;
    if (this.size < 0 && evidenceIncomplete(this.runDir)) {
      this.stopped = true;
      this.say("· evidence: the evidence of this run stopped earlier; it is not continued");
      return undefined;
    }
    try {
      // never makes the run folder: a run that was removed gets no new file
      const fd = openSync(this.file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | SAFE, 0o600);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new StreamProblem("evidence.jsonl is not a plain file");
        // Another process may have written since (a resume from the command line): what is on disk decides.
        if (st.size !== this.size) this.load(fd, st.size);
        // Stored secrets are hidden before anything is written. The envelope (ids, numbers, the time) is made here.
        const redactor = redactorOrProblem();
        if (!redactor.empty) body = redactValue(redactor, body) as EvidenceEventBody;
        const unhashed = EvidenceEventSchema.parse({ ...body, version: EVIDENCE_EVENT_VERSION, id: evidenceEventId(this.next), seq: this.next, runId: this.runId, time });
        // the hash is taken over the event as it is written: the last line's hash is in it as prevHash
        const event = EvidenceEventSchema.parse({ ...unhashed, prevHash: this.last, hash: eventHash({ ...unhashed, prevHash: this.last }) });
        const line = canonicalJson(event);
        if (!redactor.empty && redactor.find(line).length) throw new StreamProblem("an event would hold a stored secret");
        this.write(fd, `${line}\n`);
        this.next++;
        this.last = event.hash!;
        return event;
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      this.stop(e);
      return undefined;
    }
  }

  /** Ends the stream for this object after a problem and says so once. Never throws. */
  stop(e: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    markIncomplete(this.runDir);
    this.say(`! evidence: ${reasonOf(e)}; no more evidence is written for this run and it cannot be verified. The run itself goes on.`);
  }

  private say(line: string): void {
    try {
      this.report(line);
    } catch {
      // a report that fails changes nothing
    }
  }

  private write(fd: number, text: string): void {
    const buf = Buffer.from(text, "utf8");
    let done = 0;
    while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done);
    this.size += buf.length;
  }

  /**
   * Reads what is there, checks it as one chain and finds the place of the next event. Lines that are complete are
   * never changed. A last line without its line end was cut off while it was written (the process died): when it is
   * the whole next event of the chain it gets its line end, otherwise the piece is removed, because it never was an event.
   * A stream that is not a chain (a changed line, a line without hashes) is not continued.
   */
  private load(fd: number, size: number): void {
    const raw = readAll(fd, size);
    const { lines, tail } = splitEvidenceLines(raw.toString("utf8"));
    this.size = size;
    // first the whole lines: a file that is not a chain is left exactly as it is
    let chain = readEvidenceChain(lines, this.runId);
    if (!chain.ok) throw new StreamProblem(`evidence.jsonl is not an unbroken chain of this run (${chain.message})`);
    if (tail !== "") {
      const withTail = readEvidenceChain([...lines, tail], this.runId);
      if (withTail.ok) {
        this.write(fd, "\n");
        lines.push(tail);
        chain = withTail;
      } else {
        // in bytes of the file: a character cut in half decodes to a different length
        this.size = raw.lastIndexOf(0x0a) + 1;
        ftruncateSync(fd, this.size);
        this.say("· evidence: the last line was cut off when the run was interrupted; the piece was removed");
      }
    }
    this.last = chain.terminalHash;
    this.next = lines.length;
  }
}

const open = new Map<string, EvidenceStream>();

/** The stream of a run for this process: one object per run folder, so its writes come one after the other. */
export function evidenceStream(runDir: string, runId: string): EvidenceStream {
  let s = open.get(runDir);
  if (!s || s.runId !== runId) open.set(runDir, (s = new EvidenceStream(runDir, runId)));
  return s;
}

/** Forgets the stream of a run that stopped or ended; the next start reads the file again. */
export function closeEvidenceStream(runDir: string): void {
  open.delete(runDir);
}
