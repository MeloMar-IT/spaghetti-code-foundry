import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinementError } from "../src/refinement/errors.js";
import { acceptSuggestion, rejectSuggestion, newDraft, preview, saveTyped } from "../src/refinement/draft.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { autoDialog } from "./helpers/confirm-dialog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let sg: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  sg = await import("../ui/refinement-suggest.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
let stopDialog: (() => void) | undefined;
const reload = vi.fn();
let state: { drafts: any[]; epic: number | undefined };
let over: any;
let sent: { method: string; url: string; body: any }[];
let gets: number;
let mode: "ok" | number; // the answer to a change
let modeFor: RegExp; // which changes `mode` is for
let confirms: number;
let confirmAnswer: boolean;
let cleanup: (() => void) | undefined;

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const S1 = "aaaaaaa1-0000-4000-8000-000000000000";
const S2 = "aaaaaaa2-0000-4000-8000-000000000000";
const E1 = "eeeeeee1-0000-4000-8000-000000000000";
const E2 = "eeeeeee2-0000-4000-8000-000000000000";
const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", runId: "r" };
const MAP = { rules: [{ id: E1, text: "Old rule", at: "x" }], examples: [{ id: E2, text: "An example", at: "x" }], open: [] };
const talk = (map: object = MAP) => ({ rounds: [], proposals: [], map, asked: [] });
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "drafting", architect: { state: "idle" }, brief: BRIEF, talk: talk(),
  drafts: state.drafts.map((d) => ({ ...d, preview: preview(d, state) })), ...(state.epic !== undefined ? { epic: state.epic } : {}),
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }], created: "x", updated: "x", mine: true, ...over,
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  state = { drafts: [], epic: undefined };
  over = {};
  sent = [];
  gets = 0;
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
    if (init.method === "GET") {
      gets++;
      return reply(view());
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (mode !== "ok" && modeFor.test(url)) {
      if (mode === 401) return reply({ error: "sign in first" }, 401);
      return reply({ error: "The server said no" }, mode);
    }
    try {
      const body = init.body ? JSON.parse(init.body) : {};
      const m = /\/drafts\/([^/]+)(?:\/(suggest|suggestions\/([^/]+)\/(accept|reject)))?$/.exec(url);
      if (m?.[2] === "suggest") over = { ...over, architect: { state: "running", kind: "suggest", draft: m[1], field: body.field, doing: "x" } };
      else if (m?.[4] === "accept") apply(acceptSuggestion(state, m[1]!, m[3]!, body));
      else if (m?.[4] === "reject") apply(rejectSuggestion(state, m[1]!, m[3]!, body));
      else if (init.method === "PUT") apply(saveTyped(state, m![1]!, body));
      else apply(newDraft(state));
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
const upper = () => main().children[0] as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const section = () => walk(main()).find((e) => e.attrs.class === "drafts")!;
const box = (f: string) => walk(section()).find((e) => e.attrs["data-suggest"] === f)!;
const mark = (f: string) => walk(section()).find((e) => e.attrs["data-mark"] === f)!.textContent;
const buttons = (root: FakeElement = section()) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root?: FakeElement) => buttons(root).find((e) => e.textContent === t);
const byFocus = (name: string) => walk(section()).find((e) => e.attrs["data-focus"] === name);
const field = (name: string) => walk(section()).find((e) => e.attrs.name === name)!;
const critRows = () => walk(section()).filter((e) => e.tag === "li" && e.children.some((c) => c instanceof FakeElement && c.tag === "textarea"));
const dialog = () => walk((document as any).getElementById("modal-root") as FakeElement).find((e) => e.attrs.role === "dialog");
const inDialog = (t: string) => button(t, dialog());
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
const suggestButtons = () => buttons().filter((b) => b.textContent === "Suggest");
const sug = (id: string, f: string, extra: object = { text: "Suggested text" }) => ({ id, field: f, ...extra });
const crit = (n: number, text: string, from = "typed") => ({ id: `c000000${n}-0000-4000-8000-000000000000`, text, from });
const withDraft = async (d: object = {}) => {
  state.drafts = [{ id: D1, criteria: [], dependsOn: [], ...d }];
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
  await press(button("Open"));
};
const show = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
};

describe("pure functions", () => {
  it("fromText", () => {
    expect(sg.fromText("typed")).toBe("typed");
    expect(sg.fromText("accepted")).toBe("accepted");
    expect(sg.fromText("accepted-edited")).toBe("accepted, then edited");
    expect(sg.fromText(undefined)).toBe("");
    expect(sg.fromText("other")).toBe("");
  });
  it("shownFrom follows the visible text", () => {
    expect(sg.shownFrom(undefined, "")).toBe("");
    expect(sg.shownFrom(undefined, "new")).toBe("typed");
    expect(sg.shownFrom({ text: "a", from: "accepted" }, "a")).toBe("accepted");
    expect(sg.shownFrom({ text: "a", from: "accepted" }, "ab")).toBe("accepted-edited");
    expect(sg.shownFrom({ text: "a", from: "typed" }, "ab")).toBe("typed");
    expect(sg.shownFrom({ text: "a", from: "accepted" }, "  ")).toBe("");
  });
  it("suggestState", () => {
    const d = { id: D1 };
    const s = (over: object = {}) => ({ brief: BRIEF, talk: talk(), architect: { state: "idle" }, ...over });
    const run = (state: string, f = "title", draft = D1) => ({ architect: { state, kind: "suggest", draft, field: f, reason: "r" } });
    expect(sg.suggestState(s(), d, "title")).toEqual({ kind: "button" });
    expect(sg.suggestState(s({ brief: undefined }), d, "title")).toEqual({ kind: "none" });
    expect(sg.suggestState(s({ talk: talk({ rules: [], examples: [], open: [] }) }), d, "criteria")).toEqual({ kind: "hint", text: sg.NO_MAP });
    expect(sg.suggestState(s({ talk: undefined }), d, "criteria").kind).toBe("hint");
    expect(sg.suggestState(s({ talk: talk({ rules: [], examples: [{ id: E2, text: "x" }], open: [] }) }), d, "criteria").kind).toBe("button");
    expect(sg.suggestState(s(run("running")), d, "title")).toEqual({ kind: "line", again: "" });
    expect(sg.suggestState(s(run("queued")), d, "title")).toEqual({ kind: "line", again: "" });
    expect(sg.suggestState(s(run("paused")), d, "title")).toEqual({ kind: "line", again: "Ask again" });
    expect(sg.suggestState(s(run("failed")), d, "title")).toEqual({ kind: "line", again: "Try again" });
    expect(sg.suggestState(s(run("running")), d, "who")).toEqual({ kind: "none" });
    expect(sg.suggestState(s(run("failed", "who")), d, "title")).toEqual({ kind: "button" });
    expect(sg.suggestState(s({ architect: { state: "paused", kind: "round" } }), d, "title")).toEqual({ kind: "none" });
    expect(sg.suggestState(s(run("running", "title", D2)), d, "title")).toEqual({ kind: "none" });
  });
  it("tieOf", () => {
    const s = { talk: talk() };
    expect(sg.tieOf(s, { tie: E1 })).toEqual({ kind: "rule", text: "Old rule" });
    expect(sg.tieOf(s, { tie: E2 })).toEqual({ kind: "example", text: "An example" });
    expect(sg.tieOf(s, { tie: "nope" })).toBeNull();
    expect(sg.tieOf(s, {})).toBeNull();
  });
  it("suggestLogText", () => {
    expect(sg.suggestLogText({ what: "suggestion-asked", who: "Ann", detail: "title" })).toBe("Ann asked the architect for a suggestion for the title");
    expect(sg.suggestLogText({ what: "architect-suggested", detail: "criteria" })).toBe("The architect made a suggestion for the acceptance criteria");
    expect(sg.suggestLogText({ what: "suggestion-accepted", who: "Ann", detail: "who" })).toBe("Ann accepted a suggestion for “As …”");
    expect(sg.suggestLogText({ what: "suggestion-rejected", who: "Ann" })).toBe("Ann rejected a suggestion");
    expect(sg.suggestLogText({ what: "created" })).toBe("");
  });
  it("boxKey changes with what the box shows", () => {
    const s = { brief: BRIEF, talk: talk(), architect: { state: "idle" } };
    const d = { id: D1, suggestions: [sug(S1, "title")] };
    const k = sg.boxKey(s, d, "title");
    expect(sg.boxKey(s, { ...d, suggestions: [] }, "title")).not.toBe(k);
    expect(sg.boxKey({ ...s, brief: undefined }, d, "title")).not.toBe(k);
    expect(sg.boxKey(s, d, "title")).toBe(k);
  });
});

describe("api", () => {
  it("sends the right requests", async () => {
    await api.suggestField("a b", D1, "who").catch(() => {}); // the fake server knows no such draft
    await api.acceptSuggestion("a b", D1, "x y", { text: "T" }).catch(() => {});
    await api.rejectSuggestion("a b", D1, "x y").catch(() => {});
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ["POST", `/api/refinement/a%20b/drafts/${D1}/suggest`, { field: "who" }],
      ["POST", `/api/refinement/a%20b/drafts/${D1}/suggestions/x%20y/accept`, { text: "T" }],
      ["POST", `/api/refinement/a%20b/drafts/${D1}/suggestions/x%20y/reject`, {}],
    ]);
  });
  it("a 401 does not reload the page", async () => {
    mode = 401;
    await expect(api.suggestField("s1", D1, "who")).rejects.toMatchObject({ status: 401 });
    await expect(api.acceptSuggestion("s1", D1, "x")).rejects.toMatchObject({ status: 401 });
    await expect(api.rejectSuggestion("s1", D1, "x")).rejects.toMatchObject({ status: 401 });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("Suggest", () => {
  it("shows eight buttons and sends the field", async () => {
    await withDraft();
    expect(suggestButtons().length).toBe(8);
    await press(box("who").children.find((c) => c.tag === "button"));
    expect(sent).toEqual([{ method: "POST", url: `/api/refinement/s1/drafts/${D1}/suggest`, body: { field: "who" } }]);
  });
  it("saves typed text first", async () => {
    await withDraft();
    type(field("notes"), "my notes");
    await press(box("title").children.find((c) => c.tag === "button"));
    expect(sent.map((s) => [s.method, s.body])).toEqual([["PUT", { notes: "my notes" }], ["POST", { field: "title" }]]);
  });
  it("asks nothing when the save fails", async () => {
    await withDraft();
    type(field("notes"), "my notes");
    mode = 400;
    modeFor = /\/drafts\/[^/]+$/;
    await press(box("title").children.find((c) => c.tag === "button"));
    expect(sent.map((s) => s.method)).toEqual(["PUT"]);
    expect(dr.unsaved.size).toBe(1);
    expect(toastText()).toContain("not asked");
  });
  it("keeps typed text when the save before it gets a 401: no reload, no Suggest", async () => {
    await withDraft();
    type(field("notes"), "my notes");
    mode = 401;
    const before = gets;
    await press(box("title").children.find((c) => c.tag === "button"));
    expect(sent.map((s) => s.method)).toEqual(["PUT"]);
    expect(reload).not.toHaveBeenCalled();
    expect(gets).toBe(before);
    expect(field("notes").value).toBe("my notes");
    expect(dr.unsaved.size).toBe(1);
  });
  it("shows the server's sentence for a 409", async () => {
    await withDraft();
    mode = 409;
    await press(box("title").children.find((c) => c.tag === "button"));
    expect(toastText()).toBe("The server said no");
  });
});

describe("hints", () => {
  it("without a brief", async () => {
    over = { brief: undefined };
    await withDraft();
    expect(section().textContent).toContain(sg.NO_BRIEF);
    expect(suggestButtons().length).toBe(0);
  });
  it("without a rule or example", async () => {
    over = { talk: talk({ rules: [], examples: [], open: [] }) };
    await withDraft();
    expect(box("criteria").textContent).toBe(sg.NO_MAP);
    expect(suggestButtons().length).toBe(7);
  });
});

describe("status lines", () => {
  const run = (st: string, extra: object = {}) => ({ state: st, kind: "suggest", draft: D1, field: "title", doing: "x", reason: "Out of time", ...extra });
  it("running", async () => {
    over = { architect: run("running") };
    await withDraft();
    expect(box("title").textContent).toContain("The architect is writing a suggestion.");
    expect(suggestButtons().length).toBe(0);
    expect(upper().textContent).not.toContain("writing a suggestion");
  });
  it("queued", async () => {
    over = { architect: run("queued") };
    await withDraft();
    expect(box("title").textContent).toContain("The architect is waiting for its turn.");
    expect(box("title").textContent).toContain("Then it writes a suggestion.");
  });
  it("paused: Ask again sends the same body", async () => {
    over = { architect: run("paused") };
    await withDraft();
    expect(box("title").textContent).toContain("Out of time.");
    expect(suggestButtons().length).toBe(0);
    await press(button("Ask again"));
    expect(sent.map((s) => s.body)).toEqual([{ field: "title" }]);
  });
  it("failed: Try again, and Suggest on the other fields", async () => {
    over = { architect: run("failed") };
    await withDraft();
    expect(box("title").textContent).toContain("The architect could not finish.");
    expect(button("Try again")).toBeDefined();
    expect(suggestButtons().length).toBe(7);
  });
  it("a round is running: no Suggest and no line here", async () => {
    over = { architect: { state: "running", kind: "round", doing: "x" } };
    await withDraft();
    expect(suggestButtons().length).toBe(0);
    expect(section().textContent).not.toContain("The architect is");
  });
  it("a suggestion for a closed draft shows at the top", async () => {
    over = { architect: run("paused") };
    state.drafts = [{ id: D1, criteria: [], dependsOn: [], title: { text: "Export", from: "typed" } }];
    await show();
    expect(section().textContent).toContain("The architect paused.");
    expect(section().textContent).toContain('Open the draft "Export" to ask again.');
    await press(button("Open"));
    expect(section().textContent).not.toContain("Open the draft");
    expect(box("title").textContent).toContain("The architect paused.");
  });
});

describe("a suggestion and its buttons", () => {
  it("shows the pill, the text and three buttons", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "A title" })] });
    expect(box("title").textContent).toContain("Suggested");
    expect(box("title").textContent).toContain("A title");
    expect(["Accept", "Edit and accept", "Reject"].map((t) => Boolean(button(t, box("title"))))).toEqual([true, true, true]);
    expect(suggestButtons().length).toBe(8); // Suggest stays: it asks for another
  });
  it("Accept on an empty field sends {} and marks it accepted", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "A title" })] });
    await press(button("Accept", box("title")));
    expect(sent).toEqual([{ method: "POST", url: `/api/refinement/s1/drafts/${D1}/suggestions/${S1}/accept`, body: {} }]);
    expect(confirms).toBe(0);
    expect(field("title").value).toBe("A title");
    expect(box("title").textContent).not.toContain("Suggested");
    expect(mark("title")).toBe("accepted");
  });
  it("is drawn as text", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "<img src=x onerror=1>" })] });
    expect(box("title").textContent).toContain("<img src=x onerror=1>");
    expect(walk(main()).some((e) => e.tag === "img")).toBe(false);
  });
});

describe("the confirmation", () => {
  const withText = () => withDraft({ title: { text: "Old", from: "typed" }, suggestions: [sug(S1, "title", { text: "New" })] });
  it("a refusal sends nothing", async () => {
    confirmAnswer = false;
    await withText();
    await press(button("Accept", box("title")));
    expect(confirms).toBe(1);
    expect(sent).toEqual([]);
  });
  it("a yes sends", async () => {
    await withText();
    await press(button("Accept", box("title")));
    expect(sent.length).toBe(1);
    expect(field("title").value).toBe("New");
  });
  it("asks also for the same text, saved", async () => {
    await withDraft({ title: { text: "Same", from: "typed" }, suggestions: [sug(S1, "title", { text: "Same" })] });
    await press(button("Accept", box("title")));
    expect(confirms).toBe(1);
  });
  it("asks also for the same text, unsaved", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "Same" })] });
    type(field("title"), "Same");
    await press(button("Accept", box("title")));
    expect(confirms).toBe(1);
  });
  it("asks when the text is only typed; no later save overwrites the accepted text", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "New" })] });
    type(field("title"), "typed here");
    await press(button("Accept", box("title")));
    expect(confirms).toBe(1);
    await wait(3000);
    expect(sent.map((s) => s.method)).toEqual(["POST"]);
    expect(field("title").value).toBe("New");
  });
  it("a failed accept brings the typed text back", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "New" })] });
    type(field("title"), "typed here");
    mode = 500;
    await press(button("Accept", box("title")));
    mode = "ok";
    await wait(3000);
    expect(sent.map((s) => s.method)).toEqual(["POST", "PUT"]);
    expect(sent[1]!.body).toEqual({ title: "typed here" });
  });
  it("is not asked for criteria", async () => {
    await withDraft({ criteria: [crit(1, "One")], suggestions: [sug(S1, "criteria", { text: "Two", tie: E1 })] });
    await press(button("Accept", box("criteria")));
    expect(confirms).toBe(0);
  });
});

describe("Edit and accept", () => {
  const seed = () => withDraft({ suggestions: [sug(S1, "what", { text: "to export" })] });
  it("sends the changed text", async () => {
    await seed();
    await press(button("Edit and accept", box("what")));
    const titleId = dialog()!.attrs["aria-labelledby"];
    expect(walk(dialog()!).find((e) => e.attrs.id === titleId)?.textContent).toBe("Edit and accept");
    const area = walk(dialog()!).find((e) => e.tag === "textarea")!;
    expect(area.value).toBe("to export");
    type(area, "to export it");
    await press(inDialog("Accept"));
    expect(sent[0]!.body).toEqual({ text: "to export it" });
    expect(field("what").value).toBe("to export it");
    expect(mark("what")).toBe("accepted, then edited");
    expect(dialog()).toBeUndefined();
  });
  it("sends {} for unchanged text", async () => {
    await seed();
    await press(button("Edit and accept", box("what")));
    await press(inDialog("Accept"));
    expect(sent[0]!.body).toEqual({});
    expect(mark("what")).toBe("accepted");
  });
  it("needs a text", async () => {
    await seed();
    await press(button("Edit and accept", box("what")));
    type(walk(dialog()!).find((e) => e.tag === "textarea")!, "  ");
    await press(inDialog("Accept"));
    expect(dialog()!.textContent).toContain("Write the text.");
    expect(sent).toEqual([]);
  });
  it("says that it replaces text", async () => {
    await withDraft({ what: { text: "other", from: "typed" }, suggestions: [sug(S1, "what", { text: "to export" })] });
    await press(button("Edit and accept", box("what")));
    expect(dialog()!.textContent).toContain("This replaces the text of the field.");
  });
  it("a failing server gives a toast and closes the dialog", async () => {
    await seed();
    await press(button("Edit and accept", box("what")));
    mode = 400;
    await press(inDialog("Accept"));
    expect(toastText()).toBe("The server said no");
    expect(dialog()).toBeUndefined();
  });
});

describe("Reject", () => {
  const seed = () => withDraft({ title: { text: "Keep", from: "typed" }, suggestions: [sug(S1, "title", { text: "New" })] });
  it("sends the reason", async () => {
    await seed();
    await press(button("Reject", box("title")));
    const area = walk(dialog()!).find((e) => e.attrs.name === "reason")!;
    expect(area.attrs.maxlength).toBe("300");
    type(area, " too long ");
    await press(inDialog("Reject"));
    expect(sent[0]).toMatchObject({ url: `/api/refinement/s1/drafts/${D1}/suggestions/${S1}/reject`, body: { reason: "too long" } });
    expect(box("title").textContent).not.toContain("Suggested");
    expect(field("title").value).toBe("Keep");
  });
  it("sends {} without a reason", async () => {
    await seed();
    await press(button("Reject", box("title")));
    await press(inDialog("Reject"));
    expect(sent[0]!.body).toEqual({});
  });
});

describe("criteria and depends on", () => {
  it("shows the rule or example and decides one by one", async () => {
    await withDraft({ criteria: [crit(1, "One")], suggestions: [sug(S1, "criteria", { text: "Two", tie: E1 }), sug(S2, "criteria", { text: "Three", tie: E2 })] });
    expect(box("criteria").textContent).toContain("From the rule: Old rule");
    expect(box("criteria").textContent).toContain("From the example: An example");
    const typing = byFocus("crit-new")!;
    type(typing, "half a crit");
    await press(byFocus(`sug-accept-${S1}`));
    expect(critRows().length).toBe(3);
    expect(walk(section()).find((e) => e.tag === "li" && e.textContent.includes("accepted") && e.children.some((c) => c.tag === "textarea"))).toBeDefined();
    expect(box("criteria").textContent).toContain("Three");
    expect(box("criteria").textContent).not.toContain("Two");
    expect(byFocus("crit-new")).toBe(typing);
    expect(typing.value).toBe("half a crit");
  });
  it("a depends-on suggestion has no Edit and accept", async () => {
    await withDraft({ suggestions: [sug(S1, "dependsOn", { issue: 12 })] });
    expect(box("dependsOn").textContent).toContain("#12");
    expect(button("Edit and accept", box("dependsOn"))).toBeUndefined();
    await press(button("Accept", box("dependsOn")));
    const li = walk(section()).find((e) => e.tag === "li" && e.textContent.includes("#12"))!;
    expect(li.textContent).toContain("accepted");
  });
});

describe("unsaved text", () => {
  it("is kept when another field is decided", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "New" })] });
    type(field("notes"), "my notes");
    await press(button("Accept", box("title")));
    expect(field("notes").value).toBe("my notes");
    await wait(1100);
    expect(sent.map((s) => [s.method, s.body])).toContainEqual(["PUT", { notes: "my notes" }]);
  });
  it("is kept when the decision fails", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "New" })] });
    type(field("notes"), "my notes");
    mode = 500;
    await press(button("Accept", box("title")));
    expect(field("notes").value).toBe("my notes");
    expect(dr.unsaved.size).toBe(1);
  });
  it("is kept when the session ended: no hard reload, no new load", async () => {
    await withDraft({ suggestions: [sug(S1, "title", { text: "New" })] });
    type(field("notes"), "my notes");
    const before = gets;
    mode = 401;
    modeFor = /suggestions/;
    await press(button("Accept", box("title")));
    expect(reload).not.toHaveBeenCalled();
    expect(gets).toBe(before);
    expect(field("notes").value).toBe("my notes");
    expect(dr.unsaved.size).toBe(1);
  });
});

describe("marks", () => {
  it("name where a text came from", async () => {
    await withDraft({ title: { text: "A", from: "typed" }, who: { text: "B", from: "accepted" }, what: { text: "C", from: "accepted-edited" }, criteria: [crit(1, "One")] });
    expect(["title", "who", "what", "why"].map(mark)).toEqual(["typed", "accepted", "accepted, then edited", ""]);
    expect(critRows()[0]!.textContent).toContain("typed");
  });
  it("follow the visible text, also before the save and after a failed save", async () => {
    await withDraft({ who: { text: "B", from: "accepted" } });
    type(field("who"), "B2");
    expect(mark("who")).toBe("accepted, then edited");
    type(field("why"), "new");
    expect(mark("why")).toBe("typed");
    type(field("why"), "");
    expect(mark("why")).toBe("");
    mode = 400;
    type(field("what"), "x");
    await wait(1100);
    expect(mark("what")).toBe("typed");
    expect(mark("who")).toBe("accepted, then edited");
  });
  it("a typed criterion is marked at once", async () => {
    await withDraft();
    const ta = byFocus("crit-new")!;
    type(ta, "My criterion");
    expect(critRows().find((r) => r.children.includes(ta))!.textContent).toContain("typed");
  });
  it("go back to accepted when the save trims the text to what it was", async () => {
    await withDraft({ title: { text: "A", from: "accepted" } });
    type(field("title"), " A ");
    expect(mark("title")).toBe("accepted, then edited");
    await wait(1100);
    expect(field("title").value).toBe("A");
    expect(mark("title")).toBe("accepted");
  });
  it("an edited accepted text reads accepted, then edited after the save", async () => {
    await withDraft({ title: { text: "A", from: "accepted" } });
    type(field("title"), "A and more");
    await wait(1100);
    expect(mark("title")).toBe("accepted, then edited");
  });
});

describe("who sees what", () => {
  const seeded = () => {
    state.drafts = [{ id: D1, criteria: [crit(1, "One")], dependsOn: [{ id: "d0000001-0000-4000-8000-000000000000", issue: 7, from: "accepted" }], title: { text: "Export", from: "typed" }, suggestions: [sug(S1, "who", { text: "a user" })] }];
  };
  for (const [name, change] of [["a dropped session", { state: "dropped" }], ["an admin", { mine: false }], ["a missing repository", { repoAvailable: false }]] as const) {
    it(`${name}: the suggestion is read, no control`, async () => {
      over = change;
      seeded();
      await show();
      expect(section().textContent).toContain("Suggested");
      expect(section().textContent).toContain("a user");
      expect(section().textContent).toContain("Title: typed");
      expect(section().textContent).toContain("Depends on: #7 (accepted)");
      for (const t of ["Suggest", "Accept", "Reject", "Edit and accept"]) expect(button(t), t).toBeUndefined();
    });
  }
  it("hidden drafts stay hidden", async () => {
    over = { draftsHidden: true, drafts: [] };
    seeded();
    await show();
    expect(section().textContent).not.toContain("a user");
  });
});
