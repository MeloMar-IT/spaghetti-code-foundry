import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GUIDE_TEXT_LIMITS } from "../src/onboarding/progress-store.js";
import { MAX_NAME, projectName, projectSlug } from "../src/starters/starters.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let project: any;
let model: any;
let words: any;
let apiMod: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/onboarding-guide.js" as string);
  project = await import("../ui/onboarding-project.js" as string);
  model = await import("../ui/onboarding-guide-model.js" as string);
  words = await import("../ui/simple-words.js" as string);
  apiMod = await import("../ui/api.js" as string);
});
afterAll(() => restore());

const ID = "11111111-1111-4111-8111-111111111111";
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const deferred = () => {
  let resolve!: (v?: any) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const STARTERS = {
  starters: [
    { id: "website", title: "Website", description: "A small website.", needs: [], source: "built-in" },
    { id: "tool", title: "Tool", description: "A small helper.", needs: [], source: "built-in" },
  ],
  broken: [{ id: "oops", source: "own", problem: "no" }],
};
const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const stub = (step: string, answers: any, over: any = {}) => ({
  onboardingProgress: vi.fn(async () => ({ step, answers })),
  saveOnboardingProgress: vi.fn(async (p: any) => p),
  clearOnboardingProgress: vi.fn(async () => ({})),
  setupCheck: vi.fn(),
  starters: vi.fn(async () => STARTERS),
  startProject: vi.fn(async () => ({ repo: { id: ID } })),
  repos: vi.fn(async () => []),
  ...over,
});
const draw = async (a: any, o: any = {}) => {
  const box = new FakeElement("div");
  const go = vi.fn();
  const store = o.store ?? memStore();
  const cleanup = await ui.renderOnboardingGuide(box, { a, admin: true, notify: () => {}, ask: vi.fn(async () => true), go, agents: vi.fn(), store, ...o });
  return { box, cleanup, go, store };
};
const button = (box: FakeElement, focus: string) => box.all("button").find((b) => b.getAttribute("data-focus") === focus);
const press = async (box: FakeElement, focus: string) => {
  const b = button(box, focus);
  if (!b) throw new Error(`no button ${focus} in: ${box.textContent}`);
  b.click();
  await flush();
};
const field = (box: FakeElement, focus: string) => [...box.all("input"), ...box.all("textarea")].find((e) => e.getAttribute("data-focus") === focus)!;
const type = async (box: FakeElement, focus: string, value: string, event = "input") => {
  const el = field(box, focus);
  el.value = value;
  el.fire(event, { target: el });
  await flush();
};
const off = (box: FakeElement, focus: string) => button(box, focus)?.getAttribute("disabled") !== null;
const FULL = { starter: "website", name: "My Site", about: { what: "show my work" } };

describe("the model's rules", () => {
  it("nameProblem agrees with the server's name rule", () => {
    for (const raw of ["a", "東京 サイト", "!!!", " ", "x".repeat(60), "x".repeat(61), "é", "a\u0001", "  ok  "]) {
      let server: string | null = null;
      try {
        projectSlug(projectName(raw));
      } catch (e: any) {
        server = /longer/.test(e.message) ? "long" : /control/.test(e.message) ? "control" : /letter/.test(e.message) ? "letters" : "empty";
      }
      expect(model.nameProblem(raw), JSON.stringify(raw)).toBe(server);
    }
  });

  it("has the same limits as the server", () => {
    expect({ who: model.GUIDE_LIMITS.who, what: model.GUIDE_LIMITS.what, style: model.GUIDE_LIMITS.style, name: model.GUIDE_LIMITS.name }).toEqual(GUIDE_TEXT_LIMITS);
    expect(model.GUIDE_LIMITS.nameMax).toBe(MAX_NAME);
  });

  it("canContinue for steps 3 to 5", () => {
    const c = model.canContinue;
    expect(c("step-3", { admin: true, answers: {}, starterIds: ["website"] })).toBe(false);
    expect(c("step-3", { admin: true, answers: { starter: "website" }, starterIds: ["website"] })).toBe(true);
    expect(c("step-3", { admin: true, answers: { starter: "gone" }, starterIds: ["website"] })).toBe(false);
    expect(c("step-3", { admin: true, answers: { repoId: ID }, starterIds: [] })).toBe(true);
    expect(c("step-3", { admin: false, answers: {} })).toBe(true);
    expect(c("step-4", { answers: {} })).toBe(false);
    expect(c("step-4", { answers: { name: "!!!", about: { what: "x" } } })).toBe(false);
    expect(c("step-4", { answers: FULL })).toBe(true);
    expect(c("step-5", { admin: true, answers: FULL })).toBe(true);
    expect(c("step-5", { admin: true, answers: { ...FULL, where: "github" } })).toBe(false);
    expect(c("step-5", { admin: true, answers: { ...FULL, where: "github" }, github: true })).toBe(true);
    expect(c("step-5", { admin: true, answers: { repoId: ID, where: "github" } })).toBe(true);
    expect(c("step-5", { admin: false, answers: {} })).toBe(true);
  });

  it("offers only the starters list, and sorts out each failed make", () => {
    expect(model.starterChoices(STARTERS).map((s: any) => s.id)).toEqual(["website", "tool"]);
    expect(model.starterChoices({ broken: [{ id: "x" }] })).toEqual([]);
    const e = (status: number | undefined, message = "") => model.makeOutcome(Object.assign(new Error(message), { status }));
    expect(e(undefined)).toBe("lost");
    expect(model.makeOutcome(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("lost");
    expect(e(409, "a folder with that name exists already")).toBe("exists");
    expect(e(409, "the starter cannot be used")).toBe("gone");
    expect(e(404)).toBe("gone");
    expect(e(400)).toBe("name");
    expect(e(403)).toBe("denied");
    expect(e(500)).toBe("other");
  });

  it("returnToGuide keeps the marker until the guide is reached", async () => {
    const store = memStore();
    const go = vi.fn();
    expect(await model.returnToGuide({ store, choose: vi.fn(), go })).toBeNull();
    model.markGuideReturn(store, "simple");
    const choose = vi.fn(async () => null as any);
    expect(await model.returnToGuide({ store, choose, go })).toBeNull();
    expect(model.guideReturnView(store)).toBe("simple");
    choose.mockResolvedValueOnce("Problem text." as any);
    expect(await model.returnToGuide({ store, choose, go })).toBe("Problem text.");
    expect(model.guideReturnView(store)).toBe("simple");
    choose.mockResolvedValueOnce("" as any);
    expect(await model.returnToGuide({ store, choose, go })).toBe("");
    expect(model.guideReturnView(store)).toBeNull();
    expect(choose).toHaveBeenLastCalledWith("simple", expect.objectContaining({ hash: expect.any(Function) }));
    model.markGuideReturn(store, "advanced");
    expect(await model.returnToGuide({ store, choose, go })).toBe("");
    expect(go).toHaveBeenCalledWith("#/start-guide");
    expect(model.guideReturnView(store)).toBeNull();
  });
});

describe("step 3", () => {
  it("lists the starters with an example, saves the choice and turns Continue on", async () => {
    const a = stub("step-3", {});
    const { box } = await draw(a);
    expect(box.textContent).toContain("Website");
    expect(box.textContent).toContain(words.GUIDE.make.examples.website);
    expect(box.textContent).not.toContain("oops");
    expect(button(box, "guide-starter-oops")).toBeUndefined();
    expect(off(box, "guide-continue")).toBe(true);
    await press(box, "guide-starter-website");
    expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "step-3", answers: { starter: "website" } });
    expect(off(box, "guide-continue")).toBe(false);
  });

  it("keeps Continue off for a saved starter that is no longer listed", async () => {
    const { box } = await draw(stub("step-3", { starter: "retired" }));
    expect(off(box, "guide-continue")).toBe(true);
  });

  it("locks the choices once the project is made", async () => {
    const { box } = await draw(stub("step-3", { starter: "website", repoId: ID }));
    expect(box.textContent).toContain(words.GUIDE.make.made);
    expect(off(box, "guide-starter-website")).toBe(true);
    expect(off(box, "guide-continue")).toBe(false);
  });

  it("makes no starter call for someone who is not an admin, and Continue is on", async () => {
    const a = stub("step-3", {});
    const { box } = await draw(a, { admin: false });
    expect(box.textContent).toContain(words.GUIDE.make.askAdmin);
    expect(a.starters).not.toHaveBeenCalled();
    expect(off(box, "guide-continue")).toBe(false);
    const preview = stub("step-3", {});
    await draw(preview, { readOnly: true });
    expect(preview.starters).not.toHaveBeenCalled();
  });

  it("offers Retry when the list does not load", async () => {
    const a = stub("step-3", {}, { starters: vi.fn().mockRejectedValueOnce(Object.assign(new Error("x"), { status: 500 })).mockResolvedValue(STARTERS) });
    const { box } = await draw(a);
    expect(box.all("div").some((e) => e.getAttribute("role") === "alert")).toBe(true);
    box.all("button").find((b) => b.textContent === "Retry")!.click();
    await flush();
    expect(box.textContent).toContain("Website");
  });

  it("every text it shows is free of forbidden words", () => {
    const walk = (v: any): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(walk) : []);
    for (const t of [...walk(words.GUIDE.make), ...walk(words.GUIDE.about), ...walk(words.GUIDE.where), words.GUIDE.backToGuide, words.GUIDE.againConfirm.text]) {
      expect(words.forbiddenIn(t), t).toEqual([]);
    }
  });
});

describe("step 4", () => {
  it("asks for style only for the website, and saves on change", async () => {
    const a = stub("step-4", { starter: "website" });
    const { box } = await draw(a);
    expect(field(box, "guide-style")).toBeDefined();
    await type(box, "guide-what", "show my work", "change");
    expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "step-4", answers: { starter: "website", about: { what: "show my work" } } });
    const other = await draw(stub("step-4", { starter: "tool" }));
    expect(field(other.box, "guide-style")).toBeUndefined();
  });

  it("saves the name !!!, shows the plain problem, keeps Continue off and survives a new guide", async () => {
    const a = stub("step-4", { starter: "tool", about: { what: "x" } });
    const { box, cleanup } = await draw(a);
    await type(box, "guide-name", "!!!", "change");
    expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "step-4", answers: { starter: "tool", about: { what: "x" }, name: "!!!" } });
    expect(box.textContent).toContain("Use at least one letter or digit.");
    expect(off(box, "guide-continue")).toBe(true);
    cleanup();
    const again = await draw(stub("step-4", { starter: "tool", about: { what: "x" }, name: "!!!" }));
    expect(field(again.box, "guide-name").value).toBe("!!!");
    expect(again.box.textContent).toContain("Use at least one letter or digit.");
  });

  it("saves typed text that had no change event when the step is left, and Back goes to step 3", async () => {
    const a = stub("step-4", {});
    const { box } = await draw(a);
    await type(box, "guide-what", "typed");
    await press(box, "guide-back");
    expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "step-3", answers: { about: { what: "typed" } } });
    expect(box.textContent).toContain("Step 3 of 7");
  });

  it("turns Continue on when the what text and a name are there", async () => {
    const { box } = await draw(stub("step-4", { starter: "tool" }));
    await type(box, "guide-what", "a thing");
    expect(off(box, "guide-continue")).toBe(true);
    await type(box, "guide-name", "Thing");
    expect(off(box, "guide-continue")).toBe(false);
  });
});

describe("step 5", () => {
  it("makes the project once for two quick presses, then shows step 6", async () => {
    const d = deferred();
    const a = stub("step-5", FULL, { startProject: vi.fn(() => d.promise) });
    const { box } = await draw(a);
    await press(box, "guide-continue");
    await press(box, "guide-continue");
    expect(a.startProject).toHaveBeenCalledTimes(1);
    expect(a.startProject).toHaveBeenCalledWith("website", { name: "My Site", guide: true });
    expect(off(box, "guide-back")).toBe(true);
    expect(off(box, "guide-again")).toBe(true);
    d.resolve({ repo: { id: ID } });
    await flush();
    expect(box.textContent).toContain("Step 6 of 7");
  });

  it("lands a save asked before the press before the call", async () => {
    const order: string[] = [];
    const slow = deferred();
    const a = stub("step-5", FULL, {
      saveOnboardingProgress: vi.fn(async () => { order.push("save"); await slow.promise; }),
      startProject: vi.fn(async () => { order.push("make"); return { repo: { id: ID } }; }),
    });
    const { box } = await draw(a);
    await press(box, "guide-where-local");
    await press(box, "guide-continue");
    expect(order).toEqual(["save"]);
    slow.resolve();
    await flush();
    expect(order).toEqual(["save", "make", "save"]);
  });

  it("does not call again when the project is known: Back then Continue, and resuming", async () => {
    const a = stub("step-5", { ...FULL, repoId: ID });
    const { box } = await draw(a);
    expect(box.textContent).toContain(words.GUIDE.where.made);
    expect(button(box, "guide-open")?.tag).toBeUndefined(); // a link, not a button
    expect(box.all("a").find((l) => l.getAttribute("data-focus") === "guide-open")?.getAttribute("href")).toBe(`#/repos/${ID}`);
    await press(box, "guide-back");
    await press(box, "guide-continue");
    await press(box, "guide-continue");
    expect(a.startProject).not.toHaveBeenCalled();
    expect(a.clearOnboardingProgress).not.toHaveBeenCalled();
    expect(box.textContent).toContain("Step 6 of 7");
  });

  it("a 409 'exists' without a made project shows the message and Choose another name goes to step 4", async () => {
    const e = Object.assign(new Error("a folder with that name exists already"), { status: 409 });
    const a = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValue(e) });
    const { box } = await draw(a);
    await press(box, "guide-continue");
    expect(box.textContent).toContain(words.GUIDE.where.exists);
    expect(box.textContent).not.toContain("exists already");
    expect(a.onboardingProgress).toHaveBeenCalledTimes(2);
    expect(off(box, "guide-back")).toBe(false);
    await press(box, "guide-rename");
    expect(box.textContent).toContain("Step 4 of 7");
  });

  it("a 409 'exists' moves on when the place now holds the project", async () => {
    const e = Object.assign(new Error("exists already"), { status: 409 });
    const a = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValue(e) });
    const { box } = await draw(a);
    a.onboardingProgress.mockResolvedValue({ step: "step-5", answers: { ...FULL, repoId: ID } });
    await press(box, "guide-continue");
    expect(box.textContent).toContain("Step 6 of 7");
  });

  it("no answer: moves on if the place holds the project, else offers Try again and the buttons work", async () => {
    const lost = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const a = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValueOnce(lost).mockResolvedValue({ repo: { id: ID } }) });
    const { box } = await draw(a);
    await press(box, "guide-continue");
    expect(box.textContent).toContain(words.GUIDE.where.lost);
    expect(off(box, "guide-back")).toBe(false);
    expect(off(box, "guide-continue")).toBe(false);
    await press(box, "guide-retry");
    expect(a.startProject).toHaveBeenCalledTimes(2);
    expect(box.textContent).toContain("Step 6 of 7");
    const b = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValue(lost) });
    const second = await draw(b);
    b.onboardingProgress.mockResolvedValue({ step: "step-5", answers: { ...FULL, repoId: ID } });
    await press(second.box, "guide-continue");
    expect(second.box.textContent).toContain("Step 6 of 7");
  });

  it("a stalled re-read does not hold the buttons for good once it fails", async () => {
    const lost = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const a = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValue(lost) });
    const { box } = await draw(a);
    a.onboardingProgress.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    await press(box, "guide-continue");
    expect(box.textContent).toContain(words.GUIDE.where.retry);
    expect(off(box, "guide-back")).toBe(false);
  });

  it("a 404 says the starter is gone and Choose again goes to step 3; a 400 shows the name text", async () => {
    const a = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValue(Object.assign(new Error("server text"), { status: 404 })) });
    const { box } = await draw(a);
    await press(box, "guide-continue");
    expect(box.textContent).toContain(words.GUIDE.where.gone);
    expect(box.textContent).not.toContain("server text");
    await press(box, "guide-choose");
    expect(box.textContent).toContain("Step 3 of 7");
    const b = stub("step-5", FULL, { startProject: vi.fn().mockRejectedValue(Object.assign(new Error("server text"), { status: 400 })) });
    const bad = await draw(b);
    await press(bad.box, "guide-continue");
    expect(bad.box.textContent).toContain(words.GUIDE.where.nameBad);
  });

  it("a non-admin sees the ask-admin text, Continue is on and nothing is called", async () => {
    const a = stub("step-5", {});
    const { box } = await draw(a, { admin: false });
    expect(box.textContent).toContain(words.GUIDE.where.askAdmin);
    await press(box, "guide-continue");
    expect(a.startProject).not.toHaveBeenCalled();
    expect(a.starters).not.toHaveBeenCalled();
    expect(box.textContent).toContain("Step 6 of 7");
  });

  it("a made project is never deleted: there is no delete call", async () => {
    const a = stub("step-5", { ...FULL, repoId: ID });
    const { box } = await draw(a);
    await press(box, "guide-again");
    expect(a.clearOnboardingProgress).toHaveBeenCalledTimes(1);
    expect(words.GUIDE.againConfirm.text).toContain("A project you made stays.");
  });
});

describe("GitHub", () => {
  const github = { ...FULL, where: "github" };

  it("saves the choice; Continue is off and Connect GitHub shows until GitHub is connected", async () => {
    const a = stub("step-5", FULL);
    const { box } = await draw(a);
    await press(box, "guide-where-github");
    expect(a.saveOnboardingProgress).toHaveBeenLastCalledWith({ step: "step-5", answers: { ...FULL, where: "github" } });
    expect(off(box, "guide-continue")).toBe(true);
    expect(button(box, "guide-github")).toBeDefined();
  });

  it("Connect GitHub saves, marks the way back and switches to Advanced in Simple", async () => {
    const a = stub("step-5", github);
    const choose = vi.fn(async () => "");
    const { box, store } = await draw(a, { simple: true, choose });
    await press(box, "guide-github");
    expect(a.saveOnboardingProgress).toHaveBeenCalled();
    expect(model.guideReturnView(store)).toBe("simple");
    expect(choose).toHaveBeenCalledWith("advanced", expect.objectContaining({ hash: expect.any(Function) }));
    expect((choose.mock.calls[0] as any)[1].hash()).toBe("#/repos");
  });

  it("goes to the repositories page in Advanced", async () => {
    const { box, go, store } = await draw(stub("step-5", github));
    await press(box, "guide-github");
    expect(go).toHaveBeenCalledWith("#/repos");
    expect(model.guideReturnView(store)).toBe("advanced");
  });

  it("keeps the marker and shows the problem when the switch is cancelled or gives a problem", async () => {
    const choose = vi.fn(async () => "The view could not be changed." as any);
    const { box, store } = await draw(stub("step-5", github), { simple: true, choose });
    await press(box, "guide-github");
    expect(model.guideReturnView(store)).toBe("simple");
    expect(box.textContent).toContain("The view could not be changed.");
    const cancelled = vi.fn(async () => null as any);
    const second = await draw(stub("step-5", github), { simple: true, choose: cancelled });
    await press(second.box, "guide-github");
    expect(model.guideReturnView(second.store)).toBe("simple");
  });

  it("with GitHub connected, Continue is on and makes the project; opening the guide clears the marker", async () => {
    const a = stub("step-5", github, { repos: vi.fn(async () => [{ method: "github-token", github: "me/site" }]) });
    const store = memStore();
    model.markGuideReturn(store, "simple");
    const { box } = await draw(a, { store });
    expect(model.guideReturnView(store)).toBeNull();
    expect(box.textContent).toContain(words.GUIDE.where.connected);
    expect(off(box, "guide-continue")).toBe(false);
    await press(box, "guide-continue");
    expect(a.startProject).toHaveBeenCalledTimes(1);
  });

  it("a failed read of the connections counts as not connected", async () => {
    const a = stub("step-5", github, { repos: vi.fn().mockRejectedValue(new Error("x")) });
    const { box } = await draw(a);
    expect(off(box, "guide-continue")).toBe(true);
  });
});

describe("the way back on the repositories page", () => {
  it("has no button without a marker", () => {
    expect(project.guideReturnNode({ store: memStore(), toGuide: vi.fn(), notify: vi.fn() })).toBeNull();
  });

  it("calls toGuide, shows a problem text and keeps the marker (real backToGuide, fake choose)", async () => {
    const store = memStore();
    model.markGuideReturn(store, "simple");
    const notify = vi.fn();
    const choose = vi.fn().mockResolvedValueOnce("No luck." as any).mockResolvedValueOnce("" as any);
    const node = project.guideReturnNode({ store, toGuide: () => project.backToGuide(store, choose, vi.fn()), notify });
    expect(node.textContent).toBe(words.GUIDE.backToGuide);
    node.click();
    await flush();
    expect(notify).toHaveBeenCalledWith("No luck.");
    expect(model.guideReturnView(store)).toBe("simple");
    node.click();
    await flush();
    expect(model.guideReturnView(store)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("api.startProject", () => {
  it("posts the body to the starter's project route with a timeout signal", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ repo: { id: ID } }) }));
    const saved = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;
    try {
      await apiMod.api.startProject("website", { name: "A", guide: true });
    } finally {
      (globalThis as any).fetch = saved;
    }
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("/api/starters/website/project");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "A", guide: true });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
