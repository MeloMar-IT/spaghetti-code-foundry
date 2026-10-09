import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinementError } from "../src/refinement/errors.js";
import { changeEpic, dropDraft, newDraft, preview, saveTyped } from "../src/refinement/draft.js";
import { mergeDrafts, moveCriterion } from "../src/refinement/draft-parts.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { autoDialog } from "./helpers/confirm-dialog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
let stopDialog: (() => void) | undefined;
const reload = vi.fn();
let state: { drafts: any[]; epic: number | undefined };
let log: any[];
let over: any; // what the view adds or changes
let sent: { method: string; url: string; body: any }[];
let gets: number;
let holds: (() => void)[];
let mode: "ok" | "hold" | "throw" | number;
let confirmAnswer: boolean;
let cleanup: (() => void) | undefined;

const RUNNING = { state: "running", kind: "brief", doing: "x" };
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "exploring", architect: { state: "idle" },
  drafts: state.drafts.map((d) => ({ ...d, preview: preview(d, state) })), ...(state.epic !== undefined ? { epic: state.epic } : {}),
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }, ...log], created: "x", updated: "x", mine: true, ...over,
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
const apply = (c: any) => {
  if (!c) return;
  state = { drafts: c.drafts, epic: c.epic };
  if (c.line) log.push({ at: new Date().toISOString(), who: "Ann", what: c.line.what, ...(c.line.detail ? { detail: c.line.detail } : {}) });
};

beforeEach(() => {
  vi.useFakeTimers();
  state = { drafts: [], epic: undefined };
  log = [];
  over = {};
  sent = [];
  gets = 0;
  holds = [];
  mode = "ok";
  confirmAnswer = true;
  dr.unsaved.clear();
  dr.opened.clear();
  reload.mockClear();
  (document as any).getElementById("toast").textContent = "";
  (document as any).activeElement = null;
  (globalThis as any).location = { hash: "#/refinement/s1", reload };
  stopDialog = autoDialog(() => confirmAnswer);
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets++;
      return reply(view());
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (mode === "hold") await new Promise<void>((r) => holds.push(r));
    if (mode === "throw") throw new TypeError("fetch failed");
    if (typeof mode === "number") return reply({ error: mode === 401 ? "sign in first" : mode === 409 ? "this draft is split into parts; change a part instead" : "The title can have at most 120 characters" }, mode);
    try {
      const m = /\/drafts(?:\/([^/]+))?$/.exec(url);
      const mv = /\/drafts\/([^/]+)\/criteria\/([^/]+)\/move$/.exec(url);
      const mg = /\/drafts\/([^/]+)\/merge$/.exec(url);
      if (mv) apply(moveCriterion(state, mv[1]!, mv[2]!, JSON.parse(init.body!)));
      else if (mg) apply(mergeDrafts(state, mg[1]!, JSON.parse(init.body!)));
      else if (url.endsWith("/epic")) apply(changeEpic(state, JSON.parse(init.body!)));
      else if (init.method === "POST") apply(newDraft(state));
      else if (init.method === "PUT") apply(saveTyped(state, m![1]!, JSON.parse(init.body!)));
      else apply(dropDraft(state, m![1]!));
    } catch (e) {
      if (e instanceof RefinementError) return reply({ error: e.message }, 400);
      throw e;
    }
    return reply(view(), 200);
  };
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  stopDialog?.();
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const main = () => (document as any).getElementById("main") as FakeElement;
const upper = () => main().children[0] as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const section = () => walk(main()).find((e) => e.attrs.class === "drafts")!;
const buttons = () => walk(section()).filter((e) => e.tag === "button");
const button = (t: string) => buttons().find((e) => e.textContent === t);
const field = (name: string) => walk(section()).find((e) => e.attrs.name === name)!;
const rows = () => walk(section()).filter((e) => e.tag === "li" && e.attrs.class === "entry" && e.children.some((c) => c instanceof FakeElement && c.tag === "textarea"));
const press = async (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
  await flush();
};
const show = async (admin = false) => {
  cleanup = await ui.renderRefinement(main(), { admin, id: "s1" });
};
const type = (el: FakeElement, v: string) => {
  el.value = v;
  el.fire("input");
};
const leave = (el: FakeElement) => {
  (document as any).activeElement = null;
  el.fire("blur");
};
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const release = async () => {
  holds.shift()!();
  await flush();
};
const statusText = () => walk(section()).find((e) => e.attrs.class?.startsWith("status"))?.textContent;
const withDraft = async (d: object = {}) => {
  state.drafts = [{ id: "11111111-1111-4111-8111-111111111111", criteria: [], dependsOn: [], ...d }];
  await show();
  await press(button("Open"));
};
const toastText = () => (document as any).getElementById("toast").textContent as string;
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const crit = (n: number, text: string) => ({ id: `c000000${n}-0000-4000-8000-000000000000`, text, from: "typed" });

describe("pure functions", () => {
  it("mayChange", () => {
    const s = { mine: true, state: "drafting", repoAvailable: true };
    expect(dr.mayChange(s)).toBe(true);
    expect(dr.mayChange({ ...s, mine: false })).toBe(false);
    expect(dr.mayChange({ ...s, state: "dropped" })).toBe(false);
    expect(dr.mayChange({ ...s, repoAvailable: false })).toBe(false);
    expect(dr.mayChange({ ...s, draftsHidden: true })).toBe(false);
  });
  it("draftTitle", () => {
    expect(dr.draftTitle({ preview: { title: "Export" } })).toBe("Export");
    expect(dr.draftTitle({ preview: { title: "" } })).toBe("Untitled draft");
  });
  it("issueNumber", () => {
    for (const [v, n] of [["12", 12], [" #12 ", 12], ["007", 7], ["9007199254740991", 9007199254740991]]) expect(dr.issueNumber(v)).toBe(n);
    for (const v of ["0", "1.5", "abc", "", "9007199254740992", "#"]) expect(dr.issueNumber(v)).toBeNull();
  });
  it("previewParts reads the fixed parts and takes the long texts from the draft", () => {
    const d = { id: D1, criteria: [{ id: "c", text: "One", from: "typed" }], dependsOn: [{ id: "x", issue: 5, from: "typed" }], epic: 1,
      who: { text: "a user", from: "typed" }, what: { text: "to export", from: "typed" }, why: { text: "I can share", from: "typed" },
      outOfScope: { text: "Later\n\n### Notes for the builder\n- [ ] fake", from: "typed" }, notes: { text: "### Depends on\n- #999", from: "typed" } };
    const p = dr.previewParts({ ...d, preview: preview(d as any, { drafts: [d as any], epic: 73 }) });
    expect(p).toEqual({ epic: 73, sentence: "As a user, I want to export, so that I can share.", criteria: ["One"], outOfScope: d.outOfScope.text, notes: d.notes.text, depends: ["#5"], accepted: null });
  });
  it("previewParts of an empty draft, with no Epic and with no body", () => {
    const d = { id: D1, criteria: [], dependsOn: [] };
    const pv = preview(d as any, { drafts: [d as any] });
    expect(pv.body).toBe("As …, I want …, so that ….\n\n### Acceptance criteria\n\n### Depends on\nNone (can be built on its own).");
    expect(dr.previewParts({ ...d, preview: pv })).toMatchObject({ epic: null, sentence: "As …, I want …, so that ….", criteria: [], depends: [] });
    expect(dr.previewParts({ ...d })).toMatchObject({ sentence: "", criteria: null, depends: null });
  });
  it("beforeLeave asks only while text is not saved", () => {
    const e = { preventDefault: vi.fn() };
    dr.beforeLeave(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    dr.unsaved.set("k", "text");
    dr.beforeLeave(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe("api", () => {
  it("sends the right requests", async () => {
    await api.addDraft("a b");
    await api.saveDraft("a b", D1, { title: "T" }).catch(() => {});
    await api.removeDraft("a b", D1).catch(() => {});
    await api.setEpic("a b", null);
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ["POST", "/api/refinement/a%20b/drafts"], ["PUT", `/api/refinement/a%20b/drafts/${D1}`], ["DELETE", `/api/refinement/a%20b/drafts/${D1}`], ["PUT", "/api/refinement/a%20b/epic"],
    ]);
    expect(sent[3]!.body).toEqual({ issue: null });
  });
  it("a 401 reloads the page, except for a typing save", async () => {
    mode = 401;
    await expect(api.saveDraft("s1", "d", {})).rejects.toMatchObject({ status: 401, message: "sign in first" });
    expect(reload).not.toHaveBeenCalled();
    await expect(api.addDraft("s1")).rejects.toThrow("sign in first");
    expect(reload).toHaveBeenCalled();
  });
});

describe("new and remove", () => {
  it("adds a draft, opens it with the Title focused, and logs it", async () => {
    await show();
    expect(section().textContent).toContain("No story drafts yet.");
    await press(button("New draft"));
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/drafts", body: {} }]);
    expect(section().textContent).toContain("Untitled draft");
    expect(field("title").value).toBe("");
    expect(field("who").value).toBe("");
    expect((document as any).activeElement).toBe(field("title"));
    expect(main().textContent).toContain("Ann added a story draft");
  });
  it("removes a draft after a confirmation", async () => {
    await withDraft({ title: { text: "Export", from: "typed" } });
    confirmAnswer = false;
    await press(button("Remove draft"));
    expect(sent).toEqual([]);
    confirmAnswer = true;
    await press(button("Remove draft"));
    expect(sent[0]!.method).toBe("DELETE");
    expect(walk(section()).some((e) => e.tag === "textarea")).toBe(false);
    expect(section().textContent).toContain("No story drafts yet.");
    expect(main().textContent).toContain('Ann removed a story draft: "Export"');
  });
  it("a removed draft with unsaved text leaves no Not saved card", async () => {
    await withDraft();
    type(field("title"), "Typed");
    await press(button("Remove draft"));
    expect(section().textContent).not.toContain("Not saved");
    expect(dr.unsaved.size).toBe(0);
  });
  it("shows the server's sentence at the draft limit", async () => {
    state.drafts = Array.from({ length: 20 }, (_, i) => ({ id: `${i.toString().padStart(8, "0")}-1111-4111-8111-111111111111`, criteria: [], dependsOn: [] }));
    await show();
    await press(button("New draft"));
    expect(toastText()).toBe("at most 20 story drafts");
  });
});

describe("typing and the delayed save", () => {
  it("saves one second after the last key and keeps the field in use", async () => {
    await withDraft();
    const el = field("title");
    el.focus();
    const before = upper().children;
    type(el, "Export");
    expect(statusText()).toBe("Saving…");
    await wait(999);
    expect(sent).toEqual([]);
    await wait(1);
    expect(sent).toEqual([{ method: "PUT", url: `/api/refinement/s1/drafts/${D1}`, body: { title: "Export" } }]);
    expect(statusText()).toBe("Saved");
    expect(field("title")).toBe(el);
    expect((document as any).activeElement).toBe(el);
    expect(el.value).toBe("Export");
    expect(section().textContent).toContain("Export");
    expect(upper().children).toBe(before);
  });
  it("more typing restarts the timer; a blur sends at once; two fields give two requests", async () => {
    await withDraft();
    type(field("title"), "A");
    await wait(600);
    type(field("title"), "AB");
    await wait(600);
    expect(sent).toEqual([]);
    await wait(400);
    expect(sent).toHaveLength(1);
    type(field("who"), "a user");
    leave(field("who"));
    await flush();
    type(field("what"), "x");
    type(field("why"), "y");
    await wait(1000);
    expect(sent.map((s) => Object.keys(s.body))).toEqual([["title"], ["who"], ["what"], ["why"]]);
  });
  it("an emptied field sends an empty text and the preview shows …", async () => {
    await withDraft({ who: { text: "a user", from: "typed" } });
    type(field("who"), "");
    await wait(1000);
    expect(sent[0]!.body).toEqual({ who: "" });
    expect(section().textContent).toContain("As …, I want …");
  });
  it("keeps a trailing space while the field is focused and takes the saved text when it is left", async () => {
    await withDraft();
    const el = field("title");
    el.focus();
    type(el, "Hello ");
    await wait(1000);
    expect(el.value).toBe("Hello ");
    leave(el);
    expect(el.value).toBe("Hello");
  });
  it("a blur that sends shows the saved text when the answer comes", async () => {
    await withDraft();
    const el = field("title");
    mode = "hold";
    el.focus();
    type(el, "Hello ");
    leave(el);
    await flush();
    mode = "ok";
    await release();
    expect(el.value).toBe("Hello");
  });
  it("text typed after the save began is sent in a second request", async () => {
    await withDraft();
    const el = field("title");
    el.focus();
    mode = "hold";
    type(el, "One");
    await wait(1000);
    type(el, "One two");
    await release();
    expect(el.value).toBe("One two");
    mode = "ok";
    await wait(1000);
    await flush();
    expect(sent.map((s) => s.body.title)).toEqual(["One", "One two"]);
    expect(el.value).toBe("One two");
    expect(dr.unsaved.size).toBe(0);
  });
});

describe("a failed save", () => {
  it("shows the server's sentence, keeps the text and tries again with the next change", async () => {
    await withDraft();
    const el = field("title");
    mode = 400;
    gets = 0;
    type(el, "x".repeat(121));
    await wait(1000);
    expect(statusText()).toBe("The title can have at most 120 characters");
    expect(walk(section()).find((e) => e.attrs.class === "status bad")).toBeDefined();
    expect(gets).toBe(0);
    expect(toastText()).toBe("");
    expect(field("title")).toBe(el);
    expect(el.value).toHaveLength(121);
    mode = "ok";
    type(el, "short");
    await wait(1000);
    expect(sent.at(-1)!.body).toEqual({ title: "short" });
    expect(statusText()).toBe("Saved");
  });
  it("says when the server cannot be reached", async () => {
    await withDraft();
    mode = "throw";
    type(field("title"), "x");
    await wait(1000);
    expect(statusText()).toBe("Could not reach the server.");
  });
  it("a 401 keeps the page and the text", async () => {
    await withDraft();
    const el = field("title");
    mode = 401;
    type(el, "Mine");
    await wait(1000);
    expect(statusText()).toBe("sign in first");
    expect(reload).not.toHaveBeenCalled();
    expect(field("title")).toBe(el);
    expect(el.value).toBe("Mine");
    mode = "ok";
    type(el, "Mine!");
    await wait(1000);
    expect(sent.at(-1)!.body).toEqual({ title: "Mine!" });
  });
  it("a failed field does not stop another one from saving", async () => {
    await withDraft();
    mode = 400;
    type(field("title"), "x".repeat(121));
    await wait(1000);
    mode = "ok";
    type(field("who"), "a user");
    await wait(1000);
    expect(sent.at(-1)!.body).toEqual({ who: "a user" });
    expect(field("title").value).toHaveLength(121);
  });
  it("keeps saying so while a failed field is not saved, even when another field saves", async () => {
    await withDraft();
    mode = 400;
    type(field("title"), "x".repeat(121));
    await wait(1000);
    mode = "ok";
    type(field("who"), "a user");
    await wait(1000);
    expect(statusText()).toBe("The title can have at most 120 characters");
  });
  it("unsaved text is back in the new field after a failed button action reloaded the page", async () => {
    await withDraft();
    type(field("title"), "Kept");
    mode = 400;
    await press(button("New draft"));
    mode = "ok";
    await flush();
    expect(field("title").value).toBe("Kept");
    await wait(1000);
    expect(sent.at(-1)!.body).toEqual({ title: "Kept" });
  });
});

describe("races with the poll", () => {
  it("a poll never overwrites unsaved text", async () => {
    over = { architect: RUNNING };
    await withDraft();
    const el = field("who");
    mode = 400;
    type(el, "typed");
    await wait(1000);
    state.drafts = [{ ...state.drafts[0], who: { text: "from elsewhere", from: "typed" } }];
    await wait(5000);
    expect(field("who")).toBe(el);
    expect(el.value).toBe("typed");
  });
  it("a poll changes a clean field, but not a clean focused one until it is left", async () => {
    over = { architect: RUNNING };
    await withDraft();
    state.drafts = [{ ...state.drafts[0], who: { text: "a", from: "typed" }, what: { text: "b", from: "typed" } }];
    field("what").focus();
    await wait(5000);
    expect(field("who").value).toBe("a");
    expect(field("what").value).toBe("");
    leave(field("what"));
    expect(field("what").value).toBe("b");
  });
  it("a poll that sees a change before its own answer is not drawn", async () => {
    over = { architect: RUNNING };
    await withDraft();
    mode = "hold";
    await press(button("New draft"));
    apply(newDraft(state)); // the server has committed; the answer is still on its way
    await wait(5000);
    expect(section().querySelectorAll("li").filter((e) => e.textContent.startsWith("Untitled draft"))).toHaveLength(1);
    expect(gets).toBeGreaterThan(1);
    holds.shift()!();
    await flush();
  });
  it("New draft waits for a save in flight", async () => {
    await withDraft();
    mode = "hold";
    type(field("title"), "T");
    await wait(1000);
    await press(button("New draft"));
    expect(sent).toHaveLength(1);
    mode = "ok";
    await release();
    expect(sent.map((s) => s.method)).toEqual(["PUT", "POST"]);
    expect(state.drafts).toHaveLength(2);
  });
  it("opening another draft sends the text of the first", async () => {
    state.drafts = [{ id: D1, criteria: [], dependsOn: [] }, { id: D2, criteria: [], dependsOn: [] }];
    await show();
    await press(button("Open"));
    type(field("title"), "First");
    await press(button("Open"));
    await flush();
    expect(sent[0]).toMatchObject({ method: "PUT", url: `/api/refinement/s1/drafts/${D1}`, body: { title: "First" } });
    expect(field("title").value).toBe("");
  });
});

describe("acceptance criteria", () => {
  it("adds one by typing in the last field and keeps typing in the same element", async () => {
    await withDraft();
    expect(rows()).toHaveLength(1);
    const ta = rows()[0]!.children[0] as FakeElement;
    ta.focus();
    type(ta, "It works");
    await wait(1000);
    expect(sent[0]!.body).toEqual({ criteria: [{ text: "It works" }] });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.children[0]).toBe(ta);
    expect(button("Remove")).toBeDefined();
    expect(ta.attrs["data-focus"]).toMatch(/^crit-/);
    type(ta, "It works well");
    await wait(1000);
    expect(sent[1]!.body.criteria).toEqual([{ id: state.drafts[0].criteria[0].id, text: "It works well" }]);
    expect(state.drafts[0].criteria).toHaveLength(1);
  });
  it("typing on while the first save is held gives one criterion with the newer text", async () => {
    await withDraft();
    const ta = rows()[0]!.children[0] as FakeElement;
    mode = "hold";
    type(ta, "a");
    await wait(1000);
    type(ta, "ab");
    await wait(1000);
    mode = "ok";
    await release();
    await wait(1000);
    await flush();
    expect(state.drafts[0].criteria.map((c: any) => c.text)).toEqual(["ab"]);
    expect(rows()).toHaveLength(2);
  });
  it("an emptied criterion is not sent and gets its text back when left; Remove sends the list without it", async () => {
    await withDraft({ criteria: [crit(1, "One"), crit(2, "Two")] });
    const ta = rows()[0]!.children[0] as FakeElement;
    type(ta, "");
    await wait(1000);
    expect(sent).toEqual([]);
    leave(ta);
    expect(ta.value).toBe("One");
    await press(walk(rows()[0]!).find((e) => e.tag === "button"));
    expect(sent[0]!.body).toEqual({ criteria: [{ id: crit(2, "").id, text: "Two" }] });
    expect(rows()).toHaveLength(2);
  });
  it("Remove builds its list after a save in flight, so the saved edit is kept", async () => {
    await withDraft({ criteria: [crit(1, "One"), crit(2, "Two")] });
    mode = "hold";
    type(rows()[1]!.children[0] as FakeElement, "Two!");
    await wait(1000);
    await press(walk(rows()[0]!).find((e) => e.tag === "button"));
    mode = "ok";
    await release();
    await flush();
    expect(state.drafts[0].criteria.map((c: any) => c.text)).toEqual(["Two!"]);
  });
  it("a new criterion typed on while its save is in flight is not added twice when the draft is closed", async () => {
    await withDraft();
    const ta = rows()[0]!.children[0] as FakeElement;
    mode = "hold";
    type(ta, "a");
    await wait(1000);
    type(ta, "ab");
    await press(button("Close"));
    mode = "ok";
    await release();
    await flush();
    await wait(1000);
    expect(state.drafts[0].criteria.map((c: any) => c.text)).toEqual(["ab"]);
  });
  it("Remove draft keeps typed text when the request is refused", async () => {
    await withDraft();
    mode = "hold";
    await press(button("New draft"));
    type(field("title"), "Typed");
    await press(button("Remove draft"));
    expect(dr.unsaved.size).toBe(1);
    mode = "ok";
    await release();
    expect(dr.unsaved.size).toBe(1);
    expect(section().textContent).toContain("Typed"); // its draft is no longer open, so the text shows in the Not saved card
  });
  it("a blank new field sends nothing", async () => {
    await withDraft();
    type(rows()[0]!.children[0] as FakeElement, "   ");
    await wait(1000);
    expect(sent).toEqual([]);
  });
  it("a row in use keeps its place when a poll changes the other rows", async () => {
    over = { architect: RUNNING };
    await withDraft({ criteria: [crit(1, "One"), crit(2, "Two")] });
    const li = rows()[1]!;
    const ta = li.children[0] as FakeElement;
    ta.focus();
    type(ta, "Two!");
    mode = 400;
    await wait(1000);
    const list = li.parent!;
    const insert = vi.spyOn(list, "insertBefore");
    const replace = vi.spyOn(list, "replaceChildren");
    const removed = vi.spyOn(li, "remove");
    state.drafts = [{ ...state.drafts[0], criteria: [crit(3, "Three"), crit(2, "Two"), crit(1, "One")] }];
    await wait(5000);
    expect(removed).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(insert.mock.calls.some((c) => c[0] === li)).toBe(false);
    expect(rows()[1]).toBe(li);
    expect(rows().map((r) => (r.children[0] as FakeElement).value)).toEqual(["Three", "Two!", "One", ""]);
    expect((document as any).activeElement).toBe(ta);
  });
  it("text whose criterion was removed elsewhere goes to the Not saved card until it is discarded", async () => {
    over = { architect: RUNNING };
    await withDraft({ criteria: [crit(1, "One"), crit(2, "Two")] });
    const ta = rows()[1]!.children[0] as FakeElement;
    mode = 400;
    type(ta, "Two!");
    await wait(1000);
    const before = sent.length;
    state.drafts = [{ ...state.drafts[0], criteria: [crit(1, "One")] }];
    await wait(5000);
    expect(section().textContent).toContain("Not saved");
    expect(section().textContent).toContain("Two!");
    await wait(2000);
    expect(sent).toHaveLength(before);
    await press(button("Discard"));
    expect(section().textContent).not.toContain("Not saved");
    expect(dr.unsaved.size).toBe(0);
  });
});

describe("text whose place is gone", () => {
  it("the draft was removed elsewhere", async () => {
    over = { architect: RUNNING };
    await withDraft();
    mode = 400;
    type(field("title"), "Mine");
    await wait(1000);
    const before = sent.length;
    state.drafts = [];
    await wait(5000);
    expect(walk(section()).some((e) => e.tag === "textarea")).toBe(false);
    expect(section().textContent).toContain("Mine");
    await wait(2000);
    expect(sent).toHaveLength(before);
  });
  it("the session can no longer be changed; when it can again the text is back and is sent", async () => {
    over = { architect: RUNNING };
    await withDraft();
    mode = 400;
    type(field("title"), "Mine");
    await wait(1000);
    mode = "ok";
    const before = sent.length;
    over = { architect: RUNNING, state: "dropped" };
    await wait(5000);
    expect(walk(section()).some((e) => ["button", "textarea", "select", "input"].includes(e.tag))).toBe(false);
    expect(section().textContent).toContain("Mine");
    await wait(2000);
    expect(sent).toHaveLength(before);
    over = { architect: RUNNING };
    await wait(5000);
    expect(field("title").value).toBe("Mine");
    await wait(1000);
    expect(sent.at(-1)!.body).toEqual({ title: "Mine" });
  });
});

describe("depends on and the Epic", () => {
  it("adds an issue number and removes it", async () => {
    await withDraft();
    const input = field("depends-issue");
    type(input, "#12");
    await press(button("Add issue"));
    expect(sent[0]!.body).toEqual({ dependsOn: [{ issue: 12 }] });
    expect(section().textContent).toContain("#12");
    await press(button("Add issue"));
    expect(toastText()).not.toBe("");
    expect(sent).toHaveLength(1);
    type(field("depends-issue"), "abc");
    await press(button("Add issue"));
    expect(sent).toHaveLength(1);
    await press(buttons().filter((b) => b.textContent === "Remove").at(-1));
    expect(sent[1]!.body).toEqual({ dependsOn: [] });
  });
  it("chooses another draft of the session", async () => {
    state.drafts = [{ id: D1, criteria: [], dependsOn: [{ id: "d0000000-0000-4000-8000-000000000000", issue: 12, from: "typed" }] },
      { id: D2, criteria: [], dependsOn: [], title: { text: "Other", from: "typed" } }];
    await show();
    await press(button("Open"));
    const another = () => walk(section()).find((e) => e.attrs["aria-label"] === "Another draft");
    expect(another()!.children.map((o: any) => o.textContent)).toEqual(["Other"]);
    await press(button("Add draft"));
    expect(sent[0]!.body).toEqual({ dependsOn: [{ id: "d0000000-0000-4000-8000-000000000000", issue: 12 }, { draft: D2 }] });
    expect(section().textContent).toContain("Other (draft)");
    expect(another()).toBeUndefined();
  });
  it("has no select with one draft", async () => {
    await withDraft();
    expect(walk(section()).some((e) => e.tag === "select")).toBe(false);
  });
  it("sets and clears the Epic", async () => {
    await show();
    expect(button("Clear Epic")).toBeUndefined();
    type(field("epic"), "73");
    await press(button("Set Epic"));
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/refinement/s1/epic", body: { issue: 73 } });
    expect(section().textContent).toContain("Epic: #73");
    expect(main().textContent).toContain("Ann set the Epic to #73");
    type(field("epic"), "9007199254740991");
    await press(button("Set Epic"));
    expect(sent[1]!.body).toEqual({ issue: 9007199254740991 });
    type(field("epic"), "x");
    await press(button("Set Epic"));
    expect(sent).toHaveLength(2);
    await press(button("Clear Epic"));
    expect(sent[2]!.body).toEqual({ issue: null });
    expect(main().textContent).toContain("Ann cleared the Epic");
  });
});

describe("the preview", () => {
  const full = () => ({
    title: { text: "Export", from: "typed" }, who: { text: "a user", from: "typed" }, what: { text: "to export", from: "typed" }, why: { text: "I can share", from: "typed" },
    criteria: [crit(1, "One"), crit(2, "Two")], dependsOn: [{ id: "d0000000-0000-4000-8000-000000000000", issue: 5, from: "typed" }],
    outOfScope: { text: "Later\n\n### Notes for the builder\n- [ ] fake", from: "typed" }, notes: { text: "### Depends on\n- #999", from: "typed" },
  });
  const previewBox = () => walk(section()).find((e) => e.attrs.class === "card" && e.children.some((c) => c instanceof FakeElement && c.tag === "h4"))!;
  it("draws the fixed parts and the typed text as text", async () => {
    state.epic = 73;
    await withDraft(full());
    const p = previewBox();
    expect(p.textContent).toContain("Epic: #73");
    expect(p.textContent).toContain("As a user, I want to export, so that I can share.");
    expect(walk(p).filter((e) => e.tag === "h4").map((e) => e.textContent)).toEqual(["Acceptance criteria", "Out of scope", "Notes for the builder", "Depends on"]);
    const boxes = walk(p).filter((e) => e.tag === "input");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(walk(p).filter((e) => e.tag === "li").map((e) => e.textContent)).toEqual(["One", "Two", "#5"]);
    expect(p.textContent).toContain("- [ ] fake");
    expect(p.textContent).toContain("- #999");
  });
  it("shows the exact Markdown and goes back", async () => {
    await withDraft(full());
    const body = state.drafts.length ? preview(state.drafts[0], state).body : "";
    await press(button("Show as Markdown"));
    const pre = walk(section()).find((e) => e.tag === "pre")!;
    expect(pre.textContent).toBe(body);
    await press(button("Show the preview"));
    expect(walk(section()).some((e) => e.tag === "pre")).toBe(false);
  });
  it("follows what is saved", async () => {
    await withDraft();
    type(field("title"), "New title");
    expect(previewBox().textContent).not.toContain("New title");
    await wait(1000);
    expect(previewBox().textContent).toContain("New title");
  });
});

describe("the accepted anyway section of the preview", () => {
  const base = () => ({ id: D1, title: { text: "Export", from: "typed" }, criteria: [crit(1, "One")], dependsOn: [{ id: "d0000000-0000-4000-8000-000000000000", issue: 5, from: "typed" }] });
  const lines = [{ text: "it says what is out of scope", reason: "Not needed here" }, { text: "every criterion can be checked", reason: "Checked by hand" }];
  it("previewParts: depends holds only the dependencies, accepted the lines", () => {
    const p = dr.previewParts({ ...base(), preview: preview(base() as any, state as any, lines) });
    expect(p.depends).toEqual(["#5"]);
    expect(p.accepted).toEqual(lines.map((l) => `${l.text}: ${l.reason}`));
    expect(dr.previewParts({ ...base(), preview: preview(base() as any, state as any) }).accepted).toBeNull();
  });
  it("a notes text that looks like the section is not read as it", () => {
    const b = { ...base(), notes: { text: "### Accepted anyway\n- fake: x", from: "typed" } };
    const p = dr.previewParts({ ...b, preview: preview(b as any, state as any) });
    expect(p.accepted).toBeNull();
    expect(p.notes).toBe("### Accepted anyway\n- fake: x");
  });
  it("previewNodes shows the heading and lines as text", () => {
    const box = new FakeElement("div");
    box.append(...[dr.previewNodes({ ...base(), preview: preview(base() as any, state as any, lines) })].flat(5).filter(Boolean));
    expect(walk(box).filter((e) => e.tag === "h4").map((e) => e.textContent)).toEqual(["Acceptance criteria", "Depends on", "Accepted anyway"]);
    expect(walk(box).filter((e) => e.tag === "li").map((e) => e.textContent)).toEqual(["One", "#5", "it says what is out of scope: Not needed here", "every criterion can be checked: Checked by hand"]);
  });
  it("the body of the preview holds the section unchanged", () => {
    expect(preview(base() as any, state as any, lines).body).toContain("### Accepted anyway\n- it says what is out of scope: Not needed here");
  });
});

describe("who sees fields", () => {
  const readOnly = () => {
    expect(walk(section()).filter((e) => ["button", "textarea", "select"].includes(e.tag))).toEqual([]);
    expect(walk(section()).filter((e) => e.tag === "input").every((e) => e.disabled)).toBe(true);
  };
  const some = () => {
    state.drafts = [{ id: D1, criteria: [crit(1, "One")], dependsOn: [], title: { text: "Export", from: "typed" } }];
    state.epic = 3;
  };
  for (const [name, extra] of [["dropped", { state: "dropped" }], ["not mine", { mine: false }], ["repository gone", { repoAvailable: false }]] as const) {
    it(`shows text only: ${name}`, async () => {
      some();
      over = extra;
      await show(name === "not mine");
      expect(section().textContent).toContain("Export");
      expect(section().textContent).toContain("One");
      expect(section().textContent).toContain("Epic: #3");
      readOnly();
    });
  }
  it("a hidden list says so", async () => {
    some();
    over = { repoAvailable: false, draftsHidden: true, drafts: undefined };
    await show();
    expect(section().textContent).toContain(dr.DRAFTS_HIDDEN);
    expect(section().textContent).toContain("Epic: #3");
    readOnly();
  });
  it("a gone repository with no drafts has no New draft", async () => {
    over = { repoAvailable: false };
    await show();
    expect(section().textContent).toContain("No story drafts yet.");
    expect(button("New draft")).toBeUndefined();
  });
  it("shows the same controls on the admin display for an own session", async () => {
    await show();
    const a = buttons().map((b) => b.textContent);
    cleanup?.();
    await show(true);
    expect(buttons().map((b) => b.textContent)).toEqual(a);
  });
});

describe("text and wiring", () => {
  const evil = "<img src=x onerror=alert(1)><script>boom()</script>";
  it("shows every text as text", async () => {
    await withDraft({ title: { text: evil, from: "typed" }, criteria: [crit(1, evil)], notes: { text: evil, from: "typed" } });
    type(field("who"), evil);
    expect(walk(main()).some((e) => e.tag === "img" || e.tag === "script")).toBe(false);
    expect(section().textContent).toContain(evil);
    expect(walk(section()).some((e) => e.tag === "h3")).toBe(false);
    expect(section().attrs.tabindex).toBeUndefined();
  });
});

// ---- parts of a split: moving a criterion, merging, depends on ----
describe("the save state of a field", () => {
  /** The node that shows the save state of a field (it follows the label of the field). */
  const saveOf = (name: string) => {
    const label = field(name).parent!;
    const kids = label.parent!.children;
    return kids[kids.indexOf(label) + 1] as FakeElement;
  };
  const rowSave = (i: number) => walk(rows()[i]!).find((e) => e.attrs["data-save"] !== undefined)!;
  const retryIn = (el: FakeElement) => walk(el).find((e) => e.tag === "button" && e.textContent === "Retry");

  it("shows Saving… at the field that is typed in, and Saved after the PUT", async () => {
    await withDraft();
    type(field("title"), "New");
    expect(saveOf("title").textContent).toBe("Saving…");
    expect(saveOf("who").textContent).toBe("");
    await wait(1000);
    expect(saveOf("title").textContent).toBe("Saved");
    expect(saveOf("who").textContent).toBe("");
  });
  it("a failed save shows the error with Retry and keeps the text; Retry sends again and shows Saved", async () => {
    await withDraft();
    const el = field("title");
    mode = 500;
    type(el, "Mine");
    await wait(1000);
    expect(saveOf("title").getAttribute("data-save")).toBe("failed");
    expect(saveOf("title").textContent).toContain("The title can have at most 120 characters");
    expect(el.value).toBe("Mine");
    expect(dr.unsaved.size).toBe(1);
    const before = sent.length;
    mode = "ok";
    await press(retryIn(saveOf("title")));
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.body.title).toBe("Mine");
    expect(saveOf("title").textContent).toBe("Saved");
    expect(dr.unsaved.size).toBe(0);
  });
  it("a failed save of one field leaves the state of another field alone", async () => {
    await withDraft();
    type(field("who"), "a user");
    await wait(1000);
    mode = 400;
    type(field("title"), "x".repeat(121));
    await wait(1000);
    expect(saveOf("title").getAttribute("data-save")).toBe("failed");
    expect(saveOf("who").textContent).toBe("Saved");
  });
  it("does not say Saved while newer text waits", async () => {
    await withDraft();
    const el = field("title");
    el.focus();
    mode = "hold";
    type(el, "One");
    await wait(1000);
    type(el, "One two");
    mode = "ok";
    await release();
    expect(saveOf("title").textContent).toBe("Saving…");
    await wait(1000);
    await flush();
    expect(saveOf("title").textContent).toBe("Saved");
  });
  it("a criterion row keeps its state when it gets an id, and an emptied row shows none", async () => {
    await withDraft();
    const ta = rows()[0]!.children[0] as FakeElement;
    type(ta, "First");
    expect(rowSave(0).textContent).toBe("Saving…");
    await wait(1000);
    await flush();
    expect(rows()).toHaveLength(2);
    expect(rowSave(0).textContent).toBe("Saved");
    expect(rowSave(1).textContent).toBe("");
    const second = rows()[1]!.children[0] as FakeElement;
    type(second, "Second");
    expect(rowSave(1).textContent).toBe("Saving…");
    type(second, "");
    expect(rowSave(1).textContent).toBe("");
  });
  it("a criterion whose save failed shows its text again when the draft is closed and opened, and Retry sends it", async () => {
    await withDraft();
    mode = 500;
    type(rows()[0]!.children[0] as FakeElement, "First");
    await wait(1000);
    expect(rowSave(0).getAttribute("data-save")).toBe("failed");
    await press(button("Close"));
    await press(button("Open"));
    expect((rows()[0]!.children[0] as FakeElement).value).toBe("First");
    mode = "ok";
    const before = sent.length;
    await wait(1000);
    await flush();
    expect(sent.length).toBeGreaterThan(before);
    expect(sent.at(-1)!.body.criteria.map((c: any) => c.text)).toEqual(["First"]);
  });
  it("a poll answer while text is unsaved does not change the field", async () => {
    await withDraft();
    const el = field("title");
    mode = 400;
    type(el, "Mine");
    await wait(1000);
    state.drafts[0].title = { text: "Theirs", from: "typed" };
    await ui.renderRefinement(main(), { id: "s1" });
    expect(field("title").value).toBe("Mine");
  });
  it("a save that is refused because the draft was split shows the conflict, keeps the text and links to the parts", async () => {
    const D3 = "33333333-3333-4333-8333-333333333333";
    await withDraft();
    state.drafts = [
      { id: D1, title: { text: "Export rows", from: "typed" }, criteria: [], dependsOn: [], splitInto: [D2, D3] },
      { id: D2, title: { text: "Export a file", from: "typed" }, criteria: [], dependsOn: [], part: { of: D1 } },
      { id: D3, title: { text: "Choose columns", from: "typed" }, criteria: [], dependsOn: [], part: { of: D1 } },
    ];
    mode = 409;
    gets = 0;
    type(field("title"), "My change");
    await wait(1000);
    await flush();
    expect(gets).toBe(1); // the session is read again
    const box = walk(section()).find((e) => e.attrs["data-kind"] === "conflict")!;
    expect(box).toBeDefined();
    expect(box.getAttribute("class")).toContain("state-error");
    const links = walk(box).filter((e) => e.tag === "a");
    expect(links.map((l) => l.textContent)).toEqual(["Part 1: Export a file", "Part 2: Choose columns"]);
    expect(section().textContent).toContain("Not saved");
    expect(section().textContent).toContain("My change");
    mode = "ok";
    await press(links[0]);
    expect(field("title").value).toBe("Export a file");
  });
  it("Remove draft asks in the dialog; Move to notes is tested with the remarks", async () => {
    confirmAnswer = false;
    await withDraft({ title: { text: "T", from: "typed" } });
    await press(button("Remove draft"));
    expect(sent.filter((s) => s.method === "DELETE")).toEqual([]);
    confirmAnswer = true;
    await press(button("Remove draft"));
    expect(sent.filter((s) => s.method === "DELETE")).toHaveLength(1);
  });
  it("ui/refinement-draft.js does not grow past 814 lines", () => {
    expect(readFileSync("ui/refinement-draft.js", "utf8").split("\n").length - 1).toBeLessThanOrEqual(814);
  });
});

describe("parts of a split", () => {
  const D3 = "33333333-3333-4333-8333-333333333333";
  const D4 = "44444444-4444-4444-8444-444444444444";
  const tt = (text: string) => ({ text, from: "typed" });
  const family = () => {
    state.drafts = [
      { id: D1, title: tt("Export rows"), criteria: [crit(3, "Old formats work")], dependsOn: [], splitInto: [D2, D3] },
      { id: D2, title: tt("Export a file"), criteria: [crit(1, "Rows are exported")], dependsOn: [], part: { of: D1 } },
      { id: D3, title: tt("Choose columns"), criteria: [crit(2, "Columns can be chosen")], dependsOn: [], part: { of: D1 } },
      { id: D4, title: tt("Other story"), criteria: [crit(4, "Other works")], dependsOn: [] },
    ];
  };
  const openId = (id: string) => press(buttons().find((b) => b.attrs["data-focus"] === `open-${id}`));
  const selectIn = (el: FakeElement) => walk(el).find((e) => e.tag === "select");
  const labels = (sel: FakeElement | undefined) => (sel?.children ?? []).map((o: any) => o.textContent as string);
  const choose = async (sel: FakeElement, v: string) => {
    sel.value = v;
    sel.fire("change");
    await flush();
  };
  const mergeSel = () => walk(section()).find((e) => e.attrs["aria-label"] === "Merge with");
  const areas = () => walk(section()).filter((e) => e.tag === "textarea").map((e) => e.value);
  const post = (suffix: string) => sent.filter((x) => x.method === "POST" && x.url.endsWith(suffix));

  describe("moving a criterion", () => {
    it("a row of a part has the select; the empty row and a normal draft have none", async () => {
      family();
      await show();
      await openId(D2);
      const rs = rows();
      expect(labels(selectIn(rs[0]!))).toEqual(["Move to…", "Part 2: Choose columns", "Fits nowhere (the original)"]);
      expect(selectIn(rs[rs.length - 1]!)).toBeUndefined();
      await openId(D2);
      await openId(D4);
      expect(walk(section()).filter((e) => e.attrs["aria-label"]?.startsWith("Move to"))).toEqual([]);
    });
    it("typed text is saved first, then the criterion moves", async () => {
      family();
      await show();
      await openId(D2);
      type(field("title"), "Export a file now");
      await choose(selectIn(rows()[0]!)!, D3);
      expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
      expect(sent[0]!.body).toEqual({ title: "Export a file now" });
      expect(sent[1]!.body).toEqual({ to: D3 });
      expect(areas()).not.toContain("Rows are exported");
    });
    it("an edited criterion moves with its new text", async () => {
      family();
      await show();
      await openId(D2);
      type(rows()[0]!.children[0] as FakeElement, "Rows are exported fast");
      await choose(selectIn(rows()[0]!)!, D3);
      expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
      expect(JSON.stringify(sent[0]!.body)).toContain("Rows are exported fast");
      await openId(D2);
      await openId(D3);
      expect(areas()).toContain("Rows are exported fast");
      expect(section().textContent).not.toContain("Not saved");
    });
    it("a failing save sends no move", async () => {
      family();
      await show();
      await openId(D2);
      type(field("title"), "Export a file now");
      mode = 400;
      const sel = selectIn(rows()[0]!)!;
      await choose(sel, D3);
      expect(post("/move").length).toBe(0);
      expect(toastText()).toContain("Your text could not be saved, so nothing was moved. Try again.");
      expect(sel.value).toBe("");
    });
    it("a criterion can go back to the original", async () => {
      family();
      await show();
      await openId(D2);
      await choose(selectIn(rows()[0]!)!, D1);
      expect(post("/move")[0]!.body).toEqual({ to: D1 });
    });
  });

  describe("merging", () => {
    it("lists the other drafts, not itself, the original or a published draft", async () => {
      family();
      state.drafts.push({ id: "55555555-5555-4555-8555-555555555555", title: tt("On GitHub"), criteria: [], dependsOn: [], published: { issue: 7, url: "https://github.com/a/b/issues/7" } });
      await show();
      await openId(D4);
      expect(labels(mergeSel())).toEqual(["Export a file", "Choose columns"]);
    });
    it("a session with one draft has no merge control", async () => {
      await withDraft();
      expect(mergeSel()).toBeUndefined();
    });
    it("no confirmation, no call", async () => {
      family();
      await show();
      await openId(D4);
      confirmAnswer = false;
      await press(button("Merge"));
      expect(sent).toEqual([]);
    });
    it("a confirmed merge: the question, the call and the page after it", async () => {
      family();
      await show();
      await openId(D4);
      let question = "";
      stopDialog?.();
      stopDialog = autoDialog((q: string) => {
        question = q;
        return true;
      });
      mergeSel()!.value = D2;
      await press(button("Merge"));
      expect(question).toContain("Export a file");
      expect(question).toContain("Other story");
      expect(question).toContain("keeps its title, who, what and why");
      expect(question).toContain("is removed");
      expect(post("/merge").map((x) => [x.url.endsWith(`/drafts/${D4}/merge`), x.body])).toEqual([[true, { with: D2 }]]);
      expect(areas()).toContain("Rows are exported");
      expect(areas()).toContain("Other works");
      expect(labels(mergeSel())).toEqual(["Choose columns"]);
      expect(main().textContent).toContain('Ann merged two story drafts: "Other story" and "Export a file"');
    });
    it("typed text is saved first", async () => {
      family();
      await show();
      await openId(D4);
      type(field("notes"), "some notes");
      await press(button("Merge"));
      expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
    });
    it("a failing save sends no merge", async () => {
      family();
      await show();
      await openId(D4);
      type(field("notes"), "other notes");
      mode = 400;
      await press(button("Merge"));
      expect(post("/merge").length).toBe(0);
      expect(toastText()).toContain("so nothing was merged. Try again.");
    });
    it("unsaved text of the other draft blocks the merge and is kept", async () => {
      family();
      await show();
      await openId(D2);
      type(field("notes"), "precious notes");
      mode = 400;
      await wait(dr.SAVE_MS + 10);
      await openId(D2);
      await openId(D4);
      mode = "ok";
      sent.length = 0;
      mergeSel()!.value = D2;
      await press(button("Merge"));
      expect(post("/merge").length).toBe(0);
      expect(toastText()).toContain("not saved");
      expect([...dr.unsaved.values()]).toContain("precious notes");
    });
    it("a refusal is shown and both drafts stay", async () => {
      family();
      await show();
      await openId(D4);
      mode = 409;
      await press(button("Merge"));
      expect(toastText()).not.toBe("");
      expect(section().textContent).toContain("Export a file");
      expect(section().textContent).toContain("Other story");
    });
  });

  describe("depends on of a part", () => {
    const offered = () => labels(walk(section()).find((e) => e.attrs["aria-label"] === "Another draft"));
    it("part 1 is not offered part 2 or the original, but an unrelated draft", async () => {
      family();
      await show();
      await openId(D2);
      expect(offered()).toEqual(["Other story"]);
    });
    it("part 2 is offered part 1", async () => {
      family();
      await show();
      await openId(D3);
      expect(offered()).toEqual(["Export a file", "Other story"]);
    });
    it("a normal draft is offered every other draft", async () => {
      family();
      await show();
      await openId(D4);
      expect(offered()).toEqual(["Export rows", "Export a file", "Choose columns"]);
    });
  });
});
