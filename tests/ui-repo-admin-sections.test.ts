import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READY } from "../src/refinement/ready-list.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let view: any;
let sections: any;
let admin: any;
beforeAll(async () => {
  restore = installFakeDom();
  view = await import("../ui/repo-view.js" as string);
  sections = await import("../ui/repo-admin-sections.js" as string);
  admin = await import("../ui/admin-repos.js" as string);
});
afterAll(() => restore());

type Answer = { status: number; error: string };
let all: any[]; // what GET /api/admin/repos answers
let watchers: any[] | "fail";
let adminFails: Answer[]; // the next GETs of /api/admin/repos fail with these
let sent: { method: string; url: string; body: any }[];
let gets: string[];
let answers: Answer[]; // the next non-GET calls fail with these
let authAnswer: any;
const realFetch = globalThis.fetch;
const ME = "me";
let n = 1;
const S = { testCommand: "npm test", docs: ["a.md"], protectedBranches: ["release/*"], mainBranch: "main", developBranch: "develop" };
const readyOf = (items = DEFAULT_READY.map(({ id, text }) => ({ id, text })), isDefault = true) => ({ items, isDefault });
const rec = (over: object = {}) => ({
  id: `r${n++}`, owner: ME, url: "https://github.com/o/a", method: "github-token", added: "2026-03-04T10:00:00.000Z", settings: { ...S }, ready: readyOf(),
  account: { name: "Me", email: "me@example.com", role: "admin", status: "active" }, connection: { at: new Date().toISOString(), ok: true, checks: [] }, ...over,
});
const watcher = (over: object = {}) => ({
  id: "w", repoId: "", source: "issues", enabled: true, github_repo: "o/a", flow: "issue-gitflow", label: "go", every: "5m", max_per_tick: 1, state: { name: "running" }, ...over,
});

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
const rowOf = (url: string) => all.find((r) => url.includes(`/${r.id}`));

beforeEach(() => {
  all = [];
  watchers = [];
  adminFails = [];
  sent = [];
  gets = [];
  answers = [];
  authAnswer = undefined;
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets.push(url);
      if (url === "/api/repos/methods") return reply({ methods: ["github-token", "ssh-deploy-key", "none"], githubApp: { available: false } });
      if (url.startsWith("/api/runs")) return reply([]);
      if (url === "/api/watchers") return watchers === "fail" ? reply({ error: "x" }, 500) : reply(watchers);
      if (url === "/api/flows") return reply([{ name: "issue-gitflow" }]);
      if (url === "/api/repos") return reply(all.filter((r) => r.owner === ME).map(({ settings: _s, ready: _r, account: _a, ...pub }) => pub));
      if (url === "/api/admin/repos") {
        const failed = adminFails.shift();
        return failed ? reply({ error: failed.error }, failed.status) : reply(JSON.parse(JSON.stringify(all)));
      }
      return reply({});
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    const answer = answers.shift();
    if (answer) return reply({ error: answer.error }, answer.status);
    const r = rowOf(url);
    if (init.method === "PUT" && url.endsWith("/settings")) {
      r.settings = body;
      return reply(JSON.parse(JSON.stringify(r)));
    }
    if (init.method === "PUT" && url.endsWith("/ready")) {
      r.ready = readyOf(body.items.map((i: any, k: number) => ({ id: i.id ?? `c-${k}`, text: i.text })), false);
      return reply(JSON.parse(JSON.stringify(r)));
    }
    if (init.method === "POST" && url.endsWith("/transfer")) {
      r.owner = "other";
      r.account = { name: "Bob", email: body.email, role: "user", status: "active" };
      return reply(JSON.parse(JSON.stringify(r)));
    }
    if (init.method === "PUT" && url.endsWith("/auth")) return reply(authAnswer);
    if (init.method === "PUT" && url.includes("/watchers/") && Array.isArray(watchers)) {
      watchers = watchers.map((w) => (url.endsWith(`/watchers/${w.id}`) ? { ...w, ...body } : w));
      return reply({});
    }
    if (init.method === "DELETE" && url.includes("/watchers/") && Array.isArray(watchers)) {
      watchers = watchers.filter((w) => !url.endsWith(`/watchers/${w.id}`));
      return reply({});
    }
    return reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const byClass = (el: FakeElement, cls: string) => walk(el).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const buttons = (el: FakeElement = main()) => walk(el).filter((e) => e.tag === "button");
const button = (el: FakeElement, text: string) => buttons(el).find((e) => e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const section = (id: string) => walk(main()).find((e) => e.attrs.id === `repo-section-${id}`)!;
const ids = () => walk(main()).filter((e) => e.tag === "section" && (e.attrs.id ?? "").startsWith("repo-section-")).map((e) => e.attrs.id!.replace("repo-section-", ""));
const action = (name: string) => walk(main()).find((e) => e.tag === "button" && e.attrs["data-action"] === name);
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const errText = (el: FakeElement) => byClass(el, "status").filter((e) => (e.attrs.class ?? "").split(" ").includes("bad")).map((e) => e.textContent).join("");

const show = async (r: any, opts: object = {}) => {
  if (!all.includes(r)) all = [r];
  const navs: string[] = [];
  const off = await view.renderRepo(main(), {
    id: r.id, admin: true, nav: (h: string) => navs.push(h), sections: sections.adminSections(view.SECTIONS), source: sections.adminSource(ME), attention: admin.allAttention, ...opts,
  });
  return { navs, off };
};

describe("the admin view", () => {
  it("draws the sections in order, with Transfer inside the danger section", async () => {
    await show(rec());
    expect(ids()).toEqual(["overview", "connection", "branches", "run-settings", "watchers", "danger"]);
    expect(button(section("danger"), "Transfer")).toBeDefined();
    expect(button(section("danger"), "Remove")).toBeDefined();
    expect(section("branches").textContent).toContain("develop");
    expect(section("branches").textContent).toContain("release/*");
    expect(section("run-settings").textContent).toContain("npm test");
    expect(section("run-settings").textContent).toContain("(default)");
  });

  it("is plain for a user: no admin sections and no admin or watcher request", async () => {
    const r = rec();
    all = [r];
    await view.renderRepo(main(), { id: r.id, nav: () => {} });
    expect(ids()).toEqual(["overview", "connection", "danger"]);
    expect(gets.filter((u) => u.startsWith("/api/admin/") || u.startsWith("/api/watchers") || u.startsWith("/api/flows"))).toEqual([]);
  });

  it("shows NO_REPO for an unknown id", async () => {
    all = [rec()];
    await view.renderRepo(main(), { id: "nope", admin: true, sections: sections.adminSections(view.SECTIONS), source: sections.adminSource(ME), attention: admin.allAttention });
    expect(main().textContent).toContain(view.NO_REPO);
  });

  it("an admin's own repository keeps Remove and the back link to My repositories", async () => {
    await show(rec());
    expect(walk(main()).find((e) => e.tag === "a" && e.textContent === "My repositories")!.attrs.href).toBe("#/repos");
    expect(button(section("connection"), "Change authentication")).toBeDefined();
    expect(button(section("danger"), "Remove")).toBeDefined();
  });

  it("disables every action button while one action runs", async () => {
    await show(rec());
    press(action("branches")); // its dialog stays open, so the action is pending
    await flush();
    const marked = buttons().filter((b) => b.attrs["data-action"]);
    expect(marked.length).toBeGreaterThan(3);
    for (const b of marked) expect(b.disabled, b.attrs["data-action"]).toBe(true);
    (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
    await settle();
    for (const b of buttons().filter((x) => x.attrs["data-action"])) expect(b.disabled, b.attrs["data-action"]).toBeFalsy();
  });
});

describe("a foreign repository", () => {
  it("offers Test connection, but no Change authentication, Remove or Generate a new key", async () => {
    const r = rec({ owner: "other", method: "ssh-deploy-key", publicKey: "ssh-ed25519 AAAA", account: { name: "Bob", email: "bob@example.com", role: "user", status: "active" } });
    await show(r);
    expect(button(main(), "Change authentication")).toBeUndefined();
    expect(button(main(), "Remove")).toBeUndefined();
    expect(button(main(), "Generate a new key")).toBeUndefined();
    expect(section("danger").textContent).toContain("Only the owner can remove this repository or generate a new key.");
    expect(button(main(), "Test connection")).toBeDefined();
    expect(walk(main()).find((e) => e.tag === "a" && e.textContent === "Repositories")!.attrs.href).toBe("#/all-repos");
    expect(button(section("danger"), "Transfer")).toBeDefined();
  });

  it("names the owner's sign-in state instead of a button when the owner must sign in", async () => {
    await show(rec({ owner: "other", method: "none", account: { name: "Bob", email: "bob@example.com", role: "user", status: "active" } }));
    expect(section("overview").textContent).toContain("Needs authentication");
    expect(walk(section("overview")).filter((e) => e.tag === "button" && e.textContent === "Change authentication")).toHaveLength(0);
  });
});

describe("the next action", () => {
  it("names the problem for an app-list or watcher state, and 'Nothing to do' only when all is well", async () => {
    await show(rec({ offAppList: true }));
    expect(section("overview").textContent).not.toContain("Nothing to do");
    expect(section("overview").textContent).toContain("The owner may not use the GitHub App for this repository.");
    await show(rec({ watcherProblem: "The flow is gone." }));
    expect(section("overview").textContent).not.toContain("Nothing to do");
    expect(section("overview").textContent).toContain("The flow is gone.");
    await show(rec());
    expect(section("overview").textContent).toContain("Nothing to do");
  });
});

describe("Branches and Run settings", () => {
  it("saves the branches with the whole settings object, toasts, and shows the new values", async () => {
    const r = rec();
    await show(r);
    press(action("branches"));
    await flush();
    expect(root().textContent).toContain("Branches");
    expect(field(root(), "testCommand")).toBeUndefined();
    field(root(), "mainBranch")!.value = "trunk";
    press(button(root(), "Save"));
    await settle();
    const put = sent.find((s) => s.method === "PUT")!;
    expect(put.url).toBe(`/api/admin/repos/${r.id}/settings`);
    expect(put.body).toEqual({ ...S, mainBranch: "trunk" });
    expect(toastText()).toBe("Settings saved");
    expect(section("branches").textContent).toContain("trunk");
  });

  it("Run settings saves the test command and docs and keeps the branches", async () => {
    const r = rec();
    await show(r);
    press(action("run-settings"));
    await flush();
    expect(field(root(), "mainBranch")).toBeUndefined();
    field(root(), "testCommand")!.value = "make test";
    field(root(), "docs")!.value = "x.md\ny.md";
    press(button(root(), "Save"));
    await settle();
    expect(sent.find((s) => s.method === "PUT")!.body).toEqual({ ...S, testCommand: "make test", docs: ["x.md", "y.md"] });
    expect(section("run-settings").textContent).toContain("make test");
  });

  it("[R1] after a saved Branches edit with a failed reload, Run settings still sends the new branches", async () => {
    const r = rec();
    await show(r);
    press(action("branches"));
    await flush();
    field(root(), "mainBranch")!.value = "trunk";
    // the pre-read at Save is the next list request and works; the reload after the save is the one after it and fails
    const real = (globalThis as any).fetch;
    const before = gets.filter((u) => u === "/api/admin/repos").length;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (init.method === "GET" && url === "/api/admin/repos" && gets.filter((u) => u === url).length === before + 1) {
        gets.push(url);
        return reply({ error: "down" }, 500);
      }
      return real(url, init);
    };
    press(button(root(), "Save"));
    await settle();
    (globalThis as any).fetch = real;
    expect(toastText()).toBe("Settings saved");
    expect(section("branches").textContent).toContain("trunk");
    expect(byClass(main(), "stale-note")).toHaveLength(1);
    press(action("run-settings"));
    await flush();
    field(root(), "testCommand")!.value = "make test";
    press(button(root(), "Save"));
    await settle();
    const puts = sent.filter((s) => s.method === "PUT");
    expect(puts[1]!.body).toEqual({ ...S, mainBranch: "trunk", testCommand: "make test" });
  });

  it("[R1] reads the settings at Save time, so a change made elsewhere is not undone", async () => {
    const r = rec();
    await show(r);
    press(action("run-settings"));
    await flush();
    r.settings = { ...S, mainBranch: "elsewhere" }; // another admin saved Branches meanwhile
    field(root(), "testCommand")!.value = "make test";
    press(button(root(), "Save"));
    await settle();
    expect(sent.find((s) => s.method === "PUT")!.body).toEqual({ ...S, mainBranch: "elsewhere", testCommand: "make test" });
  });

  it("[R1] shows the error in the dialog and sends nothing when the pre-read fails", async () => {
    await show(rec());
    press(action("run-settings"));
    await flush();
    adminFails.push({ status: 500, error: "the store is broken" });
    press(button(root(), "Save"));
    await settle();
    expect(errText(root())).toContain("the store is broken");
    expect(sent.filter((s) => s.method === "PUT")).toEqual([]);
  });

  it("says the settings could not be loaded, and offers no Edit, when the record lacks them", async () => {
    const r = rec();
    delete (r as any).settings;
    delete (r as any).ready;
    await show(r);
    expect(section("branches").textContent).toContain("The settings could not be loaded.");
    expect(section("run-settings").textContent).toContain("The settings could not be loaded.");
    expect(section("run-settings").textContent).toContain("The Definition of Ready could not be loaded.");
    expect(action("branches")).toBeUndefined();
    expect(action("run-settings")).toBeUndefined();
    expect(action("ready-edit")).toBeUndefined();
  });
});

describe("Definition of Ready", () => {
  it("lists the items, and Back to the default saves the default list", async () => {
    const r = rec({ ready: readyOf([{ id: "c-1", text: "custom item" }], false) });
    await show(r);
    expect(section("run-settings").textContent).toContain("custom item");
    expect(section("run-settings").textContent).not.toContain("(default)");
    press(action("ready-edit"));
    await flush();
    press(button(root(), "Back to the default"));
    press(button(root(), "Save"));
    await settle();
    const put = sent.find((s) => s.method === "PUT")!;
    expect(put.url).toBe(`/api/admin/repos/${r.id}/ready`);
    expect(put.body.items.map((i: any) => i.id)).toEqual(DEFAULT_READY.map((d) => d.id));
    expect(toastText()).toBe("Definition of Ready saved");
  });
});

describe("Generate a new key", () => {
  it("[R2] keeps the admin fields when the answer is the public record and the reload fails", async () => {
    const r = rec({ method: "ssh-deploy-key", url: "git@github.com:o/a.git", publicKey: "ssh-ed25519 OLD" });
    await show(r);
    // the answer of PUT /auth is the public record only: no settings, ready or account
    authAnswer = { id: r.id, url: r.url, method: r.method, publicKey: "ssh-ed25519 NEWKEY", added: r.added };
    press(button(section("danger"), "Generate a new key"));
    await flush();
    adminFails.push({ status: 500, error: "down" }); // the reload after the new key
    press(button(root(), "Generate a new key"));
    await settle();
    expect(sent.some((s) => s.method === "PUT" && s.url === `/api/repos/${r.id}/auth`)).toBe(true);
    expect(section("connection").textContent).toContain("ssh-ed25519 NEWKEY");
    expect(section("branches").textContent).toContain("develop");
    expect(section("run-settings").textContent).toContain("npm test");
    expect(action("ready-edit")).toBeDefined();
    expect(section("run-settings").textContent).not.toContain("could not be loaded");
  });
});

describe("Watchers", () => {
  it("lists only the watchers of this repository", async () => {
    const r = rec();
    watchers = [watcher({ id: "mine", repoId: r.id }), watcher({ id: "theirs", repoId: "other" })];
    await show(r);
    expect(section("watchers").textContent).toContain("mine");
    expect(section("watchers").textContent).not.toContain("theirs");
    expect(walk(section("watchers")).find((e) => e.tag === "a")!.attrs.href).toBe("#/watchers/mine");
  });

  it("says there are none yet", async () => {
    await show(rec());
    expect(section("watchers").textContent).toContain("No watchers yet.");
    expect(action("watcher-add")).toBeDefined();
  });

  it("Disable sends the change and draws again", async () => {
    const r = rec();
    watchers = [watcher({ id: "w", repoId: r.id })];
    await show(r);
    press(action("watcher-toggle-w"));
    await settle();
    expect(sent).toEqual([{ method: "PUT", url: `/api/admin/repos/${r.id}/watchers/w`, body: { enabled: false } }]);
    expect(button(section("watchers"), "Enable")).toBeDefined();
  });

  it("Delete asks first: Cancel sends nothing, Delete watcher sends the DELETE and toasts", async () => {
    const r = rec();
    watchers = [watcher({ id: "w", repoId: r.id })];
    await show(r);
    press(action("watcher-delete-w"));
    await flush();
    expect(root().textContent).toContain("Delete watcher w?");
    expect(root().textContent).toContain("The watcher stops checking. You can add it again later.");
    press(button(root(), "Cancel"));
    await settle();
    expect(sent).toEqual([]);
    press(action("watcher-delete-w"));
    await flush();
    press(button(root(), "Delete watcher"));
    await settle();
    expect(sent).toEqual([{ method: "DELETE", url: `/api/admin/repos/${r.id}/watchers/w`, body: undefined }]);
    expect(toastText()).toBe("Deleted");
    expect(section("watchers").textContent).toContain("No watchers yet.");
  });

  it("toasts the server's sentence for a failed call", async () => {
    const r = rec();
    watchers = [watcher({ id: "w", repoId: r.id })];
    await show(r);
    answers.push({ status: 409, error: "the watcher is busy" });
    press(action("watcher-toggle-w"));
    await settle();
    expect(toastText()).toBe("the watcher is busy");
  });

  it("Add opens the dialog for this repository and posts to it", async () => {
    const r = rec();
    await show(r);
    press(action("watcher-add"));
    await flush();
    expect(root().textContent).toContain("Add a watcher");
    expect(root().textContent).toContain(r.url);
    const id = walk(root()).find((e) => e.tag === "input" && e.attrs.placeholder === "my-repo")!;
    id.value = "w1";
    press(button(root(), "Save watcher"));
    await settle();
    const post = sent.find((s) => s.method === "POST")!;
    expect(post.url).toBe(`/api/admin/repos/${r.id}/watchers`);
    expect(post.body.id).toBe("w1");
  });

  it("shows the sentence and no Add when the repository has a watcher problem", async () => {
    await show(rec({ watcherProblem: "The owner is blocked." }));
    expect(section("watchers").textContent).toContain("The owner is blocked.");
    expect(action("watcher-add")).toBeUndefined();
  });

  it("shows a retry line when the watchers cannot be loaded, and the rest of the page", async () => {
    const r = rec();
    watchers = "fail";
    await show(r);
    expect(section("watchers").textContent).toContain("The watchers could not be loaded.");
    expect(section("overview").textContent).toContain(r.url);
    expect(action("watcher-add")).toBeUndefined();
    watchers = [watcher({ id: "w", repoId: r.id })];
    press(button(section("watchers"), "Retry"));
    await settle();
    expect(section("watchers").textContent).toContain("w");
    expect(section("watchers").textContent).not.toContain("could not be loaded");
  });

  it("draws no buttons in a read-only view", async () => {
    const r = rec();
    watchers = [watcher({ id: "w", repoId: r.id })];
    await show(r, { readOnly: true });
    expect(section("watchers").textContent).toContain("w");
    for (const name of ["watcher-add", "watcher-toggle-w", "watcher-delete-w", "branches", "run-settings", "ready-edit", "transfer"]) expect(action(name), name).toBeUndefined();
  });
});

describe("Transfer", () => {
  let ctx: any;
  const memStore = { getItem: () => null, setItem: () => undefined };
  afterEach(() => ctx?.stop());

  it("explains the token note, then reloads the context once and the view with the new owner", async () => {
    const context = await import("../ui/context.js" as string);
    const a = { allRepos: vi.fn(() => Promise.resolve([{ github: "o/a", owner: ME, account: null }])) };
    ctx = context.initContext("admin", { id: "a1" }, { a, go: vi.fn(), notify: vi.fn(), store: context.contextStore("a1", memStore), where: () => "#/repos/x" });
    await ctx.ready;
    const r = rec();
    await show(r);
    press(button(section("danger"), "Transfer"));
    await flush();
    expect(root().textContent).toContain("The stored token is deleted.");
    field(root(), "email")!.value = "bob@example.com";
    press(button(root(), "Transfer"));
    await settle();
    expect(sent[0]).toEqual({ method: "POST", url: `/api/admin/repos/${r.id}/transfer`, body: { email: "bob@example.com" } });
    expect(a.allRepos).toHaveBeenCalledTimes(2);
    expect(section("danger").textContent).toContain("bob@example.com");
    // now foreign: the owner-only actions are gone
    expect(section("danger").textContent).toContain("Only the owner can remove this repository or generate a new key.");
  });
});
