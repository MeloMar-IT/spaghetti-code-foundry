import { BLOCKED, liveRedactor } from "../credentials/redact.js";
import { canonicalJson } from "../evidence/canonical.js";
import { scrub } from "../help/guard.js";
import { REDACTABLE_FIELDS, type RedactableField, type TelemetryEvent } from "./envelope.js";

export type PrivacyResult = { ok: true; event: TelemetryEvent; line: string } | { ok: false; reason: "privacy" | "identity" };

/**
 * The event as it may be stored, and its canonical line. Three checks, all fail closed:
 * 1. `id` and `runId` must not change under `scrub`; if they do the event is dropped (`identity`).
 * 2. Each label field is checked on its own with the stored credentials and the configured patterns; a field that
 *    changes is dropped and named in `redacted`.
 * 3. The whole line is checked once more, and the credential store is asked again for it. A store that cannot be
 *    read, or a line that still changes, drops the event (`privacy`).
 * Never throws.
 */
export function privateTelemetry(event: TelemetryEvent, o: { patterns?: readonly string[] } = {}): PrivacyResult {
  try {
    const patterns = o.patterns ?? [];
    const stored = liveRedactor();
    if (stored === BLOCKED) return { ok: false, reason: "privacy" };
    const opts = { patterns, stored: () => stored };
    for (const v of [event.id, event.runId]) {
      if (v !== undefined && scrub(v, opts).text !== v) return { ok: false, reason: "identity" };
    }
    const out: Record<string, unknown> = { ...event };
    const dropped = new Set<RedactableField>(event.redacted ?? []);
    for (const f of REDACTABLE_FIELDS) {
      const v = out[f];
      if (v === undefined) continue;
      const t = canonicalJson(v);
      if (scrub(t, opts).text !== t) {
        delete out[f];
        dropped.add(f);
      }
    }
    if (dropped.size) out.redacted = REDACTABLE_FIELDS.filter((f) => dropped.has(f));
    else delete out.redacted;
    const line = canonicalJson(out);
    // asks the store again (liveRedactor looks at the file for every call)
    if (scrub(line, { patterns }).text !== line) return { ok: false, reason: "privacy" };
    return { ok: true, event: out as TelemetryEvent, line };
  } catch {
    return { ok: false, reason: "privacy" };
  }
}
