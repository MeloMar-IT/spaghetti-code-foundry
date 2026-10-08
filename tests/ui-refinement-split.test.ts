import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinementError } from "../src/refinement/errors.js";
import { draftMark } from "../src/refinement/draft-impact.js";
import { newDraft, preview, saveTyped } from "../src/refinement/draft.js";
import { confirmSplit } from "../src/refinement/draft-parts.js";
import { SPLIT_CUTS, splitView } from "../src/refinement/draft-split.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let sp: any;
let tk: any;
let api: any;
let apiMod: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  sp = await import("../ui/refinement-split.js" as string);
  tk = await import("../ui/refinement-talk.js" as string);
  apiMod = await import("../ui/api.js" as string);
  api = apiMod.api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const reload = vi.fn();
let state: { drafts: any[]; epic: number | undefined };
let over: any;
let sent: { method: string; url: string; body: any }[];
let mode: "ok" | number;
let modeFor: RegExp;
let cleanup: (() => void) | undefined;

const D1 = "11111111-1111-4111-8111-111111111111";
const C1 = "c1111111-1111-4111-8111-111111111111";
const C2 = "c2222222-2222-4222-8222-222222222222";
const C3 = "c3333333-3333-4333-8333-333333333333";
const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", runId: "r" };
const AT = "2026-03-01T10:20:00.000Z";
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "drafting", architect: { state: "idle" }, brief: BRIEF,
  talk: { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] },
  drafts: over.draftsHidden
    ? undefined
    : state.drafts.map((d) => {
      const { split: _s, ...rest } = d;
      const v = splitView(d);
      return { ...rest, state: d.splitInto ? "split" : "drafting", preview: preview(d, state as any), remarks: [], ...(v ? { split: v } : {}) };
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
  dr.unsaved.clear();
  dr.opened.clear();
  sp.splitLocal.clear();
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
      const m = /\/drafts\/([^/]+)(?:\/(split\/confirm|split))?$/.exec(url);
      if (m?.[2] === "split/confirm") apply(confirmSplit(state as any, m[1]!, body));
      else if (m?.[2] === "split") over = { ...over, architect: { state: "running", kind: "split", draft: m[1], doing: "x" } };
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
  apiMod.setViewAs("");
});

const apply = (c: any) => {
  if (c) state = { drafts: c.drafts, epic: c.epic };
};
const flush = () => vi.advanceTimersByTimeAsync(0);
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const section = () => walk(main()).find((e) => e.attrs.class === "drafts")!;
const box = () => walk(section()).find((e) => e.attrs["data-split"] !== undefined)!;
const card = () => walk(section()).find((e) => e.attrs.class === "card split")!;
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
const titles = () => walk(box()).filter((e) => e.tag === "input" && (e.attrs["aria-label"] ?? "").startsWith("Title of part"));
const mover = (text: string) => walk(box()).find((e) => e.tag === "select" && e.attrs["aria-label"] === `Move: ${text}`)!;
const move = async (text: string, to: string) => {
  const sel = mover(text);
  sel.value = to;
  sel.fire("change", { currentTarget: sel });
  await flush();
};
const problem = () => walk(box()).find((e) => e.attrs["data-split-problem"] !== undefined)!.textContent;
const confirmBtn = () => button(sp.CONFIRM, box())!;
const confirms = () => sent.filter((x) => x.url.endsWith("/split/confirm"));

const crit = [{ id: C1, ...t("Rows are exported") }, { id: C2, ...t("Columns can be chosen") }, { id: C3, ...t("Old formats work") }];
const base = (extra: object = {}) => ({ id: D1, title: t("Export rows"), criteria: crit, dependsOn: [], ...extra });
const WAYS = [
  {
    cut: "step",
    stories: [
      { title: "Export a file", sentence: "Users can export rows to a file.", criteria: [C1], dependsOn: [] },
      { title: "Choose columns", sentence: "Users can choose the columns.", criteria: [C2], dependsOn: [1] },
    ],
    first: "A file with all rows.",
    unplaced: [C3],
    warnings: [{ kind: "layer", story: 2, why: "Only a setting." }, { kind: "same-code", stories: [1, 2], why: "Both change the writer." }],
  },
  {
    cut: "data",
    stories: [
      { title: "Small tables", sentence: "Small tables export.", criteria: [C1, C2], dependsOn: [] },
      { title: "Big tables", sentence: "Big tables export.", criteria: [C3], dependsOn: [] },
    ],
    first: "Small tables work.",
    unplaced: [],
    warnings: [],
  },
];
const withWays = (draft: object = {}, ways: any[] = WAYS) => {
  const d = base(draft);
  state.drafts = [{ ...d, split: { at: AT, mark: draftMark(d as any), ways } }];
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
const run = (st: string, extra: object = {}) => ({ state: st, kind: "split", draft: D1, doing: "x", reason: "Out of time", ...extra });
const useWay = async (n = 1) => {
  withWays();
  await open();
  await press(buttons(box()).filter((b) => b.textContent === sp.USE)[n - 1]);
};

describe("pure functions", () => {
  const d = { id: D1, title: t("T"), criteria: crit };
  const s = (extra: object = {}) => ({ id: "s1", brief: BRIEF, architect: { state: "idle" }, drafts: [d], ...extra });
  it("canSplit", () => {
    expect(sp.canSplit(d)).toBe(true);
    expect(sp.canSplit({ ...d, criteria: [crit[0]] })).toBe(false);
    expect(sp.canSplit({ ...d, splitInto: [D1] })).toBe(false);
    expect(sp.canSplit({ ...d, part: { of: D1 } })).toBe(false);
    expect(sp.canSplit({ ...d, published: { issue: 1 } })).toBe(false);
  });
  it("splitState", () => {
    expect(sp.splitState(s(), d)).toEqual({ kind: "button", label: sp.ASK_SPLIT });
    expect(sp.splitState(s(), { ...d, split: {} })).toEqual({ kind: "button", label: sp.ASK_AGAIN });
    expect(sp.splitState(s({ architect: run("queued") }), d)).toEqual({ kind: "line", again: "" });
    expect(sp.splitState(s({ architect: run("running") }), d)).toEqual({ kind: "line", again: "" });
    expect(sp.splitState(s({ architect: run("paused") }), d)).toEqual({ kind: "line", again: "Ask again" });
    expect(sp.splitState(s({ architect: run("failed") }), d)).toEqual({ kind: "line", again: "Try again" });
    expect(sp.splitState(s({ architect: { state: "running", kind: "impact", draft: D1 } }), d)).toEqual({ kind: "none" });
    expect(sp.splitState(s({ architect: run("running", { draft: "x" }) }), d)).toEqual({ kind: "none" });
    expect(sp.splitState(s({ brief: undefined }), d)).toEqual({ kind: "none" });
    expect(sp.splitState(s(), { ...d, criteria: [crit[0]] })).toEqual({ kind: "none" });
  });
  it("planFromWay and emptyPlan", () => {
    const p = sp.planFromWay(WAYS[0], 0, AT);
    expect(p.way).toBe(0);
    expect(p.at).toBe(AT);
    expect(p.parts.map((x: any) => x.title)).toEqual(["Export a file", "Choose columns"]);
    expect(p.parts[1].dependsOn).toEqual([p.parts[0].key]);
    expect(p.place[C1]).toBe(p.parts[0].key);
    expect(p.place[C3]).toBe("nowhere");
    const e = sp.emptyPlan();
    expect(e.parts.length).toBe(2);
    expect(e.parts.every((x: any) => x.title === "")).toBe(true);
    expect(e.way).toBeUndefined();
    expect(e.place).toEqual({});
  });
  it("planProblem", () => {
    const ok = () => {
      const p = sp.planFromWay(WAYS[0], 0, AT);
      return p;
    };
    expect(sp.planProblem(ok(), d, 1)).toBe("");
    const one = ok();
    one.parts.pop();
    expect(sp.planProblem(one, d, 1)).toBe("A split needs at least 2 parts.");
    const blank = ok();
    blank.parts[1].title = "  ";
    expect(sp.planProblem(blank, d, 1)).toBe("Part 2 needs a title.");
    const loose = ok();
    delete loose.place[C2];
    expect(sp.planProblem(loose, d, 1)).toContain('This criterion is in no list: "Columns can be chosen".');
    const late = ok();
    late.parts[0].dependsOn = [late.parts[1].key];
    expect(sp.planProblem(late, d, 1)).toBe("Part 1 depends on part 2, which comes later. Change the order or remove the dependency.");
    expect(sp.planProblem(ok(), d, 19)).toBe("A session has at most 20 story drafts. This split would make 21.");
  });
  it("planBody", () => {
    const p = sp.planFromWay(WAYS[0], 0, AT);
    const dd = { ...d, split: { at: AT }, criteria: [crit[2], crit[1], crit[0]] };
    expect(sp.planBody(p, dd)).toEqual({
      way: 0,
      parts: [
        { title: "Export a file", sentence: "Users can export rows to a file.", criteria: [C1], dependsOn: [] },
        { title: "Choose columns", sentence: "Users can choose the columns.", criteria: [C2], dependsOn: [1] },
      ],
      unplaced: [C3],
    });
    // draft order of the criteria; 1-based numbers after a reorder
    p.place[C3] = p.parts[0].key;
    [p.parts[0], p.parts[1]] = [p.parts[1], p.parts[0]];
    p.parts[0].dependsOn = [];
    p.parts[1].dependsOn = [p.parts[0].key];
    const b = sp.planBody(p, dd);
    expect(b.parts[1].criteria).toEqual([C3, C1]);
    expect(b.parts[1].dependsOn).toEqual([1]);
    // way left out when the ways differ; sentence only when set
    expect(sp.planBody(p, { ...d, split: { at: "2026-04-01T00:00:00.000Z" } })).not.toHaveProperty("way");
    expect(sp.planBody(sp.emptyPlan(), d)).not.toHaveProperty("way");
    expect(sp.planBody(sp.emptyPlan(), d).parts[0]).not.toHaveProperty("sentence");
  });
  it("splitLogText", () => {
    expect(sp.splitLogText({ what: "split-asked", who: "Ann" })).toBe("Ann asked the architect for ways to split a story draft");
    expect(sp.splitLogText({ what: "architect-split", detail: "1" })).toBe("The architect proposed 1 way to split a story draft");
    expect(sp.splitLogText({ what: "architect-split", detail: "2" })).toBe("The architect proposed 2 ways to split a story draft");
    expect(sp.splitLogText({ what: "architect-split" })).toBe("The architect proposed ways to split a story draft");
    expect(sp.splitLogText({ what: "draft-split", who: "Ann", detail: "3" })).toBe("Ann split a story draft into 3 drafts");
    expect(sp.splitLogText({ what: "draft-split", who: "Ann" })).toBe("Ann split a story draft");
    expect(sp.splitLogText({ what: "created" })).toBe("");
    expect(ui.logText({ what: "draft-split", who: "Ann", detail: "2" })).toBe("Ann split a story draft into 2 drafts");
  });
  it("has words for every server cut", () => {
    for (const c of SPLIT_CUTS) expect(sp.CUT_WORDS[c]).toBeTruthy();
  });
  it("kindOf knows split", () => {
    expect(tk.kindOf({ kind: "split" })).toBe("split");
  });
});

describe("api", () => {
  it("sends the right requests", async () => {
    await api.askSplit("a b", D1).catch(() => {});
    await api.askSplit("a b", D1, "by role").catch(() => {});
    await api.confirmSplit("a b", D1, { parts: [], unplaced: [] }).catch(() => {});
    expect(sent.map((x) => [x.method, x.url, x.body])).toEqual([
      ["POST", `/api/refinement/a%20b/drafts/${D1}/split`, {}],
      ["POST", `/api/refinement/a%20b/drafts/${D1}/split`, { own: "by role" }],
      ["POST", `/api/refinement/a%20b/drafts/${D1}/split/confirm`, { parts: [], unplaced: [] }],
    ]);
  });
  it("a 401 does not reload the page", async () => {
    mode = 401;
    await expect(api.askSplit("s1", D1)).rejects.toMatchObject({ status: 401 });
    await expect(api.confirmSplit("s1", D1, {})).rejects.toMatchObject({ status: 401 });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("asking", () => {
  const post = () => sent.filter((x) => x.url.endsWith("/split"));
  it("shows Split; typed text is saved first; then the line", async () => {
    await withDraft();
    type(field("notes"), "my notes");
    await press(button(sp.ASK_SPLIT, box()));
    expect(sent.map((x) => x.method)).toEqual(["PUT", "POST"]);
    expect(box().textContent).toContain("The architect is looking for ways to split your draft.");
    expect(button(sp.ASK_SPLIT, box())).toBeUndefined();
  });
  it("one criterion: no button", async () => {
    await withDraft({ criteria: [crit[0]] });
    expect(buttons(box())).toEqual([]);
  });
  it("a failing save sends nothing", async () => {
    await withDraft();
    type(field("notes"), "my notes");
    mode = 400;
    modeFor = /\/drafts\/[^/]+$/;
    await press(button(sp.ASK_SPLIT, box()));
    expect(post().length).toBe(0);
    expect(toastText()).toContain("could not be saved");
  });
  it("paused: Ask again; failed: reason and Try again", async () => {
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
    expect(box().textContent).toContain("Out of time");
    await press(button("Try again", box()));
    expect(post().length).toBe(1);
  });
  it("no brief or another run: no button", async () => {
    over = { brief: undefined };
    await withDraft();
    expect(button(sp.ASK_SPLIT)).toBeUndefined();
    cleanup?.();
    over = { architect: { state: "running", kind: "round" } };
    dr.opened.clear();
    await open();
    expect(button(sp.ASK_SPLIT)).toBeUndefined();
    expect(box().textContent).not.toContain("The architect is");
  });
  it("a run for a closed draft shows at the top", async () => {
    over = { architect: run("paused") };
    state.drafts = [base()];
    await show();
    expect(section().textContent).toContain("The architect paused.");
  });
});

describe("the ways", () => {
  it("are shown in words", async () => {
    withWays();
    await open();
    const text = box().textContent;
    for (const w of ["Way 1: By step", "Way 2: By data", "Export a file", "Users can export rows to a file.", "Rows are exported", "Columns can be chosen",
      "The first story already delivers: A file with all rows.", "Depends on: story 1", "Old formats work", "Every criterion has a place.",
      "Story 2 delivers nothing a user can see or check: Only a setting.", "Stories 1 and 2 touch the same code: Both change the writer."]) expect(text).toContain(w);
    expect(text.indexOf("Export a file")).toBeLessThan(text.indexOf("Choose columns"));
    expect(button(sp.ASK_AGAIN, box())).toBeDefined();
    expect(text).not.toContain(sp.OUT_OF_DATE);
  });
  it("show a text with a tag as text", async () => {
    withWays({}, [{ ...WAYS[1], stories: [{ ...WAYS[1].stories[0], title: "<b>Bold</b>" }, WAYS[1].stories[1]] }]);
    await open();
    expect(box().textContent).toContain("<b>Bold</b>");
    expect(walk(box()).some((e) => e.tag === "b" && e.textContent === "Bold")).toBe(false);
  });
  it("are out of date after the draft changed", async () => {
    withWays();
    await open();
    type(field("title"), "Export all rows");
    await wait(SAVE());
    expect(box().textContent).toContain(sp.OUT_OF_DATE);
    expect(box().textContent).toContain(sp.OUT_OF_DATE_WHY);
    expect(button(sp.ASK_AGAIN, box())).toBeDefined();
  });
  it("a removed criterion is named as removed", async () => {
    withWays();
    state.drafts[0].criteria = [crit[0], crit[1]];
    await open();
    expect(box().textContent).toContain("A criterion that was removed.");
  });
});

describe("own way", () => {
  it("opens the field; an empty text sends nothing; a text is sent", async () => {
    await withDraft();
    expect(field("own-way")).toBeUndefined();
    await press(button(sp.OWN, box()));
    expect(field("own-way")).toBeDefined();
    await press(button(sp.OWN_SEND, box()));
    expect(box().textContent).toContain(sp.OWN_EMPTY);
    expect(sent).toEqual([]);
    type(field("own-way"), "by role");
    await press(button(sp.OWN_SEND, box()));
    expect(sent.at(-1)).toMatchObject({ method: "POST", body: { own: "by role" } });
    expect(sent.at(-1)!.url.endsWith("/split")).toBe(true);
  });
});

describe("the plan", () => {
  it("Use this way sends nothing and shows the parts", async () => {
    await useWay(1);
    expect(sent).toEqual([]);
    expect(titles().map((e) => e.value)).toEqual(["Export a file", "Choose columns"]);
    expect(box().textContent).toContain(sp.NOT_SENT);
    expect(box().textContent).toContain("This creates 2 new drafts.");
    expect(confirmBtn().disabled).toBe(false);
    expect(box().textContent).not.toContain("Way 1");
  });
  it("moves a criterion to another part and to nowhere", async () => {
    await useWay(1);
    await move("Rows are exported", `p:${sp.splitLocal.values().next().value.parts[1].key}`);
    await press(confirmBtn());
    expect(confirms().at(-1)!.body.parts.map((p: any) => p.criteria)).toEqual([[], [C1, C2]]);
  });
  it("a criterion that fits nowhere is sent as unplaced", async () => {
    await useWay(1);
    await move("Columns can be chosen", "nowhere");
    await press(confirmBtn());
    expect(confirms().at(-1)!.body.unplaced).toEqual([C2, C3]);
  });
  it("rename, add and remove a part", async () => {
    await useWay(1);
    type(titles()[0]!, "Export first");
    expect(titles()[0]!.value).toBe("Export first");
    for (let i = 0; i < 4; i++) await press(button(sp.ADD_PART, box()));
    expect(titles().length).toBe(6);
    expect((button(sp.ADD_PART, box()) as any).disabled).toBe(true);
    expect(problem()).toContain("Part 3 needs a title.");
    expect(confirmBtn().disabled).toBe(true);
    for (let i = 0; i < 4; i++) await press(buttons(box()).filter((b) => b.textContent === "Remove part").at(-1));
    expect(titles().length).toBe(2);
    expect(problem()).toBe("");
    await press(buttons(box()).filter((b) => b.textContent === "Remove part")[0]);
    expect(problem()).toBe("A split needs at least 2 parts.");
    expect(confirmBtn().disabled).toBe(true);
  });
  it("removing a part puts its criteria in no list", async () => {
    await useWay(2);
    await press(buttons(box()).filter((b) => b.textContent === "Remove part")[1]);
    expect(box().textContent).toContain(sp.NO_LIST);
    expect(problem()).toBe("A split needs at least 2 parts.");
    await press(button(sp.ADD_PART, box()));
    type(titles()[1]!, "Again");
    expect(problem()).toContain("This criterion is in no list");
    expect(confirmBtn().disabled).toBe(true);
  });
  it("an invalid order blocks Confirm", async () => {
    await useWay(1);
    await press(buttons(box()).filter((b) => b.textContent === "Up")[0]);
    expect(problem()).toContain("Part 1 depends on part 2, which comes later");
    expect(confirmBtn().disabled).toBe(true);
    await press(confirmBtn());
    expect(sent).toEqual([]);
    // removing the dependency makes it right again
    const cb = walk(box()).find((e) => e.tag === "input" && e.attrs.type === "checkbox" && (e as any).checked)!;
    (cb as any).checked = false;
    cb.fire("change", {});
    expect(problem()).toBe("");
    expect(confirmBtn().disabled).toBe(false);
  });
  it("starts from an empty plan", async () => {
    withWays();
    await open();
    await press(button(sp.EMPTY_PLAN, box()));
    expect(titles().map((e) => e.value)).toEqual(["", ""]);
    expect(box().textContent).toContain(sp.NO_LIST);
    expect(problem()).toContain("Part 1 needs a title.");
    expect(confirmBtn().disabled).toBe(true);
    expect(sent).toEqual([]);
  });
  it("the count follows the parts; typing keeps the same input", async () => {
    await useWay(1);
    await press(button(sp.ADD_PART, box()));
    expect(box().textContent).toContain("This creates 3 new drafts.");
    const first = titles()[0]!;
    type(first, "Another title");
    expect(titles()[0]).toBe(first);
  });
  it("Discard plan shows the ways again", async () => {
    await useWay(1);
    await press(button(sp.DISCARD, box()));
    expect(box().textContent).toContain("Way 1");
    expect(sent).toEqual([]);
    expect(sp.splitLocal.size).toBe(0);
  });
});

describe("confirm", () => {
  it("sends the body, then shows the new drafts", async () => {
    await useWay(1);
    await move("Columns can be chosen", "nowhere");
    await press(confirmBtn());
    expect(confirms().length).toBe(1);
    expect(confirms()[0]!.body).toEqual({
      way: 0,
      parts: [
        { title: "Export a file", sentence: "Users can export rows to a file.", criteria: [C1], dependsOn: [] },
        { title: "Choose columns", sentence: "Users can choose the columns.", criteria: [], dependsOn: [1] },
      ],
      unplaced: [C2, C3],
    });
    const text = section().textContent;
    expect(text).toContain("Export a file");
    expect(text).toContain("Choose columns");
    expect(walk(section()).some((e) => e.attrs.class === "pill state-split" && e.textContent === "Split")).toBe(true);
    expect(field("title").value).toBe("Export a file");
    expect(sp.splitLocal.size).toBe(0);
    expect(toastText()).toContain("The draft is split into 2 drafts.");
  });
  it("a refusal gives a toast and keeps the plan", async () => {
    await useWay(1);
    mode = 400;
    modeFor = /\/split\/confirm$/;
    await press(confirmBtn());
    expect(toastText()).toContain("The server said no");
    expect(sp.splitLocal.size).toBe(1);
  });
  it("a criterion typed just before Confirm stops the call", async () => {
    await useWay(1);
    // the open draft has an editor only after the plan is drawn: reach the new-criterion box
    type(walk(section()).find((e) => e.attrs["aria-label"] === "Acceptance criterion" && e.attrs["data-focus"] === "crit-new")!, "A brand new rule");
    await press(confirmBtn());
    expect(sent.map((x) => x.method)).toEqual(["PUT"]);
    expect(confirms().length).toBe(0);
    expect(toastText()).toContain("A brand new rule");
    expect(box().textContent).toContain(sp.NO_LIST);
    expect(box().textContent).toContain("A brand new rule");
    expect(confirmBtn().disabled).toBe(true);
  });
});

describe("read-only", () => {
  for (const extra of [{ mine: false }, { state: "dropped" }]) {
    it(`shows the ways without controls: ${JSON.stringify(extra)}`, async () => {
      over = extra;
      withWays();
      await show();
      expect(card().textContent).toContain("Way 1: By step");
      expect(walk(card()).filter((e) => ["button", "input", "select", "textarea"].includes(e.tag))).toEqual([]);
    });
  }
  it("a draft without ways has no card", async () => {
    over = { mine: false };
    state.drafts = [base()];
    await show();
    expect(walk(section()).some((e) => e.attrs.class === "card split")).toBe(false);
  });
  it("renderRefinement readOnly sends nothing", async () => {
    withWays();
    cleanup = await ui.renderRefinement(main(), { id: "s1", readOnly: true });
    expect(card().textContent).toContain("Way 1");
    expect(buttons(card())).toEqual([]);
    expect(sent).toEqual([]);
  });
  it("in a view, the changing calls are refused before fetch", async () => {
    apiMod.setViewAs("u1");
    const calls: string[] = [];
    (globalThis as any).fetch = async (u: string) => {
      calls.push(u);
      return reply({});
    };
    await expect(api.askSplit("s1", D1)).rejects.toMatchObject({ preview: true });
    await expect(api.confirmSplit("s1", D1, {})).rejects.toMatchObject({ preview: true });
    expect(calls).toEqual([]);
  });
  it("hidden drafts show nothing", async () => {
    over = { draftsHidden: true };
    withWays();
    await show();
    expect(section().textContent).not.toContain("Way 1");
  });
  it("a split original reopened has no fields and no architect controls", async () => {
    await useWay(1);
    await press(confirmBtn());
    // the original is in the list; open it again
    const originalOpen = buttons(section()).find((b) => b.attrs["data-focus"] === `open-${D1}`)!;
    await press(originalOpen);
    expect(section().textContent).toContain("This draft was split.");
    expect(field("title")).toBeUndefined();
    expect(buttons(section()).map((b) => b.textContent).filter((x) => [sp.ASK_SPLIT, sp.ASK_AGAIN, sp.EMPTY_PLAN, sp.OWN].includes(x))).toEqual([]);
    expect(button("Remove draft")).toBeDefined();
  });
  it("a split original can be removed", async () => {
    await useWay(1);
    await press(confirmBtn());
    await press(buttons(section()).find((b) => b.attrs["data-focus"] === `open-${D1}`));
    (globalThis as any).confirm = () => true;
    const removed: string[] = [];
    const f = (globalThis as any).fetch;
    (globalThis as any).fetch = async (u: string, init: any) => {
      if (init.method === "DELETE") removed.push(u);
      return f(u, init);
    };
    await press(button("Remove draft"));
    expect(removed.length).toBe(1);
  });
  it("a paused split run of a split original shows at the top without a retry hint", async () => {
    await useWay(1);
    over = { architect: run("paused") };
    await press(confirmBtn());
    await press(buttons(section()).find((b) => b.attrs["data-focus"] === `open-${D1}`));
    expect(section().textContent).toContain("This draft was split.");
    expect(section().textContent).toContain("The architect paused.");
    expect(section().textContent).not.toContain("to ask again");
  });
  it("no retry once the draft cannot be split any more", () => {
    const one = { id: D1, criteria: [crit[0]] };
    const s = { id: "s1", brief: BRIEF, drafts: [one] };
    expect(sp.splitState({ ...s, architect: run("failed") }, one)).toEqual({ kind: "line", again: "" });
    expect(sp.splitState({ ...s, architect: run("paused") }, one)).toEqual({ kind: "line", again: "" });
  });
});
