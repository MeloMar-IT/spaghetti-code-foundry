import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinementError } from "../src/refinement/errors.js";
import { acceptAnyway, acceptedLines, acceptedView, checkReady, clearChanged, isReady, readinessView, removeAccepted, unsureByCode } from "../src/refinement/draft-ready.js";
import { newDraft, preview, saveTyped } from "../src/refinement/draft.js";
import { DEFAULT_READY } from "../src/refinement/ready-list.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { autoDialog } from "./helpers/confirm-dialog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let rd: any;
let talk: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  rd = await import("../ui/refinement-ready.js" as string);
  talk = await import("../ui/refinement-talk.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
let stopDialog: (() => void) | undefined;
const reload = vi.fn();
let state: { drafts: any[]; epic: number | undefined };
let over: any;
let sent: { method: string; url: string; body: any }[];
let mode: "ok" | number;
let modeFor: RegExp;
let confirms: number;
let confirmAnswer: boolean;
let cleanup: (() => void) | undefined;

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", runId: "r" };
const AT = "2026-03-01T10:20:00.000Z";
const LIST = DEFAULT_READY as any[];
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "drafting", architect: { state: "idle" }, brief: BRIEF, readyList: LIST,
  talk: { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] },
  drafts: state.drafts.map((d) => {
    const { readiness: _r, acceptedAnyway: _a, ...rest } = d;
    const rv = readinessView(d, LIST);
    const av = acceptedView(d, LIST);
    return { ...rest, state: isReady(d, LIST) ? "ready" : "drafting", preview: preview(d, state as any, acceptedLines(d, LIST)), ...(rv ? { readiness: rv } : {}), ...(av.length ? { acceptedAnyway: av } : {}) };
  }),
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }], created: "x", updated: "x", mine: true, ...over,
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  state = { drafts: [], epic: undefined };
  over = {};
  sent = [];
  mode = "ok";
  modeFor = /./;
  confirms = 0;
  confirmAnswer = true;
  dr.unsaved.clear();
  dr.opened.clear();
  reload.mockClear();
  (document as any).getElementById("toast").textContent = "";
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).activeElement = null;
  (globalThis as any).location = { hash: "#/refinement/s1", reload };
  stopDialog = autoDialog(() => {
    confirms++;
    return confirmAnswer;
  });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") return reply(view());
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (mode !== "ok" && modeFor.test(url)) return reply({ error: "The server said no" }, mode);
    try {
      const body = init.body ? JSON.parse(init.body) : {};
      const m = /\/drafts\/([^/]+)(?:\/(ready-check)|\/ready\/([^/]+)\/accept)?$/.exec(url);
      if (m?.[2] === "ready-check") {
        apply(checkReady(state as any, undefined, m[1]!, LIST, AT));
        const d = state.drafts.find((x) => x.id === m[1])!;
        if (unsureByCode(d).length) {
          if (!over.brief && "brief" in over) return reply({ error: "ask the architect to look at the code first" }, 409);
          over = { ...over, architect: { state: "running", kind: "ready", draft: m[1], doing: "x" } };
        }
      } else if (m?.[3] && init.method === "POST") apply(acceptAnyway(state as any, m[1]!, m[3], body, LIST, AT));
      else if (m?.[3]) apply(removeAccepted(state as any, m[1]!, m[3], LIST));
      else if (init.method === "PUT") {
        const before = state as any;
        const after = saveTyped(before, m![1]!, body);
        if (after) state = { drafts: clearChanged(before, after), epic: after.epic };
      } else apply(newDraft(state as any));
    } catch (e) {
      if (e instanceof RefinementError) return reply({ error: e.message }, 400);
      throw e;
    }
    return reply(view());
  };
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  stopDialog?.();
});

const apply = (c: any) => {
  if (c) state = { drafts: c.drafts, epic: c.epic };
};
const flush = () => vi.advanceTimersByTimeAsync(0);
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const section = () => walk(main()).find((e) => e.attrs.class === "drafts")!;
const box = () => walk(section()).find((e) => e.attrs["data-ready"] !== undefined)!;
const buttons = (root: FakeElement = section()) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root?: FakeElement) => buttons(root).find((e) => e.textContent === t);
const field = (name: string) => walk(section()).find((e) => e.attrs.name === name)!;
const dialog = () => walk((document as any).getElementById("modal-root") as FakeElement).find((e) => e.attrs.role === "dialog");
const inDialog = (t: string) => button(t, dialog());
const items = () => walk(box()).filter((e) => e.tag === "li");
const itemOf = (text: string) => items().find((e) => e.textContent.includes(text))!;
const press = async (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
  await flush();
};
const type = (el: FakeElement, v: string) => {
  el.value = v;
  el.fire("input");
};
const toastText = () => (document as any).getElementById("toast").textContent as string;
const withDraft = async (d: object = {}) => {
  state.drafts = [{ id: D1, criteria: [], dependsOn: [], ...d }];
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
  await press(button("Open"));
};
const show = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
};
const SAVE = () => (dr.SAVE_MS as number) + 10;
const run = (st: string, extra: object = {}) => ({ state: st, kind: "ready", draft: D1, doing: "x", reason: "Out of time", ...extra });
const item = (id: string, result: string, reason: string, by = "code") => ({ id, text: LIST.find((i) => i.id === id).text, result, reason, by });
const allMet = () => LIST.map((i) => item(i.id, "met", "ok"));
const checked = (rows: any[]) => ({ readiness: { at: AT, items: rows } });
const mark = (id: string, reason: string) => ({ id, text: LIST.find((i) => i.id === id).text, reason, at: AT });
const post = () => sent.filter((x) => x.url.endsWith("/ready-check"));
const XSS = "<img src=x onerror=1>";

describe("pure functions", () => {
  const d = { id: D1 };
  const s = (extra: object = {}) => ({ brief: BRIEF, architect: { state: "idle" }, readyList: LIST, ...extra });
  it("readyState", () => {
    expect(rd.readyState(s(), d)).toEqual({ kind: "button" });
    expect(rd.readyState(s({ brief: undefined }), d)).toEqual({ kind: "button" });
    expect(rd.readyState(s({ architect: run("queued") }), d)).toEqual({ kind: "line", again: "" });
    expect(rd.readyState(s({ architect: run("running") }), d)).toEqual({ kind: "line", again: "" });
    expect(rd.readyState(s({ architect: run("paused") }), d)).toEqual({ kind: "line", again: "Ask again" });
    expect(rd.readyState(s({ architect: run("failed") }), d)).toEqual({ kind: "line", again: "Try again" });
    expect(rd.readyState(s({ architect: run("running", { draft: D2 }) }), d)).toEqual({ kind: "none" });
    expect(rd.readyState(s({ architect: { state: "paused", kind: "review", draft: D1 } }), d)).toEqual({ kind: "none" });
    expect(rd.readyState(s({ architect: run("failed", { draft: D2 }) }), d)).toEqual({ kind: "button" });
  });
  it("readyRun", () => {
    expect(rd.readyRun(s({ architect: run("running") }), D1)).toBeTruthy();
    expect(rd.readyRun(s({ architect: run("running") }), D2)).toBeNull();
    expect(rd.readyRun(s({ architect: { state: "running", kind: "review", draft: D1 } }), D1)).toBeNull();
  });
  it("draftStateText", () => {
    expect(rd.draftStateText({ state: "ready" })).toBe("Ready");
    expect(rd.draftStateText({ state: "drafting" })).toBe("Drafting");
    expect(rd.draftStateText({ state: "split" })).toBe("Split");
    expect(rd.draftStateText({})).toBe("Drafting");
  });
  it("readyRows", () => {
    const rows = rd.readyRows(s(), { id: D1, ...checked([item("value", "not-met", "x"), item("small", "unsure", "y"), item("no-plan", "not-met", "z"), item("out-of-scope", "met", "m"), item("checkable", "unsure", "u")]), acceptedAnyway: [{ id: "checkable", text: "t", reason: "r" }] });
    expect(rows.map((r: any) => r.id)).toEqual(LIST.map((i) => i.id));
    const by = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    expect(by.standalone.result).toBe("none");
    expect(by["no-plan"].plan).toBe(true);
    expect(by.value.plan).toBe(false);
    expect(rows.filter((r: any) => r.canAccept).map((r: any) => r.id)).toEqual(["value", "small"]);
    expect(by.checkable.accepted).toBeDefined();
  });
  it("readyRows falls back to the items of the check", () => {
    const rows = rd.readyRows({}, { id: D1, ...checked([item("value", "met", "x")]) });
    expect(rows.map((r: any) => r.id)).toEqual(["value"]);
    expect(rd.readyRows({}, { id: D1 })).toEqual([]);
  });
  it("readyLogText", () => {
    const c = "1 met, 2 not met, 4 unsure";
    expect(rd.readyLogText({ what: "ready-checked", who: "Ann", detail: c })).toBe(`Ann checked a story draft against the Definition of Ready: ${c}`);
    expect(rd.readyLogText({ what: "ready-checked" })).toBe("Someone checked a story draft against the Definition of Ready");
    expect(rd.readyLogText({ what: "ready-checked", detail: "lots" })).toBe("Someone checked a story draft against the Definition of Ready");
    expect(rd.readyLogText({ what: "ready-asked", who: "Ann" })).toBe("Ann asked the architect to judge the readiness of a story draft");
    expect(rd.readyLogText({ what: "architect-judged", detail: c })).toBe(`The architect judged the readiness of a story draft: ${c}`);
    expect(rd.readyLogText({ what: "architect-judged" })).toBe("The architect judged the readiness of a story draft");
    expect(rd.readyLogText({ what: "ready-accepted", who: "Ann", detail: "it is small" })).toBe('Ann accepted an item anyway: "it is small"');
    expect(rd.readyLogText({ what: "ready-accepted", who: "Ann" })).toBe("Ann accepted an item anyway");
    expect(rd.readyLogText({ what: "ready-unaccepted", who: "Ann", detail: "it is small" })).toBe('Ann removed the reason of an item accepted anyway: "it is small"');
    expect(rd.readyLogText({ what: "ready-unaccepted", who: "Ann" })).toBe("Ann removed the reason of an item accepted anyway");
    expect(rd.readyLogText({ what: "created" })).toBe("");
  });
  it("the page tells the lines and the kind", () => {
    expect(ui.logText({ what: "ready-asked", who: "Ann" })).toBe("Ann asked the architect to judge the readiness of a story draft");
    expect(talk.kindOf({ kind: "ready" })).toBe("ready");
    expect(ui.architectStatus({ state: "queued", kind: "ready" }).detail).toBe("Then it judges what code could not decide.");
    expect(ui.architectStatus({ state: "running", kind: "ready" }).text).toBe("The architect is judging the readiness of your draft.");
    expect(ui.activityText("Check the form", "ready")).toBe("Checking the judgement.");
    const own = { mine: true, state: "drafting", repoAvailable: true, brief: BRIEF };
    expect(ui.askLabel({ ...own, architect: run("paused") })).toBe("");
    expect(ui.askLabel({ ...own, architect: run("failed") })).not.toBe("Try again");
  });
});

describe("api", () => {
  it("sends the right requests", async () => {
    await api.checkReady("a b", D1).catch(() => {});
    await api.acceptAnyway("a b", D1, "x/y", "why").catch(() => {});
    await api.removeAccepted("a b", D1, "x/y").catch(() => {});
    expect(sent.map((x) => [x.method, x.url])).toEqual([
      ["POST", `/api/refinement/a%20b/drafts/${D1}/ready-check`],
      ["POST", `/api/refinement/a%20b/drafts/${D1}/ready/x%2Fy/accept`],
      ["DELETE", `/api/refinement/a%20b/drafts/${D1}/ready/x%2Fy/accept`],
    ]);
  });
});

describe("the part on the page", () => {
  it("a new draft: every item not checked yet, Drafting, the button", async () => {
    await withDraft();
    expect(items().length).toBe(7);
    expect(items().every((e) => e.textContent.includes("Not checked yet"))).toBe(true);
    expect(box().textContent).toContain("Definition of Ready");
    expect(box().textContent).toContain("Drafting");
    expect(button("Check readiness", box())).toBeDefined();
    expect(items().map((e) => walk(e).filter((x) => x.tag === "b")[0]!.textContent)).toEqual(LIST.map((i) => i.text));
  });
  it("shows each result kind with its reason and who judged", async () => {
    await withDraft(checked([item("value", "met", "Both parts are there."), item("small", "not-met", "Too big."), item("checkable", "unsure", "Hard to say.", "architect")]));
    expect(itemOf("the value is clear").textContent).toContain("Met");
    expect(itemOf("the value is clear").textContent).toContain("Both parts are there.");
    expect(itemOf("the value is clear").textContent).toContain("checked by code");
    expect(itemOf("small enough").textContent).toContain("Not met");
    expect(itemOf("small enough").textContent).toContain("Too big.");
    expect(itemOf("every acceptance").textContent).toContain("Unsure");
    expect(itemOf("every acceptance").textContent).toContain("judged by the architect");
    expect(itemOf("out of scope").textContent).toContain("Not checked yet");
    expect(box().textContent).toContain("Checked ");
  });
});

describe("Check readiness", () => {
  it("saves typed text first, then asks; shows the line and no button", async () => {
    await withDraft({ title: { text: "T", from: "typed" } });
    type(field("notes"), "my notes");
    await press(button("Check readiness"));
    expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
    expect(post().length).toBe(1);
    expect(box().textContent).toContain("The architect is judging the readiness of your draft.");
    expect(button("Check readiness")).toBeUndefined();
    expect(main().textContent.split("The architect is judging the readiness").length).toBe(3); // the card and the hidden announcement for a screen reader; not in the Context brief part
  });
  it("asks nothing when the save fails", async () => {
    await withDraft({ title: { text: "T", from: "typed" } });
    type(field("notes"), "my notes");
    mode = 500;
    modeFor = /\/drafts\/[^/]+$/;
    await press(button("Check readiness"));
    expect(post().length).toBe(0);
    expect(toastText()).toContain("so the draft was not checked");
  });
  it("needs no brief when code decides every item", async () => {
    over = { brief: undefined };
    await withDraft();
    expect(button("Check readiness")).toBeDefined();
    await press(button("Check readiness"));
    expect(post().length).toBe(1);
  });
  it("without a brief and with unsure items: shows the saved code results and says a brief is needed", async () => {
    over = { brief: undefined };
    await withDraft({ title: { text: "T", from: "typed" } });
    await press(button("Check readiness"));
    expect(toastText()).toBe("ask the architect to look at the code first");
    expect(itemOf("it says what is out of scope").textContent).toContain("Not met");
    expect(box().textContent).toContain("Ask it to look at the code first");
    expect(button("Check readiness", box())).toBeDefined();
  });
  it("queued", async () => {
    over = { architect: run("queued") };
    await withDraft();
    expect(box().textContent).toContain("The architect is waiting for its turn.");
    expect(box().textContent).toContain("Then it judges what code could not decide.");
  });
  it("paused: Ask again", async () => {
    over = { architect: run("paused") };
    await withDraft();
    expect(box().textContent).toContain("Out of time.");
    await press(button("Ask again", box()));
    expect(post().length).toBe(1);
  });
  it("failed: Try again, and not in the Context brief part", async () => {
    over = { architect: run("failed") };
    await withDraft();
    expect(box().textContent).toContain("The architect could not finish.");
    expect(button("Try again", box())).toBeDefined();
    expect(buttons().filter((b) => b.textContent === "Try again").length).toBe(1);
  });
  it("a run for another draft: no button, no line", async () => {
    over = { architect: run("running", { draft: D2 }) };
    await withDraft();
    expect(button("Check readiness")).toBeUndefined();
    expect(box().textContent).not.toContain("judging");
  });
  it("a run for a closed draft shows at the top", async () => {
    over = { architect: run("paused") };
    state.drafts = [{ id: D1, title: { text: "Plain title", from: "typed" }, criteria: [], dependsOn: [] }];
    await show();
    expect(section().textContent).toContain("The architect paused.");
    expect(section().textContent).toContain('Open the draft "Plain title" to ask again.');
    await press(button("Open"));
    expect(box().textContent).toContain("The architect paused.");
    expect(section().textContent).not.toContain("Open the draft");
  });
  it("a run for a draft that is gone shows at the top", async () => {
    over = { architect: run("running", { draft: D2 }) };
    await withDraft();
    expect(section().textContent).toContain("judging the readiness");
  });
});

describe("Accept anyway", () => {
  const seeded = () => checked([item("value", "met", "ok"), item("small", "not-met", "Too big."), item("checkable", "unsure", "Hard to say."), item("no-plan", "not-met", "A plan.")]);
  it("is on not met and unsure items only", async () => {
    await withDraft(seeded());
    expect(button("Accept anyway", itemOf("small enough"))).toBeDefined();
    expect(button("Accept anyway", itemOf("every acceptance"))).toBeDefined();
    for (const t of ["the value is clear", "out of scope", "no implementation plan"]) expect(button("Accept anyway", itemOf(t)), t).toBeUndefined();
    expect(itemOf("no implementation plan").textContent).toContain(rd.PLAN_NOTE);
    expect(itemOf("small enough").textContent).not.toContain(rd.PLAN_NOTE);
  });
  it("an unsure plan item has no button either", async () => {
    await withDraft(checked([item("no-plan", "unsure", "Cannot tell.")]));
    expect(button("Accept anyway", itemOf("no implementation plan"))).toBeUndefined();
    expect(itemOf("no implementation plan").textContent).toContain(rd.PLAN_NOTE);
  });
  it("needs a reason", async () => {
    await withDraft(seeded());
    await press(button("Accept anyway", itemOf("small enough")));
    expect(dialog()).toBeDefined();
    await press(inDialog("Accept anyway"));
    expect(dialog()!.textContent).toContain("Give a reason.");
    expect(sent.length).toBe(0);
  });
  it("sends the reason, then shows it with Remove reason", async () => {
    await withDraft(seeded());
    await press(button("Accept anyway", itemOf("small enough")));
    type(walk(dialog()!).find((e) => e.tag === "textarea")!, "  It is small enough for us  ");
    await press(inDialog("Accept anyway"));
    expect(sent.map((x) => [x.method, x.url, x.body])).toEqual([["POST", `/api/refinement/s1/drafts/${D1}/ready/small/accept`, { reason: "It is small enough for us" }]]);
    expect(dialog()).toBeUndefined();
    expect(itemOf("small enough").textContent).toContain("Accepted anyway: It is small enough for us");
    expect(button("Remove reason", itemOf("small enough"))).toBeDefined();
    expect(button("Accept anyway", itemOf("small enough"))).toBeUndefined();
    expect(walk(section()).some((e) => e.tag === "h4" && e.textContent === "Accepted anyway")).toBe(true); // the preview shows the section
  });
  it("a refusal shows the toast and closes the dialog", async () => {
    await withDraft(seeded());
    await press(button("Accept anyway", itemOf("small enough")));
    type(walk(dialog()!).find((e) => e.tag === "textarea")!, "why");
    mode = 409;
    await press(inDialog("Accept anyway"));
    expect(toastText()).toBe("The server said no");
    expect(dialog()).toBeUndefined();
  });
  it("Remove reason asks first", async () => {
    await withDraft({ ...seeded(), acceptedAnyway: [mark("small", "Fine")] });
    confirmAnswer = false;
    await press(button("Remove reason", itemOf("small enough")));
    expect(confirms).toBe(1);
    expect(sent.length).toBe(0);
    confirmAnswer = true;
    await press(button("Remove reason", itemOf("small enough")));
    expect(sent.map((x) => [x.method, x.url])).toEqual([["DELETE", `/api/refinement/s1/drafts/${D1}/ready/small/accept`]]);
    expect(itemOf("small enough").textContent).not.toContain("Accepted anyway");
    expect(button("Accept anyway", itemOf("small enough"))).toBeDefined();
  });
  it("shows that the reason was not needed", async () => {
    await withDraft({ ...checked(allMet()), acceptedAnyway: [mark("small", "Fine")] });
    expect(itemOf("small enough").textContent).toContain("Accepted anyway (not needed: the item is met): Fine");
  });
});

describe("Ready and Drafting", () => {
  const readyDraft = () => ({ ...checked(LIST.map((i) => (i.id === "small" ? item(i.id, "not-met", "Too big.") : item(i.id, "met", "ok")))), acceptedAnyway: [mark("small", "Fine")], title: { text: "T", from: "typed" } });
  it("is Ready when every item is met or accepted; the list row and the toolbar say so", async () => {
    over = { state: "ready" };
    await withDraft(readyDraft());
    const pills = () => walk(section()).filter((e) => e.attrs.class === "pill state-ready").map((e) => e.textContent);
    expect(pills()).toEqual(["Ready", "Ready"]);
    expect(walk(main()).filter((e) => e.attrs.class === "pill state-ready").map((e) => e.textContent)).toEqual(["Ready", "Ready", "Ready"]);
  });
  it("falls back to Drafting after an edit; the accepted reason stays", async () => {
    await withDraft(readyDraft());
    expect(box().textContent).toContain("Ready");
    type(field("notes"), "something new");
    await wait(SAVE());
    expect(box().textContent).toContain("Drafting");
    expect(items().every((e) => e.textContent.includes("Not checked yet"))).toBe(true);
    expect(itemOf("small enough").textContent).toContain("Accepted anyway: Fine");
    expect(walk(section()).filter((e) => e.attrs.class === "pill state-drafting").length).toBe(2);
  });
  it("tells a list that changed", async () => {
    await withDraft({ readiness: { at: AT, items: [item("value", "met", "ok")], stale: true } });
    expect(box().textContent).toContain(rd.LIST_CHANGED);
  });
});

describe("who sees what", () => {
  const seeded = () => ({ ...checked([item("small", "not-met", "REASON-TEXT"), item("value", "met", "m", "architect")]), acceptedAnyway: [mark("small", "ACCEPT-TEXT")], title: { text: "T", from: "typed" } });
  const none = () => {
    const text = section().textContent;
    expect(text).toContain("REASON-TEXT");
    expect(text).toContain("ACCEPT-TEXT");
    expect(text).toContain("judged by the architect");
    for (const t of ["Check readiness", "Accept anyway", "Remove reason", "Ask again", "Try again"]) expect(button(t), t).toBeUndefined();
  };
  const readOnly = async (extra: object) => {
    over = extra;
    state.drafts = [{ id: D1, criteria: [], dependsOn: [], ...seeded() }];
    await show();
    none();
  };
  it("a dropped session", () => readOnly({ state: "dropped" }));
  it("another person's session", () => readOnly({ mine: false }));
  it("a draft with no check and no marks shows no ready card", async () => {
    over = { mine: false };
    state.drafts = [{ id: D1, criteria: [], dependsOn: [] }];
    await show();
    expect(section().textContent).not.toContain("Definition of Ready");
  });
  it("the owner sees the buttons", async () => {
    await withDraft(seeded());
    expect(button("Check readiness")).toBeDefined();
    expect(button("Remove reason")).toBeDefined();
  });
});

describe("text safety", () => {
  it("sets item texts and reasons as text", async () => {
    const list = [{ id: "x", text: XSS }];
    over = { readyList: list };
    await withDraft({ readiness: { at: AT, items: [{ id: "x", text: XSS, result: "not-met", reason: XSS, by: "architect" }] }, acceptedAnyway: [{ id: "x", text: XSS, reason: XSS, at: AT }] });
    expect(box().textContent).toContain(XSS);
    expect(walk(section()).some((e) => e.tag === "img")).toBe(false);
  });
});
