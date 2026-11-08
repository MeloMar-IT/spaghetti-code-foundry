import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allRunsDirs, runDirOf, runFile } from "../engine/state.js";
import { DEFAULT_WORKSPACE, validWorkspaceId } from "../workspaces/list.js";
import {
  effectiveLifecycle, INELIGIBLE_STATES, LIFECYCLE_STATES, readSkillLifecycle, recordLifecycleTransition, recordRunAllowance, RUN_ID_RE,
  type AllowRunLine, type SkillLifecycleState, type TransitionLine,
} from "./lifecycle.js";
import { parseSkillKey } from "./lock.js";
import type { SkillRegistry } from "./registry.js";
import { readRunSkillLock, RUN_SKILL_LOCK_FILE } from "./run-lock.js";

// `scf skills lifecycle` and `scf skills allow-run`. The apply functions return status unions and are shared with the admin API,
// so both apply the same checks. The command functions print.

export interface LockedRun {
  runId: string;
  effect: string;
}

type Reg = Pick<SkillRegistry, "byKey" | "problems" | "lifecycle" | "revoked">;

/**
 * One folder per run id over the runs folder and every workspace runs folder (#825). The first folder with a run.json wins (as runDirOf does);
 * a folder with only a skill lock counts only when no folder has a run.json for that id. `unreadable` when a folder fails to list (not ENOENT).
 */
export function chosenRunDirs(runsDir: string): { dirs: Map<string, string>; unreadable: boolean } {
  const primary = new Map<string, string>();
  const fallback = new Map<string, string>();
  let unreadable = false;
  for (const folder of allRunsDirs(runsDir)) {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const dir = join(folder, d.name);
      if (existsSync(runFile(dir))) {
        if (!primary.has(d.name)) primary.set(d.name, dir);
      } else if (existsSync(join(dir, RUN_SKILL_LOCK_FILE)) && !fallback.has(d.name)) fallback.set(d.name, dir);
    }
  }
  return { dirs: new Map([...fallback, ...primary]), unreadable };
}

/** The folder of a run for its lock: the run's own folder (runDirOf), else the first folder holding only a skill lock. */
function lockRunDir(runsDir: string, runId: string): string | undefined {
  const own = runDirOf(runsDir, runId);
  if (own) return own;
  return allRunsDirs(runsDir).map((f) => join(f, runId)).find((d) => existsSync(join(d, RUN_SKILL_LOCK_FILE)));
}

/** The workspace a run belongs to, from its run.json; `default` when absent, unreadable or not valid. */
function runWorkspace(runDir: string | undefined): string {
  if (!runDir) return DEFAULT_WORKSPACE;
  try {
    const ws = (JSON.parse(readFileSync(runFile(runDir), "utf8")) as { workspace?: unknown }).workspace;
    return validWorkspaceId(ws) ? ws : DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/** The runs, in the runs folder and every workspace runs folder, whose skill lock holds `key`, sorted. `unreadable` when a folder cannot be listed. */
export function runsLocking(runsDir: string, key: string): { runs: string[]; unreadable: boolean } {
  const { dirs, unreadable } = chosenRunDirs(runsDir);
  const runs: string[] = [];
  for (const [id, dir] of dirs) {
    const r = readRunSkillLock(dir);
    if (r.ok && r.lock.skills.some((s) => `${s.id}@${s.version}` === key)) runs.push(id);
  }
  return { runs: runs.sort(), unreadable };
}

export type ApplyFail = {
  status: "unknown" | "unapproved" | "release-revoked" | "bad-replacement" | "no-run" | "not-locked" | "bad-input" | "bad-transition" | "not-quarantined" | "full" | "unreadable";
  reason: string;
};

const EFFECT: Record<SkillLifecycleState, string> = {
  active: "goes on",
  deprecated: "goes on; a note is logged",
  quarantined: "stops at its next agent step unless allowed with scf skills allow-run",
  retired: "goes on; a note is logged",
  revoked: "stops at its next agent step",
};

const lifecycleProblem = (reg: Reg): ApplyFail | undefined => {
  const p = reg.problems.find((x) => x.kind === "lifecycle");
  return p ? { status: "unreadable", reason: p.reason } : undefined;
};

const releaseRevoked = (reg: Reg, key: string): ApplyFail | undefined => {
  const rel = reg.revoked?.get(key);
  return rel ? { status: "release-revoked", reason: `${key} is revoked by release ${rel.by}` } : undefined;
};

export function applyTransition(
  reg: Reg,
  i: { key: string; state: string; reason: string; replacement?: string; by: string; runsDir: string; waitMs?: number },
): { status: "ok"; transition: TransitionLine; lockedRuns: LockedRun[] } | ApplyFail {
  const state = i.state as SkillLifecycleState;
  if (!parseSkillKey(i.key)) return { status: "bad-input", reason: "not a skill key (expected id@version)" };
  if (!LIFECYCLE_STATES.includes(state)) return { status: "bad-input", reason: `the state must be one of ${LIFECYCLE_STATES.join(", ")}` };
  const broken = lifecycleProblem(reg);
  if (broken) return broken;
  const revoked = releaseRevoked(reg, i.key);
  if (revoked) return revoked;
  const s = reg.byKey.get(i.key);
  if (!s) return { status: "unknown", reason: `${i.key} is not installed` };
  if (s.trust === "unapproved") return { status: "unapproved", reason: `${i.key} comes from the repository; only approved and built-in skills have a lifecycle` };
  if (i.replacement !== undefined) {
    if (!parseSkillKey(i.replacement)) return { status: "bad-input", reason: "the replacement is not a skill key (expected id@version)" };
    const r = reg.byKey.get(i.replacement);
    const eff = r ? effectiveLifecycle(reg, i.replacement) : undefined;
    if (!r || r.trust === "unapproved" || reg.revoked?.has(i.replacement) || (eff && INELIGIBLE_STATES.has(eff.state))) {
      return { status: "bad-replacement", reason: `the replacement ${i.replacement} must be an installed, approved version that is not quarantined, retired or revoked` };
    }
  }
  const w = recordLifecycleTransition({ key: i.key, to: state, reason: i.reason, ...(i.replacement ? { replacement: i.replacement } : {}), by: i.by, ...(i.waitMs !== undefined ? { waitMs: i.waitMs } : {}) });
  if (w.status !== "ok") return { status: w.status, reason: w.reason };
  const effect = EFFECT[state];
  return { status: "ok", transition: w.line, lockedRuns: runsLocking(i.runsDir, i.key).runs.map((runId) => ({ runId, effect })) };
}

export function applyAllowance(
  regOf: Reg | ((workspace: string) => Reg),
  i: { runId: string; key: string; reason: string; by: string; runsDir: string; waitMs?: number },
): { status: "ok"; allowance: AllowRunLine; added: boolean } | ApplyFail {
  if (!RUN_ID_RE.test(i.runId)) return { status: "bad-input", reason: "not a run id" };
  if (!parseSkillKey(i.key)) return { status: "bad-input", reason: "not a skill key (expected id@version)" };
  // The registry of the run's own workspace (#825); a run that is not found is checked against the default one.
  const dir = lockRunDir(i.runsDir, i.runId);
  const reg = typeof regOf === "function" ? regOf(runWorkspace(dir)) : regOf;
  const broken = lifecycleProblem(reg);
  if (broken) return broken;
  const revoked = releaseRevoked(reg, i.key);
  if (revoked) return revoked;
  const lock = dir ? readRunSkillLock(dir) : undefined;
  if (!lock || !lock.ok || lock.lock.runId !== i.runId) return { status: "no-run", reason: `no run ${i.runId} with a skill lock was found` };
  if (!lock.lock.skills.some((s) => `${s.id}@${s.version}` === i.key)) return { status: "not-locked", reason: `run ${i.runId} does not lock ${i.key}` };
  const w = recordRunAllowance({ key: i.key, runId: i.runId, reason: i.reason, by: i.by, ...(i.waitMs !== undefined ? { waitMs: i.waitMs } : {}) });
  if (w.status !== "ok") return { status: w.status, reason: w.reason };
  return { status: "ok", allowance: w.line, added: w.added };
}

const plain = (reason: string) => reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

export function lifecycleCommand(
  operands: string[],
  values: { reason?: string; replacement?: string },
  out: (line: string) => void,
  o: { reg: Reg; runsDir: string; home: string },
): number {
  const broken = lifecycleProblem(o.reg);
  if (broken) {
    out(`PROBLEM ${broken.reason}`);
    return 1;
  }
  const [key, state] = operands;
  if (key === undefined) return listLifecycle(o.reg, out);
  if (state === undefined) return history(key, o.reg, o.home, out);
  const r = applyTransition(o.reg, { key, state, reason: values.reason ?? "", replacement: values.replacement, by: "cli", runsDir: o.runsDir });
  if (r.status !== "ok") {
    out(`PROBLEM ${plain(r.reason)}`);
    return 1;
  }
  out(`${key}: ${r.transition.from} → ${r.transition.to} (#${r.transition.seq})`);
  for (const l of r.lockedRuns) out(`RUN ${l.runId} locks ${key}: ${l.effect}`);
  out("OK");
  return 0;
}

function listLifecycle(reg: Reg, out: (line: string) => void): number {
  const keys = [...new Set([...(reg.lifecycle?.keys() ?? []), ...(reg.revoked?.keys() ?? [])])].sort();
  let n = 0;
  for (const key of keys) {
    const e = effectiveLifecycle(reg, key);
    if (!e) continue;
    n++;
    const by = e.release ? `release ${e.release}` : e.by;
    const runs = e.allowedRuns.length ? `, ${e.allowedRuns.length} run${e.allowedRuns.length === 1 ? "" : "s"} allowed` : "";
    out(`LIFECYCLE ${key} ${e.state} since ${e.since} by ${by}: ${plain(e.reason)}${e.replacement ? ` replaced by ${e.replacement}` : ""}${runs}`);
  }
  if (!n) out("No skill has a lifecycle state");
  return 0;
}

function history(key: string, reg: Reg, home: string, out: (line: string) => void): number {
  if (!parseSkillKey(key)) {
    out("PROBLEM not a skill key (expected id@version)");
    return 1;
  }
  const rec = readSkillLifecycle(home);
  if (!rec.ok) {
    out(`PROBLEM the skill lifecycle record ${rec.reason}`);
    return 1;
  }
  let n = 0;
  for (const l of rec.lines) {
    if (l.key !== key) continue;
    n++;
    if (l.type === "transition") out(`#${l.seq} ${l.at} ${l.by} ${l.from} → ${l.to}: ${plain(l.reason)}${l.replacement ? ` replaced by ${l.replacement}` : ""}`);
    else out(`#${l.seq} ${l.at} ${l.by} allow-run ${l.runId}: ${plain(l.reason)}`);
  }
  const rel = reg.revoked?.get(key);
  if (rel) {
    n++;
    out(`release ${rel.by} revoked ${rel.on}: ${plain(rel.reason)}`);
  }
  if (!n) out(`No lifecycle history for ${key}`);
  return 0;
}

export function allowRunCommand(
  operands: string[],
  values: { reason?: string },
  out: (line: string) => void,
  o: { reg: Reg | ((workspace: string) => Reg); runsDir: string; home: string },
): number {
  const [runId, key] = operands;
  const r = applyAllowance(o.reg, { runId: runId ?? "", key: key ?? "", reason: values.reason ?? "", by: "cli", runsDir: o.runsDir });
  if (r.status !== "ok") {
    out(`PROBLEM ${plain(r.reason)}`);
    return 1;
  }
  out(`ALLOWED ${runId} ${key} (${r.added ? "" : "already, "}#${r.allowance.seq}). Resume the run to go on.`);
  return 0;
}
