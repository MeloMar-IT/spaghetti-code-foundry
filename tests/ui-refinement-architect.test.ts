import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let runs: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  runs = await import("../ui/runs.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
let page: any;
let gets: string[];
let sent: { method: string; url: string; body: any }[];
let getMode: "ok" | "hold" | "throw" | number;
let getHold: ((v: any) => void) | undefined;
let postAnswer: any;
let postMode: "ok" | "hold" | "throw" | number;
let postHold: (() => void) | undefined;

const BRIEF_TEXT = ["## What the code does", "It does things.", "## Where it would change", "In src/a.ts\n  indented", "## Risks", "Some.", "## Open questions", "Few.", "## Backlog", "Nothing."].join("\n");
const BRIEF = { text: BRIEF_TEXT, at: "2026-03-01T10:20:00.000Z", branch: "develop", runId: "run-old" };
const session = (over: object = {}) => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "exploring", drafts: [],
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }], created: "x", updated: "x", mine: true, ...over,
});
const running = { state: "running", runId: "run-x", doing: "Clone the repository into repo/ and check out develop (or the default branch)" };

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
beforeEach(() => {
  vi.useFakeTimers();
  page = session();
  gets = [];
  sent = [];
  getMode = "ok";
  getHold = undefined;
  postMode = "ok";
  postHold = undefined;
  postAnswer = session({ architect: { state: "queued", runId: "run-x" } });
  (globalThis as any).location = { hash: "#/refinement/s1" };
  (document as any).getElementById("toast").textContent = "";
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets.push(url);
      if (getMode === "throw") throw new TypeError("fetch failed");
      if (typeof getMode === "number") return reply({ error: "nope" }, getMode);
      if (getMode === "hold") await new Promise<void>((r) => (getHold = r));
      return reply(page);
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (postMode === "hold") await new Promise<void>((r) => (postHold = r));
    if (postMode === "throw") throw new TypeError("fetch failed");
    if (typeof postMode === "number") return reply({ error: "The architect is already at work." }, postMode);
    return reply(postAnswer, 202);
  };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const main = () => (document as any).getElementById("main") as FakeElement;
/** The part of the page above the drafts: the part a poll must not draw again when nothing changed. */
const upper = () => main().children[0] as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
/** True for an element inside a part of the talk (ui/refinement-talk.js). */
const inTalk = (el: FakeElement): boolean => {
  for (let p = el.parent; p; p = p.parent) if (p.attrs.class === "talk") return true;
  return false;
};
const button = (text: string) => walk(main()).find((e) => e.tag === "button" && e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const ASK_LABEL = "Ask the architect to look at the code";
const LABELS = [ASK_LABEL, "Refresh", "Try again", "Ask again"];
const askButtons = () => walk(main()).filter((e) => e.tag === "button" && LABELS.includes(e.textContent));
const toastText = () => (document as any).getElementById("toast").textContent as string;
const text = () => main().textContent;
let cleanup: () => void;
const show = async (admin = false) => {
  cleanup = await ui.renderRefinement(main(), { admin, id: "s1" });
};

describe("pure functions", () => {
  it("logText says the architect's entries in words", () => {
    expect(ui.logText({ what: "architect-started", who: "Ann" })).toBe("Ann asked the architect to look at the code");
    expect(ui.logText({ what: "architect-resumed", who: "Ann" })).toBe("Ann asked the architect to carry on");
    expect(ui.logText({ what: "architect-brief", detail: "run-old" })).toBe("The architect wrote the context brief");
    expect(ui.logText({ what: "architect-failed", detail: "It broke" })).toBe("The architect could not finish: It broke");
    expect(ui.logText({ what: "architect-failed" })).toBe("The architect could not finish");
  });
  it("architectStatus", () => {
    for (const a of [undefined, { state: "idle" }, { state: "weird" }]) expect(ui.architectStatus(a)).toMatchObject({ busy: false, text: "" });
    expect(ui.architectStatus({ state: "queued" })).toMatchObject({ busy: true, text: "The architect is waiting for its turn." });
    expect(ui.architectStatus({ state: "running", doing: "Reading the open issues." })).toMatchObject({ busy: true, detail: "Reading the open issues." });
    expect(ui.architectStatus({ state: "paused", reason: "The usage limit is reached; ask again later" })).toMatchObject({ busy: false, text: "The architect paused.", detail: "The usage limit is reached; ask again later." });
    expect(ui.architectStatus({ state: "failed", reason: "It broke." })).toMatchObject({ bad: true, detail: "It broke." });
  });
  it("architectStatus for a suggestion", () => {
    expect(ui.architectStatus({ state: "queued", kind: "suggest" })).toMatchObject({ busy: true, text: "The architect is waiting for its turn.", detail: "Then it writes a suggestion." });
    expect(ui.architectStatus({ state: "running", kind: "suggest", doing: "Check the form of the architect's answer and pass it on" }))
      .toMatchObject({ busy: true, text: "The architect is writing a suggestion.", detail: "Checking the suggestion." });
    expect(ui.activityText("Check the form of the architect's answer and pass it on", "suggest")).toBe("Checking the suggestion.");
    expect(ui.activityText("Check the form of the architect's answer and pass it on", "question")).toBe("Checking the answer.");
  });
  it("askLabel for a suggestion", () => {
    expect(ui.askLabel(session({ brief: BRIEF, architect: { state: "paused", kind: "suggest", reason: "x" } }))).toBe("");
    expect(ui.askLabel(session({ brief: BRIEF, architect: { state: "failed", kind: "suggest", reason: "x" } }))).toBe("Refresh");
    expect(ui.askLabel(session({ architect: { state: "failed", kind: "suggest", reason: "x" } }))).toBe(ASK_LABEL);
  });
  it("architectStatus and askLabel for a review", () => {
    expect(ui.architectStatus({ state: "queued", kind: "review" })).toMatchObject({ busy: true, text: "The architect is waiting for its turn.", detail: "Then it reviews your draft." });
    expect(ui.architectStatus({ state: "running", kind: "review", doing: "Check the form of the architect's answer and pass it on" }))
      .toMatchObject({ busy: true, text: "The architect is reviewing your draft.", detail: "Checking the review." });
    expect(ui.activityText("Check the form of the architect's answer and pass it on", "review")).toBe("Checking the review.");
    expect(ui.askLabel(session({ brief: BRIEF, architect: { state: "paused", kind: "review", reason: "x" } }))).toBe("");
    expect(ui.askLabel(session({ brief: BRIEF, architect: { state: "failed", kind: "review", reason: "x" } }))).toBe("Refresh");
  });
  it("architectStatus and askLabel for an impact run", () => {
    expect(ui.architectStatus({ state: "queued", kind: "impact" })).toMatchObject({ busy: true, detail: "Then it looks at what your draft touches." });
    expect(ui.architectStatus({ state: "running", kind: "impact", doing: "Check the form of the architect's answer and pass it on" }))
      .toMatchObject({ busy: true, text: "The architect is looking at what your draft touches.", detail: "Checking the view." });
    expect(ui.activityText("Only for ask=impact: read the newest 50 open issues", "impact")).toBe("Reading the open issues.");
    expect(ui.askLabel(session({ brief: BRIEF, architect: { state: "paused", kind: "impact", reason: "x" } }))).toBe("");
    expect(ui.askLabel(session({ brief: BRIEF, architect: { state: "failed", kind: "impact", reason: "x" } }))).toBe("Refresh");
  });
  it("the brief part draws no line for a review run", async () => {
    page = session({ brief: BRIEF, architect: { state: "running", kind: "review", draft: "d", doing: "x" } });
    await show();
    const upperPart = main().children[0] as FakeElement;
    expect(walk(upperPart).some((e) => e.attrs.class === "spinner")).toBe(false);
    expect(upperPart.textContent).not.toContain("reviewing your draft");
  });
  it("the brief part draws no line for a suggestion run", async () => {
    page = session({ brief: BRIEF, architect: { state: "running", kind: "suggest", draft: "d", field: "title", doing: "x" } });
    await show();
    // the line of a suggestion run is on the draft page (here: at the top of Story drafts, as its draft is not there)
    const upperPart = main().children[0] as FakeElement;
    expect(walk(upperPart).some((e) => e.attrs.class === "spinner")).toBe(false);
    expect(upperPart.textContent).not.toContain("writing a suggestion");
  });
  it("activityText never shows a folder or file name of the run", () => {
    for (const d of [running.doing, "Read the open issues with their comments into issues.md", "The architect reads the code and the issues and writes the context brief", "Check that the brief says so when the backlog was larger than what was read; pass the brief on", "Copy into out/x.json"]) {
      const t = ui.activityText(d);
      expect(t).not.toMatch(/repo\/|issues\.md|\.json|out\//);
      expect(t.length).toBeGreaterThan(0);
    }
    expect(ui.activityText(undefined)).toBe("");
  });
  it("askLabel", () => {
    expect(ui.askLabel(session())).toBe(ASK_LABEL);
    expect(ui.askLabel(session({ brief: BRIEF }))).toBe("Refresh");
    expect(ui.askLabel(session({ architect: { state: "failed", reason: "x" } }))).toBe("Try again");
    expect(ui.askLabel(session({ architect: { state: "paused", reason: "x" } }))).toBe("Ask again");
    for (const over of [{ architect: { state: "queued" } }, { architect: running }, { mine: false }, { state: "dropped" }, { repoAvailable: false }]) expect(ui.askLabel(session(over))).toBe("");
  });
  it("briefParts", () => {
    expect(ui.briefParts(BRIEF_TEXT).map((p: any) => p.title)).toEqual(["What the code does", "Where it would change", "Risks", "Open questions", "Backlog"]);
    expect(ui.briefParts("## A\n### B\nx")).toEqual([{ title: "A", body: "### B\nx" }]);
    expect(ui.briefParts("lead\n## A\nx")).toEqual([{ title: "", body: "lead" }, { title: "A", body: "x" }]);
    expect(ui.briefParts("just text")).toEqual([{ title: "", body: "just text" }]);
    expect(ui.briefParts("")).toEqual([]);
    expect(ui.briefParts("## A\r\nx\r\n## B\r\ny")).toEqual([{ title: "A", body: "x" }, { title: "B", body: "y" }]);
  });
});

describe("the button", () => {
  it("asks once and draws from the answer without a GET", async () => {
    await show();
    expect(walk(main()).find((e) => e.tag === "h2" && e.textContent === "Context brief")).toBeDefined();
    expect(text()).toContain("No context brief yet.");
    gets = [];
    press(button(ASK_LABEL));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/architect", body: {} }]);
    expect(gets).toEqual([]);
    expect(text()).toContain("waiting for its turn");
    expect(askButtons()).toEqual([]);
  });
  it.each([
    ["dropped", { state: "dropped" }, false],
    ["not mine", { mine: false }, true],
    ["repo gone", { repoAvailable: false }, false],
  ])("is not shown for %s", async (_n, over, admin) => {
    for (const extra of [{}, { brief: BRIEF }, { architect: { state: "failed", reason: "x" } }]) {
      page = session({ ...over, ...extra });
      await show(admin as boolean);
      expect(askButtons()).toEqual([]);
    }
  });
  it("sends one request for two clicks", async () => {
    await show();
    postMode = "hold";
    const b = button(ASK_LABEL);
    press(b);
    press(b);
    await flush();
    expect(sent.length).toBe(1);
    postHold!();
    await flush();
  });
  it("shows the server's sentence on 409 and reloads once; a network error says so", async () => {
    await show();
    postMode = 409;
    gets = [];
    press(button(ASK_LABEL));
    await flush();
    expect(toastText()).toBe("The architect is already at work.");
    expect(gets.length).toBe(1);
    postMode = "throw";
    press(button(ASK_LABEL));
    await flush();
    expect(toastText()).toBe("Could not reach the server.");
  });
});

describe("busy", () => {
  it("polls while busy, one at a time, and stops when the run ends", async () => {
    page = session({ architect: { state: "queued", runId: "run-x" } });
    await show();
    expect(text()).toContain("waiting for its turn");
    expect(walk(main()).some((e) => e.attrs.class === "spinner")).toBe(true);
    expect(askButtons()).toEqual([]);
    gets = [];
    await vi.advanceTimersByTimeAsync(ui.POLL_MS - 1);
    expect(gets).toEqual([]);
    page = session({ architect: running });
    await vi.advanceTimersByTimeAsync(1);
    expect(gets.length).toBe(1);
    expect(text()).toContain("The architect is at work.");
    expect(text()).toContain("Getting the code.");
    expect(text()).not.toMatch(/repo\/|issues\.md/);
    page = session({ brief: BRIEF });
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(text()).toContain("It does things.");
    expect(button("Refresh")).toBeDefined();
    gets = [];
    await vi.advanceTimersByTimeAsync(3 * ui.POLL_MS);
    expect(gets).toEqual([]);
  });
  it("asks one at a time", async () => {
    page = session({ architect: running });
    await show();
    gets = [];
    getMode = "hold";
    await vi.advanceTimersByTimeAsync(4 * ui.POLL_MS);
    expect(gets.length).toBe(1);
    getHold!(1);
    getMode = "ok";
    await flush();
  });
  it("does not redraw an equal answer", async () => {
    page = session({ architect: running });
    await show();
    const before = upper().children;
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(upper().children).toBe(before);
  });
  it("stops with the cleanup; a held answer is not drawn and starts no timer", async () => {
    page = session({ architect: running });
    await show();
    getMode = "hold";
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    const before = upper().children;
    page = session({ architect: running, title: "Changed" });
    cleanup();
    getHold!(1);
    getMode = "ok";
    await flush();
    expect(upper().children).toBe(before);
    gets = [];
    await vi.advanceTimersByTimeAsync(3 * ui.POLL_MS);
    expect(gets).toEqual([]);
  });
  it("a tick after leaving the page sends nothing", async () => {
    page = session({ architect: running });
    await show();
    gets = [];
    (globalThis as any).location.hash = "#/runs";
    await vi.advanceTimersByTimeAsync(3 * ui.POLL_MS);
    expect(gets).toEqual([]);
  });
  it("the cleanup of the first render also stops the poll of an in-page reload", async () => {
    await show(); // first render, idle: its cleanup is the one the router keeps
    const first = cleanup;
    postMode = 409; // the ask fails; the page reloads itself, and the reload finds the architect running
    page = session({ architect: running });
    press(button(ASK_LABEL));
    await flush();
    expect(text()).toContain("The architect is at work.");
    gets = [];
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(gets.length).toBe(1); // the replacement render polls
    getMode = "hold";
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    const before = upper().children;
    first();
    page = session({ architect: running, title: "Changed" });
    getHold!(1);
    getMode = "ok";
    await flush();
    expect(upper().children).toBe(before);
    gets = [];
    await vi.advanceTimersByTimeAsync(3 * ui.POLL_MS);
    expect(gets).toEqual([]);
  });
  it("keeps the page on a 500 or a throw and stops on a 404", async () => {
    page = session({ architect: running });
    await show();
    for (const mode of [500, "throw"] as const) {
      getMode = mode;
      gets = [];
      await vi.advanceTimersByTimeAsync(ui.POLL_MS);
      expect(gets.length).toBe(1);
      expect(text()).toContain("The architect is at work.");
      expect(toastText()).toBe("");
    }
    getMode = 404;
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(text()).toContain("← All sessions");
    expect(text()).toContain("nope");
    gets = [];
    await vi.advanceTimersByTimeAsync(3 * ui.POLL_MS);
    expect(gets).toEqual([]);
  });
  it("an admin sees the status of someone else's run, with no button", async () => {
    page = session({ mine: false, ownerName: "Bob", architect: running });
    await show(true);
    expect(text()).toContain("The architect is at work.");
    expect(askButtons()).toEqual([]);
    gets = [];
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(gets.length).toBe(1);
  });
});

describe("paused and failed", () => {
  it.each(["The usage limit is reached; ask again later", "The architect is signed out; ask again later", "The daily budget is used up; ask again later"])("shows %s", async (reason) => {
    page = session({ architect: { state: "paused", reason } });
    await show();
    expect(text()).toContain(`The architect paused. ${reason}.`);
    gets = [];
    await vi.advanceTimersByTimeAsync(3 * ui.POLL_MS);
    expect(gets).toEqual([]);
    press(button("Ask again"));
    await flush();
    expect(sent.length).toBe(1);
  });
  it("shows a failure with Try again", async () => {
    page = session({ architect: { state: "failed", reason: "The brief did not have its five parts." } });
    await show();
    const bad = walk(main()).filter((e) => e.attrs.class === "status bad").map((e) => e.textContent);
    expect(bad).toContain("The architect could not finish. The brief did not have its five parts.");
    press(button("Try again"));
    await flush();
    expect(sent.length).toBe(1);
    expect(text()).toContain("waiting for its turn");
  });
  it("keeps the old brief with a failure", async () => {
    page = session({ brief: BRIEF, architect: { state: "failed", reason: "It broke" } });
    await show();
    expect(text()).toContain("It broke.");
    expect(text()).toContain("It does things.");
    expect(button("Try again")).toBeDefined();
  });
});

describe("the brief", () => {
  it("shows five parts as text with date and branch", async () => {
    page = session({ brief: BRIEF });
    await show();
    expect(walk(main()).filter((e) => e.tag === "h3" && !inTalk(e)).map((e) => e.textContent)).toEqual(["What the code does", "Where it would change", "Risks", "Open questions", "Backlog"]);
    const bodies = walk(main()).filter((e) => e.tag === "p" && e.style?.whiteSpace === "pre-wrap" && e.textContent !== "An idea");
    expect(bodies.length).toBe(5);
    expect(text()).toContain(new Date(BRIEF.at).toLocaleString());
    expect(text()).toContain("branch develop");
    expect(text()).not.toContain("run-old");
    page = session({ brief: { ...BRIEF, branch: undefined } });
    await show();
    expect(text()).not.toContain("branch");
    page = session({ brief: { ...BRIEF, cut: true } });
    await show();
    expect(text()).toContain("the end is missing");
  });
  it("shows markup literally", async () => {
    page = session({ brief: { ...BRIEF, text: "## A\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>" } });
    await show();
    expect(text()).toContain("<img src=x onerror=alert(1)>");
    expect(text()).toContain("<script>alert(2)</script>");
    expect(walk(main()).some((e) => e.tag === "img" || e.tag === "script")).toBe(false);
  });
  it("Refresh keeps the old brief until the new one is done", async () => {
    page = session({ brief: BRIEF });
    await show();
    postAnswer = session({ brief: BRIEF, architect: running });
    press(button("Refresh"));
    await flush();
    expect(text()).toContain("The architect is at work.");
    expect(text()).toContain("It does things.");
    expect(text()).toContain("Made");
    expect(button("Refresh")).toBeUndefined();
    page = session({ brief: { ...BRIEF, text: "## New\nFresh text", at: "2026-04-01T10:00:00.000Z" } });
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(text()).toContain("Fresh text");
    expect(text()).not.toContain("It does things.");
    expect(button("Refresh")).toBeDefined();
  });
  it("says so when the brief is hidden", async () => {
    page = session({ repoAvailable: false, briefHidden: true });
    await show();
    expect(text()).toContain("The brief is not shown while the repository is not in My repositories.");
    expect(walk(main()).some((e) => e.tag === "h3" && !inTalk(e))).toBe(false);
    expect(askButtons()).toEqual([]);
  });
  it("shows no run id, cost, model or folder", async () => {
    page = session({ brief: BRIEF, architect: { ...running, costUsd: 1.23, model: "opus-x" } });
    await show();
    expect(text()).not.toMatch(/run-old|run-x|\$1|opus-x|repo\/|issues\.md/);
  });
  it("shows the architect's entries in the log", async () => {
    const at = new Date().toISOString();
    page = session({ log: [{ at, what: "architect-started", who: "Ann" }, { at, what: "architect-resumed", who: "Ann" }, { at, what: "architect-brief" }, { at, what: "architect-failed", detail: "Oops" }] });
    await show();
    for (const t of ["Ann asked the architect to look at the code", "Ann asked the architect to carry on", "The architect wrote the context brief", "The architect could not finish: Oops"]) expect(text()).toContain(t);
  });
});

describe("the Runs list", () => {
  const run = (over: object = {}) => ({ runId: "r1", flow: "refine-brief", task: "t", history: [], startedAt: new Date().toISOString(), ...over });
  const link = (el: FakeElement) => walk(el).find((e) => e.tag === "a" && e.textContent === "refinement");
  it("marks an architect run and links to its session", () => {
    for (const opts of [{}, { cost: false }]) {
      const row = runs.runRow(run({ refinement: "s 1" }), opts);
      const a = link(row)!;
      expect(a.attrs.class).toBe("pill refinement");
      expect(a.attrs.href).toBe("#/refinement/s%201");
      (globalThis as any).location = { hash: "#/runs" };
      a.click();
      expect((globalThis as any).location.hash).toBe("#/runs");
      row.click();
      expect((globalThis as any).location.hash).toBe("#/runs/r1");
    }
    expect(link(runs.runRow(run()))).toBeUndefined();
  });
  it("marks a queued read", () => {
    const row = runs.queueRow({ runId: "r1", kind: "run", refinement: "s1" }, () => {});
    expect(link(row)!.attrs.href).toBe("#/refinement/s1");
    expect(link(runs.queueRow({ runId: "r1", kind: "run" }, () => {}))).toBeUndefined();
  });
  it("is wired: style rule and API call", async () => {
    expect(readUiCss()).toContain(".pill.refinement");
    await api.askArchitect("a b");
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/a%20b/architect", body: {} }]);
  });
});
