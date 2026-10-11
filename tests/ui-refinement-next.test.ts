import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let next: any;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  next = await import("../ui/refinement-next.js" as string);
  ui = await import("../ui/refinement.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const session = (over: object = {}): any => ({ id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "Idea", state: "exploring", drafts: [], log: [], mine: true, ...over });
const draft = (over: object = {}) => ({ id: "d1", state: "drafting", ...over });
const talk = (over: object = {}) => ({ rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [], ...over });
const text = (s: any) => next.sessionNext(s).text as string;
const readiness = (items: object[], extra: object = {}) => ({ at: new Date().toISOString(), items, ...extra });

describe("sessionNext", () => {
  it("says dropped", () => {
    expect(text(session({ state: "dropped" }))).toBe("This session is dropped, so restore it to carry on.");
    expect(text(session({ state: "dropped", mine: false }))).toBe("This session is dropped.");
  });
  it("sends a person who is not the owner away", () => {
    expect(next.sessionNext(session({ mine: false }))).toEqual({ who: "Nobody", text: "Only the owner of this session can take the next step." });
  });
  it("asks for the repository", () => {
    expect(text(session({ repoAvailable: false }))).toBe("Add the repository to My repositories again to carry on.");
  });
  it("names the architect's states", () => {
    for (const state of ["queued", "running"]) expect(next.sessionNext(session({ architect: { state } }))).toEqual({ who: "The architect", text: "The architect is at work, and the page updates by itself." });
    expect(text(session({ architect: { state: "paused" } }))).toBe("The architect paused, so press Ask again to let it carry on.");
    expect(text(session({ architect: { state: "failed" } }))).toBe("The architect could not finish, so press Try again or carry on without it.");
  });
  it("asks to finish a replacement, also when published", () => {
    expect(text(session({ state: "published", source: { issue: 7, replace: "due" } }))).toBe("Press Publish to finish replacing issue #7.");
  });
  it("says there is nothing more when published", () => {
    expect(next.sessionNext(session({ state: "published" })).who).toBe("Nobody");
    expect(text(session({ state: "published" }))).toBe("Nothing more to do: every story is on GitHub.");
  });
  it("counts ready stories", () => {
    expect(text(session({ drafts: [draft({ state: "ready" })] }))).toBe("1 story is ready, so press Publish to put it on GitHub.");
    expect(text(session({ drafts: [draft({ state: "ready" }), draft({ id: "d2", state: "ready" }), draft({ id: "d3", state: "ready", published: { issue: 1 } })] }))).toBe("2 stories are ready, so press Publish to put them on GitHub.");
  });
  it("does not say publish for a ready story whose prerequisite is not ready", () => {
    const blocked = draft({ id: "a", state: "ready", dependsOn: [{ draft: "b" }] });
    const s = session({ drafts: [blocked, draft({ id: "b" })] });
    expect(text(s)).toBe("Finish the story draft and press Check readiness.");
    const ok = session({ drafts: [blocked, draft({ id: "b", state: "ready" })] });
    expect(text(ok)).toBe("2 stories are ready, so press Publish to put them on GitHub.");
    const chain = session({ drafts: [draft({ id: "c", state: "ready", dependsOn: [{ draft: "a" }] }), blocked, draft({ id: "b" })] });
    expect(text(chain)).not.toContain("ready, so press Publish");
  });
  it("counts unanswered questions of the last round", () => {
    const q = (answer?: object) => ({ id: "q", text: "?", ...(answer ? { answer } : {}) });
    const one = session({ talk: talk({ rounds: [{ questions: [q({ unknown: true }), q()] }] }) });
    expect(text(one)).toBe("Answer the architect's 1 question, and \"I don't know yet\" counts as an answer.");
    const two = session({ talk: talk({ rounds: [{ questions: [q(), q()] }] }) });
    expect(text(two)).toContain("2 questions");
  });
  it("counts proposals", () => {
    expect(text(session({ talk: talk({ proposals: [{}] }) }))).toBe("Accept or reject the 1 entry the architect proposed for the map.");
    expect(text(session({ talk: talk({ proposals: [{}, {}] }) }))).toBe("Accept or reject the 2 entries the architect proposed for the map.");
  });
  it("guides a session without drafts", () => {
    expect(text(session())).toBe("Ask the architect to look at the code, or write your first story draft.");
    expect(text(session({ brief: { at: "x" } }))).toBe("Ask the architect for questions, or write your first story draft.");
    expect(text(session({ brief: { at: "x" }, talk: talk({ rounds: [{ questions: [] }] }) }))).toBe("Write your first story draft.");
  });
  it("counts open questions of the map", () => {
    const open = (n: number) => session({ drafts: [draft()], talk: talk({ map: { rules: [], examples: [], open: Array(n).fill({}) } }) });
    expect(text(open(1))).toBe("Settle the 1 open question, because a story with open questions is not ready.");
    expect(text(open(3))).toContain("3 open questions");
  });
  it("asks for a check, a new check, or a brief", () => {
    expect(text(session({ drafts: [draft()] }))).toBe("Finish the story draft and press Check readiness.");
    const stale = session({ drafts: [draft({ readiness: readiness([], { stale: true }) })] });
    expect(text(stale)).toBe("The Definition of Ready changed, so press Check readiness again.");
    const unsure = [draft({ readiness: readiness([{ id: "value", result: "unsure" }]) })];
    expect(text(session({ drafts: unsure }))).toBe("Ask the architect to look at the code, then press Check readiness again.");
    expect(text(session({ drafts: unsure, brief: { at: "x" } }))).toBe("Fix what the readiness check found, or accept an item anyway with a reason.");
  });
  it("does not offer to accept an implementation plan", () => {
    const only = [draft({ readiness: readiness([{ id: "no-plan", result: "not-met" }, { id: "value", result: "met" }]) })];
    expect(text(session({ drafts: only }))).toBe("Move the implementation plan out of the story, then press Check readiness again.");
    const both = [draft({ readiness: readiness([{ id: "no-plan", result: "not-met" }, { id: "value", result: "not-met" }]) })];
    expect(text(session({ drafts: both }))).toBe("Fix what the readiness check found, or accept an item anyway with a reason.");
  });
  it("lets earlier rules win", () => {
    const busy = session({ architect: { state: "running" }, drafts: [draft({ state: "ready" })] });
    expect(next.sessionNext(busy).who).toBe("The architect");
    const mixed = session({ drafts: [draft({ state: "ready" })], talk: talk({ map: { rules: [], examples: [], open: [{}] } }) });
    expect(text(mixed)).toContain("is ready");
  });
  it("never throws and gives one short sentence", () => {
    expect(text({})).toMatch(/\.$/);
    expect(text(undefined)).toMatch(/\.$/);
    const cases = [
      session({ state: "dropped" }), session({ mine: false }), session({ repoAvailable: false }), session({ architect: { state: "paused" } }),
      session({ drafts: [draft()] }), session({ talkHidden: true, draftsHidden: true }), session(), session({ drafts: [draft({ state: "ready" })] }),
    ];
    for (const c of cases) {
      const t = text(c);
      expect(t.length).toBeLessThanOrEqual(120);
      expect(t).toMatch(/\.$/);
      expect(t.match(/[.!?](\s|$)/g)?.length, t).toBe(1); // one sentence
    }
  });
  it("names the real buttons", () => {
    expect(text(session({ drafts: [draft({ state: "ready" })] }))).toContain("Publish");
    expect(next.ASK_BRIEF).toBe(ui.askLabel(session()));
  });
});

describe("the card on the session page", () => {
  const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
  const main = () => (document as any).getElementById("main") as FakeElement;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const cards = () => walk(main()).filter((e) => (e.attrs.class ?? "").split(" ").includes("next-step"));
  const serve = (s: () => any) => {
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "x", json: async () => s() });
  };

  it("shows one card, after the title and before the idea", async () => {
    serve(() => session({ title: "Mine <b>x</b>" }));
    (globalThis as any).location = { hash: "#/refinement/s1" };
    await ui.renderRefinement(main(), { id: "s1" });
    const found = cards();
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toContain("What happens next");
    expect(found[0].textContent).toContain("Ask the architect to look at the code");
    const all = walk(main());
    const at = all.indexOf(found[0]);
    expect(all.findIndex((e) => e.tag === "h1")).toBeLessThan(at);
    expect(all.findIndex((e) => e.tag === "h2" && e.textContent === "Idea")).toBeGreaterThan(at);
    expect(all.find((e) => e.tag === "h1")!.textContent).toBe("Mine <b>x</b>");
  });
  it("tells a reader who is not the owner", async () => {
    serve(() => session({ mine: false }));
    await ui.renderRefinement(main(), { id: "s1", readOnly: true });
    expect(cards()[0].textContent).toContain("Only the owner of this session can take the next step.");
  });
  it("changes the sentence when only the drafts change", async () => {
    let now = session({ drafts: [draft()] });
    serve(() => now);
    await ui.renderRefinement(main(), { id: "s1" });
    expect(cards()[0].textContent).toContain("press Check readiness");
    const idea = walk(main()).find((e) => e.tag === "h2" && e.textContent === "Idea");
    now = session({ drafts: [draft({ state: "ready" })] });
    // The page reads the session again after an action; the same fetch answers with the new drafts.
    await api.refinementSession("s1");
    await ui.renderRefinement(main(), { id: "s1", quiet: true });
    await flush();
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("1 story is ready");
    expect(idea).toBeDefined();
  });
});
