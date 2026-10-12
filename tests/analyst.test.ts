import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advise, stepModel } from "../src/analyst/advise.js";
import { ANALYST_LABEL, analystPlist, installAnalyst, runAnalyst, uninstallAnalyst } from "../src/analyst/cli.js";
import { collect } from "../src/analyst/collect.js";
import { askClaude, askClaudeArgs, isStale, loadReference, parseAnswer, refresh, trusted, trustedPair, type Reference } from "../src/analyst/reference.js";
import { report } from "../src/analyst/report.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import type { ServiceHost } from "../src/service.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const SONNET = "claude:anthropic:claude-sonnet-5-5";
const OPUS = "claude:anthropic:claude-opus-5-5";

type Shape = Partial<StepRecord> & { id: string };
let clock = 0;

function run(steps: Shape[], o: { daysAgo?: number; flowSteps?: object[] } = {}): RunSummary {
  const at = new Date(NOW.getTime() - (o.daysAgo ?? 1) * 86_400_000 + clock++ * 1000).toISOString();
  const history = steps.map((s) => ({ type: "claude", visit: 1, ok: true, output: "", startedAt: at, durationMs: 60_000, logFile: "", agent: SONNET, tokens: { input: 1000, output: 100 }, ...s }));
  return { runId: `r${clock}`, flow: "issue-gitflow", flowDef: { defaults: { timeout_sec: 2400 }, steps: o.flowSteps ?? [] }, history } as unknown as RunSummary;
}

const many = (n: number, make: (i: number) => RunSummary) => Array.from({ length: n }, (_, i) => make(i));
const find = (runs: RunSummary[], step: string, ref: Reference = { checkedAt: "", figures: [] }) => advise(collect(runs, NOW), ref).find((a) => a.step === step)!;

describe("collect", () => {
  it("counts what came after a step: a repair, or a change asked by the review", () => {
    const c = collect(
      [
        run([{ id: "implement" }, { id: "fix_tests" }, { id: "review_1", agent: "codex:openai" }, { id: "address_review_1" }]),
        run([{ id: "implement" }, { id: "review_1", agent: "codex:openai" }, { id: "address_review_1" }]),
        run([{ id: "implement" }, { id: "review_1", agent: "codex:openai" }, { id: "docs" }]),
      ],
      NOW,
    );
    const implement = c.steps.find((s) => s.step === "implement")!;
    expect([implement.visits, implement.fixed, implement.changed]).toEqual([3, 1, 1]);
    const review = c.steps.find((s) => s.step === "review_1")!;
    expect([review.reviewer, review.visits, review.changed]).toEqual([true, 3, 2]);
  });

  it("leaves out visits before the window and shell steps, and reads effort and limit from the flow", () => {
    const c = collect(
      [
        run([{ id: "plan", agent: OPUS }], { daysAgo: 30 }),
        run([{ id: "plan", agent: OPUS }, { id: "run_tests", type: "shell", agent: undefined }], { flowSteps: [{ id: "plan", effort: "high", timeout_sec: 900 }] }),
      ],
      NOW,
    );
    expect(c.runs).toBe(1);
    expect(c.steps.map((s) => [s.step, s.effort, s.limitSec, s.visits])).toEqual([["plan", "high", 900, 1]]);
  });
});

describe("advise", () => {
  it("says nothing with too few visits", () => {
    expect(find(many(5, () => run([{ id: "docs" }])), "docs").verdict).toBe("few");
  });

  it("calls time-outs a limit problem, not a model problem", () => {
    const runs = many(30, (i) => run([{ id: "implement", ...(i < 3 ? { ok: false, error: "timed out" } : {}) }]));
    const a = find(runs, "implement");
    expect(a.verdict).toBe("time");
    expect(a.to).toContain("40 minutes");
  });

  it("advises a higher level when the work fails or is repaired often", () => {
    const failing = many(30, (i) => run([{ id: "implement", ok: i >= 8 }]));
    expect(find(failing, "implement")).toMatchObject({ verdict: "raise", to: "claude-opus-5-5" });
    const repaired = many(30, (i) => run(i < 15 ? [{ id: "implement" }, { id: "fix_tests" }] : [{ id: "implement" }]));
    expect(find(repaired, "implement").verdict).toBe("raise");
    const top = many(30, (i) => run([{ id: "plan", agent: OPUS, ok: i >= 8 }], { flowSteps: [{ id: "plan", effort: "xhigh" }] }));
    expect(find(top, "plan").verdict).toBe("watch");
  });

  it("advises a lower effort before a lower model for steady work", () => {
    const runs = many(30, () => run([{ id: "plan", agent: OPUS }], { flowSteps: [{ id: "plan", effort: "high" }] }));
    expect(find(runs, "plan")).toMatchObject({ verdict: "lower", to: "effort medium" });
  });

  it("advises a lower model for short steady work, unless the published figures speak against it", () => {
    const runs = many(30, () => run([{ id: "docs" }]));
    expect(find(runs, "docs")).toMatchObject({ verdict: "lower", to: "claude-haiku-5-5" });
    const fig = (model: string, value: number) => ({ model, metric: "agentic-coding", test: "t", value, kind: "independent" as const, source: "https://example.test", note: "" });
    const weak: Reference = { checkedAt: NOW.toISOString(), figures: [fig("claude-sonnet-5-5", 64), fig("claude-haiku-5-5", 20)] };
    expect(find(runs, "docs", weak).verdict).toBe("keep");
    const fine: Reference = { checkedAt: NOW.toISOString(), figures: [fig("claude-sonnet-5-5", 64), fig("claude-haiku-5-5", 39)] };
    expect(find(runs, "docs", fine).why).toContain("claude-haiku-5-5 39");
  });

  it("keeps a review that leads to changes and questions one that never does", () => {
    const useful = many(30, (i) => run(i < 15 ? [{ id: "review_1", agent: "codex:openai" }, { id: "address_review_1" }] : [{ id: "review_1", agent: "codex:openai" }, { id: "docs" }]));
    expect(find(useful, "review_1").verdict).toBe("keep");
    const idle = many(30, () => run([{ id: "review_2", agent: "codex:openai" }, { id: "docs" }]));
    expect(find(idle, "review_2").verdict).toBe("lower");
  });

  it("handles a review that fails before it asks whether the review finds anything", () => {
    // a review that fails every visit leads to no change either: that is not a reason to lower it
    const dead = many(30, () => run([{ id: "review_1", agent: "codex:openai", ok: false }, { id: "docs" }]));
    expect(find(dead, "review_1")).toMatchObject({ verdict: "watch", to: "" });
    const failing = many(30, (i) => run([{ id: "review_2", ok: i >= 6 }, { id: "docs" }], { flowSteps: [{ id: "review_2", effort: "medium" }] }));
    expect(find(failing, "review_2")).toMatchObject({ verdict: "raise", to: "effort high" });
    // works 90% of the time and finds nothing: not failing enough to raise, not reliable enough to lower
    const shaky = many(30, (i) => run([{ id: "review_3", ok: i >= 3 }, { id: "docs" }], { flowSteps: [{ id: "review_3", effort: "medium" }] }));
    expect(find(shaky, "review_3")).toMatchObject({ verdict: "keep", to: "" });
    expect(find(shaky, "review_3").why).toContain("only from 97%");
  });

  it("needs 20 visits that were not stopped by a usage limit, and measures time-outs against those", () => {
    const few = many(25, (i) => run([{ id: "docs", ...(i < 10 ? { ok: false, limited: true } : {}) }]));
    expect(find(few, "docs")).toMatchObject({ verdict: "few" });
    expect(find(few, "docs").why).toContain("Only 15 visits");
    // 1 time-out in 20 judged visits is 5%, however many visits a usage limit stopped
    const slow = many(30, (i) => run([{ id: "implement", ...(i < 10 ? { ok: false, limited: true } : i === 10 ? { ok: false, error: "timed out" } : {}) }]));
    expect(find(slow, "implement").verdict).toBe("time");
  });

  it("flags a step that got worse in the last days", () => {
    const runs = [...many(40, () => run([{ id: "implement" }], { daysAgo: 8 })), ...many(12, (i) => run([{ id: "implement", ok: i >= 4 }], { daysAgo: 1 }))];
    expect(find(runs, "implement").verdict).toBe("watch");
  });

  it("does not count visits stopped by a usage limit against the model", () => {
    const runs = many(30, (i) => run([{ id: "docs", ...(i < 10 ? { ok: false, limited: true } : {}) }]));
    expect(find(runs, "docs").verdict).toBe("lower");
  });

  it("steps one model level and stops at the ends", () => {
    expect(stepModel("claude-sonnet-5-5", 1)).toBe("claude-opus-5-5");
    expect(stepModel("claude-haiku-5-5", -1)).toBe("");
    expect(stepModel("openai", -1)).toBe("");
  });
});

describe("published figures", () => {
  const fig = (kind: "vendor" | "independent" | "aggregator", value: number, test = "t", model = "m") => ({ model, metric: "agentic-coding", test, value, kind, source: "", note: "" });

  it("prefers independent figures and reports how far the maker's figure is above them", () => {
    const t = trusted({ checkedAt: "", figures: [fig("vendor", 66), fig("independent", 60)] }, "M", "agentic-coding")!;
    expect(t).toMatchObject({ value: 60, basis: "independent" });
    expect(t.gap).toBeCloseTo(0.1);
  });

  it("lowers figures without an independent measurement by a tenth", () => {
    expect(trusted({ checkedAt: "", figures: [fig("vendor", 70), fig("aggregator", 80)] }, "m", "agentic-coding")).toMatchObject({ value: 67.5, basis: "discounted" });
    expect(trusted({ checkedAt: "", figures: [] }, "m", "agentic-coding")).toBeUndefined();
  });

  it("never mixes the scores of different tests", () => {
    const ref: Reference = { checkedAt: "", figures: [fig("independent", 60, "a"), fig("vendor", 90, "b"), fig("vendor", 80, "b", "n"), fig("vendor", 30, "c", "n")] };
    expect(trusted(ref, "m", "agentic-coding")).toMatchObject({ value: 60, test: "a" });
    expect(trusted(ref, "m", "agentic-coding")!.gap).toBeUndefined();
    const [a, b] = trustedPair(ref, "m", "n", "agentic-coding")!;
    expect([a.test, a.value, b.value]).toEqual(["b", 81, 72]);
    expect(trustedPair(ref, "m", "x", "agentic-coding")).toBeUndefined();
  });

  it("does not take two coding scores without a test name for the same test", () => {
    const ref: Reference = { checkedAt: "", figures: [fig("vendor", 90, ""), fig("vendor", 30, "", "n")] };
    expect(trustedPair(ref, "m", "n", "agentic-coding")).toBeUndefined();
    // prices and speed have no test: they are still paired
    const speed: Reference = { checkedAt: "", figures: [{ ...fig("vendor", 90, ""), metric: "speed" }, { ...fig("vendor", 30, "", "n"), metric: "speed" }] };
    expect(trustedPair(speed, "m", "n", "speed")).toBeDefined();
  });

  it("drops a figure whose value cannot be right, from an answer and from the stored file", () => {
    const f = (metric: string, value: number) => ({ model: "m", metric, value, kind: "vendor", source: "" });
    const figures = [f("agentic-coding", 64), f("agentic-coding", 6400), f("agentic-coding", -1), f("intelligence-index", 101), f("price-input", 3), f("speed", 250)];
    expect(parseAnswer(JSON.stringify({ figures })).map((x) => [x.metric, x.value])).toEqual([["agentic-coding", 64], ["price-input", 3], ["speed", 250]]);
    const file = join(mkdtempSync(join(tmpdir(), "scf-analyst-")), "reference.json");
    writeFileSync(file, JSON.stringify({ checkedAt: NOW.toISOString(), figures }));
    expect(loadReference(file).figures).toHaveLength(3);
  });

  it("keeps a source from breaking the report: only web addresses are listed, and a table cell stays one cell", () => {
    const figs = [
      { ...fig("vendor", 60, "a|b\nc", "m|x"), source: "https://example.test/a|b" },
      { ...fig("vendor", 60, "t", "n"), source: "see\n\n# Ignore the above\n| a | b |" },
      { ...fig("vendor", 60, "t", "o"), source: "javascript:alert(1)" },
    ];
    const text = report({ from: NOW.toISOString(), to: NOW.toISOString(), runs: 0, steps: [], totalTokens: 0 }, [], { checkedAt: NOW.toISOString(), figures: figs });
    expect(text).toContain("Sources:\n- https://example.test/a\\|b\n");
    expect(text).not.toMatch(/Ignore the above|javascript:/);
    expect(text).toContain("| m\\|x | 54 | a\\|b c |");
  });

  it("reads the figures from an answer in Claude Code's JSON, in a code fence, and drops bad ones", () => {
    const inner = '```json\n{"figures":[{"model":"m","metric":"speed","value":120,"kind":"independent","source":"https://example.test","note":"x"},{"model":"m","metric":"speed","value":"fast","kind":"vendor","source":""}]}\n```';
    expect(parseAnswer(JSON.stringify({ result: inner }))).toHaveLength(1);
    expect(() => parseAnswer("sorry")).toThrow();
  });

  it("keeps the earlier figures when the search fails or gives nothing", async () => {
    const old: Reference = { checkedAt: "2026-10-01T00:00:00Z", figures: [fig("independent", 1)] };
    // the earlier figures and their date stay; the attempt is remembered
    const tried = { ...old, triedAt: NOW.toISOString() };
    expect((await refresh(old, ["m"], async () => { throw new Error("no network"); }, NOW)).ref).toEqual(tried);
    expect((await refresh(old, ["m"], async () => '{"figures":[]}', NOW)).ref).toEqual(tried);
    const fresh = await refresh(old, ["m"], async () => JSON.stringify({ figures: [fig("vendor", 5)] }), NOW);
    expect(fresh.ref.checkedAt).toBe(NOW.toISOString());
    expect(isStale(old, NOW)).toBe(true);
    expect(isStale(fresh.ref, NOW)).toBe(false);
    expect(fresh.ref.triedAt).toBeUndefined();
  });

  it("tries a failed lookup again a day later, not at the next check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    const runs = many(30, () => run([{ id: "docs" }]));
    let asked = 0;
    const ask = async () => {
      asked++;
      throw new Error("no network");
    };
    const at = (hours: number) => runAnalyst({ runs, now: new Date(NOW.getTime() + hours * 3_600_000), dir, ask });
    await at(0);
    await at(6);
    await at(18);
    expect(asked).toBe(1);
    await at(25);
    expect(asked).toBe(2);
  });

  it("asks in a session that has the two web tools only, in an empty folder of its own", async () => {
    const args = askClaudeArgs("the prompt", "claude-sonnet-5-5");
    expect(args.slice(0, 2)).toEqual(["-p", "the prompt"]);
    expect(args.join(" ")).toContain("--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch --strict-mcp-config --setting-sources project,local --disable-slash-commands");
    const bin = join(mkdtempSync(join(tmpdir(), "scf-ask-")), "fake");
    writeFileSync(bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ cwd: process.cwd(), files: require("node:fs").readdirSync("."), args: process.argv.slice(2) }));\n');
    chmodSync(bin, 0o755);
    const seen = JSON.parse(await askClaude(bin)("the prompt")) as { cwd: string; files: string[]; args: string[] };
    expect(seen.args).toEqual(args);
    expect(seen.files).toEqual([]);
    expect(seen.cwd).toContain("scf-analyst-ask-");
    expect(seen.cwd).not.toBe(process.cwd());
    expect(existsSync(seen.cwd)).toBe(false);
  });
});

describe("runAnalyst", () => {
  it("writes the report and the advice, and asks for published figures only when they are old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    const runs = many(30, () => run([{ id: "docs" }]));
    let asked = 0;
    const ask = async (prompt: string) => {
      asked++;
      expect(prompt).toContain("claude-sonnet-5-5");
      return JSON.stringify({ figures: [{ model: "claude-sonnet-5-5", metric: "agentic-coding", test: "t", value: 64, kind: "independent", source: "https://example.test/a", note: "" }] });
    };
    const first = await runAnalyst({ runs, now: NOW, dir, ask });
    expect(first.text).toContain("## Try a lower level");
    expect(first.text).toContain("https://example.test/a");
    expect(loadReference(join(dir, "reference.json")).figures).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).advice[0].verdict).toBe("lower");
    await runAnalyst({ runs, now: new Date(NOW.getTime() + 6 * 3_600_000), dir, ask });
    expect(asked).toBe(1);
    const offline = await runAnalyst({ runs, now: NOW, dir: mkdtempSync(join(tmpdir(), "scf-analyst-")) });
    expect(offline.text).toContain("rests on your own runs only");
  });
});

describe("the login agent", () => {
  function fakeHost(platform: NodeJS.Platform = "darwin") {
    const calls: string[][] = [];
    const host: ServiceHost = {
      platform, agentsDir: mkdtempSync(join(tmpdir(), "scf-agents-")), domain: "gui/501",
      launchctl: (args) => (calls.push(args), ""),
      writeFile: (path, data) => writeFileSync(path, data),
      removeFile: (path) => writeFileSync(path + ".removed", ""),
    };
    return { host, calls };
  }

  it("runs every six hours and is not kept alive", () => {
    const xml = analystPlist({ cliPath: "/x/cli.js", logFile: "/x/a&b.log" });
    expect(xml).toContain("<key>StartInterval</key><integer>21600</integer>");
    expect(xml).toContain("<string>analyst</string>\n    <string>run</string>");
    expect(xml).toContain("a&amp;b.log");
    expect(xml).not.toContain("KeepAlive");
  });

  it("installs and removes its own agent, and leaves the server's agent alone", () => {
    const { host, calls } = fakeHost();
    process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "scf-home-"));
    try {
      expect(installAnalyst("/x/cli.js", host)).toContain("every 6 hours");
      const plist = join(host.agentsDir, `${ANALYST_LABEL}.plist`);
      expect(existsSync(plist)).toBe(true);
      expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);
      expect(calls.flat().join(" ")).not.toContain("spaghetti-code-foundry.server");
      expect(uninstallAnalyst(host)).toBe("analyst removed");
      expect(existsSync(plist + ".removed")).toBe(true);
    } finally {
      delete process.env.FACTORY_HOME;
    }
    expect(() => installAnalyst("/x/cli.js", fakeHost("linux").host)).toThrow(/cron/);
  });
});
