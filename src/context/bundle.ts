import type { z } from "zod";
import { artifactRef, sha256Hex, type ArtifactRef } from "../evidence/identity.js";
import {
  CONTEXT_CLASSIFICATIONS, CONTEXT_CONSUMERS, ContextBundleSchema,
  type ContextBundle, type ContextClassification, type ContextConsumer, type ContextSource,
} from "./schema.js";
import { CONTEXT_BUNDLE_FILE, CONTEXT_BUNDLE_VERSION, ContextSchemaError, upgradeContextBundle, type ContextIssue, type ContextMigrations } from "./version.js";

/**
 * Reading, writing down and hashing a context bundle, and the questions later steps ask of one.
 * Pure: these take the parsed JSON or the text, never a file name, and the time is always given by the caller.
 */

/** Steps from older bundle versions. Empty while version 1 is the only one; a new version adds its step here. */
export const CONTEXT_MIGRATIONS: ContextMigrations = {};

function check(record: unknown): ContextBundle {
  const res = ContextBundleSchema.safeParse(record);
  if (res.success) return res.data;
  const issues: ContextIssue[] = res.error.issues.map((i: z.core.$ZodIssue) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
  throw new ContextSchemaError("invalid", `context bundle: not valid\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`, issues);
}

/** The bundle of the current version, from the parsed JSON of any readable version. Throws ContextSchemaError. */
export function parseContextBundle(raw: unknown, migrations: ContextMigrations = CONTEXT_MIGRATIONS): ContextBundle {
  return check(upgradeContextBundle(raw, CONTEXT_BUNDLE_VERSION, migrations));
}

export type ContextBundleRead =
  /** The run has no bundle: it was made before context bundles existed, or no context was selected for it. Not an error. */
  | { state: "absent" }
  | { state: "ok"; bundle: ContextBundle }
  /** There is a bundle but it cannot be read. `code` says whether a newer Foundry wrote it. */
  | { state: "unreadable"; code: ContextSchemaError["code"]; reason: string };

/**
 * What a run has as its bundle, from the text of its `context.json` (undefined: the file is not there).
 * Never throws: an old run without a bundle stays readable and says "absent".
 */
export function readContextBundle(text: string | undefined, migrations: ContextMigrations = CONTEXT_MIGRATIONS): ContextBundleRead {
  if (text === undefined) return { state: "absent" };
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ContextSchemaError("invalid", "context bundle: not valid JSON");
    }
    return { state: "ok", bundle: parseContextBundle(raw, migrations) };
  } catch (e) {
    if (e instanceof ContextSchemaError) return { state: "unreadable", code: e.code, reason: e.message };
    throw e;
  }
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The same value with the fields of every object in the order of their names. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(byText)) out[key] = sorted((value as Record<string, unknown>)[key]);
  return out;
}

/** The lists of a bundle in their one order: sources and omissions by address, policies by id, owners by name, consumers as in CONTEXT_CONSUMERS. */
function ordered(b: ContextBundle): ContextBundle {
  return {
    ...b,
    policies: [...b.policies].sort((x, y) => byText(x.id, y.id)),
    sources: [...b.sources]
      .sort((x, y) => byText(x.uri, y.uri))
      .map((s) => ({ ...s, owners: [...s.owners].sort(byText), consumers: CONTEXT_CONSUMERS.filter((c) => s.consumers.includes(c)) })),
    omitted: [...b.omitted].sort((x, y) => byText(x.uri, y.uri)),
  };
}

/**
 * The text of `context.json` for a bundle: checked first, then written in one fixed form (lists in a fixed order,
 * fields by name, two spaces, a newline at the end). The same bundle always gives the same text, whatever order its
 * lists and fields were in. Throws ContextSchemaError for a bundle that is not valid, so none is ever written.
 */
export function serializeContextBundle(bundle: ContextBundle): string {
  return `${JSON.stringify(sorted(ordered(check(bundle))), null, 2)}\n`;
}

/** The SHA-256 of `context.json` for a bundle: the hash of exactly the text `serializeContextBundle` gives. */
export const hashContextBundle = (bundle: ContextBundle): string => sha256Hex(serializeContextBundle(bundle));

/**
 * How evidence names the bundle of a run: `context.json`, its SHA-256 and its size, as an `ArtifactRef` for the
 * `artifacts` of an evidence event or manifest. Required: the evidence is broken when the file is gone or changed.
 * (Its kind is "other": evidence version 1 has no kind of its own for a context bundle.)
 */
export const contextBundleRef = (bundle: ContextBundle): ArtifactRef => artifactRef("other", CONTEXT_BUNDLE_FILE, serializeContextBundle(bundle), true);

/** How evidence names the stored text of one source. Not required: the text may be removed later (retention) while its hash stays in the bundle. */
export const contextSourceRef = (source: ContextSource): ArtifactRef => ({ kind: "other", path: source.content.path, sha256: source.content.sha256, bytes: source.content.bytes, required: false });

/**
 * One hash for which sources a bundle has and what they say: over kind, address, revision, hash and size of every
 * source, in address order. It does not depend on the run, the time, the budget or the reasons, so the same
 * repository state and task give the same hash in every run.
 */
export function hashContextSources(bundle: ContextBundle): string {
  const list = ordered(bundle).sources.map((s) => ({ kind: s.kind, uri: s.uri, revision: s.revision, sha256: s.content.sha256, bytes: s.content.bytes }));
  return sha256Hex(JSON.stringify(sorted(list)));
}

/** True when this text (read as UTF-8) or these bytes are exactly what the source recorded. */
export function isSourceText(source: ContextSource, contents: string | Uint8Array): boolean {
  const size = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
  return size === source.content.bytes && sha256Hex(contents) === source.content.sha256;
}

/** The bytes of text of all sources together. */
export const contextTotalBytes = (bundle: ContextBundle): number => bundle.sources.reduce((n, s) => n + s.content.bytes, 0);

/** True when `classification` is `max` or less private than it. */
export const classificationAtMost = (classification: ContextClassification, max: ContextClassification): boolean =>
  CONTEXT_CLASSIFICATIONS.indexOf(classification) <= CONTEXT_CLASSIFICATIONS.indexOf(max);

/** True when a step with this role may be given the source. */
export const mayConsume = (source: ContextSource, consumer: ContextConsumer): boolean => source.consumers.includes(consumer);

/** The moment the copy of a source stops being fresh; null when it does not go stale. */
export function staleAt(source: ContextSource): string | null {
  const age = source.freshness.maxAgeSeconds;
  return age === null ? null : new Date(Date.parse(source.retrievedAt) + age * 1000).toISOString();
}

/** True when the copy is stale at `now` (a UTC time): later than `staleAt`. A time that cannot be read counts as stale. */
export function isStale(source: ContextSource, now: string): boolean {
  const end = staleAt(source);
  if (end === null) return false;
  const at = Date.parse(now);
  return Number.isNaN(at) || at > Date.parse(end);
}

/** The entry with this id, for a citation; undefined when the bundle has none. */
export const findSource = (bundle: ContextBundle, id: string): ContextSource | undefined => bundle.sources.find((s) => s.id === id);
