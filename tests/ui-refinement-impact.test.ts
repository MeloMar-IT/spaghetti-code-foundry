import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinementError } from "../src/refinement/errors.js";
import { draftMark, impactView, setReviewLabel } from "../src/refinement/draft-impact.js";
import { newDraft, preview, saveTyped } from "../src/refinement/draft.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let im: any;
let tk: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  im = await import("../ui/refinement-impact.js" as string);
  tk = await import("../ui/refinement-talk.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const reload = vi.fn();
let state: { drafts: any[]; epic: number | undefined };
let over: any;
let sent: { method: string; url: string; body: any }[];
let mode: "ok" | number;
let modeFor: RegExp;
let limits: { maxFiles?: number; maxCodeLines?: number; reviewLabel?: string };
let cleanup: (() => void) | undefined;

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", runId: "r" };
const AT = "2026-03-01T10:20:00.000Z";
const LIMITS = { maxFiles: 15, maxCodeLines: 800, reviewLabel: "plan-review" };
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "drafting", architect: { state: "idle" }, brief: BRIEF,
  talk: { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] },
  drafts: over.draftsHidden
    ? undefined
    : state.drafts.map((d) => {
      const { impact: _i, review: _r, ...rest } = d;
      const iv = impactView(d, state.drafts as any, [], limits);
      return { ...rest, preview: preview(d, state as any), remarks: [], ...(iv ? { impact: iv } : {}) };
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
  limits = { ...LIMITS };
  dr.unsaved.clear();
  dr.opened.clear();
  reload.mockClear();
  (document as any).getElementById("toast").textContent = "";
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).activeElement = null;
  (globalThis as any).location = { hash: "#/refinement/s1", reload };
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") return reply(view());
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (mode !== "ok" && modeFor.test(url)) {
      if (mode === 401) return reply({ error: "sign in first" }, 401);
      return reply({ error: "The server said no" }, mode);
    }
    try {
      const body = init.body ? JSON.parse(init.body) : {};
      const m = /\/drafts\/([^/]+)(?:\/(impact|review-label))?$/.exec(url);
      if (m?.[2] === "impact") over = { ...over, architect: { state: "running", kind: "impact", draft: m[1], doing: "x" } };
      else if (m?.[2] === "review-label") apply(setReviewLabel(state as any, m[1]!, body));
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
});

const apply = (c: any) => {
  if (c) state = { drafts: c.drafts, epic: c.epic };
};
const flush = () => vi.advanceTimersByTimeAsync(0);
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const section = () => walk(main()).find((e) => e.attrs.class === "drafts")!;
const box = () => walk(section()).find((e) => e.attrs["data-impact"] !== undefined)!;
const card = () => walk(section()).find((e) => e.attrs.class === "card impact")!;
const buttons = (root: FakeElement = section()) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root?: FakeElement) => buttons(root).find((e) => e.textContent === t);
const field = (name: string) => walk(section()).find((e) => e.attrs.name === name)!;
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
const t = (text: string) => ({ text, from: "typed" });
const SAVE = () => (dr.SAVE_MS as number) + 10;
const checkbox = () => walk(box()).find((e) => e.tag === "input" && e.attrs.type === "checkbox")!;
const tick = async (cb: FakeElement, on: boolean) => {
  (cb as any).checked = on;
  cb.fire("change", { currentTarget: cb });
  await flush();
};

const base = (extra: object = {}) => ({ id: D1, title: t("Export rows"), criteria: [], dependsOn: [], ...extra });
/** A valid stored view that is fresh for `draft`. */
const stored = (draft: any, extra: object = {}) => ({
  at: AT, mark: draftMark(draft),
  areas: [{ area: "src/export", files: ["src/export/csv.ts", "src/export/index.ts"], basis: "found", why: "The export code lives here." }],
  dependsOn: [{ issue: 12, basis: "found", why: "It reads the table from #12." }, { draft: D2, basis: "estimate", why: "Needs the other draft first." }],
  dependents: [],
  risks: [{ kind: "security", basis: "estimate", text: "A file leaves the system." }],
  size: { size: "small", files: 3, lines: 120, why: "A small change in one area." },
  overlaps: [], sensitive: [],
  ...extra,
});
const withView = (extra: object = {}, draft: object = {}, ...more: any[]) => {
  const d = base(draft);
  state.drafts = [{ ...d, impact: stored(d, extra) }, ...more];
};
const withDraft = async (d: object = {}) => {
  state.drafts = [base(d)];
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
  await press(button("Open"));
};
const open = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
  await press(button("Open"));
};
const show = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
};
const run = (st: string, extra: object = {}) => ({ state: st, kind: "impact", draft: D1, doing: "x", reason: "Out of time", ...extra });

describe("pure functions", () => {
  const d = { id: D1, title: t("T"), criteria: [] };
  const s = (extra: object = {}) => ({ brief: BRIEF, architect: { state: "idle" }, drafts: [d], ...extra });
  it("impactState", () => {
    expect(im.impactState(s(), d)).toEqual({ kind: "button", label: im.ASK_VIEW });
    expect(im.impactState(s(), { ...d, impact: {} })).toEqual({ kind: "button", label: im.ASK_AGAIN });
    expect(im.impactState(s({ architect: run("queued") }), d)).toEqual({ kind: "line", again: "" });
    expect(im.impactState(s({ architect: run("running") }), d)).toEqual({ kind: "line", again: "" });
    expect(im.impactState(s({ architect: run("paused") }), d)).toEqual({ kind: "line", again: "Ask again" });
    expect(im.impactState(s({ architect: run("failed") }), d)).toEqual({ kind: "line", again: "Try again" });
    expect(im.impactState(s({ architect: { state: "running", kind: "review", draft: D1 } }), d)).toEqual({ kind: "none" });
    expect(im.impactState(s({ architect: { state: "failed", kind: "review", draft: D1 } }), d).kind).toBe("button");
    expect(im.impactState(s({ architect: run("running", { draft: D2 }) }), d)).toEqual({ kind: "none" });
    expect(im.impactState(s({ brief: undefined }), d)).toEqual({ kind: "none" });
    expect(im.impactState(s(), { id: D1, criteria: [] }).kind).toBe("hint");
  });
  it("impactKey changes with the choice, the mark and another draft's title", () => {
    const k = (x: any, y: any) => im.impactKey(x, y);
    const v = { areas: [] };
    expect(k(s(), { ...d, impact: v })).not.toBe(k(s(), { ...d, impact: v, addReviewLabel: true }));
    expect(k(s(), { ...d, impact: v })).not.toBe(k(s(), { ...d, impact: { ...v, outOfDate: true } }));
    expect(k(s({ drafts: [d, { id: D2, title: t("A") }] }), d)).not.toBe(k(s({ drafts: [d, { id: D2, title: t("B") }] }), d));
  });
  it("impactLogText", () => {
    expect(im.impactLogText({ what: "impact-asked", who: "Ann" })).toBe("Ann asked for the architect's view of a story draft");
    expect(im.impactLogText({ what: "architect-impact", detail: "large" })).toBe("The architect wrote its view of a story draft: large");
    expect(im.impactLogText({ what: "architect-impact", detail: "huge" })).toBe("The architect wrote its view of a story draft");
    expect(im.impactLogText({ what: "created" })).toBe("");
    expect(ui.logText({ what: "impact-asked", who: "Ann" })).toBe("Ann asked for the architect's view of a story draft");
  });
  it("has words for every server value", () => {
    for (const k of ["found", "estimate"]) expect(im.BASIS_WORDS[k]).toBeTruthy();
    for (const k of ["data", "security", "compatibility", "users"]) expect(im.RISK_WORDS[k]).toBeTruthy();
    for (const k of ["small", "medium", "large"]) expect(im.SIZE_WORDS[k]).toBeTruthy();
  });
  it("kindOf knows impact", () => {
    expect(tk.kindOf({ kind: "impact" })).toBe("impact");
  });
});

describe("api", () => {
  it("sends the right requests", async () => {
    await api.askImpact("a b", D1).catch(() => {});
    await api.setReviewLabel("a b", D1, true).catch(() => {});
    expect(sent.map((x) => [x.method, x.url, x.body])).toEqual([
      ["POST", `/api/refinement/a%20b/drafts/${D1}/impact`, {}],
      ["PUT", `/api/refinement/a%20b/drafts/${D1}/review-label`, { add: true }],
    ]);
  });
  it("a 401 does not reload the page", async () => {
    mode = 401;
    await expect(api.askImpact("s1", D1)).rejects.toMatchObject({ status: 401 });
    await expect(api.setReviewLabel("s1", D1, false)).rejects.toMatchObject({ status: 401 });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("asking", () => {
  const post = () => sent.filter((x) => x.url.endsWith("/impact"));
  it("no view: heading, sentence and button; saves typed text first; then the line", async () => {
    await withDraft();
    expect(box().textContent).toContain(im.VIEW_TITLE);
    expect(box().textContent).toContain(im.NO_VIEW);
    type(field("notes"), "my notes");
    await press(button(im.ASK_VIEW));
    expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
    expect(box().textContent).toContain("The architect is looking at what your draft touches.");
    expect(button(im.ASK_VIEW)).toBeUndefined();
  });
  it("paused: Ask again; failed: Try again", async () => {
    over = { architect: run("paused") };
    await withDraft();
    await press(button("Ask again", box()));
    expect(post().length).toBe(1);
    sent = [];
    over = { architect: run("failed") };
    state.drafts = [base()];
    dr.opened.clear();
    cleanup?.();
    await open();
    await press(button("Try again", box()));
    expect(post().length).toBe(1);
  });
  it("a failing save asks nothing", async () => {
    await withDraft();
    type(field("notes"), "my notes");
    mode = 400;
    modeFor = /\/drafts\/[^/]+$/;
    await press(button(im.ASK_VIEW));
    expect(post().length).toBe(0);
    expect(toastText()).toContain("could not be saved");
  });
  it("no brief: no button", async () => {
    over = { brief: undefined };
    await withDraft();
    expect(button(im.ASK_VIEW)).toBeUndefined();
  });
  it("a round that runs: no button and no line", async () => {
    over = { architect: { state: "running", kind: "round" } };
    await withDraft();
    expect(button(im.ASK_VIEW)).toBeUndefined();
    expect(box().textContent).not.toContain("The architect is");
  });
  it("a run for a closed draft shows at the top", async () => {
    over = { architect: run("paused") };
    state.drafts = [base()];
    await show();
    expect(section().textContent).toContain("The architect paused.");
    expect(section().textContent).toContain('Open the draft "Export rows" to ask again.');
  });
  it("an empty draft gets a hint and nothing is sent", async () => {
    await withDraft({ title: undefined });
    expect(box().textContent).toContain(im.WRITE_FIRST_VIEW);
    expect(button(im.ASK_VIEW)).toBeUndefined();
    expect(sent.length).toBe(0);
  });
});

describe("the view", () => {
  it("a small draft", async () => {
    withView({}, {}, { id: D2, title: t("Other draft"), criteria: [], dependsOn: [] });
    await open();
    const text = box().textContent;
    for (const w of ["Small", "about 3 files and 120 lines of code", "likely fits in one story", "15 files and 800 lines", "src/export", "src/export/csv.ts", "The export code lives here."]) expect(text).toContain(w);
    expect(text).toContain("#12");
    expect(text).toContain("Other draft (draft)");
    expect(text).toContain("Security");
    expect(text).toContain("A file leaves the system.");
    expect(text).not.toContain(im.OUT_OF_DATE);
    // every statement has a mark: each li and each size/fit paragraph holds a pill
    const pills = (el: FakeElement) => walk(el).filter((e) => e.attrs.class === "pill" && /found in the code|estimate/.test(e.textContent)).length;
    for (const li of walk(box()).filter((e) => e.tag === "li")) expect(pills(li), li.textContent).toBe(1);
    const size = walk(box()).filter((e) => e.tag === "p" && /about 3 files|A small change|fits in one story/.test(e.textContent));
    expect(size.length).toBe(3);
    for (const p of size) expect(pills(p), p.textContent).toBe(1);
  });
  it("a too-big draft", async () => {
    withView({ size: { size: "large", files: 20, lines: 1200, why: "Many areas." } });
    await open();
    expect(box().textContent).toContain("Large");
    expect(box().textContent).toContain("likely too big — consider splitting");
  });
  it("without limits the fit is unknown", async () => {
    limits = {};
    withView();
    await open();
    expect(box().textContent).toContain("the build limits are not known");
  });
  it("an overlap with a found issue and an estimated draft", async () => {
    withView({
      overlaps: [
        { issue: 31, areas: ["src/export"], basis: "found", why: "Being built." },
        { draft: D2, areas: ["src/export"], basis: "estimate", why: "Reads alike." },
      ],
    }, {}, { id: D2, title: t("Other draft"), criteria: [], dependsOn: [] });
    await open();
    const lis = walk(box()).filter((e) => e.tag === "li" && e.textContent.includes("src/export") && /Being built|Reads alike/.test(e.textContent));
    expect(lis.length).toBe(2);
    expect(lis[0]!.textContent).toContain("#31");
    expect(lis[0]!.textContent).toContain(im.OVERLAP_FOUND);
    expect(lis[1]!.textContent).toContain("Other draft (draft)");
    expect(lis[1]!.textContent).toContain(im.OVERLAP_ESTIMATE);
    expect(lis[1]!.textContent).not.toContain(im.OVERLAP_FOUND);
  });
  it("no overlaps", async () => {
    withView();
    await open();
    expect(box().textContent).toContain("No other open story or draft named.");
  });
  it("text is text", async () => {
    withView({ risks: [{ kind: "data", basis: "estimate", text: "<img src=x onerror=1>" }] });
    await open();
    expect(box().textContent).toContain("<img src=x onerror=1>");
    expect(walk(box()).some((e) => e.tag === "img")).toBe(false);
  });
  it("never shows hours or days", async () => {
    withView();
    await open();
    expect(box().textContent).not.toMatch(/\b(hours?|days?|weeks?)\b/i);
  });
});

describe("the plan review", () => {
  const sensitive = [{ topic: "secrets", basis: "found", why: "It reads a token." }];
  it("shows why and an unchecked checkbox; ticking and unticking", async () => {
    withView({ sensitive });
    await open();
    expect(box().textContent).toContain("A plan review by a person is recommended");
    expect(box().textContent).toContain("secrets");
    expect(box().textContent).toContain("It reads a token.");
    expect(box().textContent).toContain("Add the review label when this story is published");
    expect(box().textContent).toContain("plan-review");
    expect((checkbox() as any).checked).toBeFalsy();
    await tick(checkbox(), true);
    expect(sent.at(-1)).toMatchObject({ method: "PUT", body: { add: true } });
    expect((checkbox() as any).checked).toBe(true);
    await tick(checkbox(), false);
    expect(sent.at(-1)).toMatchObject({ body: { add: false } });
    expect((checkbox() as any).checked).toBeFalsy();
  });
  it("a failing route gives a toast and no checked box", async () => {
    withView({ sensitive });
    await open();
    mode = 500;
    await tick(checkbox(), true);
    expect(toastText()).toContain("The server said no");
    expect((checkbox() as any).checked).toBeFalsy();
  });
  it("no review label: the text shows, no checkbox", async () => {
    limits = { maxFiles: 15, maxCodeLines: 800 };
    withView({ sensitive });
    await open();
    expect(box().textContent).toContain("There is no review label.");
    expect(walk(box()).some((e) => e.tag === "input")).toBe(false);
  });
  it("the recommendation carries the estimate mark", async () => {
    withView({ sensitive });
    await open();
    const p = walk(box()).find((e) => e.tag === "p" && e.textContent.includes("A plan review by a person"))!;
    expect(p.textContent).toContain("estimate");
  });
  it("a stored choice is shown and can be cleared when nothing is recommended now", async () => {
    withView({}, { addReviewLabel: true });
    await open();
    expect(box().textContent).toContain("No review label is offered now");
    expect((checkbox() as any).checked).toBe(true);
    await tick(checkbox(), false);
    expect(sent.at(-1)).toMatchObject({ method: "PUT", body: { add: false } });
    expect(box().textContent).not.toContain("No review label is offered now");
  });
  it("a stored choice without any view is shown too, and read-only as a sentence", async () => {
    state.drafts = [base({ addReviewLabel: true })];
    await open();
    expect(checkbox()).toBeDefined();
    cleanup?.();
    over = { mine: false };
    await show();
    expect(card().textContent).toContain("You chose to add the review label");
    expect(walk(card()).filter((e) => e.tag === "button" || e.tag === "input")).toEqual([]);
  });
  it("no sensitive topic: no heading", async () => {
    withView();
    await open();
    expect(box().textContent).not.toContain("Plan review");
  });
});

describe("out of date", () => {
  it("is marked after typing, with a button to ask again", async () => {
    withView();
    await open();
    expect(box().textContent).not.toContain(im.OUT_OF_DATE);
    type(field("title"), "Export all rows");
    await wait(SAVE());
    expect(box().textContent).toContain(im.OUT_OF_DATE);
    expect(box().textContent).toContain(im.OUT_OF_DATE_WHY);
    expect(button(im.ASK_AGAIN, box())).toBeDefined();
  });
  it("is marked after the notes change", async () => {
    withView();
    await open();
    type(field("notes"), "Keep it small");
    await wait(SAVE());
    expect(box().textContent).toContain(im.OUT_OF_DATE);
  });
});

describe("advice only", () => {
  it("has only the ask button and the checkbox, disables nothing, changes no field", async () => {
    withView({ sensitive: [{ topic: "secrets", basis: "found", why: "It reads a token." }] });
    await open();
    const title = field("title").value;
    expect(buttons(box()).map((b) => b.textContent)).toEqual([im.ASK_AGAIN]);
    expect(walk(box()).filter((e) => e.tag === "input").length).toBe(1);
    expect(walk(section()).filter((e) => e.disabled && e.attrs["aria-hidden"] !== "true")).toEqual([]);
    expect(field("title").value).toBe(title);
  });
});

describe("who sees what", () => {
  const sensitive = [{ topic: "secrets", basis: "found", why: "It reads a token." }];
  const seed = () => {
    const d = base({ addReviewLabel: true });
    state.drafts = [{ ...d, impact: stored(d, { sensitive }) }];
  };
  for (const extra of [{ mine: false }, { state: "dropped" }]) {
    it(`read-only: ${JSON.stringify(extra)}`, async () => {
      over = extra;
      seed();
      await show();
      expect(card().textContent).toContain("The export code lives here.");
      expect(walk(card()).filter((e) => e.tag === "button" || e.tag === "input")).toEqual([]);
      expect(card().textContent).toContain('The review label "plan-review" is added when this story is published.');
    });
  }
  it("hidden drafts: nothing shows", async () => {
    over = { draftsHidden: true };
    seed();
    await show();
    expect(section().textContent).not.toContain("The export code lives here.");
  });
  it("a draft without a view has no card", async () => {
    over = { mine: false };
    state.drafts = [base()];
    await show();
    expect(walk(section()).some((e) => e.attrs.class === "card impact")).toBe(false);
  });
  it("the owner sees the buttons", async () => {
    seed();
    await open();
    expect(button(im.ASK_AGAIN)).toBeDefined();
    expect(checkbox()).toBeDefined();
  });
});
