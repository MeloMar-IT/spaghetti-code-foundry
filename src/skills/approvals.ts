import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StoreError, dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import { readRegular } from "./package.js";
import type { ApprovedRelease } from "./release.js";
import { decodeBase64Exact } from "./release-signature.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE, SKILL_VERSION_RE } from "./schema.js";
import type { SourcesManifest, SourcesRead } from "./sources.js";
import { withDataFileLock, writeAtomic } from "./update-schedule.js";

// Approvals made by the server itself, kept in the data folder: <data folder>/skill-approvals.json (schema 1).
// Per source id: the repository key, an approved commit (`ref`) and the catalogue releases built from it. Read never throws; write
// is atomic, mode 0600 and under a lock. The file is merged with skills.releases.approved (`approvedReleases`) and its refs
// replace `ref.approved` of a source with `update.auto` (`withApprovedRefs`). This file only imports types from sources.ts.

export const APPROVALS_FILE = "skill-approvals.json";
const LOCK_NAME = "skill-approvals.lock";
export const MAX_APPROVALS_BYTES = 262_144;
export const MAX_APPROVAL_SOURCES = 200;
export const MAX_RELEASES_PER_SOURCE = 100;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Test hook: how long a write waits for the lock. */
export const approvalsSettings = { waitMs: 2000 };

export interface StoredApproval {
  catalogue: string;
  version: string;
  digest: string;
  key?: string;
  signature?: string;
  at: string;
}
export interface SourceApprovals {
  repositoryKey: string;
  ref?: { approved: string; at: string };
  releases: StoredApproval[];
}
export type ApprovalsFile = Record<string, SourceApprovals>;
export type ApprovalsRead = { state: "none" } | { state: "ok"; sources: ApprovalsFile } | { state: "unreadable"; reason: string };

const Time = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "not a time");
const ReleaseSchema = z
  .object({
    catalogue: z.string().regex(SKILL_ID_RE),
    version: z.string().regex(SKILL_VERSION_RE),
    digest: z.string().regex(SKILL_DIGEST_RE),
    key: z.string().regex(SKILL_ID_RE).optional(),
    signature: z.string().max(100).refine((s) => decodeBase64Exact(s, 64) !== undefined, "not a signature").optional(),
    at: Time,
  })
  .strict()
  .refine((r) => (r.key === undefined) === (r.signature === undefined), "key and signature come together");
const SourceSchema = z
  .object({
    repositoryKey: z.string().min(1).max(300),
    ref: z.object({ approved: z.string().regex(COMMIT_RE), at: Time }).strict().optional(),
    releases: z.array(ReleaseSchema).max(MAX_RELEASES_PER_SOURCE),
  })
  .strict();
const FileSchema = z
  .object({
    schema: z.literal(1),
    sources: z.record(z.string().regex(SKILL_ID_RE), SourceSchema).refine((r) => Object.keys(r).length <= MAX_APPROVAL_SOURCES, "too many sources"),
  })
  .strict();

export const approvalsPath = (home: string = dataHome()): string => join(home, APPROVALS_FILE);

export function readApprovals(opts: { home?: string } = {}): ApprovalsRead {
  const path = approvalsPath(opts.home);
  try {
    lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "unreadable", reason: "cannot be read" };
  }
  let bytes: ReturnType<typeof readRegular>;
  try {
    bytes = readRegular(path, MAX_APPROVALS_BYTES);
  } catch {
    return { state: "unreadable", reason: "cannot be read" };
  }
  if (bytes === "link") return { state: "unreadable", reason: "is a symbolic link" };
  if (bytes === "other") return { state: "unreadable", reason: "is not a regular file" };
  if (bytes === "large") return { state: "unreadable", reason: `is larger than ${MAX_APPROVALS_BYTES} bytes` };
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
 * Changes the file under its lock. `fn` gets a copy of the current content (an absent file is empty) and returns the new content,
 * or undefined for no change. An unreadable file is never replaced. Throws StoreError (also `too-large`: nothing is written).
 * `claimed`: the caller already holds the home write claim (for example inside withAuthLock).
 */
export function updateSourceApprovals(
  fn: (cur: ApprovalsFile) => ApprovalsFile | undefined,
  opts: { home?: string; claimed?: boolean } = {},
): "written" | "unchanged" {
  const home = opts.home ?? dataHome();
  const path = approvalsPath(home);
  let result: "written" | "unchanged" = "unchanged";
  withDataFileLock(
    home,
    LOCK_NAME,
    approvalsSettings.waitMs,
    () => {
      const read = readApprovals({ home });
      if (read.state === "unreadable") throw new StoreError("cannot-write", path, `cannot be changed: it ${read.reason}; fix or remove it`);
      const cur: ApprovalsFile = read.state === "ok" ? structuredClone(read.sources) : {};
      const next = fn(cur);
      if (next === undefined) return;
      if (Object.keys(next).length > MAX_APPROVAL_SOURCES) {
        throw new StoreError("too-large", path, `would hold more than ${MAX_APPROVAL_SOURCES} sources; nothing was changed`);
      }
      const checked = FileSchema.safeParse({ schema: 1, sources: next });
      if (!checked.success) throw new Error("skill-approvals.json: the new content is not valid");
      const text = JSON.stringify({ schema: 1, sources: checked.data.sources }, null, 2) + "\n";
      if (Buffer.byteLength(text, "utf8") > MAX_APPROVALS_BYTES) {
        throw new StoreError("too-large", path, "would be larger than the allowed size; nothing was changed");
      }
      try {
        writeAtomic(path, text);
      } catch (e) {
        throw new StoreError("cannot-write", path, `cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      result = "written";
    },
    { claimed: opts.claimed },
  );
  return result;
}

/** Records the approved commit of an auto source. A stored entry of another repository is replaced. Throws Error for bad input, StoreError for the store. */
export function recordApprovedRef(
  sourceId: string,
  repositoryKey: string,
  commit: string,
  opts: { home?: string; at?: Date; claimed?: boolean; expectedPrevious?: string | null } = {},
): "recorded" | "unchanged" | "stale" {
  if (!SKILL_ID_RE.test(sourceId)) throw new Error("recordApprovedRef: bad source id");
  if (!COMMIT_RE.test(commit)) throw new Error("recordApprovedRef: bad commit id");
  if (!repositoryKey) throw new Error("recordApprovedRef: bad repository key");
  const at = (opts.at ?? new Date()).toISOString();
  let stale = false;
  const r = updateSourceApprovals(
    (cur) => {
      const old = cur[sourceId];
      // `expectedPrevious` (a commit, or null for none): the stored ref must still be that one, else nothing is written.
      if (opts.expectedPrevious !== undefined) {
        const stored = old && old.repositoryKey === repositoryKey ? old.ref?.approved ?? null : null;
        if (stored !== opts.expectedPrevious && stored !== commit) {
          stale = true;
          return undefined;
        }
      }
      if (old && old.repositoryKey === repositoryKey && old.ref?.approved === commit) return undefined;
      const base: SourceApprovals = old && old.repositoryKey === repositoryKey ? old : { repositoryKey, releases: [] };
      cur[sourceId] = { ...base, ref: { approved: commit, at } };
      return cur;
    },
    { home: opts.home, claimed: opts.claimed },
  );
  return stale ? "stale" : r === "written" ? "recorded" : "unchanged";
}

export interface MergedApprovals {
  approved: ApprovedRelease[];
  /** `catalogue@version` approved with different digests. None of them is in `approved`. */
  conflicts: ReadonlySet<string>;
  problems: { kind: "unreadable" | "conflict"; text: string }[];
}

/** Pure. Config entries come first, then the stored ones (source ids sorted, file order). Same digest: one entry, config wins. Different digest: all dropped, key is a conflict. */
export function mergeApprovedReleases(
  config: readonly ApprovedRelease[],
  stored: ApprovalsFile,
): { approved: ApprovedRelease[]; conflicts: Set<string> } {
  const all: ApprovedRelease[] = [...config];
  for (const id of Object.keys(stored).sort()) {
    for (const r of stored[id]!.releases) {
      all.push({ catalogue: r.catalogue, version: r.version, digest: r.digest, ...(r.key !== undefined ? { key: r.key, signature: r.signature! } : {}) });
    }
  }
  const digests = new Map<string, Set<string>>();
  for (const a of all) {
    const k = `${a.catalogue}@${a.version}`;
    const set = digests.get(k) ?? new Set<string>();
    set.add(a.digest);
    digests.set(k, set);
  }
  const conflicts = new Set<string>();
  for (const [k, set] of digests) if (set.size > 1) conflicts.add(k);
  const approved: ApprovedRelease[] = [];
  const seen = new Set<string>();
  for (const a of all) {
    const k = `${a.catalogue}@${a.version}`;
    if (conflicts.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    approved.push(a);
  }
  return { approved, conflicts };
}

/** Config plus data-folder approvals. Never throws: an unreadable file becomes a problem and the config entries stay. */
export function approvedReleases(rel: Pick<Config["skills"]["releases"], "approved">, opts: { home?: string } = {}): MergedApprovals {
  const read = readApprovals(opts);
  if (read.state === "none") return { approved: [...rel.approved], conflicts: new Set(), problems: [] };
  if (read.state === "unreadable") {
    return {
      approved: [...rel.approved],
      conflicts: new Set(),
      problems: [{ kind: "unreadable", text: `${APPROVALS_FILE} in the data folder ${read.reason}; its approvals are not used` }],
    };
  }
  const m = mergeApprovedReleases(rel.approved, read.sources);
  return {
    approved: m.approved,
    conflicts: m.conflicts,
    problems: [...m.conflicts].sort().map((k) => ({
      kind: "conflict" as const,
      text: `${k} is approved with different digests in skills.releases.approved and ${APPROVALS_FILE}, so it is not loaded`,
    })),
  };
}

/** Pure. The stored ref replaces `ref.approved` of an enabled `update.auto` source of the same repository. */
export function applyApprovedRefs(m: SourcesManifest, stored: ApprovalsFile): { manifest: SourcesManifest; fromStore: ReadonlySet<string> } {
  const fromStore = new Set<string>();
  const sources = m.sources.map((s) => {
    const e = stored[s.id];
    if (s.status !== "enabled" || s.update.auto !== true || !e || e.repositoryKey !== s.repositoryKey || !e.ref) return s;
    fromStore.add(s.id);
    return { ...s, ref: { ...s.ref, approved: e.ref.approved } };
  });
  return { manifest: { ...m, sources }, fromStore };
}

const needsStore = (read: SourcesRead): read is Extract<SourcesRead, { state: "ok" }> =>
  read.state === "ok" && read.manifest.sources.some((s) => s.update.auto === true);

/** The sources with the stored refs. Reads the file only when some source has `update.auto`; an unreadable file then makes the read invalid. */
export function withApprovedRefs(read: SourcesRead, opts: { home?: string } = {}): SourcesRead {
  if (!needsStore(read)) return read;
  const stored = readApprovals(opts);
  if (stored.state === "none") return read;
  if (stored.state === "unreadable") {
    return {
      state: "invalid",
      problems: [{ where: APPROVALS_FILE, message: `in the data folder ${stored.reason}; sources with update.auto cannot be read` }],
    };
  }
  return { state: "ok", manifest: applyApprovedRefs(read.manifest, stored.sources).manifest };
}

/** The ids of the sources whose ref comes from the data folder (empty when the file cannot be used). */
export function approvedRefSources(read: SourcesRead, opts: { home?: string } = {}): ReadonlySet<string> {
  if (!needsStore(read)) return new Set();
  const stored = readApprovals(opts);
  return stored.state === "ok" ? applyApprovedRefs(read.manifest, stored.sources).fromStore : new Set();
}
