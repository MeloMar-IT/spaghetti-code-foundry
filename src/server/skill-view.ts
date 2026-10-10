import type { RunSummary } from "../engine/state.js";
import type { SkillRegistry } from "../skills/registry.js";
import { flowSkillSource } from "../skills/run-plan.js";
import { planGateRecord, planSkillRequest, SKILL_REQUEST_GATES } from "../skills/request.js";
import { RESOLVE_REASONS, RESOLVE_REJECT_CODES, UNRESOLVED_ACTIONS, UNRESOLVED_KINDS } from "../skills/resolve-rules.js";
import { planHashOf, readRunSkillLock, safeText, verifyRunSkillLock, type RunSkillLock, type RunSkillLockRead } from "../skills/run-lock.js";
import { relativePathProblem, SkillIdSchema, SkillVersionSchema } from "../skills/schema.js";
import { hidePaths } from "./user-view.js";

// What a run page shows of the skills of a run: what the plan asked for ("requested") and what the run locked
// ("resolved"), with the state of each. Read-only and never throws. Built from an allowlist of fields, each checked
// by type: nothing of a package (folder, label, instructions) and, for a user, no digest, source or commit.

export type RequestedState = "selected" | "missing" | "conflicting" | "not-approved" | "too-large" | "not-checked";
export type ContextState = "loaded" | "reloaded" | "reused" | "omitted";
export type IntegrityState = "verified" | "changed" | "missing" | "unpinned" | "unapproved" | "unverified" | "not-checked" | "not-locked";
export interface EvidenceView { kind: "catalogue" | "issue" | "path"; text: string }

export interface RequestedSkill {
  id: string;
  version?: string;
  by: "plan" | "administrator";
  state: RequestedState;
  reason?: string;
  evidence?: EvidenceView[];
  code?: string;
  message?: string;
  action?: string;
}
export interface ResolvedSkill {
  id: string;
  version: string;
  selection?: (typeof RESOLVE_REASONS)[number];
  requiredBy: string[];
  estimatedTokens?: number;
  category?: string;
  reason?: string;
  evidence?: EvidenceView[];
  integrity: IntegrityState;
  context?: ContextState;
  contextStep?: string;
  /** Reviewer checks of this skill were given in a session. */
  review?: true;
  /** Administrator only. */
  digest?: string;
  source?: "admin" | "builtin";
}
export interface RunSkillView {
  /** ok: a valid lock. none: not locked yet. missing: the file is gone. changed: unreadable, invalid or not the one the run wrote. */
  lock: "ok" | "none" | "missing" | "changed";
  /** The run planned again after it locked. */
  planChanged?: true;
  /** What the check of the current plan decided; absent when the plan is not current. */
  action?: "continue" | "warn" | "stop";
  estimatedTokens?: number;
  /** When the registry was read for the integrity words (ISO time). */
  checkedAt?: string;
  /** Administrator only. */
  commit?: string;
  requested: RequestedSkill[];
  resolved: ResolvedSkill[];
}

type RegistryLike = Pick<SkillRegistry, "skills" | "byKey" | "problems">;
export interface SkillViewOptions {
  admin: boolean;
  /** The installed skills and the time they were read; may throw. Absent: integrity is "not-checked". */
  registry?: () => { registry: RegistryLike; at?: number } | undefined;
  readLock?: (runDir: string) => RunSkillLockRead;
}

const MAX_TEXT = 400;
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
const idOf = (v: unknown): string | undefined => (typeof v === "string" && SkillIdSchema.safeParse(v).success ? v : undefined);
const versionOf = (v: unknown): string | undefined => (typeof v === "string" && SkillVersionSchema.safeParse(v).success ? v : undefined);
const categoryOf = (v: unknown): string | undefined => (typeof v === "string" && /^[\w.-]{1,64}$/.test(v) ? v : undefined);
const tokensOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const digestOf = (v: unknown): string | undefined => (typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v) ? v : undefined);
const stepIdOf = (v: unknown): string | undefined => (typeof v === "string" && /^[\w./-]{1,100}$/.test(v) ? v : undefined);
/** A sentence of the run itself: a string, short, and without a path or a secret. */
const sentence = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max && safeText(v) ? v : undefined);

/** One evidence entry as the page shows it; undefined for a non-string or an unknown prefix. A doubtful value becomes "omitted". */
export function evidenceView(e: unknown): EvidenceView | undefined {
  if (typeof e !== "string") return undefined;
  const kind = (["catalogue", "issue", "path"] as const).find((k) => e.startsWith(`${k}:`));
  if (!kind) return undefined;
  const rest = e.slice(kind.length + 1);
  if (kind === "issue") {
    const m = /^#?(\d{1,9})$/.exec(rest);
    return { kind, text: m ? m[1]! : "omitted" };
  }
  if (rest === "omitted") return { kind, text: rest };
  const ok = rest.length > 0 && rest.length <= 200 && safeText(rest) && (kind === "catalogue" || relativePathProblem(rest) === undefined);
  return { kind, text: ok ? rest : "omitted" };
}

const evidenceList = (v: unknown): EvidenceView[] | undefined => {
  const out = list(v).flatMap((e) => evidenceView(e) ?? []).slice(0, 5);
  return out.length ? out : undefined;
};

const STATE_OF_KIND: Record<(typeof UNRESOLVED_KINDS)[number], RequestedState> = {
  unknown: "missing", missing: "missing", conflict: "conflicting", untrusted: "not-approved", oversized: "too-large",
};

interface PlanSelected { id: string; version?: string; selection?: ResolvedSkill["selection"]; requiredBy: string[]; estimatedTokens?: number; category?: string; digest?: string }
interface PlanUnresolved { id: string; version?: string; state: RequestedState; code?: string; message?: string; action?: string; mandatory: boolean }

function readPlan(plan: unknown): { action?: RunSkillView["action"]; selected: PlanSelected[]; unresolved: PlanUnresolved[] } | undefined {
  const p = obj(plan);
  if (!p) return undefined;
  const selected = list(p.selected).flatMap((x): PlanSelected[] => {
    const o = obj(x);
    const id = idOf(o?.id);
    if (!o || !id) return [];
    return [{
      id, version: versionOf(o.version), selection: oneOf(o.selection, RESOLVE_REASONS),
      requiredBy: list(o.requiredBy).flatMap((r) => idOf(r) ?? []), estimatedTokens: tokensOf(o.estimatedTokens),
      category: categoryOf(o.category), digest: digestOf(o.digest),
    }];
  });
  const unresolved = list(p.unresolved).flatMap((x): PlanUnresolved[] => {
    const o = obj(x);
    const id = idOf(o?.id);
    const kind = oneOf(o?.kind, UNRESOLVED_KINDS);
    if (!o || !id || !kind) return [];
    return [{
      id, version: versionOf(o.version), state: STATE_OF_KIND[kind], code: oneOf(o.code, RESOLVE_REJECT_CODES),
      message: typeof o.message === "string" && o.message.length > 0 ? o.message.slice(0, MAX_TEXT) : undefined, action: oneOf(o.action, UNRESOLVED_ACTIONS), mandatory: o.mandatory === true,
    }];
  });
  return { action: oneOf(p.action, ["continue", "warn", "stop"] as const), selected, unresolved };
}

/** Context per `id@version`, from the sessions after the gate whose plan the lock belongs to. */
function contextOf(history: unknown[], planHash: string | undefined): Map<string, { context?: ContextState; step?: string; review?: true }> {
  const out = new Map<string, { context?: ContextState; step?: string; review?: true }>();
  if (!planHash) return out;
  let from = -1;
  history.forEach((r, i) => {
    const o = obj(r);
    if (o && !o.parent && typeof o.id === "string" && (SKILL_REQUEST_GATES as readonly string[]).includes(o.id) && o.ok === true && typeof o.output === "string" && planHashOf(o.output) === planHash) from = i;
  });
  if (from < 0) return out;
  for (const r of history.slice(from + 1)) {
    const o = obj(r);
    const sk = obj(o?.skills);
    const step = stepIdOf(o?.id);
    if (!sk || !step) continue;
    const loaded = list(sk.loaded).filter((k): k is string => typeof k === "string");
    const omitted = list(sk.omitted).filter((k): k is string => typeof k === "string");
    if (sk.role === "reviewer") {
      for (const k of loaded) out.set(k, { ...out.get(k), review: true });
      continue;
    }
    const state = sk.state === undefined ? "loaded" : oneOf(sk.state, ["loaded", "reloaded", "reused"] as const);
    if (state) for (const k of loaded) out.set(k, { ...out.get(k), context: state, step });
    for (const k of omitted) out.set(k, { ...out.get(k), context: "omitted", step });
  }
  return out;
}

const INTEGRITY_OF: Record<string, IntegrityState> = { changed: "changed", missing: "missing", unpinned: "unpinned", unapproved: "unapproved" };

/** The skills of a run for its page; undefined when the run has none to show. Never throws. */
export function runSkillView(s: RunSummary, opts: SkillViewOptions): RunSkillView | undefined {
  try {
    return build(s, opts);
  } catch {
    return undefined;
  }
}

function build(s: RunSummary, opts: SkillViewOptions): RunSkillView | undefined {
  const history = Array.isArray(s.history) ? s.history : [];
  const flowDef = obj(s.flowDef) ? s.flowDef : undefined;
  // Only a planned flow has a plan gate; an explicit flow names its skills and an off flow has none.
  const src = flowSkillSource(flowDef);
  const gate = (() => {
    try {
      return src.mode === "planned" ? planGateRecord({ history, flowDef }) : undefined;
    } catch {
      return undefined;
    }
  })();
  const plan = readPlan(s.skillPlan);
  const kept = obj(s.skillLock);
  const hasPlan = !!gate || src.mode === "explicit";
  if (!hasPlan && !plan && !kept) return undefined;

  // The plan is current when its gate is the last one.
  const planHash = src.mode === "explicit" ? src.planHash : gate ? planHashOf(gate.output) : undefined;
  // A plan that names its gate output belongs to it only when the hashes agree; an older plan has no hash and is taken as current.
  const planOwn = obj(s.skillPlan)?.planHash;
  const planCurrent = hasPlan && !!plan && (planOwn === undefined || planOwn === planHash);
  let request: ReturnType<typeof planSkillRequest>;
  try {
    request = src.mode === "explicit" ? src.request : gate ? planSkillRequest({ history, flowDef }) : undefined;
  } catch {
    request = undefined;
  }

  let read: RunSkillLockRead;
  try {
    read = typeof s.runDir === "string" ? (opts.readLock ?? readRunSkillLock)(s.runDir) : { ok: false, reason: "missing" };
  } catch {
    read = { ok: false, reason: "unreadable" };
  }

  let lock: RunSkillView["lock"];
  let planChanged = false;
  let locked: RunSkillLock | undefined;
  if (read.ok) {
    // The same checks as ensureSkillLock: a lock of an earlier plan needs a summary that matches it exactly.
    const l = read.lock;
    const sameLock = !!kept && kept.planHash === l.planHash && kept.lockDigest === read.lockDigest;
    const bad = l.runId !== s.runId
      || (hasPlan && l.planHash !== planHash ? !sameLock : !!kept && kept.planHash === l.planHash && kept.lockDigest !== read.lockDigest);
    if (bad) lock = "changed";
    else {
      lock = "ok";
      locked = read.lock;
      planChanged = hasPlan && read.lock.planHash !== planHash;
    }
  } else lock = read.reason === "missing" ? (kept ? "missing" : "none") : "changed";

  // The skills the run holds: the lock, else the summary of it, else the selection of the plan.
  const ctx = contextOf(history, locked?.planHash ?? (typeof kept?.planHash === "string" ? kept.planHash : undefined));
  let integrity = new Map<string, IntegrityState>();
  let registry: RegistryLike | undefined;
  let checkedAt: string | undefined;
  if (locked && locked.skills.length) {
    try {
      const got = opts.registry?.();
      if (got) {
        registry = got.registry;
        const problems = verifyRunSkillLock(locked, registry);
        integrity = new Map(problems.map((p) => [p.key, INTEGRITY_OF[p.code] ?? "unverified"] as const));
        if (typeof got.at === "number" && Number.isFinite(got.at)) checkedAt = new Date(got.at).toISOString();
      }
    } catch {
      registry = undefined;
      checkedAt = undefined;
    }
  }

  const rows: ResolvedSkill[] = [];
  if (locked) {
    for (const e of locked.skills) {
      const key = `${e.id}@${e.version}`;
      const known = registry?.byKey.get(key);
      const category = categoryOf(e.category) ?? (known && known.digest === e.digest ? categoryOf(known.pkg?.category) : undefined);
      rows.push({
        id: e.id, version: e.version, selection: e.selection, requiredBy: e.requiredBy, estimatedTokens: e.estimatedTokens,
        ...(category ? { category } : {}),
        ...(sentence(e.reason, 300) ? { reason: sentence(e.reason, 300) } : {}),
        ...(evidenceList(e.evidence) ? { evidence: evidenceList(e.evidence) } : {}),
        integrity: registry ? (integrity.get(key) ?? "verified") : "not-checked",
        ...(opts.admin ? { digest: e.digest, source: e.source } : {}),
      });
    }
  } else if (lock === "missing" || lock === "changed") {
    for (const x of list(kept?.skills)) {
      const o = obj(x);
      const id = idOf(o?.id);
      const version = versionOf(o?.version);
      if (!o || !id || !version) continue;
      const selection = oneOf(o.selection, RESOLVE_REASONS);
      rows.push({ id, version, ...(selection ? { selection } : {}), requiredBy: [], integrity: "not-checked", ...(opts.admin && digestOf(o.digest) ? { digest: digestOf(o.digest) } : {}) });
    }
  } else if (plan && planCurrent) {
    for (const x of plan.selected) {
      if (!x.version) continue;
      rows.push({
        id: x.id, version: x.version, ...(x.selection ? { selection: x.selection } : {}), requiredBy: x.requiredBy,
        ...(x.estimatedTokens !== undefined ? { estimatedTokens: x.estimatedTokens } : {}),
        ...(x.category ? { category: x.category } : {}), integrity: "not-locked", ...(opts.admin && x.digest ? { digest: x.digest } : {}),
      });
    }
  }
  if (lock === "ok" || lock === "missing" || lock === "changed") {
    for (const r of rows) {
      const c = lock === "ok" ? ctx.get(`${r.id}@${r.version}`) : undefined;
      if (c?.context) Object.assign(r, { context: c.context, ...(c.step ? { contextStep: c.step } : {}) });
      if (c?.review) r.review = true;
    }
  }

  const requested = requestedOf({ plan, planCurrent, request, rows, lock, planChanged, locked });

  const action = planCurrent ? plan?.action : undefined;
  const failed = planCurrent && (action === "stop" || action === "warn");
  if (!rows.length && !requested.length && !failed && lock !== "missing" && lock !== "changed") return undefined;

  const tokens = locked ? locked.estimatedTokens : rows.some((r) => r.estimatedTokens !== undefined) ? rows.reduce((n, r) => n + (r.estimatedTokens ?? 0), 0) : tokensOf(kept?.estimatedTokens);
  const view: RunSkillView = {
    lock,
    ...(planChanged ? { planChanged: true as const } : {}),
    ...(action ? { action } : {}),
    ...(tokens !== undefined && rows.length ? { estimatedTokens: tokens } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(opts.admin && locked?.commit ? { commit: locked.commit } : {}),
    requested,
    resolved: rows,
  };
  return hidePaths(view, s);
}

function requestedOf(i: {
  plan: ReturnType<typeof readPlan>;
  planCurrent: boolean;
  request: ReturnType<typeof planSkillRequest>;
  rows: ResolvedSkill[];
  lock: RunSkillView["lock"];
  planChanged: boolean;
  locked: RunSkillLock | undefined;
}): RequestedSkill[] {
  const out: RequestedSkill[] = [];
  const seen = new Set<string>();
  const add = (r: RequestedSkill) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  const plan = i.plan;
  const lockRows = i.lock === "ok" && !i.planChanged ? i.rows : [];
  const unresolved = (id: string) => plan?.unresolved.find((u) => u.id === id);
  const fromUnresolved = (u: PlanUnresolved, by: RequestedSkill["by"], extra: Partial<RequestedSkill> = {}): RequestedSkill => ({
    id: u.id, ...(u.version ? { version: u.version } : {}), by, state: u.state, ...extra,
    ...(u.code ? { code: u.code } : {}), ...(u.message ? { message: u.message } : {}), ...(u.action ? { action: u.action } : {}),
  });

  if (i.request) {
    for (const item of i.request.skills) {
      const id = idOf(item.id);
      if (!id) continue;
      const extra: Partial<RequestedSkill> = {
        ...(sentence(item.reason, 300) ? { reason: sentence(item.reason, 300) } : {}),
        ...(evidenceList(item.evidence) ? { evidence: evidenceList(item.evidence) } : {}),
      };
      const chosen = i.planCurrent ? plan?.selected.find((x) => x.id === id) : lockRows.find((x) => x.id === id);
      if (chosen) add({ id, ...(chosen.version ? { version: chosen.version } : {}), by: "plan", state: "selected", ...extra });
      else if (i.planCurrent && unresolved(id)) add(fromUnresolved(unresolved(id)!, "plan", extra));
      else add({ id, by: "plan", state: "not-checked", ...extra });
    }
  } else {
    // No current request: what the run holds and what the plan could not use, as they were.
    for (const r of i.rows) if (r.selection === "requested") add({ id: r.id, version: r.version, by: "plan", state: "selected", ...(r.reason ? { reason: r.reason } : {}), ...(r.evidence ? { evidence: r.evidence } : {}) });
    for (const u of plan?.unresolved ?? []) if (!u.mandatory) add(fromUnresolved(u, "plan"));
  }

  // Skills the administrator always includes. A new plan lists them itself; an old plan does not say, so the lock does.
  const usePlan = i.planCurrent && !!plan && (plan.selected.length === 0 || plan.selected.some((x) => x.selection !== undefined));
  const mandatory = usePlan ? plan!.selected.filter((x) => x.selection === "mandatory") : i.rows.filter((r) => r.selection === "mandatory");
  for (const m of mandatory) add({ id: m.id, ...(m.version ? { version: m.version } : {}), by: "administrator", state: "selected" });
  for (const u of plan?.unresolved ?? []) if (u.mandatory) add(fromUnresolved(u, "administrator"));
  return out;
}
