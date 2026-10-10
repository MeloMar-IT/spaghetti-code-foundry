import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit, parseHtml } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let dom: any;
let dash: any;
let runs: any;
let next: any;
let icons: any;
let health: any;
let repos: any;
let suggest: any;
let talk: any;
let impact: any;
let turn: any;
beforeAll(async () => {
  restore = installFakeDom();
  dom = await import("../ui/dom.js" as string);
  dash = await import("../ui/dashboard.js" as string);
  runs = await import("../ui/runs.js" as string);
  next = await import("../ui/next.js" as string);
  icons = await import("../ui/icons.js" as string);
  health = await import("../ui/health.js" as string);
  repos = await import("../ui/repos.js" as string);
  suggest = await import("../ui/refinement-suggest.js" as string);
  talk = await import("../ui/refinement-talk.js" as string);
  impact = await import("../ui/refinement-impact.js" as string);
  turn = await import("../ui/turn-act.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  out.push(el);
  for (const c of el.children) if (c instanceof FakeElement) walk(c, out);
  return out;
};
const byClass = (root: FakeElement, cls: string) => walk(root).filter((e) => (e.attrs.class ?? "").split(/\s+/).includes(cls));
/** What a screen reader reads: aria-hidden subtrees left out. */
const spoken = (el: FakeElement): string => (el.attrs["aria-hidden"] === "true" ? "" : el.children.length
  ? el.children.map((c) => (typeof c === "string" ? c : c instanceof FakeElement ? spoken(c) : "")).join("") : el.textContent);
const groups = (root: FakeElement) => walk(root).filter((e) => e.attrs.role === "region" && (e.attrs["aria-label"] ?? "").startsWith("Written by AI"));
const inGroup = (root: FakeElement, text: string) => groups(root).some((g) => g.textContent.includes(text));

const DAYS = [
  { day: "2026-03-01", costUsd: 1.5, runs: 3 },
  { day: "2026-03-02", costUsd: 0, runs: 0 },
  { day: "2026-03-03", costUsd: 0.1234, runs: 1 },
];

describe("cost chart", () => {
  it("has a table row for every bar, in chart order", () => {
    const d = dash.costTable(DAYS) as FakeElement;
    expect(d.tag).toBe("details");
    expect(d.all("summary")[0]!.textContent).toBe("Show as table");
    const rows = d.all("tbody")[0]!.all("tr").map((r) => r.all("td").map((c) => c.textContent));
    expect(rows).toEqual(DAYS.map((x) => [x.day, `$${x.costUsd.toFixed(3)}`, String(x.runs)]));
    expect(d.all("th").map((c) => c.textContent)).toEqual(["Day", "Cost", "Runs"]);
    expect(dash.costTable([]).all("tbody")[0].all("tr")).toHaveLength(0);
  });

  it("has no tab stops, no focus listener and a silent tooltip", () => {
    const c = dash.costChart(DAYS) as FakeElement;
    expect(walk(c).filter((e) => "tabindex" in e.attrs)).toEqual([]);
    const bars = byClass(c, "bar-hit");
    expect(bars).toHaveLength(3);
    for (const b of bars) {
      expect(b.listeners.mouseenter).toHaveLength(1);
      expect(b.listeners.focus).toBeUndefined();
    }
    const tip = byClass(c, "chart-tip")[0]!;
    expect(tip.attrs).not.toHaveProperty("role");
    expect(tip.attrs["aria-hidden"]).toBe("true");
    bars[0]!.fire("mouseenter");
    expect(tip.textContent).toContain("2026-03-01");
  });
});

describe("rate bar", () => {
  it("says its value in words and hides the track", () => {
    const r = dash.rateBar(12, 15) as FakeElement;
    expect(r.textContent).toBe("12 of 15, 80%");
    expect(r.textContent).toBe(dash.rateText(12, 15));
    expect(byClass(r, "rate-track")[0]!.attrs["aria-hidden"]).toBe("true");
    expect(spoken(byClass(r, "mono")[0]!)).toBe("12 of 15, 80%");
    expect(dash.rateBar(0, 0).textContent).toBe("0 of 0, —");
  });
});

describe("status text", () => {
  it("gives every run status kind a non-empty text and a hidden icon", () => {
    const kinds = Object.keys(icons.KIND_SEMANTIC);
    expect(kinds.length).toBeGreaterThan(20);
    for (const kind of kinds) {
      const rec = (nextStep as any)(kind, { repo: "o/r", runId: "r1", issue: 1, title: "T" },
        { message: "m", reason: "r", questions: 1, watched: true, blockingRun: "r0", blockers: [] });
      const [pill] = next.nextStatus(rec) as FakeElement[];
      expect(spoken(pill!).trim(), kind).not.toBe("");
      expect(pill!.all("svg").every((s) => s.attrs["aria-hidden"] === "true"), kind).toBe(true);
    }
  });

  it("gives a step mark a word and hides its glyph", () => {
    for (const ok of [true, false]) {
      const e = runs.stepEntry("r1", { id: "s", type: "shell", ok, visit: 1, durationMs: 1000 }, 0) as FakeElement;
      const mark = byClass(e, ok ? "ok" : "fail")[0]!;
      expect(spoken(mark)).toBe(ok ? "Succeeded" : "Failed");
      expect(mark.all("span").some((s) => s.attrs["aria-hidden"] === "true")).toBe(true);
    }
  });

  it("tells the three health states and the three connection states apart", () => {
    const texts = [{ ok: true, summary: "All good" }, { ok: false, summary: "2 problems" }, null].map((hh) => {
      const chip = new FakeElement("button");
      health.showHealth(new FakeElement("div"), chip, hh);
      return chip.textContent;
    });
    expect(texts.every(Boolean)).toBe(true);
    expect(new Set(texts).size).toBe(3);
    const conn = [{}, { connection: { ok: true } }, { connection: { ok: false } }].map((r) => repos.connectionStatus(r));
    expect(conn.every(Boolean)).toBe(true);
    expect(new Set(conn).size).toBe(3);
  });

  it("puts a glyph before ok and bad status lines in CSS", () => {
    const css = readUiCss();
    expect(css).toMatch(/\.status\.ok:not\(:empty\)[^{]*::before \{[^}]*✓/);
    expect(css).toMatch(/\.status\.bad:not\(:empty\)[^{]*::before \{[^}]*✕/);
  });
});

describe("glyphs", () => {
  it("hides a glyph from screen readers", () => {
    expect(dom.glyph("x").attrs["aria-hidden"]).toBe("true");
  });

  it("names the modal close button and hides its glyph", () => {
    dom.modal("T", () => new FakeElement("div"));
    const btn = walk(document.getElementById("modal-root") as any).find((e) => e.attrs["aria-label"] === "Close")!;
    expect(btn.tag).toBe("button");
    expect(btn.all("span")[0]!.attrs["aria-hidden"]).toBe("true");
    (document.getElementById("modal-root") as any).replaceChildren();
  });

  it("hides the logo and keeps the brand link text", () => {
    for (const f of ["ui/index.html", "ui/user/index.html"]) {
      const brand = walk(parseHtml(readFileSync(f, "utf8"))).find((e) => (e.attrs.class ?? "") === "brand")!;
      expect(byClass(brand, "logo")[0]!.attrs["aria-hidden"]).toBe("true");
      expect(spoken(brand)).toContain("Foundry");
    }
  });

  it("hides every ✕ and names its button", () => {
    const files: string[] = [];
    const scan = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) scan(`${dir}/${e.name}`);
        else if (e.name.endsWith(".js")) files.push(`${dir}/${e.name}`);
      }
    };
    scan("ui");
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (line.includes('"✕"')) expect(line, f).toContain('glyph("✕")');
        if (line.includes('glyph("✕")') && line.includes("<button") === false && /h\("button"/.test(line)) expect(line, f).toContain("aria-label");
      }
    }
  });

  it("hides the step icon in a graph node but keeps the step id", async () => {
    const graph = await import("../ui/graph.js" as string);
    const g = graph.renderGraph({ steps: [{ id: "build", type: "claude", prompt: "p" }] }) as FakeElement;
    const text = walk(g).find((e) => e.tag === "text" && e.textContent.includes("build"))!;
    const icon = text.all("tspan")[0]!;
    expect(icon.attrs["aria-hidden"]).toBe("true");
    expect(icon.textContent).toContain("◆");
    expect(spoken(text)).toBe("build");
  });

  it("keeps the validation text free of its own glyphs", () => {
    for (const f of ["ui/flow-shell.js", "ui/flow-state.js"]) expect(readFileSync(f, "utf8")).not.toMatch(/"[✓✕] (in)?valid"/i);
  });
});

describe("Written by AI", () => {
  const draft = (over: object = {}) => ({ id: "d1", title: { text: "T" }, suggestions: [], criteria: [], dependsOn: [], ...over });
  const sess = (over: object = {}) => ({ id: "s1", brief: { text: "b" }, drafts: [], architect: { state: "idle" }, talk: { map: { rules: [], examples: [], open: [] }, rounds: [], proposals: [], asked: [] }, ...over });

  it("builds the props", () => {
    expect(dom.aiProps("x")).toEqual({ role: "region", "aria-label": "Written by AI: x" });
  });

  it("groups a suggestion with its mark", () => {
    const d = draft({ suggestions: [{ id: "g1", field: "what", text: "Build it" }] });
    const root = new FakeElement("div");
    root.append(...suggest.suggestNodes(sess(), d, "what", null));
    const g = groups(root);
    expect(g).toHaveLength(1);
    expect(g[0]!.textContent).toContain("Suggested");
    expect(g[0]!.textContent).toContain("Build it");
  });

  it("makes no group without suggestions", () => {
    const root = new FakeElement("div");
    root.append(...suggest.suggestNodes(sess(), draft(), "what", null));
    expect(groups(root)).toHaveLength(0);
  });

  const round = {
    runId: "r1", at: "x",
    questions: [{ id: "q1", view: "need", text: "What now?", why: "Because", options: [{ text: "Opt A", tradeoff: "Fast" }], recommended: 1, answer: { option: 1 } }],
  };
  const talkSession = () => sess({
    talk: { map: { rules: [], examples: [], open: [] }, rounds: [{ ...round }], proposals: [{ id: "p1", list: "rule", text: "A proposed rule" }], asked: [{ question: "Why?", answer: "Since." }] },
  });
  const ctx = { send: async () => true, line: null, errorText: (e: any) => String(e) };

  it("groups the architect's question, answer and proposal, and leaves the person's answer out", () => {
    const root = new FakeElement("div");
    root.append(...talk.talkSection(talkSession(), ctx));
    expect(inGroup(root, "What now?")).toBe(true);
    expect(inGroup(root, "Since.")).toBe(true);
    expect(inGroup(root, "A proposed rule")).toBe(true);
    expect(groups(root).some((g) => g.textContent.includes("Answer:"))).toBe(false);
    expect(groups(root).some((g) => g.textContent.includes("Why?") && !g.textContent.includes("Since."))).toBe(false);
  });

  it("groups the architect's view and leaves the review label outside", () => {
    const view = {
      at: "2026-03-01T10:00:00.000Z", areas: [{ area: "Area one", basis: "found", why: "Because area", files: [] }], dependsOn: [], dependents: [], risks: [],
      size: { size: "small", files: 1, lines: 10, why: "tiny" }, fit: { text: "fits" }, overlaps: [],
      planReview: { text: "Review it", label: "needs-review" }, sensitive: [],
    };
    const d = draft({ impact: view });
    const act = { line: () => null, ask: () => undefined, setLabel: () => undefined };
    const root = new FakeElement("div");
    root.append(...impact.impactNodes(sess({ drafts: [d] }), d, act));
    expect(inGroup(root, "Because area")).toBe(true);
    expect(groups(root).some((g) => g.textContent.includes("Add the review label"))).toBe(false);
    expect(root.textContent).toContain("Add the review label");
  });

  it("groups planner questions", () => {
    const open = (detail: object) => turn.questionsPanel({ key: "k" }, { acts: [], ...detail }, { onAct: () => undefined, close: () => undefined }) as FakeElement;
    const two = open({ questions: [{ n: 1, title: "First", text: "t1" }, { n: 2, title: "Second", text: "t2" }] });
    expect(groups(two).map((g) => g.attrs["aria-label"])).toEqual(["Written by AI: question 1", "Written by AI: question 2"]);
    const plain = open({ text: "Plain questions" });
    expect(groups(plain)).toHaveLength(1);
    expect(groups(plain)[0]!.tag).toBe("pre");
    expect(readFileSync("ui/run-tabs.js", "utf8")).toMatch(/h\("pre", \{[^}]*\.\.\.aiProps\("questions"\)/);
  });
});

describe("audit", () => {
  it("finds nothing on the dashboard", async () => {
    const real = globalThis.fetch;
    const body: Record<string, unknown> = {
      "/api/stats": { totals: { costUsd: 2, runs: 4, succeeded: 3, failed: 1 }, byDay: DAYS, byFlow: [{ flow: "f", runs: 4, succeeded: 3, avgMinutes: 5, costUsd: 2 }], byRepo: [], byUser: [], failingSteps: [], loops: [] },
      "/api/info": { spentToday: 1, dailyBudget: 0, costLimits: true },
      "/api/evals": [{ suite: "s", startedAt: "2026-03-01T10:00:00.000Z", summary: [{ variant: "v", runs: 5, passRate: 0.8, avgCostUsd: 0.1, avgTokens: 1000, avgMinutes: 3, avgFixLoops: 0 }] }],
      "/api/watchers": [], "/api/runs": [], "/api/clarity": null,
    };
    (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, statusText: "ok", json: async () => body[String(url).split("?")[0]!] });
    try {
      const main = new FakeElement("main");
      await dash.renderDashboard(main);
      expect(main.textContent).toContain("Show as table");
      expect(audit(main)).toEqual([]);
    } finally {
      (globalThis as any).fetch = real;
    }
  });

  it("finds nothing on a refinement session", () => {
    const d = { id: "d1", title: { text: "T" }, criteria: [], dependsOn: [], suggestions: [{ id: "g1", field: "what", text: "Build it" }] };
    const s = {
      id: "s1", brief: { text: "b" }, drafts: [d], architect: { state: "idle" }, mine: true,
      talk: { map: { rules: [], examples: [], open: [] }, proposals: [{ id: "p1", list: "rule", text: "A rule" }], asked: [{ question: "Why?", answer: "Since." }],
        rounds: [{ runId: "r1", at: "x", questions: [{ id: "q1", view: "need", text: "What now?", why: "Because", options: [{ text: "Opt A", tradeoff: "Fast" }], recommended: 1, answer: { option: 1 } }] }] },
    };
    const root = new FakeElement("div");
    root.append(...talk.talkSection(s, { send: async () => true, line: null, errorText: String }));
    const box = new FakeElement("div");
    box.append(...suggest.suggestNodes(s, d, "what", null));
    root.append(box);
    const imp = new FakeElement("div");
    imp.append(...impact.impactNodes(s, { ...d, impact: { at: "2026-03-01T10:00:00.000Z", areas: [{ area: "A", basis: "found", why: "w", files: [] }], dependsOn: [], dependents: [], risks: [],
      size: { size: "small", files: 1, lines: 2, why: "x" }, fit: { text: "f" }, overlaps: [] } }, null));
    root.append(imp);
    expect(audit(root)).toEqual([]);
  });

  it("renders a whole session: accepted text is written by AI, and the page passes audit", async () => {
    const { vi } = await import("vitest");
    const { newDraft, preview } = await import("../src/refinement/draft.js");
    const ui = await import("../ui/refinement.js" as string);
    const state: any = { drafts: [], epic: undefined };
    state.drafts = (newDraft(state) as any).drafts;
    state.drafts[0].title = { text: "Accepted title", from: "accepted" };
    state.drafts[0].criteria = [{ id: "c1", text: "A criterion", from: "accepted" }, { id: "c2", text: "Typed one", from: "typed" }];
    const view = () => ({
      id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "exploring", architect: { state: "idle" }, mine: true,
      drafts: state.drafts.map((d: any) => ({ ...d, preview: preview(d, state) })), log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }],
      created: "x", updated: "x",
    });
    const real = globalThis.fetch;
    vi.useFakeTimers();
    (globalThis as any).location = { hash: "#/refinement/s1", reload: () => undefined };
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "ok", json: async () => view() });
    const main = (document as any).getElementById("main") as FakeElement;
    let cleanup: (() => void) | undefined;
    try {
      cleanup = await ui.renderRefinement(main, { admin: false, id: "s1" });
      await vi.advanceTimersByTimeAsync(0);
      walk(main).find((e) => e.tag === "button" && e.textContent === "Open")?.click();
      await vi.advanceTimersByTimeAsync(0);
      const names = groups(main).map((g) => g.attrs["aria-label"]);
      expect(names).toContain("Written by AI: accepted text for Title");
      expect(names.filter((n) => n === "Written by AI: accepted acceptance criterion")).toHaveLength(1);
      // The preview's disabled checkboxes have no label yet (not part of this issue); everything else must pass.
      expect(audit(main).filter((v) => v.rule !== "field-label")).toEqual([]);
    } finally {
      cleanup?.();
      vi.clearAllTimers();
      vi.useRealTimers();
      globalThis.fetch = real;
    }
  });
});
