import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let dr: any;
let pub: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  dr = await import("../ui/refinement-draft.js" as string);
  pub = await import("../ui/refinement-publish.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const realConfirm = (globalThis as any).confirm;
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const D3 = "33333333-3333-4333-8333-333333333333";
const XSS = "<img src=x onerror=1>";
let drafts: any[];
let over: any;
let plan: any;
let sent: { method: string; url: string; body: any }[];
let postAnswer: ((body: any) => { status: number; body: any }) | undefined;
let planStatus: number;
let putStatus: number;
let confirmAnswer: boolean;
let cleanup: (() => void) | undefined;

const mk = (id: string, title: string, extra: object = {}) => ({
  id, title: { text: title }, criteria: [], dependsOn: [], state: "ready",
  preview: { title, body: "As a user, I want x, so that y.\n\n### Acceptance criteria\n- [ ] one\n\n### Depends on\nNone (can be built on its own)." }, ...extra,
});
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", architect: { state: "idle" }, readyList: [],
  talk: { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] },
  state: drafts.length && drafts.every((d) => d.published) ? "published" : "drafting",
  drafts, log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }], created: "x", updated: "x", mine: true, ...over,
});
const item = (n: number, d: any, extra: object = {}) => ({ n, draft: d.id, title: d.title.text, body: `BODY of ${d.title.text}`, state: "ready", dependsOn: [], labels: [], ...extra });
const makePlan = (extra: object = {}) => ({
  repo: "acme/app", items: [item(1, mk(D1, "One"))], willCreate: [D1], repoLabels: ["bug", "Build", "review"], buildLabel: "build", reviewLabel: "review", ...extra,
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  drafts = [mk(D1, "One")];
  over = {};
  plan = makePlan();
  sent = [];
  postAnswer = undefined;
  planStatus = 200;
  putStatus = 200;
  confirmAnswer = true;
  dr.unsaved.clear();
  dr.opened.clear();
  (document as any).getElementById("toast").textContent = "";
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).activeElement = null;
  (globalThis as any).location = { hash: "#/refinement/s1", reload: vi.fn() };
  (globalThis as any).confirm = () => confirmAnswer;
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    if (url.endsWith("/publish")) {
      if (init.method === "GET") return planStatus === 200 ? reply(plan) : reply({ error: "plan boom" }, planStatus);
      const a = postAnswer ? postAnswer(body) : { status: 200, body: { repo: "acme/app", created: [], state: "published" } };
      return reply(a.body, a.status);
    }
    if (init.method === "PUT") return putStatus === 200 ? reply(view()) : reply({ error: "put no" }, putStatus);
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

const flush = () => vi.advanceTimersByTimeAsync(0);
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const publishBox = () => walk(main()).find((e) => e.attrs.class === "publish")!;
const draftsBox = () => walk(main()).find((e) => e.attrs.class === "drafts")!;
const buttons = (root: FakeElement) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root: FakeElement = main()) => buttons(root).find((e) => e.textContent === t);
const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
const dialog = () => walk(modalRoot()).find((e) => e.attrs.role === "dialog");
const planItem = (id: string) => walk(dialog()!).find((e) => e.attrs["data-plan"] === id)!;
const press = async (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
  await flush();
};
const show = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
};
const publishButton = () => button("Publish", publishBox());
const openPlan = async () => {
  await show();
  await press(publishButton());
};
const posts = () => sent.filter((x) => x.method === "POST" && x.url.endsWith("/publish"));
const tick = (el: FakeElement | undefined) => {
  expect(el, "tick box").toBeDefined();
  el!.checked = true;
};
const labelBox = (id: string, name: string) => walk(planItem(id)).find((e) => e.attrs["data-label"] === name);
const startBox = (id: string) => walk(planItem(id)).find((e) => e.attrs["data-start"] !== undefined);
const links = () => walk(draftsBox()).filter((e) => e.tag === "a");

describe("pure functions", () => {
  const s = (extra: object = {}) => ({ mine: true, state: "drafting", repoAvailable: true, drafts: [{ id: D1, state: "ready" }], ...extra });
  it("canPublish", () => {
    expect(pub.canPublish(s())).toBe(true);
    expect(pub.canPublish(s({ mine: false }))).toBe(false);
    expect(pub.canPublish(s({ state: "dropped" }))).toBe(false);
    expect(pub.canPublish(s({ repoAvailable: false }))).toBe(false);
    expect(pub.canPublish(s({ draftsHidden: true }))).toBe(false);
    expect(pub.canPublish(s({ drafts: [{ id: D1, state: "drafting" }] }))).toBe(false);
    expect(pub.canPublish(s({ drafts: [{ id: D1, state: "ready", published: { issue: 1, url: "u" } }] }))).toBe(false);
  });
  it("dependsText", () => {
    expect(pub.dependsText({ issue: 12 })).toBe("#12");
    expect(pub.dependsText({ item: 2, title: "B" })).toBe("new issue 2: B");
  });
  it("offeredLabels leaves out the build and the review label in any case", () => {
    expect(pub.offeredLabels({ repoLabels: ["bug", "BUILD", "Review", "docs"], buildLabel: "build", reviewLabel: "review" })).toEqual(["bug", "docs"]);
  });
  it("buildChoice", () => {
    expect(pub.buildChoice(makePlan())).toEqual({ label: "build" });
    expect(pub.buildChoice(makePlan({ buildLabel: undefined }))).toEqual({ why: pub.NO_WATCHER });
    const missing = pub.buildChoice(makePlan({ repoLabels: ["bug"] }));
    expect(missing.label).toBe("build");
    expect(missing.missing).toContain("does not exist in acme/app");
  });
  it("reviewLabelOf is set only when the draft asked for it", () => {
    const sess = { drafts: [{ id: D1, addReviewLabel: true }, { id: D2 }] };
    expect(pub.reviewLabelOf(makePlan(), sess, D1)).toBe("review");
    expect(pub.reviewLabelOf(makePlan(), sess, D2)).toBe("");
    expect(pub.reviewLabelOf(makePlan({ reviewLabel: undefined }), sess, D1)).toBe("");
    expect(pub.reviewLabelOf(makePlan({ reviewLabel: "build" }), sess, D2)).toBe("");
  });
  it("choiceProblem knows the choices the server would refuse", () => {
    const sess = { drafts: [{ id: D1, addReviewLabel: true }] };
    const none = { labels: [], startBuilding: false };
    expect(pub.choiceProblem(makePlan(), sess, D1, none)).toBe("");
    expect(pub.choiceProblem(makePlan({ reviewLabel: "same", buildLabel: "same", repoLabels: ["same"] }), sess, D1, none)).toContain("also the build label");
    expect(pub.choiceProblem(makePlan({ reviewLabel: "same", buildLabel: "same", repoLabels: ["same"] }), sess, D1, { ...none, startBuilding: true })).toBe("");
    expect(pub.choiceProblem(makePlan({ repoLabels: ["bug"] }), sess, D1, none)).toContain("does not exist");
    expect(pub.choiceProblem(makePlan({ reviewLabel: undefined }), sess, D1, none)).toContain("has none");
    expect(pub.choiceProblem(makePlan({ repoLabels: ["bug", "review"] }), { drafts: [] }, D1, { ...none, startBuilding: true })).toContain("does not exist");
  });
  it("publishBody lists the drafts that will be created, in order", () => {
    const p = makePlan({ willCreate: [D2, D1] });
    expect(pub.publishBody(p, { [D1]: { labels: ["bug"], startBuilding: true } })).toEqual({
      drafts: [{ draft: D2, labels: [], startBuilding: false }, { draft: D1, labels: ["bug"], startBuilding: true }],
    });
  });
  it("onGithubText", () => {
    expect(pub.onGithubText({ drafts: [] })).toBe("Nothing is on GitHub yet.");
    expect(pub.onGithubText({ drafts: [{ id: D1, published: { issue: 101, url: "u" } }, { id: D2, published: { issue: 102, url: "u" } }] })).toBe("On GitHub already: #101, #102.");
  });
  it("the api calls", async () => {
    await api.publishPlan("a b");
    await api.publish("a b", { drafts: [] });
    expect(sent.map((x) => [x.method, x.url])).toEqual([["GET", "/api/refinement/a%20b/publish"], ["POST", "/api/refinement/a%20b/publish"]]);
  });
});

describe("the button", () => {
  it("is shown with one ready draft", async () => {
    await show();
    expect(publishButton()).toBeDefined();
  });
  it("is hidden when no draft is ready, for others, without the repository and in a preview", async () => {
    drafts = [mk(D1, "One", { state: "drafting" })];
    await show();
    expect(publishButton()).toBeUndefined();
    expect(publishBox().textContent).toContain(pub.NO_READY_YET);
    cleanup?.();
    drafts = [mk(D1, "One")];
    over = { mine: false };
    await show();
    expect(publishButton()).toBeUndefined();
    cleanup?.();
    over = { repoAvailable: false };
    await show();
    expect(publishButton()).toBeUndefined();
    cleanup?.();
    over = {};
    cleanup = await ui.renderRefinement(main(), { id: "s1", readOnly: true });
    expect(publishButton()).toBeUndefined();
  });
  it("says the architect is busy instead", async () => {
    over = { architect: { state: "running", kind: "brief", doing: "x" } };
    await show();
    expect(publishButton()).toBeUndefined();
    expect(publishBox().textContent).toContain(pub.ARCHITECT_BUSY);
  });
  it("says everything is on GitHub when the session is published", async () => {
    drafts = [mk(D1, "One", { published: { issue: 7, url: "https://github.com/acme/app/issues/7" } })];
    await show();
    expect(publishBox().textContent).toContain(pub.ALL_PUBLISHED);
    expect(publishButton()).toBeUndefined();
  });
});

describe("the plan", () => {
  it("lists the issues in order with text, dependencies and reasons; nothing is sent before the confirmation", async () => {
    const d1 = mk(D1, "One");
    const d2 = mk(D2, "Two");
    const d3 = mk(D3, "Three", { state: "drafting" });
    const d4 = mk("44444444-4444-4444-8444-444444444444", "Four", { published: { issue: 7, url: "https://github.com/acme/app/issues/7" } });
    drafts = [d1, d2, d3, d4];
    plan = makePlan({
      items: [item(1, d2), item(2, d1, { dependsOn: [{ item: 1, title: "Two" }, { issue: 5 }] }), item(3, d3, { state: "not-ready", reason: "No acceptance criteria yet." }), item(4, d4, { state: "on-github", issue: 7 })],
      willCreate: [D2, D1],
    });
    await openPlan();
    expect(dialog()).toBeDefined();
    const lis = walk(dialog()!).filter((e) => e.attrs["data-plan"] !== undefined).map((e) => e.attrs["data-plan"]);
    expect(lis).toEqual([D2, D1, D3, d4.id]);
    expect(planItem(D2).textContent).toContain("BODY of Two");
    expect(planItem(D1).textContent).toContain("new issue 1: Two");
    expect(planItem(D1).textContent).toContain("#5");
    expect(planItem(D2).textContent).toContain("None (can be built on its own).");
    expect(planItem(D3).textContent).toContain("No acceptance criteria yet.");
    expect(planItem(D3).textContent).toContain("BODY of Three");
    expect(planItem(D3).textContent).toContain("None (can be built on its own).");
    expect(planItem(d4.id).textContent).toContain("BODY of Four");
    expect(walk(planItem(D3)).some((e) => e.tag === "input")).toBe(false);
    expect(planItem(d4.id).textContent).toContain("On GitHub as #7");
    expect(planItem(D1).textContent).not.toMatch(/\d\. /); // the list numbers it, the text does not
    expect(posts()).toHaveLength(0);
    await press(button("Cancel", dialog()));
    expect(dialog()).toBeUndefined();
    expect(posts()).toHaveLength(0);
  });
  it("shows the tick box off by default, and none without a watcher", async () => {
    await openPlan();
    const box = startBox(D1)!;
    expect(box).toBeDefined();
    expect(box.checked).toBeFalsy();
    expect(planItem(D1).textContent).toContain("Start building this story");
    expect(planItem(D1).textContent).toContain('"build"');
    await press(button("Cancel", dialog()));
    plan = makePlan({ buildLabel: undefined });
    await press(publishButton());
    expect(startBox(D1)).toBeUndefined();
    expect(dialog()!.textContent).toContain(pub.NO_WATCHER);
  });
  it("shows the tick box disabled with the reason when the repository lacks the build label", async () => {
    plan = makePlan({ repoLabels: ["bug", "review"] });
    await openPlan();
    expect(startBox(D1)).toBeDefined();
    expect(startBox(D1)!.attrs.disabled).toBeDefined();
    expect(planItem(D1).textContent).toContain('The build label "build" does not exist in acme/app');
  });
  it("offers the labels of the repository unticked, and the review label only fixed for a draft that asked", async () => {
    drafts = [mk(D1, "One", { addReviewLabel: true }), mk(D2, "Two")];
    plan = makePlan({ items: [item(1, drafts[0]), item(2, drafts[1])], willCreate: [D1, D2] });
    await openPlan();
    const bug = labelBox(D1, "bug")!;
    expect(bug.checked).toBeFalsy();
    expect(labelBox(D1, "build")).toBeUndefined();
    expect(labelBox(D1, "review")).toBeUndefined();
    expect(planItem(D1).textContent).toContain("review (review label, the draft asked for it)");
    expect(planItem(D2).textContent).not.toContain("review label");
    const fixed = walk(planItem(D1)).find((e) => e.tag === "input" && e.attrs.disabled !== undefined)!;
    expect(fixed.checked).toBe(true);
  });
  it("sends the choices on confirm", async () => {
    drafts = [mk(D1, "One"), mk(D2, "Two")];
    plan = makePlan({ items: [item(1, drafts[1]), item(2, drafts[0], { dependsOn: [{ item: 1, title: "Two" }] })], willCreate: [D2, D1] });
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [], state: "drafting" } });
    await openPlan();
    tick(labelBox(D2, "bug"));
    tick(startBox(D1));
    await press(button(pub.CONFIRM, dialog()));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({ drafts: [{ draft: D2, labels: ["bug"], startBuilding: false }, { draft: D1, labels: [], startBuilding: true }] });
    expect(dialog()).toBeUndefined();
  });
  it("does not send a choice the server would refuse", async () => {
    drafts = [mk(D1, "One", { addReviewLabel: true })];
    plan = makePlan({ items: [item(1, drafts[0])], reviewLabel: "same", buildLabel: "same", repoLabels: ["same", "bug"] });
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(posts()).toHaveLength(0);
    expect(dialog()!.textContent).toContain("also the build label");
    tick(startBox(D1));
    await press(button(pub.CONFIRM, dialog()));
    expect(posts()).toHaveLength(1);
  });
  it("refuses more than 20 labels", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `l${i}`);
    plan = makePlan({ repoLabels: many });
    await openPlan();
    for (const l of many) tick(labelBox(D1, l));
    await press(button(pub.CONFIRM, dialog()));
    expect(dialog()!.textContent).toContain("Choose at most 20 labels for a story.");
    expect(posts()).toHaveLength(0);
  });
  it("sets titles as text", async () => {
    drafts = [mk(D1, XSS)];
    plan = makePlan({ items: [item(1, drafts[0])] });
    await openPlan();
    expect(planItem(D1).textContent).toContain(XSS);
    expect(walk(dialog()!).some((e) => e.tag === "img")).toBe(false);
  });
  it("has nothing to confirm when nothing will be created", async () => {
    plan = makePlan({ willCreate: [] });
    await openPlan();
    expect(button(pub.CONFIRM, dialog())).toBeUndefined();
    expect(dialog()!.textContent).toContain(pub.NOTHING_READY);
  });
});

describe("after publishing", () => {
  const link = (n: number) => ({ issue: n, url: `https://github.com/acme/app/issues/${n}` });
  it("shows the links, read only, and the state Published", async () => {
    postAnswer = () => {
      drafts = [mk(D1, "One", { published: link(101) })];
      return { status: 200, body: { repo: "acme/app", created: [{ draft: D1, ...link(101), found: false }], state: "published" } };
    };
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(dialog()).toBeUndefined();
    const a = links()[0]!;
    expect(a.attrs.href).toBe("https://github.com/acme/app/issues/101");
    expect(a.attrs.target).toBe("_blank");
    expect(a.textContent).toBe("#101");
    expect((document as any).getElementById("toast").textContent).toBe("1 issue is on GitHub");
    await press(button("Open", draftsBox()));
    const all = walk(draftsBox());
    expect(all.some((e) => e.tag === "textarea" || e.attrs.name === "title")).toBe(false);
    expect(draftsBox().textContent).toContain("cannot be changed here");
    expect(walk(main()).some((e) => e.attrs.class === "pill state-published" && e.textContent === "Published")).toBe(true);
    expect(button("New draft")).toBeUndefined();
    expect(publishButton()).toBeUndefined();
    expect(button("Set Epic")).toBeUndefined();
    expect(publishBox().textContent).toContain(pub.ALL_PUBLISHED);
  });
  it("draws a link that is not on github.com as text", async () => {
    drafts = [mk(D1, "One", { published: { issue: 101, url: "javascript:alert(1)" } })];
    await show();
    expect(links()).toHaveLength(0);
    expect(draftsBox().textContent).toContain("#101");
  });
  it("hides the Epic buttons on the same page when a draft gets published", async () => {
    drafts = [mk(D1, "One"), mk(D2, "Two", { state: "drafting" })];
    await show();
    expect(button("Set Epic")).toBeDefined();
    postAnswer = () => {
      drafts = [mk(D1, "One", { published: link(101) }), mk(D2, "Two", { state: "drafting" })];
      return { status: 200, body: { repo: "acme/app", created: [{ draft: D1, ...link(101), found: false }], state: "drafting" } };
    };
    await press(publishButton());
    await press(button(pub.CONFIRM, dialog()));
    expect(button("Set Epic")).toBeUndefined();
    expect(links()).toHaveLength(1);
  });
  it("says the issues are on GitHub when only the refresh fails", async () => {
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [{ draft: D1, ...link(101), found: false }], state: "published" } });
    await openPlan();
    const before = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (init.method === "GET" && !url.endsWith("/publish") && posts().length) throw new TypeError("offline");
      return before(url, init);
    };
    await press(button(pub.CONFIRM, dialog()));
    expect(posts()).toHaveLength(1);
    expect(publishBox().textContent).toContain("The issues are on GitHub");
    expect(publishBox().textContent).toContain(pub.UNKNOWN);
    expect(publishBox().textContent).not.toContain("Nothing is on GitHub yet");
  });
  it("says it is not known what is on GitHub when a failed publish cannot be read back", async () => {
    postAnswer = () => ({ status: 502, body: { error: "GitHub did not make the issue: boom." } });
    await openPlan();
    const before = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (init.method === "GET" && !url.endsWith("/publish") && posts().length) throw new TypeError("offline");
      return before(url, init);
    };
    await press(button(pub.CONFIRM, dialog()));
    expect(publishBox().textContent).toContain("GitHub did not make the issue: boom.");
    expect(publishBox().textContent).toContain(pub.UNKNOWN);
    expect(publishBox().textContent).not.toContain("Nothing is on GitHub yet");
  });
});

describe("a failure", () => {
  it("shows the server's message and what is on GitHub, and offers Publish again for the rest", async () => {
    drafts = [mk(D1, "One"), mk(D2, "Two")];
    plan = makePlan({ items: [item(1, drafts[1]), item(2, drafts[0])], willCreate: [D2, D1] });
    let n = 0;
    postAnswer = () => {
      n++;
      if (n > 1) return { status: 200, body: { repo: "acme/app", created: [], state: "drafting" } };
      drafts = [mk(D1, "One"), mk(D2, "Two", { published: { issue: 101, url: "https://github.com/acme/app/issues/101" } })];
      return { status: 502, body: { error: "GitHub did not make the issue: boom. Made so far: #101. Publish again." } };
    };
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(dialog()).toBeUndefined();
    expect(publishBox().textContent).toContain("GitHub did not make the issue: boom.");
    expect(publishBox().textContent).toContain("On GitHub already: #101.");
    expect(publishButton()).toBeDefined();
    plan = makePlan({ items: [item(1, drafts[0]), item(2, drafts[1], { state: "on-github", issue: 101 })], willCreate: [D1] });
    await press(publishButton());
    await press(button(pub.CONFIRM, dialog()));
    expect(posts()[1]!.body.drafts.map((x: any) => x.draft)).toEqual([D1]);
  });
  it("shows the message when the plan cannot be read", async () => {
    planStatus = 502;
    await openPlan();
    expect(dialog()).toBeUndefined();
    expect(publishBox().textContent).toContain("plan boom");
  });
});

describe("typed text", () => {
  const typeTitle = async () => {
    await show();
    await press(button("Open", draftsBox()));
    const title = walk(draftsBox()).find((e) => e.attrs.name === "title")!;
    title.value = "New title";
    title.fire("input");
  };
  it("is saved before the plan is read", async () => {
    await typeTitle();
    await press(publishButton());
    const put = sent.findIndex((x) => x.method === "PUT");
    const planGet = sent.findIndex((x) => x.method === "GET" && x.url.endsWith("/publish"));
    expect(put).toBeGreaterThan(-1);
    expect(planGet).toBeGreaterThan(put);
    expect(dialog()).toBeDefined();
  });
  it("stops with a message when it cannot be saved", async () => {
    putStatus = 400;
    await typeTitle();
    await press(publishButton());
    expect(sent.some((x) => x.method === "GET" && x.url.endsWith("/publish"))).toBe(false);
    expect(publishBox().textContent).toContain(pub.NOT_SAVED);
  });
  it("asks when a text has no place any more", async () => {
    await show();
    dr.unsaved.set(`s1\u0001gone\u0001title`, "lost text");
    confirmAnswer = false;
    await press(publishButton());
    expect(sent.some((x) => x.method === "GET" && x.url.endsWith("/publish"))).toBe(false);
    confirmAnswer = true;
    await press(publishButton());
    expect(dialog()).toBeDefined();
  });
});
