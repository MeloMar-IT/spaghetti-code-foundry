import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let words: any;
let model: any;
let view: any;
let turn: any;
let act: any;
let apiMod: any;
beforeAll(async () => {
  restore = installFakeDom();
  words = await import("../ui/simple-words.js" as string);
  model = await import("../ui/simple-model.js" as string);
  view = await import("../ui/simple.js" as string);
  turn = await import("../ui/simple-turn.js" as string);
  act = await import("../ui/turn-act.js" as string);
  apiMod = await import("../ui/api.js" as string);
});
afterAll(() => restore());

const tick = () => new Promise((r) => setTimeout(r, 0));
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const box = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const texts = (root: FakeElement) => [root, ...walk(root)].flatMap((e) => [e.children.filter((c) => typeof c === "string").join(""), e.attrs["aria-label"] ?? "", e.attrs.title ?? ""]);

const repo = { id: "r1", url: "https://github.com/o/app", github: "o/app" };
const run = (id: string, kind: any) => ({
  runId: id, flow: "issue-gitflow", task: "Show the weather (#12)\n\nShows the weather.", status: "waiting", startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  vars: { github_repo: "o/app", issue: "12" }, history: [], next: nextStep(kind, { runId: id, repo: "o/app", title: "Show the weather (#12)" } as any),
});
const mineItem = (id: string, over: any = {}) => ({ key: `m-${id}`, kind: "questions", runId: id, acts: ["answer", "defaults"], ...over });
const detailOf = (over: any = {}) => ({
  stamp: "s1", digest: "d1", acts: ["answer", "defaults"], kind: "questions", text: "",
  questions: [
    { n: 1, title: "Which colour?", text: "Pick a colour for the page.", recommendation: "Blue" },
    { n: 2, title: "Which name?", text: "Name the page.", recommendation: "Home" },
  ], ...over,
});

/** A project page for run `id` (a different id in each test: the drafts are module state). */
function page(id: string, { turns, detail = detailOf(), actFn, kind = "questions" }: { turns?: any[]; detail?: any; actFn?: any; kind?: string } = {}) {
  const done = vi.fn();
  const detailFn = vi.fn(async (_k: string) => detail);
  const actF = actFn ?? vi.fn(async (_b: any) => ({}));
  const answer = { detail: detailFn, act: actF, done };
  const m = model.projectModel(repo, [repo], [run(id, kind)], []);
  const draw = (t = turns ?? [mineItem(id)]) => box(view.projectView(m, { turns: t, answer }));
  return { m, draw, detailFn, actF, done, answer };
}
const btn = (p: FakeElement, label: string) => p.all("button").find((b) => b.textContent === label)!;
const links = (p: FakeElement) => p.all("a").filter((a) => a.attrs.href !== "#/home");
const type = (area: FakeElement, v: string) => { (area as any).value = v; area.fire("input", { target: area }); };

describe("the question card", () => {
  it("tags question cards in the model, and only those", () => {
    for (const k of ["questions", "planner_questions", "owner_action"]) {
      const c = model.cardOf({ run: run(`t-${k}`, k), job: null });
      expect(c.ask).toBe(`t-${k}`);
      expect(c.link).toBeTruthy();
    }
    expect(model.cardOf({ run: run("t-plan", "approve_plan"), job: null }).ask).toBeUndefined();
    expect(model.cardOf({ run: run("t-run", "running"), job: null }).ask).toBeUndefined();
  });

  it("keeps today's link without a matching item", () => {
    const bad = [
      null, [],[mineItem("other")], [mineItem("n1", { acts: ["retry"] })], [mineItem("n1", { acts: "answer" })],
      [mineItem("n1", { key: "" })], [mineItem("n1", { kind: "approve_plan" })], [null],
    ];
    for (const t of bad) {
      const p = page("n1", { turns: t as any }).draw(t as any);
      expect(links(p).length, JSON.stringify(t)).toBe(1);
      expect(p.all("button")).toHaveLength(0);
    }
  });

  it("opens, loads the questions in plain words and shows suggestions and boxes", async () => {
    const t = page("o1", { detail: detailOf({ questions: [{ n: 1, title: "Which story?", text: "Pick a colour.\nName it.", recommendation: "Blue" }] }) });
    const p = t.draw();
    expect(links(p)).toHaveLength(0);
    btn(p, "Answer the questions").click();
    expect(p.textContent).toContain(words.ANSWER.loading);
    await tick();
    expect(t.detailFn).toHaveBeenCalledWith("m-o1");
    expect(p.textContent).toContain("Question 1: Which change?");
    expect(p.all("p").map((x) => x.textContent)).toEqual(expect.arrayContaining(["Pick a colour.", "Name it."]));
    expect(btn(p, "Use the suggestion: Blue")).toBeTruthy();
    expect(p.all("textarea")[0]!.attrs["aria-label"]).toBe("Your answer to question 1");
    expect(audit(p)).toEqual([]);
  });

  it("uses a generic label for a recommendation with a forbidden term, and says when a text has no plain words", async () => {
    const t = page("o2", { detail: detailOf({ questions: [{ n: 1, title: "A", text: "Which branch? Merge the logs.", recommendation: "merge it" }] }) });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    expect(btn(p, words.ANSWER.useSuggestion)).toBeTruthy();
    expect(p.textContent).toContain(words.ANSWER.noPlain);
  });

  it("says the Advanced-view sentence for a title that has only forbidden words and no text", async () => {
    const t = page("tt1", { detail: detailOf({ questions: [{ n: 1, title: "Which branch?", text: "" }] }) });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.noPlain);
    expect(p.textContent).not.toContain("Which branch");
    expect(p.all("textarea")).toHaveLength(1);
  });

  it("keeps typed answers in every phase of a retry after a 409, so a 401 or a poll cannot reload them away", async () => {
    turn.clearAnswerDrafts();
    const t = page("rt1", { actFn: vi.fn(async () => { throw Object.assign(new Error("changed"), { status: 409 }); }) });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    type(p.all("textarea")[0]!, "Blue");
    type(p.all("textarea")[1]!, "Home");
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.failed);
    expect(turn.hasUnsentAnswers()).toBe(true);
    let fail: (e: Error) => void = () => {};
    t.answer.detail = vi.fn(() => new Promise((_res, rej) => { fail = rej; }));
    btn(p, "Answer the questions").click();
    expect(p.textContent).toContain(words.ANSWER.loading);
    expect(turn.hasUnsentAnswers()).toBe(true);
    await tick();
    fail(new Error("boom"));
    await tick();
    expect(p.textContent).toContain(words.ANSWER.loadFailed);
    expect(turn.hasUnsentAnswers()).toBe(true);
  });

  it("takes every suggestion as the defaults", async () => {
    const t = page("d1");
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    btn(p, "Use the suggestion: Blue").click();
    expect(btn(p, "Use the suggestion: Blue").attrs["aria-pressed"]).toBe("true");
    btn(p, "Use the suggestion: Home").click();
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(t.actF).toHaveBeenCalledWith({ key: "m-d1", action: "defaults", stamp: "s1", digest: "d1" });
    expect(p.textContent).toContain(words.ANSWER.sent);
    expect(t.done).toHaveBeenCalledTimes(1);
  });

  it("sends answers with the shared filler; typed text wins over a taken suggestion", async () => {
    expect(act.FILLER).toBe("Go with the recommendation.");
    const t = page("a1");
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    btn(p, "Use the suggestion: Blue").click();
    type(p.all("textarea")[1]!, " Green ");
    btn(p, "Use the suggestion: Home").click();
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(t.actF).toHaveBeenCalledWith({ key: "m-a1", action: "answer", stamp: "s1", digest: "d1", answers: [{ n: 1, text: act.FILLER }, { n: 2, text: "Green" }] });
  });

  it("uses answers, not defaults, when the server does not offer defaults; a suggestion pressed twice is not taken", async () => {
    const t = page("a2", { detail: detailOf({ acts: ["answer"] }) });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    for (const l of ["Use the suggestion: Blue", "Use the suggestion: Home"]) btn(p, l).click();
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(t.actF.mock.calls[0][0]).toMatchObject({ action: "answer", answers: [{ n: 1, text: act.FILLER }, { n: 2, text: act.FILLER }] });
    const u = page("a3");
    const q = u.draw();
    btn(q, "Answer the questions").click();
    await tick();
    btn(q, "Use the suggestion: Blue").click();
    btn(q, "Use the suggestion: Blue").click();
    type(q.all("textarea")[1]!, "x");
    btn(q, words.ANSWER.send).click();
    await tick();
    expect(u.actF).not.toHaveBeenCalled();
    expect(q.textContent).toContain("Question 1 needs an answer.");
  });

  it("sends nothing for an empty answer, and handles a text without questions", async () => {
    const t = page("e1", { detail: detailOf({ questions: [], text: "Tell me the colour." }) });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.oneQuestion);
    expect(p.textContent).toContain("Tell me the colour.");
    expect(p.all("button").filter((b) => b.attrs["aria-pressed"] !== undefined)).toHaveLength(0);
    btn(p, words.ANSWER.send).click();
    expect(p.textContent).toContain(words.ANSWER.needsOne);
    expect(t.actF).not.toHaveBeenCalled();
    type(p.all("textarea")[0]!, "Red");
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(t.actF).toHaveBeenCalledWith({ key: "m-e1", action: "answer", stamp: "s1", digest: "d1", answers: [{ text: "Red" }] });
  });

  it("says the fixed sentence on failure and keeps the typed text across a redraw", async () => {
    const actFn = vi.fn(async () => { throw new Error("the comment on the issue changed — gh 502"); });
    const t = page("f1", { actFn });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    type(p.all("textarea")[0]!, "Blue");
    type(p.all("textarea")[1]!, "Home");
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.failed);
    expect(p.textContent).not.toMatch(/issue|gh 502/);
    expect(t.done).not.toHaveBeenCalled();
    const again = t.draw();
    expect(again.all("textarea")[0]!.value).toBe("Blue");
    expect(turn.hasUnsentAnswers()).toBe(true);
  });

  it("after a 409 asks again and gives an answer back only to a question that did not change", async () => {
    const first = detailOf();
    const changed = detailOf({ stamp: "s2", digest: "d2", questions: [
      { n: 1, title: "Which name?", text: "Name the page.", recommendation: "Home" },
      { n: 2, title: "Which name?", text: "Name the page.", recommendation: "Home" },
    ] });
    let current = first;
    const actFn = vi.fn(async () => { throw Object.assign(new Error("changed"), { status: 409 }); });
    const t = page("c1", { actFn });
    t.answer.detail = vi.fn(async () => current);
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    type(p.all("textarea")[0]!, "Blue");
    btn(p, "Use the suggestion: Home").click();
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.failed);
    expect(btn(p, "Answer the questions")).toBeTruthy();
    current = changed;
    btn(p, "Answer the questions").click();
    await tick();
    expect(t.answer.detail).toHaveBeenCalledTimes(2);
    // question 1 is now another question, so the old text is not on it; question 2 is as it was (same text, same suggestion)
    expect(p.all("textarea")[0]!.value).toBe("");
    expect(p.all("textarea")[1]!.value).toBe("");
    expect(p.all("button").filter((b) => b.attrs["aria-pressed"] === "true")).toHaveLength(1);
    btn(p, words.ANSWER.send).click();
    expect(p.textContent).toContain("Question 1 needs an answer.");
  });

  it("goes back to closed with the load failure sentence", async () => {
    const t = page("l1");
    t.answer.detail = vi.fn(async () => { throw new Error("boom"); });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.loadFailed);
    expect(btn(p, "Answer the questions")).toBeTruthy();
  });

  it("switches every control off while sending", async () => {
    let release: () => void = () => {};
    const actFn = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const t = page("s1", { actFn });
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    type(p.all("textarea")[0]!, "a");
    type(p.all("textarea")[1]!, "b");
    btn(p, words.ANSWER.send).click();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.sending);
    for (const e of [...p.all("button"), ...p.all("textarea")]) expect(e.attrs.disabled, e.tag).toBeDefined();
    expect(audit(p)).toEqual([]);
    release();
    await tick();
    expect(p.textContent).toContain(words.ANSWER.sent);
  });

  it("keeps the sent line when the page is drawn again, until the questions read are different", async () => {
    const t = page("k1");
    const p = t.draw();
    btn(p, "Answer the questions").click();
    await tick();
    type(p.all("textarea")[0]!, "a");
    type(p.all("textarea")[1]!, "b");
    btn(p, words.ANSWER.send).click();
    await tick();
    // the item is gone from the list: the sent line, not the link
    const gone = t.draw([]);
    expect(gone.textContent).toContain(words.ANSWER.sent);
    expect(links(gone)).toHaveLength(0);
    // a poll that still lists the item with the same questions does not erase it
    const same = t.draw();
    await tick();
    expect(same.textContent).toContain(words.ANSWER.sent);
    expect(btn(same, "Answer the questions")).toBeUndefined();
    // genuinely new questions: closed again
    t.answer.detail = vi.fn(async () => detailOf({ stamp: "s9", digest: "d9" }));
    const fresh = t.draw();
    await tick();
    expect(btn(fresh, "Answer the questions")).toBeTruthy();
  });

  it("shows no forbidden term and passes the audit in every state", async () => {
    const detail = detailOf({ questions: [{ n: 1, title: "Fix the run log", text: "Which branch? Pick a colour.", recommendation: "merge it" }] });
    const seen: FakeElement[] = [];
    const check = (p: FakeElement) => {
      expect(words.forbiddenIn(texts(p).join("\n")), p.textContent).toEqual([]);
      expect(audit(p)).toEqual([]);
      seen.push(p);
    };
    const t = page("z1", { detail });
    const p = t.draw();
    check(p);
    btn(p, "Answer the questions").click();
    check(p);
    await tick();
    check(p);
    type(p.all("textarea")[0]!, "ok");
    btn(p, words.ANSWER.send).click();
    check(p);
    await tick();
    check(p);
    const bad = page("z2", { detail, actFn: vi.fn(async () => { throw new Error("gh failed"); }) });
    const q = bad.draw();
    btn(q, "Answer the questions").click();
    await tick();
    type(q.all("textarea")[0]!, "ok");
    btn(q, words.ANSWER.send).click();
    await tick();
    check(q);
    const lf = page("z3");
    lf.answer.detail = vi.fn(async () => { throw new Error("x"); });
    const r = lf.draw();
    btn(r, "Answer the questions").click();
    await tick();
    check(r);
    for (const v of Object.values<any>(words.ANSWER)) expect(words.forbiddenIn(typeof v === "function" ? `${v(2)} ${v("Blue")}` : v), String(v)).toEqual([]);
  });
});

describe("the project page", () => {
  const repos = [repo];
  const base = (over: any = {}) => ({
    repos: vi.fn(async () => repos), runs: vi.fn(async () => [run("w1", "questions")]), queue: vi.fn(async () => ({ pending: [], active: [] })),
    myTurn: vi.fn(async () => ({ items: [mineItem("w1")] })), turnDetail: vi.fn(async () => detailOf()), actTurn: vi.fn(async () => ({})),
    preview: vi.fn(async () => ({ state: "idle" })), ...over,
  });
  const open = async (a: any, id = "r1") => {
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id, a, host: "example.org" });
    return { main, off };
  };

  it("shows the answer button when the run is among the items to answer", async () => {
    const { main, off } = await open(base());
    expect(btn(main, "Answer the questions")).toBeTruthy();
    off();
  });

  it("keeps the link when the read fails or is missing, and My projects does not read the list", async () => {
    for (const a of [base({ myTurn: vi.fn(async () => { throw new Error("no"); }) }), base({ myTurn: undefined }), base({ myTurn: vi.fn(async () => ({})) })]) {
      const { main, off } = await open(a);
      expect(btn(main, "Answer the questions")).toBeUndefined();
      expect(links(main).length).toBeGreaterThan(0);
      off();
    }
    const a = base();
    const main = new FakeElement("div");
    (await view.renderSimpleHome(main, { a }))();
    expect(a.myTurn).not.toHaveBeenCalled();
  });

  it("keeps the page on a 401 while answers are unsent (the real api wrapper)", async () => {
    const reload = vi.fn();
    const g = globalThis as any;
    const saved = { fetch: g.fetch, location: g.location };
    g.location = { reload, hostname: "x" };
    g.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), headers: { get: () => null } }));
    try {
      const { main, off } = await open(base({ actTurn: apiMod.api.actTurn, turnDetail: vi.fn(async () => detailOf()) }));
      btn(main, "Answer the questions").click();
      await tick();
      type(main.all("textarea")[0]!, "Blue");
      type(main.all("textarea")[1]!, "Home");
      await apiMod.api.myTurn().catch(() => {});
      btn(main, words.ANSWER.send).click();
      await tick();
      expect(main.textContent).toContain(words.ANSWER.failed);
      expect(reload).not.toHaveBeenCalled();
      off();
      await apiMod.api.myTurn().catch(() => {});
      expect(reload).toHaveBeenCalled();
    } finally {
      g.fetch = saved.fetch;
      g.location = saved.location;
    }
  });
});
