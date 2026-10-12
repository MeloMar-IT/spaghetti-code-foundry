import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let b: any;
let rf: any;
beforeAll(async () => {
  restore = installFakeDom();
  b = await import("../ui/runs-bar.js" as string);
  rf = await import("../ui/runs-filter.js" as string);
});
afterAll(() => restore());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const focus = (bar: any, name: string): FakeElement => {
  const all: FakeElement[] = [];
  const walk = (e: FakeElement) => { for (const c of e.children) if (c instanceof FakeElement) { all.push(c); walk(c); } };
  walk(bar.el);
  return all.find((e) => e.attrs["data-focus"] === name)!;
};
const make = (over: any = {}) => {
  const onChange = vi.fn();
  const bar = b.runsBar({ admin: true, onChange, ...over });
  bar.sync(rf.emptyFilter());
  return { bar, onChange };
};
const type = (bar: any, text: string) => { bar.search.value = text; bar.search.fire("input", { target: bar.search }); };

describe("the controls", () => {
  it("each has a stable data-focus name and an accessible name", () => {
    const { bar } = make();
    const names = { "runs-search": "Search runs", "runs-repo": "Repository", "runs-flow": "Flow", "runs-status": "Status", "runs-time": "Time", "owner-filter": "Owner" };
    for (const [name, label] of Object.entries(names)) expect(focus(bar, name).attrs["aria-label"], name).toBe(label);
    expect(focus(bar, "runs-needs").parent!.textContent).toBe("Only what needs me");
    const shows = ["all", "needs", "running", "queued", "failed", "completed"].map((id) => focus(bar, `runs-view-${id}`).textContent);
    expect(shows).toEqual(["All", "Needs you", "Running", "Queued", "Failed", "Completed"]);
    expect(focus(bar, "runs-clear").textContent).toBe("Clear filters");
    expect(bar.search.attrs.maxlength).toBe("200");
    expect(bar.search.attrs.placeholder).toBe("Run id, #7 or text");
  });
  it("has no Owner select for a user", () => {
    const { bar } = make({ admin: false });
    expect(focus(bar, "owner-filter")).toBeUndefined();
  });
});

describe("typing", () => {
  it("asks once, 300 ms after the last key, with the trimmed text", () => {
    const { bar, onChange } = make();
    type(bar, "a");
    vi.advanceTimersByTime(200);
    type(bar, "ab");
    vi.advanceTimersByTime(200);
    type(bar, " abc ");
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...rf.emptyFilter(), q: "abc" });
  });
  it("calls nothing for text equal to the committed one", () => {
    const { bar, onChange } = make();
    type(bar, "  ");
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("hands the pending text over with a change of another control, once", () => {
    const { bar, onChange } = make();
    type(bar, "x");
    focus(bar, "runs-status").fire("change", { target: { value: "failed" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...rf.emptyFilter(), q: "x", status: "failed" });
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("sync leaves a pending draft alone and writes the box after the commit", () => {
    const { bar } = make();
    type(bar, "draft");
    bar.sync({ ...rf.emptyFilter(), q: "other" });
    expect(bar.search.value).toBe("draft");
    vi.advanceTimersByTime(300);
    bar.sync({ ...rf.emptyFilter(), q: "other" });
    expect(bar.search.value).toBe("other");
  });
  it("stop() during the 300 ms means no call ever", () => {
    const { bar, onChange } = make();
    type(bar, "x");
    bar.stop();
    vi.advanceTimersByTime(1000);
    focus(bar, "runs-status").fire("change", { target: { value: "failed" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("sync and setValues", () => {
  it("draws options, keeps the select node, adds an unknown current value and hides Owner without a list", () => {
    const { bar } = make();
    const repo = focus(bar, "runs-repo");
    bar.setValues({ repos: ["a/b", "c/d"], flows: ["f"], owners: [{ id: "u1", name: "Ann", runs: 2 }, { id: "u2", name: "deleted account", runs: 1 }] });
    expect(repo.all("option").map((o) => o.textContent)).toEqual(["All repositories", "a/b", "c/d"]);
    expect(focus(bar, "owner-filter").all("option").map((o) => o.textContent)).toEqual(["All owners", "Ann (2)", "deleted user (1)"]);
    expect(focus(bar, "owner-filter").hidden).toBe(false);
    bar.sync({ ...rf.emptyFilter(), repo: "x/y" });
    expect(focus(bar, "runs-repo")).toBe(repo);
    expect(repo.all("option").map((o) => o.textContent)).toContain("x/y");
    expect(repo.value).toBe("x/y");
    bar.setValues({ repos: ["a/b"], flows: [], owners: null });
    expect(focus(bar, "owner-filter").hidden).toBe(true);
  });
  it("marks the Show button, the checkbox and Clear filters", () => {
    const { bar, onChange } = make();
    expect(focus(bar, "runs-clear").hidden).toBe(true);
    bar.sync({ ...rf.emptyFilter(), view: "failed", needs: true });
    expect(focus(bar, "runs-view-failed").attrs["aria-pressed"]).toBe("true");
    expect(focus(bar, "runs-view-all").attrs["aria-pressed"]).toBe("false");
    expect(focus(bar, "runs-needs").checked).toBe(true);
    expect(focus(bar, "runs-clear").hidden).toBe(false);
    focus(bar, "runs-view-all").fire("click");
    expect(onChange).toHaveBeenLastCalledWith({ ...rf.emptyFilter(), needs: true, view: "" });
    focus(bar, "runs-clear").fire("click");
    expect(onChange).toHaveBeenLastCalledWith(rf.emptyFilter());
  });
  it("say sets the polite status region", () => {
    const { bar } = make();
    bar.say("2 runs match.");
    const region = bar.el.children.find((c: any) => c instanceof FakeElement && c.attrs.role === "status");
    expect(region.textContent).toBe("2 runs match.");
    expect(region.attrs["aria-live"]).toBe("polite");
  });
});

describe("noMatch", () => {
  it("says so, shows a note and clears", () => {
    const onClear = vi.fn();
    const el = b.noMatch({ onClear, note: "a note" });
    expect(el.textContent).toContain("No runs match your search and filters.");
    expect(el.textContent).toContain("a note");
    el.all("button").find((x: FakeElement) => x.attrs["data-focus"] === "runs-empty-clear")!.fire("click");
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
