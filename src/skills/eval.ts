import { z } from "zod";
import type { RunSummary } from "../engine/state.js";
import { SkillIdSchema } from "./schema.js";

// Skill checks of an evaluation case: a pure function over what a finished run recorded (run.json). No I/O.
// Separate verdicts: quality (the case check, see evals.ts), selection, context and activation.

export const SkillExpectSchema = z
  .object({
    selected: z.array(SkillIdSchema).max(20).default([]),
    absent: z.array(SkillIdSchema).max(100).default([]),
    /** Exactly one of these must be selected (ambiguous tasks). */
    one_of: z.array(SkillIdSchema).min(2).max(20).optional(),
    /** Largest skill block given to one session, in estimated tokens. */
    max_tokens: z.number().int().min(0).optional(),
    /** Skill tokens added to prompts over the whole run (reloads count again, reuse counts 0). */
    max_attached_tokens: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const all = [...e.selected, ...e.absent, ...(e.one_of ?? [])];
    const dup = all.find((id, i) => all.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `skill "${dup}" may appear only once in selected, absent and one_of` });
  });
export type SkillExpect = z.infer<typeof SkillExpectSchema>;

export type SkillEvalRun = Pick<RunSummary, "status" | "history"> & Partial<Pick<RunSummary, "reason" | "skillLock" | "skillPlan">>;

export interface SkillEvalResult {
  ok: boolean;
  selection: { ok: boolean; selected: string[]; missing: string[]; unexpected: string[]; ambiguous?: string[]; unresolved: { id: string; code: string }[] };
  context: { ok: boolean; tokens: number; attachedTokens: number; maxTokens?: number; maxAttachedTokens?: number };
  activation: {
    ok: boolean;
    status: "loaded" | "not-loaded" | "refused" | "none";
    notLoaded: string[];
    omitted: string[];
    reason?: string;
    sessions: { step: string; agent?: string; state?: "loaded" | "reloaded" | "reused"; role?: "reviewer"; loaded: string[]; estimatedTokens: number }[];
  };
}

/** Stop reasons of a run that refused to use skills (integrity, blocked selection, not resolved). */
export const SKILL_REFUSED_RE = /^(step "[^"]*" failed: )?(skill integrity: |skill selection is blocked: |skills not resolved: )/;

const bare = (s: string) => s.replace(/@.*$/, "");

export function evaluateSkillRun(run: SkillEvalRun, expect: SkillExpect): SkillEvalResult {
  const planned = run.skillLock?.skills ?? run.skillPlan?.selected ?? [];
  const selected = planned.map((s) => `${s.id}@${s.version}`);
  const selectedIds = new Set(planned.map((s) => s.id));
  const unresolved = (run.skillPlan?.unresolved ?? []).map((u) => ({ id: u.id, code: String((u as { code?: unknown }).code ?? "") }));

  const picked = (expect.one_of ?? []).filter((id) => selectedIds.has(id));
  const missing = expect.selected.filter((id) => !selectedIds.has(id));
  const unexpected = expect.absent.filter((id) => selectedIds.has(id));
  const oneOfBad = !!expect.one_of && picked.length !== 1;
  const selection: SkillEvalResult["selection"] = { ok: !missing.length && !unexpected.length && !oneOfBad, selected, missing, unexpected, unresolved };
  if (oneOfBad) selection.ambiguous = picked;

  const records = run.history.filter((h) => h.skills);
  const tokens = records.reduce((n, h) => Math.max(n, h.skills!.estimatedTokens), 0);
  const attachedTokens = records.reduce((n, h) => n + (h.skills!.attachedEstimatedTokens ?? h.skills!.estimatedTokens), 0);
  const context: SkillEvalResult["context"] = {
    ok: (expect.max_tokens === undefined || tokens <= expect.max_tokens) && (expect.max_attached_tokens === undefined || attachedTokens <= expect.max_attached_tokens),
    tokens, attachedTokens, maxTokens: expect.max_tokens, maxAttachedTokens: expect.max_attached_tokens,
  };

  // An agent step after the first skill session that has no skills record got none (e.g. a step with `skills: off`): an empty load.
  // Steps named "review…" are skipped: a reviewer legitimately has no block.
  const first = run.history.findIndex((h) => h.skills);
  const sessions = (first < 0 ? [] : run.history.slice(first))
    .filter((h) => h.skills || (h.type === "claude" && !/review/i.test(h.id)))
    .map((h) => ({
      step: h.id, agent: h.agent, state: h.skills?.state, role: h.skills?.role, loaded: (h.skills?.loaded ?? []).map(bare), estimatedTokens: h.skills?.estimatedTokens ?? 0,
    }));
  const coder = sessions.filter((s) => s.role !== "reviewer");
  const expected = [...expect.selected, ...(picked.length === 1 ? picked : [])];
  // Every coder session that got skills must hold every expected one; unrelated skills do not matter.
  const notLoaded = expected.filter((id) => !coder.length || coder.some((s) => !s.loaded.includes(id)));
  // A skill that must be absent must not reach any session, a reviewer's included.
  const leaked = expect.absent.filter((id) => sessions.some((s) => s.loaded.includes(id)));
  const omitted = [...new Set(records.flatMap((h) => (h.skills!.omitted ?? []).map(bare)).filter((id) => expected.includes(id)))];
  const refused = run.status !== "succeeded" && SKILL_REFUSED_RE.test(run.reason ?? "");
  const status: SkillEvalResult["activation"]["status"] = refused ? "refused" : notLoaded.length || leaked.length ? "not-loaded" : expected.length ? "loaded" : "none";
  const activation: SkillEvalResult["activation"] = { ok: status === "loaded" || status === "none", status, notLoaded: [...notLoaded, ...leaked], omitted, sessions };
  if (refused) activation.reason = (run.reason ?? "").slice(0, 300);

  return { ok: selection.ok && context.ok && activation.ok, selection, context, activation };
}
