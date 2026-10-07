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
