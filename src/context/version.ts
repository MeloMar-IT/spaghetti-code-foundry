/**
 * The version of the context bundle format, and the one way an older bundle becomes a current one.
 * Pure: no file access. A bundle carries its own `version`; a reader never guesses it.
 */

/** The version of `context.json` this Foundry writes. Raise it for any change of shape or meaning. */
export const CONTEXT_BUNDLE_VERSION = 1;

/** The context bundle of a run, relative to the run folder. */
export const CONTEXT_BUNDLE_FILE = "context.json";
/** The folder, relative to the run folder, that holds the text of the sources. Nothing else is stored in it. */
export const CONTEXT_SOURCES_DIR = "context";

export type ContextErrorCode = "not-an-object" | "no-version" | "unsupported-version" | "invalid";

export interface ContextIssue {
  /** Where in the bundle, e.g. "sources.0.content.sha256"; "(root)" for the bundle itself. */
  path: string;
  message: string;
}

const NAME = "context bundle";

/** A record that cannot be read as a context bundle. The message never repeats a value of the record, only field names. */
export class ContextSchemaError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    message: string,
    readonly issues: ContextIssue[] = [],
  ) {
    super(message);
    this.name = "ContextSchemaError";
  }
}

/** Turns a bundle of version N into one of version N + 1. It returns a new object and sets the new `version`. */
export type ContextMigration = (old: Record<string, unknown>) => Record<string, unknown>;
/** Keyed by the version a step starts from: `{ 1: v1 → v2, 2: v2 → v3 }`. Every version below the current one needs a step. */
export type ContextMigrations = Readonly<Record<number, ContextMigration>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Brings a bundle to the current version, one step at a time, and returns it (not yet checked against the schema).
 * The rules are those of evidence records (`upgradeEvidence`):
 * - no `version`, or one that is not a whole number above 0: refused;
 * - a version above `current`: refused with a sentence that says which versions can be read;
 * - a version below `current`: every step from `migrations` is applied in order.
 * The input is never changed.
 */
export function upgradeContextBundle(raw: unknown, current: number, migrations: ContextMigrations): Record<string, unknown> {
  if (!isRecord(raw)) throw new ContextSchemaError("not-an-object", `${NAME}: not a JSON object`);
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ContextSchemaError("no-version", `${NAME}: "version" is missing or is not a whole number above 0`);
  }
  if (version > current) {
    const reads = current === 1 ? "version 1" : `versions 1 to ${current}`;
    throw new ContextSchemaError("unsupported-version", `${NAME}: version ${version} is not supported; this Foundry reads ${reads}. It was written by a newer Foundry: update to read it`);
  }
  let record = raw;
  for (let v = version; v < current; v++) {
    const step = Object.hasOwn(migrations, v) ? migrations[v] : undefined;
    if (!step) throw new ContextSchemaError("unsupported-version", `${NAME}: version ${v} can no longer be read by this Foundry (there is no step to version ${v + 1})`);
    const next = step(record);
    if (!isRecord(next) || next.version !== v + 1) {
      throw new ContextSchemaError("invalid", `${NAME}: the step from version ${v} did not give a version ${v + 1} record`);
    }
    record = next;
  }
  return record;
}
