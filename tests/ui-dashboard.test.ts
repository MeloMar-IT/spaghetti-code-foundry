import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/dashboard.js" as string);
});
afterAll(() => restore());

describe("byUserCard", () => {
  const cells = (card: FakeElement) => card.all("tr").slice(1).map((r) => r.all("td").map((x) => x.textContent));

  it("shows the six columns, one row per account, with limits as value / limit", () => {
    const card = ui.byUserCard([
      { owner: "u1", name: "Ann", runs: 3, costUsd: 1.5, today: { runs: 2, costUsd: 0.4 }, active: 1, limits: { maxRunsPerDay: 5, maxConcurrent: 2, dailyBudgetUsd: 1 }, atLimit: [] },
      { owner: "u2", name: "Bob", runs: 1, costUsd: 0.25, today: { runs: 2, costUsd: 0.4 }, active: 1, limits: {}, atLimit: [] },
    ]) as FakeElement;
    expect(card.all("h3")[0]!.textContent).toBe("By user");
    expect(card.all("th").map((x) => x.textContent)).toEqual(["Name", "Runs", "Cost", "Runs today", "Active now", "Cost today"]);
    expect(cells(card)).toEqual([["Ann", "3", "$1.50", "2 / 5", "1 / 2", "$0.40 / $1.00"], ["Bob", "1", "$0.25", "2", "1", "$0.40"]]);
  });

  it("marks an account at a limit and names the limit in the title", () => {
    const card = ui.byUserCard([
      { owner: "u1", name: "Ann", runs: 1, costUsd: 0, today: { runs: 5, costUsd: 0 }, active: 0, limits: { maxRunsPerDay: 5 }, atLimit: ["maxRunsPerDay"] },
      { owner: "u2", name: "Bob", runs: 1, costUsd: 0, today: { runs: 1, costUsd: 0 }, active: 0, limits: { maxRunsPerDay: 5 }, atLimit: [] },
    ]) as FakeElement;
    const rows = card.all("tr").slice(1);
    expect(rows[0]!.attrs.class).toContain("at-limit");
    expect(rows[0]!.all("td")[0]!.textContent).toContain("at limit");
    expect(rows[0]!.all("span")[0]!.attrs.title).toContain("Runs per day");
    expect(rows[1]!.attrs.class ?? "").not.toContain("at-limit");
    expect(rows[1]!.textContent).not.toContain("at limit");
  });

  it("keeps the digits of a small daily budget", () => {
    const card = ui.byUserCard([{ owner: "u1", name: "Ann", runs: 1, costUsd: 0, today: { runs: 0, costUsd: 0 }, active: 0, limits: { dailyBudgetUsd: 0.001 }, atLimit: [] }]) as FakeElement;
    expect(cells(card)[0]![5]).toBe("$0.00 / $0.001");
  });

  it("keeps a tiny daily budget readable", () => {
    const card = ui.byUserCard([{ owner: "u1", name: "Ann", runs: 1, costUsd: 0, today: { runs: 0, costUsd: 0 }, active: 0, limits: { dailyBudgetUsd: 1e-7 }, atLimit: [] }]) as FakeElement;
    expect(cells(card)[0]![5]).toBe("$0.00 / $0.0000001");
  });

  it("shows zeros for an old answer without today, active or limits", () => {
    const card = ui.byUserCard([{ owner: "u1", name: "Ann", runs: 3, costUsd: 1.5 }]) as FakeElement;
    expect(cells(card)).toEqual([["Ann", "3", "$1.50", "0", "0", "$0.00"]]);
  });

  it("shows 'deleted user' for an account that is gone and 'no owner' as sent", () => {
    const card = ui.byUserCard([
      { owner: "ghost", name: "deleted account", runs: 1, costUsd: 0.5 },
      { owner: "", name: "no owner", runs: 2, costUsd: 0 },
    ]) as FakeElement;
    expect(card.textContent).toContain("deleted user");
    expect(card.textContent).not.toContain("deleted account");
    expect(card.textContent).toContain("no owner");
  });

  it("shows 'No runs yet.' for an empty list", () => {
    const card = ui.byUserCard([]) as FakeElement;
    expect(card.textContent).toContain("No runs yet.");
    expect(card.all("table")).toHaveLength(0);
  });
});

describe("byRepoCard", () => {
  it("shows runs and cost over 30 days plus today's runs and cost", () => {
    const card = ui.byRepoCard([{ repo: "acme/app", runs: 4, costUsd: 2, today: { runs: 1, costUsd: 0.5 } }]) as FakeElement;
    expect(card.all("th").map((x) => x.textContent)).toEqual(["Repository", "Runs", "Cost", "Runs today", "Cost today"]);
    expect(card.all("tr").slice(1).map((r) => r.all("td").map((x) => x.textContent))).toEqual([["acme/app", "4", "$2.00", "1", "$0.50"]]);
  });

  it("shows zeros for an old answer and 'No runs yet.' for an empty list", () => {
    const old = ui.byRepoCard([{ repo: "a/b", runs: 1, costUsd: 1 }]) as FakeElement;
    expect(old.all("tr")[1]!.all("td").map((x) => x.textContent)).toEqual(["a/b", "1", "$1.00", "0", "$0.00"]);
    expect((ui.byRepoCard([]) as FakeElement).textContent).toContain("No runs yet.");
  });
});

describe("states", () => {
  const realFetch = globalThis.fetch;
  const wait = () => new Promise((r) => setTimeout(r, 10));
  const stats = {
    totals: { runs: 3, succeeded: 2, failed: 1, costUsd: 4 }, byDay: [{ day: "2026-10-01", costUsd: 1, runs: 1 }],
    byFlow: [], byRepo: [{ repo: "acme/app", runs: 1, costUsd: 1 }], byUser: [], failingSteps: [], loops: [],
  };
  const info = { spentToday: 1, dailyBudget: 5, costLimits: true };
  const evals = [{ suite: "suite-a", startedAt: "2026-10-01T09:00:00.000Z", summary: [{ variant: "v1", runs: 2, passRate: 1, avgCostUsd: 0.1, avgTokens: 1000, avgMinutes: 2, avgFixLoops: 0 }, { variant: "v2", runs: 4, passRate: 0.5, qualityRate: 1, skills: { runs: 4, selectionRate: 1, contextRate: 0.75, activationRate: 0.5 }, avgCostUsd: 0.1, avgTokens: 1000, avgMinutes: 2, avgFixLoops: 0 }] }];
  const URLS = ["/api/stats", "/api/info", "/api/evals", "/api/watchers", "/api/runs", "/api/clarity"];
  const NAMES: Record<string, string> = {
    "/api/stats": "the statistics", "/api/info": "today's spending", "/api/evals": "evals", "/api/watchers": "the watchers", "/api/runs": "the runs", "/api/clarity": "your turn in numbers",
  };
  let hits: string[];
  let held: Promise<void> | undefined;
  const install = (fail: string[]) => {
    hits = [];
    (globalThis as any).fetch = async (url: string) => {
      const path = url.split("?")[0]!;
      hits.push(path);
      if (held) await held;
      const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
      if (fail.includes(path)) return reply({ error: "boom" }, 500);
      const body: Record<string, unknown> = {
        "/api/stats": stats, "/api/info": info, "/api/evals": evals,
        "/api/watchers": [{ id: "w1", source: "issues", github_repo: "o/a", label: "go", enabled: true, state: { name: "running" }, status: { id: "w1", lastActions: [] } }],
        "/api/runs": [], "/api/clarity": null,
      };
      return reply(body[path]);
    };
  };
  const render = async (fail: string[] = []) => {
    install(fail);
    const main = new FakeElement("div");
    await ui.renderDashboard(main);
    return main;
  };
  const errors = (main: FakeElement) => main.all("div").filter((d) => (d.attrs.class ?? "").split(" ").includes("state-error"));
  const heading = (main: FakeElement, text: string) => main.all("h3").some((x) => x.textContent === text);
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("partNote names the part, is an alert and calls Retry", () => {
    let retried = 0;
    const note = ui.partNote("evals", Object.assign(new Error("boom"), { status: 500 }), () => retried++) as FakeElement;
    expect(note.textContent).toContain("Could not load evals.");
    expect(note.textContent).toContain("The rest of the dashboard is shown.");
    expect(note.attrs.role).toBe("alert");
    note.all("button").find((b) => b.textContent === "Retry")!.click();
    expect(retried).toBe(1);
  });

  it("draws a skeleton while it loads", async () => {
    install([]);
    let release!: () => void;
    held = new Promise<void>((r) => (release = r));
    const main = new FakeElement("div");
    const done = ui.renderDashboard(main);
    await wait();
    expect(main.all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(true);
    held = undefined;
    release();
    await done;
    expect(main.all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(false);
  });

  it("with everything loaded it has no error and says when it was updated", async () => {
    const main = await render();
    expect(errors(main)).toHaveLength(0);
    expect(main.all("p").some((p) => (p.attrs.class ?? "") === "stale-note" && p.textContent.startsWith("Updated"))).toBe(true);
  });

  it("shows skill rates of an evaluation variant, and a dash for one without", async () => {
    const main = await render();
    expect(main.all("th").some((t) => t.textContent === "Skills")).toBe(true);
    expect(main.all("th").some((t) => t.textContent === "Quality")).toBe(true);
    const cells = main.all("td").map((t) => t.textContent);
    expect(cells).toContain("selection 100% · context 75% · activation 50%");
    expect(cells).toContain("—");
  });

  it.each(URLS)("when %s fails, its part is named and the rest is shown", async (url) => {
    const main = await render([url]);
    const notes = errors(main);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain(`Could not load ${NAMES[url]}.`);
    expect(notes[0]!.all("button").some((b) => b.textContent === "Retry")).toBe(true);
    if (url === "/api/evals") expect(main.textContent).toContain("By repository");
    else if (url === "/api/stats") expect(heading(main, "Evaluations")).toBe(true);
    else expect(heading(main, "Cost per day")).toBe(true);
    if (url === "/api/watchers") expect(heading(main, "Waiting — what happens next")).toBe(true);
    if (url === "/api/evals") expect(main.textContent).not.toContain("No evaluations yet.");
  });

  it("shows a dash in the tiles of a part that failed", async () => {
    const main = await render(["/api/stats"]);
    const values = main.all("div").filter((d) => d.attrs.class === "tile-value").map((d) => d.textContent);
    expect(values).toEqual(["$1.00", "—", "—", "0"]);
  });

  it("when all six calls fail, every part is named and each note has Retry", async () => {
    const main = await render(URLS);
    const notes = errors(main);
    expect(notes).toHaveLength(6);
    for (const url of URLS) expect(notes.some((n) => n.textContent.includes(`Could not load ${NAMES[url]}.`))).toBe(true);
    expect(notes.every((n) => n.all("button").some((b) => b.textContent === "Retry"))).toBe(true);
  });

  it("Retry on a note asks the API again and the note goes", async () => {
    const main = await render(["/api/evals"]);
    install([]);
    errors(main)[0]!.all("button").find((b) => b.textContent === "Retry")!.click();
    await wait();
    expect(hits.filter((u) => u === "/api/evals")).toHaveLength(1);
    expect(errors(main)).toHaveLength(0);
    expect(main.textContent).toContain("suite-a");
  });
});
