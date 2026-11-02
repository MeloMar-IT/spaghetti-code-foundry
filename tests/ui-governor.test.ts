import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/governor.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const hist = (over: object = {}) => ({ since: "2026-10-01T00:00:00.000Z", now: "2026-10-02T00:00:00.000Z", start: 6, steps: [], belowMs: 0, reasons: [], ...over });
const full = () => ({
  status: "ok", at: "2026-10-02T00:00:00.000Z", configured: 6, limit: 4,
  caps: [{ who: "busy", runs: 4, why: "I am here", until: "x" }, { who: "load", runs: 5, why: "machine load", until: "x" }],
  cap: { runs: 5, why: "2 runs fit" }, tests: 1, workers: 2, paused: "2026-10-01T23:00:00.000Z",
  capacity: { cores: 8, free: 3, reserve: 2, fit: 2 },
  foundry: { cores: 1.5, tests: 1, server: 0.2 },
  other: { cores: 4, top: ["a", "b", "c", "d", "<img src=x onerror=1>"].map((program, i) => ({ program, cores: 2 - i * 0.1 })) },
  history: hist({ start: 6, steps: [{ at: "2026-10-01T06:00:00.000Z", runs: 5, why: "2 runs fit" }, { at: "2026-10-01T12:00:00.000Z", runs: 4 }], belowMs: 18 * 3_600_000, lowest: 4, reasons: [{ why: "the runs that fit next to other programs", ms: 18 * 3_600_000 }] }),
});
const body = (view: unknown) => ui.governorBody(view) as FakeElement;

describe("the Load governor card", () => {
  it("shows the cap now, each cap with its reason, the free cores, five programs and the Foundry", () => {
    const el = body(full());
    const t = el.textContent;
    expect(t).toContain("Runs at once now: 4 of 6");
    expect(t).toContain("Busy mode (switched on): 4 at once");
    expect(t).toContain("Load governor: 5 at once");
    expect(t).toContain("machine load");
    expect(t).toContain("Test runs: 1 at once");
    expect(t).toContain("at most 2 per test run");
    expect(t).toContain("paused since");
    expect(t).toContain("Free capacity: 3.0 cores of 8");
    expect(t).toContain("2 runs fit");
    expect(t).toContain("Other programs: 4.0 cores");
    expect(el.all("tr")).toHaveLength(1 + 5 + 1 + 1 + 2); // programs, then the list: head, start and 2 steps
    expect(t).toContain("The Foundry: 1.5 cores (tests 1.0, server 0.2)");
    expect(t).toContain("Below 6 for 18 h in the last 24 hours (lowest 4)");
    expect(walk(el).filter((e) => e.tag === "button")).toEqual([]);
  });

  it("draws a step path from the left edge with a V per step, and a list", () => {
    const el = body(full());
    const path = walk(el).find((e) => e.attrs.class === "cap-line")!;
    expect(path.attrs.d).toMatch(/^M44,/);
    expect(path.attrs.d.match(/V/g)).toHaveLength(2);
    expect(walk(el).find((e) => e.tag === "svg")!.attrs.role).toBe("img");
    expect(el.textContent).toContain("Show as list");
    expect(el.textContent).toContain("24 h ago");
  });

  it("shows a program name only as text", () => {
    const el = body(full());
    expect(walk(el).some((e) => e.tag === "img")).toBe(false);
    expect(el.textContent).toContain("<img src=x onerror=1>");
  });

  it("says there is no result for status none, with no chart", () => {
    const el = body({ status: "none", configured: 6, limit: 6, caps: [], history: hist() });
    expect(el.textContent).toContain("scf governor install");
    expect(el.textContent).toContain("No changes in the last 24 hours");
    expect(walk(el).some((e) => e.attrs.class === "cap-line")).toBe(false);
  });

  it("for an old result shows no measurements but keeps the limits that hold", () => {
    const el = body({ status: "old", at: "2026-10-01T00:00:00.000Z", configured: 6, limit: 3, caps: [{ who: "load", runs: 3, why: "machine load", until: "x" }], history: hist() });
    expect(el.textContent).toContain("The last check was");
    expect(el.textContent).toContain("Measurements are not shown");
    expect(el.textContent).toContain("Load governor: 3 at once");
    expect(el.all("tr")).toHaveLength(0);
    expect(el.textContent).not.toContain("Free capacity");
  });

  it("says free capacity is not measured when it is missing", () => {
    const v = full() as any;
    delete v.capacity;
    expect(body(v).textContent).toContain("Free capacity: not measured.");
  });
});
