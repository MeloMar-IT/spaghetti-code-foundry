/**
 * Checks a person can try: the plan's `- CHECK: Try: … — Expect: …` lines (or one `NO_CHECKS: <why>` line), read from the
 * output of the plan gate and kept on the run. The text comes from an agent: it is never run, control characters are
 * removed and every part is cut. Recording never stops a run.
 */
import { planGateRecord, SKILL_REQUEST_GATES } from "../skills/request.js";
import { createHash } from "node:crypto";
import { rewriteRunMark, type RunSummary } from "./state.js";

export const CHECK_MARKS = ["works", "not-quite"] as const;
export type CheckMarkValue = (typeof CHECK_MARKS)[number];
export interface CheckMark {
  mark: CheckMarkValue;
  at: string;
  by?: string;
}

export interface PersonCheck {
  id: string;
  try: string;
  expect: string;
  source: "plan" | "person";
  /** When the person marked it Works in an earlier round; it comes back unmarked. */
  worked?: string;
  by?: string;
  at?: string;
}

export const PLAN_CHECK_LIMITS = { checks: 4, partChars: 300 } as const;
/** A change keeps at most this many checks written by the person. */
export const PERSON_CHECK_LIMITS = { person: 4 } as const;

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

/** Text from a person or an agent, made safe: control characters out, one line, cut. "" for anything that is not text. */
export function cleanCheckPart(s: unknown): string {
  return typeof s === "string" ? clean(s) : "";
}

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
    // A new plan reuses the ids (plan-1 …): marks of the old checks must not apply to the new ones. What was marked
    // Works moves into `worked`; the person's own checks stay.
    const next = nextRoundChecks(run.checks, run.checkMarks, r.checks);
    const kept = next.length - r.checks.length;
    const keptText = kept > 0 ? `, ${kept} kept` : "";
    delete run.checkMarks;
    for (const p of r.problems) log(`⚠ checks: ${p}`);
    if (next.length > 0) {
      run.checks = next;
      delete run.checksNone;
      if (r.checks.length > 0) log(`    · checks a person can try: ${r.checks.length} from the plan${keptText}`);
      else if (r.none !== undefined) log(`    · checks a person can try: none — ${r.none}${keptText}`);
      else log(`⚠ the plan lists no checks a person can try and does not say why${keptText}`);
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

const validCheck = (c: unknown): c is PersonCheck => !!c && typeof c === "object" && typeof (c as PersonCheck).id === "string" && typeof (c as PersonCheck).try === "string" && typeof (c as PersonCheck).expect === "string";
const textKey = (c: { try: string; expect: string }) => JSON.stringify([c.try, c.expect]);

/**
 * Pure. The checks of the next round. A check marked Works gets `worked` (the time of the mark); one marked Not quite
 * loses it. Without `plan` the checks stay as they are. With `plan` (a new plan): the plan's checks (one with the same
 * text as an earlier one inherits `worked`), then every earlier plan check that worked and is not in the plan (`kept-N`),
 * then the person's own checks with their ids.
 */
export function nextRoundChecks(checks: readonly PersonCheck[] | undefined, marks: Record<string, CheckMark> | undefined, plan?: readonly PersonCheck[]): PersonCheck[] {
  const cur = (Array.isArray(checks) ? checks : []).filter(validCheck).map((c): PersonCheck => {
    const m = marks && typeof marks === "object" && Object.hasOwn(marks, c.id) ? marks[c.id] : undefined;
    const { worked: old, ...rest } = c;
    let worked = old;
    if (m?.mark === "works" && typeof m.at === "string") worked = m.at;
    else if (m?.mark === "not-quite") worked = undefined;
    return typeof worked === "string" ? { ...rest, worked } : { ...rest };
  });
  if (!plan) return cur;
  const before = new Map<string, string>();
  for (const c of cur) if (c.worked !== undefined && !before.has(textKey(c))) before.set(textKey(c), c.worked);
  const out: PersonCheck[] = plan.map((p) => {
    const w = before.get(textKey(p));
    return w !== undefined ? { ...p, worked: w } : { ...p };
  });
  const seen = new Set(out.map(textKey));
  let n = 0;
  for (const c of cur) {
    if (c.source === "person" || c.worked === undefined || seen.has(textKey(c))) continue;
    seen.add(textKey(c));
    out.push({ ...c, id: `kept-${++n}`, source: "plan" });
  }
  for (const c of cur) if (c.source === "person") out.push(c);
  return out;
}

/** A round ends (the change is sent back): checks marked Works get `worked`, the marks go. Never throws. */
export function endCheckRound(run: RunSummary): void {
  try {
    if (Array.isArray(run.checks) && run.checks.length > 0) run.checks = nextRoundChecks(run.checks, run.checkMarks);
    delete run.checkMarks;
  } catch {
    /* a round never stops a run */
  }
}

/** Pure. The checks as a person sees them: no `by`, no `at`; an unknown source reads as "plan". */
export function publicChecks(checks: readonly PersonCheck[] | undefined): { id: string; try: string; expect: string; source: "plan" | "person"; worked?: string }[] {
  return (Array.isArray(checks) ? checks : []).filter(validCheck).map((c) => ({
    id: c.id,
    try: c.try,
    expect: c.expect,
    source: c.source === "person" ? "person" : "plan",
    ...(typeof c.worked === "string" ? { worked: c.worked } : {}),
  }));
}

/**
 * Adds a check written by the person to a waiting run, in run.json. "full": the run has all the checks of its own it may
 * keep; "refused": not waiting, `revision` is not the check set of the run, run.json changed meanwhile, or it cannot be read.
 * Never throws.
 */
export function addRunCheck(runDir: string, text: { try: string; expect: string }, meta: { by: string; at: string }, revision?: string): { id: string } | "full" | "refused" {
  let id = "";
  let full = false;
  const done = rewriteRunMark(runDir, (s) => {
    const checks = Array.isArray(s.checks) ? (s.checks as PersonCheck[]) : [];
    if (s.status !== "waiting") return undefined;
    if (revision !== undefined && revision !== checksRevision(checks)) return undefined;
    const own = checks.filter((c) => c && c.source === "person");
    if (own.length >= PERSON_CHECK_LIMITS.person) {
      full = true;
      return undefined;
    }
    let top = 0;
    for (const c of own) {
      const n = /^person-(\d+)$/.exec(String(c.id))?.[1];
      if (n) top = Math.max(top, Number(n));
    }
    id = `person-${top + 1}`;
    const out: Record<string, unknown> = { ...s, checks: [...checks, { id, try: text.try, expect: text.expect, source: "person", by: meta.by, at: meta.at }] };
    delete out.checksNone;
    return out;
  });
  return done ? { id } : full ? "full" : "refused";
}

/** Pure. A short fingerprint of the check set (ids and texts); a request made against an older set is refused. */
export function checksRevision(checks: readonly { id: string; try: string; expect: string }[] | undefined): string {
  const text = JSON.stringify((checks ?? []).map((c) => [c.id, c.try, c.expect]));
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Pure. The valid marks of a run (ids that are in `checks`, a known mark and a time), without who set them. */
export function checkMarksOf(s: Pick<RunSummary, "checks" | "checkMarks">): Record<string, { mark: CheckMarkValue; at: string }> {
  const out: Record<string, { mark: CheckMarkValue; at: string }> = {};
  const marks = s.checkMarks;
  if (!marks || typeof marks !== "object" || !Array.isArray(s.checks)) return out;
  for (const c of s.checks) {
    const m = c && typeof c.id === "string" && Object.hasOwn(marks, c.id) ? marks[c.id] : undefined;
    if (m && (CHECK_MARKS as readonly unknown[]).includes(m.mark) && typeof m.at === "string") out[c.id] = { mark: m.mark, at: m.at };
  }
  return out;
}

/**
 * Sets (or, with null, removes) the person's mark on one check of a waiting run, in run.json, and changes nothing else.
 * "same": the mark was already so; "refused": not waiting, no such check, `revision` is not the check set of the run,
 * run.json changed meanwhile, or it cannot be read. Never throws.
 */
export function setRunCheckMark(runDir: string, checkId: string, mark: CheckMarkValue | null, meta: { by: string; at: string }, revision?: string): "done" | "same" | "refused" {
  let same = false;
  const done = rewriteRunMark(runDir, (s) => {
    const checks = Array.isArray(s.checks) ? (s.checks as PersonCheck[]) : [];
    if (s.status !== "waiting" || !checks.some((c) => c && c.id === checkId)) return undefined;
    if (revision !== undefined && revision !== checksRevision(checks)) return undefined;
    const marks = s.checkMarks && typeof s.checkMarks === "object" && !Array.isArray(s.checkMarks) ? (s.checkMarks as Record<string, CheckMark>) : {};
    const current = Object.hasOwn(marks, checkId) ? marks[checkId]?.mark : undefined;
    if ((current ?? null) === mark) {
      same = true;
      return undefined;
    }
    const next: Record<string, CheckMark> = { ...marks };
    if (mark === null) delete next[checkId];
    else next[checkId] = { mark, at: meta.at, by: meta.by };
    const out: Record<string, unknown> = { ...s, checkMarks: next };
    if (Object.keys(next).length === 0) delete out.checkMarks;
    return out;
  });
  return done ? "done" : same ? "same" : "refused";
}
