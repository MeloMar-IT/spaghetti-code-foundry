import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Boundary, Conditions, PolicyPack } from "../../src/policy/schema.js";

/** A false condition on a fact: the rule never applies, but a rule that names a missing fact is "input-incomplete". */
const NEVER: Conditions = {
  flow: { in: ["__never__"] },
  step: { in: ["__never__"] },
  repository: { in: ["__never__/__never__"] },
  workspace: { in: ["empty"] },
  owner: { in: ["user"] },
  branch: { in: ["__never__"] },
  credential: { in: ["repository"] },
  elapsedMs: { over: 1e12 },
  stepCostUsd: { over: 1e12 },
  runCostUsd: { over: 1e12 },
  isolated: true,
  sandboxed: true,
};

/** The rule id of the rule that decides when a boundary got every fact it should. */
export const okRule = (boundary: Boundary): string => `${boundary.replace(/\./g, "-")}-ok`;
export const checkRule = (boundary: Boundary): string => `${boundary.replace(/\./g, "-")}-check`;

/** Per boundary: the facts it promises, and the conditions those facts must meet. */
export const COVER: Record<Boundary, { needs: (keyof Conditions)[]; ok: Conditions }> = {
  "run.start": { needs: ["flow", "workspace", "owner"], ok: { flow: { in: ["cover"] }, workspace: { in: ["inplace"] }, owner: { notIn: ["user"] } } },
  "step.before": { needs: ["flow", "step"], ok: { step: { in: ["*"] } } },
  "step.after": { needs: ["step", "elapsedMs", "runCostUsd"], ok: { step: { in: ["*"] } } },
  // asked for the run's workspace (no step, no sign-in) and for every step
  "repository.access": { needs: ["credential"], ok: { credential: { in: ["machine", "none"] } } },
  push: { needs: ["step", "credential", "isolated", "branch"], ok: { credential: { in: ["machine"] }, isolated: false, branch: { in: ["feat*"] } } },
  "agent.write": { needs: ["step", "isolated", "sandboxed"], ok: { isolated: false, sandboxed: false } },
  "approval.consume": { needs: ["step"], ok: { step: { in: ["ok"] } } },
  "run.complete": { needs: ["runCostUsd"], ok: {} },
};

/** A pack with, for every boundary, a rule that names the facts promised there (it applies to nothing when they are all there) and a rule that holds for them. */
export function coverPack(id = "cover", version = "1"): PolicyPack {
  const rules: PolicyPack["rules"] = [];
  for (const [boundary, spec] of Object.entries(COVER) as [Boundary, (typeof COVER)[Boundary]][]) {
    const when: Conditions = {};
    for (const name of spec.needs) Object.assign(when, { [name]: NEVER[name] });
    rules.push({ id: checkRule(boundary), boundaries: [boundary], when, outcome: "deny", reasonCode: "output.limit-exceeded" });
    rules.push({ id: okRule(boundary), boundaries: [boundary], when: spec.ok, outcome: "warn", reasonCode: "output.limit-exceeded" });
  }
  return { version: 1, policy: { id, version }, mode: "observe", defaultOutcome: "allow", rules };
}

/** Writes a valid pack to `target` and links <home>/policies/<id>.json to it. */
export function linkPack(home: string, id: string, target: string): void {
  mkdirSync(join(home, "policies"), { recursive: true });
  writeFileSync(target, JSON.stringify(coverPack(id)));
  symlinkSync(target, join(home, "policies", `${id}.json`));
}

/** Writes <home>/policies/<id>.json. */
export function writePack(home: string, id: string, pack: unknown): void {
  mkdirSync(join(home, "policies"), { recursive: true });
  writeFileSync(join(home, "policies", `${id}.json`), typeof pack === "string" ? pack : JSON.stringify(pack));
}
