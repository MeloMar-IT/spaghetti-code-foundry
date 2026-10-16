import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { sessionTools } from "../src/skills/tool-policy.js";
import { SKILL_LOCK_CHANGED, ensureSkillLock, skillSession } from "../src/engine/skill-lock.js";
import type { RunSkillCarry } from "../src/engine/plan-carry.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import type { SkillRequest } from "../src/skills/request.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { canonicalFromRegistered } from "../src/skills/canonical-facts.js";
import type { CanonicalDeps } from "../src/skills/run-canonical.js";
import { RUN_SKILL_LOCK_FILE, readRunSkillLock } from "../src/skills/run-lock.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
function sk(id: string, o: { version?: string; digest?: string; pin?: string; source?: string; caps?: string[]; deps?: string[]; composable?: string[]; text?: string } = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: o.source ?? "admin", label: "data folder", dir: "/secret/dir", active: true,
    trust: "approved", pin: o.pin ?? "pinned", digest: o.digest ?? digestOf("a"),
    pkg: {
      id, version, description: `About ${id}.`, instructions: o.text ?? "Do it.", roles: [], dependencies: (o.deps ?? []).map((d) => ({ id: d })), conflicts: [],
      capabilities: o.caps ?? [], ...(o.composable ? { composable: o.composable } : {}), ...(o.caps ? { category: "general" } : {}), risk: "low",
    },
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

  it("records the source kind of each locked skill: catalogue, builtin or admin", () => {
    const t = setup(gateOutput(["a", "b", "c"]));
    const discover = () => reg(sk("a", { source: "catalogue" }), sk("b", { source: "builtin" }), sk("c"));
    expect(ensureSkillLock(t.engine, { discover, commitOf })).toBeUndefined();
    const r = readRunSkillLock(t.runDir);
    expect(r.ok && r.lock.skills.map((s) => [s.id, s.source])).toEqual([["a", "catalogue"], ["b", "builtin"], ["c", "admin"]]);
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
    expect(skillSession(setup(undefined).engine, { discover })).toEqual({});
    expect(discover).not.toHaveBeenCalled();
  });

  it("gives an empty payload for an empty lock", () => {
    const t = setup(gateOutput([]));
    const p = payloadOf(skillSession(t.engine, { discover: () => reg() }));
    expect(p).toMatchObject({ loaded: [], text: "" });
  });

  it("gives the payload on the session that makes the lock and on the next one", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(withText(sk("a"), "Package instructions of a."));
    for (let i = 0; i < 2; i++) {
      const p = payloadOf(skillSession(t.engine, { discover }))!;
      expect(p.loaded).toEqual(["a@1.0.0"]);
      expect(p.text).toContain("Package instructions of a.");
    }
    // the per-session "skill context" line is logged where the session starts (runWith), not here
    expect(t.logs.filter((l) => /skill context: (loaded|reloaded|reused)/.test(l))).toHaveLength(0);
  });

  it("verifies before every session and never resolves or writes the lock again", () => {
    const t = setup(gateOutput(["a"]));
    const discover = vi.fn(() => reg(withText(sk("a"), "Package instructions of a.")));
    skillSession(t.engine, { discover });
    const first = readFileSync(file(t.runDir), "utf8");
    skillSession(t.engine, { discover });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(readFileSync(file(t.runDir), "utf8")).toBe(first);
  });

  it("loads several skills in lock order, and only the locked ones", () => {
    const t = setup(gateOutput(["a", "b"]));
    const discover = () => reg(sk("a"), sk("b", { digest: digestOf("b") }), sk("z", { digest: digestOf("c") }));
    const p = payloadOf(skillSession(t.engine, { discover }))!;
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(p.text).not.toContain('id="z"');
  });

  it("loads locked copies with the same text once and logs it", () => {
    const t = setup(gateOutput(["a", "b"]));
    const same = (id: string, digest: string) => withText(sk(id, { digest }), "Shared advice.", { description: "Shared." });
    const p = payloadOf(skillSession(t.engine, { discover: () => reg(same("a", digestOf("a")), same("b", digestOf("b"))) }))!;
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(p.collapsed).toEqual([{ key: "b@1.0.0", into: "a@1.0.0" }]);
    expect(p.text.match(/Shared advice\./g)).toHaveLength(1);
    expect(t.logs).toContain("    · skill context: b@1.0.0 has the same text as a@1.0.0; loaded once");
  });

  it("takes only the description and the instructions of a package", () => {
    const t = setup(gateOutput(["a"]));
    const s = withText(sk("a"), "Plain advice.", { allowedTools: "Bash(SENTINEL_TOOL)", tool_profile: "SENTINEL_PROFILE", files: [{ path: "scripts/x.sh", content: "SENTINEL_FILE" }] });
    const p = payloadOf(skillSession(t.engine, { discover: () => reg(s) }))!;
    expect(p.text).toContain("Plain advice.");
    expect(p.text).not.toMatch(/SENTINEL/);
  });

  it("gives nothing for an old plan without a current gate", () => {
    const t = setup(gateOutput(["a"]));
    skillSession(t.engine, { discover: () => reg(sk("a")) });
    t.summary.history.push({ id: "plan", type: "claude", visit: 1, ok: true, output: "plan", startedAt: "", durationMs: 0, logFile: "" } as StepRecord);
    t.summary.flowDef = { steps: [{ id: "plan", type: "claude", prompt: "x" }] } as never;
    expect(skillSession(t.engine, { discover: () => reg(sk("a")) })).toEqual({});
  });

  it("leaves out a requested skill over the budget and logs it; a mandatory one refuses the session", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(withText(sk("a"), "x ".repeat(2000)));
    expect(skillSession(t.engine, { discover })).toBeTruthy();
    t.engine.config = ConfigSchema.parse({ skills: { selection: { max_tokens: 100 } } });
    const p = payloadOf(skillSession(t.engine, { discover }))!;
    expect(p.loaded).toEqual([]);
    expect(p.omitted).toEqual(["a@1.0.0"]);
    expect(t.logs.some((l) => l.includes("skill context: a@1.0.0 left out: over budget"))).toBe(true);

    const m = setup(gateOutput([]));
    m.engine.config = ConfigSchema.parse({ skills: { selection: { include: ["a"] } } });
    expect(skillSession(m.engine, { discover })).toEqual({ payload: expect.objectContaining({ loaded: ["a@1.0.0"] }) });
    m.engine.config = ConfigSchema.parse({ skills: { selection: { include: ["a"], max_tokens: 100 } } });
    const r = skillSession(m.engine, { discover }) as { refused: string };
    expect(r.refused.startsWith("skill selection is blocked: ")).toBe(true);
    expect(r.refused).toContain("a@1.0.0 does not fit the skill context budget (skills.selection.max_tokens)");
  });

  it("a changed digest refuses the session", () => {
    const t = setup(gateOutput(["a"]));
    skillSession(t.engine, { discover: () => reg(sk("a")) });
    const changed = () => reg(sk("a", { digest: digestOf("d") }));
    const r = skillSession(t.engine, { discover: changed }) as { refused: string };
    expect(r.refused).toMatch(/^skill integrity: a@1\.0\.0 changed/);
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
    for (const role of ["coder", "reviewer"] as const) {
      expect(skillSession(t.engine, { discover }, role)).toEqual({});
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
    expect(skillSession(t.engine, { discover })).toMatchObject({ payload: { loaded: ["a@1.0.0"] } });
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
    expect(skillSession(t.engine, { discover: () => reg(sk("a")), commitOf }, "coder", false)).toEqual({});
    expect(existsSync(file(t.runDir))).toBe(true);
    const changed = () => reg(sk("a", { digest: digestOf("b") }));
    expect(skillSession(t.engine, { discover: changed }, "coder", false)).toHaveProperty("refused");
  });
});

describe("skillSession with session tools", () => {
  const shellSkill = (id: string, extra: Record<string, unknown> = {}) => {
    const s = sk(id);
    Object.assign(s.pkg, { risk: "medium", tool_profile: { shell: true, network: false, filesystem: "read" }, connectors: [], ...extra });
    return s;
  };
  const withDeps = (s: RegisteredSkill, deps: string[]) => {
    Object.assign(s.pkg, { dependencies: deps.map((id) => ({ id, version: "^1.0.0" })) });
    return s;
  };
  const cfg = (tools: Record<string, unknown> = {}, include: string[] = []) => ConfigSchema.parse({ skills: { tools, selection: { include } } });
  const step = (rules: string[]) => sessionTools({ stepId: "impl", step: { allowed_tools: rules }, defaults: {}, sandbox: { boxed: false } });
  const noShell = step(["Read"]);
  const shell = step(["Bash"]);
  const keys = (r: ReturnType<typeof skillSession>) => ("payload" in r ? r.payload?.loaded : undefined);

  it("leaves a shell skill out of a step without shell, and does not refuse", () => {
    const t = setup(gateOutput(["a"]));
    const r = skillSession(t.engine, { discover: () => reg(shellSkill("a")) }, "coder", true, noShell);
    expect(r).toMatchObject({ payload: { loaded: [], text: "" }, tools: { leftOut: [{ key: "a@1.0.0", code: "tool-not-in-step" }] } });
    expect(r).not.toHaveProperty("refused");
    expect(t.logs).toContain("    · skill tools: a@1.0.0 not loaded in this step [tool-not-in-step]");
  });

  it("loads it into a step with shell", () => {
    const t = setup(gateOutput(["a"]));
    const r = skillSession(t.engine, { discover: () => reg(shellSkill("a")) }, "coder", true, shell);
    expect(keys(r)).toEqual(["a@1.0.0"]);
    expect(r).toMatchObject({ tools: { action: "continue", leftOut: [], met: [{ key: "a@1.0.0", need: "shell" }] } });
  });

  it("refuses when the policy changed after the lock, and decides again on the next call", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(shellSkill("a"));
    expect(keys(skillSession(t.engine, { discover }, "coder", true, shell))).toEqual(["a@1.0.0"]);
    const bytes = readFileSync(file(t.runDir));
    t.engine.config = cfg({ shell: false });
    const r = skillSession(t.engine, { discover }, "coder", true, shell) as { refused: string };
    expect(r.refused).toMatch(/^skill tools: .*a \[tool-not-approved\]/);
    t.engine.config = cfg();
    expect(keys(skillSession(t.engine, { discover }, "coder", true, shell))).toEqual(["a@1.0.0"]);
    expect(Buffer.compare(readFileSync(file(t.runDir)), bytes)).toBe(0);
  });

  it("leaves the skill out under degrade", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(shellSkill("a"));
    skillSession(t.engine, { discover }, "coder", true, shell);
    t.engine.config = cfg({ shell: false, missing: "degrade" });
    const r = skillSession(t.engine, { discover }, "coder", true, shell);
    expect(r).toMatchObject({ payload: { loaded: [] }, tools: { leftOut: [{ key: "a@1.0.0", code: "tool-not-approved" }] } });
    expect(t.logs).toContain("    ! skill tools: a@1.0.0 left out [tool-not-approved]");
  });

  it("refuses a locked skill that needs the network under the default policy", () => {
    const t = setup(gateOutput(["a"]));
    const net = () => reg(shellSkill("a", { tool_profile: { shell: false, network: true, filesystem: "read" } }));
    expect(skillSession(t.engine, { discover: net }, "coder", true, shell)).toHaveProperty("refused");
  });

  it("leaves out a skill with a connector under degrade", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(shellSkill("a", { tool_profile: { shell: false, network: false, filesystem: "read" }, connectors: ["slack"] }));
    t.engine.config = cfg({ missing: "degrade" });
    const r = skillSession(t.engine, { discover }, "coder", true, shell);
    expect(r).toMatchObject({ tools: { leftOut: [{ key: "a@1.0.0", code: "connector-unavailable" }] } });
  });

  it("still refuses a mandatory skill under degrade", () => {
    const t = setup(gateOutput(["a"]));
    t.engine.config = cfg({}, ["a"]);
    const discover = () => reg(shellSkill("a"));
    skillSession(t.engine, { discover }, "coder", true, shell);
    t.engine.config = cfg({ shell: false, missing: "degrade" }, ["a"]);
    expect(skillSession(t.engine, { discover }, "coder", true, shell)).toHaveProperty("refused");
  });

  it("leaves a dependant out with its dependency and keeps a plain skill", () => {
    const t = setup(gateOutput(["a", "b", "c"]));
    const discover = () => reg(shellSkill("a"), withDeps(sk("b"), ["a"]), sk("c"));
    const r = skillSession(t.engine, { discover }, "coder", true, noShell);
    expect(keys(r)).toEqual(["c@1.0.0"]);
    expect(r).toMatchObject({ tools: { leftOut: expect.arrayContaining([{ key: "a@1.0.0", code: "tool-not-in-step" }, expect.objectContaining({ key: "b@1.0.0", via: expect.any(String) })]) } });
  });

  it("is as before without tools, for a reviewer and for an empty lock", () => {
    const t = setup(gateOutput(["a"]));
    const discover = () => reg(shellSkill("a"));
    const plain = skillSession(t.engine, { discover });
    expect(plain).not.toHaveProperty("tools");
    expect(keys(plain)).toEqual(["a@1.0.0"]);
    expect(skillSession(t.engine, { discover }, "reviewer", true, noShell)).not.toHaveProperty("tools");
    const e = setup(gateOutput([]));
    expect(skillSession(e.engine, { discover: () => reg() }, "coder", true, noShell)).not.toHaveProperty("tools");
  });
});

describe("exclusive capabilities at lock time", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z");
  const canon = (o: Partial<CanonicalDeps> = {}, highRisk: string[] = []): CanonicalDeps => ({
    policy: { exclusive: ["cap"], highRisk },
    candidate: (s) => canonicalFromRegistered(s),
    ...o,
  });
  const pin = (target: string) => ({ capability: "cap", target, by: "@owner", reason: "r", from: "2026-01-01T00:00:00Z", expires: "2027-01-01T00:00:00Z" });
  const pins = (target: string) => ({ state: "ok" as const, items: [pin(target)], source: { commit: "c".repeat(40), blob: "d".repeat(40) } });
  const lockedIds = (runDir: string) => {
    const r = readRunSkillLock(runDir);
    if (!r.ok) throw new Error("no lock");
    return r.lock.skills.map((x) => x.id);
  };
  const a = () => sk("a", { caps: ["cap"], source: "admin" });
  const b = () => sk("b", { caps: ["cap"], source: "builtin" });

  it("leaves a requested loser out and records the decision in run.json, not in the lock file", () => {
    const t = setup(gateOutput(["a", "b"]));
    expect(ensureSkillLock(t.engine, { discover: () => reg(a(), b()), commitOf, canonical: canon() })).toBeUndefined();
    expect(lockedIds(t.runDir)).toEqual(["a"]);
    expect(t.logs).toContain("    · skill lock: b left out: not-canonical");
    expect(t.summary.skillSelection).toEqual({
      planHash: t.summary.skillLock!.planHash,
      canonical: [{ capability: "cap", outcome: "selected", winner: "a@1.0.0", decidedBy: "trust-tier", rejected: [{ skill: "b@1.0.0", code: "outranked", level: "trust-tier" }] }],
    });
    const text = readFileSync(file(t.runDir), "utf8");
    expect(text).not.toContain("canonical");
    expect(text).not.toContain("skillSelection");
  });

  describe("companions", () => {
    const text = "Long instructions. ".repeat(100);
    // "z" (admin) wins over "a" (builtin); "a" sorts first but must load second.
    const win = () => sk("z", { caps: ["cap"], source: "admin", composable: ["cap"], text, digest: digestOf("b") });
    const comp = () => sk("a", { caps: ["cap"], source: "builtin", composable: ["cap"], text: `${text} More.`, digest: digestOf("c") });
    const payloadOf = (r: ReturnType<typeof skillSession>) => ("payload" in r ? r.payload : undefined);
    const lowBudget = (t: ReturnType<typeof setup>) => { t.engine.config = ConfigSchema.parse({ skills: { selection: { max_tokens: 700 } } }); };

    it("locks the winner first, then the companion, and records it", () => {
      const t = setup(gateOutput(["a", "z"]));
      expect(ensureSkillLock(t.engine, { discover: () => reg(comp(), win()), commitOf, canonical: canon() })).toBeUndefined();
      expect(lockedIds(t.runDir)).toEqual(["z", "a"]);
      expect(t.summary.skillSelection!.canonical[0]).toMatchObject({ winner: "z@1.0.0", companions: ["a@1.0.0"] });
      expect(t.logs.some((l) => l.includes("left out"))).toBe(false);
    });

    it("leaves the companion out of the lock when only the winner fits", () => {
      const t = setup(gateOutput(["a", "z"]));
      lowBudget(t);
      expect(ensureSkillLock(t.engine, { discover: () => reg(comp(), win()), commitOf, canonical: canon() })).toBeUndefined();
      expect(lockedIds(t.runDir)).toEqual(["z"]);
      expect(t.logs).toContain("    · skill lock: a left out: over-budget");
    });

    it("omits the companion from the payload when the budget shrinks after the lock, and keeps the winner", () => {
      const t = setup(gateOutput(["a", "z"]));
      const discover = () => reg(comp(), win());
      const first = skillSession(t.engine, { discover, commitOf, canonical: canon() });
      expect(payloadOf(first)!.loaded).toEqual(["z@1.0.0", "a@1.0.0"]);
      lowBudget(t);
      const p = payloadOf(skillSession(t.engine, { discover, commitOf, canonical: canon() }))!;
      expect(p.loaded).toEqual(["z@1.0.0"]);
      expect(p.omitted).toEqual(["a@1.0.0"]);
    });

    it("drops a provider that does not declare the capability, as before", () => {
      const t = setup(gateOutput(["a", "z"]));
      const plain = sk("a", { caps: ["cap"], source: "builtin", text });
      expect(ensureSkillLock(t.engine, { discover: () => reg(plain, win()), commitOf, canonical: canon() })).toBeUndefined();
      expect(lockedIds(t.runDir)).toEqual(["z"]);
      expect(t.logs).toContain("    · skill lock: a left out: not-canonical");
    });
  });

  it("a mandatory loser blocks and no lock is written", () => {
    const t = setup(gateOutput(["a"]));
    t.engine.config = ConfigSchema.parse({ skills: { selection: { include: ["b"] } } });
    const reason = ensureSkillLock(t.engine, { discover: () => reg(a(), b()), commitOf, canonical: canon() });
    expect(reason).toMatch(/^skill selection is blocked: /);
    expect(reason).toContain('"b" is always loaded');
    expect(reason).not.toContain("skills not resolved");
    expect(existsSync(file(t.runDir))).toBe(false);
    expect(t.summary.skillSelection).toBeUndefined();
  });

  it("a high-risk tie blocks and neither skill is dropped", () => {
    const t = setup(gateOutput(["a", "b"]));
    const reason = ensureSkillLock(t.engine, { discover: () => reg(a(), sk("b", { caps: ["cap"], source: "admin" })), commitOf, canonical: canon({}, ["cap"]) });
    expect(reason).toMatch(/^skill selection is blocked: /);
    expect(reason).toContain("Pin one of them");
    expect(t.logs.some((l) => l.includes("left out"))).toBe(false);
    expect(existsSync(file(t.runDir))).toBe(false);
  });

  it("a project pin resolves the tie and the decision is kept", () => {
    const t = setup(gateOutput(["a", "b"]));
    const bAdmin = () => sk("b", { caps: ["cap"], source: "admin" });
    const deps = canon({ choices: { pins: pins("b@1.0.0"), now: NOW } }, ["cap"]);
    expect(ensureSkillLock(t.engine, { discover: () => reg(a(), bAdmin()), commitOf, canonical: deps })).toBeUndefined();
    expect(lockedIds(t.runDir)).toEqual(["b"]);
    expect(t.logs).toContain("    · skill lock: a left out: not-canonical");
    expect(t.summary.skillSelection!.canonical[0]).toMatchObject({ winner: "b@1.0.0", decidedBy: "project-pin", rejected: [{ skill: "a@1.0.0" }] });
  });

  it("a pin on a skill that was not requested is judged, not 'not installed'", () => {
    const t = setup(gateOutput(["b"]));
    const deps = canon({ choices: { pins: pins("a@1.0.0"), now: NOW } });
    expect(ensureSkillLock(t.engine, { discover: () => reg(a(), b()), commitOf, canonical: deps })).toBeUndefined();
    expect(t.logs).toContain("    · skill lock: b left out: not-canonical");
    expect(t.summary.skillSelection!.canonical[0]).toMatchObject({ winner: "a@1.0.0", decidedBy: "project-pin" });
  });

  it("an expired override blocks", () => {
    const t = setup(gateOutput(["a", "b"]));
    const old = { ...pin("b@1.0.0"), expires: "2026-02-01T00:00:00Z", scope: "all" as const };
    const reason = ensureSkillLock(t.engine, { discover: () => reg(a(), b()), commitOf, canonical: canon({ choices: { overrides: [old], now: NOW } }) });
    expect(reason).toMatch(/^skill selection is blocked: /);
    expect(reason).toContain("has expired");
    expect(existsSync(file(t.runDir))).toBe(false);
  });

  it("a dependency that is not canonical blocks", () => {
    const t = setup(gateOutput(["a", "c"]));
    const reason = ensureSkillLock(t.engine, { discover: () => reg(a(), b(), sk("c", { deps: ["b"], caps: ["other"] })), commitOf, canonical: canon() });
    expect(reason).toMatch(/^skill selection is blocked: /);
    expect(reason).toContain('"b" is loaded as a dependency of "c"');
    expect(existsSync(file(t.runDir))).toBe(false);
  });

  it("with no exclusive capability the lock and run.json are as before", () => {
    const t = setup(gateOutput(["a", "b"]));
    expect(ensureSkillLock(t.engine, { discover: () => reg(a(), b()), commitOf })).toBeUndefined();
    expect(lockedIds(t.runDir)).toEqual(["a", "b"]);
    expect(t.summary).not.toHaveProperty("skillSelection");
    expect(t.logs.some((l) => l.includes("not-canonical"))).toBe(false);
  });

  it("uses the live dependencies when the config sets exclusive: a work tree that is not a repository stops the lock", () => {
    const t = setup(gateOutput(["a", "b"]));
    t.engine.config = ConfigSchema.parse({ skills: { selection: { exclusive: ["cap"] } } });
    const reason = ensureSkillLock(t.engine, { discover: () => reg(a(), b()), commitOf });
    expect(reason).toMatch(/^skill selection is blocked: /);
    expect(reason).toContain("project pins");
    expect(existsSync(file(t.runDir))).toBe(false);
  });

  it("does not judge a verified lock again", () => {
    const t = setup(gateOutput(["a", "b"]));
    const candidate = vi.fn((s: RegisteredSkill) => canonicalFromRegistered(s));
    const deps = { discover: () => reg(a(), b()), commitOf, canonical: canon({ candidate }) };
    expect(ensureSkillLock(t.engine, deps)).toBeUndefined();
    const calls = candidate.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(ensureSkillLock(t.engine, deps)).toBeUndefined();
    expect(candidate.mock.calls.length).toBe(calls);
  });

  it("saves the decision before the lock file, and repairs it after a crash between the writes", () => {
    const t = setup(gateOutput(["a", "b"]));
    const seen: { lockFile: boolean; selection: boolean }[] = [];
    t.save.mockImplementation(() => seen.push({ lockFile: existsSync(file(t.runDir)), selection: t.summary.skillSelection !== undefined }));
    const deps = { discover: () => reg(a(), b()), commitOf, canonical: canon() };
    expect(ensureSkillLock(t.engine, deps)).toBeUndefined();
    expect(seen).toEqual([{ lockFile: false, selection: true }, { lockFile: true, selection: true }]);
    const decision = JSON.stringify(t.summary.skillSelection);
    // a crash after the lock file but before the summary: the decision of this plan stays
    delete t.summary.skillLock;
    expect(ensureSkillLock(t.engine, deps)).toBeUndefined();
    expect(t.summary.skillLock).toBeDefined();
    expect(JSON.stringify(t.summary.skillSelection)).toBe(decision);
    // an older summary with the decision of another plan: it is removed and never ranked again
    delete t.summary.skillLock;
    t.summary.skillSelection = { planHash: digestOf("9"), canonical: [] };
    expect(ensureSkillLock(t.engine, deps)).toBeUndefined();
    expect(t.summary.skillSelection).toBeUndefined();
    expect(t.summary.skillLock).toBeDefined();
  });
});
