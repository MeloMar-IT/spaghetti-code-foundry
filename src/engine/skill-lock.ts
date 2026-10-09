import { execFileSync } from "node:child_process";
import type { SkillsConfig } from "../config.js";
import { discoverSkills, type SkillRegistry } from "../skills/registry.js";
import { renderSkillPayload, type PayloadSkill, type SkillPayload } from "../skills/payload.js";
import { planGateRecord, planSkillRequest } from "../skills/request.js";
import { resolveOptionsFrom, resolveSkills } from "../skills/resolve.js";
import {
  buildRunSkillLock, integrityReason, planHashOf, readRunSkillLock, runSkillLockSummary, verifyRunSkillLock, writeRunSkillLock,
  type RunSkillLock,
} from "../skills/run-lock.js";
import type { Engine } from "./execute.js";

// The skill lock of a run, made at the first agent step after a checked plan and verified before every agent session.
// The file <runDir>/skill-lock.json is the authority; summary.skillLock is a copy that is repaired from it.

export const SKILL_INTEGRITY_PREFIX = "skill integrity: ";
export const SKILL_BLOCKED_PREFIX = "skill selection is blocked: ";
export const SKILL_LOCK_CHANGED = "skill integrity: the skill lock of this run is missing or was changed";
const NOT_WRITTEN = "skill integrity: the skill lock of this run could not be written";

type Discover = (skills: SkillsConfig) => Pick<SkillRegistry, "skills" | "byKey" | "problems">;
/** What `ensure` hands back besides the verdict: the lock of the current plan and the registry it was checked against. */
interface EnsureOut {
  lock?: RunSkillLock;
  reg?: ReturnType<Discover>;
}
export interface SkillLockDeps {
  discover?: Discover;
  now?: Date;
  /** The commit of the workspace; default `git rev-parse HEAD` there. */
  commitOf?: (workdir: string) => string | undefined;
}

function headCommit(workdir: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Undefined: go on. A string: the reason the agent session must not start. Synchronous; never throws. */
export function ensureSkillLock(engine: Pick<Engine, "summary" | "config" | "log" | "save">, deps: SkillLockDeps = {}): string | undefined {
  try {
    return ensure(engine, deps);
  } catch {
    return NOT_WRITTEN;
  }
}

function verifyLock(engine: Pick<Engine, "config" | "log">, lock: RunSkillLock, discover: Discover, out?: EnsureOut): string | undefined {
  if (lock.skills.length === 0) {
    if (out) out.lock = lock;
    return undefined;
  }
  const reg = discover(engine.config.skills);
  const problems = verifyRunSkillLock(lock, reg);
  for (const p of problems) engine.log(`    ! ${integrityReason(p)}`);
  if (problems.length) return integrityReason(problems[0]!);
  if (out) {
    out.lock = lock;
    out.reg = reg;
  }
  engine.log(`    · skill lock: verified ${lock.skills.length} skill${lock.skills.length === 1 ? "" : "s"}`);
  return undefined;
}

function ensure(engine: Pick<Engine, "summary" | "config" | "log" | "save">, deps: SkillLockDeps, out?: EnsureOut): string | undefined {
  const s = engine.summary;
  const gate = planGateRecord({ history: s.history ?? [], flowDef: s.flowDef });
  const discover: Discover = deps.discover ?? ((skills) => discoverSkills(skills));
  const read = readRunSkillLock(s.runDir);
  const kept = s.skillLock;

  // No current gate (no plan yet, or being planned again): nothing is made, but a lock that exists is still verified.
  if (!gate) {
    if (!read.ok) return read.reason === "missing" && !kept ? undefined : SKILL_LOCK_CHANGED;
    if (read.lock.runId !== s.runId || (kept && kept.planHash === read.lock.planHash && kept.lockDigest !== read.lockDigest)) return SKILL_LOCK_CHANGED;
    return verifyLock(engine, read.lock, discover);
  }
  const planHash = planHashOf(gate.output);

  if (read.ok && read.lock.planHash === planHash) {
    // The lock of this plan: it is never resolved again. A summary of this plan must match the file exactly;
    // only a missing summary or one of an older plan (a crash between the two writes) is made again from the file.
    if (read.lock.runId !== s.runId) return SKILL_LOCK_CHANGED;
    if (kept && kept.planHash === planHash && kept.lockDigest !== read.lockDigest) return SKILL_LOCK_CHANGED;
    const want = runSkillLockSummary(read.lock, read.lockDigest);
    if (JSON.stringify(kept) !== JSON.stringify(want)) {
      if (kept) engine.log("    · skill lock: the summary in run.json was of an older plan; it was made again from the lock file");
      s.skillLock = want;
      engine.save();
    }
    return verifyLock(engine, read.lock, discover, out);
  }
  // A lock of an earlier plan, or none: a new one may be made only when the run really planned again (or never locked).
  if (read.ok) {
    if (!kept || kept.planHash !== read.lock.planHash || kept.lockDigest !== read.lockDigest) return SKILL_LOCK_CHANGED;
  } else if (read.reason !== "missing") {
    return SKILL_LOCK_CHANGED;
  } else if (kept && kept.planHash === planHash) {
    return SKILL_LOCK_CHANGED; // this plan was locked and the file is gone
  }

  // Make the lock.
  try {
    const request = planSkillRequest({ history: s.history, flowDef: s.flowDef });
    if (!request) return undefined;
    const reg = discover(engine.config.skills);
    const resolution = resolveSkills(reg, request.skills.map((i) => i.id), { role: "coder", ...resolveOptionsFrom(engine.config.skills) });
    if (!resolution.ok) {
      const bad = resolution.decisions.find((d) => d.mandatory && d.outcome === "rejected" && d.code !== "blocked") ?? resolution.decisions.find((d) => d.mandatory && d.outcome === "rejected");
      return resolution.policyErrors > 0 || !bad
        ? `${SKILL_BLOCKED_PREFIX}the skills.selection lists are not valid`
        : `${SKILL_BLOCKED_PREFIX}${bad.id} (${bad.code})`;
    }
    for (const d of resolution.decisions) if (d.outcome === "rejected" && !d.mandatory) engine.log(`    · skill lock: ${d.id} left out: ${d.code}`);
    const commit = (deps.commitOf ?? headCommit)(s.workdir ?? "") ?? undefined;
    const built = buildRunSkillLock({
      runId: s.runId,
      resolution,
      request,
      sourceOf: (id, version) => (reg.byKey.get(`${id}@${version}`)?.source === "builtin" ? "builtin" : "admin"),
      planHash,
      commit: s.workdir ? commit : undefined,
      now: deps.now,
    });
    const { lockDigest } = writeRunSkillLock(s.runDir, built);
    s.skillLock = runSkillLockSummary(built, lockDigest);
    engine.save();
    engine.log(
      built.skills.length === 0
        ? "    · skill lock: no skills"
        : `    · skill lock: ${built.skills.map((k) => `${k.id}@${k.version}`).join(", ")} (about ${built.estimatedTokens} tokens)`,
    );
    if (out) {
      out.lock = built;
      out.reg = reg;
    }
    return undefined;
  } catch {
    return NOT_WRITTEN;
  }
}

export type SkillSession = { refused: string } | { payload?: SkillPayload };

/** The skill check before a session of this agent, plus, for Claude, the payload of the lock of the current plan. Synchronous; never throws. */
export function skillSession(engine: Pick<Engine, "summary" | "config" | "log" | "save">, agent: "claude" | "codex", deps: SkillLockDeps = {}): SkillSession {
  try {
    if (agent !== "claude") {
      const r = ensureSkillLock(engine, deps);
      return r ? { refused: r } : {};
    }
    const out: EnsureOut = {};
    const refused = ensure(engine, deps, out);
    if (refused) return { refused };
    if (!out.lock) return {};
    const list: PayloadSkill[] = [];
    for (const e of out.lock.skills) {
      const key = `${e.id}@${e.version}`;
      const pkg = out.reg?.byKey.get(key)?.pkg;
      if (!pkg) return { refused: integrityReason({ key, code: "missing", expected: e.digest }) };
      list.push({ id: e.id, version: e.version, digest: e.digest, selection: e.selection, requiredBy: e.requiredBy, description: pkg.description, instructions: pkg.instructions });
    }
    const payload = renderSkillPayload(list, { maxTokens: engine.config.skills.selection.max_tokens });
    if (payload.blocked) return { refused: `${SKILL_BLOCKED_PREFIX}${payload.blocked} does not fit the skill context budget (skills.selection.max_tokens)` };
    for (const k of payload.omitted) engine.log(`    ! skill context: ${k} left out: over budget`);
    return { payload };
  } catch {
    return { refused: NOT_WRITTEN };
  }
}
