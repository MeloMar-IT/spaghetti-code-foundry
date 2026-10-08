import { z } from "zod";
import type { SkillsConfig } from "../config.js";
import { estimateTokens } from "./catalogue.js";
import { findSkill, selectSkill, SkillSelectError, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { SKILL_REQUEST_LIMITS } from "./request.js";
import { RESOLVE_DEFAULTS, RESOLVE_RANGE, RESOLVE_REASONS, RESOLVE_REJECT_CODES } from "./resolve-rules.js";
import {
  SKILL_DIGEST_RE, SKILL_ID_RE, SKILL_ROLES, SkillIdSchema, SkillVersionSchema, compareSkillVersions, type SkillPackage, type SkillRole,
} from "./schema.js";

// Resolves the skill ids of a plan to exact, approved versions under the administrator's policy and a context budget.
// Pure: no files, no processes. Approval is delegated to `selectSkill`; the resolver only ever returns what it lets through.

const int = z.number().int().min(0);

export const SelectedSkillSchema = z
  .object({
    id: SkillIdSchema,
    version: SkillVersionSchema,
    digest: z.string().regex(SKILL_DIGEST_RE),
    reason: z.enum(RESOLVE_REASONS),
    requiredBy: z.array(SkillIdSchema).max(RESOLVE_RANGE.maxSkills[1]),
    estimatedTokens: int,
  })
  .strict();

export const SkillDecisionSchema = z
  .object({
    id: SkillIdSchema,
    /** Absent for excluded and unknown skills. */
    version: SkillVersionSchema.optional(),
    outcome: z.enum(["selected", "rejected"]),
    code: z.enum([...RESOLVE_REASONS, ...RESOLVE_REJECT_CODES]),
    mandatory: z.boolean(),
    /** The conflicting skill or the failing dependency. */
    via: SkillIdSchema.optional(),
    /** For dependency-unavailable: why the dependency itself cannot be used. Absent when the dependency chain is too deep. */
    cause: z.enum(RESOLVE_REJECT_CODES).optional(),
    estimatedTokens: int.optional(),
  })
  .strict();

export const SkillResolutionSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(SKILL_ROLES),
    ok: z.boolean(),
    /** Load order: dependencies first. */
    selected: z.array(SelectedSkillSchema).max(RESOLVE_RANGE.maxSkills[1]),
    decisions: z.array(SkillDecisionSchema).max(SKILL_REQUEST_LIMITS.skills + RESOLVE_RANGE.include + RESOLVE_RANGE.maxSkills[1]),
    limits: z.object({ maxSkills: int, maxSkillTokens: int, maxTokens: int }).strict(),
    estimatedTokens: int,
    invalid: int,
    /** Invalid or over-limit ids in the include and exclude lists. Not zero: the selection is blocked. */
    policyErrors: int,
  })
  .strict();

export type SelectedSkill = z.infer<typeof SelectedSkillSchema>;
export type SkillDecision = z.infer<typeof SkillDecisionSchema>;
export type SkillResolution = z.infer<typeof SkillResolutionSchema>;

export interface ResolveOptions {
  /** Default "coder". */
  role?: SkillRole;
  /** Mandatory ids. */
  include?: readonly string[];
  exclude?: readonly string[];
  /** Not a whole number: the default. Otherwise clamped to RESOLVE_RANGE. */
  limits?: { maxSkills?: number; maxSkillTokens?: number; maxTokens?: number };
}

function clampLimit(v: number | undefined, def: number, [lo, hi]: readonly [number, number]): number {
  if (typeof v !== "number" || !Number.isInteger(v)) return def;
  return Math.min(hi, Math.max(lo, v));
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a skill costs in the agent's context: its description and its SKILL.md body. A prediction; reference files are left out. */
export function skillContextTokens(pkg: Pick<SkillPackage, "description" | "instructions">): number {
  return estimateTokens(`${pkg.description}\n${pkg.instructions}`);
}

type Fail = { code: (typeof RESOLVE_REJECT_CODES)[number]; via?: string; version?: string; cause?: (typeof RESOLVE_REJECT_CODES)[number] };
type Checked = { ok: true; skill: RegisteredSkill; tokens: number } | ({ ok: false } & Fail);

/** Valid, unique, sorted ids; bad ones are counted. */
function cleanIds(list: readonly string[] | undefined, max: number): { ids: string[]; invalid: number; dropped: number } {
  const out = new Set<string>();
  let invalid = 0;
  let dropped = 0;
  for (const raw of list ?? []) {
    if (typeof raw !== "string" || !SKILL_ID_RE.test(raw)) invalid++;
    else if (out.size < max) out.add(raw);
    else if (!out.has(raw)) dropped++;
  }
  return { ids: [...out].sort(cmp), invalid, dropped };
}

/** Pure. Never throws for a bad request or policy: every problem is a decision. */
export function resolveSkills(
  registry: Pick<SkillRegistry, "skills" | "byKey" | "problems">,
  requested: readonly string[],
  opts: ResolveOptions = {},
): SkillResolution {
  const role: SkillRole = opts.role && SKILL_ROLES.includes(opts.role) ? opts.role : "coder";
  const limits = {
    maxSkills: clampLimit(opts.limits?.maxSkills, RESOLVE_DEFAULTS.maxSkills, RESOLVE_RANGE.maxSkills),
    maxSkillTokens: clampLimit(opts.limits?.maxSkillTokens, RESOLVE_DEFAULTS.maxSkillTokens, RESOLVE_RANGE.maxSkillTokens),
    maxTokens: clampLimit(opts.limits?.maxTokens, RESOLVE_DEFAULTS.maxTokens, RESOLVE_RANGE.maxTokens),
  };
  const inc = cleanIds(opts.include, RESOLVE_RANGE.include);
  const exc = cleanIds(opts.exclude, RESOLVE_RANGE.exclude);
  const req = cleanIds(requested, SKILL_REQUEST_LIMITS.skills);
  const invalid = req.invalid;
  // A policy list that cannot be read in full must not let anything through: the selection is blocked.
  const policyErrors = inc.invalid + inc.dropped + exc.invalid + exc.dropped;
  const mandatory = new Set(inc.ids);
  const excluded = new Set(exc.ids);
  const requestedSet = new Set(req.ids);

  // Is this id approved, allowed for the role and small enough? Memoised.
  const checks = new Map<string, Checked>();
  const check = (id: string): Checked => {
    let c = checks.get(id);
    if (c) return c;
    c = checkOnce(id);
    checks.set(id, c);
    return c;
  };
  const checkOnce = (id: string): Checked => {
    if (excluded.has(id)) return { ok: false, code: "excluded" };
    const active = findSkill(registry, id);
    if (!active) return { ok: false, code: "unknown" };
    let skill: RegisteredSkill;
    try {
      skill = selectSkill(registry, active.id, active.version);
    } catch (e) {
      if (e instanceof SkillSelectError) return { ok: false, code: e.code, version: active.version };
      throw e;
    }
    const roles = skill.pkg.roles ?? [];
    if (roles.length && !roles.includes(role)) return { ok: false, code: "role", version: skill.version };
    const tokens = skillContextTokens(skill.pkg);
    if (tokens > limits.maxSkillTokens) return { ok: false, code: "too-large", version: skill.version };
    return { ok: true, skill, tokens };
  };

  // Depth-first walk: dependencies sorted by id, listed before the skill that needs them.
  const walk = (rootId: string): { order: RegisteredSkill[] } | Fail => {
    const done = new Set<string>();
    const stack: string[] = [];
    const order: RegisteredSkill[] = [];
    const visit = (id: string, isRoot: boolean, minVersion?: string): Fail | undefined => {
      if (stack.includes(id)) return { code: "dependency-cycle", via: id };
      const c = check(id);
      if (!c.ok) return isRoot ? { code: c.code, version: c.version } : { code: "dependency-unavailable", via: id, cause: c.code };
      if (minVersion && compareSkillVersions(c.skill.version, minVersion) < 0) return { code: "dependency-version", via: id };
      if (done.has(id)) return undefined;
      if (stack.length >= RESOLVE_RANGE.depth) return { code: "dependency-unavailable", via: id };
      stack.push(id);
      const deps = [...(c.skill.pkg.dependencies ?? [])].sort((a, b) => cmp(a.id, b.id));
      for (const d of deps) {
        const err = visit(d.id, false, d.min_version);
        if (err) return err;
      }
      stack.pop();
      done.add(id);
      order.push(c.skill);
      return undefined;
    };
    const err = visit(rootId, true);
    return err ?? { order };
  };

  const tokensOf = (id: string) => {
    const c = check(id);
    return c.ok ? c.tokens : undefined;
  };
  const versionOf = (id: string) => {
    const c = check(id);
    return c.ok ? c.skill.version : c.version;
  };
  const conflicts = (a: RegisteredSkill, b: RegisteredSkill) => (a.pkg.conflicts ?? []).includes(b.id) || (b.pkg.conflicts ?? []).includes(a.id);

  const selected = new Map<string, RegisteredSkill>(); // insertion order = load order
  let total = 0;
  const rejected = new Map<string, Fail>();

  // Mandatory ids first, then the other requested ids. Each root is admitted together with its fresh dependencies, or not at all.
  const roots = [...inc.ids, ...req.ids.filter((id) => !mandatory.has(id))];
  for (const id of roots) {
    const w = walk(id);
    if (!("order" in w)) {
      rejected.set(id, w);
      continue;
    }
    const fresh = w.order.filter((s) => !selected.has(s.id));
    let fail: Fail | undefined;
    // A conflict with an admitted skill: the earlier one stays. A conflict inside the unit: the whole unit is refused.
    const others = [...selected.values()];
    for (const f of fresh) {
      const hit = others.filter((o) => conflicts(f, o)).map((o) => o.id).sort(cmp)[0];
      if (hit) {
        fail = { code: "conflict", via: hit };
        break;
      }
    }
    if (!fail) {
      const inner = new Set<string>();
      for (const f of fresh)
        for (const g of fresh)
          if (f !== g && conflicts(f, g)) {
            inner.add(f.id);
            inner.add(g.id);
          }
      inner.delete(id);
      if (inner.size) fail = { code: "conflict", via: [...inner].sort(cmp)[0] };
    }
    const freshTokens = fresh.reduce((n, s) => n + (tokensOf(s.id) ?? 0), 0);
    if (!fail && selected.size + fresh.length > limits.maxSkills) fail = { code: "over-count" };
    if (!fail && total + freshTokens > limits.maxTokens) fail = { code: "over-budget" };
    if (fail) {
      rejected.set(id, { ...fail, version: versionOf(id) });
      continue;
    }
    for (const f of fresh) selected.set(f.id, f);
    total += freshTokens;
  }

  // A mandatory skill that was refused blocks the whole selection.
  const blocked = policyErrors > 0 || inc.ids.some((id) => rejected.has(id));
  const reasonOf = (id: string): SelectedSkill["reason"] => (mandatory.has(id) ? "mandatory" : requestedSet.has(id) ? "requested" : "dependency");

  const decisions: SkillDecision[] = [];
  const decide = (id: string) => {
    const isMandatory = mandatory.has(id);
    const s = selected.get(id);
    if (s && !blocked) {
      decisions.push({ id, version: s.version, outcome: "selected", code: reasonOf(id), mandatory: isMandatory, estimatedTokens: tokensOf(id) });
      return;
    }
    const r = rejected.get(id);
    const c = checks.get(id);
    const version = r?.version ?? (s ? s.version : c && c.ok ? c.skill.version : undefined);
    const d: SkillDecision = {
      id, ...(version ? { version } : {}), outcome: "rejected", code: r ? r.code : "blocked", mandatory: isMandatory,
      ...(r?.via ? { via: r.via } : {}),
      ...(r?.cause ? { cause: r.cause } : {}),
    };
    const t = tokensOf(id);
    if (t !== undefined) d.estimatedTokens = t;
    decisions.push(d);
  };
  inc.ids.forEach(decide);
  req.ids.filter((id) => !mandatory.has(id)).forEach(decide);
  if (!blocked) {
    for (const id of [...selected.keys()].sort(cmp)) {
      if (mandatory.has(id) || requestedSet.has(id)) continue;
      decide(id);
    }
  }

  const list: SelectedSkill[] = blocked
    ? []
    : [...selected.values()].map((s) => ({
        id: s.id,
        version: s.version,
        digest: s.digest,
        reason: reasonOf(s.id),
        requiredBy: [...selected.values()].filter((o) => (o.pkg.dependencies ?? []).some((d) => d.id === s.id)).map((o) => o.id).sort(cmp),
        estimatedTokens: tokensOf(s.id) ?? 0,
      }));

  return SkillResolutionSchema.parse({
    version: 1,
    role,
    ok: !blocked,
    selected: list,
    decisions,
    limits,
    estimatedTokens: list.reduce((n, s) => n + s.estimatedTokens, 0),
    invalid,
    policyErrors,
  });
}

/** include, exclude (selection ∪ catalogue) and limits from the config key skills.selection. */
export function resolveOptionsFrom(skills: SkillsConfig): Pick<ResolveOptions, "include" | "exclude" | "limits"> {
  const sel = skills.selection;
  return {
    include: [...sel.include],
    exclude: [...new Set([...sel.exclude, ...skills.catalogue.exclude])],
    limits: { maxSkills: sel.max_skills, maxSkillTokens: sel.max_skill_tokens, maxTokens: sel.max_tokens },
  };
}
