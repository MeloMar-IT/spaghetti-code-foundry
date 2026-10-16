import { z } from "zod";

/**
 * The step-by-step plan of a reply (#238). A pure function: the model proposes ordered steps, `checkPlan` keeps only
 * what the contract allows. It imports nothing at run time from `contract.ts`; what it needs to look up (an action,
 * a page, the text cleaner) comes in as a parameter. Nothing in a plan runs by itself, and no stored step says that
 * anything worked: only a verified read-back (a later story) may say that.
 */

export const STEP_KINDS = ["explanation", "navigation", "check", "input", "reversible", "high-impact"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const IMPACTS = ["read-only", "reversible", "high"] as const;
export type Impact = (typeof IMPACTS)[number];

/** The six kinds of step, in words for people, and the impact each one has. */
export const STEP_RULES: Record<StepKind, { label: string; what: string; changesState: boolean; impact: Impact }> = {
  explanation: { label: "Explanation", what: "Text that explains. Nothing to do.", changesState: false, impact: "read-only" },
  navigation: { label: "Open a page", what: "A page of the Foundry that you may open.", changesState: false, impact: "read-only" },
  check: { label: "Read-only check", what: "Something to look at. It changes nothing.", changesState: false, impact: "read-only" },
  input: { label: "Your input", what: "Something only you can supply or decide.", changesState: false, impact: "read-only" },
  reversible: { label: "Reversible change", what: "A change you can undo.", changesState: true, impact: "reversible" },
  "high-impact": { label: "High-impact change", what: "A change that is hard or impossible to undo.", changesState: true, impact: "high" },
};

export const PLAN_MAX = 8;
export const STEP_TEXT_MAX = { title: 160, instructions: 500, signal: 300 } as const;
const RAW_MAX = 20;

const ranked = (i: Impact) => IMPACTS.indexOf(i);
export const kindOfImpact = (i: Impact): StepKind => (i === "high" ? "high-impact" : i === "reversible" ? "reversible" : "check");

/** Words that make a step high impact, whole words in any case. The server raises a step on them; it never lowers one. */
export const HIGH_IMPACT_WORDS: readonly string[] = [
  "delete", "deletes", "deleted", "deleting", "remove", "removes", "removed", "removing", "drop", "drops", "dropped", "dropping",
  "purge", "purges", "purged", "purging", "wipe", "wipes", "wiped", "wiping", "discard", "discards", "discarded", "discarding",
  "overwrite", "overwrites", "overwritten", "overwriting", "force", "forces", "forced", "forcing", "reset", "resets", "resetting",
  "revoke", "revokes", "revoked", "revoking", "cancel", "cancels", "cancelled", "canceled", "cancelling", "abort", "aborts", "aborted", "aborting",
  "close", "closes", "closed", "closing", "uninstall", "uninstalls", "uninstalled", "uninstalling", "destroy", "destroys", "destroyed", "destroying",
];
const HIGH_IMPACT = new RegExp(`\\b(?:${HIGH_IMPACT_WORDS.join("|")})\\b`, "i");

/** Text that says something already worked. A step that holds it is dropped. */
export const CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:done|succeeded|successfully|completed|fixed|resolved)\b/i,
  /\b(?:has|have|was|were)\s+been\s+(?:\w+ed|reset|done|made|set|sent|put|cut|undone)\b/i,
  /\bI\s+(?:have\s+)?\w+ed\b/,
];

// A sentence that asks, or tells the person to check something, is not an assertion that it happened.
const CONDITIONAL = /\?|\b(?:whether|if|unless|until|when)\b|^\s*(?:please\s+)?(?:check|verify|confirm|make sure|ensure|see|look)\b/i;

/** True when a text says, in some sentence, that something already worked or was done. Questions and checks are not claims. */
export function claimsResult(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/).some((s) => !CONDITIONAL.test(s) && CLAIM_PATTERNS.some((p) => p.test(s)));
}

export const CHECK_FIRST = {
  expected: "What you see on the linked page matches the problem.",
  failure: "What you see does not match the problem.",
  fallback: "Stop here and ask the owner of the work.",
  title: "Check first. Change nothing yet.",
  instructions: "The evidence does not confirm this change. Check on the linked page that what you see matches the problem before you change anything.",
} as const;

export const PlanStepSchema = z
  .object({
    kind: z.enum(STEP_KINDS),
    title: z.string().min(1).max(STEP_TEXT_MAX.title),
    instructions: z.string().min(1).max(STEP_TEXT_MAX.instructions).optional(),
    to: z.string().min(1).max(300).optional(),
    action: z.string().min(1).max(80).optional(),
    evidence: z.array(z.string().min(1).max(40)).max(10),
    expected: z.string().min(1).max(STEP_TEXT_MAX.signal).optional(),
    failure: z.string().min(1).max(STEP_TEXT_MAX.signal).optional(),
    fallback: z.string().min(1).max(STEP_TEXT_MAX.signal).optional(),
    wouldBe: z.enum(["reversible", "high-impact"]).optional(),
    proposal: z.string().min(1).max(STEP_TEXT_MAX.title).optional(),
  })
  .strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

export interface PlanInput {
  /** The evidence the reply kept: only these ids may be cited by a step. */
  cited: readonly { id: string; kind: string }[];
  /** Ids of sources the server marked as old or in disagreement. */
  uncertain: readonly string[];
  /** The certainty of the reply, after the evidence and uncertainty rules. */
  certainty: "confirmed" | "likely" | "unverified";
  action: (id: string) => { id: string; impact: Impact } | undefined;
  page: (to: string) => { to: string; title: string } | undefined;
  clean: (v: unknown, max: number) => string;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const isKind = (v: unknown): v is StepKind => typeof v === "string" && (STEP_KINDS as readonly string[]).includes(v);

/** The steps of a plan the server keeps, in the order the server gives them, and what it left out (fixed words only). */
export function checkPlan(raw: readonly unknown[], input: PlanInput): { plan: PlanStep[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept: PlanStep[] = [];
  if (raw.length > RAW_MAX) dropped.push("plan step: too many");
  for (const r of raw.slice(0, RAW_MAX)) {
    const o = obj(r);
    if (!o || !isKind(o.kind)) {
      dropped.push("plan step: unknown kind");
      continue;
    }
    let kind: StepKind = o.kind;
    const title = input.clean(o.title, STEP_TEXT_MAX.title);
    if (!title) {
      dropped.push("plan step: empty");
      continue;
    }
    const instructions = input.clean(o.instructions, STEP_TEXT_MAX.instructions);
    if (claimsResult(title) || claimsResult(instructions)) {
      dropped.push("plan step: claimed a result that was not checked");
      continue;
    }
    const evidence: string[] = [];
    for (const id of Array.isArray(o.evidence) ? o.evidence : []) {
      if (typeof id === "string" && input.cited.some((c) => c.id === id)) {
        if (!evidence.includes(id) && evidence.length < 10) evidence.push(id);
      } else dropped.push("plan step: evidence not kept by the reply");
    }
    let to: string | undefined;
    if (typeof o.to === "string" && o.to !== "") {
      const page = input.page(o.to);
      if (page) to = page.to;
      else dropped.push("plan step: not a page of this role");
    }
    let action: string | undefined;
    let level: Impact = STEP_RULES[kind].impact;
    if (typeof o.action === "string" && o.action !== "") {
      const def = input.action(o.action);
      if (def) {
        action = def.id;
        if (ranked(def.impact) > ranked(level)) level = def.impact;
      } else dropped.push("plan step: action not on the server's list");
    }
    const expected = input.clean(o.expected, STEP_TEXT_MAX.signal);
    const failure = input.clean(o.failure, STEP_TEXT_MAX.signal);
    const fallbackText = input.clean(o.fallback, STEP_TEXT_MAX.signal);
    // every text that is shown is read: the marker of a secret the server took out (`[removed: …]`) is not a destructive word
    if (HIGH_IMPACT.test([title, instructions, expected, failure, fallbackText].join("\n").replace(/\[removed[^\]]*\]/gi, ""))) level = "high";
    // the level can only go up from what the model labelled
    if (ranked(level) > ranked(STEP_RULES[kind].impact)) kind = kindOfImpact(level);
    if (kind === "navigation" && !to) kind = "explanation";

    const fallback = fallbackText;
    const changes = STEP_RULES[kind].changesState;
    if (changes && (!expected || !failure || !fallback)) {
      dropped.push("plan step: a change needs what to expect, how it fails and a fallback");
      continue;
    }

    let step: PlanStep = {
      kind,
      title,
      ...(instructions ? { instructions } : {}),
      ...(to ? { to } : {}),
      ...(action ? { action } : {}),
      evidence,
      ...(expected ? { expected } : {}),
      ...(failure ? { failure } : {}),
      ...(fallback ? { fallback } : {}),
    };
    const cites = evidence.map((id) => input.cited.find((c) => c.id === id)!);
    let wouldBe: "reversible" | "high-impact" | undefined;
    if (kind === "reversible" && !cites.some((c) => c.kind === "state")) wouldBe = "reversible";
    if (kind === "high-impact") {
      const diagnosed = cites.some((c) => c.kind === "state" && c.id.startsWith("diagnosis-") && !input.uncertain.includes(c.id));
      if (input.certainty !== "confirmed" || !diagnosed) wouldBe = "high-impact";
    }
    if (wouldBe) {
      // nothing the model wrote for a change it may not propose stays shown, except the title as a blocked proposal
      const { action: _a, instructions: _i, ...rest } = step;
      step = { ...rest, kind: "check", title: CHECK_FIRST.title, instructions: CHECK_FIRST.instructions, expected: CHECK_FIRST.expected, failure: CHECK_FIRST.failure, fallback: CHECK_FIRST.fallback, wouldBe, proposal: title.slice(0, STEP_TEXT_MAX.title) };
    }
    kept.push(step);
  }

  // blocks: a high-impact step keeps the read-only steps right after it; the blocks go last, everything stays stable
  const normal: PlanStep[] = [];
  const blocks: PlanStep[][] = [];
  let open: PlanStep[] | undefined;
  for (const s of kept) {
    if (s.kind === "high-impact") {
      open = [s];
      blocks.push(open);
    } else if (open && (s.kind === "check" || s.kind === "navigation" || s.kind === "explanation" || s.kind === "input")) open.push(s);
    else {
      open = undefined;
      normal.push(s);
    }
  }
  const ordered = [...normal, ...blocks.flat()];
  if (ordered.length > PLAN_MAX) dropped.push("plan step: too many");
  return { plan: ordered.slice(0, PLAN_MAX), dropped };
}
