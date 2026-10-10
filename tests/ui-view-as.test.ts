import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let apiMod: any;
let view: any;
let start: any;
let runs: any;
let repos: any;
let refinement: any;
beforeAll(async () => {
  restore = installFakeDom();
  apiMod = await import("../ui/api.js" as string);
  view = await import("../ui/view-as.js" as string);
  start = await import("../ui/user/start.js" as string);
  runs = await import("../ui/user/runs.js" as string);
  repos = await import("../ui/repos.js" as string);
  refinement = await import("../ui/refinement.js" as string);
});
afterAll(() => restore());

const api: any = new Proxy({}, { get: (_t, k) => apiMod.api[k] });
const setViewAs = (id: string, onEnded?: () => void) => apiMod.setViewAs(id, onEnded);
const PREVIEW_TEXT = "This is a preview. Nothing can be changed here.";
const VIEW_ENDED_TEXT = "The view has ended.";
const realFetch = globalThis.fetch;
let log: { url: string; method: string; body?: any }[];
let status: (url: string, method: string) => number;
let reply: (url: string, method: string) => unknown;

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const texts = (root: FakeElement) => root.all("button").map((b) => b.textContent);
const btn = (root: FakeElement, text: string) => root.all("button").find((b) => b.textContent === text);
const div = () => document.createElement("div") as unknown as FakeElement;
const nonGets = () => log.filter((c) => c.method !== "GET");

beforeEach(() => {
  log = [];
  status = () => 200;
  reply = () => ({});
  (globalThis as any).location = { hash: "#/refinement", reload: vi.fn() };
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    log.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const s = status(url, init.method);
    return { ok: s < 400, status: s, statusText: "x", json: async () => reply(url, init.method) };
  };
});
afterEach(() => {
  setViewAs("");
  globalThis.fetch = realFetch;
  delete (globalThis as any).sessionStorage;
  delete (globalThis as any).EventSource;
});

describe("api in a view", () => {
  it("puts as= on every GET, with ? or &", async () => {
    setViewAs("u1");
    await api.runs();
    await api.runs("x");
    await api.refinementSession("s 1");
    expect(log.map((c) => c.url)).toEqual(["/api/runs?as=u1", "/api/runs?owner=x&as=u1", "/api/refinement/s%201?as=u1"]);
  });

  it("encodes the id in as=", async () => {
    setViewAs("a&b=c d");
    await api.runs();
    expect(log[0]!.url).toBe("/api/runs?as=a%26b%3Dc%20d");
  });

  it("refuses a changing call before fetch", async () => {
    setViewAs("u1");
    await expect(api.startRun({})).rejects.toThrow(PREVIEW_TEXT);
    await expect(api.removeRepo("r")).rejects.toThrow(PREVIEW_TEXT);
    await expect(api.saveDraft("s", "d", {})).rejects.toThrow(PREVIEW_TEXT);
    await expect(api.signIn("a@b.c", "x")).rejects.toThrow(PREVIEW_TEXT);
    await expect(api.changePassword("a", "b")).rejects.toThrow(PREVIEW_TEXT);
    expect(log).toEqual([]);
  });

  it("starts and stops the view without as=, and still signs out", async () => {
    setViewAs("u1");
    await api.startViewAs("u1");
    await api.stopViewAs();
    await api.signOut();
    expect(log).toEqual([
      { url: "/api/admin/view-as", method: "POST", body: { userId: "u1" } },
      { url: "/api/admin/view-as", method: "DELETE", body: undefined },
      { url: "/api/session", method: "DELETE", body: undefined },
    ]);
  });

  it("puts as= on the event stream", () => {
    const urls: string[] = [];
    (globalThis as any).EventSource = class { constructor(u: string) { urls.push(u); } };
    setViewAs("u1");
    api.events("r1");
    expect(urls).toEqual(["/api/runs/r1/events?as=u1"]);
  });

  it("appends nothing and sends a POST without a view", async () => {
    await api.runs();
    await api.startRun({});
    expect(log.map((c) => [c.method, c.url])).toEqual([["GET", "/api/runs"], ["POST", "/api/runs"]]);
  });

  it("calls the hook once on a 403 and then refuses before fetch, also for the event stream", async () => {
    const ended = vi.fn();
    setViewAs("u1", ended);
    status = () => 403;
    await expect(api.runs()).rejects.toMatchObject({ status: 403 });
    expect(ended).toHaveBeenCalledTimes(1);
    log.length = 0;
    await expect(api.runs()).rejects.toThrow(VIEW_ENDED_TEXT);
    expect(log).toEqual([]);
    expect(ended).toHaveBeenCalledTimes(1);
    const made = vi.fn();
    (globalThis as any).EventSource = class { constructor() { made(); } };
    expect(() => api.events("r1")).toThrow(VIEW_ENDED_TEXT);
    expect(made).not.toHaveBeenCalled();
    await expect(api.startViewAs("u1")).rejects.toMatchObject({ status: 403 });
    expect(log).toHaveLength(1);
  });

  it("does not call the hook for a 404 or without a view", async () => {
    const ended = vi.fn();
    setViewAs("u1", ended);
    status = () => 404;
    await expect(api.runs()).rejects.toMatchObject({ status: 404 });
    setViewAs("");
    status = () => 403;
    await expect(api.runs()).rejects.toMatchObject({ status: 403 });
    expect(ended).not.toHaveBeenCalled();
  });
});

describe("the bar", () => {
  const store = (value?: string) => ({ getItem: () => value ?? null, setItem: vi.fn() });

  it("names the user, shows itself and leaves", async () => {
    const box = div();
    box.hidden = true;
    const go = vi.fn();
    view.viewBar(box, "u1", { store: store(JSON.stringify({ id: "u1", name: "Ann" })), go });
    expect(box.textContent).toContain("You are viewing as Ann. Nothing can be changed here.");
    expect(box.hidden).toBe(false);
    btn(box, "Back to the admin display")!.click();
    await flush();
    expect(log).toEqual([{ url: "/api/admin/view-as", method: "DELETE", body: undefined }]);
    expect(go).toHaveBeenCalledWith("/#/users");
  });

  it("says 'this user' for another id or a throwing store", () => {
    const a = div();
    view.viewBar(a, "u1", { store: store(JSON.stringify({ id: "u2", name: "Bob" })) });
    expect(a.textContent).toContain("You are viewing as this user.");
    const b = div();
    view.viewBar(b, "u1", { store: { getItem: () => { throw new Error("no"); } } });
    expect(b.textContent).toContain("this user");
  });

  it("goes back also when the stop call fails", async () => {
    status = () => 500;
    const go = vi.fn();
    await view.leaveView({ go });
    expect(go).toHaveBeenCalledWith("/#/users");
  });
});

describe("the ended card", () => {
  it("has both buttons; View again starts a new view, keeps the name and reloads", async () => {
    const stash = new Map<string, string>();
    (globalThis as any).sessionStorage = { getItem: (k: string) => stash.get(k) ?? null, setItem: (k: string, v: string) => void stash.set(k, v) };
    reply = () => ({ id: "u1", name: "Ann" });
    const main = div();
    const reload = vi.fn();
    view.viewEndedCard(main, "u1", { reload, go: vi.fn() });
    expect(texts(main)).toEqual(["View again", "Back to the admin display"]);
    btn(main, "View again")!.click();
    await flush();
    expect(log).toEqual([{ url: "/api/admin/view-as", method: "POST", body: { userId: "u1" } }]);
    expect(view.viewName("u1")).toBe("Ann");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal and does not reload", async () => {
    status = () => 404;
    reply = () => ({ error: "no such account" });
    const main = div();
    const reload = vi.fn();
    view.viewEndedCard(main, "u1", { reload });
    btn(main, "View again")!.click();
    await flush();
    expect(find(main, "p", { class: "status bad" })[0]!.textContent).toBe("no such account");
    expect(reload).not.toHaveBeenCalled();
  });

  it("Back goes to the Users page", async () => {
    const main = div();
    const go = vi.fn();
    view.viewEndedCard(main, "u1", { go });
    btn(main, "Back to the admin display")!.click();
    await flush();
    expect(go).toHaveBeenCalledWith("/#/users");
  });
});

describe("beginView", () => {
  const admin = { id: "a1", role: "admin" };
  const named = { getItem: () => JSON.stringify({ id: "u1", name: "Ann" }), setItem() {} };
  const setup = (me: any, as: string, store: any = named) => {
    const box = div();
    const main = div();
    const body = document.createElement("body") as unknown as FakeElement;
    const onEnded = vi.fn();
    const r = view.beginView(as, me, { box, main, body, onEnded, store, go: vi.fn(), reload: vi.fn() });
    return { r, box, main, body, onEnded };
  };

  it("ignores as for a user and without as", () => {
    for (const [me, as] of [[{ id: "u9", role: "user" }, "u1"], [admin, ""]] as const) {
      const { r, box, body } = setup(me, as);
      expect(r).toEqual({ readOnly: false, ready: true });
      expect(box.textContent).toBe("");
      expect(body.classList.contains("view-as")).toBe(false);
    }
  });

  it("turns the preview on before any request, with the bar and the body class", () => {
    const { r, box, body } = setup(admin, "u1");
    expect(r).toEqual({ readOnly: true, ready: true });
    expect(box.textContent).toContain("You are viewing as Ann.");
    expect(body.classList.contains("view-as")).toBe(true);
    expect(log).toEqual([]);
  });

  it("draws an unnamed preview with 'this user' and does not treat it as ended", () => {
    const { r, box, main } = setup(admin, "u1", { getItem: () => null, setItem() {} });
    expect(r).toEqual({ readOnly: true, ready: true });
    expect(box.textContent).toContain("You are viewing as this user. Nothing can be changed here.");
    expect(main.textContent).toBe("");
    expect(log).toEqual([]);
  });

  it("on a 403 replaces the bar and the page with the ended card, with no unscoped request", async () => {
    const { box, main, onEnded } = setup(admin, "u1");
    status = () => 403;
    await expect(api.runs()).rejects.toMatchObject({ status: 403 });
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(box.hidden).toBe(true);
    expect(box.textContent).toBe("");
    expect(main.textContent).toContain("The view has ended");
    expect(main.textContent).not.toContain("You are viewing as");
    expect(texts(main)).toEqual(["View again", "Back to the admin display"]);
    expect(log.every((c) => c.url.endsWith("as=u1"))).toBe(true);
  });
});

describe("renderers with readOnly", () => {
  const flowWith = (fields: object[] = []) => ({ name: "build", title: "Build", description: "", version: 1, usesTask: true, fields });
  const repoField = { name: "github_repo", mode: "input", label: "Repo", value: "", required: true };

  it("Start work: no Start, no Add repository, and submit sends nothing", async () => {
    const a = { flows: async () => [flowWith([repoField])], repos: async () => [], repoMethods: async () => ({}), startRun: vi.fn() };
    const main = div();
    await start.renderStart(main, { a, readOnly: true });
    expect(texts(main)).toEqual([]);
    find(main, "form")[0]!.fire("submit", { preventDefault() {} });
    await flush();
    expect(a.startRun).not.toHaveBeenCalled();
    // control
    const again = div();
    await start.renderStart(again, { a });
    expect(texts(again)).toEqual(["Add repository", "Start"]);
  });

  it("My runs: no Remove for a queued run", async () => {
    const a = { runs: async () => [], queue: async () => ({ pending: [{ runId: "q1", flow: "build", task: "t", enqueuedAt: new Date().toISOString(), ahead: 1 }], active: [] }), cancelRun: vi.fn() };
    const on = div();
    const stopOn = await runs.renderMyRuns(on, { a, readOnly: true });
    expect(texts(on)).toEqual([]);
    stopOn();
    const off = div();
    const stopOff = await runs.renderMyRuns(off, { a });
    expect(texts(off)).toEqual(["Remove"]);
    stopOff();
  });

  describe("the run page", () => {
    const stream = () => ({ listeners: {} as any, addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); }, close: vi.fn(), readyState: 1, onerror: null as any });
    const make = (summary: any, readOnly: boolean) => {
      const es = stream();
      const a = {
        run: vi.fn(async () => summary),
        queue: vi.fn(async () => ({ pending: [], active: [] })),
        events: vi.fn(() => es),
        diff: vi.fn(async () => ({})),
        approveRun: vi.fn(), rejectRun: vi.fn(), resumeRun: vi.fn(), cancelRun: vi.fn(), answerRun: vi.fn(),
      };
      const main = div();
      const cleanup = runs.renderMyRun(main, "r1", { a, readOnly }) as () => void;
      return { a, es, main, cleanup };
    };
    const base = { runId: "r1", flow: "build", task: "t", startedAt: new Date().toISOString(), vars: {}, history: [], next: { who: "You", text: "x", kind: "approve" } };

    it("has no Approve, Reject, Cancel or answer form for a waiting run", async () => {
      const waiting = { ...base, status: "waiting", questions: "Q?", canAnswer: true };
      const on = make(waiting, true);
      await flush();
      expect(texts(on.main).filter((t) => ["Approve", "Reject", "Cancel"].includes(t))).toEqual([]);
      // the answer form is built once but stays hidden, so Send answer is never shown
      expect(find(on.main, "form", { class: "run-answer" })[0]!.hidden).toBe(true);
      on.cleanup();
      const off = make(waiting, false);
      await flush();
      expect(texts(off.main)).toEqual(expect.arrayContaining(["Approve", "Reject", "Cancel"]));
      off.cleanup();
    });

    it("has no Retry for a failed run", async () => {
      const on = make({ ...base, status: "failed" }, true);
      await flush();
      expect(texts(on.main)).not.toContain("Retry");
      expect(texts(on.main)).not.toContain("Retry from the failing step");
      on.cleanup();
    });

    it("asks again when the stream closes", async () => {
      const on = make({ ...base, status: "running" }, true);
      await flush();
      const before = on.a.run.mock.calls.length;
      on.es.readyState = 2;
      on.es.onerror();
      await flush();
      expect(on.a.run.mock.calls.length).toBe(before + 1);
      on.cleanup();
    });
  });

  it("My repositories: no Add, Test, Change, Generate or Remove", async () => {
    const list = [{ id: "r1", url: "git@github.com:o/r.git", method: "ssh-deploy-key", publicKey: "ssh-ed25519 AAAA", github: "o/r" }];
    reply = (url) => (url.startsWith("/api/repos/methods") ? {} : list);
    (globalThis as any).location = { hash: "#/repos" };
    setViewAs("u1");
    const main = div();
    await repos.renderRepos(main, { admin: false, readOnly: true });
    expect(texts(main)).toEqual(["Copy"]);
    expect(nonGets()).toEqual([]);
    reply = (url) => (url.startsWith("/api/repos/methods") ? {} : []);
    const empty = div();
    await repos.renderRepos(empty, { admin: false, readOnly: true });
    expect(texts(empty)).toEqual([]);
    setViewAs("");
    reply = (url) => (url.startsWith("/api/repos/methods") ? {} : list);
    const off = div();
    await repos.renderRepos(off, { admin: false });
    expect(texts(off)).toEqual(expect.arrayContaining(["+ Add repository", "Test connection", "Remove"]));
  });

  describe("Refinement", () => {
    const session = (over: object = {}) => ({
      id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "Idea", state: "exploring", drafts: [], log: [],
      created: new Date().toISOString(), updated: new Date().toISOString(), mine: true, ...over,
    });

    it("the list has no New session and no Restore", async () => {
      const dropped = session({ id: "s2", state: "dropped", removedOn: new Date(Date.now() + 864e5).toISOString() });
      reply = () => ({ sessions: [session(), dropped], repos: ["acme/app"] });
      setViewAs("u1");
      const main = div();
      await refinement.renderRefinement(main, { admin: false, readOnly: true });
      expect(texts(main)).toEqual(["Open sessions", "Dropped"]);
      btn(main, "Dropped")!.click();
      await flush();
      expect(texts(main)).toEqual(["Open sessions", "Dropped"]);
      expect(main.textContent).toContain("My idea");
      expect(nonGets()).toEqual([]);
    });

    it("a session of the viewed user has no buttons or inputs", async () => {
      reply = () => session();
      setViewAs("u1");
      const main = div();
      await refinement.renderRefinement(main, { admin: false, id: "s1", readOnly: true });
      expect(texts(main)).toEqual([]);
      expect(main.all("textarea")).toHaveLength(0);
      expect(main.all("input")).toHaveLength(0);
      expect(log.every((c) => c.method === "GET" && c.url.endsWith("as=u1"))).toBe(true);
    });
  });
});
