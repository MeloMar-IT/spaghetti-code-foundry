import { describe, expect, it } from "vitest";
import { fallbackTargets, resolveTarget } from "../src/agents/targets.js";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import type { ClaudeStep } from "../src/flow/schema.js";
import {
  agentsView, applyAnswers, currentValues, FIX_STEPS, keptKeys, parseAgentsRequest, REVIEW_STEPS, settingsFor, settle, summaryLines, valuesOf,
  type AgentAnswers, type AgentStatus, type StoredAgents,
} from "../src/onboarding/agents.js";

const MARK = "do-not-echo-769";
const NOW = new Date("2026-11-04T10:00:00Z");
const ans = (over: Partial<AgentAnswers> = {}): AgentAnswers => ({ have: "claude", plans: { claude: "pro" }, busy: "normal", ...over });
const runsPct = (a: AgentAnswers) => [settingsFor(a).concurrency, settingsFor(a).governor.usage_percent];
const apply = (a: AgentAnswers, text = "", stored: StoredAgents | null = null, replace: Parameters<typeof applyAnswers>[0]["replace"] = []) =>
  applyAnswers({ text, stored, answers: a, replace, now: NOW });

describe("settingsFor: plans", () => {
  it.each([
    ["claude", "pro", [1, 70]], ["claude", "max", [2, 80]], ["claude", "api-key", [1, 60]], ["claude", "unknown", [1, 60]],
    ["codex", "plus", [1, 70]], ["codex", "pro", [2, 80]], ["codex", "api-key", [1, 60]], ["codex", "unknown", [1, 60]],
  ] as const)("%s %s", (tool, plan, want) => {
    expect(runsPct(ans({ have: tool, plans: { [tool]: plan } }))).toEqual(want);
  });

  it("a missing plan, no tool, and the lower of two tools", () => {
    expect(runsPct(ans({ plans: {} }))).toEqual([1, 60]);
    expect(runsPct(ans({ have: "none", plans: {} }))).toEqual([1, 60]);
    expect(runsPct(ans({ have: "both", plans: { claude: "max", codex: "pro" } }))).toEqual([2, 80]);
    expect(runsPct(ans({ have: "both", plans: { claude: "max", codex: "unknown" } }))).toEqual([1, 60]);
    expect(runsPct(ans({ have: "both", plans: { claude: "pro", codex: "pro" } }))).toEqual([1, 70]);
    expect(runsPct(ans({ have: "both", plans: { claude: "pro", codex: "plus" } }))).toEqual([1, 70]);
    expect(runsPct(ans({ have: "both", plans: { claude: "max" } }))).toEqual([1, 60]);
  });

  it("ignores a plan for a tool the user does not have", () => {
    expect(runsPct(ans({ have: "claude", plans: { claude: "pro", codex: "pro" } }))).toEqual([1, 70]);
  });

  it("rejects a Codex plan that is a Claude plan", () => {
    expect(() => parseAgentsRequest({ answers: { have: "codex", plans: { codex: "max" }, busy: "normal" } })).toThrow(/plans\.codex/);
  });
});

describe("settingsFor: busy", () => {
  it("little, normal and fast", () => {
    const max = { have: "claude", plans: { claude: "max" } } as const;
    expect(settingsFor(ans({ ...max, busy: "little" }))).toMatchObject({ concurrency: 1, governor: { priority: "background", usage_percent: 50 } });
    expect(settingsFor(ans({ ...max, busy: "normal" }))).toMatchObject({ concurrency: 2, governor: { priority: "low", usage_percent: 80 } });
    expect(settingsFor(ans({ ...max, busy: "fast" }))).toMatchObject({ concurrency: 2, governor: { priority: "normal", usage_percent: 90 } });
    expect(settingsFor(ans({ busy: "fast" }))).toMatchObject({ concurrency: 1, governor: { priority: "normal", usage_percent: 90 } });
  });
});

describe("settingsFor: routing", () => {
  const both = (share?: AgentAnswers["share"]) => ans({ have: "both", plans: {}, share });
  it.each([
    [ans({ have: "none", plans: {} }), undefined, [], []],
    [ans({ have: "claude" }), "sonnet", [], [{ agent: "codex", model: "sonnet" }]],
    [ans({ have: "codex", plans: {} }), undefined, [], [{ agent: "claude", model: "codex" }]],
    [both("claude"), "sonnet", ["codex"], []],
    [both("codex"), undefined, ["sonnet"], [{ agent: "claude", model: "codex" }]],
    [both("even"), undefined, ["codex", "sonnet"], [{ step: REVIEW_STEPS, model: "codex" }, { step: FIX_STEPS, model: "codex" }]],
    [both("auto"), undefined, ["codex"], []],
    [both(undefined), undefined, ["codex"], []],
  ])("%j", (a, model, fallback, rules) => {
    const s = settingsFor(a);
    expect(s.default_model).toBe(model);
    expect(s.router.fallback).toEqual(fallback);
    expect(s.router.rules).toEqual(rules);
    expect(s.default_model).not.toBe("codex");
  });

  it("ignores `share` with one tool", () => {
    expect(settingsFor(ans({ have: "claude", share: "codex" }))).toEqual(settingsFor(ans({ have: "claude" })));
  });

  const flow = parseFlow(`
name: f
defaults: {model: sonnet}
steps:
  - {id: plan, type: claude, model: claude-opus-5-5, prompt: x}
  - {id: plan_review, type: claude, agent: codex, prompt: x}
  - {id: review_1, type: claude, agent: codex, prompt: x}
  - {id: cross_review, type: claude, agent: codex, prompt: x}
  - {id: my_check, type: claude, agent: codex, prompt: x}
  - {id: implement, type: claude, prompt: x}
  - {id: fix_tests, type: claude, prompt: x}
  - {id: address_review_1, type: claude, prompt: x}
`);
  const step = (id: string) => flow.steps.find((s) => s.id === id) as ClaudeStep;
  const config = (a: AgentAnswers) => ConfigSchema.parse(settingsFor(a));
  const label = (a: AgentAnswers, id: string) => resolveTarget(step(id), flow, config(a), 1).label;

  it("Claude only: every step runs on Claude Code, Opus stays", () => {
    const a = ans({ have: "claude" });
    for (const id of ["plan_review", "review_1", "cross_review", "my_check", "implement"]) expect(label(a, id)).toBe("claude:anthropic:sonnet");
    expect(label(a, "plan")).toBe("claude:anthropic:claude-opus-5-5");
  });

  it("Codex only: every step runs on Codex", () => {
    const a = ans({ have: "codex", plans: {} });
    for (const s of flow.steps) expect(label(a, s.id)).toBe("codex:openai");
  });

  it("both, even: Codex reviews and fixes, Claude writes", () => {
    const a = ans({ have: "both", plans: {}, share: "even" });
    for (const id of ["plan_review", "review_1", "cross_review", "fix_tests"]) expect(label(a, id)).toBe("codex:openai");
    for (const id of ["implement", "address_review_1"]) expect(label(a, id)).toBe("claude:anthropic:sonnet");
    expect(fallbackTargets(config(a)).map((t) => t.label)).toEqual(["codex:openai", "claude:anthropic:sonnet"]);
  });
});

describe("parseAgentsRequest", () => {
  const ok = { have: "claude", plans: { claude: "pro" }, busy: "normal" };
  it("accepts good answers and defaults replace", () => {
    expect(parseAgentsRequest({ answers: ok })).toEqual({ answers: ok, replace: [] });
    expect(parseAgentsRequest({ answers: { have: "none", busy: "fast" } }).answers.plans).toEqual({});
  });

  it.each([
    ["no answers", {}],
    ["missing have", { answers: { busy: "normal" } }],
    ["bad busy", { answers: { ...ok, busy: MARK } }],
    ["unknown top-level key", { answers: ok, [MARK]: 1 }],
    ["unknown answer key", { answers: { ...ok, extra: MARK } }],
    ["bad plan", { answers: { ...ok, plans: { codex: MARK } } }],
    ["bad replace", { answers: ok, replace: ["providers"] }],
    ["bad replace value", { answers: ok, replace: [MARK] }],
    ["unknown plans key", { answers: { ...ok, plans: { [MARK]: "pro" } } }],
  ])("refuses %s without echoing it", (_n, body) => {
    let message = "";
    try {
      parseAgentsRequest(body);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^invalid answers: /);
    expect(message).not.toContain(MARK);
  });
});

describe("applyAnswers: keep or replace", () => {
  it("writes the six values on the first apply and records them", () => {
    const r = apply(ans({ have: "claude", plans: { claude: "max" }, busy: "fast" }));
    expect(r.config.concurrency).toBe(2);
    expect(r.config.governor).toMatchObject({ usage_percent: 90, priority: "normal" });
    expect(r.config.default_model).toBe("sonnet");
    expect(Object.keys(r.record.applied).sort()).toEqual(["concurrency", "default_model", "governor.priority", "governor.usage_percent", "router.fallback", "router.rules"]);
    expect(r.kept).toEqual([]);
  });

  it("keeps a comment and an unrelated setting", () => {
    const r = apply(ans(), "# my notes\nsecret_scan: false\n");
    expect(r.text).toContain("# my notes");
    expect(r.config.secret_scan).toBe(false);
    expect(r.config.governor.usage_percent).toBe(70);
  });

  it("applying the same answers again changes nothing", () => {
    const first = apply(ans({ have: "both", plans: {}, share: "even" }), "# c\n");
    const second = apply(ans({ have: "both", plans: {}, share: "even" }), first.text, first.record, []);
    expect(second.text).toBe(first.text);
    expect(second.changed).toEqual([]);
    expect(second.record).toEqual(first.record);
  });

  it("keeps a value set by hand, and replaces it when asked", () => {
    const kept = apply(ans(), "concurrency: 5\n");
    expect(kept.config.concurrency).toBe(5);
    expect(kept.kept).toEqual(["concurrency"]);
    expect(kept.record.applied).not.toHaveProperty("concurrency");
    const replaced = apply(ans(), "concurrency: 5\n", null, ["concurrency"]);
    expect(replaced.config.concurrency).toBe(1);
    expect(replaced.kept).toEqual([]);
  });

  it("a hand-set value stays kept even when later answers want what the admin set", () => {
    const a1 = apply(ans({ have: "claude", plans: { claude: "pro" } }));
    expect(a1.config.concurrency).toBe(1);
    const edited = a1.text.replace(/concurrency: 1/, "concurrency: 2");
    const a2 = apply(ans({ have: "claude", plans: { claude: "max" } }), edited, a1.record);
    expect(a2.kept).toContain("concurrency");
    expect(a2.record.applied.concurrency).toBe(1);
    const a3 = apply(ans({ have: "claude", plans: { claude: "pro" } }), a2.text, a2.record);
    expect(a3.config.concurrency).toBe(2);
    expect(a3.kept).toContain("concurrency");
  });

  it("new answers replace the earlier applied values; codex to auto empties the rules", () => {
    const a1 = apply(ans({ have: "both", plans: {}, share: "codex" }));
    expect(a1.config.router.rules).toHaveLength(1);
    const a2 = apply(ans({ have: "both", plans: {}, share: "auto" }), a1.text, a1.record);
    expect(a2.config.router.rules).toEqual([]);
    expect(a2.config.router.fallback).toEqual(["codex"]);
    expect(a2.kept).toEqual([]);
  });

  it("a value equal to the default is not a hand edit", () => {
    expect(apply(ans({ have: "claude", plans: { claude: "max" }, busy: "normal" }), "concurrency: 2\n").kept).toEqual([]);
  });

  it("keptKeys: a key with an applied entry that differs from the file is kept", () => {
    const cur = currentValues(ConfigSchema.parse({ concurrency: 4 }));
    const want = valuesOf(settingsFor(ans()));
    expect(keptKeys(cur, want, { concurrency: 3 }).kept).toEqual(["concurrency"]);
    expect(keptKeys(cur, want, { concurrency: 4 }).changed).toContain("concurrency");
  });
});

describe("settle", () => {
  const base = (over: Partial<StoredAgents> = {}): StoredAgents => ({ version: 1, answers: ans(), applied: { concurrency: 1 }, at: "old", ...over });
  const pending = { answers: ans({ busy: "fast" }), applied: { concurrency: 2, "governor.priority": "normal" as const }, at: "new", to: "written" };

  it("no pending: unchanged", () => {
    const s = base();
    expect(settle(s, "any")).toBe(s);
    expect(settle(null, "any")).toBeNull();
  });

  it("promotes a pending whose config is exactly the file it wrote", () => {
    expect(settle(base({ pending }), "written")).toEqual({ version: 1, answers: pending.answers, applied: pending.applied, at: "new" });
  });

  it("drops a pending whose config is not the file it wrote, also after an admin's later edit", () => {
    expect(settle(base({ pending }), "before")).toEqual({ version: 1, answers: ans(), applied: { concurrency: 1 }, at: "old" });
    expect(settle(base({ answers: null, applied: {}, pending }), "edited")).toBeNull();
  });
});

describe("summaryLines", () => {
  const status = (a: AgentAnswers, over: Partial<AgentStatus> = {}): AgentStatus => ({ applied: true, kept: [], current: valuesOf(settingsFor(a)), ...over });
  const lines = (a: AgentAnswers, over: Partial<AgentStatus> = {}) => summaryLines(a, status(a, over));

  it("describes both tools, even, normal", () => {
    const a = ans({ have: "both", plans: { claude: "max", codex: "plus" }, share: "even" });
    expect(lines(a)).toEqual([
      "You use Claude Code and Codex.",
      "Claude Code: Max plan.",
      "Codex: Plus plan.",
      "Up to 1 run at the same time.",
      "The usage threshold is 70% of a weekly limit; with 1 run at the same time it lowers nothing.",
      "Runs give way a little to your other programs.",
      "Claude Code plans and writes the code; Codex reviews it and fixes failed tests. Each takes over when the other hits a limit.",
    ]);
  });

  it("none, unknown plan, not applied", () => {
    expect(lines(ans({ have: "none", plans: {} }))[0]).toBe("You have neither Claude Code nor Codex yet. Set one up on the Setup check page first.");
    expect(lines(ans({ plans: { claude: "unknown" } }))).toContain("Claude Code: plan not known, so the Foundry starts with the smallest setting.");
    expect(lines(ans(), { applied: false })).toContain("These settings are not applied yet.");
  });

  it("describes the values in effect, not the wanted ones", () => {
    const a = ans({ busy: "little" });
    const cur = currentValues(ConfigSchema.parse({ concurrency: 5, governor: { usage_percent: 50, priority: "normal" } }));
    const l = lines(a, { current: cur, kept: ["concurrency"] });
    expect(l).toContain("Up to 5 runs at the same time.");
    expect(l).toContain("When about 50% of a weekly limit is used, the Foundry goes down to 1 run at the same time.");
    expect(l).toContain("Runs get the computer's full speed.");
    expect(l).toContain("Kept as an admin set them: runs at the same time.");
  });

  it("threshold: lowers nothing, floor, none", () => {
    expect(lines(ans({ busy: "little" }))).toContain("The usage threshold is 50% of a weekly limit; with 1 run at the same time it lowers nothing.");
    const fast = ans({ plans: { claude: "max" }, busy: "fast" });
    expect(lines(fast, { floor: 2 }).join("\n")).toContain("lowers nothing");
    expect(lines(fast).join("\n")).toContain("goes down to 1 run at the same time");
    const none = currentValues(ConfigSchema.parse({}));
    expect(lines(fast, { current: none })).toContain("No usage threshold is set.");
  });

  it("says when slowing down is off, there is no reading, or the reading may not be usable", () => {
    const fast = ans({ plans: { claude: "max" }, busy: "fast" });
    expect(lines(fast, { limits: { auto: false, readings: [] } })).toContain("Slowing down is off, so this does not happen yet (`scf limits auto on`).");
    expect(lines(fast, { limits: { auto: true, readings: [] } }).join("\n")).toContain("needs a usage reading first");
    const l = lines(fast, { limits: { auto: true, readings: ["claude"] } }).join("\n");
    expect(l).not.toContain("Slowing down is off");
    expect(l).not.toContain("needs a usage reading first");
    expect(l).toContain("works only while the reading matches the runs recorded");
  });

  it("routing set by hand", () => {
    const l = lines(ans(), { kept: ["router.rules"] });
    expect(l).toContain("An admin set the routing by hand; see the Models page.");
    expect(l).not.toContain("Claude Code runs every step, also the ones made for Codex.");
  });
});

describe("agentsView", () => {
  it("is empty without a record", () => {
    expect(agentsView(null, ConfigSchema.parse({}), "v")).toMatchObject({ answers: null, settings: null, kept: [], summary: [] });
  });

  it("lists a value changed by hand", () => {
    const r = apply(ans());
    const config = ConfigSchema.parse({ ...r.config, concurrency: 4 });
    const v = agentsView(r.record, config, "v");
    expect(v.kept).toEqual(["concurrency"]);
    expect(v.current.concurrency).toBe(4);
    expect(v.summary).toContain("Up to 4 runs at the same time.");
    expect(agentsView(r.record, r.config, "v").kept).toEqual([]);
  });
});
