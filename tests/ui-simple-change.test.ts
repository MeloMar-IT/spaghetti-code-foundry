import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let page: any;
let words: any;
let cm: any;
let simple: any;
let simpleModel: any;
beforeAll(async () => {
  restore = installFakeDom();
  words = await import("../ui/simple-words.js" as string);
  cm = await import("../ui/simple-change-model.js" as string);
  page = await import("../ui/simple-change.js" as string);
  simple = await import("../ui/simple.js" as string);
  simpleModel = await import("../ui/simple-model.js" as string);
});
afterAll(() => restore());
afterEach(() => {
  cm.clearChangeDraft("r1");
  cm.clearChangeDraft("r2");
});

const CHANGE: any = new Proxy({}, { get: (_t, k) => words.CHANGE[k] });
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
/** Every text a person can read or hear: text nodes, aria-label, title, placeholder and the value of text boxes. */
const readable = (root: FakeElement) => [root, ...walk(root)].flatMap((e) => [
  e.children.filter((c) => typeof c === "string").join(""), e.attrs["aria-label"] ?? "", e.attrs.title ?? "", e.attrs.placeholder ?? "",
  e.tag === "textarea" || (e.tag === "input" && e.attrs.type !== "radio") ? String(e.value ?? "") : "",
]);
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};
const btn = (p: FakeElement, text: string) => p.all("button").find((b) => b.textContent === text)!;
const labels = (p: FakeElement) => p.all("button").map((b) => b.textContent);
const off_ = (e: FakeElement) => e.disabled || "disabled" in e.attrs;
const box = (p: FakeElement, n = 0) => p.all("textarea")[n]!;
const type = (el: FakeElement, v: string) => { el.value = v; el.fire("input", {}); };

const repos = [
  { id: "r1", url: "https://github.com/o/app", github: "o/app" },
  { id: "r2", url: "local://demo", localName: "local:demo-0123abcd", method: "local" },
];
const view = (state: string, over: any = {}) => ({ id: "c1", repo: "o/app", text: "Show the weather", state, created: "2026-01-01T10:00:00Z", updated: "2026-01-01T10:00:00Z", ...over });
const questions = (recommended = 2) => view("questions", { questions: [
  { id: "q1", text: "Which city?", why: "It sets the weather.", options: ["Paris", "Rome"], recommended },
  { id: "q2", text: "Which unit?", why: "", options: ["Celsius", "Fahrenheit"], recommended },
] });
const card = (id: string, over: any = {}) => ({ id, title: `Card ${id}`, understood: "This is what I understood: it shows the weather.", criteria: ["Shows a city", "Shows a number"], ...over });
const cards = (n = 1, over: any = {}) => view("cards", { cards: Array.from({ length: n }, (_, i) => card(`d${i + 1}`)), ...over });

/** A fake API. `list` is what GET /changes gives; `reads` are the answers of GET /changes/:id (the last one repeats; an Error is thrown). */
function fake(over: Record<string, any> = {}, list: any[] = [], reads: any[] = []) {
  const queue = [...reads];
  return {
    repos: vi.fn(async () => repos),
    changes: vi.fn(async () => ({ changes: list })),
    change: vi.fn(async () => { const x = queue.length > 1 ? queue.shift() : queue[0]; if (x instanceof Error) throw x; return x; }),
    createChange: vi.fn(async () => view("thinking")),
    answerChange: vi.fn(async () => view("thinking")),
    saveChangeCard: vi.fn(async () => cards()),
    buildChange: vi.fn(async () => view("planned", { building: true, cards: [card("d1")] })),
    laterChange: vi.fn(async () => view("planned", { building: false, cards: [card("d1")] })),
    retryChange: vi.fn(async () => view("thinking")),
    ...over,
  } as any;
}
async function open(a: any, id = "r1", extra: any = {}) {
  const main = new FakeElement("div");
  const names: string[] = [];
  const off = await page.renderSimpleChange(main, { id, a, every: 1, onName: (n: string) => names.push(n), ...extra });
  return { main, off, names };
}

describe("the Ask for a change page: write", () => {
  it("sends with Ctrl+Enter in the box, as the start page does", async () => {
    const a = fake();
    const { main, off } = await open(a);
    type(box(main), "By key");
    box(main).fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
    await until(() => main.textContent.includes(CHANGE.thinking));
    expect(a.createChange).toHaveBeenCalledWith({ repo: "o/app", text: "By key" });
    off();
  });

  it("shows the box and Make a plan, refuses an empty text, and sends the repo and the text", async () => {
    const a = fake();
    const { main, off, names } = await open(a);
    expect(names).toEqual(["app"]);
    expect(main.textContent).toContain("What would you like to change?");
    expect(main.all("a").some((l) => l.attrs.href === "#/repos/r1")).toBe(true);
    btn(main, "Make a plan").click();
    await tick();
    expect(a.createChange).not.toHaveBeenCalled();
    expect(main.textContent).toContain(CHANGE.needsText);
    type(box(main), "  Show the weather  ");
    btn(main, "Make a plan").click();
    await until(() => main.textContent.includes(CHANGE.thinking));
    expect(a.createChange).toHaveBeenCalledWith({ repo: "o/app", text: "Show the weather" });
    expect(cm.hasUnsentChange()).toBe(false);
    off();
  });

  it("refuses a text over 10000 characters with a message, and keeps it", async () => {
    const a = fake();
    const { main, off } = await open(a);
    type(box(main), "x".repeat(10_001));
    btn(main, "Make a plan").click();
    await tick();
    expect(a.createChange).not.toHaveBeenCalled();
    expect(main.textContent).toContain(CHANGE.tooLongText(10_001));
    expect(box(main).value).toHaveLength(10_001);
    off();
  });

  it("sends the local name for a local project", async () => {
    const a = fake();
    const { main, off } = await open(a, "r2");
    expect(a.changes).toHaveBeenCalledWith("local:demo-0123abcd");
    type(box(main), "Do it");
    btn(main, "Make a plan").click();
    await until(() => a.createChange.mock.calls.length === 1);
    expect(a.createChange).toHaveBeenCalledWith({ repo: "local:demo-0123abcd", text: "Do it" });
    off();
  });

  it("keeps the typed text when the call fails, and tells it in plain words", async () => {
    const a = fake({ createChange: vi.fn(async () => { throw new Error("500 boom issue #12"); }) }, [], [new Error("down")]);
    const { main, off } = await open(a);
    type(box(main), "Keep me");
    expect(cm.hasUnsentChange()).toBe(true);
    btn(main, "Make a plan").click();
    await until(() => main.textContent.includes(CHANGE.failed));
    expect(box(main).value).toBe("Keep me");
    expect(main.textContent).not.toContain("boom");
    off();
  });

  it("follows a request the server made although the answer was lost", async () => {
    const a = fake({ createChange: vi.fn(async () => { throw new TypeError("network"); }) });
    const { main, off } = await open(a);
    a.changes.mockResolvedValue({ changes: [view("thinking", { text: "Lost answer" })] });
    type(box(main), "Lost answer");
    btn(main, "Make a plan").click();
    await until(() => main.textContent.includes(CHANGE.thinking));
    expect(cm.hasUnsentChange()).toBe(false);
    off();
  });

  it("goes on with the newest open request, and shows an unknown project and a missing place", async () => {
    const a = fake({}, [view("cards", { updated: "2026-01-01T11:00:00Z", cards: [card("d1")] }), view("planned", { id: "c0", updated: "2026-01-01T12:00:00Z" })]);
    const first = await open(a);
    expect(first.main.textContent).toContain("This is what I understood");
    first.off();
    const none = await open(fake(), "nope");
    expect(none.main.textContent).toContain(words.WORDS.notFound);
    none.off();
    const noPlace = await open(fake({ repos: vi.fn(async () => [{ id: "r3", url: "x" }]) }), "r3");
    expect(noPlace.main.textContent).toContain(CHANGE.noPlace);
    noPlace.off();
  });

  it("shows its own wording when the first read fails, and loads again with the button", async () => {
    let fail = true;
    const a = fake({ repos: vi.fn(async () => { if (fail) throw new Error("GET /api/repos 500 repository"); return repos; }) });
    const { main, off } = await open(a);
    expect(main.textContent).toBe(`${CHANGE.loadFailed}${CHANGE.retry}`);
    fail = false;
    btn(main, CHANGE.retry).click();
    await until(() => main.textContent.includes("What would you like to change?"));
    off();
  });
});

describe("the Ask for a change page: thinking", () => {
  it("says it visibly, reads again until the state changes, and then shows the questions", async () => {
    const a = fake({}, [view("thinking")], [view("thinking"), questions()]);
    const { main, off } = await open(a);
    const say = walk(main).find((e) => e.tag === "p" && e.textContent === CHANGE.thinking)!;
    expect(say.attrs["aria-hidden"]).toBeUndefined();
    await until(() => main.textContent.includes("Which city?"));
    expect(a.change).toHaveBeenCalledWith("c1");
    off();
  });

  it("keeps the page, says the read failed, and tries again", async () => {
    const a = fake({}, [view("thinking")], [new Error("down"), new Error("down"), cards()]);
    const { main, off } = await open(a);
    await until(() => main.textContent.includes(CHANGE.readFailed));
    expect(main.textContent).toContain(CHANGE.thinking);
    await until(() => main.textContent.includes("This is what I understood"));
    expect(main.textContent).not.toContain(CHANGE.readFailed);
    off();
  });

  it("stops reading when the page is left", async () => {
    const a = fake({}, [view("thinking")], [view("thinking")]);
    const { off } = await open(a);
    await until(() => a.change.mock.calls.length >= 2);
    off();
    await tick();
    const n = a.change.mock.calls.length;
    for (let i = 0; i < 10; i++) await tick();
    expect(a.change.mock.calls.length).toBe(n);
  });
});

describe("the Ask for a change page: questions", () => {
  const radios = (p: FakeElement) => p.all("input").filter((i) => i.attrs.type === "radio");

  it("marks the suggested option and chooses it, and sends exactly the answers", async () => {
    const a = fake({}, [questions()]);
    const { main, off } = await open(a);
    expect(main.textContent).toContain(`Rome (${CHANGE.suggested})`);
    expect(radios(main).map((r) => r.checked)).toEqual([false, true, false, true]);
    radios(main)[0]!.click();
    type(box(main, 1), "  Kelvin ");
    btn(main, "Send my answers").click();
    await until(() => a.answerChange.mock.calls.length === 1);
    expect(a.answerChange).toHaveBeenCalledWith("c1", { answers: [{ question: "q1", option: 1 }, { question: "q2", text: "Kelvin" }] });
    await until(() => main.textContent.includes(CHANGE.thinking));
    expect(cm.hasUnsentChange()).toBe(false);
    off();
  });

  it("names a question with no answer and sends nothing", async () => {
    const a = fake({}, [questions(0)]);
    const { main, off } = await open(a);
    radios(main)[2]!.click();
    btn(main, "Send my answers").click();
    await tick();
    expect(a.answerChange).not.toHaveBeenCalled();
    expect(main.textContent).toContain(words.ANSWER.needs(1));
    off();
  });

  it("refuses a free answer over 2000 characters", async () => {
    const a = fake({}, [questions()]);
    const { main, off } = await open(a);
    type(box(main, 0), "z".repeat(2001));
    btn(main, "Send my answers").click();
    await tick();
    expect(a.answerChange).not.toHaveBeenCalled();
    expect(main.textContent).toContain(CHANGE.tooLongAnswer(1));
    off();
  });

  it("follows the server when the answers were saved but the call failed, and keeps the typed text otherwise", async () => {
    const a = fake({ answerChange: vi.fn(async () => { throw new Error("502 the next step could not start"); }) }, [questions()], [view("thinking")]);
    const { main, off } = await open(a);
    type(box(main, 0), "Mine");
    btn(main, "Send my answers").click();
    await until(() => main.textContent.includes(CHANGE.thinking));
    expect(main.textContent).not.toContain(CHANGE.failed);
    expect(cm.hasUnsentChange()).toBe(false); // the answers are saved: nothing of them is unsent
    off();
    // the server still shows the same questions: the failure is told and the text stays
    const b = fake({ answerChange: vi.fn(async () => { throw new Error("x"); }) }, [questions()], [questions()]);
    const second = await open(b);
    type(box(second.main, 0), "Mine");
    btn(second.main, "Send my answers").click();
    await until(() => second.main.textContent.includes(CHANGE.failed));
    expect(box(second.main, 0).value).toBe("Mine");
    second.off();
  });
});

describe("the Ask for a change page: cards", () => {
  it("shows three cards for a split, with the sentence once, and never the word epic", async () => {
    const a = fake({}, [cards(3)]);
    const { main, off } = await open(a);
    expect(walk(main).filter((e) => e.tag === "h3")).toHaveLength(3);
    expect(main.textContent.match(/This is what I understood/g)).toHaveLength(3);
    expect(main.textContent).not.toMatch(/epic/i);
    expect(labels(main)).toEqual([CHANGE.change, CHANGE.change, CHANGE.change, CHANGE.build, CHANGE.later]);
    off();
  });

  it("saves only what changed, with the criteria as separate entries, and shows the new card", async () => {
    const multi = cards(1, { cards: [card("d1", { criteria: ["Line one\nline two", "Second"] })] });
    const a = fake({ saveChangeCard: vi.fn(async () => cards(1, { cards: [card("d1", { title: "Better" })] })) }, [multi]);
    const { main, off } = await open(a);
    btn(main, CHANGE.change).click();
    expect(off_(btn(main, CHANGE.build))).toBe(true);
    expect(off_(btn(main, CHANGE.later))).toBe(true);
    const input = main.all("input")[0]!;
    expect(input.value).toBe("Card d1");
    input.value = "Better";
    input.fire("input", {});
    expect(cm.hasUnsentChange()).toBe(true);
    btn(main, CHANGE.save).click();
    await until(() => a.saveChangeCard.mock.calls.length === 1);
    expect(a.saveChangeCard).toHaveBeenCalledWith("c1", "d1", { title: "Better" });
    await until(() => main.textContent.includes("Better"));
    expect(cm.hasUnsentChange()).toBe(false);
    expect(off_(btn(main, CHANGE.build))).toBe(false);
    off();
  });

  it("saves a changed point as the list of entries and refuses an empty title", async () => {
    const a = fake({}, [cards(1, { cards: [card("d1", { criteria: ["Line one\nline two", "Second"] })] })]);
    const { main, off } = await open(a);
    btn(main, CHANGE.change).click();
    const input = main.all("input")[0]!;
    input.value = " ";
    input.fire("input", {});
    btn(main, CHANGE.save).click();
    await tick();
    expect(a.saveChangeCard).not.toHaveBeenCalled();
    expect(main.textContent).toContain(CHANGE.titleNeeded);
    const input2 = main.all("input")[0]!;
    input2.value = "Card d1";
    input2.fire("input", {});
    const points = main.all("textarea");
    type(points[1]!, "Changed");
    btn(main, CHANGE.save).click();
    await until(() => a.saveChangeCard.mock.calls.length === 1);
    expect(a.saveChangeCard).toHaveBeenCalledWith("c1", "d1", { criteria: ["Line one\nline two", "Changed"] });
    off();
  });

  it("closes the edit without a call when nothing changed, and Cancel drops it", async () => {
    const a = fake({}, [cards()]);
    const { main, off } = await open(a);
    btn(main, CHANGE.change).click();
    btn(main, CHANGE.save).click();
    await tick();
    expect(a.saveChangeCard).not.toHaveBeenCalled();
    expect(labels(main)).toContain(CHANGE.build);
    btn(main, CHANGE.change).click();
    btn(main, CHANGE.cancel).click();
    expect(labels(main)).toContain(CHANGE.change);
    off();
  });

  it("builds and shows that it is on its way; Not now keeps it and links back", async () => {
    const a = fake({}, [cards()]);
    const { main, off } = await open(a);
    btn(main, CHANGE.build).click();
    await until(() => main.textContent.includes(CHANGE.onItsWay));
    expect(a.buildChange).toHaveBeenCalledWith("c1");
    expect(labels(main)).toEqual([CHANGE.another]);
    btn(main, CHANGE.another).click();
    expect(main.textContent).toContain("What would you like to change?");
    off();
    const b = fake({}, [cards()]);
    const later = await open(b);
    btn(later.main, CHANGE.later).click();
    await until(() => later.main.textContent.includes(CHANGE.kept));
    expect(b.laterChange).toHaveBeenCalledWith("c1");
    expect(later.main.all("a").filter((l) => l.attrs.href === "#/repos/r1").length).toBeGreaterThan(0);
    later.off();
  });

  it("reads the request again after a failed build and follows it when it was planned after all", async () => {
    const a = fake({ buildChange: vi.fn(async () => { throw new Error("502 half done"); }) }, [cards()], [view("planned", { building: true, cards: [card("d1")] })]);
    const { main, off } = await open(a);
    btn(main, CHANGE.build).click();
    await until(() => main.textContent.includes(CHANGE.onItsWay));
    off();
    const b = fake({ buildChange: vi.fn(async () => { throw new Error("409"); }) }, [cards()], [cards()]);
    const same = await open(b);
    btn(same.main, CHANGE.build).click();
    await until(() => same.main.textContent.includes(CHANGE.failed));
    expect(labels(same.main)).toContain(CHANGE.build);
    same.off();
  });
});

describe("the Ask for a change page: stuck and the rest", () => {
  it("shows a fixed sentence, never the server's reason, and Try again calls retry", async () => {
    const a = fake({}, [view("stuck", { reason: "The Foundry could not finish this by itself. run abc" })], [view("thinking")]);
    const { main, off } = await open(a);
    expect(main.textContent).toContain(CHANGE.stuck);
    expect(main.textContent).not.toContain("abc");
    btn(main, CHANGE.retry).click();
    await until(() => a.retryChange.mock.calls.length === 1);
    expect(a.retryChange).toHaveBeenCalledWith("c1");
    await until(() => main.textContent.includes(CHANGE.thinking));
    off();
  });

  it("keeps typed text in the draft across a redraw and after the page is opened again", async () => {
    const a = fake();
    const first = await open(a);
    type(box(first.main), "typed");
    first.off();
    expect(cm.hasUnsentChange()).toBe(true);
    const second = await open(a);
    expect(box(second.main).value).toBe("typed");
    second.off();
  });
});

describe("the Ask for a change page: delayed answers", () => {
  /** A promise that the test resolves by hand, so the page can be seen while a call is on its way. */
  const gate = () => { let go!: (v: unknown) => void; let fail!: (e: unknown) => void; const p = new Promise((res, rej) => { go = res; fail = rej; }); return { p, go, fail }; };

  it("keeps text typed while Send is on its way, and does not clear it when the earlier send worked", async () => {
    const g = gate();
    const a = fake({ createChange: vi.fn(() => g.p) });
    const { main, off } = await open(a);
    type(box(main), "first");
    btn(main, CHANGE.send).click();
    await until(() => a.createChange.mock.calls.length === 1);
    expect(off_(box(main))).toBe(true);
    // a browser would not take typing into a disabled box; a change made by other means must still survive the answer
    cm.changeDraft("r1").text = "second";
    g.go(view("thinking"));
    await until(() => main.textContent.includes(CHANGE.thinking));
    expect(cm.changeDraft("r1").text).toBe("second");
    expect(cm.hasUnsentChange()).toBe(true);
    off();
  });

  it("says the build did not start when publishing worked but the build did not, and offers Yes, build this again", async () => {
    const a = fake({ buildChange: vi.fn(async () => { throw new Error("502 after publishing"); }) }, [cards()], [view("planned", { building: false, cards: [card("d1")] })]);
    const { main, off } = await open(a);
    btn(main, CHANGE.build).click();
    await until(() => main.textContent.includes(CHANGE.buildFailed));
    expect(main.textContent).not.toContain(CHANGE.kept);
    expect(labels(main)).toContain(CHANGE.build);
    btn(main, CHANGE.build).click();
    await until(() => a.buildChange.mock.calls.length === 2);
    off();
  });
});

describe("the words on the page", () => {
  const dirty = (state: string) => {
    const bad = { title: "Fix issue #12 label", understood: "This is what I understood: it costs $3 on a branch", criteria: ["Works", "Uses a label", "Costs $3"] };
    if (state === "questions") return questions();
    if (state === "cards") return cards(2, { cards: [card("d1", bad), card("d2", bad)] });
    return view(state, { cards: [card("d1", bad)], building: true, reason: "run failed in branch main" });
  };
  const hidden = /\bcosts?\b|\$\s?\d|#\d+|\blabels?\b|\bissues?\b|\bbranch(es)?\b|\bruns?\b|\bfailed\b|\bepics?\b/i;

  it("shows no forbidden term in any phase, also in text boxes after Change, and passes the accessibility check", async () => {
    for (const state of ["thinking", "questions", "cards", "planned", "stuck"]) {
      const { main, off } = await open(fake({}, [dirty(state)]));
      if (state === "cards") btn(main, CHANGE.change).click();
      for (const t of readable(main)) expect(words.forbiddenIn(t), `${state}: ${t}`).toEqual([]);
      expect(readable(main).join(" ")).not.toMatch(hidden);
      expect(audit(main), state).toEqual([]);
      off();
    }
    const write = await open(fake());
    expect(audit(write.main)).toEqual([]);
    write.off();
    const bad = await open(fake({ repos: vi.fn(async () => { throw new Error("x"); }) }));
    expect(audit(bad.main)).toEqual([]);
    bad.off();
  });

  it("keeps the untouched criteria when a card with a hidden point is saved", async () => {
    const raw = cards(1, { cards: [card("d1", { criteria: ["Works", "Uses a label"] })] });
    const a = fake({}, [raw]);
    const { main, off } = await open(a);
    btn(main, CHANGE.change).click();
    type(main.all("textarea")[0]!, "Works well");
    btn(main, CHANGE.save).click();
    await until(() => a.saveChangeCard.mock.calls.length === 1);
    expect(a.saveChangeCard).toHaveBeenCalledWith("c1", "d1", { criteria: ["Works well", "Uses a label"] });
    off();
  });
});

describe("the Planned entries on the project page", () => {
  const kept = [
    { id: "k1", state: "planned", building: false, cards: [card("d1", { title: "Show the weather" })], updated: "2026-01-01T10:00:00Z", created: "2026-01-01T10:00:00Z" },
    { id: "k2", state: "planned", building: true, cards: [card("d1", { title: "Already building" })], updated: "2026-01-01T10:00:00Z", created: "2026-01-01T10:00:00Z" },
  ];
  const projectApi = (over: any = {}) => ({
    repos: vi.fn(async () => repos), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn(),
    changes: vi.fn(async () => ({ changes: kept })), buildChange: vi.fn(async () => ({})), ...over,
  }) as any;

  it("counts the card in the state line and shows Yes, build this", () => {
    const m = simpleModel.projectsModel(repos, [], [], { r1: kept });
    expect(m[0].groups.planned.map((c: any) => c.title)).toEqual(["Show the weather"]);
    expect(m[0].state).toBe("1 thing planned");
    expect(m[1].groups.planned).toEqual([]);
  });

  it("reads the right repo, lists only the kept request, and builds it and reads the page again", async () => {
    const a = projectApi();
    const main = new FakeElement("div");
    const off = await simple.renderSimpleProject(main, { id: "r1", a });
    expect(a.changes).toHaveBeenCalledWith("o/app");
    expect(main.textContent).toContain("Show the weather");
    expect(main.textContent).not.toContain("Already building");
    const runsBefore = a.runs.mock.calls.length;
    btn(main, CHANGE.build).click();
    await until(() => a.buildChange.mock.calls.length === 1);
    expect(a.buildChange).toHaveBeenCalledWith("k1");
    await until(() => a.runs.mock.calls.length > runsBefore);
    off();
  });

  it("reads the local name for a local project, and tells a failed build", async () => {
    const a = projectApi({ buildChange: vi.fn(async () => { throw new Error("409 label"); }) });
    const main = new FakeElement("div");
    const off = await simple.renderSimpleProject(main, { id: "r2", a });
    expect(a.changes).toHaveBeenCalledWith("local:demo-0123abcd");
    btn(main, CHANGE.build).click();
    await until(() => main.textContent.includes(CHANGE.failed));
    expect(main.textContent).not.toContain("409");
    off();
  });

  it("still draws the page when the read fails or the API has no such call", async () => {
    const a = projectApi({ changes: vi.fn(async () => { throw new Error("down"); }) });
    const main = new FakeElement("div");
    (await simple.renderSimpleProject(main, { id: "r1", a }))();
    expect(main.textContent).toContain("What you need to do");
    expect(main.textContent).not.toContain("Show the weather");
    const b = projectApi();
    delete b.changes;
    const main2 = new FakeElement("div");
    (await simple.renderSimpleProject(main2, { id: "r1", a: b }))();
    expect(main2.textContent).toContain("What you need to do");
  });
});
