/**
 * The points of a plan: what the issue asked (`ASKED:` lines) and what the planner chose itself (`ASSUMED:` lines).
 * The plan output is untrusted: only lines outside fenced code are read, the text is redacted, cleaned and cut.
 */
import { redactText } from "../credentials/redact.js";

export type PlanPointKind = "asked" | "assumed";
export interface PlanPoint {
  kind: PlanPointKind;
  text: string;
}

export const PLAN_POINT_LIMITS = Object.freeze({ points: 100, text: 500 });

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const POINT = /^ {0,3}(?:[-*+][ \t]+)?(?:\*\*)?(ASKED|ASSUMED):(?:\*\*)?[ \t]*(.*)$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** `redact` is called on the raw text, before it is cleaned and cut, so a secret cannot be left as a fragment. */
export function parsePlanPoints(output: string, redact: (text: string) => string = redactText): PlanPoint[] {
  const points: PlanPoint[] = [];
  const seen = new Set<string>();
  let fence: { char: string; length: number } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    const m = POINT.exec(line);
    if (!m) continue;
    const text = redact(m[2]!).replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, PLAN_POINT_LIMITS.text);
    if (!text) continue;
    const kind: PlanPointKind = m[1] === "ASKED" ? "asked" : "assumed";
    const key = `${kind}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ kind, text });
    if (points.length >= PLAN_POINT_LIMITS.points) break;
  }
  return points;
}

const READY = /^PLAN_STATUS: READY/m;
const ANY_STATUS = /^PLAN_STATUS: *[A-Z_]+/m;

/**
 * The plan points after a step. The choice of plan follows PICK_PLAN in scripts/build-flows.mjs: a revision whose
 * output has a READY status line wins (also when the step failed); a draft counts only when the step succeeded.
 * A revision that ended with another status sends the run back, so the list is cleared. Never throws.
 */
export function planPointsAfter(
  prev: PlanPoint[] | undefined,
  o: { stepId: string; type: string; topLevel: boolean; ok: boolean; output: string },
  redact?: (text: string) => string,
): PlanPoint[] | undefined {
  try {
    if (!o.topLevel || o.type !== "claude" || (o.stepId !== "plan" && o.stepId !== "revise_plan")) return prev;
    const ready = READY.test(o.output);
    let take: boolean;
    if (o.stepId === "plan") take = o.ok && ready;
    else if (ready) take = true;
    else if (o.ok && ANY_STATUS.test(o.output)) return undefined;
    else return prev;
    if (!take) return undefined;
    const points = parsePlanPoints(o.output, redact);
    return points.length ? points : undefined;
  } catch {
    return prev;
  }
}
