import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rc: any;
let rh: any;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  rc = await import("../ui/run-checks.js" as string);
  rh = await import("../ui/run-header.js" as string);
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const CHECKS = [{ id: "plan-1", try: "Open the page", expect: "A red button" }, { id: "plan-2", try: "Click it", expect: "A dialog opens" }];
const waiting = (over: Record<string, unknown> = {}) => ({
  runId: "r1", flow: "walk", status: "waiting", task: "Do it", startedAt: "2026-01-01T11:00:00Z", vars: {}, history: [], state: { next: "b" },
  next: nextStep("approval", { runId: "r1" } as any), checks: CHECKS, checksRev: "rev1", ...over,
});
const btn = (root: FakeElement, focus: string) => root.all("button").find((b) => b.attrs["data-focus"] === focus)!;
const count = (el: FakeElement) => el.all("p").find((p) => p.attrs["aria-live"] === "polite")!.textContent;

describe("personChecks, openChecks, approveLabel", () => {
  it("gives no rows unless a waiting run has usable checks", () => {
    expect(rc.personChecks(waiting({ status: "running" }))).toEqual([]);
    expect(rc.personChecks(waiting({ checks: undefined }))).toEqual([]);
    expect(rc.personChecks(waiting({ checks: [] }))).toEqual([]);
    expect(rc.personChecks(waiting({ checks: [{ id: "x", try: "a" }, null, { id: "", try: "a", expect: "b" }] }))).toEqual([]);
    expect(rc.personChecks(null)).toEqual([]);
  });
  it("reads the marks and ignores an unknown one", () => {
    const rows = rc.personChecks(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" }, "plan-2": { mark: "bad", at: "t" } } }));
    expect(rows.map((r: any) => [r.id, r.mark])).toEqual([["plan-1", "works"], ["plan-2", null]]);
    expect(rows[0].rev).toBe("rev1");
  });
  it("counts the open checks and words the Approve label", () => {
    expect(rc.approveLabel(waiting({ checks: [] }))).toBe("Approve");
    expect(rc.approveLabel(waiting())).toBe("Approve — 2 checks not marked yet");
    const one = waiting({ checkMarks: { "plan-1": { mark: "not-quite", at: "t" } } });
    expect(rc.openChecks(one)).toBe(1);
    expect(rc.approveLabel(one)).toBe("Approve — 1 check not marked yet");
    expect(rc.approveLabel(one, "✔ Approve")).toBe("✔ Approve — 1 check not marked yet");
    expect(rc.approveLabel(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" }, "plan-2": { mark: "works", at: "t" } } }))).toBe("Approve");
  });
});

describe("createCheckList", () => {
  it("is hidden without checks, and shows the rows and the count with them", () => {
    const list = rc.createCheckList({ onMark: vi.fn() });
    list.update(waiting({ checks: [] }));
    expect(list.el.hidden).toBe(true);
    list.update(waiting());
    expect(list.el.hidden).toBe(false);
    expect(list.el.all("li")).toHaveLength(2);
    expect(list.el.textContent).toContain("Try: Open the page");
    expect(list.el.textContent).toContain("Expect: A red button");
    expect(count(list.el)).toBe("0 of 2 done");
    list.update(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" } } }));
    expect(count(list.el)).toBe("1 of 2 done");
    expect(btn(list.el, "check-works-plan-1").getAttribute("aria-pressed")).toBe("true");
    expect(btn(list.el, "check-works-plan-1").textContent).toBe("✓ Works");
    expect(btn(list.el, "check-not-quite-plan-1").getAttribute("aria-pressed")).toBe("false");
  });
  it("sends the mark, and null when the pressed button is clicked again", async () => {
    const onMark = vi.fn(async () => ({}));
    const list = rc.createCheckList({ onMark });
    list.update(waiting());
    btn(list.el, "check-works-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-1", "works", "rev1");
    list.update(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" } } }));
    btn(list.el, "check-works-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-1", null, "rev1");
    btn(list.el, "check-not-quite-plan-2").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-2", "not-quite", "rev1");
  });
  it("ignores a second click while a call is out, and draws the marks the call returns", async () => {
    let finish!: (v: unknown) => void;
    const onMark = vi.fn(() => new Promise((r) => { finish = r; }));
    const list = rc.createCheckList({ onMark });
    list.update(waiting());
    const b = btn(list.el, "check-works-plan-1");
    b.click();
    expect(b.getAttribute("aria-disabled")).toBe("true");
    b.click();
    expect(onMark).toHaveBeenCalledTimes(1);
    finish({ checkMarks: { "plan-1": { mark: "works", at: "t" } } });
    await flush();
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(count(list.el)).toBe("1 of 2 done");
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });
  it("shows an error and clears the busy state when the call fails", async () => {
    const list = rc.createCheckList({ onMark: vi.fn(async () => { throw new Error("this change moved on; load it again"); }) });
    list.update(waiting());
    const b = btn(list.el, "check-works-plan-1");
    b.click();
    await flush();
    expect(list.el.all("p").find((p) => p.attrs.role === "alert")!.textContent).toBe("this change moved on; load it again");
    expect(b.getAttribute("aria-disabled")).toBeNull();
  });
  it("shows words, not buttons, without onMark", () => {
    const list = rc.createCheckList();
    list.update(waiting({ checkMarks: { "plan-1": { mark: "not-quite", at: "t" } } }));
    expect(list.el.all("button")).toHaveLength(0);
    expect(list.el.textContent).toContain("Not quite");
    expect(list.el.textContent).toContain("Not tried yet");
  });
  it("keeps the same button nodes across updates, and rebuilds when the checks change", () => {
    const list = rc.createCheckList({ onMark: vi.fn() });
    list.update(waiting());
    const before = btn(list.el, "check-works-plan-1");
    list.update(waiting({ checkMarks: { "plan-2": { mark: "works", at: "t" } } }));
    expect(btn(list.el, "check-works-plan-1")).toBe(before);
    list.update(waiting({ checks: [{ id: "plan-1", try: "New", expect: "New" }] }));
    expect(btn(list.el, "check-works-plan-1")).not.toBe(before);
    expect(list.el.all("li")).toHaveLength(1);
  });
});

describe("the run header", () => {
  const labels = (head: any) => head.el.all("div").find((d: FakeElement) => d.attrs.class === "run-actions").all("button").map((b: FakeElement) => b.textContent);
  const section = (head: any) => head.el.all("section").find((s: FakeElement) => s.attrs["aria-label"] === "Checks to try");
  it("puts the checks between Now and the buttons, and words Approve by the open checks", () => {
    const head = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn() });
    head.update(waiting());
    const kids = head.el.children.map((c: FakeElement) => c.attrs["aria-label"] ?? c.attrs.class);
    const at = (x: string) => kids.indexOf(x);
    expect(at("Now")).toBeLessThan(at("Checks to try"));
    expect(at("Checks to try")).toBeLessThan(at("run-actions"));
    expect(labels(head)).toContain("Approve — 2 checks not marked yet");
    head.update(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" }, "plan-2": { mark: "works", at: "t" } } }));
    expect(labels(head)[0]).toBe("Approve");
  });
  it("looks as before without checks, and shows no section for a running run", () => {
    const head = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn() });
    head.update(waiting({ checks: undefined }));
    expect(labels(head)).toEqual(["Approve", "Reject", "Stop this change…"]);
    expect(section(head).hidden).toBe(true);
    const running = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn() });
    running.update(waiting({ status: "running", next: nextStep("running") }));
    expect(section(running).hidden).toBe(true);
  });
  it("the admin Approve button says how many checks are open", () => {
    const labelsOf = (s: any) => runs.actions(s).map((b: FakeElement) => b.textContent);
    expect(labelsOf(waiting())).toContain("✔ Approve — 2 checks not marked yet");
    expect(labelsOf(waiting({ checks: undefined }))).toContain("✔ Approve");
  });
});
