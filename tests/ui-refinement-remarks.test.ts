import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinementError } from "../src/refinement/errors.js";
import { draftRemarks } from "../src/refinement/draft-check.js";
import { moveToNotes, reviewView } from "../src/refinement/draft-review.js";
import { newDraft, preview, saveTyped } from "../src/refinement/draft.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let rm: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  rm = await import("../ui/refinement-remarks.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const realConfirm = (globalThis as any).confirm;
const reload = vi.fn();
let state: { drafts: any[]; epic: number | undefined };
let over: any;
let sent: { method: string; url: string; body: any }[];
let mode: "ok" | number;
let modeFor: RegExp;
let confirms: number;
let confirmAnswer: boolean;
let cleanup: (() => void) | undefined;
let gate: Promise<void> | undefined; // holds the answer of a move

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", runId: "r" };
const AT = "2026-03-01T10:20:00.000Z";
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "drafting", architect: { state: "idle" }, brief: BRIEF,
  talk: { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] },
  drafts: state.drafts.map((d) => {
    const { review: _r, ...rest } = d;
    const rv = reviewView(d);
    return { ...rest, preview: preview(d, state as any), remarks: draftRemarks(d), ...(rv ? { review: rv } : {}) };
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
  gate = undefined;
  dr.unsaved.clear();
  dr.opened.clear();
  reload.mockClear();
  (document as any).getElementById("toast").textContent = "";
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).activeElement = null;
  (globalThis as any).location = { hash: "#/refinement/s1", reload };
  (globalThis as any).confirm = () => {
    confirms++;
    return confirmAnswer;
  };
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") return reply(view());
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (gate && /move-to-notes/.test(url)) await gate;
    if (mode !== "ok" && modeFor.test(url)) {
      if (mode === 401) return reply({ error: "sign in first" }, 401);
      return reply({ error: "The server said no" }, mode);
    }
    try {
      const body = init.body ? JSON.parse(init.body) : {};
      const m = /\/drafts\/([^/]+)(?:\/(review|move-to-notes))?$/.exec(url);
      if (m?.[2] === "review") over = { ...over, architect: { state: "running", kind: "review", draft: m[1], doing: "x" } };
      else if (m?.[2] === "move-to-notes") apply(moveToNotes(state as any, m[1]!, body));
      else if (init.method === "PUT") apply(saveTyped(state as any, m![1]!, body));
      else apply(newDraft(state as any));
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
  (globalThis as any).confirm = realConfirm;
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
const rem = (name: string) => walk(section()).find((e) => e.attrs["data-remarks"] === name)!;
const reviewBox = () => walk(section()).find((e) => e.attrs["data-review"] !== undefined)!;
const buttons = (root: FakeElement = section()) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root?: FakeElement) => buttons(root).find((e) => e.textContent === t);
const field = (name: string) => walk(section()).find((e) => e.attrs.name === name)!;
const critRows = () => walk(section()).filter((e) => e.tag === "li" && e.children.some((c) => c instanceof FakeElement && c.tag === "textarea"));
const areaOf = (row: FakeElement) => row.children.find((c) => c instanceof FakeElement && c.tag === "textarea") as FakeElement;
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
const crit = (n: number, text: string) => ({ id: `C${n}`, text, from: "typed" });
const t = (text: string) => ({ text, from: "typed" });
const withDraft = async (d: object = {}) => {
  state.drafts = [{ id: D1, criteria: [], dependsOn: [], ...d }];
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
  await press(button("Open"));
};
const show = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
};
const review = (remarks: object[]) => ({ review: { at: AT, remarks } });
const run = (st: string, extra: object = {}) => ({ state: st, kind: "review", draft: D1, doing: "x", reason: "Out of time", ...extra });
const SAVE = () => (dr.SAVE_MS as number) + 10;

describe("pure functions", () => {
  const d = { id: D1, title: t("T"), criteria: [] };
  const s = (extra: object = {}) => ({ brief: BRIEF, architect: { state: "idle" }, ...extra });
  it("isEmpty: notes count, depends on does not", () => {
    expect(rm.isEmpty({ criteria: [], dependsOn: [] })).toBe(true);
    expect(rm.isEmpty({ criteria: [], dependsOn: [{ id: "x", issue: 3 }] })).toBe(true);
    expect(rm.isEmpty({ criteria: [], notes: t("n") })).toBe(false);
    expect(rm.isEmpty({ criteria: [crit(1, "a")] })).toBe(false);
  });
  it("reviewState", () => {
    expect(rm.reviewState(s(), d)).toEqual({ kind: "button" });
    expect(rm.reviewState(s({ brief: undefined }), d)).toEqual({ kind: "none" });
    expect(rm.reviewState(s({ architect: { state: "running", kind: "round" } }), d)).toEqual({ kind: "none" });
    expect(rm.reviewState(s({ architect: { state: "paused", kind: "suggest", draft: D1, field: "title" } }), d)).toEqual({ kind: "none" });
    expect(rm.reviewState(s(), { id: D1, criteria: [] }).kind).toBe("hint");
    expect(rm.reviewState(s(), { id: D1, criteria: [], dependsOn: [{ id: "x", issue: 3 }] }).kind).toBe("hint");
    expect(rm.reviewState(s(), { id: D1, criteria: [], notes: t("n") })).toEqual({ kind: "button" });
    expect(rm.reviewState(s({ architect: run("queued") }), d)).toEqual({ kind: "line", again: "" });
    expect(rm.reviewState(s({ architect: run("running") }), d)).toEqual({ kind: "line", again: "" });
    expect(rm.reviewState(s({ architect: run("paused") }), d)).toEqual({ kind: "line", again: "Ask again" });
    expect(rm.reviewState(s({ architect: run("failed") }), d)).toEqual({ kind: "line", again: "Try again" });
    expect(rm.reviewState(s({ architect: run("running", { draft: D2 }) }), d)).toEqual({ kind: "none" });
    expect(rm.reviewState(s({ architect: run("failed", { draft: D2 }) }), d)).toEqual({ kind: "button" });
  });
  it("canMove", () => {
    const base = { id: D1, criteria: [] };
    expect(rm.canMove({ ...base, remarks: [{ field: "what", kind: "plan", text: "x" }] }, "what")).toBe(true);
    expect(rm.canMove({ ...base, remarks: [{ field: "what", kind: "vague", text: "x" }] }, "what")).toBe(false);
    expect(rm.canMove({ ...base, review: { remarks: [{ field: "what", kind: "how", text: "x" }] } }, "what")).toBe(true);
    expect(rm.canMove({ ...base, review: { remarks: [{ field: "what", kind: "plan", text: "x", stale: true }] } }, "what")).toBe(false);
    expect(rm.canMove({ ...base, review: { remarks: [{ field: "what", kind: "vague", text: "x" }] } }, "what")).toBe(false);
    const c = { ...base, review: { remarks: [{ field: "criteria", item: "C1", kind: "how", text: "x" }] } };
    expect(rm.canMove(c, "criteria", "C1")).toBe(true);
    expect(rm.canMove(c, "criteria", "C2")).toBe(false);
    expect(rm.canMove(c, "what")).toBe(false);
  });
  it("remarksAt of a draft with neither remarks nor review", () => {
    expect(rm.remarksAt({ id: D1 }, "what")).toEqual({ code: [], review: [] });
    expect(rm.orphanRemarks({ id: D1 })).toEqual([]);
    expect(rm.remarkNodes({ id: D1 }, "what")).toEqual([]);
  });
  it("reviewLogText", () => {
    expect(rm.reviewLogText({ what: "review-asked", who: "Ann" })).toBe("Ann asked the architect to review a story draft");
    expect(rm.reviewLogText({ what: "architect-reviewed", detail: "0" })).toBe("The architect reviewed a story draft: no remarks");
    expect(rm.reviewLogText({ what: "architect-reviewed", detail: "1" })).toBe("The architect reviewed a story draft: 1 remark");
    expect(rm.reviewLogText({ what: "architect-reviewed", detail: "3" })).toBe("The architect reviewed a story draft: 3 remarks");
    expect(rm.reviewLogText({ what: "architect-reviewed" })).toBe("The architect reviewed a story draft");
    expect(rm.reviewLogText({ what: "moved-to-notes", who: "Ann", detail: "criteria" })).toBe("Ann moved a criterion to the notes for the builder");
    expect(rm.reviewLogText({ what: "moved-to-notes", who: "Ann", detail: "title" })).toBe("Ann moved the title to the notes for the builder");
    expect(rm.reviewLogText({ what: "moved-to-notes", who: "Ann" })).toBe("Ann moved a text to the notes for the builder");
    expect(rm.reviewLogText({ what: "created" })).toBe("");
  });
  it("KIND_WORDS has a word for each kind", () => {
    for (const k of ["uncheckable", "vague", "contradiction", "how", "plan"]) expect(rm.KIND_WORDS[k]).toBeTruthy();
  });
});

describe("api", () => {
  it("sends the right requests", async () => {
    await api.reviewDraft("a b", D1).catch(() => {});
    await api.moveToNotes("a b", D1, { field: "what" }).catch(() => {});
    expect(sent.map((x) => [x.method, x.url, x.body])).toEqual([
      ["POST", `/api/refinement/a%20b/drafts/${D1}/review`, {}],
      ["POST", `/api/refinement/a%20b/drafts/${D1}/move-to-notes`, { field: "what" }],
    ]);
  });
  it("a 401 does not reload the page", async () => {
    mode = 401;
    await expect(api.reviewDraft("s1", D1)).rejects.toMatchObject({ status: 401 });
    await expect(api.moveToNotes("s1", D1, {})).rejects.toMatchObject({ status: 401 });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("live remarks after a save", () => {
  it("shows a remark under the field without touching it", async () => {
    await withDraft();
    const el = field("what");
    (document as any).activeElement = el;
    type(el, "It must be fast");
    await wait(SAVE());
    expect(rem("what").textContent).toContain('"fast" is vague');
    expect(field("what")).toBe(el);
    expect((document as any).activeElement).toBe(el);
    expect(el.value).toBe("It must be fast");
    type(el, "It answers in 2 seconds");
    await wait(SAVE());
    expect(rem("what").textContent).toBe("");
  });
  it("shows a remark under a new criterion", async () => {
    await withDraft();
    const ta = areaOf(critRows()[0]!);
    type(ta, "The page is simple");
    await wait(SAVE());
    expect(critRows()[0]!.textContent).toContain('"simple" is vague');
    expect(areaOf(critRows()[0]!)).toBe(ta);
    type(ta, "The page shows three fields");
    await wait(SAVE());
    expect(critRows()[0]!.textContent).not.toContain("vague");
  });
  it("the notes get no remark box", async () => {
    await withDraft();
    type(field("notes"), "fast");
    await wait(SAVE());
    expect(walk(section()).some((e) => e.attrs["data-remarks"] === "notes")).toBe(false);
    expect(section().textContent).not.toContain("is vague");
  });
});

describe("Review draft", () => {
  const post = () => sent.filter((x) => x.url.endsWith("/review"));
  it("saves typed text first, then asks; shows the line and no button", async () => {
    await withDraft({ title: t("T") });
    type(field("notes"), "my notes");
    await press(button("Review draft"));
    expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
    expect(post().length).toBe(1);
    expect(reviewBox().textContent).toContain("The architect is reviewing your draft.");
    expect(button("Review draft")).toBeUndefined();
    expect(upper().textContent).not.toContain("reviewing your draft");
  });
  it("queued", async () => {
    over = { architect: run("queued") };
    await withDraft({ title: t("T") });
    expect(reviewBox().textContent).toContain("The architect is waiting for its turn.");
    expect(reviewBox().textContent).toContain("Then it reviews your draft.");
  });
  it("paused: Ask again", async () => {
    over = { architect: run("paused") };
    await withDraft({ title: t("T") });
    expect(reviewBox().textContent).toContain("Out of time.");
    await press(button("Ask again", reviewBox()));
    expect(post().length).toBe(1);
  });
  it("failed: Try again", async () => {
    over = { architect: run("failed") };
    await withDraft({ title: t("T") });
    expect(reviewBox().textContent).toContain("The architect could not finish.");
    expect(button("Try again", reviewBox())).toBeDefined();
  });
  it("asks nothing when the save fails", async () => {
    await withDraft({ title: t("T") });
    type(field("notes"), "my notes");
    mode = 400;
    modeFor = /\/drafts\/[^/]+$/;
    await press(button("Review draft"));
    expect(post().length).toBe(0);
    expect(toastText()).toContain("could not be saved");
  });
  it("no brief", async () => {
    over = { brief: undefined };
    await withDraft({ title: t("T") });
    expect(button("Review draft")).toBeUndefined();
  });
  it("an empty draft gets a hint", async () => {
    await withDraft({ dependsOn: [{ id: "x", issue: 4 }] });
    expect(button("Review draft")).toBeUndefined();
    expect(reviewBox().textContent).toContain("Write something in the draft first");
  });
  it("a round that runs: no button, no line", async () => {
    over = { architect: { state: "running", kind: "round" } };
    await withDraft({ title: t("T") });
    expect(button("Review draft")).toBeUndefined();
    expect(reviewBox().textContent).toBe("");
  });
  it("a run for a closed draft shows at the top", async () => {
    over = { architect: run("paused") };
    state.drafts = [{ id: D1, title: t("Plain title"), criteria: [], dependsOn: [] }];
    await show();
    expect(section().textContent).toContain("The architect paused.");
    expect(section().textContent).toContain('Open the draft "Plain title" to ask again.');
    await press(button("Open"));
    expect(reviewBox().textContent).toContain("The architect paused.");
    expect(section().textContent).not.toContain("Open the draft");
  });
  it("shows the server's sentence for a 409", async () => {
    await withDraft({ title: t("T") });
    mode = 409;
    await press(button("Review draft"));
    expect(toastText()).toBe("The server said no");
  });
});

describe("the architect's remarks", () => {
  it("shows each kind in words next to its field or criterion", async () => {
    await withDraft({
      title: t("A title"), what: t("I want a thing"), criteria: [crit(1, "It shows a table")],
      ...review([
        { field: "title", kind: "vague", text: "Too broad.", about: "A title" },
        { field: "what", kind: "contradiction", text: "Clashes with the title.", about: "I want a thing" },
        { field: "criteria", item: "C1", kind: "uncheckable", text: "Nobody can see this.", about: "It shows a table" },
        { field: "why", kind: "how", text: "Says how.", about: "y" },
      ]),
    });
    expect(rem("title").textContent).toContain("Vague");
    expect(rem("what").textContent).toContain("Contradicts");
    expect(rem("crit-C1").textContent).toContain("Cannot be checked");
    expect(rem("crit-C1").textContent).toContain("Nobody can see this.");
    expect(rem("title").textContent).not.toContain("written before");
    expect(reviewBox().textContent).toContain("Reviewed ");
  });
  it("says when there is nothing to remark", async () => {
    await withDraft({ title: t("T"), ...review([]) });
    expect(reviewBox().textContent).toContain("The architect found nothing to remark.");
  });
  it("a stale remark says so; typing and saving makes one stale", async () => {
    await withDraft({
      title: t("New title"), what: t("I want a thing"),
      ...review([
        { field: "title", kind: "vague", text: "Too broad.", about: "Old title" },
        { field: "what", kind: "vague", text: "Too vague.", about: "I want a thing" },
      ]),
    });
    expect(rem("title").textContent).toContain("written before your last change");
    expect(rem("what").textContent).not.toContain("written before");
    const el = field("what");
    (document as any).activeElement = el;
    type(el, "I want another thing");
    await wait(SAVE());
    expect(rem("what").textContent).toContain("written before your last change");
    expect(field("what")).toBe(el);
    expect(el.value).toBe("I want another thing");
  });
  it("shows remarks about a gone criterion once each, as stale", async () => {
    await withDraft({
      title: t("T"),
      ...review([
        { field: "criteria", item: "C9", kind: "vague", text: "First.", about: "gone" },
        { field: "criteria", item: "C9", kind: "uncheckable", text: "Second.", about: "gone" },
      ]),
    });
    const text = rem("criteria").textContent;
    expect(text.match(/First\./g)?.length).toBe(1);
    expect(text.match(/Second\./g)?.length).toBe(1);
    expect(text).toContain("written before your last change");
  });
  it("sets a remark text as text", async () => {
    await withDraft({ title: t("T"), ...review([{ field: "title", kind: "vague", text: "<b>x</b>", about: "T" }]) });
    expect(rem("title").textContent).toContain("<b>x</b>");
    expect(walk(rem("title")).some((e) => e.tag === "b")).toBe(false);
  });
});

describe("Move to notes", () => {
  const PLAN = "Add a table in src/db/schema.ts for users";
  const moves = () => sent.filter((x) => x.url.endsWith("/move-to-notes"));
  it("a criterion with a plan: sentence and button; a refusal sends nothing", async () => {
    await withDraft({ criteria: [crit(1, PLAN)] });
    expect(rem("crit-C1").textContent).toContain("belongs in the build step");
    confirmAnswer = false;
    await press(button(rm.MOVE));
    expect(confirms).toBe(1);
    expect(sent.length).toBe(0);
  });
  it("moves a criterion", async () => {
    await withDraft({ criteria: [crit(1, PLAN)] });
    await press(button(rm.MOVE));
    expect(moves()[0]!.body).toEqual({ field: "criteria", item: "C1" });
    expect(critRows().filter((r) => r.textContent.includes("src/db"))).toEqual([]);
    expect(field("notes").value.startsWith("Wish: ")).toBe(true);
    expect(section().textContent).toContain("Wish: Add a table");
    expect(section().textContent).not.toContain("Not saved");
  });
  it("moves a field after a review remark", async () => {
    await withDraft({ what: t("I want a loop over the rows"), ...review([{ field: "what", kind: "how", text: "Says how.", about: "I want a loop over the rows" }]) });
    expect(rem("what").textContent).toContain("This belongs in the build step.");
    await press(button(rm.MOVE));
    expect(moves()[0]!.body).toEqual({ field: "what" });
    expect(field("what").value).toBe("");
    expect(field("notes").value).toContain("Wish: I want a loop");
  });
  it("a stale plan remark and a vague remark have no button", async () => {
    await withDraft({
      what: t("New"), title: t("T"),
      ...review([
        { field: "what", kind: "plan", text: "Plan.", about: "Old" },
        { field: "title", kind: "vague", text: "Vague.", about: "T" },
      ]),
    });
    expect(rem("what").textContent).toContain("This belongs in the build step.");
    expect(button(rm.MOVE)).toBeUndefined();
  });
  it("saves other typed text first", async () => {
    await withDraft({ criteria: [crit(1, PLAN)] });
    type(field("outOfScope"), "Not the admin");
    await press(button(rm.MOVE));
    expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
    expect(field("outOfScope").value).toBe("Not the admin");
    expect(dr.unsaved.size).toBe(0);
  });
  it("a failing save before it: nothing moves and the text is kept", async () => {
    await withDraft({ criteria: [crit(1, PLAN)] });
    const ta = areaOf(critRows()[0]!);
    type(ta, `${PLAN} and an index`);
    mode = 400;
    modeFor = /\/drafts\/[^/]+$/;
    await press(button(rm.MOVE));
    expect(moves().length).toBe(0);
    expect(toastText()).toContain("nothing was moved");
    expect(ta.value).toBe(`${PLAN} and an index`);
    expect(dr.unsaved.size).toBe(1);
    expect(field("notes").value).toBe("");
  });
  it("text typed while the move is in flight is kept and saved", async () => {
    await withDraft({ what: t("I want a loop"), ...review([{ field: "what", kind: "how", text: "Says how.", about: "I want a loop" }]) });
    let open!: () => void;
    gate = new Promise<void>((r) => {
      open = r;
    });
    await press(button(rm.MOVE));
    type(field("what"), "I want a better thing");
    open();
    await flush();
    expect(dr.unsaved.size).toBe(1);
    expect(field("what").value).toBe("I want a better thing");
    await wait(SAVE());
    expect(dr.unsaved.size).toBe(0);
    expect(sent.at(-1)).toMatchObject({ method: "PUT", body: { what: "I want a better thing" } });
    expect(field("what").value).toBe("I want a better thing");
  });
  it("a failing move keeps the text and shows a toast", async () => {
    await withDraft({ what: t("I want a loop"), ...review([{ field: "what", kind: "how", text: "Says how.", about: "I want a loop" }]) });
    mode = 400;
    modeFor = /move-to-notes/;
    await press(button(rm.MOVE));
    expect(toastText()).toBe("The server said no");
    expect(field("what").value).toBe("I want a loop");
  });
});

describe("who sees what", () => {
  const seeded = { what: t("It must be fast"), ...review([{ field: "what", kind: "vague", text: "REMARK-TEXT", about: "It must be fast" }]), criteria: [crit(1, "Add a table in src/db/schema.ts")] };
  const none = () => {
    const text = section().textContent;
    expect(text).not.toContain("REMARK-TEXT");
    expect(text).not.toContain("is vague");
    expect(text).not.toContain("Reviewed");
    expect(button("Review draft")).toBeUndefined();
    expect(button(rm.MOVE)).toBeUndefined();
  };
  const readOnly = async (extra: object) => {
    over = extra;
    state.drafts = [{ id: D1, criteria: [], dependsOn: [], ...seeded }];
    await show();
    none();
  };
  it("a dropped session", () => readOnly({ state: "dropped" }));
  it("another person's session", () => readOnly({ mine: false }));
  it("a repository that is not available", () => readOnly({ repoAvailable: false }));
  it("hidden drafts", () => readOnly({ draftsHidden: true }));
  it("the owner sees them", async () => {
    await withDraft(seeded);
    expect(rem("what").textContent).toContain("REMARK-TEXT");
    expect(button("Review draft")).toBeDefined();
    expect(button(rm.MOVE)).toBeDefined();
  });
});
