import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GUIDE_STEPS as SERVER_STEPS } from "../src/onboarding/progress-store.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let model: any;
let words: any;
let agentsUi: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/onboarding-guide.js" as string);
  model = await import("../ui/onboarding-guide-model.js" as string);
  words = await import("../ui/simple-words.js" as string);
  agentsUi = await import("../ui/onboarding-agents.js" as string);
});
afterAll(() => restore());

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const deferred = () => {
  let resolve!: (v?: any) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const item = (id: string, name: string, state: string, over: any = {}) => ({ id, name, needed: true, state, explain: "", ...over });
const GREEN = { items: [item("git", "Git", "ok"), item("claude", "Claude Code", "ok")], ready: true, problems: 0, unchecked: 0 };
const RED = { items: [item("git", "Git", "ok"), item("claude", "Claude Code", "missing", { explain: "Claude Code is not on this computer.", command: "npm install -g claude" })], ready: false, problems: 1, unchecked: 0 };
// ready for what is needed, but an optional row is not green
const OPTIONAL_RED = { items: [item("git", "Git", "ok"), item("codex", "Codex", "missing", { needed: false, explain: "Codex is not on this computer." })], ready: true, problems: 0, unchecked: 0 };

const make = (over: any = {}) => ({
  onboardingProgress: vi.fn(async () => ({ step: null, answers: {} })),
  saveOnboardingProgress: vi.fn(async (p: any) => p),
  clearOnboardingProgress: vi.fn(async () => ({ step: null, answers: {} })),
  setupCheck: vi.fn(async () => GREEN),
  starters: vi.fn(async () => ({ starters: [], broken: [] })),
  startProject: vi.fn(async () => ({ repo: { id: "11111111-1111-4111-8111-111111111111" } })),
  repos: vi.fn(async () => []),
  ...over,
});
const agentsStub = () => {
  const stop = vi.fn();
  const fn = vi.fn(async (box: FakeElement) => {
    box.replaceChildren(new FakeElement("h1"));
    box.children.length = 0;
    return stop;
  });
  return Object.assign(fn, { stop });
};
const draw = async (a: any, o: any = {}) => {
  const box = new FakeElement("div");
  const go = vi.fn();
  const ask = vi.fn(async () => true);
  const agents = o.agents ?? agentsStub();
  const cleanup = await ui.renderOnboardingGuide(box, { a, admin: true, notify: () => {}, ask, go, agents, clipboard: { writeText: vi.fn(async () => {}) }, ...o });
  return { box, cleanup, go, ask, agents };
};
const button = (box: FakeElement, focus: string) => box.all("button").find((b) => b.getAttribute("data-focus") === focus);
const press = async (box: FakeElement, focus: string) => {
  const b = button(box, focus);
  if (!b) throw new Error(`no button ${focus} in: ${box.textContent}`);
  b.click();
  await flush();
};
const disabled = (box: FakeElement, focus: string) => button(box, focus)?.getAttribute("disabled") !== null;

describe("the model", () => {
  it("has the same step ids as the server", () => {
    expect(model.STEP_IDS).toEqual([...SERVER_STEPS]);
  });

  it("walks the chain and falls back to the first step for an unknown id", () => {
    expect(model.knownStep("x")).toBe("welcome");
    expect(model.knownStep("agents")).toBe("agents");
    expect(model.nextStep("welcome")).toBe("computer");
    expect(model.nextStep("step-7")).toBeNull();
    expect(model.prevStep("welcome")).toBeNull();
    expect(model.prevStep("step-3")).toBe("agents");
    expect(model.stepLabel("agents")).toBe("Step 2b of 7");
    expect(model.stepLabel("nope")).toBe("Step 1 of 7");
  });

  it("turns Continue on at the computer step only when every row is green, for an admin", () => {
    const can = (o: any) => model.canContinue("computer", o);
    expect(can({ admin: true })).toBe(false);
    expect(can({ admin: true, report: RED })).toBe(false);
    expect(can({ admin: true, report: GREEN })).toBe(true);
    expect(can({ admin: true, report: GREEN, failed: true })).toBe(false);
    expect(can({ admin: true, report: { ...GREEN, items: [] } })).toBe(false);
    // "ready" counts what is needed; an optional row that is not green still holds Continue
    expect(can({ admin: true, report: OPTIONAL_RED })).toBe(false);
    expect(can({ admin: false })).toBe(true);
    expect(model.canContinue("welcome", {})).toBe(true);
    expect(model.canContinue("step-7", { admin: true })).toBe(false);
    // step 6 holds an admin until the plan is built; someone who is not an admin can go on
    expect(model.canContinue("step-6", { admin: true })).toBe(false);
    expect(model.canContinue("step-6", { admin: true, answers: { plan: "built" } })).toBe(true);
    expect(model.canContinue("step-6", { admin: false })).toBe(true);
  });

  it("reads and builds the saved progress", () => {
    expect(model.progressFrom({ step: "agents", answers: { a: 1 } })).toEqual({ step: "agents", answers: { a: 1 } });
    expect(model.progressFrom({ step: "gone", answers: [] })).toEqual({ step: "welcome", answers: {} });
    expect(model.progressFrom(null)).toEqual({ step: "welcome", answers: {} });
    expect(model.requestOf({ step: "x", answers: { a: 1 } })).toEqual({ step: "welcome", answers: { a: 1 } });
    expect(model.withAnswer({ step: "computer", answers: { a: 1 } }, "b", 2)).toEqual({ step: "computer", answers: { a: 1, b: 2 } });
    expect(model.withAnswer({ step: "computer", answers: { a: 1 } }, "a", null)).toEqual({ step: "computer", answers: {} });
  });

  it("keeps only known choices of a saved draft, and a question that is in the chain", () => {
    const x = { draft: { have: "both", plans: { claude: "max", codex: "wrong", other: "x" }, share: "nope", busy: "fast" }, step: "share" };
    expect(model.cleanAgentsDraft(x)).toEqual({ draft: { have: "both", plans: { claude: "max" }, share: "auto", busy: "fast" }, step: "share" });
    expect(model.cleanAgentsDraft({ draft: { have: "claude", plans: {}, busy: "normal" }, step: "share" })?.step).toBe("have");
    expect(model.cleanAgentsDraft({ draft: { have: "junk" }, step: "have" })).toBeNull();
    for (const bad of [null, undefined, 1, "x", [], { draft: null }, { draft: [] }]) expect(model.cleanAgentsDraft(bad)).toBeNull();
  });

  it("uses no forbidden term in any guide text", () => {
    const texts: string[] = [];
    const walk = (v: any) => {
      if (typeof v === "string") texts.push(v);
      else if (typeof v === "function") texts.push(String(v("2b")));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(words.GUIDE);
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) expect(words.forbiddenIn(t), t).toEqual([]);
  });
});

describe("the steps", () => {
  it("opens at Welcome with three sentences, and Continue saves the next step", async () => {
    const a = make();
    const { box } = await draw(a);
    expect(box.all("h1").map((h) => h.textContent)).toEqual(["Get started"]);
    expect(box.textContent).toContain("Step 1 of 7");
    expect(box.all("p").filter((p) => words.GUIDE.welcome.lines.includes(p.textContent))).toHaveLength(3);
    await press(box, "guide-continue");
    expect(a.saveOnboardingProgress).toHaveBeenCalledWith({ step: "computer", answers: {} });
    expect(box.textContent).toContain("Step 2 of 7");
  });

  it("goes to My projects with Back on the first step", async () => {
    const { box, go, ask } = await draw(make());
    await press(box, "guide-back");
    expect(go).toHaveBeenCalledWith("#/home");
    expect(ask).not.toHaveBeenCalled();
  });

  it("shows the loading state while the saved place is read, and an error with Retry", async () => {
    const d = deferred();
    const a = make({ onboardingProgress: vi.fn(() => d.promise) });
    const box = new FakeElement("div");
    const p = ui.renderOnboardingGuide(box, { a, admin: true, agents: agentsStub(), go: vi.fn(), ask: vi.fn() });
    await flush();
    expect(box.all("div").some((e) => e.getAttribute("aria-busy") === "true")).toBe(true);
    d.reject(Object.assign(new Error("x"), { status: 500 }));
    await p;
    expect(box.all("div").some((e) => e.getAttribute("role") === "alert")).toBe(true);
    a.onboardingProgress.mockResolvedValueOnce({ step: "computer", answers: {} });
    box.all("button").find((b) => b.textContent === "Retry")!.click();
    await flush();
    expect(box.textContent).toContain("Your computer");
  });

  describe("Your computer, as an admin", () => {
    const atComputer = (a: any) => draw({ ...a, onboardingProgress: vi.fn(async () => ({ step: "computer", answers: {} })) });

    it("shows the loading state, then the rows; Continue stays off until every row is green", async () => {
      const d = deferred();
      const a = make({ setupCheck: vi.fn(() => d.promise) });
      const box = new FakeElement("div");
      const p = ui.renderOnboardingGuide(box, { a: { ...a, onboardingProgress: vi.fn(async () => ({ step: "computer", answers: {} })) }, admin: true, agents: agentsStub(), go: vi.fn(), ask: vi.fn() });
      await flush();
      expect(box.all("div").some((e) => e.getAttribute("aria-busy") === "true")).toBe(true);
      expect(disabled(box, "guide-continue")).toBe(true);
      d.resolve(RED);
      await p;
      await flush();
      expect(box.all("strong").map((s) => s.textContent)).toEqual(["Git", "Claude Code"]);
      expect(disabled(box, "guide-continue")).toBe(true);
      expect(a.saveOnboardingProgress).not.toHaveBeenCalled();
    });

    it("turns Continue on after Check again finds every row green", async () => {
      const a = make({ setupCheck: vi.fn().mockResolvedValueOnce(RED).mockResolvedValue(GREEN) });
      const { box } = await atComputer(a);
      expect(disabled(box, "guide-continue")).toBe(true);
      await press(box, "guide-check");
      expect(a.setupCheck).toHaveBeenCalledTimes(2);
      expect(disabled(box, "guide-continue")).toBe(false);
      await press(box, "guide-continue");
      expect(a.saveOnboardingProgress).toHaveBeenCalledWith({ step: "agents", answers: {} });
    });

    it("keeps Continue off when only an optional row is not green, and says it is optional", async () => {
      const { box } = await atComputer(make({ setupCheck: vi.fn(async () => OPTIONAL_RED) }));
      expect(box.textContent).toContain("(optional)");
      expect(disabled(box, "guide-continue")).toBe(true);
    });

    it("shows an error with Retry when the check cannot be made, and Continue stays off", async () => {
      const a = make({ setupCheck: vi.fn().mockRejectedValueOnce(Object.assign(new Error("x"), { status: 500 })).mockResolvedValue(GREEN) });
      const { box } = await atComputer(a);
      expect(box.all("div").some((e) => e.getAttribute("role") === "alert")).toBe(true);
      expect(disabled(box, "guide-continue")).toBe(true);
      box.all("button").find((b) => b.textContent === "Retry")!.click();
      await flush();
      expect(disabled(box, "guide-continue")).toBe(false);
    });

    it("goes back to Welcome and saves it", async () => {
      const a = make();
      const { box } = await atComputer(a);
      await press(box, "guide-back");
      expect(a.saveOnboardingProgress).toHaveBeenCalledWith({ step: "welcome", answers: {} });
      expect(box.textContent).toContain("Step 1 of 7");
    });

    it("drops a late check answer after the person left the step or the page", async () => {
      const d = deferred();
      const a = make({ setupCheck: vi.fn(() => d.promise) });
      const { box, cleanup } = await draw({ ...a, onboardingProgress: vi.fn(async () => ({ step: "computer", answers: {} })) });
      await flush();
      cleanup();
      d.resolve(GREEN);
      await flush();
      expect(box.all("strong")).toHaveLength(0);
    });
  });

  it("asks a non-admin to ask an admin at steps 2 and 2b, makes no call, and leaves Continue on", async () => {
    for (const step of ["computer", "agents"]) {
      const a = make({ onboardingProgress: vi.fn(async () => ({ step, answers: {} })) });
      const agents = agentsStub();
      const { box } = await draw(a, { admin: false, agents });
      expect(box.textContent).toContain("Ask the person who looks after it");
      expect(a.setupCheck).not.toHaveBeenCalled();
      expect(agents).not.toHaveBeenCalled();
      expect(disabled(box, "guide-continue")).toBe(false);
    }
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "computer", answers: {} })) });
    const { box } = await draw(a, { readOnly: true });
    expect(box.textContent).toContain("Ask the person who looks after it");
    expect(a.setupCheck).not.toHaveBeenCalled();
  });

  describe("Claude and Codex", () => {
    const SAVED = { draft: { have: "claude", plans: { claude: "pro" }, share: "auto", busy: "little" }, step: "busy" };
    const atAgents = (answers: any = {}, agents = agentsStub(), over: any = {}) =>
      draw(make({ onboardingProgress: vi.fn(async () => ({ step: "agents", answers })), ...over }), { agents });

    it("draws the questions inside the guide, simple and without its own Start again, with the credentials link", async () => {
      const agents = agentsStub();
      const { box } = await atAgents({}, agents, {});
      expect(agents).toHaveBeenCalledTimes(1);
      const o = agents.mock.calls[0]![1];
      expect(o).toMatchObject({ simple: true, again: false, admin: true, readOnly: false, resume: { fresh: true } });
      expect(box.textContent).toContain("Step 2b of 7");
      expect(box.all("h1").map((h) => h.textContent)).toEqual([]); // the embedded page draws the heading
    });

    it("passes the credentials link of the display it is in", async () => {
      const agents = agentsStub();
      const box = new FakeElement("div");
      await ui.renderOnboardingGuide(box, { a: make({ onboardingProgress: vi.fn(async () => ({ step: "agents", answers: {} })) }), admin: true, agents, credentialsHref: "/#/credentials", go: vi.fn(), ask: vi.fn() });
      expect(agents.mock.calls[0]![1].credentialsHref).toBe("/#/credentials");
    });

    it("resumes at the saved question from the saved draft, and drops unknown values", async () => {
      const agents = agentsStub();
      await atAgents({ agents: { ...SAVED, draft: { ...SAVED.draft, busy: "junk" } } }, agents);
      expect(agents.mock.calls[0]![1].resume).toEqual({ draft: { ...SAVED.draft, busy: "normal" }, step: "busy" });
    });

    it("saves the draft under answers.agents when the questions report it, once per change", async () => {
      const agents = agentsStub();
      const a = make({ onboardingProgress: vi.fn(async () => ({ step: "agents", answers: { other: 1 } })) });
      await draw(a, { agents });
      const onDraft = agents.mock.calls[0]![1].onDraft;
      onDraft({ draft: SAVED.draft, step: "busy" });
      onDraft({ draft: SAVED.draft, step: "busy" });
      await flush();
      expect(a.saveOnboardingProgress).toHaveBeenCalledTimes(1);
      expect(a.saveOnboardingProgress).toHaveBeenCalledWith({ step: "agents", answers: { other: 1, agents: SAVED } });
      onDraft({ draft: SAVED.draft, step: null, done: true });
      await flush();
      expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "agents", answers: { other: 1, agents: { draft: SAVED.draft, step: null, done: true } } });
      // the completed state is saved once (the call before); a question with nothing chosen yet removes the draft: one more save
      expect(a.saveOnboardingProgress).toHaveBeenCalledTimes(2);
      onDraft({ draft: { have: null, plans: {}, share: "auto", busy: "normal" }, step: "have" });
      await flush();
      expect(a.saveOnboardingProgress).toHaveBeenCalledTimes(3);
    });

    it("keeps the draft when the person leaves and comes back (Back, then Continue)", async () => {
      const agents = agentsStub();
      const a = make({ onboardingProgress: vi.fn(async () => ({ step: "agents", answers: { agents: SAVED } })) });
      const { box } = await draw(a, { agents });
      await press(box, "guide-back");
      expect(agents.stop).toHaveBeenCalledTimes(1);
      expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "computer", answers: { agents: SAVED } });
      await press(box, "guide-check");
      await press(box, "guide-continue");
      expect(agents).toHaveBeenCalledTimes(2);
      expect(agents.mock.calls[1]![1].resume).toEqual(SAVED);
    });

    it("stops the questions on leaving, and ignores a draft that arrives after", async () => {
      const agents = agentsStub();
      const a = make({ onboardingProgress: vi.fn(async () => ({ step: "agents", answers: {} })) });
      const { box } = await draw(a, { agents });
      const onDraft = agents.mock.calls[0]![1].onDraft;
      await press(box, "guide-continue");
      expect(agents.stop).toHaveBeenCalled();
      a.saveOnboardingProgress.mockClear();
      onDraft({ draft: SAVED.draft, step: "busy" });
      await flush();
      expect(a.saveOnboardingProgress).not.toHaveBeenCalled();
    });
  });

  it("walks steps 6 and 7 with Continue and Back for someone who is not an admin; the last step has no Continue", async () => {
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: {} })) });
    const { box } = await draw(a, { admin: false });
    expect(box.textContent).toContain(words.GUIDE.plan.askAdmin);
    await press(box, "guide-continue");
    expect(box.textContent).toContain("Step 7 of 7");
    expect(box.textContent).toContain(words.GUIDE.grow.askAdmin);
    expect(button(box, "guide-continue")).toBeUndefined();
    expect(button(box, "guide-back")).toBeDefined();
    await press(box, "guide-back");
    expect(box.textContent).toContain("Step 6 of 7");
  });

  it("opens the saved step, and Welcome for a step it does not know", async () => {
    const { box } = await draw(make({ onboardingProgress: vi.fn(async () => ({ step: "step-5", answers: {} })) }));
    expect(box.textContent).toContain("Step 5 of 7");
    const other = await draw(make({ onboardingProgress: vi.fn(async () => ({ step: "pick-idea", answers: {} })) }));
    expect(other.box.textContent).toContain("Step 1 of 7");
    const none = await draw(make({ onboardingProgress: vi.fn(async () => ({})) }));
    expect(none.box.textContent).toContain("Step 1 of 7");
  });
});

describe("Start again", () => {
  it("clears the progress after a confirm and shows Welcome", async () => {
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "step-4", answers: { agents: 1 } })) });
    const { box, ask } = await draw(a);
    await press(box, "guide-again");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(a.clearOnboardingProgress).toHaveBeenCalledTimes(1);
    expect(box.textContent).toContain("Step 1 of 7");
    await press(box, "guide-continue");
    expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "computer", answers: {} });
  });

  it("does nothing when the confirm is cancelled", async () => {
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "step-4", answers: {} })) });
    const { box } = await draw(a, { ask: vi.fn(async () => false) });
    await press(box, "guide-again");
    expect(a.clearOnboardingProgress).not.toHaveBeenCalled();
    expect(box.textContent).toContain("Step 4 of 7");
  });
});

describe("saving", () => {
  it("shows a quiet line when a save fails, and the step still changes", async () => {
    const a = make();
    a.saveOnboardingProgress.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 500 }));
    const { box } = await draw(a);
    await press(box, "guide-continue");
    expect(box.textContent).toContain("Step 2 of 7");
    expect(box.textContent).toContain(words.GUIDE.notSaved);
    expect(box.all("div").some((e) => e.getAttribute("role") === "alert")).toBe(false);
  });

  it("sends the saves in the order they were asked, even when the first is slow", async () => {
    const first = deferred();
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: {} })) });
    const order: string[] = [];
    a.saveOnboardingProgress.mockImplementationOnce(async (p: any) => { order.push(`start ${p.step}`); await first.promise; order.push(`end ${p.step}`); });
    a.saveOnboardingProgress.mockImplementation(async (p: any) => { order.push(`start ${p.step}`); order.push(`end ${p.step}`); });
    const { box } = await draw(a, { admin: false });
    await press(box, "guide-continue");
    await press(box, "guide-back");
    expect(order).toEqual(["start step-7"]);
    first.resolve();
    await flush();
    expect(order).toEqual(["start step-7", "end step-7", "start step-6", "end step-6"]);
  });

  it("sends a slow save before Start again, so the clear is the last word", async () => {
    const slow = deferred();
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: {} })) });
    const order: string[] = [];
    a.saveOnboardingProgress.mockImplementation(async (p: any) => { order.push(`save ${p.step}`); await slow.promise; });
    a.clearOnboardingProgress.mockImplementation(async () => { order.push("clear"); });
    const { box } = await draw(a, { admin: false });
    await press(box, "guide-continue");
    await press(box, "guide-again");
    expect(order).toEqual(["save step-7"]);
    slow.resolve();
    await flush();
    expect(order).toEqual(["save step-7", "clear"]);
  });

  it("reads the place again only after the saves of the guide that was left", async () => {
    const slow = deferred();
    const a = make({ onboardingProgress: vi.fn(async () => ({ step: "step-6", answers: {} })) });
    a.saveOnboardingProgress.mockImplementation(async () => { await slow.promise; });
    const first = await draw(a, { admin: false });
    await press(first.box, "guide-continue");
    first.cleanup();
    const box = new FakeElement("div");
    const reopened = ui.renderOnboardingGuide(box, { a, admin: false, agents: agentsStub(), go: vi.fn(), ask: vi.fn() });
    await flush();
    expect(a.onboardingProgress).toHaveBeenCalledTimes(1); // only the first open has read so far
    slow.resolve();
    await reopened;
    expect(a.onboardingProgress).toHaveBeenCalledTimes(2);
  });

  it("does not draw or save after cleanup", async () => {
    const a = make();
    const { box, cleanup } = await draw(a);
    cleanup();
    button(box, "guide-continue")?.click();
    await flush();
    expect(a.saveOnboardingProgress).not.toHaveBeenCalled();
  });
});

describe("Claude and Codex in the guide: completing, another admin, starting again", () => {
  const pressText = async (box: FakeElement, label: string) => {
    const b = box.all("button").find((x) => x.textContent === label);
    if (!b) throw new Error(`no button "${label}" in: ${box.textContent}`);
    b.click();
    await flush();
  };

  it("keeps the completed answers per account, shows them on return, and restarts the questions after Start again", async () => {
    let progress: any = { step: "agents", answers: {} };
    let shared: any = { answers: null, settings: null, current: null, kept: [], summary: [] };
    const a = make({
      onboardingProgress: vi.fn(async () => progress),
      saveOnboardingProgress: vi.fn(async (p: any) => { progress = p; return p; }),
      clearOnboardingProgress: vi.fn(async () => { progress = { step: null, answers: {} }; return progress; }),
      onboardingAgents: vi.fn(async () => shared),
      saveOnboardingAgents: vi.fn(async (answers: any) => { shared = { answers, settings: {}, current: {}, kept: [], summary: [] }; return shared; }),
      setupCheck: vi.fn(async () => GREEN),
    });
    const real = agentsUi.renderOnboardingAgents;

    // 1. complete the questions (one tool, so no sharing question)
    const first = await draw(a, { agents: real });
    expect(first.box.textContent).toContain("Which do you have?");
    await pressText(first.box, "Claude Code");
    await pressText(first.box, "Pro");
    await pressText(first.box, "Next"); // install
    await pressText(first.box, "Next"); // sign-in and test
    await pressText(first.box, "Normal");
    expect(shared.answers).toMatchObject({ have: "claude", plans: { claude: "pro" }, busy: "normal" });
    expect(progress.answers.agents).toEqual({ draft: { have: "claude", plans: { claude: "pro" }, share: "auto", busy: "normal" }, step: null, done: true });
    first.cleanup();

    // 2. another admin changes the settings
    shared = { answers: { have: "both", plans: { claude: "max", codex: "plus" }, share: "even", busy: "fast" }, settings: {}, current: {}, kept: [], summary: [] };

    // 3. back on the page: the own completed answers show, not the other admin's
    const again = await draw(a, { agents: real });
    expect(again.box.textContent).not.toContain("Which do you have?");
    expect(again.box.textContent).toContain("Claude Code");
    expect(again.box.textContent).toContain("Claude Code, Pro plan");
    expect(again.box.textContent).not.toContain("How they share the work");

    // 4. Start again on the guide: Welcome, then the questions from the first one, with the server's answers chosen; nothing is cleared
    await press(again.box, "guide-again");
    expect(a.clearOnboardingProgress).toHaveBeenCalledTimes(1);
    expect(again.box.textContent).toContain("Step 1 of 7");
    await press(again.box, "guide-continue"); // computer: the check is green
    expect(again.box.textContent).toContain("Step 2 of 7");
    await press(again.box, "guide-continue");
    expect(again.box.textContent).toContain("Step 2b of 7");
    expect(again.box.textContent).toContain("Which do you have?");
    expect(again.box.all("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent)).toEqual(["Both"]);
    expect(shared.answers.have).toBe("both");
    expect(a.saveOnboardingAgents).toHaveBeenCalledTimes(1); // only the first completion saved answers
    again.cleanup();
  });
});

describe("the page", () => {
  it("uses no forbidden term at any step, and passes the accessibility audit", async () => {
    for (const step of model.STEP_IDS) {
      const items = [item("git", "Git", "ok"), item("claude", "Claude Code", "missing", { explain: "Nothing to run: the job failed to find a model.", command: "npm install -g x" })];
      const a = make({ onboardingProgress: vi.fn(async () => ({ step, answers: {} })), setupCheck: vi.fn(async () => ({ items, ready: false })) });
      const { box } = await draw(a);
      expect(words.forbiddenIn(box.textContent), step).toEqual([]);
      expect(audit(box), step).toEqual([]);
    }
  });
});
