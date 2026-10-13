import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The compact density of the runs lists: the storage helpers and the table rows. Fake DOM, no server.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rl: any;
beforeAll(async () => {
  restore = installFakeDom();
  rl = await import("../ui/runs-list.js" as string);
});
afterAll(() => restore());

const doc = () => (globalThis as any).document;
const rec = (who: string, kind = "running") => ({ who, kind, status: `${kind} status`, text: `${kind} text`, help: "help" });
const run = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, flow: `flow-${id}`, status: "running", startedAt: "2026-10-01T10:00:00Z", history: [], totalCostUsd: 0, task: `task ${id}\nsecond`, vars: { github_repo: "o/r", issue: "7" }, next: rec("Foundry"), ...over });
const job = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, kind: "run", enqueuedAt: "2026-10-01T11:00:00Z", task: "queued", ahead: 0, next: rec("Foundry", "queued"), ...over });
const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of el.children) if (c instanceof FakeElement) { out.push(c); walk(c, out); }
  return out;
};
const named = (root: FakeElement, name: string) => walk(root).find((el) => el.attrs["data-focus"] === name)!;
const box = () => document.createElement("div") as unknown as FakeElement;

beforeEach(() => { doc().activeElement = null; });
afterEach(() => { doc().activeElement = null; });

describe("density storage", () => {
  const store = (value: unknown) => ({ getItem: vi.fn(() => value), setItem: vi.fn() });
  it("reads compact only when exactly that is stored", () => {
    expect(rl.DENSITY_KEY).toBe("scf-runs-density");
    expect(rl.readDensity(store("compact"))).toBe("compact");
    for (const v of [null, "", "COMPACT", "dense", "comfortable", 5]) expect(rl.readDensity(store(v)), String(v)).toBe("comfortable");
    expect(rl.readDensity({ getItem: () => { throw new Error("denied"); } })).toBe("comfortable");
    expect(rl.readDensity(undefined)).toBe("comfortable");
  });

  it("writes compact or comfortable and never throws", () => {
    const s = store(null);
    rl.writeDensity("compact", s);
    expect(s.setItem).toHaveBeenCalledWith("scf-runs-density", "compact");
    rl.writeDensity("wide", s);
    expect(s.setItem).toHaveBeenLastCalledWith("scf-runs-density", "comfortable");
    expect(() => rl.writeDensity("compact", { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });
});

describe("the compact table", () => {
  const sample = () => rl.runSections(
    [run("r1", { next: rec("You", "approval") }), run("r2"), run("r3", { status: "failed" }), run("r4", { status: "succeeded" })],
    [job("q1", { priority: true, ahead: 2 }), job("q2")]);
  const draw = (b: FakeElement, secs: any, opts: any = {}) => rl.renderSections(b, secs, { density: "compact", ...opts });
  const heads = (t: FakeElement) => t.all("th").map((th) => th.textContent);
  const table = (b: FakeElement, title: string) => b.all("table").find((t) => t.attrs["aria-label"] === title)!;
  const leaves = (el: FakeElement) => walk(el).filter((e) => e.children.every((c) => !(c instanceof FakeElement)) && e.textContent).map((e) => e.textContent);
  const nodes = (b: FakeElement) => [...b.all("table"), ...b.all("tbody"), ...b.all("tr")];
  const selection = () => ({ has: () => false, toggle: vi.fn() });

  it("draws one labelled table per section with one row per run, and no cards", () => {
    const b = box();
    draw(b, sample());
    expect(b.all("table").map((t) => t.attrs["aria-label"])).toEqual(["Needs you", "Running", "Queued", "Failed", "Completed"]);
    for (const t of b.all("table")) expect(t.attrs.class).toBe("table compact run-table");
    expect(b.all("div").filter((d) => d.attrs.class === "table-box")).toHaveLength(5);
    expect(b.all("ul")).toHaveLength(0);
    expect(b.all("li")).toHaveLength(0);
    expect(table(b, "Queued").all("tr")).toHaveLength(3); // the head and two rows
    expect(table(b, "Running").all("tr")).toHaveLength(2);
  });

  it("has the columns for the user, the admin, select and Remove", () => {
    const b = box();
    draw(b, sample());
    expect(heads(table(b, "Running"))).toEqual(["Status", "Run", "Next", "Task", "Repository", "Updated"]);
    for (const th of b.all("th")) expect(th.attrs.scope).toBe("col");
    const c = box();
    draw(c, sample(), { admin: true, select: selection(), onRemove: vi.fn() });
    expect(heads(table(c, "Running"))).toEqual(["Status", "Run", "Next", "Task", "Repository", "Updated", "Owner", "Steps", "Cost"]);
    expect(heads(table(c, "Failed"))[0]).toBe("Select");
    expect(heads(table(c, "Queued")).slice(-1)).toEqual(["Actions"]);
    expect(heads(table(c, "Completed"))).not.toContain("Actions");
    for (const tr of c.all("tr").slice(1)) expect(tr.all("td").length).toBe(tr.all("td").length);
    for (const t of c.all("table")) for (const tr of t.all("tr").slice(1)) expect(tr.all("td")).toHaveLength(heads(t).length);
  });

  it("shows the same texts, links and names as the card", () => {
    const entries = [
      { run: null, job: job("q1", { priority: true, ahead: 2, refinement: { phase: "talk" } }), place: { n: 1, of: 3 } },
      { run: run("r1", { next: rec("You", "approval"), status: "failed" }), job: null },
    ];
    const opts = { admin: true, select: selection(), onRemove: vi.fn() };
    for (const e of entries) {
      const card = rl.listRow(e, opts);
      const b = box();
      draw(b, [{ id: e.job ? "queued" : "failed", title: e.job ? "Queued" : "Failed", entries: [e] }], opts);
      const tr = b.all("tr")[1]!;
      const names = (el: FakeElement) => walk(el).map((x) => x.attrs["data-focus"]).filter(Boolean).sort();
      expect(names(tr)).toEqual(names(card));
      for (const t of leaves(card)) expect(tr.textContent, t).toContain(t);
      expect(tr.all("a")[0]!.attrs.href).toBe(card.all("a")[0]!.attrs.href);
      expect(tr.all("input").map((i) => i.attrs["aria-label"])).toEqual(card.all("input").map((i: FakeElement) => i.attrs["aria-label"]));
    }
    const queued = box();
    draw(queued, [{ id: "queued", title: "Queued", entries: [entries[0]!] }], opts);
    for (const t of ["goes first", "1 of 3", "2 runs ahead", "Remove"]) expect(queued.textContent).toContain(t);
    const b = box();
    draw(b, sample());
    expect(table(b, "Needs you").all("tr")[1]!.attrs.class).toContain("who-you");
  });

  it("does not throw for a run with no record", () => {
    const b = box();
    expect(() => draw(b, [{ id: "running", title: "Running", entries: [{ run: run("r1", { next: undefined }), job: null }] }])).not.toThrow();
  });

  it("keeps closed sections, Show all, the selection and the focus when switching and back", () => {
    const many = Array.from({ length: 12 }, (_, i) => run(`c${String(i).padStart(2, "0")}`, { status: "succeeded", startedAt: `2026-09-${String(10 + i)}T10:00:00Z` }));
    const secs = rl.runSections([...many, run("f1", { status: "failed" })], []);
    const picked = new Set(["f1"]);
    const select = { has: (id: string) => picked.has(id), toggle: (id: string, on: boolean) => (on ? picked.add(id) : picked.delete(id)) };
    const b = box();
    rl.renderSections(b, secs, { select });
    named(b, "more-completed").click();
    named(b, "sec-failed").click();
    for (const density of ["compact", "comfortable", "compact"]) {
      rl.renderSections(b, secs, { select, density });
      const rows = density === "compact" ? table(b, "Completed").all("tr").length - 1 : b.all("li").filter((l) => l.textContent.includes("flow-c")).length;
      expect(rows).toBe(12);
      expect(walk(b).some((x) => x.attrs["data-focus"] === "more-completed")).toBe(false);
      expect(named(b, "sec-failed").attrs["aria-expanded"]).toBe("false");
      expect(named(b, "select-f1").checked).toBe(true);
    }
    const open = named(b, "open-c00");
    open.focus();
    rl.renderSections(b, secs, { select, density: "comfortable" });
    expect(doc().activeElement.attrs["data-focus"]).toBe("open-c00");
    expect(doc().activeElement).not.toBe(open);
    const outside = doc().createElement("button");
    outside.focus();
    rl.renderSections(b, secs, { select, density: "compact" });
    expect(doc().activeElement).toBe(outside);
  });

  it("changes no node on an update with the same data, and one row when a run changes", () => {
    const b = box();
    draw(b, sample());
    const before = nodes(b);
    draw(b, sample());
    const after = nodes(b);
    expect(after).toHaveLength(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    const row = (id: string) => b.all("tr").find((r) => r.textContent.includes(`flow-${id}`))!;
    const r1 = row("r1");
    const r2 = row("r2");
    draw(b, rl.runSections([run("r1", { next: rec("You", "approval") }), run("r2", { task: "other" }), run("r3", { status: "failed" }), run("r4", { status: "succeeded" })], [job("q1", { priority: true, ahead: 2 }), job("q2")]));
    expect(row("r2")).not.toBe(r2);
    expect(row("r1")).toBe(r1);
  });

  it("rebuilds a table only when its columns change", () => {
    const b = box();
    draw(b, sample());
    const running = table(b, "Running");
    const failed = table(b, "Failed");
    draw(b, sample(), { select: selection() });
    expect(table(b, "Running")).toBe(running);
    expect(table(b, "Failed")).not.toBe(failed);
    expect(heads(table(b, "Failed"))[0]).toBe("Select");
    draw(b, sample(), { onRemove: vi.fn() });
    expect(heads(table(b, "Queued")).slice(-1)).toEqual(["Actions"]);
    draw(b, rl.runSections([run("r2"), run("r5", { status: "stopped" })], []), { onRemove: vi.fn() });
    expect(b.all("th").map((t) => t.textContent)).not.toContain("Actions");
  });

  it("selects with the boxes and removes with the button in a row", () => {
    const picked = new Set<string>();
    const toggle = vi.fn((id: string, on: boolean) => (on ? picked.add(id) : picked.delete(id)));
    const onRemove = vi.fn();
    const secs = rl.runSections([run("f1", { status: "failed" }), run("f2", { status: "failed" })], [job("q1")]);
    const b = box();
    draw(b, secs, { select: { has: (id: string) => picked.has(id), toggle }, onRemove });
    named(b, "select-all-failed").fire("change", {});
    expect(toggle).toHaveBeenCalledWith("f1", true);
    expect(named(b, "select-f2").checked).toBe(true);
    named(b, "remove-q1").click();
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ runId: "q1" }));
  });

  it("draws cards for an unknown density", () => {
    const b = box();
    draw(b, sample(), { density: "wide" });
    expect(b.all("table")).toHaveLength(0);
    expect(b.all("li").length).toBeGreaterThan(0);
  });
});
