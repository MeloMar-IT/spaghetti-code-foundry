import type { z } from "zod";
import { EvidenceEventSchema, RunEvidenceSchema, type EvidenceEvent, type RunEvidence } from "./schema.js";
import {
  EVIDENCE_EVENT_VERSION, EvidenceSchemaError, evidenceKindName, RUN_EVIDENCE_VERSION, upgradeEvidence,
  type EvidenceIssue, type EvidenceKind, type EvidenceMigrations,
} from "./version.js";

/**
 * Reading evidence: the version is looked at first, an older record is brought to the current version, and only then
 * is it checked. Pure: these take the parsed JSON or the text, never a file name.
 */

/** Steps from older event versions. 1 → 2 and 2 → 3 only set the version: each added an event type, no field changed. */
export const EVENT_MIGRATIONS: EvidenceMigrations = { 1: (old) => ({ ...old, version: 2 }), 2: (old) => ({ ...old, version: 3 }), 3: (old) => ({ ...old, version: 4 }) };
/** Steps from older manifest versions. */
export const MANIFEST_MIGRATIONS: EvidenceMigrations = {};

function check<S extends z.ZodType>(schema: S, record: unknown, kind: EvidenceKind): z.output<S> {
  const res = schema.safeParse(record);
  if (res.success) return res.data;
  const issues: EvidenceIssue[] = res.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
  throw new EvidenceSchemaError(kind, "invalid", `${evidenceKindName(kind)}: not valid\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`, issues);
}

/** One evidence event of the current version, from the parsed JSON of any readable version. Throws EvidenceSchemaError. */
export function parseEvidenceEvent(raw: unknown, migrations: EvidenceMigrations = EVENT_MIGRATIONS): EvidenceEvent {
  return check(EvidenceEventSchema, upgradeEvidence(raw, "event", EVIDENCE_EVENT_VERSION, migrations), "event");
}

/** The manifest of the current version, from the parsed JSON of any readable version. Throws EvidenceSchemaError. */
export function parseRunEvidence(raw: unknown, migrations: EvidenceMigrations = MANIFEST_MIGRATIONS): RunEvidence {
  return check(RunEvidenceSchema, upgradeEvidence(raw, "manifest", RUN_EVIDENCE_VERSION, migrations), "manifest");
}

function fromJson(text: string, kind: EvidenceKind): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EvidenceSchemaError(kind, "invalid", `${evidenceKindName(kind)}: not valid JSON`);
  }
}

/** One line of `evidence.jsonl`. Throws EvidenceSchemaError. */
export const parseEvidenceEventLine = (line: string): EvidenceEvent => parseEvidenceEvent(fromJson(line, "event"));

export type RunEvidenceRead =
  /** The run has no manifest: it was made before evidence existed, or it has not ended yet. Not an error. */
  | { state: "absent" }
  | { state: "ok"; evidence: RunEvidence }
  /** There is a manifest but it cannot be read. `code` says whether a newer Foundry wrote it. */
  | { state: "unreadable"; code: EvidenceSchemaError["code"]; reason: string };

/**
 * What a run has as its manifest, from the text of its `evidence.json` (undefined: the file is not there).
 * Never throws: an old run without evidence stays readable and says "absent".
 */
export function readRunEvidence(text: string | undefined): RunEvidenceRead {
  if (text === undefined) return { state: "absent" };
  try {
    return { state: "ok", evidence: parseRunEvidence(fromJson(text, "manifest")) };
  } catch (e) {
    if (e instanceof EvidenceSchemaError) return { state: "unreadable", code: e.code, reason: e.message };
    throw e;
  }
}
