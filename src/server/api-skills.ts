import { z } from "zod";
import { StoreError } from "../auth/store.js";
import { effectiveLifecycle, LIFECYCLE_STATES, lifecycleReasonProblem, RUN_ID_RE } from "../skills/lifecycle.js";
import { parseSkillKey } from "../skills/lock.js";
import { applyAllowance, applyTransition, type ApplyFail } from "../skills/lifecycle-cli.js";
import { clearSkillRegistryCache, discoverSkills } from "../skills/registry.js";
import { HttpError, readJson, send } from "./http.js";
import type { Route } from "./server.js";

// Admin routes for the skill lifecycle. The checks are the ones of `scf skills lifecycle` and `scf skills allow-run`.

const Key = z.string().refine((k) => parseSkillKey(k) !== undefined, "not a skill key (expected id@version)");
const Reason = z.string().refine((r) => lifecycleReasonProblem(r) === undefined, "not a valid reason (1-200 characters, trimmed, no control characters, no credential)");
const Transition = z.object({ key: Key, state: z.enum(LIFECYCLE_STATES), reason: Reason, replacement: Key.optional() }).strict();
const Allowance = z.object({ runId: z.string().regex(RUN_ID_RE, "not a run id"), key: Key, reason: Reason }).strict();

const STATUS: Record<ApplyFail["status"], number> = {
  unknown: 404,
  "no-run": 404,
  "bad-input": 400,
  unapproved: 409,
  "release-revoked": 409,
  "bad-replacement": 409,
  "not-locked": 409,
  "bad-transition": 409,
  "not-quarantined": 409,
  full: 409,
  unreadable: 409,
};

function body<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, "invalid body", undefined, { issues: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}

/** A locked data folder answers 503; any other write problem is not described to the caller. */
function storeFailure(e: unknown): never {
  if (e instanceof StoreError && e.kind === "locked") throw new HttpError(503, "the data folder is busy; try again");
  throw e;
}

export const skillRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "skills" || seg[1] !== "lifecycle") return false;
  const reg = () => discoverSkills(ctx.config().skills);
  if (!seg[2] && method === "GET") {
    const r = reg();
    const keys = [...new Set([...(r.lifecycle?.keys() ?? []), ...(r.revoked?.keys() ?? [])])].sort();
    const states = keys.flatMap((key) => {
      const e = effectiveLifecycle(r, key);
      return e ? [{ key, ...e }] : [];
    });
    const problem = r.problems.find((p) => p.kind === "lifecycle")?.reason;
    return send(res, 200, { states, ...(problem ? { problem } : {}) }), true;
  }
  if (!seg[2] && method === "POST") {
    const b = body(Transition, await readJson(req));
    try {
      const r = applyTransition(reg(), { ...b, by: user.id, runsDir: ctx.opts.runsDir, waitMs: 0 });
      if (r.status !== "ok") throw new HttpError(STATUS[r.status], r.reason);
      clearSkillRegistryCache();
      return send(res, 200, { transition: r.transition, lockedRuns: r.lockedRuns }), true;
    } catch (e) {
      return storeFailure(e);
    }
  }
  if (seg[2] === "allow-run" && !seg[3] && method === "POST") {
    const b = body(Allowance, await readJson(req));
    try {
      const r = applyAllowance(reg(), { ...b, by: user.id, runsDir: ctx.opts.runsDir, waitMs: 0 });
      if (r.status !== "ok") throw new HttpError(STATUS[r.status], r.reason);
      clearSkillRegistryCache();
      return send(res, 200, { allowance: r.allowance, added: r.added }), true;
    } catch (e) {
      return storeFailure(e);
    }
  }
  return false;
};
