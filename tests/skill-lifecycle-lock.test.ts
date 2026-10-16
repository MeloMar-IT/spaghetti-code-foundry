import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { ensureSkillLock, skillSession } from "../src/engine/skill-lock.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import type { SkillLifecycleStatus, SkillReleaseRevocation } from "../src/skills/lifecycle.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import {
  RUN_SKILL_LOCK_FILE, RunSkillLockSchema, integrityReason, runSkillLockNotes, runSkillLockReasons, verifyRunSkillLock, type RunSkillLock,
} from "../src/skills/run-lock.js";

// The lifecycle policy for runs that already lock a version: revoked always stops, quarantined stops unless this run is allowed,
// deprecated and retired go on with a note. A lifecycle problem of the registry comes first.

const digest = `sha256:${"a".repeat(64)}`;
const K = "kafka@1.0.0";
const RUN = "run-1";
const status = (state: SkillLifecycleStatus["state"], o: { replacement?: string; reason?: string; allowed?: string[] } = {}): SkillLifecycleStatus => ({
  state, seq: 3, since: "2026-01-01T00:00:00.000Z", by: "cli", reason: o.reason ?? "because",
  ...(o.replacement ? { replacement: o.replacement } : {}),
  allowedRuns: (o.allowed ?? []).map((runId, i) => ({ seq: 4 + i, runId, at: "2026-01-02T00:00:00.000Z", by: "cli", reason: "ok" })),
});
const skill = (id = "kafka", d = digest, pin = "pinned") =>
  ({ key: `${id}@1.0.0`, id, version: "1.0.0", source: "admin", label: "x", dir: "/d", active: true, trust: "approved", pin, digest: d,
    pkg: { id, version: "1.0.0", description: "About.", instructions: "Do it.", roles: [], dependencies: [], conflicts: [] } }) as unknown as RegisteredSkill;
interface RegOver { skills?: RegisteredSkill[]; lifecycle?: [string, SkillLifecycleStatus][]; revoked?: [string, SkillReleaseRevocation][]; lifeProblem?: boolean }
const reg = (o: RegOver = {}) => {
  const skills = o.skills ?? [skill()];
  return {
    skills, byKey: new Map(skills.map((s) => [s.key, s])),
    problems: o.lifeProblem ? [{ kind: "lifecycle" as const, source: "admin" as const, label: "skill lifecycle", root: "x", reason: "bad" }] : [],
    lifecycle: new Map(o.lifecycle ?? []), revoked: new Map(o.revoked ?? []),
  };
};
const lockOf = (keys = [K], runId = RUN): RunSkillLock =>
  RunSkillLockSchema.parse({
    version: 1, runId, createdAt: "2026-01-01T00:00:00.000Z", planHash: digest, estimatedTokens: 10,
    skills: keys.map((k) => ({ id: k.split("@")[0], version: "1.0.0", digest, source: "admin", role: "coder", selection: "requested", requiredBy: [], estimatedTokens: 5 })),
  });
const REL: [string, SkillReleaseRevocation] = [K, { by: "acme@1.0.0", on: "2026-03-04", reason: "usage limit reached" }];
const codes = (r: ReturnType<typeof reg>, lock = lockOf()) => verifyRunSkillLock(lock, r).map((p) => p.code);

describe("verifyRunSkillLock with a lifecycle", () => {
  it("stops a locally revoked version, and says to plan again", () => {
    const r = reg({ lifecycle: [[K, status("revoked", { replacement: "kafka@2.0.0" })]] });
    const [p] = verifyRunSkillLock(lockOf(), r);
    expect(p).toMatchObject({ code: "revoked", replacement: "kafka@2.0.0" });
    expect(integrityReason(p!)).toContain("plan the issue again");
    expect(integrityReason(p!)).toContain("(replaced by kafka@2.0.0)");
  });

  it("calls a key revoked by a release revoked, not missing, and names the release", () => {
    const r = reg({ skills: [], revoked: [REL] });
    const [p] = verifyRunSkillLock(lockOf(), r);
    expect(p!.code).toBe("revoked");
    expect(integrityReason(p!)).toContain("by release acme@1.0.0");
  });

  it("lets a release revocation win over a local quarantine, replacement kept, allowance useless", () => {
    const r = reg({ skills: [], revoked: [REL], lifecycle: [[K, status("quarantined", { replacement: "kafka@2.0.0", allowed: [RUN] })]] });
    const [p] = verifyRunSkillLock(lockOf(), r);
    expect(p!.code).toBe("revoked");
    expect(integrityReason(p!)).toContain("(replaced by kafka@2.0.0)");
    expect(codes(reg({ revoked: [REL], lifecycle: [[K, status("quarantined", { allowed: [RUN] })]] }))).toEqual(["revoked"]);
  });

  it("stops a quarantined version with the allow-run command, unless this run is allowed", () => {
    const [p] = verifyRunSkillLock(lockOf(), reg({ lifecycle: [[K, status("quarantined")]] }));
    expect(p).toMatchObject({ code: "quarantined", runId: RUN });
    expect(integrityReason(p!)).toContain(`scf skills allow-run ${RUN} ${K}`);
    expect(codes(reg({ lifecycle: [[K, status("quarantined", { allowed: [RUN] })]] }))).toEqual([]);
    expect(codes(reg({ lifecycle: [[K, status("quarantined", { allowed: ["run-2"] })]] }))).toEqual(["quarantined"]);
  });

  it("lets deprecated and retired versions go on, with a note that names the replacement", () => {
    for (const state of ["deprecated", "retired"] as const) {
      const r = reg({ lifecycle: [[K, status(state, { replacement: "kafka@2.0.0" })]] });
      expect(codes(r)).toEqual([]);
      expect(runSkillLockNotes(lockOf(), r)).toEqual([`skill lifecycle: ${K} is ${state} (replaced by kafka@2.0.0); this run goes on with it`]);
    }
    const allowed = reg({ lifecycle: [[K, status("quarantined", { allowed: [RUN] })]] });
    expect(runSkillLockNotes(lockOf(), allowed)).toEqual([`skill lifecycle: ${K} is quarantined; this run is allowed (#4 by cli)`]);
    expect(runSkillLockNotes(lockOf(), reg())).toEqual([]);
  });

  it("puts a lifecycle problem first, before every other problem", () => {
    const other = lockOf(["other@1.0.0", K]);
    const cases: Record<string, ReturnType<typeof reg>> = {
      missing: reg({ lifeProblem: true, skills: [skill()] }),
      unpinned: reg({ lifeProblem: true, skills: [skill("other", digest, "unpinned"), skill()] }),
      changed: reg({ lifeProblem: true, skills: [skill("other", `sha256:${"b".repeat(64)}`), skill()] }),
      revoked: reg({ lifeProblem: true, skills: [skill("other"), skill()], revoked: [REL] }),
    };
    for (const [name, r] of Object.entries(cases)) {
      const list = verifyRunSkillLock(other, r);
      expect(list[0]!.code, name).toBe("lifecycle");
      expect(list.length, name).toBeGreaterThan(1);
      expect(integrityReason(list[0]!)).toContain("the skill lifecycle record cannot be read");
    }
    expect(codes(reg({ lifeProblem: true }))).toEqual(["lifecycle"]);
    expect(verifyRunSkillLock(lockOf([]), reg({ lifeProblem: true }))).toEqual([]);
  });

  it("keeps the free text of a reason out of every stop reason, and puts it in the log lines", () => {
    const r = reg({ lifecycle: [[K, status("revoked", { reason: "daily budget" })]], revoked: [REL] });
    for (const p of [...verifyRunSkillLock(lockOf(), r), ...verifyRunSkillLock(lockOf(), reg({ lifecycle: [[K, status("quarantined", { reason: "daily budget" })]] }))]) {
      expect(integrityReason(p)).not.toMatch(/daily budget|usage limit/);
    }
    expect(runSkillLockReasons(lockOf(), r)).toEqual([`skill lifecycle: ${K} revoked: usage limit reached`]);
    const ctl = reg({ lifecycle: [[K, status("retired", { reason: "tab\there" })]] });
    expect(runSkillLockReasons(lockOf(), ctl)).toEqual([`skill lifecycle: ${K} retired: (reason not shown)`]);
  });
});

// ---- the engine ----

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const gateStep = (ids: string[]): StepRecord => ({
  id: "risk_gate", type: "shell", visit: 1, ok: true, startedAt: "", durationMs: 0, logFile: "",
  output: `READY\nSKILL_REQUEST: ${JSON.stringify({ version: 1, skills: ids.map((id) => ({ id, reason: "Needed", evidence: ["catalogue:" + id] })) })}\n`,
});
function setup(ids = ["kafka"]) {
  const runDir = mkdtempSync(join(tmpdir(), "lifecycle-engine-"));
  dirs.push(runDir);
  const logs: string[] = [];
  const summary = {
    runId: RUN, runDir, history: [gateStep(ids)], workdir: runDir,
    flowDef: { steps: [{ id: "risk_gate", type: "shell", run: 'x | node "$FACTORY_TOOLS/skill-request" # /skill-request' }] },
  } as unknown as RunSummary;
  const engine = { summary, config: ConfigSchema.parse({}), log: (m: string) => logs.push(m), save: vi.fn() };
  return { engine, summary, runDir, logs };
}
const commitOf = () => "f".repeat(40);

describe("the engine", () => {
  it("logs a note for a deprecated skill when the lock is made, and for a retired one when it is verified", () => {
    const t = setup();
    const dep = reg({ lifecycle: [[K, status("deprecated", { replacement: "kafka@2.0.0" })]] });
    expect(skillSession(t.engine, { discover: () => dep, commitOf }).refused).toBeUndefined();
    expect(t.logs.some((l) => l.includes(`! skill lifecycle: ${K} is deprecated (replaced by kafka@2.0.0)`))).toBe(true);
    t.logs.length = 0;
    const retired = reg({ lifecycle: [[K, status("retired")]] });
    const s = skillSession(t.engine, { discover: () => retired });
    expect(s.refused).toBeUndefined();
    expect(s.payload).toBeDefined();
    expect(t.logs.some((l) => l.includes(`! skill lifecycle: ${K} is retired; this run goes on with it`))).toBe(true);
  });

  it("refuses a quarantined skill until this run is allowed, and does not rewrite the lock", () => {
    const t = setup();
    expect(ensureSkillLock(t.engine, { discover: () => reg(), commitOf })).toBeUndefined();
    const file = join(t.runDir, RUN_SKILL_LOCK_FILE);
    const bytes = readFileSync(file);
    const summaryBefore = JSON.stringify(t.summary.skillLock);
    const quarantined = reg({ lifecycle: [[K, status("quarantined", { reason: "daily budget" })]] });
    const refused = skillSession(t.engine, { discover: () => quarantined }).refused;
    expect(refused).toMatch(/^skill integrity: kafka@1\.0\.0 is quarantined/);
    expect(refused).not.toContain("daily budget");
    expect(t.logs.some((l) => l.includes(`skill lifecycle: ${K} quarantined: daily budget`))).toBe(true);
    const allowed = reg({ lifecycle: [[K, status("quarantined", { allowed: [RUN] })]] });
    expect(ensureSkillLock(t.engine, { discover: () => allowed })).toBeUndefined();
    expect(skillSession(t.engine, { discover: () => allowed }).refused).toBeUndefined();
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(JSON.stringify(t.summary.skillLock)).toBe(summaryBefore);
  });

  it("always refuses a revoked skill", () => {
    const t = setup();
    expect(ensureSkillLock(t.engine, { discover: () => reg(), commitOf })).toBeUndefined();
    const local = reg({ lifecycle: [[K, status("revoked", { allowed: [RUN] })]] });
    expect(ensureSkillLock(t.engine, { discover: () => local })).toMatch(/is revoked/);
    const release = reg({ skills: [], revoked: [REL] });
    expect(ensureSkillLock(t.engine, { discover: () => release })).toMatch(/is revoked by release acme@1\.0\.0/);
    expect(ensureSkillLock(t.engine, { discover: () => reg({ lifeProblem: true }) })).toMatch(/skill lifecycle record cannot be read/);
  });
});
