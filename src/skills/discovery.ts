import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tryParseRepoUrl } from "../auth/repo-url.js";
import { dataHome, replaceFileLocked, withAuthLock } from "../auth/store.js";
import { credentialProblem } from "./credential-scan.js";
import { readRegular } from "./package.js";

// Skill source discovery: reads the repository names of a saved Skills.sh export and keeps a local list of candidates.
// Only the identity of a repository is taken from the export. A candidate is never approved: the list is not read by the
// registry, the lock or the import, and only a person can add a source to skill-sources.yaml.

export const CANDIDATES_FILE = "skill-source-candidates.json";
export const DISCOVERY_ORIGIN = "skills.sh";
export const DISCOVERY_LIMITS = { exportBytes: 4_194_304, entries: 20_000, repositories: 100, candidates: 500, fileBytes: 1_048_576 } as const;

export interface DiscoveredRepository {
  repository: string;
  repositoryKey: string;
  /** How many entries of the export name it. */
  listed: number;
}
export type ExportRead =
  | { ok: true; repositories: DiscoveredRepository[]; skipped: number; hidden: number }
  | { ok: false; reason: string };

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Identity = { repository: string; repositoryKey: string };

/** A GitHub https repository with no user, as {repository, repositoryKey}; undefined for anything else. */
function githubIdentity(value: unknown): Identity | undefined {
  const p = tryParseRepoUrl(value);
  if (!p || p.scheme !== "https" || p.url.includes("@") || p.github === undefined) return undefined;
  return { repository: `https://github.com/${p.github}`, repositoryKey: p.key };
}

/** True when the raw value, the address or the key looks like a credential. */
function looksLikeCredential(raw: string, id: Identity): boolean {
  return [raw, id.repository, id.repositoryKey].some((t) => credentialProblem(t) !== undefined);
}

/** The repository text of one entry: a string, or the first string in source, repository, repo. */
function entryValue(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!isObject(entry)) return undefined;
  for (const k of ["source", "repository", "repo"]) {
    const v = entry[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Reads the text of an export: JSON (an array, or an object with `skills` or `repositories`), else one repository per line. */
export function parseExport(text: string): ExportRead {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return { ok: false, reason: "is empty" };
  let entries: unknown[];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: "is not valid JSON" };
    }
    const list = Array.isArray(doc) ? doc : isObject(doc) ? (Array.isArray(doc.skills) ? doc.skills : Array.isArray(doc.repositories) ? doc.repositories : undefined) : undefined;
    if (!list) return { ok: false, reason: "has no list of skills or repositories" };
    entries = list;
  } else {
    entries = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  }
  if (entries.length > DISCOVERY_LIMITS.entries) return { ok: false, reason: `holds more than ${DISCOVERY_LIMITS.entries} entries; split the file` };

  const found = new Map<string, DiscoveredRepository>();
  let skipped = 0;
  let hidden = 0;
  for (const entry of entries) {
    const raw = entryValue(entry);
    const id = raw === undefined ? undefined : githubIdentity(raw);
    if (raw === undefined || !id) {
      skipped++;
      continue;
    }
    if (looksLikeCredential(raw, id)) {
      hidden++;
      continue;
    }
    const have = found.get(id.repositoryKey);
    if (have) have.listed++;
    else found.set(id.repositoryKey, { ...id, listed: 1 });
  }
  if (found.size > DISCOVERY_LIMITS.repositories) return { ok: false, reason: `holds more than ${DISCOVERY_LIMITS.repositories} repositories; split the file` };
  return { ok: true, repositories: [...found.values()].sort((a, b) => cmp(a.repositoryKey, b.repositoryKey)), skipped, hidden };
}

/** Reads an export file (no links, size limit, valid UTF-8), then parseExport. No reason repeats a path or file content. */
export function readExport(path: string): ExportRead {
  try {
    lstatSync(path);
  } catch {
    return { ok: false, reason: "cannot be read" };
  }
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, DISCOVERY_LIMITS.exportBytes);
  } catch {
    return { ok: false, reason: "cannot be read" };
  }
  if (data === "link") return { ok: false, reason: "is a symbolic link" };
  if (data === "other") return { ok: false, reason: "is not a readable regular file" };
  if (data === "large") return { ok: false, reason: `is larger than ${DISCOVERY_LIMITS.exportBytes} bytes` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ok: false, reason: "is not valid UTF-8 text" };
  }
  return parseExport(text);
}

export interface SourceCandidate {
  repository: string;
  repositoryKey: string;
  /** The commit HEAD pointed at when the repository was found: a starting point for review, not an approval. */
  revision: string;
  status: "proposed";
  origin: "skills.sh";
  listed: number;
  /** ISO time. */
  foundAt: string;
}
export type CandidatesRead = { ok: true; candidates: SourceCandidate[] } | { ok: false; reason: string };

const CandidateSchema = z
  .object({
    repository: z.string().max(500),
    repositoryKey: z.string().max(500),
    revision: z.string().regex(COMMIT_RE),
    status: z.literal("proposed"),
    origin: z.literal(DISCOVERY_ORIGIN),
    listed: z.number().int().min(1).max(DISCOVERY_LIMITS.entries),
    foundAt: z.string().max(64),
  })
  .strict()
  .refine((c) => {
    const id = githubIdentity(c.repository);
    return id !== undefined && id.repository === c.repository && id.repositoryKey === c.repositoryKey && !looksLikeCredential(c.repository, id);
  });
const FileSchema = z.object({ version: z.literal(1), candidates: z.array(CandidateSchema).max(DISCOVERY_LIMITS.candidates) }).strict();

export const candidatesPath = (): string => join(dataHome(), CANDIDATES_FILE);

/** Reads the candidate list. A missing file is an empty list; anything else wrong is `ok: false` with a reason that repeats nothing from the file. */
export function readCandidates(): CandidatesRead {
  const file = candidatesPath();
  try {
    lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, candidates: [] };
    return { ok: false, reason: "cannot be read" };
  }
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(file, DISCOVERY_LIMITS.fileBytes);
  } catch {
    return { ok: false, reason: "cannot be read" };
  }
  if (typeof data === "string") return { ok: false, reason: data === "large" ? `is larger than ${DISCOVERY_LIMITS.fileBytes} bytes` : data === "link" ? "is a symbolic link" : "is not a readable regular file" };
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  const r = FileSchema.safeParse(doc);
  if (!r.success) return { ok: false, reason: "has the wrong format" };
  return { ok: true, candidates: r.data.candidates };
}

export type DiscoveryErrorCode = "unreadable" | "too-large";
/** A problem with the candidate list. The message never holds a path or file content. */
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

/**
 * Under the data-folder lock: drops candidates whose key is in `known`, adds the new ones of `found`, keeps the rest as they
 * are. Nothing is written when nothing changes. A broken list is never overwritten.
 */
export function mergeCandidates(found: readonly SourceCandidate[], known: ReadonlySet<string>, opts: { waitMs?: number } = {}): { added: string[]; kept: string[]; removed: string[] } {
  return withAuthLock(() => {
    const have = readCandidates();
    if (!have.ok) throw new DiscoveryError("unreadable", `the candidate list ${have.reason}`);
    const out = { added: [] as string[], kept: [] as string[], removed: [] as string[] };
    const next = new Map<string, SourceCandidate>();
    for (const c of have.candidates) {
      if (known.has(c.repositoryKey)) out.removed.push(c.repositoryKey);
      else {
        next.set(c.repositoryKey, c);
        out.kept.push(c.repositoryKey);
      }
    }
    for (const c of found) {
      if (known.has(c.repositoryKey) || next.has(c.repositoryKey)) continue;
      next.set(c.repositoryKey, c);
      out.added.push(c.repositoryKey);
    }
    if (!out.added.length && !out.removed.length) return out;
    const sorted = [...next.values()].sort((a, b) => cmp(a.repositoryKey, b.repositoryKey));
    const bytes = Buffer.from(JSON.stringify({ version: 1, candidates: sorted }, null, 2) + "\n");
    if (sorted.length > DISCOVERY_LIMITS.candidates || bytes.length > DISCOVERY_LIMITS.fileBytes) {
      throw new DiscoveryError("too-large", `the candidate list would hold more than ${DISCOVERY_LIMITS.candidates} candidates; add some to the source list as disabled`);
    }
    replaceFileLocked(candidatesPath(), (w) => w(bytes));
    return out;
  }, opts.waitMs);
}
