import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let plan: any;
let model: any;
let words: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/onboarding-guide.js" as string);
  plan = await import("../ui/onboarding-plan.js" as string);
  model = await import("../ui/onboarding-guide-model.js" as string);
  words = await import("../ui/simple-words.js" as string);
});
afterAll(() => restore());

const ID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const deferred = () => {
  let resolve!: (v?: any) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const ANSWERS = { starter: "website", name: "My Site", about: { what: "show my work" }, repoId: ID };
const READY_LIST = [{ id: "r1", rule: "other" }, { id: "np", rule: "no-plan" }];
const draft = (id: string, over: any = {}) => ({ id, state: "drafting", title: { text: `Part ${id}` }, what: { text: `Does ${id}.` }, ...over });
const checked = (d: any, results: [string, string][]) => ({ ...d, readiness: { at: "2026-01-01T00:00:00.000Z", items: results.map(([id, result]) => ({ id, result })) } });

/** A guide API with one session that changes as the calls come in. */
function fakeApi(over: any = {}, first: any = {}) {
  let s: any = { id: SID, architect: { state: "idle" }, brief: null, drafts: [], readyList: READY_LIST, ...first };
  const setDraft = (id: string, fn: (d: any) => any) => { s = { ...s, drafts: s.drafts.map((d: any) => (d.id === id ? fn(d) : d)) }; };
  const a: any = {
    state: () => s,
    set: (next: any) => { s = next; },
    onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: ANSWERS })),
    saveOnboardingProgress: vi.fn(async (p: any) => p),
    clearOnboardingProgress: vi.fn(async () => ({})),
    guideSession: vi.fn(async () => s),
    askArchitect: vi.fn(async () => { s = { ...s, brief: "A brief." }; return s; }),
    askUnderstand: vi.fn(async () => { s = { ...s, drafts: [draft("d1"), draft("d2")] }; return s; }),
    refinementSession: vi.fn(async () => s),
    saveDraft: vi.fn(async (_id: string, did: string, body: any) => { setDraft(did, (d) => ({ ...d, title: { text: body.title }, what: { text: body.what } })); return s; }),
    removeDraft: vi.fn(async (_id: string, did: string) => { s = { ...s, drafts: s.drafts.filter((d: any) => d.id !== did) }; return s; }),
    checkReady: vi.fn(async (_id: string, did: string) => { setDraft(did, (d) => checked(d, [["r1", "not-met"], ["np", "met"]])); return s; }),
    acceptAnyway: vi.fn(async (_id: string, did: string, item: string, reason: string) => {
      setDraft(did, (d) => ({ ...d, acceptedAnyway: [{ id: item, reason }], state: "ready" }));
      return s;
    }),
    publish: vi.fn(async () => { s = { ...s, drafts: s.drafts.map((d: any) => ({ ...d, published: { issue: 1 } })) }; return { created: [] }; }),
    repoWatchers: vi.fn(async () => []),
    addRepoWatcher: vi.fn(async (_r: string, b: any) => ({ id: b.id, source: "issues", enabled: true })),
    saveRepoWatcher: vi.fn(async (_r: string, id: string) => ({ id, source: "issues", enabled: true })),
    tickWatcher: vi.fn(async () => ({})),
    ...over,
  };
  return a;
}
const draw = async (a: any, o: any = {}) => {
  const box = new FakeElement("div");
  const go = vi.fn();
  const ask = vi.fn(async () => true);
  const cleanup = await ui.renderOnboardingGuide(box, { a, admin: true, notify: () => {}, ask, go, agents: vi.fn(), wait: async () => {}, ...o });
  await flush();
  return { box, cleanup, go, ask };
};
const button = (box: FakeElement, focus: string) => box.all("button").find((b) => b.getAttribute("data-focus") === focus);
const press = async (box: FakeElement, focus: string) => {
  const b = button(box, focus);
  if (!b) throw new Error(`no button ${focus} in: ${box.textContent}`);
  b.click();
  await flush();
};
const on = (box: FakeElement, focus: string) => button(box, focus)?.getAttribute("disabled") === null;

describe("the model of step 6", () => {
  const ready = draft("a", { state: "ready" });
  it("planPhase follows the session", () => {
    expect(model.planPhase(null)).toBe("none");
    expect(model.planPhase({ id: SID, architect: { state: "running" } })).toBe("working");
    expect(model.planPhase({ id: SID, architect: { state: "failed", reason: "The answer is being stored" } })).toBe("working");
    expect(model.planPhase({ id: SID, architect: { state: "failed", reason: "It broke" } })).toBe("stopped");
    expect(model.planPhase({ id: SID, architect: { state: "paused" } })).toBe("stopped");
    expect(model.planPhase({ id: SID, architect: { state: "idle" } })).toBe("need-brief");
    expect(model.planPhase({ id: SID, architect: { state: "idle" }, brief: "x" })).toBe("need-plan");
    expect(model.planPhase({ id: SID, architect: { state: "idle" }, drafts: [draft("a")] })).toBe("plan");
    expect(model.planPhase({ id: SID, architect: { state: "idle" }, drafts: [draft("a", { state: "split" })] })).toBe("need-brief");
  });

  it("planItems gives plain cards", () => {
    const items = model.planItems({ drafts: [draft("a", { published: { issue: 3 } }), draft("s", { state: "split" }), { id: "b", state: "drafting" }] });
    expect(items).toEqual([{ id: "a", title: "Part a", what: "Does a.", published: true }, { id: "b", title: "A part of your project", what: "", published: false }]);
  });

  it("nextBuildAction goes check, accept, publish, done, one step at a time", () => {
    const base = { architect: { state: "idle" }, readyList: READY_LIST };
    expect(model.nextBuildAction({ ...base, drafts: [] })).toEqual({ type: "empty" });
    expect(model.nextBuildAction({ ...base, architect: { state: "queued" }, drafts: [ready] })).toEqual({ type: "wait" });
    expect(model.nextBuildAction({ ...base, architect: { state: "failed", reason: "x" }, drafts: [ready] })).toEqual({ type: "stopped" });
    expect(model.nextBuildAction({ ...base, drafts: [draft("a")] })).toEqual({ type: "check", draft: "a" });
    expect(model.nextBuildAction({ ...base, drafts: [{ ...checked(draft("a"), [["r1", "met"]]), readiness: { items: [], stale: true } }] })).toEqual({ type: "check", draft: "a" });
    expect(model.nextBuildAction({ ...base, drafts: [checked(draft("a"), [["r1", "unsure"], ["np", "met"]])] })).toEqual({ type: "accept", draft: "a", item: "r1" });
    expect(model.nextBuildAction({ ...base, drafts: [checked(draft("a"), [["np", "not-met"], ["r1", "not-met"]])] })).toEqual({ type: "blocked", draft: "a", item: "np" });
    const accepted = { ...checked(draft("a"), [["r1", "not-met"]]), acceptedAnyway: [{ id: "r1" }] };
    expect(model.nextBuildAction({ ...base, drafts: [accepted] })).toEqual({ type: "check", draft: "a" });
    // a draft that still needs a check comes before the publish of the ready ones
    expect(model.nextBuildAction({ ...base, drafts: [ready, draft("b")] })).toEqual({ type: "check", draft: "b" });
    expect(model.nextBuildAction({ ...base, drafts: [ready, draft("p", { state: "ready", published: { issue: 1 } })] })).toEqual({ type: "publish", drafts: ["a"] });
    expect(model.nextBuildAction({ ...base, drafts: [{ ...ready, published: { issue: 1 } }] })).toEqual({ type: "done" });
  });

  it("finds the watcher of the stories and names the guide's own", () => {
    expect(model.issuesWatcherOf([{ id: "x", source: "monitor" }, { id: "y", source: "issues", enabled: false }])).toBeUndefined();
    expect(model.issuesWatcherOf([{ id: "y", source: "issues", enabled: false }, { id: "z", source: "issues", enabled: true }])?.id).toBe("z");
    expect(model.issuesWatcherOf(undefined)).toBeUndefined();
    expect(model.guideWatcherId(ID)).toBe("guide-11111111");
  });
});

describe("ensureWatcher", () => {
  it("uses an enabled watcher that is there and asks it to look", async () => {
    const a = fakeApi({ repoWatchers: vi.fn(async () => [{ id: "mine", source: "issues", enabled: true }]) });
    expect((await plan.ensureWatcher(a, ID)).id).toBe("mine");
    expect(a.addRepoWatcher).not.toHaveBeenCalled();
    expect(a.tickWatcher).toHaveBeenCalledWith("mine");
  });

  it("adds its own, and a failed look is not a failure", async () => {
    const a = fakeApi({ tickWatcher: vi.fn(async () => { throw Object.assign(new Error("busy"), { status: 500 }); }) });
    expect((await plan.ensureWatcher(a, ID)).id).toBe("guide-11111111");
    expect(a.addRepoWatcher).toHaveBeenCalledWith(ID, { id: "guide-11111111", source: "issues" });
  });

  it("reads again on a 409 and switches its own watcher on when it is off", async () => {
    const rows = [{ id: "guide-11111111", source: "issues", enabled: false }];
    const a = fakeApi({
      repoWatchers: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(rows),
      addRepoWatcher: vi.fn(async () => { throw Object.assign(new Error("exists"), { status: 409 }); }),
    });
    await plan.ensureWatcher(a, ID);
    expect(a.saveRepoWatcher).toHaveBeenCalledWith(ID, "guide-11111111", { enabled: true });
    const other = fakeApi({ addRepoWatcher: vi.fn(async () => { throw Object.assign(new Error("no"), { status: 400 }); }) });
    await expect(plan.ensureWatcher(other, ID)).rejects.toThrow();
  });
});

describe("step 6 in the guide", () => {
  it("says what to do when there is no project, or no admin", async () => {
    const none = await draw(fakeApi({ onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: { starter: "website" } })) }));
    expect(none.box.textContent).toContain(words.GUIDE.plan.noProject);
    await press(none.box, "guide-to-step-5");
    expect(none.box.textContent).toContain("Step 5 of 7");
    const user = await draw(fakeApi(), { admin: false });
    expect(user.box.textContent).toContain(words.GUIDE.plan.askAdmin);
  });

  it("stores the answers first, then makes the session, asks for the brief and the plan in plain words, and shows cards", async () => {
    const order: string[] = [];
    const a = fakeApi();
    a.saveOnboardingProgress.mockImplementation(async () => { order.push("save"); });
    a.guideSession.mockImplementation(async () => { order.push("session"); return a.state(); });
    const { box } = await draw(a);
    expect(order.slice(0, 2)).toEqual(["save", "session"]); // the answers are stored before the session is made from them
    expect(a.askArchitect).toHaveBeenCalledWith(SID);
    expect(a.askUnderstand).toHaveBeenCalledWith(SID, "simple");
    expect(box.textContent).toContain("Your plan for My Site");
    expect(box.textContent).toContain("Part d1");
    expect(box.textContent).toContain("Does d2.");
    expect(words.forbiddenIn(box.textContent)).toEqual([]);
    expect(box.textContent).not.toMatch(/#\d/);
    expect(on(box, "guide-continue")).toBe(false);
  });

  it("waits while the architect works, without a fixed time", async () => {
    const a = fakeApi({}, { architect: { state: "running" } });
    let polls = 0;
    a.refinementSession.mockImplementation(async () => { polls += 1; a.set({ ...a.state(), architect: polls < 3 ? { state: "running" } : { state: "idle" }, drafts: polls < 3 ? [] : [draft("d1")] }); return a.state(); });
    const { box } = await draw(a);
    expect(polls).toBe(3);
    expect(box.textContent).toContain("Part d1");
    expect(a.askArchitect).not.toHaveBeenCalled();
  });

  it("shows Try again when the architect stopped, and asks again", async () => {
    const a = fakeApi({}, { architect: { state: "failed", reason: "It broke", kind: "brief" } });
    const { box } = await draw(a);
    expect(box.textContent).toContain(words.GUIDE.plan.stopped);
    a.set({ ...a.state(), architect: { state: "idle" }, brief: "x", drafts: [draft("d1")] });
    await press(box, "guide-plan-retry");
    expect(a.askArchitect).toHaveBeenCalledTimes(1);
  });

  it("changes a card, and removes one only after a yes", async () => {
    const a = fakeApi();
    const { box, ask } = await draw(a);
    await press(box, "guide-change-d1");
    const title = box.all("input").find((e) => e.getAttribute("data-focus") === "guide-plan-title-d1")!;
    title.value = "A better name";
    const what = box.all("textarea")[0]!;
    what.value = "It does more.";
    await press(box, "guide-plan-save-d1");
    expect(a.saveDraft).toHaveBeenCalledWith(SID, "d1", { title: "A better name", what: "It does more." });
    expect(box.textContent).toContain("A better name");
    ask.mockResolvedValueOnce(false);
    await press(box, "guide-remove-d2");
    expect(a.removeDraft).not.toHaveBeenCalled();
    await press(box, "guide-remove-d2");
    expect(a.removeDraft).toHaveBeenCalledWith(SID, "d2");
    expect(box.textContent).not.toContain("Part d2");
  });

  it("builds: check, accept anyway with the fixed reason, publish with the build switch, watcher, then step 7 and the project's page", async () => {
    const order: string[] = [];
    const a = fakeApi();
    a.saveOnboardingProgress.mockImplementation(async (p: any) => { order.push(`save ${p.step} build=${p.answers.build} plan=${p.answers.plan}`); });
    a.publish.mockImplementation(async (_id: string, body: any) => { order.push("publish"); a.set({ ...a.state(), drafts: a.state().drafts.map((d: any) => ({ ...d, published: { issue: 1 } })) }); return body; });
    const { box, go } = await draw(a);
    order.length = 0;
    await press(box, "guide-build");
    expect(a.checkReady).toHaveBeenCalledTimes(2);
    expect(a.acceptAnyway).toHaveBeenCalledWith(SID, "d1", "r1", model.ACCEPT_REASON);
    expect(a.acceptAnyway).toHaveBeenCalledTimes(2);
    expect(a.publish).toHaveBeenCalledTimes(1);
    expect(a.publish.mock.calls[0][1]).toEqual({ drafts: [{ draft: "d1", startBuilding: true }, { draft: "d2", startBuilding: true }] });
    expect(a.addRepoWatcher).toHaveBeenCalledTimes(1);
    expect(a.tickWatcher).toHaveBeenCalledTimes(1);
    // build=true is stored before the first change; the completion is stored before the guide leaves
    expect(order[0]).toBe("save step-6 build=true plan=undefined");
    expect(order.indexOf("publish")).toBeGreaterThan(0);
    expect(order).toContain("save step-6 build=undefined plan=built");
    expect(go).toHaveBeenCalledWith(`#/repos/${ID}`);
    expect(box.textContent).toContain("Step 7 of 7");
    expect(box.all("a").some((l) => l.getAttribute("href") === `#/repos/${ID}`)).toBe(true);
  });

  it("makes nothing before the save of build=true has landed, and nothing if it fails", async () => {
    const slow = deferred();
    const a = fakeApi();
    const { box } = await draw(a);
    a.saveOnboardingProgress.mockImplementationOnce(async () => { await slow.promise; });
    await press(box, "guide-build");
    expect(a.checkReady).not.toHaveBeenCalled();
    slow.resolve();
    await flush();
    expect(a.checkReady).toHaveBeenCalled();

    const failing = fakeApi();
    const second = await draw(failing);
    failing.saveOnboardingProgress.mockImplementationOnce(async () => { throw new Error("disk"); });
    await press(second.box, "guide-build");
    expect(failing.checkReady).not.toHaveBeenCalled();
    expect(failing.publish).not.toHaveBeenCalled();
    expect(second.box.textContent).toContain(words.GUIDE.plan.notSaved);
    expect(on(second.box, "guide-build")).toBe(true); // the person can try again
  });

  it("does not build while an edit is being saved, and publishes the saved text", async () => {
    const slow = deferred();
    const order: string[] = [];
    const a = fakeApi();
    const saved = a.saveDraft;
    a.saveDraft = vi.fn(async (...args: any[]) => { await slow.promise; const s = await saved(...args); order.push("save-draft"); return s; });
    a.publish.mockImplementation(async () => { order.push("publish"); a.set({ ...a.state(), drafts: a.state().drafts.map((d: any) => ({ ...d, published: { issue: 1 } })) }); return {}; });
    const { box } = await draw(a);
    await press(box, "guide-change-d1");
    const title = box.all("input").find((e) => e.getAttribute("data-focus") === "guide-plan-title-d1")!;
    title.value = "Saved title";
    await press(box, "guide-plan-save-d1");
    expect(on(box, "guide-build")).toBe(false); // off while the edit is open
    await press(box, "guide-build");
    expect(a.checkReady).not.toHaveBeenCalled();
    expect(a.publish).not.toHaveBeenCalled();
    expect(box.textContent).toContain(words.GUIDE.plan.saveFirst);
    slow.resolve();
    await flush();
    await press(box, "guide-build");
    expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("save-draft"));
    expect(a.publish).toHaveBeenCalled();
  });

  it("does not leave for step 7 when the completion could not be saved", async () => {
    const a = fakeApi();
    const { box, go } = await draw(a);
    let saves = 0;
    a.saveOnboardingProgress.mockImplementation(async () => { saves += 1; if (saves === 2) throw new Error("disk"); });
    await press(box, "guide-build");
    expect(a.publish).toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(box.textContent).not.toContain("Step 7 of 7");
    expect(box.textContent).toContain(words.GUIDE.plan.notSaved);
  });

  it("goes on by itself when it opens with build=true", async () => {
    const a = fakeApi({ onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: { ...ANSWERS, build: true, session: SID } })) }, { drafts: [draft("d1")], brief: "x" });
    const { go } = await draw(a);
    expect(a.askArchitect).not.toHaveBeenCalled();
    expect(a.publish).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(`#/repos/${ID}`);
  });

  it("stops at a part that says how, not what, and offers Change, Remove and Check again", async () => {
    const a = fakeApi();
    a.checkReady.mockImplementation(async (_id: string, did: string) => {
      a.set({ ...a.state(), drafts: a.state().drafts.map((d: any) => (d.id === did ? checked(d, [["np", "not-met"], ["r1", "met"]]) : d)) });
      return a.state();
    });
    const { box, go } = await draw(a);
    await press(box, "guide-build");
    expect(box.textContent).toContain(words.GUIDE.plan.blocked);
    expect(a.publish).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(button(box, "guide-change-d1")).toBeDefined();
    expect(button(box, "guide-remove-d1")).toBeDefined();
    expect(button(box, "guide-recheck-d1")).toBeDefined();
    // removing the parts that are stuck lets the build finish
    await press(box, "guide-remove-d1");
    await press(box, "guide-remove-d2");
    expect(box.textContent).not.toContain("Part d1");
  });

  it("makes no more calls after the step is left", async () => {
    const a = fakeApi({}, { architect: { state: "running" } });
    const { cleanup } = await draw(a, { wait: () => new Promise(() => {}) });
    cleanup();
    const before = a.refinementSession.mock.calls.length;
    await flush();
    expect(a.refinementSession.mock.calls.length).toBe(before);
    expect(a.publish).not.toHaveBeenCalled();
  });

  it("goes Back to step 5 from step 6 and again from step 7", async () => {
    const a = fakeApi();
    const { box } = await draw(a);
    await press(box, "guide-back");
    expect(box.textContent).toContain("Step 5 of 7");
    const seven = await draw(fakeApi({ onboardingProgress: vi.fn(async () => ({ step: "step-7", answers: ANSWERS })) }));
    expect(seven.box.textContent).toContain(words.GUIDE.grow.text);
    expect(seven.box.all("a").some((l) => l.getAttribute("href") === `#/repos/${ID}`)).toBe(true);
    await press(seven.box, "guide-back");
    expect(seven.box.textContent).toContain("Step 6 of 7");
  });
});

describe("the texts of steps 6 and 7", () => {
  it("use no forbidden term", () => {
    const texts: string[] = [];
    const walk = (x: any) => { if (typeof x === "string") texts.push(x); else if (typeof x === "function") texts.push(x("My Site")); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
    walk(words.GUIDE.plan);
    walk(words.GUIDE.grow);
    for (const t of texts) expect(words.forbiddenIn(t), t).toEqual([]);
  });
});
