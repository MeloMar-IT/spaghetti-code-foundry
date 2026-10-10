import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextStep, runNextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rh: any;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  rh = await import("../ui/run-header.js" as string);
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const doc = () => (globalThis as any).document;
const NOW = Date.parse("2026-01-01T12:00:00Z");
const base = (over: Record<string, unknown> = {}) => ({
  runId: "r1", flow: "walk", status: "running", task: "Do the thing\nmore text", startedAt: "2026-01-01T11:00:00Z",
  vars: { github_repo: "o/r", issue: 7 }, branch: "feature/x", state: { next: "b" }, history: [], next: nextStep("running"), ...over,
});
const primary = (head: any) => head.el.all("button").filter((b: FakeElement) => (b.attrs.class ?? "").split(" ").includes("primary")).map((b: FakeElement) => b.textContent);
const buttons = (head: any) => head.el.all("button").map((b: FakeElement) => b.textContent);
const byFocus = (head: any, name: string) => [...head.el.all("button"), ...head.el.all("a"), ...head.el.all("select")].find((b: FakeElement) => b.attrs["data-focus"] === name);
const fact = (head: any, key: string) => head.el.all("dd").find((d: FakeElement) => d.attrs["data-fact"] === key);

describe("pure helpers", () => {
  it("runTitle: first line, else the flow, else Run", () => {
    expect(rh.runTitle({ task: "A\nB", flow: "f" })).toBe("A");
    expect(rh.runTitle({ task: "  ", flow: "f" })).toBe("f");
    expect(rh.runTitle({})).toBe("Run");
  });

  it("mainAction fills Approve, else Retry, never Cancel", () => {
    expect(rh.mainAction(["approve", "reject", "cancel"])).toBe("approve");
    expect(rh.mainAction(["retry"])).toBe("retry");
    expect(rh.mainAction(["cancel"])).toBeNull();
    expect(rh.mainAction([])).toBeNull();
  });

  it("runTiming", () => {
    const done = rh.runTiming({ startedAt: "2026-01-01T11:00:00Z", finishedAt: "2026-01-01T11:12:00Z", status: "succeeded" }, NOW);
    expect(done).toEqual({ started: "1h ago", duration: "12m" });
    const live = rh.runTiming({ startedAt: "2026-01-01T09:30:00Z", status: "running", next: { timing: { progress: "step 2 of 5" } } }, NOW);
    expect(live.duration).toBe("2h 30m · step 2 of 5");
    expect(rh.runTiming({ status: "running" }, NOW)).toEqual({ started: "—", duration: "—" });
    expect(rh.runTiming({ startedAt: "2026-01-01T11:00:00Z", finishedAt: "2026-01-01T10:00:00Z", status: "failed" }, NOW).duration).toBe("—");
  });

  it("runActions offers Retry only with a step to continue at", () => {
    for (const s of ["failed", "stopped", "cancelled"]) {
      expect(rh.runActions({ status: s })).toEqual([]);
      expect(rh.runActions({ status: s, state: { next: "a" } })).toEqual(["retry"]);
    }
  });

  it("headerFacts: the keys per role", () => {
    const s = base({ resumes: 2, owner: "u1", totalCostUsd: 1.5, workdir: "/w" });
    expect(rh.headerFacts(s, { now: NOW }).map((f: any) => f.key)).toEqual(["work", "branch", "started", "duration", "resumes", "flow"]);
    const admin = rh.headerFacts(s, { admin: true, names: new Map([["u1", "Ann"]]), now: NOW });
    expect(admin.map((f: any) => f.key)).toEqual(["work", "branch", "started", "duration", "resumes", "flow", "owner", "cost", "workspace"]);
    expect(admin.find((f: any) => f.key === "owner").text).toBe("Ann");
    expect(admin.find((f: any) => f.key === "duration").label).toBe("Running for");
    expect(rh.headerFacts(s, { admin: true, names: new Map(), now: NOW }).find((f: any) => f.key === "owner").text).toBe("deleted user");
    expect(rh.headerFacts(s, { admin: true, now: NOW }).some((f: any) => f.key === "owner")).toBe(false);
    expect(rh.headerFacts(base({ status: "failed", finishedAt: "2026-01-01T11:30:00Z" }), { now: NOW }).find((f: any) => f.key === "duration")).toMatchObject({ label: "Ran for", text: "30m" });
    expect(rh.headerFacts(base({ vars: { github_repo: "o/r", pr: 5 } }), { now: NOW })[0].text).toBe("o/r PR #5");
  });
});

describe("role safety", () => {
  const trap = () => {
    const s: any = base({ status: "failed", next: runNextStep(base({ status: "failed", reason: "x" }) as never, {}) });
    for (const k of ["totalCostUsd", "workdir", "agent", "owner"]) Object.defineProperty(s, k, { get: () => { throw new Error(`read ${k}`); }, enumerable: true });
    return s;
  };

  it("a user header never reads cost, workspace, agent or owner", () => {
    expect(() => rh.headerFacts(trap(), { admin: false })).not.toThrow();
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    expect(() => head.update(trap(), {})).not.toThrow();
    const text = head.el.textContent;
    for (const w of ["$", "Cost", "Owner", "Workspace", "Open flow"]) expect(text).not.toContain(w);
  });

  it("an administrator sees cost, owner and Open flow", () => {
    const head = rh.createRunHeader({ admin: true, actions: () => [] });
    head.update(base({ owner: "u1", totalCostUsd: 0.5 }), { names: new Map([["u1", "Ann"]]) });
    expect(fact(head, "cost").textContent).toBe("$0.5000");
    expect(fact(head, "owner").textContent).toBe("Ann");
    expect(byFocus(head, "open-flow").attrs.href).toBe("#/flows/walk");
  });
});

describe("the main button", () => {
  const make = (s: any, opts: any = {}) => {
    const head = rh.createRunHeader({ admin: false, onAction: vi.fn(), ...opts });
    head.update(s, {});
    return head;
  };

  it("is chosen from the status", () => {
    expect(primary(make(base({ status: "waiting", next: nextStep("approval", { repo: "o/r", runId: "r1" }) })))).toEqual(["Approve"]);
    for (const status of ["failed", "stopped", "cancelled"]) expect(primary(make(base({ status, next: undefined }))), status).toEqual([rh.RETRY_LABEL]);
    const running = make(base());
    expect(primary(running)).toEqual([]);
    expect(byFocus(running, "act-cancel").attrs.class).toBe("danger");
  });

  it("is not filled while the answer form is shown", () => {
    const s = base({ status: "stopped", questions: "Which?", canAnswer: true });
    expect(primary(make(s))).toEqual([]);
    expect(buttons(make(s))).toContain(rh.RETRY_LABEL);
  });

  it("read-only: no buttons, the container is hidden", () => {
    const head = make(base({ status: "failed" }), { onAction: null });
    expect(buttons(head).filter((t: string) => t !== "?")).toEqual([]);
    expect(head.el.all("div").find((d: FakeElement) => d.attrs.class === "run-actions").hidden).toBe(true);
  });

  it("D16: the words are 'Retry from the failing step', never 'Resume at' or plain 'Retry'", () => {
    const head = make(base({ status: "failed", next: undefined }));
    expect(head.el.textContent).not.toContain("Resume at");
    expect(buttons(head)).toContain("Retry from the failing step");
    expect(buttons(head)).not.toContain("Retry");
    expect(byFocus(head, "act-retry").attrs.title).toBe('Continue at step "b"');
  });

  it("the administrator's resume button has the label, the step in the title and is filled", () => {
    const head = rh.createRunHeader({ admin: true, actions: runs.actions });
    head.update(base({ status: "failed", next: undefined, flowDef: { steps: [{ id: "b" }] } }), {});
    const b = byFocus(head, "act-resume");
    expect(b.textContent).toBe("Retry from the failing step");
    expect(b.attrs.title).toBe('Continue at step "b"');
    expect(b.attrs.class).toBe("primary");
    expect(byFocus(head, "act-retry-from")).toBeTruthy();
    expect(head.el.textContent).not.toContain("Resume at");
  });

  it("busy sets aria-disabled on the same nodes", () => {
    const head = make(base());
    const b = byFocus(head, "act-cancel");
    head.update(base(), { busy: true });
    expect(byFocus(head, "act-cancel")).toBe(b);
    expect(b.attrs["aria-disabled"]).toBe("true");
    head.update(base(), { busy: false });
    expect("aria-disabled" in b.attrs).toBe(false);
  });
});

describe("an old run and a queued run", () => {
  it("draws a run with almost nothing, with dashes", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    expect(() => head.update({ runId: "r1", flow: "walk", status: "failed" }, {})).not.toThrow();
    for (const k of ["work", "branch", "started", "duration"]) expect(fact(head, k).textContent, k).toBe("—");
    expect(head.el.all("h1")[0].textContent).toBe("walk");
    expect(head.el.textContent).toContain("failed");
    expect(head.el.all("button").filter((b: FakeElement) => b.textContent === "?")).toHaveLength(0);
    expect(buttons(head)).toEqual([]);
  });

  it("a queued run without a run: title, only Cancel, the ahead text", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(null, { job: { runId: "r1", flow: "walk", githubRepo: "o/r", issue: 3, next: nextStep("queued", { repo: "o/r", runId: "r1" }), ahead: 2 } });
    expect(head.el.all("h1")[0].textContent).toBe("Queued run");
    expect(buttons(head).filter((t: string) => t !== "?")).toEqual(["Cancel"]);
    expect(head.el.textContent).toContain("2 runs ahead of you");
    expect(head.el.all("dd").map((d: FakeElement) => d.textContent)).toEqual(["walk", "o/r#3"]);
  });
});

describe("a stream update", () => {
  it("keeps the nodes and changes the text", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(base(), {});
    const [h1, branch, box] = [head.el.all("h1")[0], fact(head, "branch"), head.el.all("div").find((d: FakeElement) => d.attrs.class === "run-actions")];
    const cancel = byFocus(head, "act-cancel");
    head.update(base({ status: "waiting", branch: "other", task: "New", next: nextStep("approval", { repo: "o/r", runId: "r1" }) }), {});
    expect(head.el.all("h1")[0]).toBe(h1);
    expect(fact(head, "branch")).toBe(branch);
    expect(branch.textContent).toBe("other");
    expect(h1.textContent).toBe("New");
    expect(head.el.all("div").find((d: FakeElement) => d.attrs.class === "run-actions")).toBe(box);
    expect(byFocus(head, "act-cancel")).toBe(cancel);
  });

  it("a focused Cancel keeps the focus when running becomes waiting", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(base(), {});
    const cancel = byFocus(head, "act-cancel");
    cancel.focus();
    head.update(base({ status: "waiting", task: "Changed", next: nextStep("approval", { repo: "o/r", runId: "r1" }) }), {});
    expect(doc().activeElement).toBe(cancel);
    expect(byFocus(head, "act-cancel")).toBe(cancel);
  });

  it("the administrator's focused button keeps the focus", () => {
    const head = rh.createRunHeader({ admin: true, actions: runs.actions });
    const s = base({ status: "waiting", next: nextStep("approval", { repo: "o/r", runId: "r1" }) });
    head.update(s, {});
    const approve = byFocus(head, "act-approve");
    approve.focus();
    head.update({ ...s, task: "changed" }, {});
    expect(doc().activeElement).toBe(approve);
    expect(byFocus(head, "act-approve")).toBe(approve);
  });

  it("an open '?' note stays open, with the same node, also for a new status and text", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    const waiting = nextStep("approval", { repo: "o/r", runId: "r1" });
    head.update(base({ status: "waiting", next: waiting }), {});
    byFocus(head, "status-help").click();
    const note = head.el.all("span").find((s: FakeElement) => s.attrs.role === "note");
    expect(note.hidden).toBe(false);
    head.update(base({ status: "waiting", next: waiting }), {});
    expect(note.hidden).toBe(false);
    const failed = { ...nextStep("failed", { repo: "o/r", runId: "r1" }), help: "A new help text" };
    head.update(base({ status: "failed", next: failed }), {});
    expect(head.el.all("span").find((s: FakeElement) => s.attrs.role === "note")).toBe(note);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("A new help text");
  });
});

describe("the clock", () => {
  it("the admin page moves the running time on without a new update, and stops at cleanup", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T11:00:30Z"));
      (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => [] });
      (globalThis as any).EventSource = class {
        static CLOSED = 2;
        readyState = 1;
        addEventListener(type: string, fn: (e: { data: string }) => void) { if (type === "update") (globalThis as any).__update = fn; }
        close() {}
      };
      const main = new FakeElement("div");
      const stop = runs.renderRunDetail(main, "r1", { admin: true });
      (globalThis as any).__update({ data: JSON.stringify({ summary: base({ next: undefined }) }) });
      const dur = () => main.all("dd").find((d) => d.attrs["data-fact"] === "duration")!.textContent;
      expect(dur()).toBe("<1m");
      vi.setSystemTime(new Date("2026-01-01T11:04:00Z"));
      vi.advanceTimersByTime(60_000);
      expect(dur()).toBe("5m");
      stop();
      vi.advanceTimersByTime(120_000);
      expect(dur()).toBe("5m");
    } finally {
      vi.useRealTimers();
      delete (globalThis as any).EventSource;
    }
  });
});

describe("the page", () => {
  it("puts the failure card before the tabs and keeps the raw reason for the administrator", () => {
    const failed = base({ status: "failed", reason: 'step "b" failed: exit 1', history: [{ id: "b", type: "shell", ok: false, visit: 1, output: "x", error: "e", durationMs: 1 }] });
    (failed as any).next = runNextStep(failed as never, {});
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => [] });
    (globalThis as any).EventSource = class {
      static CLOSED = 2;
      readyState = 1;
      addEventListener(type: string, fn: (e: { data: string }) => void) { if (type === "update") (globalThis as any).__update = fn; }
      close() {}
    };
    for (const admin of [true, false]) {
      const main = new FakeElement("div");
      const stop = runs.renderRunDetail(main, "r1", { admin });
      (globalThis as any).__update({ data: JSON.stringify({ summary: failed }) });
      const order: FakeElement[] = [];
      const walk = (el: FakeElement) => { order.push(el); for (const c of el.children) if (c instanceof FakeElement) walk(c); };
      walk(main);
      const card = order.findIndex((e) => (e.attrs.class ?? "").includes("failure"));
      const tab = order.findIndex((e) => "data-tab" in e.attrs);
      expect(card).toBeGreaterThan(-1);
      expect(card).toBeLessThan(tab);
      const raw = main.all("details").find((d) => d.attrs.class === "raw");
      if (admin) expect(raw?.textContent).toContain("exit 1");
      else expect(raw).toBeUndefined();
      stop();
    }
    delete (globalThis as any).EventSource;
  });
});
