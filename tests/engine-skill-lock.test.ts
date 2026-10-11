import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { SKILL_LOCK_CHANGED, ensureSkillLock, skillSession } from "../src/engine/skill-lock.js";
import type { RunSkillCarry } from "../src/engine/plan-carry.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import type { SkillRequest } from "../src/skills/request.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { RUN_SKILL_LOCK_FILE, readRunSkillLock } from "../src/skills/run-lock.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
function sk(id: string, o: { version?: string; digest?: string; pin?: string } = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "data folder", dir: "/secret/dir", active: true,
    trust: "approved", pin: o.pin ?? "pinned", digest: o.digest ?? digestOf("a"),
    pkg: { id, version, description: `About ${id}.`, instructions: "Do it.", roles: [], dependencies: [], conflicts: [] },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });

const gateOutput = (ids: string[]) =>
  `READY\nSKILL_REQUEST: ${JSON.stringify({ version: 1, skills: ids.map((id) => ({ id, reason: "Needed", evidence: ["catalogue:" + id] })) })}\n`;
function gate(output: string): StepRecord {
  return { id: "risk_gate", type: "shell", visit: 1, ok: true, output, startedAt: "", durationMs: 0, logFile: "" };
}

function setup(output: string | undefined, over: Record<string, unknown> = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "enginelock-"));
  dirs.push(runDir);
  const logs: string[] = [];
  const summary = {
    runId: "run-1", runDir, history: output === undefined ? [] : [gate(output)], workdir: runDir,
    flowDef: { steps: [{ id: "risk_gate", type: "shell", run: 'x | node "$FACTORY_TOOLS/skill-request" # /skill-request' }] },
    ...over,
  } as unknown as RunSummary;
  const save = vi.fn();
  const engine = { summary, config: ConfigSchema.parse({}), log: (m: string) => logs.push(m), save };
  return { engine, summary, runDir, logs, save };
}
const file = (runDir: string) => join(runDir, RUN_SKILL_LOCK_FILE);
const commitOf = () => "f".repeat(40);

describe("ensureSkillLock with a carry", () => {
  const request: SkillRequest = { version: 1, skills: [{ id: "a", reason: "Needed", evidence: ["catalogue:a"] }] };
  const carry = (lockHash = digestOf("1")): RunSkillCarry => ({ request, planHash: digestOf("1"), lockHash, commentId: "7", changes: [], at: "2026-01-01T00:00:00.000Z" });

  it("makes the lock from the carry and verifies on the second call", () => {
    const t = setup(undefined, { skillCarry: carry() });
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")), commitOf })).toBeUndefined();
    expect(t.summary.skillLock).toMatchObject({ planHash: digestOf("1"), skills: [{ id: "a", version: "1.0.0" }] });
    const bytes = readFileSync(file(t.runDir));
    const discover = vi.fn(() => reg(sk("a")));
    expect(ensureSkillLock(t.engine, { discover })).toBeUndefined();
    expect(Buffer.compare(readFileSync(file(t.runDir)), bytes)).toBe(0);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.logs.at(-1)).toMatch(/verified 1 skill$/);
  });

  it("a plan gate and a carry with the same request lock the same skills in the same order", () => {
    const registry = () => reg(sk("a"), sk("b", { version: "2.0.0", digest: digestOf("c") }));
    const both: SkillRequest = { version: 1, skills: ["a", "b"].map((id) => ({ id, reason: "Needed", evidence: ["catalogue:" + id] })) };
    const now = new Date("2026-01-01T00:00:00.000Z");
    const viaGate = setup(gateOutput(["a", "b"]));
    const viaCarry = setup(undefined, { skillCarry: { ...carry(), request: both } });
    expect(ensureSkillLock(viaGate.engine, { discover: registry, commitOf, now })).toBeUndefined();
    expect(ensureSkillLock(viaCarry.engine, { discover: registry, commitOf, now })).toBeUndefined();
    const g = readRunSkillLock(viaGate.runDir);
    const c = readRunSkillLock(viaCarry.runDir);
    if (!g.ok || !c.ok) throw new Error("no lock");
    expect(g.lock.skills.length).toBe(2);
    expect(c.lock.skills).toEqual(g.lock.skills);
    expect(c.lock.estimatedTokens).toBe(g.lock.estimatedTokens);
    expect(c.lock.commit).toBe(g.lock.commit);
  });

  it("a carry is stopped by skills.unresolved when a skill is gone before the lock", () => {
    const t = setup(undefined, { skillCarry: carry() });
    const reason = ensureSkillLock(t.engine, { discover: () => reg(), commitOf });
    expect(reason).toBeDefined();
    expect(existsSync(file(t.runDir))).toBe(false);
  });

  it("a plan gate wins over a carry", () => {
    const t = setup(gateOutput(["a"]), { skillCarry: carry() });
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")), commitOf })).toBeUndefined();
    expect(t.summary.skillLock!.planHash).not.toBe(digestOf("1"));
  });

  it("a changed carry makes a new lock with the new registry version", () => {
    const t = setup(undefined, { skillCarry: carry() });
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")), commitOf })).toBeUndefined();
    t.summary.skillCarry = carry(digestOf("2"));
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a", { version: "1.1.0", digest: digestOf("b") }), sk("a")), commitOf })).toBeUndefined();
    expect(t.summary.skillLock).toMatchObject({ planHash: digestOf("2"), skills: [{ id: "a", version: "1.1.0" }] });
  });

  it("a changed carry with a tampered summary is refused", () => {
    const t = setup(undefined, { skillCarry: carry() });
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")), commitOf })).toBeUndefined();
    t.summary.skillCarry = carry(digestOf("2"));
    t.summary.skillLock = { ...t.summary.skillLock!, lockDigest: digestOf("9") };
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")), commitOf })).toBe(SKILL_LOCK_CHANGED);
  });
});

describe("ensureSkillLock", () => {
  it("does nothing for a run without a checked plan gate", () => {
    const discover = vi.fn(() => reg());
    const none = setup(undefined);
    expect(ensureSkillLock(none.engine, { discover })).toBeUndefined();
    // an old run: its gate came from a flow that did not run the tool
    const old = setup(gateOutput(["a"]), { flowDef: { steps: [{ id: "risk_gate", type: "shell", run: "echo plan" }] } });
    expect(ensureSkillLock(old.engine, { discover })).toBeUndefined();
    for (const t of [none, old]) {
      expect(existsSync(file(t.runDir))).toBe(false);
      expect(t.summary.skillLock).toBeUndefined();
      expect(t.save).not.toHaveBeenCalled();
    }
    expect(discover).not.toHaveBeenCalled();
  });

  it("makes the lock at the first agent step, keeps the summary and the commit, and verifies afterwards", () => {
    const t = setup(gateOutput(["a"]));
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")), commitOf })).toBeUndefined();
    expect(statSync(file(t.runDir)).mode & 0o777).toBe(0o600);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.summary.skillLock).toMatchObject({ version: 1, commit: "f".repeat(40), skills: [{ id: "a", version: "1.0.0", digest: digestOf("a"), selection: "requested" }] });
    expect(t.logs.at(-1)).toMatch(/skill lock: a@1\.0\.0 \(about \d+ tokens\)/);
    const bytes = readFileSync(file(t.runDir));
    // the second call verifies; it does not resolve again and does not rewrite
    const discover = vi.fn(() => reg(sk("a")));
    expect(ensureSkillLock(t.engine, { discover })).toBeUndefined();
    expect(Buffer.compare(readFileSync(file(t.runDir)), bytes)).toBe(0);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.logs.at(-1)).toMatch(/verified 1 skill$/);
  });

  it("keeps the pinned version when the registry got a newer one (resume)", () => {
    const t = setup(gateOutput(["a"]));
    ensureSkillLock(t.engine, { discover: () => reg(sk("a")) });
    const newer = reg(sk("a", { version: "2.0.0", digest: digestOf("d") }), sk("a"));
    expect(ensureSkillLock(t.engine, { discover: () => newer })).toBeUndefined();
    expect(t.summary.skillLock!.skills.map((s) => s.version)).toEqual(["1.0.0"]);
    expect((readRunSkillLock(t.runDir) as { lock: { skills: { version: string }[] } }).lock.skills[0]!.version).toBe("1.0.0");
  });

  it("an empty lock is made once and never looks at the registry again", () => {
    const t = setup(gateOutput([]));
    expect(ensureSkillLock(t.engine, { discover: () => reg() })).toBeUndefined();
    expect(t.logs.at(-1)).toMatch(/skill lock: no skills/);
    const discover = vi.fn(() => reg());
    expect(ensureSkillLock(t.engine, { discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });

  it("stops when a locked package changed, is missing or lost its pin", () => {
    const t = setup(gateOutput(["a"]));
    ensureSkillLock(t.engine, { discover: () => reg(sk("a")) });
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a", { digest: digestOf("e") })) })).toBe(
      `skill integrity: a@1.0.0 changed since this run locked it (locked ${digestOf("a")}, now ${digestOf("e")})`,
    );
    expect(ensureSkillLock(t.engine, { discover: () => reg() })).toMatch(/^skill integrity: a@1\.0\.0 is missing/);
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a", { pin: "unpinned" })) })).toMatch(/^skill integrity: a@1\.0\.0 is no longer pinned/);
    // nothing was made again
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("stops when the lock file is deleted, edited or replaced by garbage", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(sk("a"));
    ensureSkillLock(t.engine, { discover });
    const original = readFileSync(file(t.runDir), "utf8");
    // edited: still valid, but not the bytes the summary holds the digest of
    writeFileSync(file(t.runDir), original.replace(digestOf("a"), digestOf("b")));
    expect(ensureSkillLock(t.engine, { discover })).toBe(SKILL_LOCK_CHANGED);
    // emptied or substituted by another installed, pinned skill: the same
    const parsed = JSON.parse(original);
    writeFileSync(file(t.runDir), JSON.stringify({ ...parsed, skills: [] }));
    expect(ensureSkillLock(t.engine, { discover })).toBe(SKILL_LOCK_CHANGED);
    writeFileSync(file(t.runDir), JSON.stringify({ ...parsed, skills: [{ ...parsed.skills[0], id: "z", digest: digestOf("f") }] }));
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a"), sk("z", { digest: digestOf("f") })) })).toBe(SKILL_LOCK_CHANGED);
    writeFileSync(file(t.runDir), original);
    expect(ensureSkillLock(t.engine, { discover })).toBeUndefined();
    writeFileSync(file(t.runDir), "garbage");
    expect(ensureSkillLock(t.engine, { discover })).toBe(SKILL_LOCK_CHANGED);
    rmSync(file(t.runDir));
    expect(ensureSkillLock(t.engine, { discover })).toBe(SKILL_LOCK_CHANGED);
    expect(existsSync(file(t.runDir))).toBe(false); // never made again from the registry
  });

  it("repairs a missing or altered summary from the file and never resolves again", () => {
    const t = setup(gateOutput(["a"]));
    ensureSkillLock(t.engine, { discover: () => reg(sk("a")) });
    const want = structuredClone(t.summary.skillLock);
    const newer = () => reg(sk("a", { version: "2.0.0", digest: digestOf("d") }), sk("a"));
    // crash between the file and run.json
    t.summary.skillLock = undefined;
    expect(ensureSkillLock(t.engine, { discover: newer })).toBeUndefined();
    expect(t.summary.skillLock).toEqual(want);
    // a summary that was changed
    t.summary.skillLock = { ...want!, planHash: digestOf("9"), skills: [] };
    expect(ensureSkillLock(t.engine, { discover: newer })).toBeUndefined();
    expect(t.summary.skillLock).toEqual(want);
    expect(t.logs.some((l) => /made again from the lock file/.test(l))).toBe(true);
    // a summary of this plan with another lock digest is not repaired: the file or the summary was changed
    t.summary.skillLock = { ...want!, lockDigest: digestOf("9") };
    expect(ensureSkillLock(t.engine, { discover: newer })).toBe(SKILL_LOCK_CHANGED);
  });

  it("a lock of another plan is replaced only when the run really planned again", () => {
    const t = setup(gateOutput(["a"]));
    ensureSkillLock(t.engine, { discover: () => reg(sk("a"), sk("b")) });
    const first = t.summary.skillLock!.lockDigest;
    t.summary.history = [gate(gateOutput(["b"]))];
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a"), sk("b")) })).toBeUndefined();
    expect(t.summary.skillLock!.lockDigest).not.toBe(first);
    expect(t.summary.skillLock!.skills.map((s) => s.id)).toEqual(["b"]);
    // the lock file was swapped for one that the summary does not know: not a re-plan
    const other = setup(gateOutput(["a"]));
    ensureSkillLock(other.engine, { discover: () => reg(sk("a")) });
    other.summary.skillLock = undefined;
    other.summary.history = [gate(gateOutput(["b"]))];
    expect(ensureSkillLock(other.engine, { discover: () => reg(sk("a"), sk("b")) })).toBe(SKILL_LOCK_CHANGED);
  });

  it("still verifies an existing lock when a planning step follows the gate", () => {
    const t = setup(gateOutput(["a"]));
    ensureSkillLock(t.engine, { discover: () => reg(sk("a")) });
    const planning = { ...gate(""), id: "plan", type: "claude" } as StepRecord;
    t.summary.history = [...t.summary.history, planning];
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")) })).toBeUndefined();
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a", { digest: digestOf("e") })) })).toMatch(/^skill integrity: a@1\.0\.0 changed/);
    expect(ensureSkillLock(t.engine, { discover: () => reg() })).toMatch(/is missing/);
    // nothing is made or replaced while there is no gate
    rmSync(file(t.runDir));
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")) })).toBe(SKILL_LOCK_CHANGED);
    expect(existsSync(file(t.runDir))).toBe(false);
    // a run that has never locked anything is not affected
    const fresh = setup(undefined);
    expect(ensureSkillLock(fresh.engine, { discover: () => reg() })).toBeUndefined();
  });

  it("refuses a lock file of another run", () => {
    const a = setup(gateOutput(["a"]));
    ensureSkillLock(a.engine, { discover: () => reg(sk("a")) });
    const b = setup(gateOutput(["a"]), { runId: "run-2" });
    writeFileSync(file(b.runDir), readFileSync(file(a.runDir)));
    b.summary.skillLock = a.summary.skillLock;
    expect(ensureSkillLock(b.engine, { discover: () => reg(sk("a")) })).toBe(SKILL_LOCK_CHANGED);
  });

  it("blocks the run when a mandatory skill cannot be used, and writes nothing", () => {
    const t = setup(gateOutput([]));
    t.engine.config = ConfigSchema.parse({ skills: { selection: { include: ["a"] } } });
    const reason = ensureSkillLock(t.engine, { discover: () => reg(sk("a", { pin: "unpinned" })) });
    expect(reason).toBe("skill selection is blocked: a (unpinned)");
    expect(existsSync(file(t.runDir))).toBe(false);
    expect(t.summary.skillLock).toBeUndefined();
  });

  it("leaves out a requested skill that is refused and logs it", () => {
    const t = setup(gateOutput(["nope"]));
    expect(ensureSkillLock(t.engine, { discover: () => reg() })).toBeUndefined();
    expect(t.summary.skillLock!.skills).toEqual([]);
    expect(t.logs.some((l) => l.includes("nope left out: unknown"))).toBe(true);
  });

  it("returns a reason instead of throwing when the lock cannot be written", () => {
    const t = setup(gateOutput(["a"]), { runDir: join(tmpdir(), "enginelock-does-not-exist", "x") });
    expect(ensureSkillLock(t.engine, { discover: () => reg(sk("a")) })).toBe("skill integrity: the skill lock of this run could not be written");
  });
});

describe("skillSession", () => {
  const withText = (s: RegisteredSkill, instructions: string, extra: Record<string, unknown> = {}) => {
    Object.assign(s.pkg, { instructions }, extra);
    return s;
  };
  const payloadOf = (r: ReturnType<typeof skillSession>) => ("payload" in r ? r.payload : undefined);

  it("does nothing without a gate", () => {
    const discover = vi.fn(() => reg());
    expect(skillSession(setup(undefined).engine, "claude", { discover })).toEqual({});
    expect(discover).not.toHaveBeenCalled();
  });

  it("gives an empty payload for an empty lock", () => {
    const t = setup(gateOutput([]));
    const p = payloadOf(skillSession(t.engine, "claude", { discover: () => reg() }));
    expect(p).toMatchObject({ loaded: [], text: "" });
  });

  it("gives the payload on the session that makes the lock and on the next one", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(withText(sk("a"), "Package instructions of a."));
    for (let i = 0; i < 2; i++) {
      const p = payloadOf(skillSession(t.engine, "claude", { discover }))!;
      expect(p.loaded).toEqual(["a@1.0.0"]);
      expect(p.text).toContain("Package instructions of a.");
    }
    // the per-session "skill context" line is logged where the session starts (runWith), not here
    expect(t.logs.filter((l) => /skill context: (loaded|reloaded|reused)/.test(l))).toHaveLength(0);
  });

  it("verifies before every session and never resolves or writes the lock again", () => {
    const t = setup(gateOutput(["a"]));
    const discover = vi.fn(() => reg(withText(sk("a"), "Package instructions of a.")));
    skillSession(t.engine, "claude", { discover });
    const first = readFileSync(file(t.runDir), "utf8");
    skillSession(t.engine, "claude", { discover });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(readFileSync(file(t.runDir), "utf8")).toBe(first);
  });

  it("loads several skills in lock order, and only the locked ones", () => {
    const t = setup(gateOutput(["a", "b"]));
    const discover = () => reg(sk("a"), sk("b", { digest: digestOf("b") }), sk("z", { digest: digestOf("c") }));
    const p = payloadOf(skillSession(t.engine, "claude", { discover }))!;
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(p.text).not.toContain('id="z"');
  });

  it("takes only the description and the instructions of a package", () => {
    const t = setup(gateOutput(["a"]));
    const s = withText(sk("a"), "Plain advice.", { allowedTools: "Bash(SENTINEL_TOOL)", tool_profile: "SENTINEL_PROFILE", files: [{ path: "scripts/x.sh", content: "SENTINEL_FILE" }] });
    const p = payloadOf(skillSession(t.engine, "claude", { discover: () => reg(s) }))!;
    expect(p.text).toContain("Plain advice.");
    expect(p.text).not.toMatch(/SENTINEL/);
  });

  it("gives nothing for an old plan without a current gate", () => {
    const t = setup(gateOutput(["a"]));
    skillSession(t.engine, "claude", { discover: () => reg(sk("a")) });
    t.summary.history.push({ id: "plan", type: "claude", visit: 1, ok: true, output: "plan", startedAt: "", durationMs: 0, logFile: "" } as StepRecord);
    t.summary.flowDef = { steps: [{ id: "plan", type: "claude", prompt: "x" }] } as never;
    expect(skillSession(t.engine, "claude", { discover: () => reg(sk("a")) })).toEqual({});
  });

  it("leaves out a requested skill over the budget and logs it; a mandatory one refuses the session", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(withText(sk("a"), "x ".repeat(2000)));
    expect(skillSession(t.engine, "claude", { discover })).toBeTruthy();
    t.engine.config = ConfigSchema.parse({ skills: { selection: { max_tokens: 100 } } });
    const p = payloadOf(skillSession(t.engine, "claude", { discover }))!;
    expect(p.loaded).toEqual([]);
    expect(p.omitted).toEqual(["a@1.0.0"]);
    expect(t.logs.some((l) => l.includes("skill context: a@1.0.0 left out: over budget"))).toBe(true);

    const m = setup(gateOutput([]));
    m.engine.config = ConfigSchema.parse({ skills: { selection: { include: ["a"] } } });
    expect(skillSession(m.engine, "claude", { discover })).toEqual({ payload: expect.objectContaining({ loaded: ["a@1.0.0"] }) });
    m.engine.config = ConfigSchema.parse({ skills: { selection: { include: ["a"], max_tokens: 100 } } });
    const r = skillSession(m.engine, "claude", { discover }) as { refused: string };
    expect(r.refused.startsWith("skill selection is blocked: ")).toBe(true);
    expect(r.refused).toContain("a@1.0.0 does not fit the skill context budget (skills.selection.max_tokens)");
    // Codex gets no payload and no refusal; a fallback to Claude is judged again
    const before = m.logs.length;
    expect(skillSession(m.engine, "codex", { discover })).toEqual({});
    expect(m.logs.slice(before).some((l) => l.includes("skill context"))).toBe(false);
    expect(skillSession(m.engine, "claude", { discover })).toHaveProperty("refused");
  });

  it("verifies for Codex too: a changed digest refuses both agents", () => {
    const t = setup(gateOutput(["a"]));
    skillSession(t.engine, "claude", { discover: () => reg(sk("a")) });
    const changed = () => reg(sk("a", { digest: digestOf("d") }));
    for (const agent of ["claude", "codex"] as const) {
      const r = skillSession(t.engine, agent, { discover: changed }) as { refused: string };
      expect(r.refused).toMatch(/^skill integrity: a@1\.0\.0 changed/);
    }
  });
});

describe("flow skill modes", () => {
  const explicit = (ids: string[]) => ({ flowDef: { steps: [{ id: "impl", type: "claude", prompt: "x" }], skills: { mode: "explicit", ids } } });
  const off = { flowDef: { steps: [{ id: "risk_gate", type: "shell", run: "# /skill-request" }], skills: { mode: "off" } } };

  it("off: no lock, no payload, even with include and a valid request", () => {
    const t = setup(gateOutput(["a"]), off);
    t.engine.config.skills.selection.include = ["a"];
    const discover = vi.fn(() => reg(sk("a")));
    expect(ensureSkillLock(t.engine, { discover })).toBeUndefined();
    for (const [agent, role] of [["claude", "coder"], ["codex", "coder"], ["claude", "reviewer"]] as const) {
      expect(skillSession(t.engine, agent, { discover }, role)).toEqual({});
    }
    expect(existsSync(file(t.runDir))).toBe(false);
    expect(t.summary.skillLock).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it("explicit: locks the named ids without evidence and verifies afterwards", () => {
    const t = setup(undefined, explicit(["a"]));
    const discover = () => reg(sk("a"));
    expect(ensureSkillLock(t.engine, { discover, commitOf })).toBeUndefined();
    const lock = JSON.parse(readFileSync(file(t.runDir), "utf8"));
    expect(lock.version).toBe(1);
    expect(lock.skills[0]).toMatchObject({ id: "a", selection: "requested", reason: "named by the flow" });
    expect(lock.skills[0]).not.toHaveProperty("evidence");
    const bytes = readFileSync(file(t.runDir));
    expect(ensureSkillLock(t.engine, { discover })).toBeUndefined();
    expect(readFileSync(file(t.runDir)).equals(bytes)).toBe(true);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(skillSession(t.engine, "claude", { discover })).toMatchObject({ payload: { loaded: ["a@1.0.0"] } });
    rmSync(file(t.runDir));
    expect(ensureSkillLock(t.engine, { discover })).toBe(SKILL_LOCK_CHANGED);
  });

  it("explicit: a skill that went away before the lock stops the run under the unresolved policy", () => {
    const t = setup(undefined, explicit(["a"]));
    const r = ensureSkillLock(t.engine, { discover: () => reg() });
    expect(r).toMatch(/\ba\b/);
    expect(existsSync(file(t.runDir))).toBe(false);
  });

  it("block = false: lock still made, no payload; a changed skill is refused", () => {
    const t = setup(gateOutput(["a"]));
    expect(skillSession(t.engine, "claude", { discover: () => reg(sk("a")), commitOf }, "coder", false)).toEqual({});
    expect(existsSync(file(t.runDir))).toBe(true);
    const changed = () => reg(sk("a", { digest: digestOf("b") }));
    expect(skillSession(t.engine, "claude", { discover: changed }, "coder", false)).toHaveProperty("refused");
  });
});
