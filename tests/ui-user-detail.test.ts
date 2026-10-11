import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The page of one account (#/users/:id): facts, three groups of actions, and every dialog with its call and follow-up.
let restore: () => void;
let ui: any;
let detail: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/users.js" as string);
  detail = await import("../ui/user-detail.js" as string);
});
afterAll(() => restore());

const TOKEN = "Ab3_".repeat(10) + "xyz";
const ORIGIN = "https://foundry.example";
const LINK = `${ORIGIN}/#/set-password/${TOKEN}`;
const FUTURE = new Date(Date.now() + 20 * 60_000).toISOString();
const ADMIN_ONLY = "this is the only admin that is not blocked; make another admin first";

type Answer = { status: number; error: string; after?: boolean };
let users: any[];
let usersGets: { status?: number; gate?: Promise<void> }[]; // one entry per GET /api/users, taken in order
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let limits: any;
let limitsFail: boolean;
let appRepos: string[];
let appGate: Promise<void> | undefined;
let page: any;
const realFetch = globalThis.fetch;

const user = (over: object = {}) => ({
  id: "u1", name: "Ann", email: "ann@example.com", role: "user", status: "active", created: "2026-01-01T00:00:00.000Z",
  lastSignIn: new Date().toISOString(), runs: 2, hasPassword: true, lockedUntil: null, ...over,
});

beforeEach(() => {
  users = [user({ id: "me", name: "Root", email: "root@example.com", role: "admin", runs: 0 }), user()];
  usersGets = [];
  sent = [];
  answers = [];
  limits = { defaults: {}, users: {} };
  limitsFail = false;
  appRepos = [];
  appGate = undefined;
  page = { origin: () => ORIGIN, clipboard: () => undefined, reload: vi.fn(), go: vi.fn() };
  delete (globalThis as any).location;
  document.getElementById("modal-root")!.replaceChildren();
  document.getElementById("main")!.replaceChildren();
  (document as any).listeners.keydown = [];
  document.getElementById("toast")!.textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (url === "/api/users" && init.method === "GET") {
      const g = usersGets.shift();
      if (g?.gate) await g.gate;
      if (g?.status) return reply({ error: "down" }, g.status);
      return reply(users.map((u) => ({ ...u })));
    }
    if (url.endsWith("/limits") && init.method === "GET") return limitsFail ? reply({ error: "broken" }, 500) : reply(limits);
    if (url.endsWith("/app-repos") && init.method === "GET") {
      const a = answers.shift();
      if (appGate) await appGate;
      return a ? reply({ error: a.error }, a.status) : reply({ repos: appRepos });
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    const answer = answers.shift();
    const id = url.split("/")[3] ?? "";
    const target = users.find((u) => u.id === id);
    const apply = () => {
      if (url.endsWith("/limits")) {
        const into = (limits.users[id] ??= {});
        for (const [k, v] of Object.entries(body)) {
          if (v === null) delete into[k];
          else into[k] = v;
        }
        return;
      }
      if (init.method === "PUT" && target && !url.endsWith("/app-repos")) Object.assign(target, body);
      if (url.endsWith("/block") && target) target.status = "blocked";
      if (url.endsWith("/unblock") && target) target.status = "active";
      if (url.endsWith("/unlock") && target) target.lockedUntil = null;
      if (url.endsWith("/reset") && target) target.hasPassword = false;
      if (init.method === "DELETE") users = users.filter((u) => u.id !== id);
    };
    if (answer) {
      if (answer.after) apply();
      return reply({ error: answer.error }, answer.status);
    }
    apply();
    if (url.endsWith("/app-repos")) return reply({ repos: body.repos });
    if (url.endsWith("/limits")) return reply(limits);
    if (url.endsWith("/link") || url.endsWith("/reset")) return reply({ user: target, token: TOKEN, expires: "x" });
    if (url.endsWith("/block")) return reply({ user: target, cancelled: { queued: 1, running: 1, waiting: 1 } });
    if (init.method === "DELETE") return reply({ ok: true, credentials: 0, cancelled: 1 });
    return reply({ user: target });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => document.getElementById("main") as unknown as FakeElement;
const root = () => document.getElementById("modal-root") as unknown as FakeElement;
const toastText = () => document.getElementById("toast")!.textContent as string;
const button = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text);
const field = (el: FakeElement, name: string) => el.all("input").concat(el.all("select"), el.all("textarea")).find((e) => e.attrs.name === name);
const errLine = (el: FakeElement) => el.all("p").filter((e) => (e.attrs.class ?? "").includes("bad"));
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const pressEscape = () => (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
const group = (title: string) => main().all("section").find((s) => s.all("h2")[0]?.textContent === title);
const labelsIn = (title: string) => group(title)?.all("button").map((b) => b.textContent) ?? [];
const fact = (label: string) => main().all("div").find((d) => d.all("dt")[0]?.textContent === label)?.all("dd")[0]?.textContent;
const stale = () => main().all("p").filter((p) => (p.attrs.class ?? "").includes("stale-note"));
const show = async (id = "u1", over: object = {}) => {
  const onName = vi.fn();
  await detail.renderUserDetail(main(), id, { me: "me", page, onName, ...over });
  return onName;
};
const open = async (label: string, id = "u1") => {
  await show(id);
  press(button(main(), label));
  await flush();
};

describe("groupsFor", () => {
  const cases: [string, any][] = [
    ["active user", user()],
    ["blocked user", user({ status: "blocked" })],
    ["no password", user({ hasPassword: false })],
    ["locked", user({ lockedUntil: FUTURE })],
    ["locked and blocked", user({ lockedUntil: FUTURE, status: "blocked" })],
    ["admin", user({ role: "admin" })],
  ];
  it.each(cases)("%s: the groups together are the actions, and Block, Unblock and Delete are set apart", (_n, u) => {
    const groups = detail.groupsFor(u);
    expect(groups.flatMap((g: any) => g.kinds).sort()).toEqual([...ui.actionsFor(u)].sort());
    expect(groups.map((g: any) => g.id)).toEqual(["routine", "security", "danger"]);
    const routine = groups[0].kinds;
    for (const k of ["block", "unblock", "delete", "reset", "unlock"]) expect(routine).not.toContain(k);
    expect(groups[2].kinds).toEqual(["delete"]);
  });
  it("offers View as user only for a user, and a link only without a password", () => {
    expect(detail.groupsFor(user())[0].kinds).toEqual(["edit", "limits", "app", "view"]);
    expect(detail.groupsFor(user({ role: "admin" }))[0].kinds).toEqual(["edit", "limits", "app"]);
    expect(detail.groupsFor(user({ hasPassword: false }))[0].kinds).toContain("link");
    expect(detail.groupsFor(user({ hasPassword: false }))[1].kinds).toEqual(["block"]);
  });
});

describe("the page", () => {
  it("shows the facts and the three groups with their buttons", async () => {
    limits = { defaults: { maxConcurrent: 2 }, users: { u1: { dailyBudgetUsd: 5 } } };
    const onName = await show();
    expect(onName).toHaveBeenCalledWith("Ann");
    expect(main().all("h1").map((h) => h.textContent)).toEqual(["Ann"]);
    expect(main().all("a").find((a) => a.attrs.href === "#/users")?.textContent).toBe("Users");
    expect(fact("E-mail")).toBe("ann@example.com");
    expect(fact("Role")).toBe("user");
    expect(fact("Status")).toBe("active");
    expect(fact("Last sign-in")).toBe("just now");
    expect(fact("Runs")).toBe("2");
    expect(fact("Limits")).toBe("2 at a time · $5 a day (own)");
    expect(fact("Id")).toBe("u1");
    expect(main().all("h2").map((h) => h.textContent)).toEqual(["Account", "Actions", "Security", "Danger"]);
    expect(labelsIn("Actions")).toEqual(["Edit", "Limits", "App repositories", "View as user"]);
    expect(labelsIn("Security")).toEqual(["Reset password", "Block"]);
    expect(labelsIn("Danger")).toEqual(["Delete"]);
    expect(main().all("button").filter((b) => b.textContent === "Delete")).toHaveLength(1);
    expect(group("Danger")!.attrs.class).toContain("fail");
    expect(main().textContent).not.toContain("(you)");
  });
  it("follows the status: unlock, unblock and a link", async () => {
    users.push(user({ id: "u2", name: "Cy", hasPassword: false, status: "blocked" }), user({ id: "u3", name: "Di", lockedUntil: FUTURE }));
    await show("u2");
    expect(labelsIn("Actions")).toContain("New link");
    expect(labelsIn("Security")).toEqual(["Unblock"]);
    expect(fact("Status")).toBe("blocked");
    await show("u3");
    expect(labelsIn("Security")).toEqual(["Reset password", "Unlock", "Block"]);
    expect(fact("Status")).toBe("locked");
  });
  it("marks the own account", async () => {
    await show("me");
    expect(main().textContent).toContain("(you)");
    expect(labelsIn("Actions")).not.toContain("View as user");
  });
  it("disables Limits when the limits cannot be read", async () => {
    limitsFail = true;
    await show();
    expect(fact("Limits")).toBe("not available");
    expect(button(main(), "Limits")!.attrs.disabled).toBe("");
    expect(button(main(), "Edit")!.attrs.disabled).toBeUndefined();
  });
  it("says so for an unknown account and offers the way back", async () => {
    const onName = await show("nope");
    expect(main().textContent).toContain("This account does not exist.");
    expect(detail.NO_ACCOUNT).toBe("This account does not exist.");
    expect(main().all("a").find((a) => a.attrs.href === "#/users")?.textContent).toBe("Back to Users");
    expect(main().all("button")).toHaveLength(0);
    expect(onName).not.toHaveBeenCalled();
  });
  it("draws a skeleton while the account loads, and rejects when the list fails", async () => {
    let release!: () => void;
    usersGets.push({ gate: new Promise<void>((r) => (release = r)) });
    const done = show();
    await flush();
    expect(main().textContent).toContain("Loading the account…");
    release();
    await done;
    expect(main().textContent).not.toContain("Loading the account…");
    usersGets.push({ status: 500 });
    await expect(show()).rejects.toThrow("down");
  });
});

describe("the actions use the same dialogs, calls and follow-ups", () => {
  it("Edit sends only what changed, toasts Saved and reloads", async () => {
    await open("Edit");
    expect(field(root(), "name")!.value).toBe("Ann");
    field(root(), "name")!.value = "Bea";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/users/u1", body: { name: "Bea" } }]);
    expect(toastText()).toBe("Saved");
    expect(main().all("h1")[0]!.textContent).toBe("Bea");
    expect(page.reload).not.toHaveBeenCalled();
  });
  it("Edit sends nothing when nothing changed", async () => {
    await open("Edit");
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([]);
    expect(root().children).toHaveLength(0);
  });
  it("Limits is prefilled, sends only changes and shows the result", async () => {
    limits = { defaults: { maxConcurrent: 2 }, users: { u1: { maxConcurrent: 9, dailyBudgetUsd: 5 } } };
    await open("Limits");
    expect(root().textContent).toContain("Limits of Ann");
    expect(field(root(), "maxConcurrent")!.value).toBe("9");
    field(root(), "maxConcurrent")!.value = "";
    field(root(), "maxRunsPerDay")!.value = "7";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/users/u1/limits", body: { maxConcurrent: null, maxRunsPerDay: 7 } }]);
    expect(toastText()).toBe("Saved");
    expect(fact("Limits")).toBe("2 at a time · 7 runs a day (own) · $5 a day (own)");
  });
  it("App repositories loads the list, sends the lines and toasts Saved", async () => {
    appRepos = ["acme/one", "acme/*"];
    await open("App repositories");
    expect(field(root(), "appRepos")!.value).toBe("acme/one\nacme/*");
    field(root(), "appRepos")!.value = "acme/two\n\n  acme/three  ";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/users/u1/app-repos", body: { repos: ["acme/two", "acme/three"] } }]);
    expect(toastText()).toBe("Saved");
  });
  it("App repositories toasts and opens no dialog when the list cannot be loaded", async () => {
    await show();
    answers.push({ status: 404, error: "no such account" });
    press(button(main(), "App repositories"));
    await flush();
    expect(root().children).toHaveLength(0);
    expect(toastText()).toBe("no such account");
  });
  it("App repositories of an admin tells that an admin is not limited", async () => {
    await open("App repositories", "me");
    expect(root().textContent).toContain("An admin is not limited");
  });
  it("New link shows a fresh link and tells a blocked account to be unblocked first", async () => {
    users[1] = user({ hasPassword: false, status: "blocked" });
    await open("New link");
    expect(root().textContent).toContain("only after you unblock");
    press(button(root(), "New link"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users/u1/link", body: {} }]);
    expect(field(root(), "link")!.value).toBe(LINK);
    expect(root().textContent).toContain("works once");
  });
  it("Reset password names the account, shows the link once and reloads on Done", async () => {
    await open("Reset password");
    expect(root().textContent).toContain("Ann (ann@example.com)");
    press(button(root(), "Reset password"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users/u1/reset", body: {} }]);
    expect(field(root(), "link")!.value).toBe(LINK);
    press(button(root(), "Done"));
    await flush();
    expect(fact("Status")).toBe("no password yet");
    for (const t of [main().textContent, toastText(), root().textContent]) expect(t).not.toContain(TOKEN);
  });
  it("Unlock sends the call, toasts and shows the account active", async () => {
    users[1]!.lockedUntil = FUTURE;
    await open("Unlock");
    expect(root().textContent).not.toContain("at once");
    press(button(root(), "Unlock"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users/u1/unlock", body: {} }]);
    expect(toastText()).toBe("Ann is unlocked");
    expect(fact("Status")).toBe("active");
  });
  it("Block says what happens, sends the choice and keeps the notice", async () => {
    for (const checked of [false, true]) {
      users = [user({ id: "me", name: "Root", role: "admin" }), user()];
      await open("Block");
      for (const t of ["signed out", "queued runs are cancelled", "Also stop all their work now"]) expect(root().textContent).toContain(t);
      expect(root().textContent).not.toContain("signed out at once");
      (field(root(), "stopWork") as any).checked = checked;
      press(button(root(), "Block"));
      await flush();
      expect(sent.at(-1)).toEqual({ method: "POST", url: "/api/users/u1/block", body: { stopWork: checked } });
      expect(main().textContent).toContain(ui.cancelledText("Ann", 3));
      expect(fact("Status")).toBe("blocked");
      expect(labelsIn("Security")).toEqual(["Reset password", "Unblock"]);
    }
  });
  it("Unblock toasts and shows Block again", async () => {
    users[1]!.status = "blocked";
    await open("Unblock");
    expect(root().textContent).toContain("not restarted");
    press(button(root(), "Unblock"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users/u1/unblock", body: {} }]);
    expect(toastText()).toBe("Ann is unblocked");
    expect(labelsIn("Security")).toContain("Block");
  });
  it("Delete asks first, then toasts and goes back to the list", async () => {
    await open("Delete");
    for (const t of ["Ann", "ann@example.com", "stored credentials", "wiped", "runs are kept"]) expect(root().textContent).toContain(t);
    pressEscape();
    await flush();
    expect(sent).toEqual([]);
    expect(page.go).not.toHaveBeenCalled();
    press(button(main(), "Delete"));
    await flush();
    press(button(root(), "Delete"));
    await flush();
    expect(sent).toEqual([{ method: "DELETE", url: "/api/users/u1", body: undefined }]);
    expect(toastText()).toBe("Ann was deleted");
    expect(page.go).toHaveBeenCalledWith("#/users");
  });
  it("View as user starts the view and opens the preview", async () => {
    await show();
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (init.method === "POST") {
        sent.push({ method: init.method, url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: "u1", name: "Ann" }) };
      }
      return real(url, init);
    };
    press(button(main(), "View as user"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/admin/view-as", body: { userId: "u1" } }]);
    expect(page.go).toHaveBeenCalledWith("/user/?as=u1");
  });
  it("a refusal of View as user toasts the sentence and goes nowhere", async () => {
    await show();
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) =>
      init.method === "POST" ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: "that account is not a user" }) } : real(url, init);
    press(button(main(), "View as user"));
    await flush();
    expect(toastText()).toBe("that account is not a user");
    expect(page.go).not.toHaveBeenCalled();
  });
});

describe("the own account", () => {
  it("reloads the page after Edit, Block and Delete", async () => {
    await open("Edit", "me");
    field(root(), "name")!.value = "Boss";
    press(button(root(), "Save"));
    await flush();
    expect(page.reload).toHaveBeenCalledTimes(1);
    await show("me");
    press(button(main(), "Block"));
    await flush();
    expect(root().textContent).toContain("signed out at once");
    press(button(root(), "Block"));
    await flush();
    expect(page.reload).toHaveBeenCalledTimes(2);
    await show("me");
    press(button(main(), "Delete"));
    await flush();
    press(button(root(), "Delete"));
    await flush();
    expect(page.reload).toHaveBeenCalledTimes(3);
    expect(page.go).not.toHaveBeenCalled();
  });
  it("warns in the reset dialog", async () => {
    await open("Reset password", "me");
    expect(root().textContent).toContain("signed out at once");
  });
});

describe("failures", () => {
  const cases: [string, string, string, (() => void)?][] = [
    ["Edit: last admin", "Edit", "Save", () => { field(root(), "role")!.value = "user"; }],
    ["Block: last admin", "Block", "Block"],
    ["Reset: last admin", "Reset password", "Reset password"],
    ["Delete: last admin", "Delete", "Delete"],
  ];
  it.each(cases)("%s: the refusal stays in the dialog and the page is unchanged", async (_n, opener, confirm, prepare) => {
    await open(opener, "me");
    prepare?.();
    const before = main().textContent;
    answers.push({ status: 409, error: ADMIN_ONLY });
    press(button(root(), confirm));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe(ADMIN_ONLY);
    expect(button(root(), confirm)!.disabled).toBe(false);
    expect(main().textContent).toBe(before);
  });
  it("keeps the dialog on a 500 after the change and reads the page when it closes", async () => {
    await open("Block");
    answers.push({ status: 500, error: "the account list is not working; see the server log", after: true });
    press(button(root(), "Block"));
    await flush();
    expect(errLine(root())[0]!.textContent).toContain("not working");
    expect(fact("Status")).toBe("active");
    pressEscape();
    await flush();
    expect(fact("Status")).toBe("blocked");
  });
  it("a failed reload keeps the page and the notice, and Retry clears the note", async () => {
    await open("Block");
    usersGets.push({ status: 500 });
    press(button(root(), "Block"));
    await flush();
    await flush();
    expect(main().textContent).toContain(ui.cancelledText("Ann", 3));
    expect(stale()).toHaveLength(1);
    expect(stale()[0]!.attrs.class).toContain("failed");
    expect(main().all("h1")[0]!.textContent).toBe("Ann");
    press(button(stale()[0]!, "Retry"));
    await flush();
    await flush();
    expect(stale()).toHaveLength(0);
    expect(fact("Status")).toBe("blocked");
  });
  it("after Delete the account is gone when the dialog was closed late", async () => {
    await open("Delete");
    users = users.filter((u) => u.id !== "u1");
    pressEscape();
    await flush();
    expect(main().textContent).toContain("This account does not exist.");
  });
});

describe("late answers", () => {
  it("draws nothing after the cleanup", async () => {
    let release!: () => void;
    usersGets.push({ gate: new Promise<void>((r) => (release = r)) });
    const done = detail.renderUserDetail(main(), "u1", { me: "me", page });
    await flush();
    main().replaceChildren();
    // a newer render has taken over
    const stop = await detail.renderUserDetail(main(), "u1", { me: "me", page });
    stop();
    main().replaceChildren();
    release();
    await done;
    expect(main().children).toHaveLength(0);
  });
  it("draws nothing when the address changed to another account or to the list", async () => {
    for (const hash of ["#/users/other", "#/users", "#/runs"]) {
      (globalThis as any).location = { hash };
      let release!: () => void;
      usersGets.push({ gate: new Promise<void>((r) => (release = r)) });
      const onName = vi.fn();
      const done = detail.renderUserDetail(main(), "u1", { me: "me", page, onName });
      await flush();
      release();
      await done;
      expect(main().children, hash).toHaveLength(0);
      expect(onName).not.toHaveBeenCalled();
    }
  });
  it("draws on the right address, also with an id that needs encoding", async () => {
    users.push(user({ id: "a b/c", name: "Odd" }));
    (globalThis as any).location = { hash: "#/users/a%20b%2Fc" };
    await show("a b/c");
    expect(main().all("h1")[0]!.textContent).toBe("Odd");
  });
  it("opens no app-repositories dialog and shows no error when the page was left while the list loads", async () => {
    for (const fail of [false, true]) {
      const stop = await detail.renderUserDetail(main(), "u1", { me: "me", page });
      let release!: () => void;
      appGate = new Promise<void>((r) => (release = r));
      if (fail) answers.push({ status: 404, error: "no such account" });
      press(button(main(), "App repositories"));
      await flush();
      stop();
      release();
      await flush();
      appGate = undefined;
      expect(root().children).toHaveLength(0);
      expect(toastText()).toBe("");
    }
  });
});
