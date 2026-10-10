import { z } from "zod";
import type { RunSummary, StepRecord } from "../engine/state.js";
import { SkillIdSchema, relativePathProblem } from "./schema.js";

// The skill request of a final plan: one "SKILL_REQUEST: {…}" line. The rules mirror tools/skill-request
// (a plain Node script the flows run); the two must be kept the same — tests/skill-request.test.ts checks it.

export const SKILL_REQUEST_VERSION = 1;
export const SKILL_REQUEST_MARKER = "SKILL_REQUEST: ";
export const SKILL_REQUEST_LIMITS = { lineBytes: 8000, skills: 20, reasonChars: 300, evidence: 5, evidenceChars: 200 } as const;
/** The steps whose output ends with the checked request line. */
export const SKILL_REQUEST_GATES = ["risk_gate", "post_plan"] as const;

/** Text that is kept out of reasons and evidence: control characters and anything that could be markup or a code span. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f<>`]/;
const EVIDENCE_PREFIXES = ["catalogue:", "issue:", "path:"] as const;

const reason = z.string().trim().min(1).max(SKILL_REQUEST_LIMITS.reasonChars).refine((s) => !FORBIDDEN.test(s), "has a forbidden character");

const evidence = z.string().trim().max(SKILL_REQUEST_LIMITS.evidenceChars).superRefine((e, ctx) => {
  const prefix = EVIDENCE_PREFIXES.find((p) => e.startsWith(p));
  if (!prefix) return void ctx.addIssue({ code: "custom", message: "has no known prefix" });
  const rest = e.slice(prefix.length);
  if (rest.trim() === "") ctx.addIssue({ code: "custom", message: "is empty after its prefix" });
  if (FORBIDDEN.test(e)) ctx.addIssue({ code: "custom", message: "has a forbidden character" });
  if (prefix === "path:") {
    const problem = relativePathProblem(rest);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }
});

export const SkillRequestItemSchema = z
  .object({ id: SkillIdSchema, reason, evidence: z.array(evidence).min(1).max(SKILL_REQUEST_LIMITS.evidence) })
  .strict();

export const SkillRequestSchema = z
  .object({ version: z.literal(SKILL_REQUEST_VERSION), skills: z.array(SkillRequestItemSchema).max(SKILL_REQUEST_LIMITS.skills) })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.skills.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["skills", i], message: "duplicate skill" });
      seen.add(s.id);
    });
  });

export type SkillRequest = z.infer<typeof SkillRequestSchema>;

export class SkillRequestError extends Error {}

/** Parses one "SKILL_REQUEST: {…}" line. Throws SkillRequestError; the text never repeats the input. */
export function parseSkillRequestLine(line: string): SkillRequest {
  if (!line.startsWith(SKILL_REQUEST_MARKER)) throw new SkillRequestError("the line does not start with the marker");
  if (Buffer.byteLength(line) > SKILL_REQUEST_LIMITS.lineBytes) throw new SkillRequestError("too long");
  let json: unknown;
  try {
    json = JSON.parse(line.slice(SKILL_REQUEST_MARKER.length));
  } catch {
    throw new SkillRequestError("not valid JSON");
  }
  const parsed = SkillRequestSchema.safeParse(json);
  if (!parsed.success) throw new SkillRequestError("does not have the asked form");
  return parsed.data;
}

/** The step of a coding run that reads the plan record. It is not a plan gate. */
export const PLAN_CHECK_STEP = "plan_check";

export const PLAN_PHASE_STEPS = new Set<string>([...SKILL_REQUEST_GATES, "plan", "pull_ticket", "send_back", "split_gate", "force_split", "create_split"]);

/**
 * The step record of a run's final READY plan gate; undefined when there is none: the plan was not READY, it is
 * being planned again, or the run is older than the check (its gate came from a flow that did not run
 * tools/skill-request, so its output holds the planner's raw text).
 * Pass `flowDef` (as stored in the run) to have that provenance checked; without it only the history is read.
 */
export function planGateRecord(run: Pick<RunSummary, "history"> & Partial<Pick<RunSummary, "flowDef">>): StepRecord | undefined {
  const last = [...run.history].reverse().find((r) => !r.parent && PLAN_PHASE_STEPS.has(r.id));
  if (!last || !last.ok || !(SKILL_REQUEST_GATES as readonly string[]).includes(last.id)) return undefined;
  // Provenance: only a gate of a flow that checks the line with the tool produced a validated one.
  if (run.flowDef) {
    const def = run.flowDef.steps?.find((s) => s.id === last.id);
    if (!def || def.type !== "shell" || !def.run.includes("/skill-request")) return undefined;
  }
  return last;
}

/** The request of a run's final READY plan; undefined when there is none (see planGateRecord). Throws SkillRequestError for a line that is not valid. */
export function planSkillRequest(run: Pick<RunSummary, "history"> & Partial<Pick<RunSummary, "flowDef">>): SkillRequest | undefined {
  const last = planGateRecord(run);
  return last ? requestOf(last) : undefined;
}

/** The request line of a draft plan under review: the last top-level plan-phase record is an ok `plan` step. Undefined otherwise. Throws SkillRequestError for a bad line. */
export function draftSkillRequest(run: Pick<RunSummary, "history">): SkillRequest | undefined {
  const last = [...run.history].reverse().find((r) => !r.parent && PLAN_PHASE_STEPS.has(r.id));
  return last && last.ok && last.id === "plan" ? requestOf(last) : undefined;
}

function requestOf(last: StepRecord): SkillRequest | undefined {
  const lines = last.output.split("\n").filter((l) => l.startsWith(SKILL_REQUEST_MARKER) || l.startsWith("SKILL_REQUEST:"));
  if (lines.length === 0) return undefined;
  if (lines.length > 1) throw new SkillRequestError("more than one SKILL_REQUEST line");
  return parseSkillRequestLine(lines[0]!);
}
