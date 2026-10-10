import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/run-timeline.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const rec = (id: string, i: number, over: any = {}) => ({ id, type: "shell", visit: 1, ok: true, durationMs: 1000, startedAt: T(i), output: `out ${id}`, ...over });
const run = (over: any = {}) => ({ status: "succeeded", startedAt: T(0), finishedAt: T(100), history: [], flowDef: { steps: [{ id: "a", type: "shell", description: "Build the thing" }] }, ...over });
const keys = (s: any) => mod.milestones(s).map((m: any) => m.key);
const entries = (t: any) => (t.el.children[1] as FakeElement).children as FakeElement[];
const details = (t: any) => entries(t).filter((e) => e.tag === "details");

describe("milestones", () => {
  it("is empty for no run", () => expect(mod.milestones(null)).toEqual([]));

  it("an old run with no history has a start and an end", () => {
    expect(mod.milestones(run({ history: undefined })).map((m: any) => m.kind)).toEqual(["start", "end"]);
  });

  it("running: start, steps, then the current step with a plain label", () => {
    const m = mod.milestones(run({ status: "running", finishedAt: undefined, history: [rec("a", 1)], state: { next: "a" }, stepStartedAt: T(5) }));
    expect(m.map((x: any) => x.kind)).toEqual(["start", "step", "current"]);
    expect(m[2].label).toBe("Running Build the thing");
    expect(m[1]).toMatchObject({ key: "step:0", index: 0, ok: true, depth: 0, label: "Build the thing" });
  });

  it("waiting: ends with the message and has no current or end", () => {
    const m = mod.milestones(run({ status: "waiting", history: [rec("a", 1)], waiting: { since: T(9), message: "Ship it?" }, state: { next: "a" } }));
    expect(m.map((x: any) => x.kind)).toEqual(["start", "step", "waiting"]);
    expect(m[2]).toMatchObject({ label: "Waiting for approval", text: "Ship it?" });
  });

  it("failed and succeeded ends", () => {
    const f = mod.milestones(run({ status: "failed", history: [rec("a", 1, { ok: false })] }));
    expect(f[1].ok).toBe(false);
    expect(f[2]).toMatchObject({ kind: "end", label: "Run failed", ok: false });
    expect(mod.milestones(run()).at(-1)).toMatchObject({ label: "Run finished", ok: true });
  });

  it("stopped with answers: answers sit between steps by time", () => {
    const m = mod.milestones(run({ status: "stopped", history: [rec("a", 1), rec("b", 10)], answers: [{ at: T(5), text: "yes" }] }));
    expect(m.map((x: any) => x.key)).toEqual(["start", "step:0", "answer:0", "step:1", "end"]);
    expect(m[2]).toMatchObject({ label: "Answer given", text: "yes" });
    expect(m.at(-1).label).toBe("Run stopped");
  });

  it("nested steps are indented and the parent is above its children", () => {
    const hist = [rec("x", 2, { parent: "build" }), rec("y", 3, { parent: "a/b" }), rec("build", 1, { type: "flow" })];
    const m = mod.milestones(run({ history: hist }));
    expect(m.map((x: any) => x.key)).toEqual(["start", "step:2", "step:0", "step:1", "end"]);
    expect(m.map((x: any) => x.depth)).toEqual([0, 0, 1, 2, 0]);
  });

  it("equal start times: the parent still goes above its children, per occurrence", () => {
    const hist = [
      rec("x", 1, { parent: "p" }), rec("p", 1, { type: "flow" }),
      rec("x", 5, { parent: "p", visit: 2 }), rec("p", 5, { type: "flow", visit: 2 }),
    ];
    expect(keys(run({ history: hist }))).toEqual(["start", "step:1", "step:0", "step:3", "step:2", "end"]);
  });

  it("engine-shaped nested ids: ancestors come before descendants on equal times", () => {
    const hist = [
      rec("a/b/c", 1, { parent: "a/b" }), rec("a/b", 1, { type: "flow", parent: "a" }), rec("a", 1, { type: "flow" }),
      rec("a/b/c", 7, { parent: "a/b", visit: 2 }), rec("a/b", 7, { type: "flow", parent: "a", visit: 2 }), rec("a", 7, { type: "flow", visit: 2 }),
    ];
    const m = mod.milestones(run({ history: hist }));
    expect(m.map((x: any) => x.key)).toEqual(["start", "step:2", "step:1", "step:0", "step:5", "step:4", "step:3", "end"]);
    expect(m.slice(1, 4).map((x: any) => x.depth)).toEqual([0, 1, 2]);
  });

  it("repeated visits are separate entries", () => {
    expect(keys(run({ history: [rec("a", 1), rec("a", 2, { visit: 2 })] }))).toEqual(["start", "step:0", "step:1", "end"]);
  });

  it("entries without a time keep their place", () => {
    const hist = [rec("a", 1), { ...rec("b", 0), startedAt: undefined }, rec("c", 3)];
    expect(keys(run({ history: hist }))).toEqual(["start", "step:0", "step:1", "step:2", "end"]);
  });

  it("the label is the description, else '<id> — <kind>', never the id alone", () => {
    const m = mod.milestones(run({ history: [rec("a", 1), rec("z", 2), rec("q", 3, { type: "claude" })] }));
    expect(m[1].label).toBe("Build the thing");
    expect(m[2].label).toBe("z — Shell");
    expect(m[3].label).toBe("q — Agent");
  });
});

describe("createTimeline", () => {
  let a: any;
  beforeEach(() => {
    a = { transcript: vi.fn().mockResolvedValue({ events: [{ kind: "text", text: "hello" }, { kind: "tool", name: "Bash", input: { command: "ls" }, result: "x" }] }) };
    (FakeElement.prototype as any).scrollIntoView = vi.fn();
  });

  it("keeps the nodes already shown when a step arrives", () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    const one = run({ status: "running", finishedAt: undefined, history: [rec("a", 1)], state: { next: "b" } });
    t.update(one);
    const before = [...entries(t)];
    t.update({ ...one, history: [rec("a", 1), rec("b", 2)], state: { next: "c" } });
    const after = entries(t);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after).toHaveLength(4);
    expect(after[3]).not.toBe(before[2]); // the current row is replaced
  });

  it("an open entry stays open and its transcript is loaded once", async () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    const s = run({ status: "running", finishedAt: undefined, history: [rec("a", 1, { type: "claude" })], state: { next: "b" } });
    t.update(s);
    t.open(0);
    await flush();
    const node = details(t)[0]!;
    t.update({ ...s, history: [...s.history, rec("b", 2)] });
    await flush();
    expect(details(t)[0]).toBe(node);
    expect("open" in node.attrs).toBe(true);
    expect(a.transcript).toHaveBeenCalledTimes(1);
    expect(a.transcript).toHaveBeenCalledWith("r1", 0);
    expect(node.textContent).toContain("hello");
    const tool = node.all("details").find((d) => d.attrs.class === "tx-tool")!;
    expect("open" in tool.attrs).toBe(false);
  });

  it("a late parent and a new step keep focus, the open entry and its loaded transcript", async () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    const child = rec("kid", 2, { type: "claude", parent: "p" });
    const s = run({ status: "running", finishedAt: undefined, history: [rec("a", 1), child], state: { next: "z" } });
    t.update(s);
    t.open(1);
    await flush();
    const node = details(t)[1]!;
    const summary = node.all("summary")[0]!;
    summary.focus();
    t.update({ ...s, history: [...s.history, rec("p", 2, { type: "flow" }), rec("b", 5)] });
    await flush();
    expect(details(t)).toContain(node);
    expect("open" in node.attrs).toBe(true);
    expect((document as any).activeElement).toBe(summary);
    expect(a.transcript).toHaveBeenCalledTimes(1);
    expect(node.textContent).toContain("hello");
    // the parent now sits above its child
    expect(entries(t).indexOf(details(t).find((d) => d.textContent.includes("p — Flow"))!)).toBeLessThan(entries(t).indexOf(node));
  });

  it("open(index) shows a shell step's output without a transcript call and scrolls", async () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    t.update(run({ history: [rec("a", 1, { error: "bad" })] }));
    const node = details(t)[0]!;
    expect(node.textContent).not.toContain("out a");
    expect(node.textContent).not.toContain("bad");
    t.open(0);
    await flush();
    expect(node.textContent).toContain("out a");
    expect(node.textContent).toContain("Details");
    expect(a.transcript).not.toHaveBeenCalled();
    expect((FakeElement.prototype as any).scrollIntoView).toHaveBeenCalled();
  });

  it("open(index) before the entry exists is applied by the update that brings it", async () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    t.update(run({ status: "running", finishedAt: undefined, history: [] }));
    t.open(1);
    t.update(run({ status: "running", finishedAt: undefined, history: [rec("a", 1), rec("b", 2)] }));
    await flush();
    expect("open" in details(t)[1]!.attrs).toBe(true);
    expect("open" in details(t)[0]!.attrs).toBe(false);
  });

  it("the user shape never offers details or a transcript", async () => {
    const t = mod.createTimeline({ runId: "r1", admin: false, a });
    const hist = [{ id: "a", type: "agent", visit: 1, ok: false, durationMs: 5, error: "one sentence", startedAt: T(1) }];
    t.update(run({ status: "failed", history: hist }));
    t.open(0);
    t.update(run({ status: "failed", history: [...hist, { ...hist[0], id: "b", startedAt: T(2) }] }));
    await flush();
    expect(t.el.all("details")).toHaveLength(0);
    expect(t.el.all("summary")).toHaveLength(0);
    expect(t.el.textContent).toContain("one sentence");
    expect(a.transcript).not.toHaveBeenCalled();
  });

  it("admin: false with records that have output still draws plain rows", () => {
    const t = mod.createTimeline({ runId: "r1", admin: false, a });
    t.update(run({ status: "failed", history: [rec("a", 1, { type: "claude", agent: "claude", costUsd: 1 })] }));
    t.open(0);
    expect(t.el.all("details")).toHaveLength(0);
    expect(t.el.textContent).not.toContain("claude");
    expect(t.el.textContent).not.toContain("$");
    expect(a.transcript).not.toHaveBeenCalled();
  });

  it("a failed run opens the failing step once", async () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    const s = run({ status: "failed", history: [rec("a", 1), rec("b", 2, { ok: false, error: "boom" })] });
    t.update(s);
    await flush();
    const [first, second] = details(t);
    expect("open" in first!.attrs).toBe(false);
    expect("open" in second!.attrs).toBe(true);
    expect(second!.textContent).toContain("boom");
    second!.removeAttribute("open");
    t.update({ ...s, finishedAt: T(101) });
    expect("open" in second!.attrs).toBe(false);
  });

  it("a transcript that fails to load leaves the entry in place with a retry", async () => {
    a.transcript.mockRejectedValue(new Error("nope"));
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    t.update(run({ history: [rec("a", 1, { type: "claude" })] }));
    t.open(0);
    await flush();
    const node = details(t)[0]!;
    expect(node.textContent).toContain("Could not load the transcript.");
    expect(node.all("button").length).toBeGreaterThan(0);
    expect(entries(t)).toContain(node);
  });

  it("says what is missing when there are no steps", () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    const note = t.el.children[0] as FakeElement;
    t.update(run({ status: "running", finishedAt: undefined }));
    expect(note.textContent).toBe("No steps finished yet.");
    expect(note.hidden).toBe(false);
    t.update(run({ status: "succeeded" }));
    expect(note.textContent).toBe("No steps recorded.");
    t.update(run({ history: [rec("a", 1)] }));
    expect(note.hidden).toBe(true);
  });

  it("removes a milestone that is gone", () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    t.update(run({ status: "waiting", finishedAt: undefined, waiting: { since: T(1), message: "ok?" } }));
    expect(t.el.textContent).toContain("Waiting for approval");
    t.update(run({ status: "running", finishedAt: undefined, state: { next: "a" } }));
    expect(t.el.textContent).not.toContain("Waiting for approval");
    expect(t.el.textContent).toContain("Running Build the thing");
  });

  it("500 steps: no transcript call and no step body until one is opened", () => {
    const t = mod.createTimeline({ runId: "r1", admin: true, a });
    const big = "x".repeat(50_000);
    const history = Array.from({ length: 500 }, (_, i) => rec(`s${i}`, i, { type: i % 2 ? "claude" : "shell", ok: i % 5 !== 0, error: i % 5 === 0 ? big : undefined }));
    t.update(run({ history }));
    const all = details(t);
    expect(all).toHaveLength(500);
    expect(a.transcript).not.toHaveBeenCalled();
    for (const d of all) {
      expect(d.children).toHaveLength(2); // summary and an empty body
      expect((d.children[1] as FakeElement).children).toHaveLength(0);
    }
    expect(t.el.textContent).not.toContain("xxxxx");
  });
});
