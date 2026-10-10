import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { answerDialog, autoDialog } from "./helpers/confirm-dialog.js";

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
let stopDialog: (() => void) | undefined;
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
  pub.partials.clear();
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
  stopDialog = autoDialog(() => confirmAnswer);
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
  stopDialog?.();
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

describe("a session that came from an issue", () => {
  const source = { issue: 7, url: "https://github.com/acme/app/issues/7", title: "T", body: "", updatedAt: "x", draft: D1 };
  const updating = (extra: object = {}) => makePlan({ items: [item(1, mk(D1, "One"), { updates: 7 })], willCreate: [], willUpdate: [D1], ...extra });
  it("willPublish, confirmText and doneText", () => {
    expect(pub.willPublish({ willUpdate: [D1], willCreate: [D2] })).toEqual([D1, D2]);
    expect(pub.willPublish({ willCreate: [D2] })).toEqual([D2]);
    expect(pub.confirmText({ willCreate: [D2] })).toBe("Create the issues");
    expect(pub.confirmText({ willUpdate: [D1], willCreate: [] })).toBe("Update the issue");
    expect(pub.confirmText({ willUpdate: [D1], willCreate: [D2] })).toBe("Update and create the issues");
    expect(pub.doneText({ created: [{}] })).toBe("1 issue is on GitHub");
    expect(pub.doneText({ created: [{}, {}] })).toBe("2 issues are on GitHub");
    expect(pub.doneText({ created: [], updated: [{ issue: 7 }] })).toBe("Issue #7 is updated");
    expect(pub.doneText({ created: [{}, {}], updated: [{ issue: 7 }] })).toBe("Issue #7 is updated and 2 issues are on GitHub");
  });
  it("updatesOf", () => {
    const d = mk(D1, "One");
    expect(pub.updatesOf({ drafts: [d] })).toBeUndefined();
    expect(pub.updatesOf({ source, drafts: [d] })).toEqual({ issue: 7, draft: d, published: undefined });
    expect(pub.updatesOf({ source, drafts: [mk(D2, "Two")] })).toBeUndefined();
    expect(pub.updatesOf({ source, drafts: [mk(D1, "One", { state: "split" })] })).toBeUndefined();
    const done = mk(D1, "One", { published: { issue: 7, url: "u" } });
    expect(pub.updatesOf({ source, drafts: [done] }).published).toEqual({ issue: 7, url: "u" });
  });
  it("shows Updates #N in the dialog, and a confirm button that sends the draft", async () => {
    over = { source };
    plan = updating();
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [], updated: [{ draft: D1, issue: 7, url: source.url, found: false }], state: "published" } });
    await openPlan();
    expect(planItem(D1).textContent).toContain("Updates #7");
    expect(planItem(D1).textContent).toContain("The title and text of issue #7 are replaced. Its labels are kept.");
    expect(dialog()!.textContent).toContain("Issue #7 is updated, not created again.");
    expect(button(pub.CONFIRM, dialog())).toBeUndefined();
    tick(labelBox(D1, "bug"));
    await press(button("Update the issue", dialog()));
    expect(posts()[0]!.body).toEqual({ drafts: [{ draft: D1, labels: ["bug"], startBuilding: false }] });
    expect((document as any).getElementById("toast").textContent).toBe("Issue #7 is updated");
  });
  it("says when the issue is not changed", async () => {
    over = { source };
    plan = makePlan({ notChanged: 7 });
    await openPlan();
    expect(dialog()!.textContent).toContain("Issue #7 is not changed: no story draft stands for it.");
  });
  it("shows what the section does with the issue, before and after", async () => {
    over = { source };
    await show();
    expect(publishBox().textContent).toContain("Updates #7: One");
    drafts = [mk(D1, "One", { published: { issue: 7, url: source.url } })];
    await show();
    const a = walk(publishBox()).find((e) => e.tag === "a");
    expect(a?.attrs.href).toBe(source.url);
    expect(publishBox().textContent).toContain("Updated #7");
    drafts = [mk(D1, "One", { published: { issue: 7, url: "javascript:alert(1)" } })];
    await show();
    expect(walk(publishBox()).some((e) => e.tag === "a")).toBe(false);
    expect(publishBox().textContent).toContain("Updated #7");
    drafts = [mk(D2, "Two")];
    await show();
    expect(publishBox().textContent).toContain("Issue #7 is not changed.");
  });
  it("shows a title with markup as text", async () => {
    over = { source };
    drafts = [mk(D1, XSS)];
    await show();
    expect(publishBox().textContent).toContain(XSS);
    expect(walk(publishBox()).some((e) => e.tag === "img")).toBe(false);
  });
  it("behaves as before without willUpdate", async () => {
    plan = makePlan();
    await openPlan();
    expect(button(pub.CONFIRM, dialog())).toBeDefined();
    expect(dialog()!.textContent).not.toContain("Updates #");
    expect(dialog()!.textContent).not.toContain("is not changed");
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
    // Issue 101 was made and the other was not: a banner lists both sides, with the server's words and Retry; the plain line is not shown too.
    expect(publishBox().textContent).toContain("GitHub did not make the issue: boom.");
    expect(publishBox().textContent).toContain("1 of 2 issues are on GitHub: #101 Two. Not published: One.");
    expect(publishBox().textContent).not.toContain("On GitHub already");
    expect(button("Retry", publishBox())).toBeDefined();
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
  it("asks in the dialog, with its own title and button", async () => {
    await show();
    dr.unsaved.set(`s1\u0001gone\u0001title`, "lost text");
    stopDialog?.();
    await press(publishButton());
    expect(walk(modalRoot()).find((e) => e.tag === "h2")!.textContent).toBe(pub.PUBLISH_TITLE);
    expect(dialog()!.textContent).toContain(pub.LOST_ASK);
    expect(button("Publish anyway", dialog())).toBeDefined();
    await answerDialog(false);
    expect(sent.some((x) => x.method === "GET" && x.url.endsWith("/publish"))).toBe(false);
  });
});

describe("a publish that stops half way", () => {
  const link = (n: number) => ({ issue: n, url: `https://github.com/acme/app/issues/${n}` });
  const three = () => [mk(D1, "One"), mk(D2, "Two"), mk(D3, "Three")];
  const plan3 = () => makePlan({ items: three().map((d, i) => item(i + 1, d)), willCreate: [D1, D2, D3] });
  /** The first publish makes two of three issues and fails; later ones make what is asked. */
  const partly = (made: string[], error = "GitHub did not make the issue: boom.") => {
    postAnswer = () => {
      drafts = three().map((d, i) => (made.includes(d.id) ? { ...d, published: link(101 + i) } : d));
      return { status: 502, body: { error } };
    };
  };
  const banner = () => walk(publishBox()).find((e) => e.attrs["data-kind"] === "warn");
  const retry = () => button("Retry", publishBox());

  it("partialOf and partialText", () => {
    const s = { drafts: [{ ...mk(D1, "One"), published: link(101) }, mk(D2, "Two"), { ...mk(D3, "Three"), published: link(103) }] };
    const p = pub.partialOf(new Set([D3]), [D1, D2, D3], s);
    expect(p).toEqual({ made: [D1], rest: [D2] });
    expect(pub.partialText({ ...p, error: "boom." }, s)).toBe("1 of 2 issues are on GitHub: #101 One. Not published: Two. boom.");
  });
  it("lists both sides in a banner with Retry, and not also the plain failure line", async () => {
    drafts = three();
    plan = plan3();
    partly([D1, D2]);
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(dialog()).toBeUndefined();
    expect(banner()).toBeDefined();
    expect(banner()!.textContent).toContain("2 of 3 issues are on GitHub: #101 One, #102 Two. Not published: Three.");
    expect(banner()!.textContent).toContain("GitHub did not make the issue: boom.");
    expect(retry()).toBeDefined();
    expect(walk(publishBox()).filter((e) => e.attrs.class === "status bad")).toHaveLength(0);
    expect((document as any).getElementById("toast").textContent).toContain("2 of 3 issues are on GitHub");
  });
  it("stays after the same session is drawn again and after the page is drawn again", async () => {
    drafts = three();
    plan = plan3();
    partly([D1, D2]);
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()).toBeDefined();
    cleanup?.();
    await show();
    expect(banner()).toBeDefined();
    expect(banner()!.textContent).toContain("Not published: Three.");
  });
  it("Retry opens the plan; a good publish removes the banner and the toast stays extra", async () => {
    drafts = three();
    plan = plan3();
    partly([D1, D2]);
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    plan = makePlan({ items: [item(1, drafts[2])], willCreate: [D3] });
    postAnswer = () => {
      drafts = three().map((d, i) => ({ ...d, published: link(101 + i) }));
      return { status: 200, body: { repo: "acme/app", created: [{ draft: D3, ...link(103), found: false }], state: "published" } };
    };
    await press(retry());
    expect(dialog()).toBeDefined();
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()).toBeUndefined();
    expect((document as any).getElementById("toast").textContent).toContain("1 issue is on GitHub");
  });
  it("two partial attempts add up what was made", async () => {
    drafts = three();
    plan = plan3();
    partly([D1]);
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()!.textContent).toContain("1 of 3 issues are on GitHub");
    plan = makePlan({ items: [item(1, drafts[1]), item(2, drafts[2])], willCreate: [D2, D3] });
    partly([D1, D2]);
    await press(retry());
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()!.textContent).toContain("2 of 3 issues are on GitHub: #101 One, #102 Two. Not published: Three.");
  });
  it("a second partial attempt keeps an earlier unresolved draft that was not part of it", async () => {
    drafts = three();
    plan = plan3();
    partly([D1]);
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    plan = makePlan({ items: [item(1, drafts[1])], willCreate: [D2] });
    partly([D1, D2]);
    await press(retry());
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()!.textContent).toContain("Not published: Three.");
  });
  it("a successful publish that leaves a draft out keeps the banner until it is published or removed", async () => {
    drafts = three();
    plan = plan3();
    partly([D1, D2]);
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    plan = makePlan({ items: [item(1, drafts[0])], willCreate: [D1] });
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [], state: "drafting" } });
    await press(retry());
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()).toBeDefined();
    drafts = [drafts[0]!, drafts[1]!]; // the remaining draft is removed
    await ui.renderRefinement(main(), { id: "s1" });
    expect(banner()).toBeUndefined();
  });
  it("a failure with nothing made shows the plain failure line and no banner", async () => {
    postAnswer = () => ({ status: 502, body: { error: "GitHub did not make the issue: boom." } });
    await openPlan();
    await press(button(pub.CONFIRM, dialog()));
    expect(banner()).toBeUndefined();
    expect(publishBox().textContent).toContain("Nothing is on GitHub yet");
  });
});

describe("replacing a split issue", () => {
  const source = { issue: 7, url: "https://github.com/acme/app/issues/7", title: "T", body: "", updatedAt: "x", draft: D1 };
  const split = () => [mk(D1, "Orig", { state: "split", splitInto: [D2, D3] }), mk(D2, "Two"), mk(D3, "Three")];
  const pubd = (d: any, n: number) => ({ ...d, published: { issue: n, url: `https://github.com/acme/app/issues/${n}` } });
  const rep = (extra: object = {}) => ({ issue: 7, parts: [{ issue: 101 }, { issue: 102 }], ready: true, dependants: [], ...extra });
  const toast = () => (document as any).getElementById("toast").textContent;
  const replaced = { issue: 7, parts: [101, 102], dependants: [], closed: "not_planned" };
  const dueDrafts = () => [split()[0], pubd(mk(D2, "Two"), 101), pubd(mk(D3, "Three"), 102)];
  const duePlan = () => makePlan({ items: [item(1, mk(D2, "Two"), { state: "on-github", issue: 101 }), item(2, mk(D3, "Three"), { state: "on-github", issue: 102 })], willCreate: [], replaces: rep() });
  const dueSession = () => { drafts = dueDrafts(); over = { state: "published", source: { ...source, replace: "due" } }; plan = duePlan(); };
  const createPlan = (replaces: object) => {
    drafts = split();
    over = { source: { ...source, replace: "waiting" } };
    plan = makePlan({ items: [item(1, drafts[1]), item(2, drafts[2])], willCreate: [D2, D3], replaces });
  };

  describe("pure", () => {
    const s = (extra: object = {}) => ({ mine: true, state: "published", repoAvailable: true, drafts: [{ id: D1, state: "ready", published: { issue: 1, url: "u" } }], ...extra });
    it("canPublish when the replacement is due, also in a published session", () => {
      expect(pub.canPublish(s({ source: { issue: 7, replace: "due" } }))).toBe(true);
      expect(pub.canPublish(s({ source: { issue: 7, replace: "done" } }))).toBe(false);
      expect(pub.canPublish(s({ source: { issue: 7, replace: "waiting" } }))).toBe(false);
      expect(pub.canPublish(s({ source: { issue: 7, replace: "due" }, mine: false }))).toBe(false);
      expect(pub.canPublish(s({ source: { issue: 7, replace: "due" }, state: "dropped" }))).toBe(false);
    });
    it("confirmText", () => {
      expect(pub.confirmText({ replaces: { ready: true }, willCreate: [] })).toBe("Replace the issue");
      expect(pub.confirmText({ replaces: { ready: true }, willCreate: [D2] })).toBe("Create the issues and replace the original");
      expect(pub.confirmText({ replaces: { ready: false }, willCreate: [D2] })).toBe("Create the issues");
    });
    it("doneText", () => {
      expect(pub.doneText({ created: [], replaced })).toBe("Issue #7 is replaced");
      expect(pub.doneText({ created: [{}, {}], replaced })).toBe("2 issues are on GitHub and issue #7 is replaced");
      expect(pub.doneText({ created: [{}], replaced })).toBe("1 issue is on GitHub and issue #7 is replaced");
    });
    it("doneText for a replacement that is not closed", () => {
      expect(pub.doneText({ created: [], replaced: { ...replaced, closed: "other" } })).toBe("Issue #7 is replaced; it was closed in another way");
      expect(pub.doneText({ created: [{}], replaced: { ...replaced, closed: "other" } })).toBe("1 issue is on GitHub and issue #7 is replaced; it was closed in another way");
      expect(pub.doneText({ created: [], replaced: { ...replaced, closed: "open" } })).toBe("Issue #7 is not closed: check and close it by hand");
      expect(pub.doneText({ created: [{}, {}], replaced: { ...replaced, closed: "open" } })).toBe("2 issues are on GitHub and issue #7 is not closed: check and close it by hand");
    });
    it("replacesText", () => {
      expect(pub.replacesText(rep())).toBe("Issue #7 is replaced by its parts and closed as not planned. Issues that depend on it are changed to depend on the parts, and a comment on #7 names them.");
      const stays = pub.replacesText(rep({ staysOpen: true }));
      expect(stays).toBe("Issue #7 is replaced by its parts: issues that depend on it are changed to depend on the parts, and a comment on #7 names them. #7 stays open: check it and close it by hand.");
      expect(stays).not.toContain("closed as not planned");
      expect(pub.replacesText(rep({ ready: false }))).toBe("Issue #7 is replaced by its parts when every part is on GitHub. Nothing changes for it now.");
    });
    it("replaceText", () => {
      expect(pub.replaceText({ issue: 7, replace: "waiting" })).toBe("Issue #7 is replaced by its parts when every part is on GitHub.");
      expect(pub.replaceText({ issue: 7, replace: "due" })).toBe("Issue #7 is not replaced yet. Publish again to finish.");
      expect(pub.replaceText({ issue: 7, replace: "done", replacedBy: [101, 102], closed: "open" })).toBe("Issue #7 was replaced by #101, #102. It is still open: check it and close it by hand.");
      expect(pub.replaceText({ issue: 7, replace: "done", replacedBy: [101, 102], closed: "not_planned" })).toBe("Issue #7 was replaced by #101, #102.");
      expect(pub.replaceText({ issue: 7, replace: "done", replacedBy: [101, 102], closed: "other" })).toBe("Issue #7 was replaced by #101, #102. It was closed on GitHub in another way and is left so.");
      expect(pub.replaceText({ issue: 7, replace: "done", replacedBy: [101, 102] })).toBe("Issue #7 was replaced by #101, #102. It is still open: check it and close it by hand.");
      expect(pub.replaceText({ issue: 7 })).toBe("");
      expect(pub.replaceText(undefined)).toBe("");
    });
    it("replacesNode", async () => {
      const { h } = await import("../ui/dom.js" as string);
      const text = (r: any) => h("div", {}, pub.replacesNode(r)) as FakeElement;
      const cut = "This repository has more than 1,000 open issues and pull requests. Some issues that depend on #7 may be missing.";
      expect(text(rep({ cut: true })).textContent).toContain(cut);
      expect(text(rep()).textContent).not.toContain("1,000");
      const el = text(rep({ dependants: [{ issue: 20, title: "Twenty", before: "- #7", after: "- #101\n- #102" }, { issue: 21, title: "Other", byHand: true }] }));
      expect(el.textContent).toContain("Issues that depend on #7");
      const lis = walk(el).filter((e) => e.tag === "li");
      expect(lis).toHaveLength(2);
      expect(lis[0]!.textContent).toContain("#20 Twenty");
      expect(walk(lis[0]!).filter((e) => e.tag === "pre").map((e) => e.textContent)).toEqual(["- #7", "- #101\n- #102"]);
      expect(lis[1]!.textContent).toContain("Change by hand: it names the issue by its title.");
      expect(walk(lis[1]!).some((e) => e.tag === "pre")).toBe(false);
      const none = text(rep());
      expect(none.textContent).not.toContain("Issues that depend on #7");
      expect(walk(none).some((e) => e.tag === "ul")).toBe(false);
    });
  });

  it("a ready replacement that creates: dialog, button, request and toast", async () => {
    createPlan(rep({ parts: [{ item: 1, title: "Two" }, { item: 2, title: "Three" }], dependants: [{ issue: 20, title: "Twenty", before: "B", after: "A" }] }));
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [{}, {}], replaced, state: "published" } });
    await openPlan();
    expect(dialog()!.textContent).toContain(pub.replacesText(rep()));
    expect(dialog()!.textContent).toContain("Issues that depend on #7");
    expect(dialog()!.textContent).not.toContain("is not changed");
    expect(button("Create the issues", dialog())).toBeUndefined();
    await press(button("Create the issues and replace the original", dialog()));
    expect(posts()[0]!.body.drafts.map((x: any) => x.draft)).toEqual([D2, D3]);
    expect(toast()).toBe("2 issues are on GitHub and issue #7 is replaced");
  });
  it("a replacement that is not ready says so and keeps the plain button", async () => {
    createPlan(rep({ ready: false }));
    plan.willCreate = [D2];
    await openPlan();
    expect(dialog()!.textContent).toContain(pub.replacesText(rep({ ready: false })));
    expect(button("Create the issues", dialog())).toBeDefined();
  });
  it("the dialog warns when the list is cut", async () => {
    createPlan(rep({ cut: true }));
    await openPlan();
    expect(dialog()!.textContent).toContain("Some issues that depend on #7 may be missing.");
  });
  it("shows a dependant title and texts as text, never as HTML", async () => {
    createPlan(rep({ dependants: [{ issue: 20, title: XSS, before: XSS, after: XSS }] }));
    await openPlan();
    expect(dialog()!.textContent).toContain(XSS);
    expect(walk(dialog()!).some((e) => e.tag === "img")).toBe(false);
  });
  it("offers Publish in a published session while the replacement is due, and replaces with an empty list", async () => {
    dueSession();
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [], replaced, state: "published" } });
    await show();
    expect(publishButton()).toBeDefined();
    expect(publishBox().textContent).toContain("Issue #7 is not replaced yet. Publish again to finish.");
    expect(publishBox().textContent).not.toContain(pub.NO_READY_YET);
    await press(publishButton());
    expect(dialog()!.textContent).not.toContain(pub.NOTHING_READY);
    await press(button("Replace the issue", dialog()));
    expect(posts()[0]!.body).toEqual({ drafts: [] });
    expect(toast()).toBe("Issue #7 is replaced");
  });
  it("says the architect is busy while the replacement is due", async () => {
    dueSession();
    over.architect = { state: "running" };
    await show();
    expect(publishButton()).toBeUndefined();
    expect(publishBox().textContent).toContain(pub.ARCHITECT_BUSY);
  });
  it("a finished replacement has no Publish button and says whether the original is open", async () => {
    dueSession();
    over = { state: "published", source: { ...source, replace: "done", replacedBy: [101, 102], closed: "open" } };
    await show();
    expect(publishButton()).toBeUndefined();
    expect(publishBox().textContent).toContain("Issue #7 was replaced by #101, #102. It is still open: check it and close it by hand.");
    expect(publishBox().textContent).toContain(pub.ALL_PUBLISHED);
    cleanup?.();
    over.source.closed = "other";
    await show();
    expect(publishBox().textContent).toContain("It was closed on GitHub in another way and is left so.");
  });
  it("the waiting line comes before the not-changed line", async () => {
    drafts = split();
    over = { source: { ...source, replace: "waiting" } };
    await show();
    expect(publishBox().textContent).toContain("Issue #7 is replaced by its parts when every part is on GitHub.");
    expect(publishBox().textContent).not.toContain("Issue #7 is not changed.");
  });
  it("redraws when a replacement field changes, without a new page", () => {
    const sec = pub.publishSection({ id: "s1", save: async (f: any) => f(), read: async () => view(), saveAll: async () => ({ ok: true }), errorText: (e: any) => String(e), current: () => true });
    const sess = (src: object) => ({ ...view(), drafts: dueDrafts(), state: "published", source: { ...source, ...src } });
    sec.update(sess({ replace: "due" }));
    expect(sec.node.textContent).toContain("is not replaced yet");
    sec.update(sess({ replace: "done", replacedBy: [101], closed: "open" }));
    expect(sec.node.textContent).toContain("was replaced by #101. It is still open");
    sec.update(sess({ replace: "done", replacedBy: [101, 102], closed: "open" }));
    expect(sec.node.textContent).toContain("was replaced by #101, #102.");
    sec.update(sess({ replace: "done", replacedBy: [101, 102], closed: "other" }));
    expect(sec.node.textContent).toContain("It was closed on GitHub in another way and is left so.");
  });
  it("a replacement that fails after every part is on GitHub can be retried", async () => {
    createPlan(rep());
    postAnswer = () => {
      drafts = dueDrafts();
      over = { state: "published", source: { ...source, replace: "due" } };
      return { status: 502, body: { error: "GitHub did not change the issue: boom." } };
    };
    await openPlan();
    await press(button("Create the issues and replace the original", dialog()));
    expect(publishBox().textContent).toContain("boom");
    expect(publishBox().textContent).toContain("Issue #7 is not replaced yet. Publish again to finish.");
    expect(toast()).toBe("");
    expect(publishButton()).toBeDefined();
    expect(publishButton()!.disabled).toBeFalsy();
    plan = duePlan();
    postAnswer = () => {
      over = { state: "published", source: { ...source, replace: "done", replacedBy: [101, 102], closed: "open" } };
      return { status: 200, body: { repo: "acme/app", created: [], replaced, state: "published" } };
    };
    await press(publishButton());
    await press(button("Replace the issue", dialog()));
    expect(posts()[1]!.body).toEqual({ drafts: [] });
    expect(toast()).toBe("Issue #7 is replaced");
    expect(publishBox().textContent).toContain("Issue #7 was replaced by #101, #102. It is still open");
    expect(publishButton()).toBeUndefined();
  });
});
