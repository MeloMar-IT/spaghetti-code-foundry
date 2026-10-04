import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/user/runs.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const refused = (msg: string, status = 409) => Object.assign(new Error(msg), { status });
const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();

const rec = (kind: any, runId = "r1", d: any = {}) => nextStep(kind, { runId }, d);
const run = (id: string, over: any = {}) => ({ runId: id, flow: `flow-${id}`, task: `task ${id}\nsecond line`, status: "running", startedAt: iso(10), vars: {}, history: [], next: rec("running", id), ...over });
const job = (id: string, over: any = {}) => ({ runId: id, kind: "run", enqueuedAt: iso(5), task: `queued ${id}`, ahead: 0, next: rec("queued", id), ...over });

const failure = { kind: "Code problem", cause: "code", what: "The tests failed", why: "A test did not pass.", tried: "Nothing yet.", options: ["Fix it", "Start again"], byModel: false };

describe("helpers", () => {
  it("firstLine and workText", () => {
    expect(ui.firstLine("a\nb")).toBe("a");
    expect(ui.firstLine(undefined)).toBe("");
    expect(ui.workText("o/r", "7")).toBe("o/r#7");
    expect(ui.workText("o/r")).toBe("o/r");
    expect(ui.workText("", "7")).toBe("");
  });

  it("myRunsEntries: newest first, You first, jobs attached or alone", () => {
    const a = run("a", { startedAt: iso(30) });
    const b = run("b", { startedAt: iso(5) });
    const c = run("c", { startedAt: iso(60), next: rec("approval", "c") });
    const alone = job("j", { enqueuedAt: iso(20) });
    const attached = job("a");
    const out = ui.myRunsEntries([a, b, c], [alone, attached]);
    expect(out.map((e: any) => e.run?.runId ?? `job:${e.job.runId}`)).toEqual(["c", "b", "job:j", "a"]);
    expect(out.find((e: any) => e.run?.runId === "a").job).toBe(attached);
    expect(ui.myRunsEntries(undefined, undefined)).toEqual([]);
  });

  it("runActions per status", () => {
    const k = (status: string, over: any = {}, queued = false) => ui.runActions({ status, ...over }, queued);
    expect(k("waiting")).toEqual(["approve", "reject", "cancel"]);
    expect(k("running")).toEqual(["cancel"]);
    expect(k("failed")).toEqual(["retry"]);
    expect(k("stopped")).toEqual(["retry"]);
    expect(k("cancelled")).toEqual(["retry"]);
    expect(k("succeeded")).toEqual([]);
    expect(k("queued")).toEqual(["cancel"]);
    expect(k("failed", { refinement: "s1" })).toEqual([]);
    expect(k("failed", {}, true)).toEqual(["cancel"]);
    expect(k("waiting", {}, true)).toEqual(["cancel"]);
  });

  it("runCard does not throw without a next record", () => {
    expect(() => ui.runCard({ run: run("x", { next: undefined }), job: null }, () => {})).not.toThrow();
    expect(() => ui.runCard({ run: null, job: job("y", { next: undefined }) }, () => {})).not.toThrow();
  });
});

describe("dialogs", () => {
  beforeEach(() => {
    modalRoot().replaceChildren();
    (document as any).listeners.keydown = [];
  });

  it("confirmDialog resolves true, or false for Close and Escape", async () => {
    let p = ui.confirmDialog("T", "text", "Yes please", "No");
    one(modalRoot(), "button", {}).textContent; // exists
    find(modalRoot(), "button").find((b) => b.textContent === "Yes please")!.click();
    expect(await p).toBe(true);
    p = ui.confirmDialog("T", "text", "Yes", "No");
    find(modalRoot(), "button").find((b) => b.attrs["aria-label"] === "Close")!.click();
    expect(await p).toBe(false);
    p = ui.confirmDialog("T", "text", "Yes", "No");
    for (const fn of (document as any).listeners.keydown) fn({ key: "Escape" });
    expect(await p).toBe(false);
  });

  it("decisionDialog keeps the dialog open while the call is out and after a refusal", async () => {
    let fail = true;
    let release!: () => void;
    const send = vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      if (fail) throw refused("run is not waiting for approval");
    });
    const p = ui.decisionDialog("approve", send);
    const note = one(modalRoot(), "textarea");
    note.value = " ok ";
    one(modalRoot(), "form").fire("submit", { preventDefault() {} });
    await flush();
    expect(send).toHaveBeenCalledWith("ok");
    // nothing closes the dialog while the call is out
    for (const fn of (document as any).listeners.keydown) fn({ key: "Escape" });
    find(modalRoot(), "button").find((b) => b.attrs["aria-label"] === "Close")!.click();
    expect(modalRoot().children).toHaveLength(1);
    expect(one(modalRoot(), "button", { type: "submit" }).disabled).toBe(true);
    release();
    await flush();
    expect(one(modalRoot(), "p", { role: "alert" }).textContent).toBe("run is not waiting for approval");
    expect(one(modalRoot(), "button", { type: "submit" }).disabled).toBe(false);
    expect(one(modalRoot(), "textarea").value).toBe(" ok ");
    fail = false;
    one(modalRoot(), "form").fire("submit", { preventDefault() {} });
    await flush();
    release();
    expect(await p).toBe(true);
    expect(modalRoot().children).toHaveLength(0);
  });
});

describe("renderMyRuns", () => {
  let main: FakeElement;
  let data: { runs: any[]; pending: any[] };
  let a: any;
  let ask: ReturnType<typeof vi.fn>;
  const open = async () => {
    main = document.createElement("div") as unknown as FakeElement;
    return (await ui.renderMyRuns(main, { a, ask })) as () => void;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    data = { runs: [], pending: [] };
    ask = vi.fn(async () => true);
    a = { runs: vi.fn(async () => data.runs), queue: vi.fn(async () => ({ pending: data.pending, active: [] })), cancelRun: vi.fn(async () => ({ cancelled: true })) };
  });

  it("draws one card per run with a real link and no click handler", async () => {
    data.runs = [run("r1", { vars: { github_repo: "o/r", issue: "7" }, next: rec("approval", "r1") }), run("r2", { vars: { github_repo: "o/r" } }), run("r3")];
    await open();
    const items = find(main, "li");
    expect(items).toHaveLength(3);
    for (const li of items) {
      const links = find(li, "a");
      expect(links).toHaveLength(1);
      expect(links[0]!.attrs.href).toMatch(/^#\/runs\/r\d$/);
      expect(links[0]!.attrs.tabindex).toBeUndefined();
      expect(li.listeners.click).toBeUndefined();
    }
    const first = items[0]!;
    expect(first.attrs.class).toContain("who-you");
    expect(first.textContent).toContain(data.runs[0].next.status);
    expect(find(first, "button", { "aria-label": "What does this mean?" })).toHaveLength(1);
    expect(first.textContent).toContain("flow-r1");
    expect(first.textContent).toContain("task r1");
    expect(first.textContent).not.toContain("second line");
    expect(first.textContent).toContain("o/r#7");
    expect(first.textContent).toContain(data.runs[0].next.text);
    expect(first.textContent).toContain("Started");
    expect(items[1]!.textContent).toContain("o/r");
    expect(items[1]!.textContent).not.toContain("o/r#");
    expect(items[2]!.textContent).not.toMatch(/o\/r/);
  });

  it("shows queued runs ahead of the user and removes them", async () => {
    data.runs = [run("q2", { status: "queued", next: rec("queued", "q2") })];
    data.pending = [job("q2", { ahead: 2 }), job("q3", { ahead: 1 }), job("q4", { ahead: 0, flow: "named" })];
    await open();
    expect(main.textContent).toContain("2 runs ahead of you");
    expect(main.textContent).toContain("1 run ahead of you");
    expect(main.textContent).not.toContain("0 runs ahead");
    expect(main.textContent).toContain("Queued run");
    expect(main.textContent).toContain("queued q3");
    expect(main.textContent).toContain("named");
    const remove = (id: string) => one(main, "button", { "data-focus": `remove-${id}` });

    ask.mockResolvedValueOnce(false);
    remove("q3").click();
    await flush();
    expect(a.cancelRun).not.toHaveBeenCalled();

    const before = a.runs.mock.calls.length;
    remove("q3").click();
    await flush();
    expect(a.cancelRun).toHaveBeenCalledTimes(1);
    expect(a.cancelRun).toHaveBeenCalledWith("q3");
    expect(a.runs.mock.calls.length).toBe(before + 1);
  });

  it("shows the server's sentence when Remove is refused, or when nothing was cancelled", async () => {
    data.pending = [job("q1")];
    await open();
    a.cancelRun.mockRejectedValueOnce(refused("not allowed", 403));
    one(main, "button", { "data-focus": "remove-q1" }).click();
    await flush();
    expect(one(main, "p", { role: "alert" }).textContent).toBe("not allowed");
    expect(find(main, "li")).toHaveLength(1);
    a.cancelRun.mockResolvedValueOnce({ cancelled: false });
    one(main, "button", { "data-focus": "remove-q1" }).click();
    await flush();
    expect(one(main, "p", { role: "alert" }).textContent).toContain("could not be cancelled");
    expect(find(main, "li")).toHaveLength(1);
  });

  it("says so with no runs and offers Start work", async () => {
    await open();
    expect(main.textContent).toContain(ui.NO_RUNS);
    expect(find(main, "a", { href: "#/start" }).filter((l) => l.textContent === "Start work").length).toBeGreaterThan(0);
    expect(find(main, "li")).toHaveLength(0);
  });

  it("refreshes every 30 s and stops after the cleanup", async () => {
    const cleanup = await open();
    expect(find(main, "li")).toHaveLength(0);
    data.runs = [run("n1")];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(find(main, "li")).toHaveLength(1);
    cleanup();
    const n = a.runs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(a.runs.mock.calls.length).toBe(n);
  });

  it("draws no cost, model or agent text", async () => {
    data.runs = [run("c1", { totalCostUsd: 1.2345, workdir: "/srv/w", history: [{ agent: "claude", model: "opus-x", costUsd: 0.5 }] })];
    await open();
    const text = main.textContent.toLowerCase();
    for (const w of ["$", "cost", "model", "claude", "opus", "tok", "/srv/"]) expect(text, w).not.toContain(w);
  });
});

describe("renderMyRun", () => {
  let main: FakeElement;
  let a: any;
  let stream: any;
  let ask: ReturnType<typeof vi.fn>;
  let go: ReturnType<typeof vi.fn>;
  let state: { summary: any; runError: any; pending: any[]; queueError?: any };
  const emit = (type: string, data: unknown) => { for (const fn of stream.listeners[type] ?? []) fn({ data: typeof data === "string" ? data : JSON.stringify(data) }); };
  const open = async (decide?: any) => {
    main = document.createElement("div") as unknown as FakeElement;
    const cleanup = ui.renderMyRun(main, "r1", { a, ask, go, ...(decide ? { decide } : {}) }) as () => void;
    await flush();
    return cleanup;
  };
  const labels = () => find(one(main, "div", { class: "run-actions" }), "button").map((b) => b.textContent);
  const button = (kind: string) => one(main, "button", { "data-focus": `act-${kind}` });
  const summaryOf = (over: any = {}) => ({
    runId: "r1", flow: "build", task: "Do the thing", status: "running", startedAt: iso(3), vars: { github_repo: "o/r", issue: "7" }, branch: "feature/x",
    history: [], state: { next: "step2" }, next: rec("running"),
    flowDef: { name: "build", steps: [{ id: "step2", type: "agent", description: "Writes the code" }], publish: { enabled: true, version: 3 } }, ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    modalRoot().replaceChildren();
    (document as any).listeners.keydown = [];
    (document as any).getElementById("toast").textContent = "";
    (document as any).activeElement = null;
    state = { summary: summaryOf(), runError: null, pending: [] };
    stream = { listeners: {} as any, addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); }, close: vi.fn(), readyState: 1 };
    ask = vi.fn(async () => true);
    go = vi.fn();
    a = {
      run: vi.fn(async () => { if (state.runError) throw state.runError; return state.summary; }),
      queue: vi.fn(async () => { if (state.queueError) throw state.queueError; return { pending: state.pending, active: [] }; }),
      events: vi.fn(() => stream),
      diff: vi.fn(async () => ({ patch: "+a", stat: "1 file" })),
      approveRun: vi.fn(async () => ({})),
      rejectRun: vi.fn(async () => ({})),
      resumeRun: vi.fn(async () => ({})),
      cancelRun: vi.fn(async () => ({ cancelled: true })),
    };
  });

  it("shows the right buttons for each status", async () => {
    const cases: [any, string[]][] = [
      [{ status: "waiting", next: rec("approval") }, ["Approve", "Reject", "Cancel"]],
      [{ status: "running" }, ["Cancel"]],
      [{ status: "failed" }, ["Retry"]],
      [{ status: "stopped" }, ["Retry"]],
      [{ status: "cancelled" }, ["Retry"]],
      [{ status: "succeeded" }, []],
      [{ status: "queued" }, ["Cancel"]],
      [{ status: "failed", refinement: "s1" }, []],
    ];
    for (const [over, want] of cases) {
      state.summary = summaryOf(over);
      await open();
      expect(labels(), over.status).toEqual(want);
    }
  });

  it("shows what it is doing now, the task, branch and version", async () => {
    await open();
    expect(main.textContent).toContain("Now");
    expect(main.textContent).toContain(state.summary.next.action);
    expect(main.textContent).toContain(state.summary.next.why);
    expect(main.textContent).toContain("Current step");
    expect(main.textContent).toContain("Writes the code");
    expect(main.textContent).toContain("Do the thing");
    expect(main.textContent).toContain("Branch");
    expect(main.textContent).toContain("feature/x");
    expect(main.textContent).toContain("Flow version");
    expect(main.textContent).toContain("o/r#7");
    expect(find(main, "button", { "aria-label": "What does this mean?" })).toHaveLength(1);
    expect(one(main, "a", { "aria-label": "Back to My runs" }).attrs.href).toBe("#/runs");
  });

  it("approves and rejects through the real dialog", async () => {
    state.summary = summaryOf({ status: "waiting", next: rec("approval") });
    await open();
    button("approve").click();
    await flush();
    one(modalRoot(), "div", { role: "dialog" });
    one(modalRoot(), "textarea").value = " ok ";
    one(modalRoot(), "form").fire("submit", { preventDefault() {} });
    await flush();
    expect(a.approveRun).toHaveBeenCalledWith("r1", "ok");
    expect(modalRoot().children).toHaveLength(0);
    expect(toastText()).toBe("Approved — continuing");

    button("reject").click();
    await flush();
    one(modalRoot(), "form").fire("submit", { preventDefault() {} });
    await flush();
    expect(a.rejectRun).toHaveBeenCalledWith("r1", "");
    expect(toastText()).toBe("Rejected");
  });

  it("does not replace the button that opens a dialog, and shows only Cancel for a queued failed run", async () => {
    state.summary = summaryOf({ status: "waiting", next: rec("approval") });
    await open();
    const opener = button("approve");
    opener.click();
    await flush();
    expect(opener.parent).toBeDefined();
    expect(find(main, "button", { "data-focus": "act-approve" })[0]).toBe(opener);
    state.summary = summaryOf({ status: "failed", next: { ...rec("failed"), failure } });
    state.pending = [job("r1", { ahead: 1 })];
    await open();
    expect(labels()).toEqual(["Cancel"]);
  });

  it("sends with Ctrl+Enter in the note", async () => {
    state.summary = summaryOf({ status: "waiting", next: rec("approval") });
    await open();
    button("approve").click();
    await flush();
    one(modalRoot(), "textarea").fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
    await flush();
    expect(a.approveRun).toHaveBeenCalledWith("r1", "");
  });

  it("keeps the dialog and the page usable when Approve is refused", async () => {
    state.summary = summaryOf({ status: "waiting", next: rec("approval") });
    a.approveRun.mockRejectedValueOnce(refused("run is not waiting for approval"));
    await open();
    button("approve").click();
    await flush();
    one(modalRoot(), "textarea").value = "note";
    one(modalRoot(), "form").fire("submit", { preventDefault() {} });
    await flush();
    expect(one(modalRoot(), "p", { role: "alert" }).textContent).toBe("run is not waiting for approval");
    expect(one(modalRoot(), "button", { type: "submit" }).disabled).toBe(false);
    expect(one(modalRoot(), "textarea").value).toBe("note");
    find(modalRoot(), "button").find((b) => b.attrs["aria-label"] === "Close")!.click();
    await flush();
    expect(labels()).toEqual(["Approve", "Reject", "Cancel"]);
    expect(button("approve").disabled).toBe(false);
  });

  it("retries with the run id only, and shows a refusal", async () => {
    state.summary = summaryOf({ status: "failed", next: { ...rec("failed"), failure } });
    await open();
    button("retry").click();
    await flush();
    expect(a.resumeRun.mock.calls[0]).toEqual(["r1"]);
    expect(toastText()).toBe("Retrying");
    a.resumeRun.mockRejectedValueOnce(refused("this run belongs to a refinement session"));
    button("retry").click();
    await flush();
    expect(one(main, "p", { role: "alert" }).textContent).toBe("this run belongs to a refinement session");
    expect(button("retry").disabled).toBe(false);
  });

  it("cancels after a confirmation", async () => {
    await open();
    ask.mockResolvedValueOnce(false);
    button("cancel").click();
    await flush();
    expect(a.cancelRun).not.toHaveBeenCalled();
    const reads = a.run.mock.calls.length;
    button("cancel").click();
    await flush();
    expect(a.cancelRun).toHaveBeenCalledWith("r1");
    expect(a.run.mock.calls.length).toBeGreaterThan(reads);
    expect(toastText()).toBe("Cancelled");
  });

  it("treats cancelled:false as a refusal and stays on the page", async () => {
    await open();
    a.cancelRun.mockResolvedValueOnce({ cancelled: false });
    button("cancel").click();
    await flush();
    expect(one(main, "p", { role: "alert" }).textContent).toContain("could not be cancelled");
    expect(go).not.toHaveBeenCalled();
  });

  it("shows a queued run with no run record, and cancelling goes back to the list", async () => {
    state.summary = null;
    state.runError = refused("run not found", 404);
    state.pending = [job("r1", { ahead: 2, flow: "named" })];
    await open();
    expect(main.textContent).toContain("Queued run");
    expect(main.textContent).toContain(state.pending[0].next.status);
    expect(main.textContent).toContain("2 runs ahead of you");
    expect(labels()).toEqual(["Cancel"]);
    button("cancel").click();
    await flush();
    expect(ask.mock.calls[0]![1]).toContain("leaves the queue");
    expect(a.cancelRun).toHaveBeenCalledWith("r1");
    expect(go).toHaveBeenCalledWith("#/runs");
  });

  it("says not found, and shows an error for any other failure", async () => {
    state.summary = null;
    state.runError = refused("run not found", 404);
    await open();
    expect(main.textContent).toContain(ui.NOT_FOUND);
    expect(find(main, "a", { href: "#/runs" }).length).toBeGreaterThan(0);
    expect(find(main, "div", { class: "run-actions" })).toHaveLength(0);

    state.runError = refused("boom", 500);
    await open();
    expect(one(main, "p", { role: "alert" }).textContent).toBe("boom");
    expect(main.textContent).not.toContain("Loading");

    state.runError = refused("run not found", 404);
    state.queueError = new Error("queue down");
    await open();
    expect(main.textContent).not.toContain(ui.NOT_FOUND);
    expect(one(main, "p", { role: "alert" }).textContent).toBe("queue down");
  });

  it("explains a failed run without raw details", async () => {
    state.summary = summaryOf({ status: "failed", reason: "raw /srv/x exit 1", next: { ...rec("failed"), failure } });
    await open();
    expect(main.textContent).toContain("What happened");
    expect(main.textContent).toContain("Why");
    expect(main.textContent).toContain("Your options");
    expect(main.textContent).not.toContain("Raw details");
    expect(main.textContent).not.toContain("/srv/x");
    expect(find(main, "details")).toHaveLength(0);
  });

  it("has Log, Steps and Changes", async () => {
    state.summary = summaryOf({ history: [
      { id: "a", type: "claude", visit: 1, ok: true, durationMs: 1000, output: "secret", agent: "claude", model: "opus-x" },
      { id: "b", type: "shell", visit: 1, ok: false, durationMs: 50, error: "exit 1" },
    ] });
    await open();
    const tabs = find(one(main, "div", { class: "seg tabs" }), "button");
    expect(tabs.map((b) => b.textContent)).toEqual(["Log", "Steps", "Changes"]);
    emit("log", { line: "▶ a (shell)" });
    emit("log", "not json");
    expect(one(main, "pre", { class: "log" }).textContent).toContain("▶ a (shell)");

    tabs[1]!.click();
    expect(find(main, "details")).toHaveLength(0);
    expect(find(main, "summary")).toHaveLength(0);
    expect(main.textContent).not.toContain("secret");
    expect(main.textContent).toContain("Agent");

    tabs[2]!.click();
    await flush();
    one(main, "pre", { class: "diff" });
    a.diff.mockResolvedValueOnce({ patch: "" });
    tabs[2]!.click();
    await flush();
    expect(main.textContent).toContain(ui.NO_CHANGES);
    a.diff.mockRejectedValueOnce(refused("no access", 403));
    tabs[2]!.click();
    await flush();
    expect(find(main, "p", { role: "alert" }).map((p) => p.textContent)).toContain("no access");
  });

  it("draws no cost, model, agent, folder or admin control on any tab", async () => {
    state.summary = summaryOf({
      totalCostUsd: 1.5, workdir: "/srv/w", runDir: "/srv/d",
      history: [{ id: "a", type: "claude", visit: 1, ok: true, durationMs: 10, agent: "claude", model: "opus-x", costUsd: 0.5, tokens: { input: 1000, output: 1000 } }],
    });
    state.summary.flowDef.steps = [{ id: "step2", type: "agent" }];
    await open();
    const texts: string[] = [main.textContent];
    for (const b of find(one(main, "div", { class: "seg tabs" }), "button")) {
      b.click();
      await flush();
      texts.push(main.textContent);
    }
    for (const t of texts) {
      for (const w of ["$", "Cost", "claude", "opus", "tok", "/srv/", "Open flow", "Retry from step", "Workspace", "ranscript"]) expect(t, w).not.toContain(w);
    }
    expect(find(main, "select")).toHaveLength(0);
  });

  it("does not replace the page while a dialog is open", async () => {
    state.summary = summaryOf({ status: "waiting", next: rec("approval") });
    await open();
    button("approve").click();
    await flush();
    state.summary = summaryOf({ flow: "renamed", status: "waiting", next: rec("approval") });
    emit("update", { summary: state.summary });
    expect(main.textContent).not.toContain("renamed");
    find(modalRoot(), "button").find((b) => b.attrs["aria-label"] === "Close")!.click();
    await flush();
    expect(main.textContent).toContain("renamed");
  });

  it("ignores an older answer that arrives after a newer update", async () => {
    let release!: (s: any) => void;
    let first = true;
    a.run.mockImplementation(() => (first ? ((first = false), new Promise((r) => (release = r))) : Promise.resolve(state.summary)));
    await open();
    emit("update", { summary: summaryOf({ flow: "fresh" }) });
    release(summaryOf({ flow: "stale" }));
    await flush();
    expect(main.textContent).toContain("fresh");
    expect(main.textContent).not.toContain("stale");
  });

  it("closes the stream, stops the timer and draws nothing after the cleanup", async () => {
    state.pending = [job("r1")];
    const cleanup = await open();
    cleanup();
    expect(stream.close).toHaveBeenCalled();
    const n = a.queue.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.queue.mock.calls.length).toBe(n);
  });

  it("toasts when the stream is lost for good", async () => {
    await open();
    stream.readyState = 2;
    stream.onerror();
    expect(toastText()).toBe("Lost connection to the run stream");
  });
});

describe("ui/style.css", () => {
  const css = readFileSync("ui/style.css", "utf8");
  const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(`${sel} {`)) ?? "";
  it("is one column of cards, wraps the buttons and scrolls the log and diff", () => {
    expect(rule(".run-cards")).not.toBe("");
    expect(rule(".run-cards")).not.toContain("grid-template-columns");
    expect(rule(".run-actions")).toContain("flex-wrap: wrap");
    expect(rule(".log")).toContain("overflow: auto");
    expect(rule("pre.diff")).toContain("overflow: auto");
  });
});
