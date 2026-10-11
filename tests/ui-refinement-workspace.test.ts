import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let ws: any;
let dr: any;
let nx: any;
let h: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  ws = await import("../ui/refinement-workspace.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  nx = await import("../ui/refinement-next.js" as string);
  h = (await import("../ui/dom.js" as string)).h;
});
afterAll(() => restore());

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", runId: "r" };
const session = (over: object = {}): any => ({ id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "Idea", state: "exploring", architect: { state: "idle" }, drafts: [], log: [], mine: true, ...over });
const draft = (over: object = {}) => ({ id: D1, state: "drafting", ...over });
const talk = (over: object = {}) => ({ rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [], ...over });
const q = (answer?: object) => ({ id: "q", text: "?", ...(answer ? { answer } : {}) });
const LABELS: Record<string, string> = { brief: "Idea and brief", talk: "Conversation", drafts: "Story drafts", handoff: "Hand off", log: "Log" };
const run = (state: string, kind = "brief") => ({ state, kind });

describe("partSummary", () => {
  it("brief", () => {
    expect(ws.partSummary(session()).brief).toBe("none");
    expect(ws.partSummary(session({ brief: BRIEF })).brief).toBe("made");
    expect(ws.partSummary(session({ architect: run("running") })).brief).toBe("working");
    expect(ws.partSummary(session({ architect: run("queued") })).brief).toBe("working");
    expect(ws.partSummary(session({ architect: run("running", "review") })).brief).toBe("none");
    expect(ws.partSummary(session({ briefHidden: true, brief: BRIEF })).brief).toBe("not shown");
  });
  it("conversation", () => {
    expect(ws.partSummary(session()).talk).toBe("no questions open");
    expect(ws.partSummary(session({ talk: talk({ rounds: [{ questions: [q(), q({ unknown: true })] }] }) })).talk).toBe("1 question open");
    const three = talk({ rounds: [{ questions: [q(), q()] }], map: { rules: [], examples: [], open: [{}] } });
    expect(ws.partSummary(session({ talk: three })).talk).toBe("3 questions open");
    expect(ws.partSummary(session({ talk: talk({ proposals: [{}, {}] }) })).talk).toBe("no questions open, 2 proposed");
    expect(ws.partSummary(session({ talkHidden: true, talk: three })).talk).toBe("not shown");
  });
  it("keeps the count while the architect works on the talk", () => {
    const t = talk({ rounds: [{ questions: [q()] }] });
    expect(ws.partSummary(session({ talk: t, architect: run("running", "round") })).talk).toBe("1 question open, working");
    expect(ws.partSummary(session({ talk: t, architect: run("queued", "question") })).talk).toBe("1 question open, working");
    expect(ws.partSummary(session({ talk: t, architect: run("running", "brief") })).talk).toBe("1 question open");
  });
  it("drafts", () => {
    expect(ws.partSummary(session()).drafts).toBe("no drafts");
    expect(ws.partSummary(session({ drafts: [draft()] })).drafts).toBe("1 draft, 0 ready");
    const three = [draft(), draft({ id: "b", state: "ready" }), draft({ id: "c", state: "ready" })];
    expect(ws.partSummary(session({ drafts: three })).drafts).toBe("3 drafts, 2 ready");
    expect(ws.partSummary(session({ drafts: [draft({ state: "split" }), draft({ id: "b" })] })).drafts).toBe("1 draft, 0 ready");
    expect(ws.partSummary(session({ draftsHidden: true, drafts: three })).drafts).toBe("not shown");
  });
  it("hand off", () => {
    expect(ws.partSummary(session()).handoff).toBe("nothing ready");
    expect(ws.partSummary(session({ drafts: [draft({ state: "ready" })] })).handoff).toBe("1 ready");
    const pub = (id: string) => draft({ id, state: "ready", published: { issue: 1, url: "u" } });
    expect(ws.partSummary(session({ drafts: [pub("a"), pub("b")] })).handoff).toBe("2 on GitHub");
    expect(ws.partSummary(session({ drafts: [pub("a"), draft({ id: "b", state: "ready" })] })).handoff).toBe("1 on GitHub, 1 ready");
    const blocked = draft({ id: "a", state: "ready", dependsOn: [{ draft: "b" }] });
    expect(ws.partSummary(session({ drafts: [blocked, draft({ id: "b" })] })).handoff).toBe("nothing ready");
    expect(ws.partSummary(session({ draftsHidden: true })).handoff).toBe("not shown");
  });
  it("does not throw on missing data", () => {
    expect(() => ws.partSummary({})).not.toThrow();
    expect(() => ws.partSummary(undefined)).not.toThrow();
    expect(ws.partSummary(undefined).log).toBe("");
  });
});

describe("nextStep", () => {
  const step = (s: any) => ws.nextStep(s)?.step;
  const part = (s: any) => ws.nextStep(s)?.part;
  const readiness = (items: object[], extra: object = {}) => ({ at: "x", items, ...extra });
  it("follows the rules in order", () => {
    expect(step(session())).toBe("ask");
    expect(part(session())).toBe("brief");
    expect(ws.nextStep(session()).text).toBe("ask the architect to look at the code");
    expect(step(session({ brief: BRIEF }))).toBe("draft");
    expect(part(session({ brief: BRIEF }))).toBe("drafts");
    expect(step(session({ talk: talk({ rounds: [{ questions: [q()] }] }) }))).toBe("answer");
    expect(part(session({ talk: talk({ proposals: [{}] }) }))).toBe("talk");
    expect(step(session({ drafts: [draft()], talk: talk({ map: { rules: [], examples: [], open: [{}] } }) }))).toBe("answer");
    expect(step(session({ drafts: [draft()] }))).toBe("check");
    expect(step(session({ drafts: [draft({ readiness: readiness([], { stale: true }) })] }))).toBe("check");
    expect(step(session({ drafts: [draft({ readiness: readiness([{ id: "x", result: "unsure" }]) })] }))).toBe("ask");
    expect(step(session({ brief: BRIEF, drafts: [draft({ readiness: readiness([{ id: "x", result: "not-met" }]) })] }))).toBe("check");
    expect(step(session({ drafts: [draft({ state: "ready" })] }))).toBe("publish");
    expect(part(session({ drafts: [draft({ state: "ready" })] }))).toBe("handoff");
    expect(step(session({ state: "published", source: { issue: 7, replace: "due" } }))).toBe("publish");
  });
  it("is null when nobody should act or the person cannot", () => {
    expect(ws.nextStep(session({ state: "dropped" }))).toBeNull();
    expect(ws.nextStep(session({ mine: false }))).toBeNull();
    expect(ws.nextStep(session({ repoAvailable: false }))).toBeNull();
    for (const state of ["queued", "running", "paused", "failed"]) expect(ws.nextStep(session({ architect: { state } }))).toBeNull();
    expect(ws.nextStep(session({ state: "published" }))).toBeNull();
    expect(ws.nextStep(undefined)).toBeNull();
  });
  it("agrees with the card", () => {
    const cases = [session(), session({ brief: BRIEF }), session({ drafts: [draft()] }), session({ drafts: [draft({ state: "ready" })] }), session({ mine: false }), session({ state: "dropped" }), session({ state: "published" }), session({ architect: { state: "paused" } }), session({ architect: { state: "running" } }), session({ repoAvailable: false })];
    for (const s of cases) expect(ws.nextStep(s) === null, JSON.stringify(s)).toBe(nx.sessionNext(s).who !== "You" || ["paused", "failed"].includes(s.architect.state) || s.repoAvailable === false);
  });
});

describe("defaultPart and homePart", () => {
  it("opens on drafts only when drafts are shown", () => {
    expect(ws.defaultPart(session())).toBe("brief");
    expect(ws.defaultPart(session({ drafts: [draft()] }))).toBe("drafts");
    expect(ws.defaultPart(session({ drafts: [draft()], draftsHidden: true }))).toBe("brief");
  });
  it("names the part that draws the line", () => {
    expect(ws.homePart(undefined, session())).toBe("brief");
    expect(ws.homePart({ kind: "round" }, session())).toBe("talk");
    expect(ws.homePart({ kind: "question" }, session())).toBe("talk");
    for (const kind of ["suggest", "review", "impact", "ready", "split"]) expect(ws.homePart({ kind }, session())).toBe("drafts");
    expect(ws.homePart({ kind: "review" }, session({ draftsHidden: true }))).toBe("");
  });
  it("handoffNote", () => {
    expect(ws.handoffNote(session())).toBe("");
    expect(ws.handoffNote(session({ mine: false }))).toBe(ws.HANDOFF_NOTE);
    expect(ws.handoffNote(session({ state: "dropped" }))).toBe(ws.HANDOFF_NOTE);
  });
});

describe("workspace", () => {
  beforeEach(() => ws.chosen.clear());
  const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
  const make = (initial?: string) => {
    const parts = ws.PARTS.map((p: any) => ({ ...p, node: h("div", {}, p.id) }));
    const w = ws.workspace({ id: "s1", parts, initial });
    const tabs = () => walk(w.node).filter((e) => e.attrs.role === "tab");
    const panels = () => walk(w.node).filter((e) => e.attrs.role === "tabpanel");
    return { w, tabs, panels };
  };
  const selected = (tabs: FakeElement[]) => tabs.filter((t) => t.attrs["aria-selected"] === "true");
  it("has tab roles and linked panels", () => {
    const { w, tabs, panels } = make();
    expect(walk(w.node).filter((e) => e.attrs.role === "tablist").length).toBe(1);
    expect(tabs().map((t) => t.textContent.trim())).toEqual(["Idea and brief", "Conversation", "Story drafts", "Hand off", "Log"]);
    tabs().forEach((t, i) => {
      expect(t.attrs["aria-controls"]).toBe(panels()[i]!.attrs.id);
      expect(panels()[i]!.attrs["aria-labelledby"]).toBe(t.attrs.id);
    });
    expect(selected(tabs()).length).toBe(1);
    expect((tabs() as any[]).filter((t) => t.tabIndex === 0).length).toBe(1);
    expect(panels().filter((p: any) => !p.hidden).length).toBe(1);
  });
  it("opens on the initial part, brief when it is unknown, and stores nothing", () => {
    expect(make("drafts").w.current()).toBe("drafts");
    expect(make("nope").w.current()).toBe("brief");
    expect(ws.chosen.size).toBe(0);
  });
  it("selects on click and remembers it", () => {
    const { w, tabs, panels } = make();
    tabs()[3]!.click();
    expect(w.current()).toBe("handoff");
    expect(selected(tabs())[0]).toBe(tabs()[3]);
    expect((panels() as any[]).map((p) => !p.hidden)).toEqual([false, false, false, true, false]);
    expect(ws.chosen.get("s1")).toBe("handoff");
  });
  it("moves with the arrow keys, Home and End", () => {
    const { w, tabs } = make();
    const key = (i: number, k: string) => tabs()[i]!.fire("keydown", { key: k, preventDefault() {} });
    key(4, "ArrowRight");
    expect(w.current()).toBe("brief");
    key(0, "ArrowLeft");
    expect(w.current()).toBe("log");
    key(4, "Home");
    expect(w.current()).toBe("brief");
    key(0, "End");
    expect(w.current()).toBe("log");
    expect((document as any).activeElement).toBe(tabs()[4]);
    key(4, "x");
    expect(w.current()).toBe("log");
    expect(ws.chosen.get("s1")).toBe("log");
  });
  it("update changes the state text and keeps the tab nodes", () => {
    const { w, tabs } = make();
    const before = tabs();
    w.update({ summary: { brief: "made", talk: "no questions open", drafts: "no drafts", handoff: "nothing ready", log: "" }, next: null, line: null });
    expect(tabs()[0]!.textContent).toContain("made");
    w.update({ summary: { brief: "none" }, next: null, line: null });
    expect(tabs()[0]!.textContent).toContain("none");
    tabs().forEach((t, i) => expect(t).toBe(before[i]));
  });
  it("shows a Next button that only opens its part", () => {
    const { w, tabs } = make();
    const next = { step: "draft", part: "drafts", text: "add a draft" };
    w.update({ summary: {}, next, line: null });
    const btn = () => walk(w.node).find((e) => e.attrs.class === "ws-next")!;
    expect(btn().textContent).toBe("Next: add a draft");
    const node = btn();
    w.update({ summary: {}, next: { ...next }, line: null });
    expect(btn()).toBe(node);
    btn().click();
    expect(w.current()).toBe("drafts");
    expect((document as any).activeElement).toBe(tabs()[2]);
    w.update({ summary: {}, next: null, line: null });
    expect(walk(w.node).some((e) => e.attrs.class === "ws-next")).toBe(false);
  });
  it("draws the architect's line only outside its home part", () => {
    const { w, tabs } = make("drafts");
    const box = () => w.node.children[2] as FakeElement;
    const st = { busy: true, text: "The architect is at work.", detail: "" };
    w.update({ summary: {}, next: null, line: { home: "drafts", st } });
    expect(box().textContent).toBe("");
    w.update({ summary: {}, next: null, line: { home: "brief", st } });
    expect(box().textContent).toContain("The architect is at work.");
    tabs()[0]!.click();
    expect(box().textContent).toBe("");
    tabs()[1]!.click();
    expect(box().textContent).toContain("The architect is at work.");
    w.update({ summary: {}, next: null, line: null });
    expect(box().textContent).toBe("");
  });
});

describe("the session page", () => {
  const realFetch = globalThis.fetch;
  let view: any;
  let sent: { method: string; url: string; body: any }[];
  let gets: number;
  let cleanup: (() => void) | undefined;
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  const main = () => (document as any).getElementById("main") as FakeElement;
  const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
  const tabs = () => walk(main()).filter((e) => e.attrs.role === "tab");
  const tab = (label: string) => tabs().find((t) => t.textContent.startsWith(label))!;
  const panels = () => walk(main()).filter((e) => e.attrs.role === "tabpanel");
  const open = () => tabs().filter((t) => t.attrs["aria-selected"] === "true").map((t) => LABELS[t.attrs["data-part"]!]);
  const buttons = () => walk(main()).filter((e) => e.tag === "button");
  const inPanel = (text: string) => panels().findIndex((p) => walk(p).some((e) => e.tag === "h2" && e.textContent === text));
  const show = async (over: object = {}, opts: object = {}) => {
    view = { ...session({ brief: BRIEF, created: "x", updated: "x" }), ...over };
    cleanup = await ui.renderRefinement(main(), { id: "s1", ...opts });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    ws.chosen.clear();
    dr.unsaved.clear();
    dr.opened.clear();
    sent = [];
    gets = 0;
    (document as any).getElementById("modal-root").replaceChildren();
    (document as any).activeElement = null;
    (globalThis as any).location = { hash: "#/refinement/s1", reload: vi.fn() };
    (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "GET") {
        gets++;
        return reply(view);
      }
      sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      return reply(view);
    };
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it("opens on the brief for a new session and on the drafts for one with drafts", async () => {
    await show();
    expect(tabs().length).toBe(5);
    expect(open()[0]).toBe("Idea and brief");
    cleanup!();
    await show({ drafts: [draft({ criteria: [], dependsOn: [] })] });
    expect(open()[0]).toBe("Story drafts");
  });
  it("keeps the head above the parts and puts the sections in their own panels", async () => {
    await show({ drafts: [draft()] });
    const inside = (el: FakeElement) => panels().some((p) => p.contains(el));
    const named = (tag: string) => walk(main()).filter((e) => e.tag === tag);
    expect(inside(named("h1")[0]!)).toBe(false);
    expect(inside(walk(main()).find((e) => (e.attrs.class ?? "").includes("pill"))!)).toBe(false);
    expect(inside(buttons().find((b) => b.textContent === "Rename")!)).toBe(false);
    expect(inside(buttons().find((b) => b.textContent === "Drop")!)).toBe(false);
    expect(inPanel("Idea")).toBe(inPanel("Context brief"));
    const where = [inPanel("Idea"), inPanel("Story drafts"), inPanel("Log")];
    expect(new Set(where).size).toBe(3);
    expect(where.every((i) => i >= 0)).toBe(true);
  });
  it("shows the state on each tab", async () => {
    await show({ drafts: [draft({ state: "ready" })] });
    expect(tab("Idea and brief").textContent).toContain("made");
    expect(tab("Story drafts").textContent).toContain("1 draft, 1 ready");
    expect(tab("Hand off").textContent).toContain("1 ready");
  });
  it("keeps a typed draft field and its save when the part changes", async () => {
    await show({ drafts: [draft({ criteria: [], dependsOn: [] })] });
    const openBtn = buttons().find((b) => b.textContent === "Open")!;
    openBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    const field = walk(main()).find((e) => e.attrs.name === "notes")!;
    field.value = "typed notes";
    field.fire("input");
    expect(dr.unsaved.size).toBe(1);
    tab("Conversation").click();
    tab("Story drafts").click();
    const again = walk(main()).find((e) => e.attrs.name === "notes")!;
    expect(again).toBe(field);
    expect(again.value).toBe("typed notes");
    expect(dr.unsaved.size).toBe(1);
    tab("Conversation").click();
    await vi.advanceTimersByTimeAsync(dr.SAVE_MS + 10);
    expect(sent.filter((x) => x.method === "PUT").length).toBe(1);
    expect(JSON.stringify(sent.find((x) => x.method === "PUT")!.body)).toContain("typed notes");
  });
  it("sends a waiting save at once when the page is left", async () => {
    await show({ drafts: [draft({ criteria: [], dependsOn: [] })] });
    buttons().find((b) => b.textContent === "Open")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const field = walk(main()).find((e) => e.attrs.name === "notes")!;
    field.value = "leave notes";
    field.fire("input");
    tab("Log").click();
    cleanup!();
    cleanup = undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((x) => x.method === "PUT").length).toBe(1);
  });
  it("keeps an unsent answer in the conversation across a switch", async () => {
    const t = talk({ rounds: [{ id: "r1", questions: [{ id: "q1", text: "Why?", view: "need", why: "w", options: [] }] }] });
    await show({ talk: t });
    tab("Conversation").click();
    const area = walk(main()).find((e) => e.tag === "textarea")!;
    area.value = "because";
    area.fire("input");
    tab("Log").click();
    tab("Conversation").click();
    expect(walk(main()).find((e) => e.tag === "textarea")).toBe(area);
    expect(area.value).toBe("because");
  });
  it("keeps the chosen part and the focus through a poll", async () => {
    await show({ architect: run("running") });
    tab("Log").click();
    tab("Log").focus();
    const node = tab("Log");
    view = { ...view, architect: { state: "running", kind: "brief", doing: "Reading the code" }, title: "Changed" };
    await vi.advanceTimersByTimeAsync(ui.POLL_MS + 10);
    expect(gets).toBeGreaterThan(1);
    expect(tab("Log")).toBe(node);
    expect(node.attrs["aria-selected"]).toBe("true");
    expect((document as any).activeElement).toBe(node);
  });
  it("keeps the chosen part and the focused tab after a reload", async () => {
    await show();
    tab("Conversation").click();
    tab("Conversation").focus();
    cleanup = await ui.renderRefinement(main(), { id: "s1", quiet: true });
    expect(open()[0]).toBe("Conversation");
    expect(((document as any).activeElement as FakeElement).attrs["data-focus"]).toBe("part-talk");
  });
  it("shows the architect's line in a part that does not draw it", async () => {
    await show({ architect: run("running"), drafts: [draft()] });
    const box = () => walk(main()).filter((e) => e.textContent.includes("The architect is at work."));
    expect(open()[0]).toBe("Story drafts");
    const line = () => (walk(main()).find((e) => e.attrs.class === "scf-tabs session-parts")!.children[2] as FakeElement).textContent;
    expect(line()).toContain("The architect is at work.");
    tab("Idea and brief").click();
    expect(line()).toBe("");
    expect(box().length).toBeGreaterThan(0);
  });
  it("shows no second line for a draft run that its part draws, and shows it when drafts are hidden", async () => {
    await show({ architect: { state: "running", kind: "review", draft: D1 }, drafts: [draft()] });
    const line = () => (walk(main()).find((e) => e.attrs.class === "scf-tabs session-parts")!.children[2] as FakeElement).textContent;
    expect(line()).toBe("");
    cleanup!();
    await show({ architect: { state: "running", kind: "review", draft: D1 }, drafts: [draft()], draftsHidden: true });
    expect(open()[0]).toBe("Idea and brief");
    expect(line()).toContain("The architect is reviewing your draft.");
  });
  it("sends nothing when Next is pressed", async () => {
    await show();
    const next = walk(main()).find((e) => e.attrs.class === "ws-next")!;
    expect(next.textContent).toBe("Next: add a draft");
    const before = gets;
    next.click();
    expect(open()[0]).toBe("Story drafts");
    expect(sent.length).toBe(0);
    expect(gets).toBe(before);
    expect(location.hash).toBe("#/refinement/s1");
  });
  it("shows five tabs, the note and no Next for a dropped session", async () => {
    await show({ state: "dropped", removedOn: "2026-12-01T00:00:00.000Z" });
    expect(tabs().length).toBe(5);
    expect(walk(main()).some((e) => e.attrs.class === "ws-next")).toBe(false);
    expect(buttons().some((b) => b.textContent === "Restore")).toBe(true);
    expect(main().textContent).toContain(ws.HANDOFF_NOTE);
  });
  it("shows the note and no Next in a read-only preview", async () => {
    await show({}, { readOnly: true });
    expect(walk(main()).some((e) => e.attrs.class === "ws-next")).toBe(false);
    expect(buttons().some((b) => b.textContent === "Rename")).toBe(false);
    tab("Log").click();
    expect(open()[0]).toBe("Log");
    expect(main().textContent).toContain(ws.HANDOFF_NOTE);
  });
  it("keeps the same for an admin who is not the owner", async () => {
    await show({ mine: false }, { admin: true });
    expect(walk(main()).some((e) => e.attrs.class === "ws-next")).toBe(false);
    expect(buttons().some((b) => b.textContent === "Drop")).toBe(true);
    expect(main().textContent).toContain(ws.HANDOFF_NOTE);
  });
  it("shows not shown for a session whose repository is gone", async () => {
    await show({ repoAvailable: false, briefHidden: true, talkHidden: true, draftsHidden: true, drafts: [] });
    expect(main().textContent).toContain("not in My repositories any more");
    expect(walk(main()).some((e) => e.attrs.class === "ws-next")).toBe(false);
    for (const label of ["Idea and brief", "Conversation", "Story drafts", "Hand off"]) expect(tab(label).textContent).toContain("not shown");
  });
});
