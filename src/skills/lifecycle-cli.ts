import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveLifecycle, INELIGIBLE_STATES, LIFECYCLE_STATES, readSkillLifecycle, recordLifecycleTransition, recordRunAllowance, RUN_ID_RE,
  type AllowRunLine, type SkillLifecycleState, type TransitionLine,
} from "./lifecycle.js";
import { parseSkillKey } from "./lock.js";
import type { SkillRegistry } from "./registry.js";
import { readRunSkillLock } from "./run-lock.js";

// `scf skills lifecycle` and `scf skills allow-run`. The apply functions return status unions and are shared with the admin API,
// so both apply the same checks. The command functions print.

export interface LockedRun {
  runId: string;
  effect: string;
}

type Reg = Pick<SkillRegistry, "byKey" | "problems" | "lifecycle" | "revoked">;

/** The runs in `runsDir` whose skill lock holds `key`, sorted. `unreadable` when the folder cannot be listed. */
export function runsLocking(runsDir: string, key: string): { runs: string[]; unreadable: boolean } {
  const runs: string[] = [];
  let unreadable = false;
  try {
    for (const d of readdirSync(runsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const r = readRunSkillLock(join(runsDir, d.name));
      if (r.ok && r.lock.skills.some((s) => `${s.id}@${s.version}` === key)) runs.push(d.name);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
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
  reg: Reg,
  i: { runId: string; key: string; reason: string; by: string; runsDir: string; waitMs?: number },
): { status: "ok"; allowance: AllowRunLine; added: boolean } | ApplyFail {
  if (!RUN_ID_RE.test(i.runId)) return { status: "bad-input", reason: "not a run id" };
  if (!parseSkillKey(i.key)) return { status: "bad-input", reason: "not a skill key (expected id@version)" };
  const broken = lifecycleProblem(reg);
  if (broken) return broken;
  const revoked = releaseRevoked(reg, i.key);
  if (revoked) return revoked;
  const lock = readRunSkillLock(join(i.runsDir, i.runId));
  if (!lock.ok || lock.lock.runId !== i.runId) return { status: "no-run", reason: `no run ${i.runId} with a skill lock was found` };
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
  o: { reg: Reg; runsDir: string; home: string },
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
