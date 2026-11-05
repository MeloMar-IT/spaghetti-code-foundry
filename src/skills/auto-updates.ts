import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StoreError, dataHome } from "../auth/store.js";
import { readRegular } from "./package.js";
import { RELEASE_GATES, type ReleaseGate } from "./release-publish.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE, SKILL_VERSION_RE } from "./schema.js";
import { withDataFileLock, writeAtomic } from "./update-schedule.js";

// <data folder>/skill-auto-updates.json (schema 1): the last automatic update of each `update.auto` source (#799) and the skills
// that failed a gate. It holds checked ids, digests, commits and fixed sentences only, never upstream text: `message` must be the
// fixed text of its gate. Part 2c reads it. Read never throws; write is atomic, mode 0600 and under a lock.

export const AUTO_UPDATES_FILE = "skill-auto-updates.json";
const LOCK_NAME = "skill-auto-updates.lock";
export const MAX_AUTO_UPDATES_BYTES = 1_048_576;
export const MAX_AUTO_UPDATE_SOURCES = 200;
export const MAX_AUTO_UPDATE_FAILED = 500;
export const AUTO_UPDATE_RESULTS = ["released", "unchanged", "blocked", "failed"] as const;
export const autoUpdatesSettings = { waitMs: 2000 };
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The Foundry's own sentence for each gate. */
export const GATE_MESSAGES: Record<ReleaseGate, string> = {
  normalize: "the skill could not be normalized",
  licence: "the licence check refused the skill",
  scan: "the security scan found a high finding",
  profile: "the evaluation suite profile check refused the skill",
  evaluation: "the evaluation did not pass",
  package: "the Foundry package does not load again",
  version: "no unused version could be given to the skill",
  source: "the source could not be used",
};

export interface AutoSkillFailure {
  skill: string;
  gate: ReleaseGate;
  message: string;
}
export interface AutoUpdateEntry {
  at: string;
  commit: string;
  result: (typeof AUTO_UPDATE_RESULTS)[number];
  release?: { catalogue: string; version: string; digest: string };
  failed: AutoSkillFailure[];
}
export type AutoUpdatesRead = { state: "none" } | { state: "ok"; sources: Record<string, AutoUpdateEntry> } | { state: "unreadable"; reason: string };

export const autoFailure = (skill: string, gate: ReleaseGate): AutoSkillFailure => ({ skill, gate, message: GATE_MESSAGES[gate] });

const Failure = z
  .object({ skill: z.string().regex(SKILL_ID_RE), gate: z.enum(RELEASE_GATES), message: z.string() })
  .strict()
  .refine((f) => f.message === GATE_MESSAGES[f.gate], "not the fixed message");
const Entry = z
  .object({
    at: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "not a time"),
    commit: z.string().regex(COMMIT_RE),
    result: z.enum(AUTO_UPDATE_RESULTS),
    release: z.object({ catalogue: z.string().regex(SKILL_ID_RE), version: z.string().regex(SKILL_VERSION_RE), digest: z.string().regex(SKILL_DIGEST_RE) }).strict().optional(),
    failed: z.array(Failure).max(MAX_AUTO_UPDATE_FAILED),
  })
  .strict();
const FileSchema = z
  .object({
    schema: z.literal(1),
    sources: z.record(z.string().regex(SKILL_ID_RE), Entry).refine((r) => Object.keys(r).length <= MAX_AUTO_UPDATE_SOURCES, "too many sources"),
  })
  .strict();

export const autoUpdatesPath = (home: string = dataHome()): string => join(home, AUTO_UPDATES_FILE);

export function readAutoUpdates(opts: { home?: string } = {}): AutoUpdatesRead {
  const path = autoUpdatesPath(opts.home);
  try {
    lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "unreadable", reason: "cannot be read" };
  }
  let bytes: ReturnType<typeof readRegular>;
  try {
    bytes = readRegular(path, MAX_AUTO_UPDATES_BYTES);
  } catch {
    return { state: "unreadable", reason: "cannot be read" };
  }
  if (bytes === "link") return { state: "unreadable", reason: "is a symbolic link" };
  if (bytes === "other") return { state: "unreadable", reason: "is not a regular file" };
  if (bytes === "large") return { state: "unreadable", reason: `is larger than ${MAX_AUTO_UPDATES_BYTES} bytes` };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { state: "unreadable", reason: "is not valid JSON" };
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) return { state: "unreadable", reason: "has the wrong format" };
  return { state: "ok", sources: parsed.data.sources };
}

/**
 * Sets the entry of `sourceId` under the lock; the file is read again inside. An unreadable file counts as empty. Sources not in `keep`
 * are dropped. Throws StoreError; nothing is written when the new content is over a limit.
 */
export function recordAutoUpdate(sourceId: string, entry: AutoUpdateEntry, opts: { home?: string; keep?: ReadonlySet<string> } = {}): void {
  if (!SKILL_ID_RE.test(sourceId)) throw new Error("recordAutoUpdate: bad source id");
  const home = opts.home ?? dataHome();
  const path = autoUpdatesPath(home);
  withDataFileLock(home, LOCK_NAME, autoUpdatesSettings.waitMs, () => {
    const read = readAutoUpdates({ home });
    const sources: Record<string, AutoUpdateEntry> = read.state === "ok" ? { ...read.sources } : {};
    sources[sourceId] = entry;
    if (opts.keep) for (const k of Object.keys(sources)) if (!opts.keep.has(k) && k !== sourceId) delete sources[k];
    if (entry.failed.length > MAX_AUTO_UPDATE_FAILED || Object.keys(sources).length > MAX_AUTO_UPDATE_SOURCES) {
      throw new StoreError("too-large", path, "would be over a limit; nothing was changed");
    }
    const checked = FileSchema.safeParse({ schema: 1, sources });
    if (!checked.success) throw new Error("skill-auto-updates.json: the new content is not valid");
    const text = JSON.stringify({ schema: 1, sources: checked.data.sources }, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_AUTO_UPDATES_BYTES) throw new StoreError("too-large", path, "would be larger than the allowed size; nothing was changed");
    try {
      writeAtomic(path, text);
    } catch (e) {
      throw new StoreError("cannot-write", path, `cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  });
}
