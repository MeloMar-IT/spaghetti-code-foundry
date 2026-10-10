import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
let out: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/run-tabs.js" as string);
  out = await import("../ui/run-output.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const el = (tag = "div") => document.createElement(tag) as unknown as FakeElement;
const tabsOf = (t: any) => t.el.all("button") as FakeElement[];
const panelsOf = (t: any) => (t.el.all("div") as FakeElement[]).filter((d) => d.attrs.role === "tabpanel");

function make(initial = "a") {
  const calls = { build: { a: 0, b: 0, c: 0 }, update: { a: [] as unknown[][], b: [] as unknown[][], c: [] as unknown[][] }, show: { a: 0, b: 0, c: 0 } };
  const def = (id: "a" | "b" | "c") => ({
    id, label: id.toUpperCase(),
    build: () => { calls.build[id]++; return el(); },
    update: (s: unknown, prev: unknown) => { calls.update[id].push([s, prev]); },
    onShow: () => { calls.show[id]++; },
  });
  const tabs = mod.createTabs([def("a"), def("b"), def("c")], { initial });
  return { tabs, calls };
}

describe("createTabs", () => {
  it("builds the initial tab once and the others when first shown", () => {
    const { tabs, calls } = make();
    expect(calls.build).toEqual({ a: 1, b: 0, c: 0 });
    tabs.show("b");
    tabs.show("b");
    tabs.show("a");
    expect(calls.build).toEqual({ a: 1, b: 1, c: 0 });
    expect(calls.show.b).toBe(2);
  });

  it("updates built panels only, and gives a late panel the last summary once", () => {
    const { tabs, calls } = make();
    tabs.update({ n: 1 }, undefined);
    tabs.update({ n: 2 }, { n: 1 });
    expect(calls.update.b).toHaveLength(0);
    tabs.show("b");
    expect(calls.update.b).toEqual([[{ n: 2 }, undefined]]);
    expect(calls.update.a).toHaveLength(2);
  });

  it("keeps the selected tab across updates", () => {
    const { tabs } = make();
    tabs.show("c", { byUser: true });
    for (let i = 0; i < 3; i++) tabs.update({ i }, { i: i - 1 });
    expect(tabs.current()).toBe("c");
    expect(tabsOf(tabs).map((b) => b.attrs["aria-selected"])).toEqual(["false", "false", "true"]);
    expect(panelsOf(tabs).map((p) => p.hidden)).toEqual([true, true, false]);
  });

  it("has the roles, the pairs, the roving tabindex and the data-tab ids in order", () => {
    const { tabs } = make();
    const list = (tabs.el.all("div") as FakeElement[]).find((d) => d.attrs.role === "tablist")!;
    expect(list).toBeTruthy();
    const buttons = tabsOf(tabs);
    expect(buttons.map((b) => b.attrs.role)).toEqual(["tab", "tab", "tab"]);
    expect(buttons.map((b) => b.attrs["data-tab"])).toEqual(["a", "b", "c"]);
    expect(buttons.map((b) => b.attrs.tabindex)).toEqual(["0", "-1", "-1"]);
    panelsOf(tabs).forEach((p, i) => {
      expect(p.attrs["aria-labelledby"]).toBe(buttons[i]!.attrs.id);
      expect(buttons[i]!.attrs["aria-controls"]).toBe(p.attrs.id);
    });
  });

  it("moves with the arrow keys, wraps, jumps with Home and End, and ignores other keys", () => {
    const { tabs } = make();
    const key = (i: number, k: string) => tabsOf(tabs)[i]!.fire("keydown", { key: k, preventDefault() {} });
    key(0, "ArrowLeft");
    expect(tabs.current()).toBe("c");
    expect(document.activeElement).toBe(tabsOf(tabs)[2]);
    key(2, "ArrowRight");
    expect(tabs.current()).toBe("a");
    key(0, "ArrowRight");
    expect(tabs.current()).toBe("b");
    key(1, "End");
    expect(tabs.current()).toBe("c");
    key(2, "Home");
    expect(tabs.current()).toBe("a");
    key(0, "x");
    expect(tabs.current()).toBe("a");
  });

  it("picked() is true after a click or a key and false after a programmatic show", () => {
    const one = make();
    one.tabs.show("b");
    expect(one.tabs.picked()).toBe(false);
    tabsOf(one.tabs)[2]!.click();
    expect(one.tabs.picked()).toBe(true);
    const two = make();
    tabsOf(two.tabs)[0]!.fire("keydown", { key: "ArrowRight", preventDefault() {} });
    expect(two.tabs.picked()).toBe(true);
  });

  it("does not throw for an unknown id and moves the focus out of a hidden panel", () => {
    const { tabs } = make();
    expect(() => tabs.show("nope")).not.toThrow();
    expect(tabs.current()).toBe("a");
    const inside = el("textarea");
    panelsOf(tabs)[0]!.append(inside);
    inside.focus();
    tabs.show("b");
    expect(document.activeElement).toBe(tabsOf(tabs)[1]);
  });
});

describe("focus and caret of a panel", () => {
  it("come back when the panel is shown again, also after a click took the focus away", () => {
    const { tabs } = make();
    const box = el("textarea") as any;
    box.selectionStart = 2;
    box.selectionEnd = 4;
    const set = vi.fn();
    box.setSelectionRange = set;
    panelsOf(tabs)[0]!.append(box);
    box.focus();
    panelsOf(tabs)[0]!.fire("focusin", { target: box });
    tabsOf(tabs)[1]!.focus();
    tabsOf(tabs)[1]!.click();
    expect(tabs.current()).toBe("b");
    tabsOf(tabs)[0]!.click();
    expect(document.activeElement).toBe(box);
    expect(set).toHaveBeenCalledWith(2, 4);
  });
  it("stay on the tab button for a key move", () => {
    const { tabs } = make();
    const box = el("textarea");
    panelsOf(tabs)[1]!.append(box);
    tabs.show("b");
    box.focus();
    tabs.show("a");
    tabsOf(tabs)[0]!.fire("keydown", { key: "ArrowRight", preventDefault() {} });
    expect(document.activeElement).toBe(tabsOf(tabs)[1]);
  });
});

describe("showFailedOnce", () => {
  const failing = { status: "failed", next: { failure: { tried: "t" } } };
  const running = { status: "running" };
  const tabsFor = () => make("a").tabs;
  const withSteps = () => mod.createTabs([{ id: "overview", label: "O", build: () => el() }, { id: "steps", label: "S", build: () => el() }], { initial: "overview" });

  it("opens Steps when a run fails, once", () => {
    const t = withSteps();
    mod.showFailedOnce(t, failing, running);
    expect(t.current()).toBe("steps");
    t.show("overview");
    mod.showFailedOnce(t, failing, failing);
    expect(t.current()).toBe("overview");
  });
  it("does not open Steps after the reader picked a tab", () => {
    const t = withSteps();
    tabsOf(t)[0]!.click();
    mod.showFailedOnce(t, failing, running);
    expect(t.current()).toBe("overview");
    expect(tabsFor().current()).toBe("a");
  });
  it("does nothing for a failed run without a failure record", () => {
    const t = withSteps();
    mod.showFailedOnce(t, { status: "failed" }, running);
    expect(t.current()).toBe("overview");
  });
});

const USER_RUN = {
  status: "stopped", questions: "Which db?",
  answers: [{ at: "2026-01-01T10:00:00Z", text: "pg" }, { at: "2026-01-01T11:00:00Z", text: "yes" }],
  history: [{ id: "ask", type: "agent", visit: 1, ok: true, durationMs: 5 }],
};

describe("evidenceItems", () => {
  it("lists the questions and the answers of a stopped run", () => {
    const items = mod.evidenceItems(USER_RUN);
    expect(items.map((i: any) => i.kind)).toEqual(["question", "answer", "answer"]);
    expect(items[1]).toMatchObject({ text: "pg", at: "2026-01-01T10:00:00Z" });
  });
  it("orders a failed run: checks, link, tried; cuts an error to its first line; skips agent steps", () => {
    const s = {
      status: "failed",
      history: [
        { id: "ag", type: "claude", ok: true, durationMs: 1, output: "x" },
        { id: "t", type: "shell", ok: false, durationMs: 1200, error: "exit 1\nmore lines" },
        { id: "ok", type: "approval", ok: true, durationMs: 40 },
      ],
      next: { where: { url: "https://github.com/o/r/issues/7", label: "o/r#7" }, failure: { tried: "It ran twice." } },
    };
    const items = mod.evidenceItems(s);
    expect(items.map((i: any) => i.kind)).toEqual(["check", "check", "link", "tried"]);
    expect(items[0]).toMatchObject({ id: "t", ok: false, error: "exit 1" });
    expect(items[1]).toMatchObject({ id: "ok", ok: true });
    expect(items[2]).toMatchObject({ href: "https://github.com/o/r/issues/7", label: "o/r#7" });
    expect(items[3].text).toBe("It ran twice.");
  });
  it("keeps an administrator's questions after the answered run went on", () => {
    const s = { status: "failed", answers: [{ at: "t", text: "pg" }], history: [{ id: "ask_for_info", type: "claude", ok: true, durationMs: 1, output: "Which db?" }, { id: "build", type: "shell", ok: false, durationMs: 1 }] };
    expect(mod.evidenceItems(mod.withQuestions(s))[0]).toMatchObject({ kind: "question", text: "Which db?" });
    expect(mod.withQuestions({ ...s, answers: undefined }).questions).toBeUndefined();
  });
  it("is empty for an empty run", () => {
    expect(mod.evidenceItems({})).toEqual([]);
  });
  it("reads no output, cost, tokens or agent", () => {
    const items = mod.evidenceItems({ ...USER_RUN, history: [{ id: "s", type: "shell", ok: true, durationMs: 3, output: "o", costUsd: 1, tokens: {}, agent: "a" }] });
    for (const i of items) for (const k of ["output", "costUsd", "tokens", "agent"]) expect(i).not.toHaveProperty(k);
  });
  it("gives no link for a same-page address", () => {
    expect(mod.evidenceItems({ next: { where: { url: "#/runs/r1", label: "run" } } })).toEqual([]);
  });
});

describe("evidencePanel", () => {
  it("says so when there is nothing", () => {
    const p = mod.evidencePanel();
    const node = p.build();
    p.update({});
    expect(node.textContent).toBe("No evidence recorded yet.");
  });
  it("keeps the same nodes for the same summary", () => {
    const p = mod.evidencePanel();
    const node = p.build();
    p.update(USER_RUN);
    const before = [...node.all("li")];
    expect(before).toHaveLength(3);
    p.update({ ...USER_RUN });
    expect(node.all("li").every((n: FakeElement, i: number) => n === before[i])).toBe(true);
  });
  it("shows the questions of an administrator's stopped run, read from the step that asked", () => {
    const p = mod.evidencePanel();
    const node = p.build();
    p.update({ status: "stopped", reason: 'stopped at step "ask_for_info"', history: [{ id: "ask_for_info", type: "claude", ok: true, durationMs: 1, output: "What size?" }] });
    expect(node.textContent).toContain("What size?");
  });
});

describe("stepCountText", () => {
  const steps = (n: number) => ({ flowDef: { steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })) } });
  it("counts done and failed", () => {
    const history = [{ id: "s0", ok: true }, { id: "s1", ok: true }, { id: "s2", ok: true }, { id: "s3", ok: false }];
    expect(mod.stepCountText({ ...steps(5), history })).toBe("3 of 5 steps done, 1 failed");
    expect(mod.stepCountText({ ...steps(1), history: [{ id: "s0", ok: true }] })).toBe("1 of 1 step done");
  });
  it("counts a retried step by its last visit and ignores records with a parent", () => {
    const history = [{ id: "s0", ok: false }, { id: "s0", ok: true }, { id: "x", ok: false, parent: "s1" }];
    expect(mod.stepCountText({ ...steps(2), history })).toBe("1 of 2 steps done");
  });
  it("is empty without a flow and without history", () => {
    expect(mod.stepCountText({})).toBe("");
  });
});

describe("overviewPanel", () => {
  const RUN = { runId: "r1", flow: "build", task: "Do it\nin full", status: "stopped", questions: "Q?", workdir: "/w", flowDef: { steps: [{ id: "a" }], publish: { enabled: true, version: 3 } }, history: [] };
  it("shows the task, questions, run, flow and version; the workspace only for an administrator", () => {
    const user = mod.overviewPanel({ admin: false });
    const node = user.build();
    user.update(RUN);
    for (const t of ["Do it\nin full", "Q?", "r1", "build", "Flow version", "3", "0 of 1 step done"]) expect(node.textContent).toContain(t);
    expect(node.textContent).not.toContain("Workspace");
    const admin = mod.overviewPanel({ admin: true });
    const a = admin.build();
    admin.update(RUN);
    expect(a.textContent).toContain("Workspace");
    expect(a.textContent).toContain("/w");
  });
  it("keeps `extra`, its value and the focus over updates; keeps the details nodes for the same summary", () => {
    const extra = el();
    const box = el("textarea");
    extra.append(box);
    const p = mod.overviewPanel({ extra });
    const node = p.build();
    p.update(RUN);
    box.value = "typing";
    box.focus();
    const dl = node.all("dl")[0]!;
    const rows = [...dl.children];
    for (let i = 0; i < 3; i++) p.update({ ...RUN }, RUN);
    expect(node.children).toContain(extra);
    expect(box.value).toBe("typing");
    expect(document.activeElement).toBe(box);
    expect(dl.children.every((c, i) => c === rows[i])).toBe(true);
  });
  it("does not throw for an empty summary", () => {
    const p = mod.overviewPanel();
    p.build();
    expect(() => p.update({})).not.toThrow();
  });
  it("shows the questions of an administrator's stopped run", () => {
    const p = mod.overviewPanel({ admin: true });
    const node = p.build();
    p.update({ status: "stopped", reason: 'stopped at step "send_back"', history: [{ id: "send_back", type: "claude", ok: true, output: "Which one?" }] });
    expect(node.textContent).toContain("Which one?");
  });
});

describe("changesPanel", () => {
  const view = (d: any, o?: any) => { const n = el(); n.append(d.patch ? "diff" : (o?.none ?? "none")); return n; };
  it("loads once, not on updates, again on Refresh, and when the run finishes", async () => {
    const load = vi.fn(async () => ({ patch: "x" }));
    const p = mod.changesPanel({ load, view });
    const node = p.build();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    const running = { status: "running" };
    for (let i = 0; i < 3; i++) p.update(running, running);
    p.update({ status: "waiting", finishedAt: "t1" }, running);
    expect(load).toHaveBeenCalledTimes(2);
    p.update({ status: "running" }, { status: "waiting", finishedAt: "t1" });
    p.update({ status: "succeeded", finishedAt: "t2" }, { status: "running" });
    expect(load).toHaveBeenCalledTimes(3);
    await flush();
    node.all("button")[0]!.click();
    await flush();
    expect(load).toHaveBeenCalledTimes(4);
  });
  it("keeps the opened file node over updates", async () => {
    const file = el("details");
    const p = mod.changesPanel({ load: async () => ({ patch: "x" }), view: () => { const n = el(); n.append(file); return n; } });
    const node = p.build();
    await flush();
    p.update({ status: "running" }, { status: "running" });
    expect(node.all("details")[0]).toBe(file);
  });
  it("shows the node of onError for a rejected load", async () => {
    const p = mod.changesPanel({ load: async () => { throw new Error("no access"); }, view, onError: (e: Error) => { const n = el("p"); n.append(e.message); return n; } });
    const node = p.build();
    await flush();
    expect(node.textContent).toContain("no access");
  });
});

describe("noStepsText", () => {
  it("tells a running run from an old one", () => {
    expect(mod.noStepsText({ status: "running" })).toBe(mod.NO_STEPS);
    expect(mod.noStepsText({ status: "succeeded" })).toBe(mod.NO_STEPS_OLD);
  });
});

describe("createLog restore in a tab set", () => {
  it("is called on show", () => {
    const log = out.createLog();
    const spy = vi.spyOn(log, "restore");
    const t = mod.createTabs([{ id: "a", label: "A", build: () => el() }, { id: "log", label: "Logs", build: () => log.el, onShow: () => log.restore() }], { initial: "a" });
    t.show("log");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
