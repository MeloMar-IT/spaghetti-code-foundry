import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { autoDialog } from "./helpers/confirm-dialog.js";

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
const XSS = "<img src=x onerror=1>";
const SEEN1 = "a".repeat(64);
const SEEN2 = "b".repeat(64);
let drafts: any[];
let plan: any;
let sent: { method: string; url: string; body: any }[];
let postAnswer: ((body: any) => { status: number; body: any }) | undefined;
let cleanup: (() => void) | undefined;

const mk = (id: string, title: string, extra: object = {}) => ({
  id, title: { text: title }, criteria: [], dependsOn: [], state: "ready",
  preview: { title, body: "As a user, I want x, so that y." }, ...extra,
});
const view = () => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", architect: { state: "idle" }, readyList: [],
  talk: { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] },
  state: "drafting", drafts, log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }], created: "x", updated: "x", mine: true,
  source: { issue: 7, draft: D1, url: "https://github.com/acme/app/issues/7" },
});
const item = (n: number, d: any, extra: object = {}) => ({ n, draft: d.id, title: d.title.text, body: `BODY of ${d.title.text}`, state: "ready", dependsOn: [], labels: [], ...extra });
const changed = (extra: object = {}) => ({ issue: 7, github: { title: "GH title", body: "GH body" }, mine: { title: "My title", body: "My body" }, seen: SEEN1, ...extra });
const makePlan = (extra: object = {}) => ({
  repo: "acme/app", items: [item(1, mk(D1, "One"), { updates: 7 })], willCreate: [], willUpdate: [D1], repoLabels: ["bug"], changedOnGithub: changed(), ...extra,
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  drafts = [mk(D1, "One")];
  plan = makePlan();
  sent = [];
  postAnswer = undefined;
  dr.unsaved.clear();
  dr.opened.clear();
  (document as any).getElementById("toast").textContent = "";
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).activeElement = null;
  (globalThis as any).location = { hash: "#/refinement/s1", reload: vi.fn() };
  stopDialog = autoDialog(() => true);
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    if (url.endsWith("/publish")) {
      if (init.method === "GET") return reply(plan);
      const a = postAnswer ? postAnswer(body) : { status: 200, body: { repo: "acme/app", created: [], kept: { issue: 7 }, state: "drafting" } };
      return reply(a.body, a.status);
    }
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
const buttons = (root: FakeElement) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root: FakeElement = main()) => buttons(root).find((e) => e.textContent === t);
const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
const dialog = () => walk(modalRoot()).find((e) => e.attrs.role === "dialog");
const press = async (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
  await flush();
};
const openPlan = async () => {
  cleanup = await ui.renderRefinement(main(), { id: "s1" });
  await press(button("Publish", publishBox()));
};
const posts = () => sent.filter((x) => x.method === "POST" && x.url.endsWith("/publish"));
const versions = () => walk(dialog()!).find((e) => e.attrs["data-versions"] !== undefined);

describe("pure functions", () => {
  it("keepBody", () => {
    const p = makePlan();
    expect(pub.keepBody(p, {}, "github")).toEqual({ source: { keep: "github", seen: SEEN1 } });
    expect(pub.keepBody(p, { [D1]: { labels: ["bug"], startBuilding: false } }, "mine")).toEqual({
      drafts: [{ draft: D1, labels: ["bug"], startBuilding: false }],
      source: { keep: "mine", seen: SEEN1 },
    });
  });
  it("doneText for a kept GitHub version", () => {
    expect(pub.doneText({ kept: { issue: 12 }, created: [] })).toBe("Issue #12 is not changed. Your draft is not published.");
  });
});

describe("the question", () => {
  it("shows both versions side by side and the two buttons, not the usual confirm", async () => {
    await openPlan();
    const v = versions()!;
    expect(v.attrs.class).toBe("stack cols-2");
    expect(v.textContent).toContain("GH title");
    expect(v.textContent).toContain("GH body");
    expect(v.textContent).toContain("My title");
    expect(v.textContent).toContain("My body");
    expect(dialog()!.textContent).toContain(pub.changedText(changed()));
    expect(button(pub.KEEP_MINE, dialog())).toBeDefined();
    expect(button(pub.KEEP_GITHUB, dialog())).toBeDefined();
    expect(button(pub.CONFIRM_UPDATE, dialog())).toBeUndefined();
  });
  it("says that Keep GitHub's publishes none of the listed stories, with several drafts", async () => {
    drafts = [mk(D1, "One"), mk(D2, "Two")];
    plan = makePlan({ items: [item(1, drafts[0], { updates: 7 }), item(2, drafts[1])], willCreate: [D2] });
    await openPlan();
    expect(dialog()!.textContent).toContain("Keep GitHub's writes nothing and publishes none of the stories listed below");
    await press(button(pub.KEEP_GITHUB, dialog()));
    expect(posts()[0]!.body).toEqual({ source: { keep: "github", seen: SEEN1 } });
  });
  it("sets the texts as text, never as HTML", async () => {
    plan = makePlan({ changedOnGithub: changed({ github: { title: XSS, body: XSS }, mine: { title: XSS, body: XSS } }) });
    await openPlan();
    expect(versions()!.textContent).toContain(XSS);
    expect(walk(dialog()!).some((e) => e.tag === "img")).toBe(false);
  });
  it("Keep mine posts the drafts and the confirmed version", async () => {
    postAnswer = () => ({ status: 200, body: { repo: "acme/app", created: [], updated: [{ draft: D1, issue: 7, url: "u", found: false }], state: "published" } });
    await openPlan();
    await press(button(pub.KEEP_MINE, dialog()));
    expect(posts()[0]!.body).toEqual({ drafts: [{ draft: D1, labels: [], startBuilding: false }], source: { keep: "mine", seen: SEEN1 } });
    expect((document as any).getElementById("toast").textContent).toBe("Issue #7 is updated");
  });
  it("Keep GitHub's posts only the choice and says the draft is not published", async () => {
    await openPlan();
    await press(button(pub.KEEP_GITHUB, dialog()));
    expect(posts()[0]!.body).toEqual({ source: { keep: "github", seen: SEEN1 } });
    expect((document as any).getElementById("toast").textContent).toBe("Issue #7 is not changed. Your draft is not published.");
    expect(dialog()).toBeUndefined();
  });
  it("asks again with the new versions when the answer is 409 with changedOnGithub, with no failure line", async () => {
    const again = changed({ seen: SEEN2, github: { title: "GH title 2", body: "GH body 2" } });
    let n = 0;
    postAnswer = () => (n++ === 0 ? { status: 409, body: { error: "changed", changedOnGithub: again } } : { status: 200, body: { repo: "acme/app", created: [], updated: [{ draft: D1, issue: 7, url: "u", found: false }], state: "published" } });
    await openPlan();
    await press(button(pub.KEEP_MINE, dialog()));
    expect(dialog()).toBeDefined();
    expect(versions()!.textContent).toContain("GH title 2");
    expect(publishBox().textContent).not.toContain("changed");
    expect((document as any).getElementById("toast").textContent).toBe("");
    await press(button(pub.KEEP_MINE, dialog()));
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.body.source).toEqual({ keep: "mine", seen: SEEN2 });
    expect(dialog()).toBeUndefined();
  });
  it("still shows the failure line for a 409 without changedOnGithub", async () => {
    postAnswer = () => ({ status: 409, body: { error: "issue #7 is closed" } });
    await openPlan();
    await press(button(pub.KEEP_MINE, dialog()));
    expect(dialog()).toBeUndefined();
    expect(publishBox().textContent).toContain("issue #7 is closed");
  });
});

describe("api.publish", () => {
  it("rejects with the status and the body of the answer", async () => {
    (globalThis as any).fetch = async () => reply({ error: "changed", changedOnGithub: changed() }, 409);
    const e = await api.publish("s1", {}).catch((x: any) => x);
    expect(e.status).toBe(409);
    expect(e.data.changedOnGithub.seen).toBe(SEEN1);
  });
});
