import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { RunSummary } from "../src/engine/state.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import type { SkillRequest } from "../src/skills/request.js";
import { resolveSkills } from "../src/skills/resolve.js";
import { buildRunSkillLock, planHashOf, runSkillLockSummary, sha256Of, serializeRunSkillLock, type RunSkillLock, type RunSkillLockRead } from "../src/skills/run-lock.js";
import { assessSkills } from "../src/skills/unresolved.js";
import { evidenceView, runSkillView, type RunSkillView } from "../src/server/skill-view.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
function sk(id: string, o: { version?: string; digest?: string; pin?: string; trust?: string; deps?: string[]; category?: string } = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "skills.roots[0]", dir: "/secret/dir", active: true,
    trust: o.trust ?? "approved", pin: o.pin ?? "pinned", digest: o.digest ?? digestOf("a"),
    pkg: { id, version, description: `About ${id}.`, instructions: "BODY", category: o.category, roles: [], dependencies: (o.deps ?? []).map((d) => ({ id: d })), conflicts: [] },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [], notes: [], sources: [] });
const request = (...items: { id: string; reason?: string; evidence?: string[] }[]): SkillRequest => ({
  version: 1,
  skills: items.map((i) => ({ id: i.id, reason: i.reason ?? "Needed for the change", evidence: i.evidence ?? ["catalogue:" + i.id] })),
});

const AT = Date.parse("2026-01-02T00:00:00Z");
const policy = ConfigSchema.parse({}).skills.unresolved;
const gateOutput = (req: SkillRequest) => `READY\nSKILL_REQUEST: ${JSON.stringify(req)}`;
const rec = (id: string, over: any = {}) => ({ id, type: "shell", visit: 1, ok: true, output: "", startedAt: "2026-01-01T00:00:00Z", durationMs: 1, logFile: "/x/log", ...over });
const GATE_DEF = { id: "risk_gate", type: "shell", run: "$FACTORY_TOOLS/skill-request" };

/** A run with a checked gate for `req`; `over` replaces any field. */
function runOf(req: SkillRequest, over: any = {}): RunSummary {
  return {
    runId: "run-1", runDir: "/srv/runs/run-1", workdir: "/srv/work/run-1", repo: "/srv/repo",
    flowDef: { name: "f", steps: [GATE_DEF] }, history: [rec("risk_gate", { output: gateOutput(req) })], ...over,
  } as unknown as RunSummary;
}
function lockOf(r: ReturnType<typeof reg>, req: SkillRequest, o: { planHash?: string; runId?: string } = {}): RunSkillLock {
  const resolution = resolveSkills(r, req.skills.map((s) => s.id));
  return buildRunSkillLock({
    runId: o.runId ?? "run-1", resolution, request: req, sourceOf: () => "admin", planHash: o.planHash ?? planHashOf(gateOutput(req)),
    categoryOf: (id, v) => r.byKey.get(`${id}@${v}`)?.pkg.category, commit: "f".repeat(40), now: new Date("2026-01-01T00:00:00Z"),
  });
}
const read = (lock: RunSkillLock): RunSkillLockRead => ({ ok: true, lock, lockDigest: sha256Of(serializeRunSkillLock(lock)) });
const summaryOf = (lock: RunSkillLock) => runSkillLockSummary(lock, sha256Of(serializeRunSkillLock(lock)));
const planOf = (r: ReturnType<typeof reg>, req: SkillRequest, over: any = {}) => ({
  ...assessSkills(resolveSkills(r, req.skills.map((s) => s.id)), r, policy), gate: "risk_gate", at: "2026-01-01T00:00:00Z", checks: 1, ...over,
});
const unresolvedItem = (over: any) => ({
  id: "a", code: "unknown", kind: "unknown", risk: "low", action: "stop", because: "policy", mandatory: false, message: "No skill a is installed.", ...over,
});
const view = (run: RunSummary, o: any = {}): RunSkillView | undefined => runSkillView(run, { admin: false, ...o });
const missing = () => ({ ok: false, reason: "missing" }) as RunSkillLockRead;
const withRegistry = (r: any) => () => ({ registry: r, at: AT });

/** Every key name found anywhere in a value. */
function keys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keys(x, out));
  return out;
}

describe("runSkillView: nothing to show", () => {
  it("gives undefined for an old run and does not read the lock", () => {
    const readLock = vi.fn();
    expect(view({ runId: "r", runDir: "/x", history: [] } as unknown as RunSummary, { readLock })).toBeUndefined();
    expect(readLock).not.toHaveBeenCalled();
  });
  it("gives undefined for a lock with no skills and a request with none", () => {
    const req = request();
    const lock = lockOf(reg(), req);
    expect(view(runOf(req, { skillLock: summaryOf(lock) }), { readLock: () => read(lock) })).toBeUndefined();
  });
  it("keeps a view for a plan that stopped with nothing listed", () => {
    const req = request({ id: "a" });
    const run = runOf(req, { skillPlan: { version: 1, role: "coder", action: "stop", selected: [], unresolved: [], warnings: [], reason: "skills not resolved: x", gate: "risk_gate", at: "t", checks: 1 } });
    expect(view(run, { readLock: missing })).toMatchObject({ lock: "none", action: "stop", resolved: [], requested: [{ id: "a", state: "not-checked" }] });
    const bare = runOf(request(), { skillPlan: { version: 1, role: "coder", action: "stop", selected: [], unresolved: [], warnings: [], reason: "r", gate: "risk_gate", at: "t", checks: 1 } });
    expect(view(bare, { readLock: missing })).toMatchObject({ action: "stop", requested: [], resolved: [] });
  });
});

describe("runSkillView: selected skills", () => {
  const r = reg(sk("a", { deps: ["b"], category: "testing" }), sk("b", { version: "2.1.0", digest: digestOf("b"), category: "base" }));
  const req = request({ id: "a", evidence: ["path:src/x.ts", "issue:#12", "catalogue:a"] });
  const lock = lockOf(r, req);
  const run = () => runOf(req, { skillLock: summaryOf(lock), skillPlan: planOf(r, req) });

  it("lists the resolved skills in load order with everything the lock holds", () => {
    const v = view(run(), { readLock: () => read(lock), registry: withRegistry(r) })!;
    expect(v.lock).toBe("ok");
    expect(v.resolved.map((x) => `${x.id}@${x.version}`)).toEqual(["b@2.1.0", "a@1.0.0"]);
    expect(v.resolved[0]).toMatchObject({ selection: "dependency", requiredBy: ["a"], category: "base", integrity: "verified" });
    expect(v.resolved[1]).toMatchObject({
      selection: "requested", category: "testing", reason: "Needed for the change", integrity: "verified",
      evidence: [{ kind: "path", text: "src/x.ts" }, { kind: "issue", text: "12" }, { kind: "catalogue", text: "a" }],
    });
    expect(typeof v.resolved[1]!.estimatedTokens).toBe("number");
    expect(v.requested).toEqual([expect.objectContaining({ id: "a", version: "1.0.0", by: "plan", state: "selected", reason: "Needed for the change" })]);
    expect(v.action).toBe("continue");
    expect(v.checkedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(v.estimatedTokens).toBe(lock.estimatedTokens);
  });
});

describe("runSkillView: requested states", () => {
  const req = request({ id: "a" }, { id: "b" });
  const planWith = (u: any[]) => ({ version: 1, role: "coder", action: "stop", selected: [], unresolved: u, warnings: [], reason: "r", gate: "risk_gate", at: "t", checks: 1 });
  it.each([
    ["unknown", "unknown", undefined, "missing"],
    ["dependency-unavailable", "missing", "unknown", "missing"],
    ["dependency-unavailable", "untrusted", "unpinned", "not-approved"],
    ["dependency-unavailable", "oversized", "too-large", "too-large"],
    ["conflict", "conflict", undefined, "conflicting"],
    ["unpinned", "untrusted", undefined, "not-approved"],
    ["too-large", "oversized", undefined, "too-large"],
  ])("maps code %s (kind %s, cause %s) to %s", (code, kind, cause, state) => {
    const run = runOf(req, { skillPlan: planWith([unresolvedItem({ code, kind, cause, version: "1.0.0", message: "Fix it." })]) });
    const v = view(run, { readLock: missing })!;
    expect(v.requested.find((x) => x.id === "a")).toMatchObject({ state, code, message: "Fix it.", action: "stop", version: "1.0.0", by: "plan" });
  });
  it("marks a requested id that is in neither list as not checked", () => {
    const run = runOf(req, { skillPlan: planWith([unresolvedItem({})]) });
    expect(view(run, { readLock: missing })!.requested.find((x) => x.id === "b")).toMatchObject({ state: "not-checked", by: "plan" });
  });
  it("names the administrator for mandatory skills, unresolved or selected", () => {
    const r = reg(sk("m"));
    const plan = {
      ...planWith([unresolvedItem({ id: "z", mandatory: true, because: "mandatory" })]),
      selected: [{ id: "m", version: "1.0.0", digest: digestOf("a"), selection: "mandatory", requiredBy: [], estimatedTokens: 3 }],
    };
    const v = view(runOf(req, { skillPlan: plan }), { readLock: missing, registry: withRegistry(r) })!;
    expect(v.requested).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "z", by: "administrator", state: "missing" }),
      expect.objectContaining({ id: "m", by: "administrator", state: "selected" }),
    ]));
  });
  it("takes a mandatory skill from the lock when the plan is old", () => {
    const r = reg(sk("m"));
    const q = request();
    const resolution = resolveSkills(r, [], { include: ["m"] });
    const lock = buildRunSkillLock({ runId: "run-1", resolution, request: q, sourceOf: () => "admin", planHash: planHashOf(gateOutput(q)) });
    const old = { version: 1, role: "coder", action: "continue", selected: [{ id: "m", version: "1.0.0", digest: digestOf("a") }], unresolved: [], warnings: [], gate: "risk_gate", at: "t", checks: 1 };
    const v = view(runOf(q, { skillPlan: old, skillLock: summaryOf(lock) }), { readLock: () => read(lock) })!;
    expect(lock.skills[0]?.selection).toBe("mandatory");
    expect(v.requested).toEqual([expect.objectContaining({ id: "m", by: "administrator", state: "selected" })]);
  });
});

describe("runSkillView: the lock", () => {
  const r = reg(sk("a"));
  const req = request({ id: "a" });
  const lock = lockOf(r, req);
  const base = () => runOf(req, { skillPlan: planOf(r, req) });

  it("shows a valid lock when run.json has no summary", () => {
    const v = view(base(), { readLock: () => read(lock) })!;
    expect(v.lock).toBe("ok");
    expect(v.resolved.map((x) => x.id)).toEqual(["a"]);
  });
  it("is none when there is no summary and no file", () => {
    expect(view(base(), { readLock: missing })).toMatchObject({ lock: "none", resolved: [expect.objectContaining({ id: "a", integrity: "not-locked" })] });
  });
  it.each([
    ["missing", () => missing()],
    ["unreadable", () => ({ ok: false, reason: "unreadable" }) as RunSkillLockRead],
    ["invalid", () => ({ ok: false, reason: "invalid" }) as RunSkillLockRead],
    ["another run", () => read(lockOf(r, req, { runId: "other" }))],
    ["another digest", () => ({ ...read(lock), lockDigest: digestOf("9") })],
    ["a throw", () => { throw new Error("boom"); }],
  ])("names a lock that is %s and lists the summary without calling it verified", (name, readLock) => {
    const run = { ...base(), skillLock: summaryOf(lock) } as RunSummary;
    const registry = vi.fn(withRegistry(r));
    const v = view(run, { readLock, registry })!;
    expect(v.lock).toBe(name === "missing" ? "missing" : "changed");
    expect(v.resolved).toEqual([expect.objectContaining({ id: "a", version: "1.0.0", integrity: "not-checked" })]);
    expect(registry).not.toHaveBeenCalled();
    expect(v.checkedAt).toBeUndefined();
  });
  it("is changed for an unreadable file even without a summary", () => {
    expect(view(base(), { readLock: () => ({ ok: false, reason: "unreadable" }) })!.lock).toBe("changed");
  });
  it("does not call the registry for a lock with no skills", () => {
    const q = request();
    const registry = vi.fn(withRegistry(r));
    const empty = lockOf(reg(), q);
    view(runOf(q, { skillPlan: { ...planOf(reg(), q), action: "warn" } }), { readLock: () => read(empty), registry });
    expect(registry).not.toHaveBeenCalled();
  });
});

describe("runSkillView: planned again", () => {
  it("shows the old lock and the current plan", () => {
    const r = reg(sk("a"), sk("b"));
    const oldReq = request({ id: "a" });
    const newReq = request({ id: "b" }, { id: "a" });
    const lock = lockOf(r, oldReq);
    const plan = {
      version: 1, role: "coder", action: "stop", warnings: [], reason: "r", gate: "risk_gate", at: "t", checks: 2,
      selected: [{ id: "b", version: "1.0.0", digest: digestOf("a") }],
      unresolved: [unresolvedItem({ id: "a", code: "unpinned", kind: "untrusted" })],
    };
    const v = view(runOf(newReq, { skillLock: summaryOf(lock), skillPlan: plan }), { readLock: () => read(lock), registry: withRegistry(r) })!;
    expect(v.planChanged).toBe(true);
    expect(v.lock).toBe("ok");
    expect(v.resolved.map((x) => x.id)).toEqual(["a"]);
    expect(v.requested).toEqual([
      expect.objectContaining({ id: "b", state: "selected" }),
      expect.objectContaining({ id: "a", state: "not-approved", code: "unpinned" }),
    ]);
  });
  it("does not pair a new request with the plan of the earlier gate", () => {
    const r = reg(sk("a"), sk("b"));
    const oldReq = request({ id: "a" });
    const newReq = request({ id: "a" }, { id: "b" });
    const lock = lockOf(r, oldReq);
    const oldPlan = { ...planOf(r, oldReq), planHash: planHashOf(gateOutput(oldReq)) };
    const v = view(runOf(newReq, { skillLock: summaryOf(lock), skillPlan: oldPlan }), { readLock: () => read(lock) })!;
    expect(v.action).toBeUndefined();
    expect(v.requested.map((x) => `${x.id}:${x.state}`)).toEqual(["a:not-checked", "b:not-checked"]);
    const same = { ...planOf(r, oldReq), planHash: planHashOf(gateOutput(oldReq)) };
    expect(view(runOf(oldReq, { skillLock: summaryOf(lock), skillPlan: same }), { readLock: () => read(lock) })!.action).toBe("continue");
  });
  it("calls a lock of an earlier plan changed unless the summary matches it exactly", () => {
    const r = reg(sk("a"));
    const lock = lockOf(r, request({ id: "a" }));
    const newReq = request({ id: "a", reason: "Another reason" });
    const go = (skillLock: unknown) => view(runOf(newReq, { skillLock }), { readLock: () => read(lock) })!.lock;
    expect(go(summaryOf(lock))).toBe("ok");
    expect(go(undefined)).toBe("changed");
    expect(go({ ...summaryOf(lock), planHash: digestOf("9") })).toBe("changed");
    expect(go({ ...summaryOf(lock), lockDigest: digestOf("9") })).toBe("changed");
  });
  it("shows no context from before the new plan", () => {
    const r = reg(sk("a"));
    const req1 = request({ id: "a", reason: "First" });
    const req2 = request({ id: "a", reason: "Second" });
    const lock = lockOf(r, req2);
    const history = [
      rec("risk_gate", { output: gateOutput(req1) }),
      rec("implement", { skills: { loaded: ["a@1.0.0"], bytes: 1, estimatedTokens: 1, state: "loaded" } }),
      rec("risk_gate", { output: gateOutput(req2) }),
    ];
    const v = view(runOf(req2, { history, skillLock: summaryOf(lock) }), { readLock: () => read(lock) })!;
    expect(v.resolved[0]!.context).toBeUndefined();
    const later = [...history, rec("implement", { skills: { loaded: ["a@1.0.0"], bytes: 1, estimatedTokens: 1, state: "reloaded" } })];
    expect(view(runOf(req2, { history: later, skillLock: summaryOf(lock) }), { readLock: () => read(lock) })!.resolved[0]).toMatchObject({ context: "reloaded", contextStep: "implement" });
  });
});

describe("runSkillView: a plan that is no longer current", () => {
  it("lists what the plan could not use and what the lock holds, without an action", () => {
    const r = reg(sk("a"));
    const req = request({ id: "a" });
    const lock = lockOf(r, req);
    const plan = { version: 1, role: "coder", action: "stop", selected: [], unresolved: [unresolvedItem({ id: "x", code: "unknown", kind: "unknown" }), unresolvedItem({ id: "m", mandatory: true })], warnings: [], reason: "r", gate: "risk_gate", at: "t", checks: 1 };
    const history = [rec("risk_gate", { output: gateOutput(req) }), rec("plan", { output: "a new draft" })];
    const v = view(runOf(req, { history, skillLock: summaryOf(lock), skillPlan: plan }), { readLock: () => read(lock) })!;
    expect(v.action).toBeUndefined();
    expect(v.requested).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a", state: "selected", by: "plan" }),
      expect.objectContaining({ id: "x", state: "missing", by: "plan" }),
      expect.objectContaining({ id: "m", by: "administrator" }),
    ]));
  });
});

describe("runSkillView: before the lock", () => {
  it("shows the true selection of the plan", () => {
    const r = reg(sk("a", { deps: ["b"], category: "testing" }), sk("b", { category: "base" }));
    const req = request({ id: "a" });
    const v = view(runOf(req, { skillPlan: planOf(r, req) }), { readLock: missing })!;
    expect(v.lock).toBe("none");
    const b = v.resolved.find((x) => x.id === "b")!;
    expect(b).toMatchObject({ selection: "dependency", requiredBy: ["a"], category: "base", integrity: "not-locked" });
    expect(typeof b.estimatedTokens).toBe("number");
    expect(v.resolved.find((x) => x.id === "a")).toMatchObject({ selection: "requested", category: "testing" });
  });
  it("shows an old plan entry with no selection", () => {
    const req = request({ id: "a" });
    const old = { version: 1, role: "coder", action: "continue", selected: [{ id: "a", version: "1.0.0", digest: digestOf("a") }], unresolved: [], warnings: [], gate: "risk_gate", at: "t", checks: 1 };
    const row = view(runOf(req, { skillPlan: old }), { readLock: missing })!.resolved[0]!;
    expect(row).toMatchObject({ id: "a", version: "1.0.0", integrity: "not-locked", requiredBy: [] });
    expect("selection" in row).toBe(false);
  });
});

describe("runSkillView: integrity and category", () => {
  const req = request({ id: "a" });
  const lock = lockOf(reg(sk("a")), req);
  const run = () => runOf(req, { skillLock: summaryOf(lock) });
  const integrityOf = (registry: any) => view(run(), { readLock: () => read(lock), registry })!.resolved[0]!.integrity;

  it("verified when the registry matches", () => expect(integrityOf(withRegistry(reg(sk("a"))))).toBe("verified"));
  it("changed for another digest", () => expect(integrityOf(withRegistry(reg(sk("a", { digest: digestOf("d") }))))).toBe("changed"));
  it("missing when the package is gone", () => expect(integrityOf(withRegistry(reg()))).toBe("missing"));
  it("unpinned when the pin is gone", () => expect(integrityOf(withRegistry(reg(sk("a", { pin: "unpinned" }))))).toBe("unpinned"));
  it("not checked when the registry throws or is absent, and then has no time", () => {
    const v = view(run(), { readLock: () => read(lock), registry: () => { throw new Error("x"); } })!;
    expect(v.resolved[0]!.integrity).toBe("not-checked");
    expect(v.checkedAt).toBeUndefined();
    expect(integrityOf(undefined)).toBe("not-checked");
  });
  it("takes the category from the lock even when the package is gone", () => {
    const r = reg(sk("a", { category: "testing" }));
    const l = lockOf(r, req);
    const v = view(runOf(req, { skillLock: summaryOf(l) }), { readLock: () => read(l), registry: withRegistry(reg()) })!;
    expect(v.resolved[0]).toMatchObject({ category: "testing", integrity: "missing" });
  });
  it("falls back to the registry for a lock without a category, only for the same digest", () => {
    const l = lockOf(reg(sk("a")), req);
    const one = (r: any) => view(run(), { readLock: () => read(l), registry: withRegistry(r) })!.resolved[0]!.category;
    expect(one(reg(sk("a", { category: "testing" })))).toBe("testing");
    expect(one(reg(sk("a", { category: "testing", digest: digestOf("d") })))).toBeUndefined();
  });
});

describe("runSkillView: context in the session", () => {
  const req = request({ id: "a" }, { id: "b" });
  const r = reg(sk("a"), sk("b"));
  const lock = lockOf(r, req);
  const run = (sessions: any[]) =>
    runOf(req, { history: [rec("risk_gate", { output: gateOutput(req) }), ...sessions], skillLock: summaryOf(lock) });
  const rows = (sessions: any[]) => view(run(sessions), { readLock: () => read(lock) })!.resolved;
  const S = (id: string, skills: any) => rec(id, { type: "claude", skills: { bytes: 1, estimatedTokens: 1, loaded: ["a@1.0.0"], ...skills } });

  it("gives the last state and its step", () => {
    expect(rows([S("s1", { state: "loaded" }), S("s2", { state: "reused" }), S("s3", { state: "reloaded" })])[0]).toMatchObject({ context: "reloaded", contextStep: "s3" });
    expect(rows([S("s1", { state: "loaded" }), S("s2", { state: "reused" })])[0]).toMatchObject({ context: "reused", contextStep: "s2" });
  });
  it("gives loaded for a record without a state, and leaves a malformed state out", () => {
    expect(rows([S("s1", {})])[0]).toMatchObject({ context: "loaded" });
    expect(rows([S("s1", { state: "bogus" })])[0]!.context).toBeUndefined();
  });
  it("gives omitted for a skill left out", () => {
    expect(rows([S("s1", { loaded: ["b@1.0.0"], omitted: ["a@1.0.0"] })])[0]).toMatchObject({ id: "a", context: "omitted", contextStep: "s1" });
  });
  it("marks review checks without changing the context", () => {
    const [a] = rows([S("s1", { state: "loaded" }), S("rev", { role: "reviewer", state: "reloaded" })]);
    expect(a).toMatchObject({ context: "loaded", contextStep: "s1", review: true });
  });
  it("ignores records with malformed ids and lists", () => {
    expect(() => rows([S("bad id!", {}), S("s1", { loaded: "x" }), rec("s2", { skills: 5 }), rec("s3", { skills: { loaded: [1, null, "a@1.0.0"], state: "reused" } })])).not.toThrow();
    expect(rows([S("bad id!", {})])[0]!.context).toBeUndefined();
  });
});

describe("runSkillView: what is left out", () => {
  const r = reg(sk("a", { category: "testing" }));
  const req = request({ id: "a", reason: "Needed", evidence: ["issue:12"] });
  const lock = lockOf(r, req);
  const run = () => runOf(req, { skillLock: summaryOf(lock), skillPlan: planOf(r, req) });

  it("gives a user no digest, source or commit, and an administrator all three", () => {
    const user = view(run(), { admin: false, readLock: () => read(lock), registry: withRegistry(r) });
    const names = keys(user);
    for (const k of ["digest", "source", "commit"]) expect(names.has(k)).toBe(false);
    const admin = view(run(), { admin: true, readLock: () => read(lock), registry: withRegistry(r) })!;
    expect(admin.resolved[0]).toMatchObject({ digest: digestOf("a"), source: "admin" });
    expect(admin.commit).toBe("f".repeat(40));
  });
  it("shows no digest from the summary or the plan to a user", () => {
    const user = view(run(), { readLock: () => ({ ok: false, reason: "invalid" }) });
    expect(keys(user).has("digest")).toBe(false);
    expect(keys(view(runOf(req, { skillPlan: planOf(r, req) }), { readLock: missing })).has("digest")).toBe(false);
    expect(keys(view(runOf(req, { skillPlan: planOf(r, req) }), { admin: true, readLock: missing })).has("digest")).toBe(true);
  });
  it("shows nothing of a package", () => {
    for (const admin of [false, true]) {
      const text = JSON.stringify(view(run(), { admin, readLock: () => read(lock), registry: withRegistry(r) }));
      for (const t of ["/secret/dir", "BODY", "skills.roots"]) expect(text).not.toContain(t);
    }
  });
  it("drops a request reason that holds a path", () => {
    const q = request({ id: "a", reason: "see /etc/x" });
    const v = view(runOf(q), { readLock: missing })!;
    expect(v.requested[0]!.reason).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("/etc/x");
  });
  it("replaces the folder of the run in a message", () => {
    const plan = { version: 1, role: "coder", action: "stop", selected: [], warnings: [], reason: "r", gate: "risk_gate", at: "t", checks: 1, unresolved: [unresolvedItem({ message: "It is in /srv/work/run-1 only." })] };
    const v = view(runOf(request({ id: "a" }), { skillPlan: plan }), { readLock: missing })!;
    expect(v.requested[0]!.message).toBe("It is in (folder) only.");
  });
});

describe("evidenceView", () => {
  it("keeps a safe relative path and drops other paths", () => {
    expect(evidenceView("path:src/a.ts")).toEqual({ kind: "path", text: "src/a.ts" });
    expect(evidenceView("path:../x")).toEqual({ kind: "path", text: "omitted" });
    expect(evidenceView("path:/abs")).toEqual({ kind: "path", text: "omitted" });
  });
  it("reads an issue with or without the hash and drops free text", () => {
    expect(evidenceView("issue:12")).toEqual({ kind: "issue", text: "12" });
    expect(evidenceView("issue:#12")).toEqual({ kind: "issue", text: "12" });
    expect(evidenceView("issue:free text")).toEqual({ kind: "issue", text: "omitted" });
    expect(evidenceView("issue:omitted")).toEqual({ kind: "issue", text: "omitted" });
  });
  it("keeps a catalogue entry, drops an unsafe one, and rejects unknown input", () => {
    expect(evidenceView("catalogue:testing")).toEqual({ kind: "catalogue", text: "testing" });
    expect(evidenceView("catalogue:token=abcdef")).toEqual({ kind: "catalogue", text: "omitted" });
    expect(evidenceView("other:x")).toBeUndefined();
    expect(evidenceView(5)).toBeUndefined();
    expect(evidenceView(undefined)).toBeUndefined();
  });
});

describe("runSkillView: bad input", () => {
  it("never throws", () => {
    const req = request({ id: "a" });
    const bad = [
      runOf(req, { skillPlan: { unresolved: "x", selected: 5 } }),
      runOf(req, { history: null, skillLock: { skills: "x" } }),
      runOf(req, { skillPlan: { selected: [null, { id: 5 }, { id: "a", version: 7 }], unresolved: [null, { id: "a", kind: "nope" }, { id: "a", kind: "unknown", message: 5, code: {} }] } }),
      runOf(req, { skillLock: { skills: [null, { id: "a", version: "x" }, { id: "A!", version: "1.0.0" }] } }),
      { runDir: 5, skillLock: 7 } as unknown as RunSummary,
    ];
    for (const run of bad) for (const readLock of [missing, () => { throw new Error("x"); }, () => ({ ok: false, reason: "invalid" }) as RunSkillLockRead]) {
      expect(() => view(run, { readLock, registry: () => { throw new Error("x"); } })).not.toThrow();
    }
  });
  it("copies only checked values", () => {
    const run = runOf(request({ id: "a" }), {
      skillPlan: { version: 1, role: "coder", action: "bogus", selected: [], warnings: [], gate: "risk_gate", at: "t", checks: 1, unresolved: [unresolvedItem({ code: "<b>", action: "<i>", version: "x y", message: { a: 1 } })] },
    });
    const v = view(run, { readLock: missing })!;
    expect(v.action).toBeUndefined();
    expect(v.requested[0]).toMatchObject({ id: "a", by: "plan", state: "missing" });
    for (const k of ["code", "action", "version", "message"]) expect(k in v.requested[0]!).toBe(false);
  });
});
