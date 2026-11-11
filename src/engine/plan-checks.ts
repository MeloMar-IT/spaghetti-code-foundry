/**
 * Checks a person can try: the plan's `- CHECK: Try: … — Expect: …` lines (or one `NO_CHECKS: <why>` line), read from the
 * output of the plan gate and kept on the run. The text comes from an agent: it is never run, control characters are
 * removed and every part is cut. Recording never stops a run.
 */
import { planGateRecord, SKILL_REQUEST_GATES } from "../skills/request.js";
import type { RunSummary } from "./state.js";

export interface PersonCheck {
  id: string;
  try: string;
  expect: string;
  source: "plan";
}

export const PLAN_CHECK_LIMITS = { checks: 4, partChars: 300 } as const;

export interface PlanChecks {
  checks: PersonCheck[];
  none?: string;
  problems: string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const CHECK_LINE = /^(?:- )?CHECK:/i;
const NO_CHECKS_LINE = /^(?:- )?NO_CHECKS:(.*)$/i;
const CHECK_PARTS = /^(?:- )?CHECK:\s*Try:\s*(.*?)\s*(?:—|–|--|-)?\s*Expect:\s*(.*?)\s*$/i;
// The gate prints the review notes of Codex after the plan; they are not the plan.
const NOTES_HEADING = /^## Review notes to work in\s*$/;

function clean(s: string): string {
  let t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[—–-]$/, "").trim();
  const chars = Array.from(t);
  return chars.length > PLAN_CHECK_LIMITS.partChars ? chars.slice(0, PLAN_CHECK_LIMITS.partChars - 1).join("") + "…" : t;
}

/** Pure. Lines at column 0, outside ``` / ~~~ fences, before the review notes of the gate. */
export function parsePlanChecks(output: string): PlanChecks {
  const checks: PersonCheck[] = [];
  const problems: string[] = [];
  let none: string | undefined;
  let emptyNone = false;
  let extra = 0;
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
    if (NOTES_HEADING.test(line)) break;
    if (CHECK_LINE.test(line)) {
      const m = CHECK_PARTS.exec(line);
      const t = m ? clean(m[1]!) : "";
      const e = m ? clean(m[2]!) : "";
      if (!t || !e) {
        problems.push("a CHECK line has no Try or no Expect part");
      } else if (checks.length >= PLAN_CHECK_LIMITS.checks) {
        extra++;
      } else {
        checks.push({ id: `plan-${checks.length + 1}`, try: t, expect: e, source: "plan" });
      }
      continue;
    }
    const n = NO_CHECKS_LINE.exec(line);
    if (n) {
      const why = clean(n[1]!);
      if (!why) emptyNone = true;
      else if (none === undefined) none = why;
    }
  }
  if (extra > 0) problems.push(`more than ${PLAN_CHECK_LIMITS.checks} CHECK lines; the first ${PLAN_CHECK_LIMITS.checks} are kept`);
  if (checks.length > 0 && none !== undefined) {
    problems.push("the plan has checks and a NO_CHECKS line; the line is ignored");
    none = undefined;
  } else if (none === undefined && emptyNone) {
    problems.push("the NO_CHECKS line gives no reason");
  }
  return { checks, ...(none !== undefined ? { none } : {}), problems };
}

/**
 * After a top-level plan gate that is the run's final READY plan: sets or clears run.checks / run.checksNone.
 * Never throws; problems become ⚠ log lines.
 */
export function recordPlanChecks(run: RunSummary, stepId: string, log: (m: string) => void): void {
  try {
    if (!(SKILL_REQUEST_GATES as readonly string[]).includes(stepId)) return;
    const gate = planGateRecord(run);
    if (!gate || gate.id !== stepId) return;
    const r = parsePlanChecks(gate.output ?? "");
    for (const p of r.problems) log(`⚠ checks: ${p}`);
    if (r.checks.length > 0) {
      run.checks = r.checks;
      delete run.checksNone;
      log(`    · checks a person can try: ${r.checks.length} from the plan`);
    } else if (r.none !== undefined) {
      run.checks = [];
      run.checksNone = r.none;
      log(`    · checks a person can try: none — ${r.none}`);
    } else {
      delete run.checks;
      delete run.checksNone;
      log("⚠ the plan lists no checks a person can try and does not say why");
    }
  } catch {
    /* recording checks never stops a run */
  }
}
