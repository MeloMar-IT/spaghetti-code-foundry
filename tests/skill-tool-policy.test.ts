import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { DEFAULT_PERMISSION_MODE } from "../src/engine/execute.js";
import { parseFlow } from "../src/flow/load.js";
import { SKILL_REFUSED_RE } from "../src/skills/eval.js";
import {
  FLOW_DEFAULT_MODE, SKILL_TOOLS_PREFIX, assessSkillTools, checkSkillTools, flowTools, sessionToolGrant, sessionTools, skillNeeds,
  type Capabilities, type SkillToolNeed,
} from "../src/skills/tool-policy.js";
import { flowPath } from "./helpers/fake-github.js";

const policy = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ skills: { tools: over } }).skills.tools;
const profile = (over: Record<string, unknown> = {}) => ({ shell: false, network: false, filesystem: "read" as const, ...over });
interface NeedOver { selection?: SkillToolNeed["selection"]; requiredBy?: string[]; profile?: Record<string, unknown>; connectors?: string[]; deps?: string[] }
const need = (id: string, over: NeedOver = {}): SkillToolNeed => ({
  key: `${id}@1.0.0`, id, selection: over.selection ?? "requested", requiredBy: over.requiredBy ?? [],
  pkg: {
    tool_profile: profile(over.profile) as never,
    connectors: over.connectors ?? [],
    dependencies: (over.deps ?? []).map((d) => ({ id: d })) as never,
  },
});
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  shell: true, network: true, filesystem: "write", sources: { shell: "s", network: "n", filesystem: "f" }, ...over,
});
const st = (o: { step?: object; defaults?: object; sandbox?: object } = {}) =>
  sessionTools({ stepId: "x", step: o.step ?? {}, defaults: o.defaults ?? {}, sandbox: { boxed: false, ...o.sandbox } });

describe("sessionTools", () => {
  it("keeps the default mode equal to the engine's", () => expect(FLOW_DEFAULT_MODE).toBe(DEFAULT_PERMISSION_MODE));

  it("gives write only for no mode and no rules", () => {
    const t = st();
    expect(t.mode).toEqual({ value: "acceptEdits", source: "default" });
    expect(t.approved).toEqual({ rules: [], source: "none" });
    expect(t.capabilities).toEqual({ shell: false, network: false, filesystem: "write", sources: { shell: "none", network: "none", filesystem: "default" } });
  });
  it("plan gives read only, whatever the rules and sandbox say", () => {
    const t = st({ step: { permission_mode: "plan", allowed_tools: ["Bash", "WebFetch", "Edit"] }, sandbox: { step: true } });
    expect(t.sandbox).toBe(true);
    expect(t.capabilities).toEqual({ shell: false, network: false, filesystem: "read", sources: { shell: "none", network: "none", filesystem: "none" } });
  });
  it.each(["bypassPermissions", "auto"])("%s gives everything", (m) => {
    const c = st({ step: { permission_mode: m } }).capabilities;
    expect([c.shell, c.network, c.filesystem]).toEqual([true, true, "write"]);
    expect(c.sources).toEqual({ shell: "flow:step:x", network: "flow:step:x", filesystem: "flow:step:x" });
  });
  it("dontAsk gives what the rules name", () => {
    expect(st({ step: { permission_mode: "dontAsk" } }).capabilities).toMatchObject({ shell: false, network: false, filesystem: "read" });
    const c = st({ defaults: { permission_mode: "dontAsk", allowed_tools: ["Bash(npm test:*)", "WebSearch", "Edit"] } }).capabilities;
    expect([c.shell, c.network, c.filesystem]).toEqual([true, true, "write"]);
    expect(c.sources.shell).toBe("flow:defaults");
  });
  it("default gives write plus the rules", () => {
    const c = st({ step: { permission_mode: "default", allowed_tools: ["Read"] } }).capabilities;
    expect([c.shell, c.network, c.filesystem]).toEqual([false, false, "write"]);
  });
  it("takes sources from the step or the defaults", () => {
    expect(st({ defaults: { allowed_tools: ["Bash"] } }).capabilities.sources.shell).toBe("flow:defaults");
    expect(st({ step: { allowed_tools: ["Bash"] } }).capabilities.sources.shell).toBe("flow:step:x");
    expect(st({ step: { permission_mode: "plan" }, defaults: { permission_mode: "auto" } }).capabilities.shell).toBe(false);
    const hidden = st({ step: { allowed_tools: [] }, defaults: { allowed_tools: ["Bash"] } });
    expect(hidden.capabilities).toMatchObject({ shell: false });
    expect(hidden.approved.source).toBe("none");
  });
  it("takes the sandbox from step, flow or config", () => {
    expect(st({ sandbox: { step: true } }).capabilities.sources.shell).toBe("flow:step:x");
    expect(st({ sandbox: { flow: true } }).capabilities.sources.shell).toBe("flow:sandbox");
    expect(st({ sandbox: { config: true } }).capabilities.sources.shell).toBe("config:sandbox");
    expect(st({ sandbox: { step: false, flow: true } }).capabilities.shell).toBe(false);
    const boxed = st({ sandbox: { flow: true, boxed: true } });
    expect(boxed.sandbox).toBe(false);
    expect(boxed.capabilities.shell).toBe(false);
    expect(st({ defaults: { allowed_tools: ["Bash"] }, sandbox: { flow: true } }).capabilities.sources.shell).toBe("flow:defaults");
  });
  it("matches rules exactly", () => {
    for (const r of ["BashOutput", "mcp__x__Bash", "WebFetcher"]) expect(st({ step: { allowed_tools: [r] } }).capabilities).toMatchObject({ shell: false, network: false });
    expect(st({ step: { allowed_tools: [" Bash "] } }).capabilities.shell).toBe(true);
  });
});

describe("flowTools", () => {
  const cl = (id: string, over: object = {}) => ({ id, type: "claude", prompt: "p", ...over });
  const bash = { allowed_tools: ["Bash"] };
  it("takes the union with the first giver as source", () => {
    const f = flowTools({ steps: [cl("a"), cl("b", { allowed_tools: ["Bash", "WebFetch"] }), cl("c", bash)] });
    expect(f.sessions).toBe(3);
    expect(f.partial).toBe(false);
    expect(f.capabilities).toMatchObject({ shell: true, network: true, filesystem: "write" });
    expect(f.capabilities.sources).toEqual({ shell: "flow:step:b", network: "flow:step:b", filesystem: "flow:step:a" });
  });
  it("skips Codex, shell and approval steps", () => {
    const f = flowTools({
      steps: [cl("a", { agent: "codex", ...bash }), cl("b", { model: "codex:gpt-5", ...bash }), cl("c", { model: " codex:gpt-5 ", ...bash }),
        { id: "d", type: "shell", run: "x" }, { id: "e", type: "approval", message: "m" }],
    });
    expect(f.sessions).toBe(0);
    expect(f.capabilities.shell).toBe(false);
  });
  it("finds the agent from the defaults, trimming model specs", () => {
    expect(flowTools({ defaults: { agent: "codex" }, steps: [cl("a", bash)] }).sessions).toBe(0);
    expect(flowTools({ defaults: { model: " codex:x ", agent: "claude" }, steps: [cl("a", bash)] }).sessions).toBe(0);
    expect(flowTools({ defaults: { agent: "codex" }, steps: [cl("a", { agent: "claude" })] }).sessions).toBe(1);
    expect(flowTools({ defaults: { agent: "codex" }, steps: [cl("a", { model: " claude:sonnet " })] }).sessions).toBe(1);
    expect(flowTools({ defaults: { agent: "codex" }, steps: [cl("a", { model: "sonnet" })] }).sessions).toBe(0);
    expect(flowTools({ defaults: { model: " claude:x ", agent: "codex" }, steps: [cl("a")] }).sessions).toBe(1);
  });
  it("counts parallel children once and marks flow steps partial", () => {
    const f = flowTools({ steps: [cl("a"), cl("b"), { id: "p", type: "parallel", steps: ["a", "b"] }] });
    expect(f.sessions).toBe(2);
    expect(flowTools({ steps: [{ id: "s", type: "flow", flow: "x" }] }).partial).toBe(true);
  });
  it("uses the flow and config sandbox", () => {
    expect(flowTools({ steps: [cl("a")], sandbox: { claude: true } }).capabilities.sources.shell).toBe("flow:step:a");
    expect(flowTools({ steps: [cl("a")] }, true).capabilities.shell).toBe(true);
  });
  it("copes with empty and junk steps", () => {
    for (const steps of [undefined, [], [null, "x", {}, { id: 1, type: "claude" }]] as unknown[][]) {
      const f = flowTools({ steps });
      expect(f).toMatchObject({ sessions: 0, partial: false, capabilities: { shell: false, network: false, filesystem: "read" } });
      expect(f.capabilities.sources).toEqual({ shell: "none", network: "none", filesystem: "none" });
    }
  });
  it("gives no network for a built-in flow", () => {
    const f = parseFlow(readFileSync(flowPath("issue-plan"), "utf8"), flowPath("issue-plan"));
    expect(flowTools(f).capabilities.network).toBe(false);
  });
});

describe("skillNeeds", () => {
  const n = (p: unknown, connectors: string[] = []) => skillNeeds({ tool_profile: p as never, connectors, dependencies: [] });
  it("gives nothing for default, read and none", () => {
    for (const p of [profile(), profile({ filesystem: "none" }), undefined, null, "x"]) expect(n(p)).toEqual([]);
  });
  it("lists shell, network, write, then connectors", () => {
    expect(n(profile({ shell: true, network: true, filesystem: "write" }), ["ibm-mq", "a"])).toEqual(["shell", "network", "write", "connector:ibm-mq", "connector:a"]);
  });
});

describe("checkSkillTools in flow scope", () => {
  const shellSkill = (id = "a", over: NeedOver = {}) => need(id, { profile: { shell: true }, ...over });
  it("continues when all is met, with three sources", () => {
    const c = checkSkillTools([need("a", { profile: { shell: true, filesystem: "write" } })], caps(), policy(), "flow");
    expect(c.action).toBe("continue");
    expect(c.met).toEqual([
      { key: "a@1.0.0", need: "shell", sources: ["skill:a@1.0.0", "policy:skills.tools.shell", "s"] },
      { key: "a@1.0.0", need: "write", sources: ["skill:a@1.0.0", "policy:skills.tools.filesystem", "f"] },
    ]);
  });
  it("refuses what the policy does not allow", () => {
    const code = (p: object, prof: object) => checkSkillTools([need("a", { profile: prof })], caps(), policy(p), "flow").missing[0]?.code;
    expect(code({ shell: false }, { shell: true })).toBe("tool-not-approved");
    expect(code({}, { network: true })).toBe("tool-not-approved");
    expect(code({ filesystem: "read" }, { filesystem: "write" })).toBe("tool-not-approved");
  });
  it("says tool-not-in-flow unless partial", () => {
    const c = caps({ shell: false });
    expect(checkSkillTools([shellSkill()], c, policy(), "flow").missing[0]?.code).toBe("tool-not-in-flow");
    expect(checkSkillTools([shellSkill()], c, policy(), "flow", true)).toMatchObject({ action: "continue", met: [], missing: [] });
  });
  it("checks every need, and the first missing code leads", () => {
    const c = checkSkillTools([shellSkill("a", { connectors: ["ibm-mq"] })], caps(), policy({ shell: false }), "flow");
    expect(c.missing.map((m) => m.code)).toEqual(["tool-not-approved", "connector-unavailable"]);
    expect(c.leftOut[0]?.code).toBe("tool-not-approved");
  });
  it("always refuses a connector", () => {
    const all = policy({ shell: true, network: true, filesystem: "write", missing: "degrade" });
    const c = assessSkillTools([need("a", { connectors: ["ibm-mq"], selection: "mandatory" })], { sessions: 1, partial: true, capabilities: caps() }, all);
    expect(c.missing[0]).toMatchObject({ code: "connector-unavailable", message: "It names the connector ibm-mq. Connectors are not available in this version." });
    expect(c.action).toBe("stop");
    expect(checkSkillTools([need("a", { connectors: ["x"] })], caps(), all, "session").missing[0]?.code).toBe("connector-unavailable");
  });
});

describe("checkSkillTools in session scope", () => {
  it("never stops for tool-not-in-step", () => {
    for (const sel of ["requested", "mandatory"] as const) {
      const r = checkSkillTools([need("a", { profile: { shell: true }, selection: sel })], caps({ shell: false }), policy(), "session");
      expect(r).toMatchObject({ action: "degrade", leftOut: [{ key: "a@1.0.0", code: "tool-not-in-step" }] });
      expect(r.reason).toBeUndefined();
    }
  });
  it("stops for tool-not-approved with the session prefix", () => {
    const r = checkSkillTools([need("a", { profile: { network: true } })], caps(), policy(), "session");
    expect(r.action).toBe("stop");
    expect(r.reason?.startsWith(SKILL_TOOLS_PREFIX)).toBe(true);
  });
});

describe("degrade", () => {
  const deg = policy({ missing: "degrade" });
  const net = { network: true };
  it("leaves out a skill with a warning", () => {
    const r = checkSkillTools([need("a", { profile: net })], caps(), deg, "flow");
    expect(r.action).toBe("degrade");
    expect(r.warnings).toEqual(["skill a [tool-not-approved]: It needs network access, which skills.tools.network does not allow."]);
  });
  it("leaves out dependants with via", () => {
    const r = checkSkillTools([need("a", { deps: ["b"] }), need("b", { deps: ["c"] }), need("c", { profile: net })], caps(), deg, "flow");
    expect(r.action).toBe("degrade");
    expect(r.leftOut).toEqual([
      { key: "a@1.0.0", code: "tool-not-approved", via: "c" },
      { key: "b@1.0.0", code: "tool-not-approved", via: "c" },
      { key: "c@1.0.0", code: "tool-not-approved" },
    ]);
    expect(r.warnings[0]).toBe("skill a [tool-not-approved]: It depends on c, which is left out.");
  });
  it("leaves out orphaned dependencies, keeps shared ones", () => {
    const top = need("a", { profile: net, deps: ["d", "e"] });
    const d = need("d", { selection: "dependency", requiredBy: ["a"] });
    const e = need("e", { selection: "dependency", requiredBy: ["a", "k"] });
    const r = checkSkillTools([top, d, e, need("k")], caps(), deg, "flow");
    expect(r.leftOut.map((l) => l.key)).toEqual(["a@1.0.0", "d@1.0.0"]);
    expect(r.leftOut[1]?.via).toBe("a");
  });
  it("words the orphan warning", () => {
    const r = checkSkillTools([need("a", { profile: net }), need("d", { selection: "dependency", requiredBy: ["a"] })], caps(), deg, "flow");
    expect(r.warnings[1]).toBe("skill d [tool-not-approved]: Only skills that are left out need it (a).");
  });
  it("stops for mandatory skills", () => {
    expect(checkSkillTools([need("a", { profile: net, selection: "mandatory" })], caps(), deg, "flow").action).toBe("stop");
    const m = need("m", { selection: "mandatory", deps: ["a"] });
    const a = need("a", { profile: net, selection: "dependency", requiredBy: ["m"] });
    expect(checkSkillTools([m, a], caps(), deg, "flow").action).toBe("stop");
  });
  it("leaves knowledge-only skills alone", () => {
    const r = checkSkillTools([need("a", { profile: net }), need("b")], caps(), deg, "flow");
    expect(r.leftOut.map((l) => l.key)).toEqual(["a@1.0.0"]);
  });
});

describe("the stop reason", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => need(`s${i}`, { profile: { network: true } }));
  it("uses the flow prefix that the watcher reads as a refusal", () => {
    const r = checkSkillTools(many(1), caps(), policy(), "flow");
    expect(r.reason).toMatch(/^skills not resolved: 1 skill\(s\) cannot be used — s0 \[tool-not-approved\]: /);
    expect(SKILL_REFUSED_RE.test(r.reason ?? "")).toBe(true);
  });
  it("shows three items, then the rest", () => {
    const r = checkSkillTools(many(5), caps(), policy(), "flow");
    expect(r.reason?.split(" · ")).toHaveLength(3);
    expect(r.reason?.endsWith(" (+2 more)")).toBe(true);
    expect(r.reason).toContain("5 skill(s)");
  });
  it("avoids the pause phrases", () => {
    const r = checkSkillTools([...many(2), need("c", { connectors: ["x"] })], caps({ shell: false }), policy(), "session");
    const all = [r.reason ?? "", ...r.warnings, ...r.missing.map((m) => m.message)].join("\n");
    expect(all).not.toMatch(/daily budget|usage limit reached|signed out/);
  });
});

describe("knowledge-only skills", () => {
  const strict = policy({ shell: false, network: false, filesystem: "read" });
  const plan = st({ step: { permission_mode: "plan" } }).capabilities;
  it.each(["oracle", "cassandra", "kafka", "ibm-mq"])("%s needs nothing", (id) => {
    const s = need(id);
    expect(skillNeeds(s.pkg)).toEqual([]);
    expect(checkSkillTools([s], plan, strict, "flow").action).toBe("continue");
    expect(checkSkillTools([s], plan, strict, "session").action).toBe("continue");
  });
  it("ibm-mq with a connector is unavailable", () => {
    expect(checkSkillTools([need("ibm-mq", { connectors: ["ibm-mq"] })], plan, strict, "flow").missing[0]?.code).toBe("connector-unavailable");
  });
});

describe("sessionToolGrant", () => {
  it("copies the session and drops left-out skills", () => {
    const tools = st({ step: { allowed_tools: ["Bash"] } });
    const check = checkSkillTools([need("a", { profile: { shell: true } }), need("b", { profile: { network: true } })], tools.capabilities, policy({ missing: "degrade" }), "session");
    const g = sessionToolGrant(tools, check);
    expect(g).toMatchObject({ mode: tools.mode, approved: tools.approved, sandbox: false, capabilities: tools.capabilities, connectors: [] });
    expect(g.met).toEqual([{ key: "a@1.0.0", need: "shell" }]);
    expect(g.leftOut).toEqual(check.leftOut);
    expect(g.settingSources).toEqual(["user", "project", "local"]);
    expect(sessionToolGrant(tools, check, true).settingSources).toEqual(["project", "local"]);
  });
});
