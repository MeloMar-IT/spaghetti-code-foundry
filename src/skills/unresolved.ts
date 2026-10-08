import { z } from "zod";
import { findSkill, type SkillRegistry } from "./registry.js";
import type { SkillDecision, SkillResolution } from "./resolve.js";
import {
  RESOLVE_REJECT_CODES, UNRESOLVED_ACTIONS, UNRESOLVED_KIND, UNRESOLVED_KINDS, UNRESOLVED_LIMITS,
} from "./resolve-rules.js";
import { SKILL_DIGEST_RE, SKILL_RISKS, SKILL_ROLES, SkillIdSchema, SkillVersionSchema, type SkillRole, type UnresolvedPolicy } from "./schema.js";

// Decides what a plan does about skills that could not be resolved: stop (the default) or, for low-risk work only,
// warn and continue. Pure. Messages are built from validated fields (ids, versions, digests, limits), never from request text.
// They must not contain the phrases the watcher reads as a pause ("daily budget", "usage limit reached", "signed out").

export const UnresolvedSkillSchema = z
  .object({
    id: SkillIdSchema,
    version: SkillVersionSchema.optional(),
    code: z.enum(RESOLVE_REJECT_CODES),
    kind: z.enum(UNRESOLVED_KINDS),
    /** Only "low" can be warned about; medium and high always stop. */
    risk: z.enum(SKILL_RISKS),
    action: z.enum(UNRESOLVED_ACTIONS),
    because: z.enum(["mandatory", "high-risk", "policy"]),
    mandatory: z.boolean(),
    via: SkillIdSchema.optional(),
    cause: z.enum(RESOLVE_REJECT_CODES).optional(),
    message: z.string().min(1).max(UNRESOLVED_LIMITS.messageChars),
  })
  .strict();

export const SkillPlanSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(SKILL_ROLES),
    action: z.enum(["continue", "warn", "stop"]),
    selected: z.array(z.object({ id: SkillIdSchema, version: SkillVersionSchema, digest: z.string().regex(SKILL_DIGEST_RE) }).strict()),
    unresolved: z.array(UnresolvedSkillSchema),
    /** One line per item with action "warn". */
    warnings: z.array(z.string()),
    /** Only for "stop". */
    reason: z.string().optional(),
  })
  .strict();

export type UnresolvedSkill = z.infer<typeof UnresolvedSkillSchema>;
export type SkillPlan = z.infer<typeof SkillPlanSchema>;
type Reg = Pick<SkillRegistry, "skills" | "byKey">;
type Risk = (typeof SKILL_RISKS)[number];

/** Do the hyphen-separated words of `term` appear, whole and in order, in `text`? No substring match. */
function hasTerm(text: string, term: string): boolean {
  const a = text.split("-");
  const t = term.split("-");
  for (let i = 0; i + t.length <= a.length; i++) if (t.every((w, j) => a[i + j] === w)) return true;
  return false;
}

/**
 * "high" when the id, or the category or a capability of an installed package of that id, is one of the high-risk terms,
 * or the package says risk: high. "medium" when a package says so. Package metadata can only raise the risk.
 */
export function skillRisk(id: string, registry: Reg, highRisk: readonly string[]): Risk {
  const pkgs = registry.skills.filter((s) => s.id === id).map((s) => s.pkg);
  const words = [id, ...pkgs.flatMap((p) => [p.category, ...(p.capabilities ?? [])])];
  if (highRisk.some((t) => words.some((w) => typeof w === "string" && hasTerm(w, t)))) return "high";
  if (pkgs.some((p) => p.risk === "high")) return "high";
  if (pkgs.some((p) => p.risk === "medium")) return "medium";
  return "low";
}

const RISK_ORDER: Risk[] = ["low", "medium", "high"];
const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

/** The highest risk in the whole unit a rejection involves: the skill, everything it depends on (all the way down), and the `via` skill. */
function unitRisk(id: string, via: string | undefined, registry: Reg, highRisk: readonly string[]): Risk {
  const seen = new Set<string>();
  const todo = via ? [id, via] : [id];
  let risk: Risk = "low";
  while (todo.length) {
    const next = todo.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    risk = maxRisk(risk, skillRisk(next, registry, highRisk));
    for (const s of registry.skills) if (s.id === next) for (const d of s.pkg.dependencies ?? []) todo.push(d.id);
  }
  return risk;
}

/** The policy kind: a failing dependency counts by why it failed (trust and size stay trust and size), else by the code. */
function kindOf(code: UnresolvedSkill["code"], cause: UnresolvedSkill["cause"]): UnresolvedSkill["kind"] {
  return code === "dependency-unavailable" && cause && cause !== "unknown" ? UNRESOLVED_KIND[cause] : UNRESOLVED_KIND[code];
}

interface MessageContext {
  /** `id@version` of the skill that fails (the dependency for a dependency failure). */
  key?: string;
  digest?: string;
  limits: SkillResolution["limits"];
  role: SkillRole;
}

const RESUME = "then resume the run";

/** What is wrong with `subject` and what to do, by the reason it cannot be used. */
function causeText(code: SkillDecision["code"], subject: string, id: string, ctx: MessageContext): string {
  const key = ctx.key ?? subject;
  switch (code) {
    case "unknown":
      return `No skill ${subject} is installed. Put it in the skills folder of the data folder, pin it with "scf skills pin", ${RESUME}.`;
    case "excluded":
      return `${subject} is on skills.selection.exclude or skills.catalogue.exclude. Take it off the list, ${RESUME}.`;
    case "unapproved":
      return `${key} comes from the repository and cannot be used. Copy it to an administrator skills folder, pin it, ${RESUME}.`;
    case "unpinned":
      return `${key} is not approved yet. Check the package, run "scf skills pin ${key} ${ctx.digest ?? "<digest>"}", ${RESUME}.`;
    case "mismatch":
      return `${key} changed since it was pinned. Run "scf skills" to see both digests, then pin it with --replace or give it a new version.`;
    case "unverified":
      return `${key} cannot be checked because the skill lock cannot be read. Fix or delete skills.lock.json, pin again, ${RESUME}.`;
    case "role":
      return `${key} is not allowed for the ${ctx.role} role. Release a version that allows it, or plan without it.`;
    case "too-large":
      return `${key} is larger than skills.selection.max_skill_tokens (${ctx.limits.maxSkillTokens}). Raise the limit or shorten the skill.`;
    default:
      return `${id} cannot be used.`;
  }
}

/** The actionable message of one rejected decision. */
export function unresolvedMessage(d: SkillDecision, ctx: MessageContext): string {
  const id = d.id;
  const subject = `"${id}"`;
  const own = d.version ? `${id}@${d.version}` : id;
  const via = d.via ? `"${d.via}"` : "a dependency";
  let text: string;
  switch (d.code) {
    case "dependency-unavailable":
      text = d.cause
        ? `${subject} needs ${via}, which cannot be used. ${causeText(d.cause, via, d.via ?? id, { ...ctx, key: ctx.key })}`
        : `${subject} needs ${via}, but the chain of dependencies is nested too deeply. Shorten the chain, ${RESUME}.`;
      break;
    case "dependency-version":
      text = `${subject} needs a newer version of ${via} than the one installed. Install a newer version of ${via} and pin it, ${RESUME}.`;
      break;
    case "dependency-cycle":
      text = `${subject} has a dependency cycle through ${via}. Remove the cycle from the skill packages, ${RESUME}.`;
      break;
    case "conflict":
      text = `${subject} conflicts with ${via}, which was chosen first. Put one of them on skills.selection.exclude.`;
      break;
    case "over-count":
      text = `${own} does not fit skills.selection.max_skills (${ctx.limits.maxSkills}). Raise the limit or request fewer skills.`;
      break;
    case "over-budget":
      text = `${own} does not fit skills.selection.max_tokens (${ctx.limits.maxTokens}). Raise the limit or request fewer skills.`;
      break;
    case "blocked":
      text = "Not selected because a mandatory skill was refused or the include/exclude lists are not valid. Fix that first.";
      break;
    case "unknown":
    case "excluded":
      text = causeText(d.code, subject, id, ctx);
      break;
    default:
      text = causeText(d.code, subject, id, { ...ctx, key: ctx.key ?? own });
  }
  return text.slice(0, UNRESOLVED_LIMITS.messageChars);
}

const label = (u: UnresolvedSkill) => `${u.id} [${u.code}]: ${u.message}`;

/** Turns a resolution into the plan result: what is selected, what is not, and whether the run may go on. Pure. */
export function assessSkills(resolution: SkillResolution, registry: Reg, policy: UnresolvedPolicy): SkillPlan {
  const unresolved: UnresolvedSkill[] = [];
  for (const d of resolution.decisions) {
    if (d.outcome !== "rejected") continue;
    const code = d.code as UnresolvedSkill["code"];
    // For a failing dependency the pin command and the digest are the dependency's.
    const target = d.code === "dependency-unavailable" && d.via ? findSkill(registry, d.via) : d.version ? findSkill(registry, d.id, d.version) : findSkill(registry, d.id);
    const risk = unitRisk(d.id, d.via, registry, policy.high_risk);
    const kind = kindOf(code, d.cause);
    let action: UnresolvedSkill["action"] = policy[kind];
    let because: UnresolvedSkill["because"] = "policy";
    if (d.mandatory) because = "mandatory";
    else if (risk !== "low") because = "high-risk";
    if (because !== "policy" || !resolution.ok) action = "stop";
    unresolved.push({
      id: d.id,
      ...(d.version ? { version: d.version } : {}),
      code,
      kind,
      risk,
      action,
      because,
      mandatory: d.mandatory,
      ...(d.via ? { via: d.via } : {}),
      ...(d.cause ? { cause: d.cause } : {}),
      message: unresolvedMessage(d, { key: target?.key, digest: target?.digest, limits: resolution.limits, role: resolution.role }),
    });
  }
  const warnings = unresolved
    .filter((u) => u.action === "warn")
    .map((u) => `skill ${u.id} [${u.code}]: ${u.message} Continuing without it (skills.unresolved.${u.kind}: warn).`);
  const stops = unresolved.filter((u) => u.action === "stop");
  const stop = stops.length > 0 || !resolution.ok;
  let reason: string | undefined;
  if (stop) {
    const shown = stops.slice(0, UNRESOLVED_LIMITS.reasonItems).map(label).join(" · ");
    const more = stops.length > UNRESOLVED_LIMITS.reasonItems ? ` (+${stops.length - UNRESOLVED_LIMITS.reasonItems} more)` : "";
    reason = stops.length
      ? `skills not resolved: ${stops.length} skill(s) cannot be used — ${shown}${more}`
      : "skills not resolved: skills.selection include/exclude is not valid";
  }
  return SkillPlanSchema.parse({
    version: 1,
    role: resolution.role,
    action: stop ? "stop" : warnings.length ? "warn" : "continue",
    selected: resolution.selected.map((s) => ({ id: s.id, version: s.version, digest: s.digest })),
    unresolved,
    warnings,
    ...(reason ? { reason } : {}),
  });
}
