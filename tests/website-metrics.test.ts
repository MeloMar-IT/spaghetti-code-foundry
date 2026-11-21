import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ES modules of the website, without types
import { build } from "../website/build.mjs";
// @ts-expect-error plain ES module of the website, without types
import * as M from "../website/assets/metrics.js";
// @ts-expect-error plain ES module of the scripts folder, without types
import { websiteDefinitions } from "../scripts/outcome-definitions.mjs";
import { computeTotals, medianOf } from "../collector/totals.js";
import { DURATION_EDGES_MS, PARTS_EDGES, emptyHistogram, type ShareReport } from "../src/metrics-share/report.js";
import { randomInstall, report } from "./collector-report.js";

type Page = { url: string; html: string };
const NOW = new Date("2026-11-20T12:00:00Z");
const installs = [randomInstall(), randomInstall(), randomInstall()];
const hist = (bucket: number, n: number, sum: number) => {
  const h = emptyHistogram(DURATION_EDGES_MS);
  h.counts[bucket] = n;
  h.sum = sum;
  return h;
};
function reportFor(install: string, day: string, runs = 2): ShareReport {
  const base = report();
  const parts = emptyHistogram(PARTS_EDGES);
  parts.counts[1] = 1;
  parts.sum = 3;
  return report({
    install,
    day,
    accountsSharing: 1,
    changes: { runsStarted: runs, runsEnded: { succeeded: runs, failed: 0, cancelled: 0 }, workItemsDelivered: 1, pullRequestsDelivered: 1 },
    speed: { ...base.speed, runDuration: hist(4, runs, 100_000), issueToPullRequest: hist(5, 1, 2_400_000), stepTime: { implement: hist(3, 1, 600_000) } },
    splits: { issuesSplit: 1, partsPerSplit: parts },
    rework: { reworkedAfterDelivery: 1, repeatedSteps: { fix_tests: 1 } },
    quality: { firstPassTests: { passed: 1, counted: 2 }, mergeRate: { delivered: 1, counted: 1 }, evidence: { complete: 2, counted: 2 }, policyBlocks: 1 },
    cost: { byModel: { opus: { tokensIn: 100, tokensOut: 50, costUsd: 1.5 } }, byStep: { implement: { tokensIn: 100, tokensOut: 50, costUsd: 1.5 } }, costUsd: 1.5 },
    use: { bySource: { issues: runs }, byFlow: { "issue-gitflow": runs }, repositories: 1 },
  });
}
const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
const old = "2026-07-22"; // 121 days before NOW
const sample = () => computeTotals([...installs.flatMap((i) => days.map((d) => reportFor(i, d))), ...installs.map((i) => reportFor(i, old, 7))], NOW);
const defs = {
  outcomes: websiteDefinitions(),
  measures: Object.fromEntries(M.MEASURE_IDS.map((id: string) => [id, { label: `Label ${id}`, definition: `Definition of ${id}.` }])),
};
const figures = (h: string) => [(h.match(/<figure/g) ?? []).length, (h.match(/<svg/g) ?? []).length, (h.match(/<table/g) ?? []).length];

describe("website: definitions from the app", () => {
  it("keeps website/content/outcome-definitions.json equal to OUTCOME_DEFINITIONS", () => {
    const file = JSON.parse(readFileSync(join(__dirname, "../website/content/outcome-definitions.json"), "utf8"));
    expect(file, "run `npm run website:definitions`").toEqual(websiteDefinitions());
    expect(file.map((d: { id: string }) => d.id)).not.toContain("returning_users");
    for (const id of M.OUTCOME_IDS) expect(file.map((d: { id: string }) => d.id)).toContain(id);
  });
});

describe("website: the Metrics page build", () => {
  let dir = "";
  let withSample: { problems: string[]; pages: Page[]; out: string };
  let without: { problems: string[]; pages: Page[]; out: string };
  const samplePath = () => join(dir, "metrics.json");
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scf-metrics-"));
    writeFileSync(samplePath(), JSON.stringify(sample()));
    withSample = build({ out: join(dir, "a"), quiet: true, gitDates: false, metrics: samplePath() });
    without = build({ out: join(dir, "b"), quiet: true, gitDates: false });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("builds /metrics/ with a sample metrics.json", () => {
    expect(withSample.problems).toEqual([]);
    const html = withSample.pages.find((p) => p.url === "/metrics/")!.html;
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain('href="/privacy/metrics/"');
    expect(html).toContain('id="metrics-app"');
    expect(html).toContain('<script type="module" src="/assets/metrics.js">');
    const json = html.match(/<script type="application\/json" id="metric-definitions">(.*?)<\/script>/s)![1]!;
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.measures).sort()).toEqual([...M.MEASURE_IDS].sort());
    expect(parsed.outcomes).toEqual(websiteDefinitions());
    expect(JSON.parse(readFileSync(join(withSample.out, "metrics.json"), "utf8"))).toEqual(sample());
    expect(readFileSync(join(withSample.out, "sitemap.xml"), "utf8")).toContain("/metrics/</loc>");
    for (const p of withSample.pages.filter((x) => x.url === "/" || x.url === "/features/")) expect(p.html).toContain('<a href="/metrics/"');
  });

  it("builds without a metrics.json and writes none", () => {
    expect(without.problems).toEqual([]);
    expect(existsSync(join(without.out, "metrics.json"))).toBe(false);
    const html = without.pages.find((p) => p.url === "/metrics/")!.html;
    expect(html).toContain("Loading the numbers");
    expect(html).toContain("<noscript>");
  });

  it("reports a --metrics file that is not a metrics.json", () => {
    writeFileSync(join(dir, "bad.json"), '{"version":2}');
    expect(build({ out: join(dir, "c"), quiet: true, gitDates: false, metrics: join(dir, "bad.json") }).problems).toEqual(["--metrics: not a metrics.json"]);
    expect(build({ out: join(dir, "c"), quiet: true, gitDates: false, metrics: join(dir, "missing.json") }).problems).toEqual(["--metrics: not a metrics.json"]);
  });
});

describe("website: rendering the numbers", () => {
  it("shows the seven sections with a definition for each number and a table for each chart", () => {
    const html = M.renderMetrics(sample(), defs, "30d");
    const titles = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
    expect(titles).toEqual(["Changes", "Speed", "Splits", "Rework", "Quality", "Cost and models", "Use"]);
    for (const o of defs.outcomes.filter((d: { id: string }) => M.OUTCOME_IDS.includes(d.id))) expect(html).toContain(M.esc(o.definition));
    for (const id of M.MEASURE_IDS) if (id !== "installsPerWeek") expect(html).toContain(`Definition of ${id}.`);
    const [f, s, t] = figures(html);
    expect(f).toBeGreaterThan(0);
    expect(s).toBe(f);
    expect(t).toBe(f);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    expect(html).toContain('aria-pressed="true">Last 30 days');
  });

  it("adds the days of the period, groups weeks by Monday and recomputes shares", () => {
    const m = sample();
    const p = M.periodOf(m, "30d");
    expect(p.totals.changes.runsStarted).toBe(3 * 5 * 2);
    expect(p.weeks.map((w: { week: string }) => w.week)).toEqual(["2026-11-16"]);
    expect(p.totals.quality.firstPassTests.share).toBe(0.5);
    const html = M.renderMetrics(m, defs, "30d");
    expect(html).toContain("50%");
    expect(html).toContain("$0.75"); // cost 22.5 / 30 succeeded
  });

  it("uses whole weeks for 90 days and all time, and leaves out the week that starts before the window", () => {
    const m = sample();
    expect(M.periodOf(m, "90d").weeks.map((w: { week: string }) => w.week)).toEqual(["2026-11-16"]);
    const all = M.periodOf(m, "all");
    expect(all.weeks.map((w: { week: string }) => w.week)).toEqual([M.weekOf(old), "2026-11-16"]);
    expect(all.totals.changes.runsStarted).toBe(30 + 3 * 7);
    expect(M.renderMetrics(m, defs, "all")).toContain('aria-pressed="true">All time');
    expect(M.renderMetrics(m, defs, "all")).toContain("up to 400 days");
  });

  it("does not add up installs: the weekly chart uses the installs of each week", () => {
    const m = sample();
    const html = M.renderMetrics(m, defs, "90d");
    expect(html).toContain("Label installsPerWeek");
    const chart = html.match(/<figure[^>]*><figcaption>Label installsPerWeek.*?<\/figure>/s)![0];
    expect(chart).toContain("<td>3</td>");
    expect(chart).not.toContain("<td>15</td>");
    expect(M.sumTotals(m.days).installs).toBeUndefined();
  });

  it("says so, without charts, when there is no data", () => {
    const empty = { version: 1, generatedAt: NOW.toISOString(), minInstalls: 3, edges: { durationMs: [...DURATION_EDGES_MS], partsPerSplit: [...PARTS_EDGES] }, days: [], weeks: [] };
    for (const [input, text] of [[null, "cannot be loaded"], [{ version: 2 }, "cannot be loaded"], ["garbage", "cannot be loaded"], [empty, "No numbers are shared yet"]] as const) {
      const html = M.renderMetrics(input, defs);
      expect(html).toContain(text);
      expect(html).not.toMatch(/<svg|<table|<figure/);
    }
    const onlyOld = computeTotals(installs.map((i) => reportFor(i, old)), NOW);
    const html = M.renderMetrics(onlyOld, defs, "30d");
    expect(html).toContain("There are no numbers for the period “Last 30 days” yet.");
    expect(html).toContain("data-period");
    expect(html).not.toMatch(/<svg|<table/);
  });

  it("rejects malformed version 1 data", () => {
    const ok = sample();
    expect(M.isMetrics(ok)).toBe(true);
    const bad = (f: (m: any) => void) => {
      const m = structuredClone(ok) as any;
      f(m);
      return M.isMetrics(m);
    };
    expect(bad((m) => (m.days[0].day = "2026-13-45"))).toBe(false);
    expect(bad((m) => (m.generatedAt = "nope"))).toBe(false);
    expect(bad((m) => (m.edges.durationMs = "x"))).toBe(false);
    expect(bad((m) => (m.days[0].speed.runDuration.counts = [1, 2]))).toBe(false);
    expect(bad((m) => (m.weeks[0].changes = 5))).toBe(false);
    expect(bad((m) => (m.sharing = { since: "x", installs: 1, accounts: 1 }))).toBe(false);
    expect(bad((m) => delete m.sharing)).toBe(true);
    expect(bad((m) => delete m.days[0].speed)).toBe(true);
  });

  it("draws cost bars in dollars only, and lists the names without a cost in a sentence", () => {
    const m = sample() as any;
    m.days[0].cost.byModel["unpriced-model"] = { tokensIn: 200_000, tokensOut: 0 };
    const html = M.renderMetrics(m, defs, "30d");
    const chart = html.match(/<figure[^>]*><figcaption>Label costByModel.*?<\/figure>/s)![0];
    expect(chart).toContain("$");
    expect(chart).not.toContain("200,000 tokens<");
    expect(chart).not.toContain("unpriced-model");
    expect(html).toContain("No cost is known for unpriced-model; only the tokens are counted.");
  });

  it("escapes every name from the data", () => {
    const m = sample() as any;
    m.days[0].cost.byModel["<img src=x onerror=alert(1)>"] = { tokensIn: 1, tokensOut: 1, costUsd: 1 };
    const html = M.renderMetrics(m, defs, "30d");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img");
  });
});

describe("website: quantile and sums", () => {
  it("gives the receiver's median for q = 0.5", () => {
    for (const counts of [[0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 5]]) {
      expect(M.quantile(counts, DURATION_EDGES_MS, 0.5, false)?.value).toBe(medianOf(counts, DURATION_EDGES_MS, false));
    }
    const parts = [0, 2, 2, 0, 0, 0, 0, 0, 0, 0];
    expect(M.quantile(parts, PARTS_EDGES, 0.5, true)?.value).toBe(medianOf(parts, PARTS_EDGES, true));
  });
  it("finds the 90th percentile, the open last bucket and an empty histogram", () => {
    const c = emptyHistogram(DURATION_EDGES_MS).counts;
    c[1] = 8;
    c[3] = 2;
    const q = M.quantile(c, DURATION_EDGES_MS, 0.9, false);
    expect(q.value).toBeGreaterThanOrEqual(5 * 60_000);
    expect(q.value).toBeLessThanOrEqual(15 * 60_000);
    const open = emptyHistogram(DURATION_EDGES_MS).counts;
    open[open.length - 1] = 4;
    expect(M.quantile(open, DURATION_EDGES_MS, 0.9, false)).toEqual({ value: DURATION_EDGES_MS[DURATION_EDGES_MS.length - 1], open: true });
    expect(M.quantile(emptyHistogram(DURATION_EDGES_MS).counts, DURATION_EDGES_MS, 0.5, false)).toBeUndefined();
  });
  it("adds numbers and histograms, keeps keys that one period has, works shares out again", () => {
    const a = { changes: { runsStarted: 2 }, speed: { runDuration: { counts: [1, 0], sum: 5 } }, quality: { mergeRate: { delivered: 1, counted: 1, share: 1 } }, installs: 3 };
    const b = { changes: { runsStarted: 3, workItemsDelivered: 4 }, speed: { runDuration: { counts: [0, 2], sum: 7 } }, quality: { mergeRate: { delivered: 0, counted: 3, share: 0 } }, installs: 3 };
    const s = M.sumTotals([a, b]);
    expect(s.changes).toEqual({ runsStarted: 5, workItemsDelivered: 4 });
    expect(s.speed.runDuration).toEqual({ counts: [1, 2], sum: 12 });
    expect(s.quality.mergeRate.share).toBe(0.25);
    expect(s.installs).toBeUndefined();
  });
  it("gets the Monday of a week like the receiver", () => {
    expect(M.weekOf("2026-11-22")).toBe("2026-11-16");
    expect(M.weekOf("2026-11-16")).toBe("2026-11-16");
  });
});

describe("website: loading /metrics.json", () => {
  const fakeRoot = () => {
    const root = { innerHTML: "", click: (_: unknown) => {}, addEventListener: (_: string, f: (e: unknown) => void) => (root.click = f) };
    return root;
  };
  const answer = (status: number, body?: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  it("shows the numbers, and changes the period on a click", async () => {
    const root = fakeRoot();
    let seen: { url: string; init: RequestInit } | undefined;
    await M.start(root, defs, async (url: string, init: RequestInit) => {
      seen = { url, init };
      return answer(200, sample())();
    });
    expect(seen!.url).toBe("/metrics.json");
    expect(seen!.init.credentials).toBe("omit");
    expect(root.innerHTML).toContain(">Changes</h2>");
    expect(root.innerHTML).toContain("Showing last 30 days");
    root.click({ target: { closest: () => ({ dataset: { period: "all" } }) } });
    expect(root.innerHTML).toContain("Showing all time");
    root.click({ target: { closest: () => null } });
    expect(root.innerHTML).toContain("Showing all time");
  });

  it("says the numbers cannot be loaded for 503, 404, bad JSON, a network error and a wrong version", async () => {
    const cases = [answer(503), answer(404), async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) as unknown as Response, async () => { throw new Error("offline"); }, answer(200, { version: 2 })];
    for (const f of cases) {
      const root = fakeRoot();
      await M.start(root, defs, f);
      expect(root.innerHTML).toContain("cannot be loaded");
      expect(root.innerHTML).not.toMatch(/<svg|<table/);
    }
  });

  it("says there are no numbers yet when the file loads but is empty", async () => {
    const root = fakeRoot();
    await M.start(root, defs, answer(200, { ...sample(), days: [], weeks: [] }));
    expect(root.innerHTML).toContain("No numbers are shared yet");
  });

  it("stops waiting after the timeout", async () => {
    const root = fakeRoot();
    await M.start(root, defs, (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))), 20);
    expect(root.innerHTML).toContain("cannot be loaded");
  });
});
