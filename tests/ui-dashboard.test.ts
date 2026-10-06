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
  it("shows Name, Runs and Cost, one row per account, in the given order", () => {
    const card = ui.byUserCard([
      { owner: "u1", name: "Ann", runs: 3, costUsd: 1.5 },
      { owner: "u2", name: "Bob", runs: 1, costUsd: 0.25 },
    ]) as FakeElement;
    expect(card.all("h3")[0]!.textContent).toBe("By user");
    expect(card.all("th").map((x) => x.textContent)).toEqual(["Name", "Runs", "Cost"]);
    const rows = card.all("tr").slice(1).map((r) => r.all("td").map((x) => x.textContent));
    expect(rows).toEqual([["Ann", "3", "$1.50"], ["Bob", "1", "$0.25"]]);
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
