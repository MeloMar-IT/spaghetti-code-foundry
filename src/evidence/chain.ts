import { canonicalJson, eventHash } from "./canonical.js";
import { parseEvidenceEvent } from "./parse.js";
import type { EvidenceEvent } from "./schema.js";
import { EvidenceSchemaError } from "./version.js";

/**
 * The hash chain of an event stream. Pure: it takes the lines, never a file name.
 *
 * A stream is a chain when, for every line i (from 0):
 * 1. the line is a JSON object in canonical form (see canonical.ts), byte for byte;
 * 2. it is a valid event of a version this Foundry reads, with `seq` = i, the run id of the stream, and an id no
 *    earlier line has;
 * 3. it has `prevHash` and `hash`; `prevHash` is null for line 0 and the `hash` of line i - 1 for every other line;
 * 4. `hash` is the hash of the event (see eventHash).
 * So a changed, added, removed or reordered line breaks the chain at that line or the next one, and the `hash` of the
 * last line (the terminal hash) stands for the whole stream.
 */

export type ChainFault =
  /** The line is not JSON, or is not a JSON object. */
  | "not-json"
  /** The line is JSON, but not written in the canonical form. */
  | "not-canonical"
  /** The line was written by a newer Foundry. */
  | "unsupported-version"
  /** The line is not a valid event. */
  | "invalid"
  /** `seq` is not the place of the line, the run id is another run's, or the id was used before. */
  | "order"
  /** The event has no `prevHash` and `hash`. */
  | "unchained"
  /** `prevHash` is not the hash of the line before. */
  | "link"
  /** `hash` is not the hash of the event. */
  | "hash";

export type ChainRead =
  | { ok: true; events: EvidenceEvent[]; /** The `hash` of the last event; null for an empty stream. */ terminalHash: string | null }
  | { ok: false; /** The first line that is wrong, counted from 1. */ line: number; fault: ChainFault; /** One sentence, without any value of the line. */ message: string; /** The events before that line. */ events: EvidenceEvent[] };

/** The whole lines of a stream text (the text after the last line end is not a line; see splitEvidenceLines). */
export function splitEvidenceLines(text: string): { lines: string[]; tail: string } {
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  return { lines, tail };
}

/** Checks the lines of a stream as one chain. `runId`: the run the stream must belong to. Never throws. */
export function readEvidenceChain(lines: readonly string[], runId: string): ChainRead {
  const events: EvidenceEvent[] = [];
  const ids = new Set<string>();
  let prev: string | null = null;
  const bad = (i: number, fault: ChainFault, message: string): ChainRead => ({ ok: false, line: i + 1, fault, message: `line ${i + 1}: ${message}`, events });
  for (const [i, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return bad(i, "not-json", "is not JSON");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(i, "not-json", "is not a JSON object");
    let canonical: string;
    try {
      canonical = canonicalJson(raw);
    } catch {
      return bad(i, "not-canonical", "has no canonical form");
    }
    if (canonical !== line) return bad(i, "not-canonical", "is not written in the canonical form");
    let event: EvidenceEvent;
    try {
      event = parseEvidenceEvent(raw);
    } catch (e) {
      if (e instanceof EvidenceSchemaError && e.code === "unsupported-version") return bad(i, "unsupported-version", "was written by a newer Foundry");
      const fields = e instanceof EvidenceSchemaError ? [...new Set(e.issues.map((x) => x.path))].slice(0, 5).join(", ") : "";
      return bad(i, "invalid", `is not a valid event${fields ? ` (${fields})` : ""}`);
    }
    if (event.seq !== i) return bad(i, "order", `has place ${event.seq}, not ${i}: a line was added, removed or moved`);
    if (event.runId !== runId) return bad(i, "order", "belongs to another run");
    if (ids.has(event.id)) return bad(i, "order", "has an event id that an earlier line has");
    ids.add(event.id);
    if (event.hash === undefined || event.prevHash === undefined) return bad(i, "unchained", "has no hash");
    if (event.prevHash !== prev) return bad(i, "link", "does not follow the line before it (prevHash is not that line's hash)");
    if (eventHash(raw as Record<string, unknown>) !== event.hash) return bad(i, "hash", "was changed (its hash is not the hash of its content)");
    prev = event.hash;
    events.push(event);
  }
  return { ok: true, events, terminalHash: prev };
}
