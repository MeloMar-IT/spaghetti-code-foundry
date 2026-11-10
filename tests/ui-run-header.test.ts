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
  it("runTitle: issue title, else the first task line, else Issue #N, else Change; never the flow or the run ID", () => {
    expect(rh.runTitle({ issueTitle: "Fix login", task: "A\nB", flow: "f", runId: "r9" })).toBe("Fix login");
    expect(rh.runTitle({ task: "A\nB", flow: "f" })).toBe("A");
    expect(rh.runTitle({ task: "  ", flow: "f", vars: { issue: 7 }, runId: "r9" })).toBe("Issue #7");
    expect(rh.runTitle({ task: "  ", flow: "f", runId: "r9" })).toBe("Change");
    expect(rh.runTitle({})).toBe("Change");
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
      expect(rh.runActions({ status: s })).toEqual(s === "stopped" ? ["cancel"] : []);
      expect(rh.runActions({ status: s, state: { next: "a" } })).toEqual(s === "stopped" ? ["retry", "cancel"] : ["retry"]);
    }
    expect(rh.runActions({ status: "stopped", refinement: "s1" })).toEqual([]);
    expect(rh.runActions({ status: "stopped", next: { kind: "issue_closed" } })).toEqual(["cancel"]);
    // a split that already made new issues is not retried
    expect(rh.runActions({ status: "failed", state: { next: "create_split" }, next: { kind: "failed", splitMade: "some" } })).toEqual([]);
    expect(rh.runActions({ status: "failed", state: { next: "create_split" }, next: { kind: "failed" } })).toEqual(["retry"]);
  });

  it("retryText and the retries fact", () => {
    const r = (o: Record<string, unknown>) => rh.retryText({ started: 2, waiting: false, outcome: "finished", ...o });
    expect(r({})).toBe("2 automatic retries after a time limit — it finished");
    expect(r({ started: 1 })).toBe("1 automatic retry after a time limit — it finished");
    expect(r({ outcome: "split" })).toContain("it was split");
    expect(r({ outcome: "failed" })).toContain("it failed");
    expect(r({ outcome: "cancelled" })).toContain("it was cancelled");
    expect(r({ outcome: "open" })).toContain("it is still open");
    expect(r({ started: 1, waiting: true, outcome: "open" })).toBe("1 automatic retry after a time limit — the next one is waiting");
    expect(r({ started: 0, waiting: true, outcome: "open" })).toBe("An automatic retry after a time limit is waiting");
    const s = base({ resumes: 2, retries: { started: 2, waiting: false, outcome: "finished" } });
    const keys = ["work", "branch", "started", "duration", "resumes", "retries"];
    expect(rh.headerFacts(s, { now: NOW }).map((f: any) => f.key)).toEqual(keys);
    expect(rh.headerFacts(s, { admin: true, now: NOW }).map((f: any) => f.key).slice(0, 6)).toEqual(keys);
    expect(rh.headerFacts(base({}), { now: NOW }).some((f: any) => f.key === "retries")).toBe(false);
  });

  it("headerFacts: the keys per role", () => {
    const s = base({ resumes: 2, owner: "u1", totalCostUsd: 1.5, workdir: "/w" });
    expect(rh.headerFacts(s, { now: NOW }).map((f: any) => f.key)).toEqual(["work", "branch", "started", "duration", "resumes"]);
    const admin = rh.headerFacts(s, { admin: true, names: new Map([["u1", "Ann"]]), now: NOW });
    expect(admin.map((f: any) => f.key)).toEqual(["work", "branch", "started", "duration", "resumes", "owner", "cost"]);
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

describe("the bar", () => {
  it.each([[undefined, "Back to Runs"], ["Back to My runs", "Back to My runs"]])("is a toolbar page-head with the back link before the title (%s)", (label, expected) => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {}, ...(label ? { backLabel: label } : {}) });
    const h1 = head.el.all("h1")[0] as FakeElement;
    const bar = h1.parent as FakeElement;
    expect(bar.attrs.class).toBe("toolbar page-head");
    const back = bar.children[bar.children.indexOf(h1) - 1] as FakeElement;
    expect(back.attrs["data-focus"]).toBe("back");
    expect(back.attrs.href).toBe("#/runs");
    expect(back.attrs.class).toBe("btn ghost");
    expect(back.attrs["aria-label"]).toBe(expected);
    expect(bar.children.slice(bar.children.indexOf(h1) + 1).map((c: FakeElement) => c.tag)).toEqual(["span", "span", "span"]);
    head.update(base(), {});
    expect(h1.textContent).toBe("Do the thing");
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
    expect(head.el.all("h1")[0].textContent).toBe("Change");
    expect(head.el.textContent).toContain("failed");
    expect(head.el.all("button").filter((b: FakeElement) => b.textContent === "?")).toHaveLength(0);
    expect(buttons(head)).toEqual([]);
  });

  it("a queued run without a run: title, only Cancel, the ahead text", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(null, { job: { runId: "r1", flow: "walk", githubRepo: "o/r", issue: 3, next: nextStep("queued", { repo: "o/r", runId: "r1" }), ahead: 2 } });
    expect(head.el.all("h1")[0].textContent).toBe("Issue #3");
    expect(buttons(head).filter((t: string) => t !== "?")).toEqual(["Stop this change…"]);
    expect(head.el.textContent).toContain("2 runs ahead of you");
    expect(head.el.textContent).toContain(rh.NOW_TEXT.queued);
    expect(head.el.all("dd").map((d: FakeElement) => d.textContent)).toEqual(["o/r#3", "r1", "walk"]);
  });
});

describe("phase and now sentence", () => {
  const flowDef = { steps: ["pull_ticket", "plan", "wait_for_story", "implement", "run_tests", "push"].map((id) => ({ id })) };
  const run = (over: Record<string, unknown>) => ({ runId: "r1", flow: "f", flowDef, history: [], state: { next: null }, ...over });
  const ok = (id: string) => ({ id, ok: true, type: "shell" });
  const cur = (s: any, job: any = null) => rh.runPhase(s, job);

  it("marks the phase of the step a running run is at", () => {
    expect(cur(run({ status: "running", state: { next: "implement" } }))).toEqual({ current: 2, complete: false });
    expect(cur(run({ status: "running", state: { next: null }, history: [ok("pull_ticket"), ok("plan")] }))).toEqual({ current: 1, complete: false });
  });
  it("a stopped run shows the step it stopped at, not the step it resumes at", () => {
    // The shipped flows stop at wait_for_story or send_back but resume at pull_ticket.
    const s = run({ status: "stopped", reason: 'stopped at step "wait_for_story" — needs attention', state: { next: "pull_ticket" }, history: [ok("pull_ticket"), ok("plan"), ok("wait_for_story")] });
    expect(cur(s)).toEqual({ current: 1, complete: false });
    expect(cur({ ...s, reason: undefined })).toEqual({ current: 1, complete: false });
    expect(cur(run({ status: "stopped", reason: 'stopped at step "sub/send_back" — needs attention', state: { next: "pull_ticket" } }))).toEqual({ current: 1, complete: false });
  });
  it("a failed run shows the failed step; a waiting run the step that waits", () => {
    const failed = run({ status: "failed", state: { next: "pull_ticket" }, history: [ok("pull_ticket"), { id: "run_tests", ok: false, type: "shell" }] });
    expect(cur(failed)).toEqual({ current: 3, complete: false });
    expect(cur(run({ status: "waiting", waiting: { stepId: "push" }, state: { next: "implement" } }))).toEqual({ current: 4, complete: false });
  });
  it("a succeeded run is complete; a queued run, or a pending retry, marks nothing", () => {
    expect(cur(run({ status: "succeeded" }))).toEqual({ current: null, complete: true });
    expect(cur(run({ status: "queued", state: { next: "plan" } }))).toEqual({ current: null, complete: false });
    expect(cur(run({ status: "failed", state: { next: "plan" }, history: [{ id: "plan", ok: false }] }), { runId: "r1" })).toEqual({ current: null, complete: false });
    expect(cur(null)).toEqual({ current: null, complete: false });
  });
  it("uses the name rules for a step that is not in the flow, and does not throw", () => {
    expect(cur(run({ status: "running", state: { next: "my_own_step" } }))).toMatchObject({ complete: false });
    expect(cur(run({ status: "running", flowDef: undefined, state: { next: "run_tests" } }))).toEqual({ current: 3, complete: false });
  });

  it("nowText: one sentence per state", () => {
    const T = rh.NOW_TEXT;
    const now = (s: any, job: any = null) => rh.nowText(s, job);
    expect(now(null)).toBe(T.queued);
    expect(now(run({ status: "queued" }))).toBe(T.queued);
    expect(now(run({ status: "running", state: { next: "implement" } }))).toBe("Making the change.");
    expect(now(run({ status: "waiting" }))).toBe(T.waiting);
    expect(now(run({ status: "stopped", questions: "Which db?" }))).toBe(T.questions);
    expect(now(run({ status: "stopped" }))).toBe(T.stopped);
    expect(now(run({ status: "failed" }))).toBe(T.failed);
    expect(now(run({ status: "cancelled" }))).toBe(T.cancelled);
    expect(now(run({ status: "succeeded" }))).toBe(T.succeeded);
  });
  it("nowText: answered questions do not override the current status", () => {
    const T = rh.NOW_TEXT;
    const answered = { questions: "Which db?", answers: [{ at: "2026-01-01T10:00:00Z", text: "pg" }] };
    expect(rh.nowText(run({ ...answered, status: "succeeded" }))).toBe(T.succeeded);
    expect(rh.nowText(run({ ...answered, status: "failed" }))).toBe(T.failed);
    expect(rh.nowText(run({ ...answered, status: "waiting" }))).toBe(T.waiting);
  });
  it("nowText: a pending retry is queued although the run failed before", () => {
    expect(rh.nowText(run({ status: "failed" }), { runId: "r1" })).toBe(rh.NOW_TEXT.queued);
  });

  it("the header shows the strip and the sentence, and the strip stays for the same phase", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(base({ flowDef, state: { next: "implement" } }), {});
    const strip = () => head.el.all("ol").find((o: FakeElement) => (o.attrs.class ?? "").includes("scf-phase-strip"));
    const first = strip();
    expect(first.all("li").map((li: FakeElement) => li.textContent)).toEqual(["Understand", "Plan", "Build", "Check", "Deliver"]);
    expect(first.all("li").filter((li: FakeElement) => li.attrs["aria-current"] === "step")).toHaveLength(1);
    expect(head.el.textContent).toContain("Making the change.");
    head.update(base({ flowDef, state: { next: "implement" }, branch: "other" }), {});
    expect(strip()).toBe(first);
    head.update(base({ flowDef, state: { next: "run_tests" } }), {});
    expect(strip()).not.toBe(first);
    head.update(base({ flowDef, status: "succeeded" }), {});
    expect(strip().all("li").filter((li: FakeElement) => li.attrs["aria-current"] === "step")).toHaveLength(0);
  });
});

describe("technical details and the title", () => {
  const tech = (head: any) => head.el.all("details").find((d: FakeElement) => d.attrs["data-part"] === "tech");
  const flowDef = { steps: ["a", "b", "c", "d", "e"].map((id) => ({ id })) };
  it("holds Run ID, Flow and the step count, starts closed, and is the only place for them", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(base({ flowDef, history: [{ id: "a", ok: true }, { id: "b", ok: true }] }), {});
    const d = tech(head);
    expect(d.open).toBeFalsy();
    expect(d.all("summary")[0].textContent).toBe("Technical details");
    expect(d.textContent).toContain("r1");
    expect(d.textContent).toContain("walk");
    expect(d.textContent).toContain("2 of 5 steps done");
    const outside = head.el.textContent.replace(d.textContent, "");
    expect(outside).not.toContain("r1");
    expect(outside).not.toContain("walk");
    expect(head.el.all("h1")[0].textContent).toBe("Do the thing");
  });
  it("shows the workspace to an administrator only, and keeps its open state over updates", () => {
    const user = rh.createRunHeader({ admin: false, onAction: () => {} });
    user.update(base({ workdir: "/w" }), {});
    expect(tech(user).textContent).not.toContain("/w");
    const admin = rh.createRunHeader({ admin: true, actions: () => [] });
    admin.update(base({ workdir: "/w" }), {});
    expect(tech(admin).textContent).toContain("/w");
    const d = tech(admin);
    d.open = true;
    admin.update(base({ workdir: "/w", history: [{ id: "a", ok: true }] }), {});
    expect(tech(admin)).toBe(d);
    expect(d.open).toBe(true);
  });
  it("calls onTitle once for equal titles and again when the title changes", () => {
    const onTitle = vi.fn();
    const head = rh.createRunHeader({ admin: false, onAction: () => {}, onTitle });
    head.update(base(), {});
    head.update(base({ branch: "x" }), {});
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith("Do the thing");
    head.update(base({ issueTitle: "Fix login" }), {});
    expect(onTitle).toHaveBeenCalledTimes(2);
    expect(onTitle).toHaveBeenLastCalledWith("Fix login");
  });
  it("the user button is Stop this change…", () => {
    const head = rh.createRunHeader({ admin: false, onAction: () => {} });
    head.update(base(), {});
    expect(buttons(head).filter((t: string) => t !== "?")).toEqual(["Stop this change…"]);
  });
  it("techRows leaves out the reason of a failed run with a record", () => {
    const rows = rh.techRows(base({ status: "failed", reason: "step failed", next: { failure: {} } }), { admin: true });
    expect(rows.map((r: any) => r.key)).not.toContain("reason");
    expect(rh.techRows(base({ status: "stopped", reason: "why" }), {}).find((r: any) => r.key === "reason").text).toBe("why");
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
