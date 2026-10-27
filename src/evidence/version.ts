/**
 * Versions of the evidence formats, and the one way an older record becomes a current one.
 * Pure: no file access. A record carries its own `version`; a reader never guesses it.
 */

/**
 * The version of one line of `evidence.jsonl` this Foundry writes. Raise it for any change of shape or meaning.
 * 2 adds the `policy.decided` event. 3 adds `step.profiled`. 4 adds `repo.operation`. 5 adds `context.bundled` and the `context.select` boundary.
 */
export const EVIDENCE_EVENT_VERSION = 5;
/** The version of `evidence.json` (the manifest of a finished run) this Foundry writes. */
export const RUN_EVIDENCE_VERSION = 1;

/** The event stream of a run, relative to the run folder: one JSON object per line, only appended. */
export const EVIDENCE_EVENTS_FILE = "evidence.jsonl";
/** The manifest of a finished run, relative to the run folder. */
export const EVIDENCE_MANIFEST_FILE = "evidence.json";
/** The diff between the base and the final commit of a run that ended with success, relative to the run folder. Made when the run is finalized. */
export const EVIDENCE_DIFF_FILE = "evidence.diff";
/**
 * An empty mark in the run folder: an event of this run could not be written, so its stream is not whole.
 * While it is there the stream is not continued and the run gets no manifest. Nothing removes it.
 */
export const EVIDENCE_INCOMPLETE_FILE = "evidence.incomplete";

export type EvidenceKind = "event" | "manifest";
export type EvidenceErrorCode = "not-an-object" | "no-version" | "unsupported-version" | "invalid";

export interface EvidenceIssue {
  /** Where in the record, e.g. "artifacts.0.sha256"; "(root)" for the record itself. */
  path: string;
  message: string;
}

const NAMES: Record<EvidenceKind, string> = { event: "evidence event", manifest: "evidence manifest" };
export const evidenceKindName = (kind: EvidenceKind): string => NAMES[kind];

/** A record that cannot be read as evidence. The message never repeats a value of the record, only field names. */
export class EvidenceSchemaError extends Error {
  constructor(
    readonly kind: EvidenceKind,
    readonly code: EvidenceErrorCode,
    message: string,
    readonly issues: EvidenceIssue[] = [],
  ) {
    super(message);
    this.name = "EvidenceSchemaError";
  }
}

/** Turns a record of version N into one of version N + 1. It returns a new object and sets the new `version`. */
export type EvidenceMigration = (old: Record<string, unknown>) => Record<string, unknown>;
/** Keyed by the version a step starts from: `{ 1: v1 → v2, 2: v2 → v3 }`. Every version below the current one needs a step. */
export type EvidenceMigrations = Readonly<Record<number, EvidenceMigration>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Brings a record to the current version, one step at a time, and returns it (not yet checked against the schema).
 * - no `version`, or one that is not a whole number above 0: refused;
 * - a version above `current`: refused with a sentence that says which versions can be read;
 * - a version below `current`: every step from `migrations` is applied in order.
 * The input is never changed.
 */
export function upgradeEvidence(raw: unknown, kind: EvidenceKind, current: number, migrations: EvidenceMigrations): Record<string, unknown> {
  const name = NAMES[kind];
  if (!isRecord(raw)) throw new EvidenceSchemaError(kind, "not-an-object", `${name}: not a JSON object`);
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new EvidenceSchemaError(kind, "no-version", `${name}: "version" is missing or is not a whole number above 0`);
  }
  if (version > current) {
    const reads = current === 1 ? "version 1" : `versions 1 to ${current}`;
    throw new EvidenceSchemaError(kind, "unsupported-version", `${name}: version ${version} is not supported; this Foundry reads ${reads}. It was written by a newer Foundry: update to read it`);
  }
  let record = raw;
  for (let v = version; v < current; v++) {
    const step = Object.hasOwn(migrations, v) ? migrations[v] : undefined;
    if (!step) throw new EvidenceSchemaError(kind, "unsupported-version", `${name}: version ${v} can no longer be read by this Foundry (there is no step to version ${v + 1})`);
    const next = step(record);
    if (!isRecord(next) || next.version !== v + 1) {
      throw new EvidenceSchemaError(kind, "invalid", `${name}: the step from version ${v} did not give a version ${v + 1} record`);
    }
    record = next;
  }
  return record;
}
