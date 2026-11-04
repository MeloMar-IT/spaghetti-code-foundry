import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { agentParts, cleanId, costOf, DEFAULT_PRICES, priceFor, runEndEvents, runStartedEvent, splitOf, stepFinishedEvent, UsageEventSchema } from "../src/usage/events.js";

const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
// secret-shaped values are built here, never written out
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const KEY = "sk-" + "Zy9Xw8Vu7T".repeat(4);

const rec = (over: Partial<StepRecord> = {}): StepRecord => ({ id: "a", type: "shell", visit: 1, ok: true, output: "", startedAt: "2026-11-04T10:00:00.000Z", durationMs: 1200, logFile: "/x/a.log", ...over }) as StepRecord;
const run = (over: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: "20261104-100000-ab12",
    flow: "My flow with spaces ü",
    vars: { github_repo: "acme/widgets", issue: "42" },
    status: "succeeded",
    startedAt: "2026-11-04T10:00:00.000Z",
    finishedAt: "2026-11-04T10:00:30.000Z",
    totalCostUsd: 0.5,
    history: [],
    source: "watcher w1 issue #42",
    ...over,
  }) as unknown as RunSummary;

describe("prices", () => {
  it("costs the cached tokens at their own rate", () => {
    const c = costOf({ input: 1000, cached: 400, output: 50 }, DEFAULT_PRICES["gpt-5"]);
    expect(c).toBeCloseTo((600 * 1.25 + 400 * 0.125 + 50 * 10) / 1e6, 12);
  });
  it("has no cost without a price, and never counts more cached tokens than input", () => {
    expect(costOf({ input: 1, output: 1 })).toBeUndefined();
    expect(costOf({ input: 100, cached: 900, output: 0 }, { input_per_mtok: 1, cached_input_per_mtok: 0.5, output_per_mtok: 1 })).toBeCloseTo(50 / 1e6, 12);
  });
  it("looks a price up in the order config, provider, built-in table", () => {
    const own = { input_per_mtok: 9, cached_input_per_mtok: 8, output_per_mtok: 7 };
    const c = cfg({ usage: { prices: { "gpt-5": own } } });
    expect(priceFor("gpt-5", c, { price: { input_per_mtok: 1, output_per_mtok: 2 } })).toEqual(own);
    expect(priceFor("gpt-5", cfg(), { price: { input_per_mtok: 1, output_per_mtok: 2 } })).toEqual({ input_per_mtok: 1, cached_input_per_mtok: 1, output_per_mtok: 2 });
    expect(priceFor("gpt-5", cfg())).toEqual(DEFAULT_PRICES["gpt-5"]);
    expect(priceFor("gpt-nope", cfg())).toBeUndefined();
    expect(priceFor(undefined, cfg())).toBeUndefined();
    expect(priceFor("constructor", cfg())).toBeUndefined();
  });
  it("has a default for the usage section, and refuses a negative price", () => {
    expect(cfg().usage).toEqual({ prices: {} });
    expect(ConfigSchema.safeParse({ usage: { prices: { m: { input_per_mtok: -1, cached_input_per_mtok: 0, output_per_mtok: 0 } } } }).success).toBe(false);
  });
});

describe("agentParts", () => {
  it("reads a built-in provider with the default config", () => {
    expect(agentParts("codex:openai:gpt-5", cfg())).toEqual({ agent: "codex", provider: "openai", model: "gpt-5" });
    expect(agentParts("claude:anthropic:sonnet", cfg())).toEqual({ agent: "claude", provider: "anthropic", model: "sonnet" });
  });
  it("keeps the colons of a local model name", () => {
    expect(agentParts("codex:ollama:gpt-oss:20b", cfg())).toEqual({ agent: "codex", provider: "ollama", model: "gpt-oss:20b" });
  });
  it("gives nothing for no label", () => {
    expect(agentParts(undefined, cfg())).toEqual({});
  });
  it("redacts a model name that is a path or holds a secret", () => {
    expect(agentParts("ollama:/Users/x/model.gguf", cfg()).model).toBe("redacted");
    expect(agentParts(`codex:openai:${TOKEN}`, cfg()).model).toBe("redacted");
  });
});

describe("cleanId", () => {
  it("replaces other characters and cuts at 200", () => {
    expect(cleanId("a b/ü")).toBe("a_b/_");
    expect(cleanId("x".repeat(500))).toHaveLength(200);
  });
  it("turns a secret or an absolute path into a fixed word", () => {
    for (const bad of [TOKEN, KEY, "/Users/name/model.gguf", "~/m", "C:\\m", "C:/m"]) expect(cleanId(bad), bad).toBe("redacted");
  });
});

describe("the events", () => {
  it("builds a valid run.started with ids only", () => {
    const e = runStartedEvent(run());
    expect(UsageEventSchema.parse(e)).toMatchObject({ name: "run.started", repository: "acme/widgets", issue: 42, workspace: "" });
    expect(JSON.stringify(e)).not.toContain("flow");
  });
  it("takes the issue only when it is a plain number", () => {
    expect(runStartedEvent(run({ vars: { issue: "4x" } as never })).issue).toBeUndefined();
    expect(runStartedEvent(run({ vars: { issue: "0" } as never })).issue).toBeUndefined();
  });
  it("builds step.finished with tokens, cost and the earlier cost", () => {
    const e = stepFinishedEvent(run(), rec({ id: "a", type: "claude", agent: "codex:openai:gpt-5", tokens: { input: 1000, output: 50, cached: 400 }, costUsd: 0.01, earlierCostUsd: 0.002 }), 3, cfg());
    expect(UsageEventSchema.parse(e)).toMatchObject({
      id: "20261104-100000-ab12:step:3", name: "step.finished", step: "a", agent: "codex", provider: "openai", model: "gpt-5", tokensIn: 1000, tokensCached: 400, tokensOut: 50, costUsd: 0.01, earlierCostUsd: 0.002, durationMs: 1200,
    });
  });
  it("has a null cost for a step with no cost", () => {
    const e = stepFinishedEvent(run(), rec(), 0, cfg());
    expect(e).toMatchObject({ costUsd: null, earlierCostUsd: 0 });
    expect(UsageEventSchema.safeParse(e).success).toBe(true);
  });
  it("still gives a valid event for a long or odd step id", () => {
    for (const id of ["sub flow.step ü", "x".repeat(400), "sub.".repeat(60) + "step"]) {
      expect(UsageEventSchema.safeParse(stepFinishedEvent(run(), rec({ id }), 0, cfg())).success, id).toBe(true);
    }
  });
  it("refuses a field it does not know", () => {
    const e = { ...runStartedEvent(run()), task: "text" };
    expect(UsageEventSchema.safeParse(e).success).toBe(false);
  });
  it("gives run.finished a fixed reason, and a long flow name changes nothing", () => {
    const ok = runEndEvents(run({ flow: "f ".repeat(200), status: "succeeded", isStory: undefined } as never));
    expect(ok[0]).toMatchObject({ id: "20261104-100000-ab12:finished:0", name: "run.finished", status: "succeeded", reason: "none", durationMs: 30000, costUsd: 0.5 });
    const bad = runEndEvents(run({ status: "failed", reason: "step a failed", history: [rec({ ok: false, error: "boom" })] }));
    expect(["code", "factory", "limit", "decision"]).toContain((bad[0] as { reason: string }).reason);
    expect(UsageEventSchema.safeParse(bad[0]).success).toBe(true);
  });
  it("numbers the finish and the issue event by the resumes", () => {
    const e = runEndEvents(run({ resumes: 2 }));
    expect(e.map((x) => x.id)).toEqual(["20261104-100000-ab12:finished:2", "20261104-100000-ab12:issue:2"]);
  });
  it("sends no event for a run that has not ended", () => {
    for (const status of ["running", "waiting", "stopped"] as const) expect(runEndEvents(run({ status }))).toEqual([]);
  });
  it("sends issue events only for a story run that succeeded or failed", () => {
    expect(runEndEvents(run()).map((e) => e.name)).toEqual(["run.finished", "issue.done"]);
    expect(runEndEvents(run({ status: "failed" })).map((e) => e.name)).toEqual(["run.finished", "issue.failed"]);
    expect(runEndEvents(run({ status: "cancelled" })).map((e) => e.name)).toEqual(["run.finished"]);
    expect(runEndEvents(run({ source: "cli" })).map((e) => e.name)).toEqual(["run.finished"]);
    expect(runEndEvents(run({ localTest: true })).map((e) => e.name)).toEqual(["run.finished"]);
  });
  it("sends issue.split for a successful create_split, for both outputs", () => {
    const split = runEndEvents(run({ history: [rec({ id: "create_split", output: "SPLIT: #11 #12 — #42 closed\n" })] }));
    expect(split.map((e) => e.name)).toEqual(["run.finished", "issue.split"]);
    expect(split[1]).toMatchObject({ parent: 42, parts: [11, 12], issue: 42 });
    const again = runEndEvents(run({ history: [rec({ id: "create_split", output: "already split: #11 #12" })] }));
    expect(again[1]).toMatchObject({ name: "issue.split", parent: 42, parts: [11, 12] });
  });
});

describe("splitOf", () => {
  const split = (over: Partial<StepRecord>) => splitOf(rec({ id: "create_split", ...over }));
  it("reads the SPLIT line and the already-split line", () => {
    expect(split({ output: "log\nSPLIT: #5 #6 #7 — #4 closed\n" })).toEqual({ parent: 4, parts: [5, 6, 7] });
    expect(split({ output: "already split: #8 #9" })).toEqual({ parts: [8, 9] });
  });
  it("refuses a failed record, a nested one, another step and garbage", () => {
    expect(split({ ok: false, output: "SPLIT: #5 — #4 closed" })).toBeUndefined();
    expect(split({ parent: "sub", output: "SPLIT: #5 — #4 closed" })).toBeUndefined();
    expect(splitOf(rec({ id: "other", output: "SPLIT: #5 — #4 closed" }))).toBeUndefined();
    expect(split({ output: "SPLIT: #5 and text — #4 closed" })).toBeUndefined();
    expect(split({ output: "" })).toBeUndefined();
    expect(splitOf(undefined)).toBeUndefined();
  });
});

describe("privacy", () => {
  it("holds neither the task, the output, the error nor a secret", () => {
    const history = [
      rec({ id: "create_split", output: `SPLIT: #5 — #42 closed\nthe secret ${TOKEN} and private text`, error: `failed with ${KEY}` }),
    ];
    const r = run({ task: `fix this: ${TOKEN} private task text`, history, reason: `failed ${KEY}` } as never);
    const all = [runStartedEvent(r), stepFinishedEvent(r, history[0]!, 0, cfg()), ...runEndEvents(r), ...runEndEvents({ ...r, status: "failed" })];
    const text = JSON.stringify(all);
    for (const bad of [TOKEN, KEY, "private", "the secret", "failed with", "My flow", "/x/a.log"]) expect(text, bad).not.toContain(bad);
  });
  it("shows a step id, provider or model with a secret or a path as redacted", () => {
    const e = stepFinishedEvent(run(), rec({ id: TOKEN, type: "claude", agent: `codex:ollama:/Users/name/model.gguf` }), 0, cfg());
    const text = JSON.stringify(e);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("/Users/name");
    expect(e).toMatchObject({ step: "redacted", model: "redacted" });
    expect(UsageEventSchema.safeParse(e).success).toBe(true);
  });
});
