import { createHash } from "node:crypto";
import { z } from "zod";
import { CANONICAL_STOP_PREFIX } from "./canonical-rules.js";
import type { CanonicalResult } from "./canonical.js";
import { CHOICE_LIMITS, CHOICE_PROBLEM_TEXT, PINS_FILE, type CHOICE_LEVELS, type CHOICE_PROBLEMS } from "./choice-rules.js";
import { credentialProblem } from "./credential-scan.js";
import { byteCmp } from "./import-plan.js";
import { parseSkillKey } from "./lock.js";
import { canonicalJson } from "./normalize-values.js";
import { isUtcTime } from "./release.js";
import { SkillIdSchema } from "./schema.js";
import { hasUnsafeChar, OWNER_RE, type SourceProblem } from "./sources.js";

// Owner overrides (catalogue level) and project pins (repository level): reviewed, dated, attributed records that choose one approved
// skill version for an exclusive capability. Pure: no clock, file system or process. A choice only ranks eligible candidates higher
// (canonical.ts); it cannot bring back a revoked or failed skill.

export type ChoiceLevel = (typeof CHOICE_LEVELS)[number];
export type ChoiceCode = (typeof CHOICE_PROBLEMS)[number];
export interface SkillChoice { capability: string; target: string; by: string; reason: string; from: string; expires?: string; review_by?: string }
export interface SkillOverride extends SkillChoice { scope: "all" | { repositories: string[] } }

const time = z.string().refine(isUtcTime, "must be a UTC time like 2026-01-31T12:00:00Z");
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

const entryShape = {
  capability: SkillIdSchema,
  target: z.string().refine((v) => parseSkillKey(v) !== undefined, "must be a skill id and version like my-skill@1.0.0"),
  by: z.string().regex(OWNER_RE, "must be a GitHub user or team like @octocat or @acme/skills"),
  reason: z
    .string()
    .min(1)
    .max(CHOICE_LIMITS.reasonChars)
    .refine((v) => !hasUnsafeChar(v), "must not hold control characters")
    .refine((v) => credentialProblem(v) === undefined, "must not hold what looks like a credential"),
  from: time,
  expires: time.optional(),
  review_by: time.optional(),
};
function datesOk(e: { from: string; expires?: string | undefined; review_by?: string | undefined }, ctx: z.RefinementCtx) {
  if (e.expires === undefined && e.review_by === undefined) ctx.addIssue({ code: "custom", message: "needs expires or review_by", path: [] });
  for (const k of ["expires", "review_by"] as const) {
    const v = e[k];
    if (v !== undefined && isUtcTime(v) && isUtcTime(e.from) && Date.parse(v) <= Date.parse(e.from)) ctx.addIssue({ code: "custom", message: "must be later than from", path: [k] });
  }
}
const PinSchema = z.object(entryShape).strict().superRefine(datesOk);
const ScopeSchema = z.union([
  z.literal("all"),
  z.object({ repositories: z.array(z.string().regex(REPO_RE, "must be like owner/name")).min(1).max(CHOICE_LIMITS.repositories) }).strict(),
]);
const OverrideSchema = z.object({ ...entryShape, scope: ScopeSchema }).strict().superRefine(datesOk);

export const ProjectPinsSchema = z
  .object({ schema: z.literal(1), pins: z.array(PinSchema).max(CHOICE_LIMITS.entries) })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.pins.forEach((p, i) => {
      if (seen.has(p.capability)) ctx.addIssue({ code: "custom", message: "has two project pins for one capability", path: ["pins", i, "capability"] });
      seen.add(p.capability);
    });
  });
export const SkillOverridesSchema = z
  .object({ schema: z.literal(1), overrides: z.array(OverrideSchema).max(CHOICE_LIMITS.entries) })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.overrides.forEach((o, i) => {
      const repos = o.scope === "all" ? ["*"] : o.scope.repositories.map((r) => r.toLowerCase());
      if (new Set(repos).size !== repos.length) ctx.addIssue({ code: "custom", message: "lists a repository twice", path: ["overrides", i, "scope"] });
      for (const r of new Set(repos)) {
        const k = `${o.capability} ${r}`;
        if (seen.has(k)) ctx.addIssue({ code: "custom", message: "has two owner overrides for one capability and scope", path: ["overrides", i, "scope"] });
        seen.add(k);
      }
    });
  });

export type ChoicesParse<T> = { ok: true; items: T[] } | { ok: false; problems: SourceProblem[] };

function problemsOf(err: z.ZodError): SourceProblem[] {
  return err.issues.slice(0, 20).map((i) => ({
    where: i.path.length ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") : "file",
    message: i.code === "unrecognized_keys" ? "has a key that is not known" : i.message,
  }));
}
/** Checks parsed YAML. Never throws; no problem repeats file content. */
export function parseProjectPins(raw: unknown): ChoicesParse<SkillChoice> {
  const r = ProjectPinsSchema.safeParse(raw);
  return r.success ? { ok: true, items: r.data.pins as SkillChoice[] } : { ok: false, problems: problemsOf(r.error) };
}
export function parseSkillOverrides(raw: unknown): ChoicesParse<SkillOverride> {
  const r = SkillOverridesSchema.safeParse(raw);
  return r.success ? { ok: true, items: r.data.overrides as SkillOverride[] } : { ok: false, problems: problemsOf(r.error) };
}

/** "sha256:<hex>" of canonicalJson(entry): the whole validated entry, reason included. */
export function choiceDigest(entry: SkillChoice | SkillOverride): string {
  const plain = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
  return `sha256:${createHash("sha256").update(canonicalJson(plain), "utf8").digest("hex")}`;
}

export interface PlannedChoice {
  level: ChoiceLevel;
  capability: string;
  target: string;
  by: string;
  scope: "all" | "repository";
  from: string;
  expires?: string;
  reviewBy?: string;
  reviewDue: boolean;
  digest: string;
  /** false: a repository-scoped override of the same capability replaced it; it is not given to the selector. */
  given: boolean;
}
/** Also the shape kept on the step record. No free text. */
export type AppliedChoice = Omit<PlannedChoice, "given"> & { effect: "selected" | "superseded" };
export interface ChoiceProblem { code: ChoiceCode; level?: ChoiceLevel; capability?: string; target?: string }
export interface ChoicePlan { pins: Record<string, string>; overrides: Record<string, string>; planned: PlannedChoice[]; pending: number; problems: ChoiceProblem[] }

const LEVEL_ORDER: Record<ChoiceLevel, number> = { "project-pin": 0, "owner-override": 1 };
const SCOPE_ORDER = { repository: 0, all: 1 } as const;
const planSort = (a: { capability?: string; level?: ChoiceLevel; scope?: "all" | "repository" }, b: typeof a) =>
  byteCmp(a.capability ?? "", b.capability ?? "") ||
  LEVEL_ORDER[a.level ?? "project-pin"] - LEVEL_ORDER[b.level ?? "project-pin"] ||
  SCOPE_ORDER[a.scope ?? "all"] - SCOPE_ORDER[b.scope ?? "all"];

export function planSkillChoices(i: {
  overrides?: readonly SkillOverride[];
  pins?: readonly SkillChoice[];
  repository?: string;
  now: Date;
  exclusive: readonly string[];
}): ChoicePlan {
  const repo = i.repository?.toLowerCase();
  const now = i.now.getTime();
  const exclusive = new Set(i.exclusive);
  const entries: { level: ChoiceLevel; scope: "all" | "repository"; e: SkillChoice }[] = [];
  for (const p of i.pins ?? []) entries.push({ level: "project-pin", scope: "repository", e: p });
  for (const o of i.overrides ?? []) {
    if (o.scope === "all") entries.push({ level: "owner-override", scope: "all", e: o });
    else if (repo !== undefined && o.scope.repositories.some((r) => r.toLowerCase() === repo)) entries.push({ level: "owner-override", scope: "repository", e: o });
  }
  const planned: PlannedChoice[] = [];
  const problems: (ChoiceProblem & { scope?: "all" | "repository" })[] = [];
  let pending = 0;
  for (const { level, scope, e } of entries) {
    if (now < Date.parse(e.from)) {
      pending++;
      continue;
    }
    const ref = { level, capability: e.capability, target: e.target };
    if (e.expires !== undefined && Date.parse(e.expires) <= now) {
      problems.push({ code: "expired", ...ref, scope });
      continue;
    }
    if (!exclusive.has(e.capability)) {
      problems.push({ code: "not-exclusive", ...ref, scope });
      continue;
    }
    planned.push({
      level, capability: e.capability, target: e.target, by: e.by, scope, from: e.from,
      ...(e.expires !== undefined ? { expires: e.expires } : {}),
      ...(e.review_by !== undefined ? { reviewBy: e.review_by } : {}),
      reviewDue: e.review_by !== undefined && Date.parse(e.review_by) <= now,
      digest: choiceDigest(e),
      given: true,
    });
  }
  // A repository-scoped override beats an `all` override of the same capability.
  const repoOverride = new Set(planned.filter((p) => p.level === "owner-override" && p.scope === "repository").map((p) => p.capability));
  for (const p of planned) if (p.level === "owner-override" && p.scope === "all" && repoOverride.has(p.capability)) p.given = false;
  planned.sort(planSort);
  problems.sort(planSort);
  const pins: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  for (const p of planned) if (p.given) (p.level === "project-pin" ? pins : overrides)[p.capability] = p.target;
  return { pins, overrides, planned, pending, problems: problems.map(({ scope: _s, ...p }) => p) };
}

const REJECT_TO_CODE: Record<string, ChoiceCode> = {
  "ambiguous-record": "ambiguous-record", revoked: "revoked", quarantined: "quarantined", "discovery-only": "unapproved", safety: "safety",
  licence: "licence", tools: "tools", incompatible: "incompatible", "compatibility-unchecked": "compatibility-unchecked",
};

export function checkSkillChoices(
  plan: ChoicePlan,
  result: CanonicalResult,
  targetState?: (target: string) => "missing" | "not-active" | "unapproved" | "not-usable",
): { problems: ChoiceProblem[]; applied: AppliedChoice[] } {
  const problems = [...plan.problems];
  for (const r of result.resolutions)
    for (const ig of r.ignored) {
      const code: ChoiceCode =
        ig.reason === "not-a-candidate"
          ? (targetState?.(ig.value) ?? "missing")
          : (REJECT_TO_CODE[r.rejected.find((x) => `${x.id}@${x.version}` === ig.value)?.code ?? ""] ?? "unapproved");
      problems.push({ code, level: ig.level, capability: r.capability, target: ig.value });
    }
  const winners = new Map(result.resolutions.map((r) => [r.capability, r.winner ? `${r.winner.id}@${r.winner.version}` : undefined]));
  const applied = plan.planned.map(({ given: _given, ...p }): AppliedChoice => ({ ...p, effect: winners.get(p.capability) === p.target ? "selected" : "superseded" }));
  return { problems, applied };
}

const FILE_CODES: readonly ChoiceCode[] = ["invalid", "no-default-branch", "unreadable", "unchecked"];

function problemMessage(p: ChoiceProblem): string {
  if (p.code === "invalid") return `The project pins file (${PINS_FILE} on the default branch) is not valid. Run "scf skills project-pins check", fix it, then run again.`;
  if (p.code === "no-default-branch")
    return 'The project pins cannot be read: the default branch of this repository is not known (origin/HEAD is not set). Run "git remote set-head origin -a" in the repository, then run again.';
  if (p.code === "unreadable") return "The project pins cannot be read from the default branch. Run again.";
  if (p.code === "unchecked") return "The owner choices of this run could not be checked, because the skill catalogue could not be built. Run again.";
  const what = p.level === "project-pin" ? "project pin" : "owner override";
  const where = p.level === "project-pin" ? `${PINS_FILE} on the default branch` : "the owner overrides";
  return `The ${what} for "${p.capability}" names ${p.target}, ${CHOICE_PROBLEM_TEXT[p.code]}. Change or remove it in ${where}, then run again.`;
}

/** One stop line from slugs and codes only, never from a reason. undefined when there are no problems. */
export function choiceStop(problems: readonly ChoiceProblem[]): string | undefined {
  if (!problems.length) return undefined;
  const sorted = [...problems].sort((a, b) => Number(FILE_CODES.includes(b.code)) - Number(FILE_CODES.includes(a.code)));
  const more = sorted.length - 1;
  return `${CANONICAL_STOP_PREFIX}${problemMessage(sorted[0]!)}${more > 0 ? ` (and ${more} more)` : ""}`;
}
