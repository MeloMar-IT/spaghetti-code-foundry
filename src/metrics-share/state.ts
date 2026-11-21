import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FACTORY_HOME } from "../flow/load.js";
import { NO_INSTALL } from "./report.js";

// The state of the metrics push (#889) in <data folder>/metrics-share.json: the install id, which days were accepted, the
// deletes still to send and the last answer of the receiver. A missing file is empty; a broken one is never overwritten.
// The lock file metrics-share.lock keeps the server and `scf metrics send` from deciding or writing at the same time.

export const SHARE_STATE_FILE = "metrics-share.json";
export const SHARE_LOCK_FILE = "metrics-share.lock";
const home = (): string => process.env.FACTORY_HOME ?? FACTORY_HOME;
export const shareStateFile = (): string => join(home(), SHARE_STATE_FILE);
export const shareLockFile = (): string => join(home(), SHARE_LOCK_FILE);

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Install = z.string().regex(/^[0-9a-f]{32}$/);
const Time = z.string().max(40);
const Tries = z.number().int().min(0).max(10_000).default(0);

export const LastAnswerSchema = z
  .object({
    at: Time,
    request: z.enum(["send", "delete"]),
    day: Day.optional(),
    result: z.enum(["accepted", "refused", "unreachable", "error"]),
    status: z.number().int().min(100).max(999).optional(),
  })
  .strict();
export type LastAnswer = z.infer<typeof LastAnswerSchema>;

const DayEntrySchema = z.object({ accepted: Time.optional(), tries: Tries, nextAt: Time.optional() }).strict();
export type DayEntry = z.infer<typeof DayEntrySchema>;

const DeleteEntrySchema = z.object({ install: Install, endpoint: z.string().max(2048), since: Day, tries: Tries, nextAt: Time.optional() }).strict();
export type DeleteEntry = z.infer<typeof DeleteEntrySchema>;

/** At most this many deletes wait; a new stop waits while the list is full. */
export const MAX_DELETES = 100;

export const ShareStateSchema = z
  .object({
    version: z.literal(1),
    install: Install,
    /** The receiver the install id was posted to. Set with `posted`. */
    endpoint: z.string().max(2048).optional(),
    /** The UTC day this install id started to share; earlier days are never sent. */
    activeSince: Day.optional(),
    /** A POST was tried for this install id: a stop sends a DELETE. */
    posted: z.boolean().default(false),
    days: z.record(Day, DayEntrySchema).default({}),
    deletes: z.array(DeleteEntrySchema).max(MAX_DELETES).default([]),
    last: LastAnswerSchema.optional(),
  })
  .strict();
export type ShareState = z.infer<typeof ShareStateSchema>;

/** A random 128-bit install id as 32 hex characters, never all zeros (the placeholder of the preview). */
export function newInstallId(): string {
  for (;;) {
    const id = randomBytes(16).toString("hex");
    if (id !== NO_INSTALL) return id;
  }
}

/** Reads the state. Missing file: no state. A file that cannot be read or is not valid: `broken`. */
export function loadShareState(file = shareStateFile()): { state?: ShareState; broken: boolean } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { broken: (e as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  try {
    const r = ShareStateSchema.safeParse(JSON.parse(text));
    return r.success ? { state: r.data, broken: false } : { broken: true };
  } catch {
    return { broken: true };
  }
}

/** Saves through a temporary file (mode 0600) and a rename. False when it could not be saved. */
export function saveShareState(state: ShareState, file = shareStateFile()): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(ShareStateSchema.parse(state), null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/** The stored install id, or the placeholder while there is none. Read-only. */
export function peekInstall(file = shareStateFile()): string {
  return loadShareState(file).state?.install ?? NO_INSTALL;
}

/** The last answer of the receiver, for the preview (#888). Read-only. */
export function lastShareAnswer(file = shareStateFile()): LastAnswer | undefined {
  return loadShareState(file).state?.last;
}

/** `accepted (200)`, `refused (500)`, `unreachable`. */
export function answerText(a: Pick<LastAnswer, "result" | "status">): string {
  return a.status !== undefined ? `${a.result} (${a.status})` : a.result;
}

export interface LockOptions {
  file?: string;
  /** A lock whose time is older than this is from a holder that is gone and is taken over. */
  staleMs: number;
  /** How often the holder renews the lock's time while it works. */
  heartbeatMs?: number;
}

const LOCK_HEARTBEAT_MS = 10_000;

function tryLock(file: string): string | undefined {
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return token;
}

/** Runs `fn` while holding the lock file; "busy" when another process holds it. Never waits. */
export async function withShareLock<T>(fn: () => Promise<T>, opts: LockOptions): Promise<T | "busy"> {
  const file = opts.file ?? shareLockFile();
  let token: string | undefined;
  for (let attempt = 0; attempt < 2 && !token; attempt++) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      token = tryLock(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age: number;
      try {
        age = Date.now() - statSync(file).mtimeMs;
      } catch {
        continue; // gone in the meantime: try again
      }
      if (age <= opts.staleMs) return "busy";
      rmSync(file, { force: true });
    }
  }
  if (!token) return "busy";
  const ours = token;
  // The holder renews the lock's time while it works, so a long job is never taken over as stale. A lock taken over
  // by someone else (token changed) is left alone.
  const beat = setInterval(() => {
    try {
      if (readFileSync(file, "utf8") !== ours) return;
      const t = new Date();
      utimesSync(file, t, t);
    } catch {
      // the lock is gone: nothing to renew
    }
  }, opts.heartbeatMs ?? LOCK_HEARTBEAT_MS);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      if (readFileSync(file, "utf8") === token) unlinkSync(file);
    } catch {
      // already gone
    }
  }
}
