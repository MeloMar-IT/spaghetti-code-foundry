import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The Users list, its pure functions and the Add user and Default limits dialogs. The actions of one account are in ui-user-detail.test.ts.
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/users.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const TOKEN = "Ab3_".repeat(10) + "xyz"; // 43 characters
const ORIGIN = "https://foundry.example";
const LINK = `${ORIGIN}/#/set-password/${TOKEN}`;
const FUTURE = new Date(Date.now() + 20 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

type Answer = { status: number; error: string; after?: boolean } | "throw";
let users: any[];
let gets: number;
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let holdNext: boolean;
let held: { release: () => void } | undefined;
let heldGets: (() => void)[][];
let clipboard: any;
let page: any;
let limits: { defaults: any; users: Record<string, any> };
let limitsFail: boolean;
const realFetch = globalThis.fetch;

const user = (over: object = {}) => ({
  id: "u1", name: "Ann", email: "ann@example.com", role: "user", status: "active", created: "2026-01-01T00:00:00.000Z",
  lastSignIn: new Date().toISOString(), runs: 2, hasPassword: true, lockedUntil: null, ...over,
});

beforeEach(() => {
  users = [user({ id: "me", name: "Root", email: "root@example.com", role: "admin", runs: 0 }), user()];
  gets = 0;
  limits = { defaults: {}, users: {} };
  limitsFail = false;
  sent = [];
  answers = [];
  holdNext = false;
  held = undefined;
  heldGets = [];
  clipboard = { writeText: vi.fn(async () => {}) };
  page = { origin: () => ORIGIN, clipboard: () => clipboard, reload: vi.fn(), go: vi.fn() };
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).getElementById("main").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (url.endsWith("/limits")) {
      if (init.method === "GET") return limitsFail ? reply({ error: "broken" }, 500) : reply(limits);
      const patch = JSON.parse(init.body!);
      sent.push({ method: init.method, url, body: patch });
      const answer = answers.shift();
      if (answer && answer !== "throw") return reply({ error: answer.error }, answer.status);
      const m = /^\/api\/users\/([^/]+)\/limits$/.exec(url);
      const into = m ? (limits.users[m[1]!] ??= {}) : limits.defaults;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete into[k];
        else into[k] = v;
      }
      if (m && !Object.keys(into).length) delete limits.users[m[1]!];
      return reply(limits);
    }
    if (init.method === "GET") {
      gets++;
      const snapshot = users.map((u) => ({ ...u }));
      const wait = heldGets.shift();
      if (wait) await new Promise<void>((r) => wait.push(r));
      return reply(snapshot);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    const answer = answers.shift();
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((r) => (held = { release: r }));
    }
    if (answer === "throw") throw new TypeError("fetch failed");
    const id = url.split("/")[3] ?? "";
    const target = users.find((u) => u.id === id);
    if (answer) return reply({ error: answer.error }, answer.status);
    if (init.method === "PUT" && target) Object.assign(target, body);
    if (init.method === "POST" && url === "/api/users") {
      const created = user({ id: "new1", ...body, hasPassword: false, lastSignIn: null, runs: 0 });
      users.push(created);
      return reply({ user: created, token: TOKEN, expires: "2026-12-01T00:00:00.000Z" }, 201);
    }
    return reply({ user: target });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const errLine = (el: FakeElement) => walk(el).filter((e) => (e.attrs.class ?? "").split(" ").includes("status") && (e.attrs.class ?? "").split(" ").includes("bad"));
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const pressEscape = () => (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
const rows = () => main().all("tr").filter((r) => r.all("td").length);
const rowOf = (name: string) => rows().find((r) => r.all("td")[0]!.textContent.startsWith(name))!;
const show = async () => {
  await ui.renderUsers(main(), { me: "me", page });
};

describe("pure functions", () => {
  it("statusText", () => {
    expect(ui.statusText(user())).toBe("active");
    expect(ui.statusText(user({ status: "blocked" }))).toBe("blocked");
    expect(ui.statusText(user({ hasPassword: false }))).toBe("no password yet");
    expect(ui.statusText(user({ hasPassword: false, status: "blocked" }))).toBe("blocked");
    expect(ui.statusText(user({ lockedUntil: FUTURE }))).toBe("locked");
    expect(ui.statusText(user({ lockedUntil: FUTURE, status: "blocked" }))).toBe("blocked");
    expect(ui.statusText(user({ lockedUntil: FUTURE, hasPassword: false }))).toBe("no password yet");
    expect(ui.statusText(user({ lockedUntil: PAST }))).toBe("active");
  });
  it("isLocked", () => {
    expect(ui.isLocked(user())).toBe(false);
    expect(ui.isLocked(user({ lockedUntil: FUTURE }))).toBe(true);
    expect(ui.isLocked(user({ lockedUntil: PAST }))).toBe(false);
  });
  it("pillClass", () => {
    expect(ui.pillClass(user())).toBe("pill ok");
    expect(ui.pillClass(user({ status: "blocked" }))).toBe("pill fail");
    expect(ui.pillClass(user({ hasPassword: false }))).toBe("pill");
    expect(ui.pillClass(user({ lockedUntil: FUTURE }))).toBe("pill locked");
    expect(ui.pillClass(user({ lockedUntil: FUTURE, status: "blocked" }))).toBe("pill fail");
    expect(ui.pillClass(user({ lockedUntil: PAST }))).toBe("pill ok");
  });
  it("lastSignInText", () => {
    expect(ui.lastSignInText({ lastSignIn: null })).toBe("never");
    expect(ui.lastSignInText({ lastSignIn: new Date().toISOString() })).toBe("just now");
  });
  it("actionsFor", () => {
    expect(ui.actionsFor(user())).toEqual(["edit", "limits", "app","reset", "block", "view", "delete"]);
    expect(ui.actionsFor(user({ status: "blocked" }))).toEqual(["edit", "limits", "app","reset", "unblock", "view", "delete"]);
    expect(ui.actionsFor(user({ hasPassword: false }))).toEqual(["edit", "limits", "app","link", "block", "view", "delete"]);
    expect(ui.actionsFor(user({ hasPassword: false, status: "blocked" }))).toEqual(["edit", "limits", "app","link", "unblock", "view", "delete"]);
    expect(ui.actionsFor(user({ lockedUntil: FUTURE }))).toEqual(["edit", "limits", "app","reset", "unlock", "block", "view", "delete"]);
    expect(ui.actionsFor(user({ lockedUntil: FUTURE, status: "blocked" }))).toEqual(["edit", "limits", "app","reset", "unlock", "unblock", "view", "delete"]);
    expect(ui.actionsFor(user({ lockedUntil: FUTURE, hasPassword: false }))).toEqual(["edit", "limits", "app","link", "block", "view", "delete"]);
    expect(ui.actionsFor(user({ lockedUntil: PAST }))).toEqual(["edit", "limits", "app","reset", "block", "view", "delete"]);
    expect(ui.actionsFor(user({ role: "admin" }))).toEqual(["edit", "limits", "app","reset", "block", "delete"]);
  });
  it("every action has a dialog (or View as) and a label", () => {
    for (const k of ui.actionsFor(user({ lockedUntil: FUTURE }))) {
      expect(ui.LABELS[k], k).toBeTruthy();
      if (k !== "view") expect(typeof ui.DIALOGS[k], k).toBe("function");
    }
  });
  it("limitParts", () => {
    expect(ui.limitParts({ defaults: {}, users: {} }, "u1")).toEqual([]);
    expect(ui.limitParts(null, "u1")).toEqual([]);
    expect(ui.limitParts({ defaults: { maxConcurrent: 2, dailyBudgetUsd: 5 }, users: {} }, "u1")).toEqual([
      { key: "maxConcurrent", text: "2 at a time", override: false },
      { key: "dailyBudgetUsd", text: "$5 a day", override: false },
    ]);
    expect(ui.limitParts({ defaults: { maxConcurrent: 2 }, users: { u1: { maxConcurrent: 9, maxRunsPerDay: 10 } } }, "u1")).toEqual([
      { key: "maxConcurrent", text: "9 at a time", override: true },
      { key: "maxRunsPerDay", text: "10 runs a day", override: true },
    ]);
  });
  it("readLimits", () => {
    expect(ui.readLimits({ maxConcurrent: " ", maxRunsPerDay: "", dailyBudgetUsd: "" })).toEqual({ values: {} });
    expect(ui.readLimits({ maxConcurrent: "3", maxRunsPerDay: " 10 ", dailyBudgetUsd: "2.5" })).toEqual({ values: { maxConcurrent: 3, maxRunsPerDay: 10, dailyBudgetUsd: 2.5 } });
    expect(ui.readLimits({ dailyBudgetUsd: "1e+100" })).toEqual({ values: { dailyBudgetUsd: 1e100 } });
    for (const bad of ["0", "-1", "1.5", "x", "9007199254740993"]) expect(ui.readLimits({ maxConcurrent: bad }).problem, bad).toBe("Runs at the same time must be a whole number of 1 or more, or empty.");
    expect(ui.readLimits({ maxRunsPerDay: "0" }).problem).toBe("Runs per day must be a whole number of 1 or more, or empty.");
    for (const bad of ["0", "-1", "abc", "1e999", "0.0"]) expect(ui.readLimits({ dailyBudgetUsd: bad }).problem, bad).toBe("Daily budget must be a number above 0, or empty.");
  });
  it("limitsPatch", () => {
    expect(ui.limitsPatch({ maxConcurrent: 2, maxRunsPerDay: 5 }, { maxConcurrent: 3, maxRunsPerDay: 5 })).toEqual({ maxConcurrent: 3 });
    expect(ui.limitsPatch({ maxConcurrent: 2, maxRunsPerDay: 5 }, { maxRunsPerDay: 5 })).toEqual({ maxConcurrent: null });
    expect(ui.limitsPatch({}, { dailyBudgetUsd: 1 })).toEqual({ dailyBudgetUsd: 1 });
    expect(ui.limitsPatch({ maxConcurrent: 2 }, { maxConcurrent: 2 })).toEqual({});
    expect(ui.limitsPatch(undefined, {})).toEqual({});
  });
  it("blockedLinkText", () => {
    expect(ui.blockedLinkText(user())).toBe("");
    expect(ui.blockedLinkText(user({ status: "blocked" }))).toContain("Ann is blocked");
    expect(ui.blockedLinkText(user({ status: "blocked" }))).toContain("only after you unblock");
  });
  it("passwordLink gives the token back", async () => {
    const { linkToken } = await import("../ui/auth.js" as string);
    expect(ui.passwordLink(ORIGIN, TOKEN)).toBe(LINK);
    expect(linkToken(new URL(LINK).hash)).toBe(TOKEN);
  });
  it("userProblem and newUserBody", () => {
    expect(ui.userProblem({ name: " ", email: "a@b.c" })).toBe("Fill in the name.");
    expect(ui.userProblem({ name: "A", email: "" })).toBe("Fill in the e-mail.");
    expect(ui.userProblem({ name: "A", email: "a@b.c" })).toBe("");
    expect(ui.newUserBody({ name: " A ", email: " a@b.c ", role: "admin" })).toEqual({ name: "A", email: "a@b.c", role: "admin" });
    expect(ui.newUserBody({ name: "A", email: "a@b.c", role: "root" }).role).toBe("user");
  });
  it("userChanges", () => {
    const u = user();
    expect(ui.userChanges(u, { name: "Bea", email: "ann@example.com", role: "user" })).toEqual({ name: "Bea" });
    expect(ui.userChanges(u, { name: "Ann", email: "ANN@example.com", role: "user" })).toEqual({});
    expect(ui.userChanges(u, { name: "Ann", email: "b@example.com", role: "admin" })).toEqual({ email: "b@example.com", role: "admin" });
  });
  it("cancelledText", () => {
    expect(ui.cancelledText("Ann", 0)).toBe("Ann is blocked. No runs were cancelled.");
    expect(ui.cancelledText("Ann", 1)).toBe("Ann is blocked. 1 run was cancelled.");
    expect(ui.cancelledText("Ann", 4)).toBe("Ann is blocked. 4 runs were cancelled.");
  });
  it("cancelledTotal adds what the server counted", () => {
    expect(ui.cancelledTotal({ queued: 1, running: 2, waiting: 3 })).toBe(6);
    expect(ui.cancelledTotal({ queued: 1 })).toBe(1);
    expect(ui.cancelledTotal(undefined)).toBe(0);
  });
  it("appReposBody turns the lines of the box into a list", () => {
    expect(ui.appReposBody(" acme/app \n\n acme/* \r\n")).toEqual(["acme/app", "acme/*"]);
    expect(ui.appReposBody("")).toEqual([]);
  });
  it("copyText", async () => {
    const fake = { writeText: vi.fn(async () => {}) };
    expect(await ui.copyText(fake, "x")).toBe(true);
    expect(fake.writeText).toHaveBeenCalledWith("x");
    expect(await ui.copyText(undefined, "x")).toBe(false);
    expect(await ui.copyText({ writeText: async () => { throw new Error("no"); } }, "x")).toBe(false);
  });
  it("limitsCell marks own values, mutes defaults and says when the limits are not available", () => {
    expect(ui.limitsCell(null, "u1").textContent).toBe("not available");
    expect(ui.limitsCell({ defaults: {}, users: {} }, "u1").textContent).toBe("no limits");
    const cell = ui.limitsCell({ defaults: { maxConcurrent: 2 }, users: { u1: { dailyBudgetUsd: 5 } } }, "u1");
    expect(cell.flat(Infinity).map((n: any) => (typeof n === "string" ? n : n?.textContent ?? "")).join("")).toBe("2 at a time · $5 a day (own)");
  });
});

describe("the list", () => {
  it("shows the columns and one row per account, with no action buttons", async () => {
    users.push(user({ id: "u2", name: "Bob", status: "blocked", lastSignIn: null }), user({ id: "u3", name: "Cy", hasPassword: false, lastSignIn: null }));
    await show();
    expect(main().all("th").map((t) => t.textContent)).toEqual(["Name", "E-mail", "Role", "Status", "Last sign-in", "Runs", "Limits"]);
    const cells = (n: string) => rowOf(n).all("td").map((t) => t.textContent);
    expect(cells("Root").slice(0, 4)).toEqual(["Root (you)", "root@example.com", "admin", "active"]);
    expect(cells("Ann").slice(0, 7)).toEqual(["Ann", "ann@example.com", "user", "active", "just now", "2", "no limits"]);
    expect(cells("Bob")[3]).toBe("blocked");
    expect(cells("Bob")[4]).toBe("never");
    expect(cells("Cy")[3]).toBe("no password yet");
    for (const r of rows()) expect(r.all("button"), r.textContent).toHaveLength(0);
    expect(main().all("table")[0]!.all("button")).toHaveLength(0);
    expect(main().all("input")).toHaveLength(0);
  });

  it("the name links to the account's page", async () => {
    users.push(user({ id: "a b/c", name: "Odd" }));
    await show();
    const link = (n: string) => rowOf(n).all("a")[0]!;
    expect(link("Ann").attrs.href).toBe("#/users/u1");
    expect(link("Ann").textContent).toBe("Ann");
    expect(link("Root").attrs.href).toBe("#/users/me");
    expect(link("Odd").attrs.href).toBe("#/users/a%20b%2Fc");
  });

  it("offers Delete and Block nowhere on the list", async () => {
    await show();
    const labels = main().all("button").map((b) => b.textContent);
    expect(labels).toEqual(["Default limits", "+ Add user"]);
  });
});

describe("Add user", () => {
  it("asks for a name first", async () => {
    await show();
    press(button(main(), "+ Add user"));
    press(button(root(), "Add user"));
    expect(errLine(root())[0]!.textContent).toBe("Fill in the name.");
    expect(sent).toEqual([]);
  });

  it("shows the link once, reloads on Done and leaves no token behind", async () => {
    await show();
    press(button(main(), "+ Add user"));
    field(root(), "name")!.value = " Dee ";
    field(root(), "email")!.value = "dee@example.com";
    field(root(), "role")!.value = "admin";
    press(button(root(), "Add user"));
    press(button(root(), "Add user"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users", body: { name: "Dee", email: "dee@example.com", role: "admin" } }]);
    const link = field(root(), "link")!;
    expect(link.value).toBe(LINK);
    expect(link.attrs.readonly).toBeDefined();
    for (const t of ["works once", "24 hours", "Send it to the user yourself"]) expect(root().textContent).toContain(t);
    expect(gets).toBe(1);
    press(button(root(), "Copy"));
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith(LINK);
    expect(root().textContent).toContain("Copied.");
    press(button(root(), "Done"));
    await flush();
    expect(gets).toBe(2);
    expect(rowOf("Dee").all("td")[3]!.textContent).toBe("no password yet");
    for (const t of [main().textContent, toastText(), root().textContent]) expect(t).not.toContain(TOKEN);
  });

  it("says so when it cannot copy", async () => {
    clipboard = undefined;
    await show();
    press(button(main(), "+ Add user"));
    field(root(), "name")!.value = "Dee";
    field(root(), "email")!.value = "dee@example.com";
    press(button(root(), "Add user"));
    await flush();
    press(button(root(), "Copy"));
    await flush();
    expect(root().textContent).toContain("Could not copy");
  });

  it("toasts when the dialog was closed before the link came", async () => {
    await show();
    press(button(main(), "+ Add user"));
    field(root(), "name")!.value = "Dee";
    field(root(), "email")!.value = "dee@example.com";
    holdNext = true;
    press(button(root(), "Add user"));
    await flush();
    pressEscape();
    held!.release();
    await flush();
    expect(toastText()).toContain("The link was not shown");
    expect(toastText()).not.toContain(TOKEN);
    expect(rowOf("Dee")).toBeDefined();
  });
});

describe("Limits on the list", () => {
  it("shows defaults, and an own value marked (own)", async () => {
    limits = { defaults: { maxConcurrent: 2 }, users: { u1: { maxConcurrent: 9, dailyBudgetUsd: 5 } } };
    await show();
    expect(rowOf("Root").all("td")[6]!.textContent).toBe("2 at a time");
    expect(rowOf("Ann").all("td")[6]!.textContent).toBe("9 at a time (own) · $5 a day (own)");
  });
  it("Default limits sends the defaults", async () => {
    await show();
    press(button(main(), "Default limits"));
    await flush();
    field(root(), "dailyBudgetUsd")!.value = "12.5";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/users/limits", body: { dailyBudgetUsd: 12.5 } }]);
    expect(toastText()).toBe("Saved");
    expect(rowOf("Ann").all("td")[6]!.textContent).toBe("$12.5 a day");
  });
  it("Default limits shows a problem and a server error in the dialog", async () => {
    await show();
    press(button(main(), "Default limits"));
    await flush();
    field(root(), "maxConcurrent")!.value = "0";
    press(button(root(), "Save"));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe("Runs at the same time must be a whole number of 1 or more, or empty.");
    field(root(), "maxConcurrent")!.value = "3";
    answers.push({ status: 500, error: "nope" });
    press(button(root(), "Save"));
    await flush();
    expect(errLine(root())[0]!.textContent).toContain("nope");
  });
  it("still lists users when the limits cannot be read", async () => {
    limitsFail = true;
    await show();
    expect(rows()).toHaveLength(2);
    expect(rowOf("Ann").all("td")[6]!.textContent).toBe("not available");
    expect(button(main(), "Default limits")!.attrs.disabled).toBe("");
  });
});

describe("refusals", () => {
  const cases: [string, string, Answer, () => void][] = [
    ["Add: e-mail taken", "Add user", { status: 409, error: "an account with that e-mail exists already" }, () => {
      press(button(main(), "+ Add user"));
      field(root(), "name")!.value = "Dee";
      field(root(), "email")!.value = "ann@example.com";
    }],
    ["Add: bad e-mail", "Add user", { status: 400, error: "that is not a valid e-mail address" }, () => {
      press(button(main(), "+ Add user"));
      field(root(), "name")!.value = "Dee";
      field(root(), "email")!.value = "nope";
    }],
    ["Add: network", "Add user", "throw", () => {
      press(button(main(), "+ Add user"));
      field(root(), "name")!.value = "Dee";
      field(root(), "email")!.value = "dee@example.com";
    }],
  ];
  it.each(cases)("%s", async (_n, label, answer, setup) => {
    await show();
    setup();
    const before = main().textContent;
    const g = gets;
    answers.push(answer);
    press(button(root(), label));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe(answer === "throw" ? "Could not reach the server." : answer.error);
    expect(button(root(), label)!.disabled).toBe(false);
    expect(gets).toBe(g);
    expect(main().textContent).toBe(before);
  });
});

describe("late answers", () => {
  it("draws nothing when the page was left", async () => {
    (globalThis as any).location = { hash: "#/runs" };
    await show();
    expect(main().textContent).toBe("");
  });
  it("draws nothing on an account's page address", async () => {
    (globalThis as any).location = { hash: "#/users/u1" };
    await show();
    expect(main().textContent).toBe("");
  });
  it("draws on the list address", async () => {
    (globalThis as any).location = { hash: "#/users" };
    await show();
    expect(rows()).toHaveLength(2);
  });
  it("the cleanup drops a load that is on its way", async () => {
    const wait: (() => void)[] = [];
    heldGets.push(wait);
    const load = ui.renderUsers(main(), { me: "me", page });
    await flush();
    const stop = await ui.renderUsers(main(), { me: "me", page }); // a newer load that has finished
    stop();
    main().replaceChildren();
    wait.forEach((r) => r());
    await load;
    expect(main().textContent).toBe("");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");
  it("is wired into the page", async () => {
    const ia = (await import("../ui/ia.js" as string)) as { subnavFor: (r: string, d: string) => { href: string; label: string }[] };
    expect(ia.subnavFor("admin", "administration")).toContainEqual({ id: "users", href: "#/users", label: "Users", section: "access" });
    expect(read("index.html")).toContain('href="#/operations" data-nav="administration"');
    expect(read("app.js")).toContain('from "./users.js"');
    expect(read("app.js")).toContain('from "./user-detail.js"');
    expect(read("app.js")).toContain('section === "users" && arg');
    expect(read("app.js")).toContain('section === "users")');
    expect(read("user/index.html")).not.toContain("#/users");
  });
  it("the two files stay under 500 lines", () => {
    for (const f of ["users.js", "user-detail.js"]) expect(read(f).split("\n").length, f).toBeLessThan(500);
  });
  it("the api calls hit the right routes", async () => {
    await api.users();
    await api.addUser({ name: "A" });
    await api.saveUser("a b", { name: "B" });
    await api.blockUser("u1", true);
    await api.unblockUser("u1");
    await api.userLink("u1");
    await api.resetUser("u1");
    await api.unlockUser("u1");
    await api.deleteUser("u1");
    expect(gets).toBe(1);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/users", "PUT /api/users/a%20b", "POST /api/users/u1/block", "POST /api/users/u1/unblock", "POST /api/users/u1/link",
      "POST /api/users/u1/reset", "POST /api/users/u1/unlock", "DELETE /api/users/u1",
    ]);
    expect(sent[2]!.body).toEqual({ stopWork: true });
  });
});
