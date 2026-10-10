import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Audits the administration, repository, watcher, model, user and sign-in pages and their dialogs, and checks that
// errors are read out (role="alert") and that the field at fault is marked (aria-invalid) and focused.
let restore: () => void;
const m: Record<string, any> = {};
beforeAll(async () => {
  restore = installFakeDom();
  for (const [k, f] of Object.entries({
    dom: "dom", auth: "auth", users: "users", repos: "repos", adminRepos: "admin-repos", admin: "admin", watcherForm: "watcher-form",
    models: "models", audit: "audit", monitor: "monitor", problems: "problems",
  })) m[k] = await import(`../ui/${f}.js` as string);
});
afterAll(() => restore());

const doc = () => document as any;
const main = () => document.getElementById("main") as unknown as FakeElement;
const modalRoot = () => document.getElementById("modal-root") as unknown as FakeElement;
const controls = (root: FakeElement) => ["input", "select", "textarea"].flatMap((t) => root.all(t));
const named = (root: FakeElement, name: string) => controls(root).find((c) => c.attrs.name === name)!;
const withPlaceholder = (root: FakeElement, text: string) => controls(root).find((c) => (c.attrs.placeholder ?? "").startsWith(text))!;
const button = (root: FakeElement, text: string) => root.all("button").find((b) => b.textContent === text)!;
const invalid = (root: FakeElement) => controls(root).filter((c) => c.attrs["aria-invalid"] === "true");
const alerts = (root: FakeElement) => [...["p", "div", "span"].flatMap((t) => root.all(t))].filter((e) => e.attrs.role === "alert");
const settle = () => new Promise((r) => setTimeout(r, 0));
const dialogUp = () => vi.waitFor(() => expect(modalRoot().children.length).toBeGreaterThan(0));
const noViolations = (root: FakeElement) => expect(audit(root)).toEqual([]);

// ---- the fetch stub: every call needs an answer; an unknown call fails the test ----------------------

const realFetch = globalThis.fetch;
let routes: Record<string, unknown>;
let failures: Record<string, { status: number; error: string }[]>;
let sent: { key: string; body: any }[];
/** Answers the next call of `METHOD url` with an error. */
const fail = (method: string, url: string, status: number, error: string) => (failures[`${method} ${url}`] ??= []).push({ status, error });

beforeEach(() => {
  routes = {};
  failures = {};
  sent = [];
  main().replaceChildren();
  modalRoot().replaceChildren();
  doc().listeners.keydown = [];
  doc().activeElement = null;
  delete (globalThis as any).location;
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    sent.push({ key, body: init?.body ? JSON.parse(init.body) : undefined });
    const failed = failures[key]?.shift();
    if (failed) return { ok: false, status: failed.status, statusText: "x", json: async () => ({ error: failed.error }) };
    const found = key in routes ? key : key.split("?")[0]!;
    if (!(found in routes)) throw new Error(`unexpected call: ${key}`);
    return { ok: true, status: 200, statusText: "OK", json: async () => routes[found] };
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Every table has a head with `scope="col"` cells and a name. */
function tablesOk(root: FakeElement) {
  const tables = root.all("table");
  expect(tables.length).toBeGreaterThan(0);
  for (const t of tables) {
    expect(t.all("thead").length, "thead").toBe(1);
    const ths = t.all("th");
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) expect(th.attrs.scope).toBe("col");
    const caption = t.all("caption").find((c) => (c.attrs.class ?? "") === "sr-only" && c.textContent.trim());
    expect(!!(t.attrs["aria-label"] || caption), `a name for the table with ${ths[0]!.textContent}`).toBe(true);
  }
}

// ---- data ---------------------------------------------------------------------------------------

const NOW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 20 * 60_000).toISOString();
const TOKEN = "Ab3_".repeat(10) + "xyz";
const user = (over: object = {}) => ({
  id: "u1", name: "Ann", email: "ann@example.com", role: "user", status: "active", created: NOW, lastSignIn: NOW, runs: 2, hasPassword: true, lockedUntil: null, ...over,
});
const USERS = [
  user({ id: "me", name: "Root", email: "root@example.com", role: "admin" }), user(), user({ id: "u2", name: "Cy", email: "cy@example.com", hasPassword: false }),
  user({ id: "u3", name: "Lou", email: "lou@example.com", lockedUntil: FUTURE }), user({ id: "u4", name: "Bob", email: "bob@example.com", status: "blocked" }),
];
const repo = (over: object = {}) => ({
  id: "r1", url: "https://github.com/acme/app", method: "ssh-deploy-key", publicKey: "ssh-ed25519 AAAA", account: { name: "Ann", email: "ann@example.com", status: "active", role: "user" },
  connection: { ok: true, at: NOW, checks: [] }, settings: {}, watcherProblem: undefined, ...over,
});
const finding = { id: "f1", severity: "major", detector: "stuck-run", summary: "A run is stuck", firstSeen: NOW, lastSeen: NOW, count: 2, state: "seen", story: null, needsYou: false };
const mute = { id: "m1", kind: "detector", detector: "stuck-run", reason: "known", since: NOW, until: null };
const monitorState = {
  state: "on", running: true, findings: [finding], mutes: [mute], lastCheck: NOW, madeToday: 0,
  detectors: [{ name: "stuck-run", key: "stuck_run", description: "A run that does not move", thresholds: { resumes: 3 }, lastFound: NOW }],
};
const config = ConfigSchema.parse({
  providers: { local: { kind: "ollama" } },
  router: { rules: [{ step: "^review$", model: "codex" }] },
});
const providers = {
  agents: [{ agent: "claude", installed: true, loggedIn: true, version: "1.0", detail: "" }],
  providers: [{ name: "local", kind: "ollama", base_url: "http://localhost:11434", ok: true, detail: "", models: ["qwen3-coder"], agents: ["claude"] }],
};
const watchers = [
  { id: "w1", repoId: "r1", source: "issues", flow: "issue-gitflow", label: "claude-factory", every: "5m", max_per_tick: 1, enabled: true, vars: {}, github_repo: "acme/app" },
  { id: "monitor", source: "monitor", every: "1h", enabled: true },
];
const page = { origin: () => "https://foundry.example", clipboard: () => undefined, reload: vi.fn(), go: vi.fn() };
const press = (el: FakeElement) => el.click();

// ---- pages --------------------------------------------------------------------------------------

describe("pages", () => {
  it("Settings", async () => {
    routes = { "GET /api/config": config, "GET /api/info": { configPath: "/x/config.yaml", spentToday: 0, listening: "127.0.0.1" } };
    await m.admin.renderSettings(main());
    noViolations(main());
    const boxes = controls(main()).filter((c) => c.attrs.type === "checkbox");
    expect(boxes.length).toBeGreaterThan(5);
    for (const b of boxes) {
      let inLabel = false;
      for (let p = b.parent; p; p = p.parent) if (p.tag === "label") inLabel = true;
      expect(inLabel).toBe(true);
    }
  });
  it("Watchers", async () => {
    routes = {
      "GET /api/watchers": watchers, "GET /api/flows": [{ name: "issue-gitflow" }], "GET /api/admin/repos": [repo()], "GET /api/monitor": monitorState,
    };
    await m.admin.renderWatchers(main());
    noViolations(main());
    tablesOk(main());
  });
  it("Models", async () => {
    routes = { "GET /api/config": config, "GET /api/providers": providers };
    await m.models.renderModels(main());
    noViolations(main());
    tablesOk(main());
  });
  it("Problems", async () => {
    routes = { "GET /api/monitor": monitorState };
    await m.problems.renderProblems(main());
    noViolations(main());
    tablesOk(main());
  });
  it("Audit", async () => {
    routes = {
      "GET /api/users": USERS,
      "GET /api/audit": { more: false, entries: [{ time: NOW, actor: { id: "me", name: "Root" }, action: "sign-in", target: null, result: "ok" }] },
    };
    m.audit.renderAudit(main());
    await vi.waitFor(() => expect(main().all("table").length).toBe(1));
    noViolations(main());
    tablesOk(main());
  });
  it("Users", async () => {
    routes = { "GET /api/users": USERS, "GET /api/users/limits": { defaults: {}, users: {} } };
    await m.users.renderUsers(main(), { me: "me", page });
    noViolations(main());
    tablesOk(main());
  });
  it("My repositories", async () => {
    routes = { "GET /api/repos": [repo()], "GET /api/repos/methods": { methods: ["ssh-deploy-key", "https-token"] } };
    await m.repos.renderRepos(main(), { admin: true });
    noViolations(main());
    tablesOk(main());
  });
  it("Repositories of all accounts", async () => {
    routes = { "GET /api/admin/repos": [repo()] };
    await m.adminRepos.renderAllRepos(main());
    noViolations(main());
    tablesOk(main());
  });
});

// ---- sign-in ------------------------------------------------------------------------------------

describe("sign-in", () => {
  const signedOut = (hash = "", session: object = { user: null, setupNeeded: false }) => {
    const api = { session: async () => session, signIn: vi.fn(async () => { throw new Error("wrong e-mail or password"); }), setup: vi.fn(), setPassword: vi.fn() };
    void m.auth.ensureSignedIn(api, vi.fn(), { hash: () => hash, clearHash: vi.fn(), onHashChange: vi.fn() });
    return api;
  };
  const submit = (form: FakeElement) => form.fire("submit", { preventDefault: () => {} });

  it("the sign-in, first-admin and set-password forms have no violations", async () => {
    signedOut();
    await settle();
    noViolations(main());
    expect(controls(main()).length).toBe(2);
    main().replaceChildren();
    signedOut("", { user: null, setupNeeded: true });
    await settle();
    noViolations(main());
    expect(controls(main()).length).toBe(4);
    main().replaceChildren();
    signedOut(`#/set-password/${TOKEN}`);
    await settle();
    noViolations(main());
    expect(controls(main()).length).toBe(2);
  });
  it("an empty e-mail marks the e-mail field; a wrong sign-in marks no field", async () => {
    signedOut();
    await settle();
    const form = main().all("form")[0]!;
    submit(form);
    await vi.waitFor(() => expect(alerts(main())[0]!.textContent).toBe("Fill in your e-mail and password."));
    expect(invalid(main())).toEqual([named(main(), "email")]);
    expect(doc().activeElement).toBe(named(main(), "email"));
    named(main(), "email").value = "a@example.com";
    named(main(), "password").value = "pw";
    submit(form);
    await vi.waitFor(() => expect(alerts(main())[0]!.textContent).toBe("wrong e-mail or password"));
    expect(invalid(main())).toEqual([]);
  });
  it("the session failure box is an alert", async () => {
    const api = { session: async () => { throw new TypeError("x"); } };
    void m.auth.ensureSignedIn(api, vi.fn(), { hash: () => "", clearHash: vi.fn(), onHashChange: vi.fn() });
    await settle();
    expect(main().all("div")[0]!.attrs.role).toBe("alert");
  });
  it("the Change password dialog has no violations and marks the current password", async () => {
    const api = { changePassword: vi.fn(async () => { throw new Error("the current password is wrong"); }) };
    void m.auth.changePasswordDialog(api);
    await dialogUp();
    noViolations(modalRoot());
    for (const n of ["current", "password", "repeat"]) named(modalRoot(), n).value = "long-enough-password";
    submit(modalRoot().all("form")[0]!);
    await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe("the current password is wrong"));
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "current")]);
    expect(doc().activeElement).toBe(named(modalRoot(), "current"));
  });
});

describe("errorField", () => {
  const rows: [string, object, string, string][] = [
    ["change", {}, "the current password is wrong", "current"],
    ["setup", {}, "The two passwords are not the same.", "repeat"],
    ["setup", { name: " ", email: "a@b.c" }, "Fill in your name and e-mail.", "name"],
    ["setup", { name: "Ann", email: "" }, "Fill in your name and e-mail.", "email"],
    ["signin", { email: "", password: "x" }, "Fill in your e-mail and password.", "email"],
    ["signin", { email: "a@b.c", password: "" }, "Fill in your e-mail and password.", "password"],
    ["signin", {}, "wrong e-mail or password", ""],
    ["setup", {}, "that is not a valid e-mail address", "email"],
    ["setup", {}, "an account with that e-mail exists already", "email"],
    ["setup", {}, "the name must be 1 to 100 characters", "name"],
    ["setup", {}, "The password must be at least 12 characters.", "password"],
    ["signin", {}, "Could not reach the server.", ""],
  ];
  it.each(rows)("%s %j: %s → %s", (kind, v, message, field) => {
    expect(m.auth.errorField(kind, v, message)).toBe(field);
  });
});

// ---- users --------------------------------------------------------------------------------------

describe("users", () => {
  const rowOf = (name: string) => main().all("tr").find((tr) => tr.all("td")[0]?.textContent.startsWith(name))!;
  const show = async () => {
    routes = {
      ...routes, "GET /api/users": USERS, "GET /api/users/limits": { defaults: { maxRunsPerDay: 10 }, users: {} }, "GET /api/users/u1/app-repos": { repos: ["acme/app"] },
    };
    await m.users.renderUsers(main(), { me: "me", page });
  };
  const open = async (name: string, label: string) => {
    press(button(rowOf(name), label));
    await dialogUp();
  };
  const dialogs: [string, string][] = [
    ["Ann", "Edit"], ["Ann", "Limits"], ["Ann", "App repositories"], ["Ann", "Reset password"], ["Ann", "Block"], ["Ann", "Delete"],
    ["Cy", "New link"], ["Lou", "Unlock"], ["Bob", "Unblock"],
  ];
  it.each(dialogs)("the dialog of %s → %s has no violations", async (name, label) => {
    await show();
    await open(name, label);
    noViolations(modalRoot());
  });
  it("Add user, the link view and Default limits have no violations", async () => {
    await show();
    press(button(main(), "+ Add user"));
    await dialogUp();
    noViolations(modalRoot());
    named(modalRoot(), "name").value = "New";
    named(modalRoot(), "email").value = "new@example.com";
    routes["POST /api/users"] = { token: TOKEN, user: user({ id: "u9", hasPassword: false }) };
    press(button(modalRoot(), "Add user"));
    await vi.waitFor(() => expect(named(modalRoot(), "link")).toBeDefined());
    noViolations(modalRoot());
    expect(named(modalRoot(), "link").attrs["aria-label"]).toBe("Set-password link");
    modalRoot().replaceChildren();
    press(button(main(), "Default limits"));
    await dialogUp();
    noViolations(modalRoot());
  });
  it("an empty name marks the name; a taken e-mail marks the e-mail; a good second try clears it", async () => {
    await show();
    press(button(main(), "+ Add user"));
    await dialogUp();
    press(button(modalRoot(), "Add user"));
    expect(alerts(modalRoot())[0]!.textContent).toBe("Fill in the name.");
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "name")]);
    expect(doc().activeElement).toBe(named(modalRoot(), "name"));
    named(modalRoot(), "name").value = "New";
    named(modalRoot(), "email").value = "ann@example.com";
    fail("POST", "/api/users", 409, "an account with that e-mail exists already");
    press(button(modalRoot(), "Add user"));
    await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe("an account with that e-mail exists already"));
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "email")]);
    expect(doc().activeElement).toBe(named(modalRoot(), "email"));
    const email = named(modalRoot(), "email");
    routes["POST /api/users"] = { token: TOKEN, user: user({ id: "u9", hasPassword: false }) };
    press(button(modalRoot(), "Add user"));
    await settle();
    expect(email.attrs["aria-invalid"]).toBeUndefined();
  });
  it("a bad role from the server marks the role", async () => {
    await show();
    await open("Ann", "Edit");
    named(modalRoot(), "name").value = "Ann B";
    fail("PUT", "/api/users/u1", 400, "the role must be admin or user");
    press(button(modalRoot(), "Save"));
    await vi.waitFor(() => expect(invalid(modalRoot())).toEqual([named(modalRoot(), "role")]));
  });
  it("the last-admin error is read out and marks no field", async () => {
    await show();
    await open("Ann", "Edit");
    named(modalRoot(), "name").value = "Ann B";
    fail("PUT", "/api/users/u1", 409, "this is the only admin that is not blocked; make another admin first");
    press(button(modalRoot(), "Save"));
    await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toContain("only admin"));
    expect(invalid(modalRoot())).toEqual([]);
  });
  it("limits: a local problem and the server's camel-case names mark the input", async () => {
    await show();
    await open("Ann", "Limits");
    named(modalRoot(), "maxRunsPerDay").value = "abc";
    press(button(modalRoot(), "Save"));
    expect(alerts(modalRoot())[0]!.textContent).toContain("Runs per day must be");
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "maxRunsPerDay")]);
    expect(doc().activeElement).toBe(named(modalRoot(), "maxRunsPerDay"));
    for (const [key, message] of [
      ["maxConcurrent", "maxConcurrent must be a whole number of 1 or more, or null"],
      ["dailyBudgetUsd", "dailyBudgetUsd must be a number above 0, or null"],
    ]) {
      named(modalRoot(), "maxRunsPerDay").value = "3";
      fail("PUT", "/api/users/u1/limits", 400, message!);
      press(button(modalRoot(), "Save"));
      await vi.waitFor(() => expect(invalid(modalRoot())).toEqual([named(modalRoot(), key!)]));
      expect(alerts(modalRoot())[0]!.textContent).toBe(message);
    }
  });
  it("app repositories: a server error marks the box", async () => {
    await show();
    await open("Ann", "App repositories");
    expect(modalRoot().all("textarea")[0]!.attrs["aria-label"]).toBe("App repositories, one per line");
    fail("PUT", "/api/users/u1/app-repos", 400, "entry 1 is not valid");
    press(button(modalRoot(), "Save"));
    await vi.waitFor(() => expect(invalid(modalRoot())).toEqual([modalRoot().all("textarea")[0]]));
  });
  it("the copy result is a status on success and an alert when it fails", async () => {
    await show();
    press(button(main(), "+ Add user"));
    await dialogUp();
    named(modalRoot(), "name").value = "New";
    named(modalRoot(), "email").value = "new@example.com";
    routes["POST /api/users"] = { token: TOKEN, user: user({ id: "u9", hasPassword: false }) };
    press(button(modalRoot(), "Add user"));
    await vi.waitFor(() => expect(named(modalRoot(), "link")).toBeDefined());
    const note = modalRoot().all("p").find((p) => (p.attrs.class ?? "").includes("status"))!;
    expect(note.attrs.role).toBe("status");
    press(button(modalRoot(), "Copy"));
    await vi.waitFor(() => expect(note.textContent).toContain("Could not copy"));
    expect(note.attrs.role).toBe("alert");
  });
});

// ---- repositories -------------------------------------------------------------------------------

describe("repositories", () => {
  it("the repository dialogs have no violations", async () => {
    void m.repos.repoDialog({ admin: true });
    await dialogUp();
    noViolations(modalRoot());
    modalRoot().replaceChildren();
    void m.repos.repoDialog({ admin: true, repo: { id: "r1", url: "https://github.com/acme/app", method: "https-token", username: "bob" } });
    await dialogUp();
    noViolations(modalRoot());
    expect(named(modalRoot(), "token").value).toBe("");
    modalRoot().replaceChildren();
    routes["GET /api/repos/r1/ready"] = { items: [{ id: "value", text: "the value is clear" }], isDefault: true };
    void m.repos.readyView({ id: "r1", url: "https://github.com/acme/app" });
    await dialogUp();
    noViolations(modalRoot());
  });
  it("an empty URL marks the URL; the server's sentences mark the URL", async () => {
    void m.repos.repoDialog({ admin: true });
    await dialogUp();
    press(button(modalRoot(), "Add repository"));
    expect(alerts(modalRoot())[0]!.textContent).toBe("Fill in the repository URL.");
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "url")]);
    expect(doc().activeElement).toBe(named(modalRoot(), "url"));
    named(modalRoot(), "url").value = "https://bad_host/acme/app";
    named(modalRoot(), "method").value = "github-token";
    named(modalRoot(), "method").fire("change");
    named(modalRoot(), "token").value = "t";
    for (const message of ["the host name is not valid", "you have that repository already", 'the path must be "name/name…" without empty parts', 'the "git" transport is not allowed']) {
      fail("POST", "/api/repos", 400, message);
      press(button(modalRoot(), "Add repository"));
      await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe(message));
      expect(invalid(modalRoot())).toEqual([named(modalRoot(), "url")]);
    }
  });
  it("a missing token marks the token; a server error about the user name marks it; the app errors mark the method", async () => {
    void m.repos.repoDialog({ admin: true });
    await dialogUp();
    named(modalRoot(), "url").value = "https://github.com/acme/app";
    named(modalRoot(), "method").value = "https-token";
    named(modalRoot(), "method").fire("change");
    named(modalRoot(), "username").value = "bob";
    press(button(modalRoot(), "Add repository"));
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "token")]);
    named(modalRoot(), "token").value = "t";
    fail("POST", "/api/repos", 400, "the user name is not valid");
    press(button(modalRoot(), "Add repository"));
    await vi.waitFor(() => expect(invalid(modalRoot())).toEqual([named(modalRoot(), "username")]));
    fail("POST", "/api/repos", 400, "the token is not valid");
    press(button(modalRoot(), "Add repository"));
    await vi.waitFor(() => expect(invalid(modalRoot())).toEqual([named(modalRoot(), "token")]));
    fail("POST", "/api/repos", 400, 'only an admin may choose "none" (the server\'s own access)');
    press(button(modalRoot(), "Add repository"));
    await vi.waitFor(() => expect(invalid(modalRoot())).toEqual([named(modalRoot(), "method")]));
  });
  it("quota and server failures mark no field", async () => {
    void m.repos.repoDialog({ admin: true });
    await dialogUp();
    named(modalRoot(), "url").value = "https://github.com/acme/app";
    named(modalRoot(), "method").value = "none";
    named(modalRoot(), "method").fire("change");
    for (const message of ["at most 50 repositories", "the repository list is not working"]) {
      fail("POST", "/api/repos", 400, message);
      press(button(modalRoot(), "Add repository"));
      await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe(message));
      expect(invalid(modalRoot())).toEqual([]);
    }
  });
  it("repoProblemAt names the field", () => {
    expect(m.repos.repoProblemAt({ url: "", method: "none" })).toEqual({ text: "Fill in the repository URL.", field: "url" });
    expect(m.repos.repoProblemAt({ url: "x", method: "https-token", values: { username: "a" } })).toEqual({ text: "Fill in the token.", field: "token" });
    expect(m.repos.repoProblemAt({ url: "x", method: "none" })).toEqual({ text: "", field: undefined });
    expect(m.repos.repoProblem({ url: "", method: "none" })).toBe("Fill in the repository URL.");
  });
  it("the removal notice is an alert", async () => {
    routes = { "GET /api/repos": [repo()], "GET /api/repos/methods": { methods: ["ssh-deploy-key"] } };
    await m.repos.renderRepos(main(), { admin: true, notice: { text: "could not remove" } });
    expect(main().all("p").find((p) => p.textContent.startsWith("could not remove"))!.attrs.role).toBe("alert");
  });
});

describe("repository administration dialogs", () => {
  const r = repo({ method: "none" });
  it("have no violations", async () => {
    for (const open of [m.adminRepos.settingsDialog, m.adminRepos.readyDialog, m.adminRepos.transferDialog]) {
      void open(r);
      await dialogUp();
      noViolations(modalRoot());
      modalRoot().replaceChildren();
    }
  });
  it("a server sentence about a setting marks that setting", async () => {
    void m.adminRepos.settingsDialog(r);
    await dialogUp();
    for (const [name, message] of [
      ["testCommand", "testCommand must be one line without control characters"],
      ["docs", '"/etc" is not a path inside the repository (not starting with "/")'],
      ["protectedBranches", '"[x" is not a branch pattern (glob)'],
      ["mainBranch", "mainBranch must be a valid git branch name"],
      ["developBranch", "developBranch must be a valid git branch name"],
    ] as const) {
      fail("PUT", "/api/admin/repos/r1/settings", 400, message);
      press(button(modalRoot(), "Save"));
      await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe(message));
      expect(invalid(modalRoot())).toEqual([named(modalRoot(), name)]);
      expect(doc().activeElement).toBe(named(modalRoot(), name));
    }
    routes["PUT /api/admin/repos/r1/settings"] = {};
    press(button(modalRoot(), "Save"));
    await settle();
  });
  it("an empty Definition of Ready item marks its input; a server error marks nothing", async () => {
    void m.adminRepos.readyDialog(r);
    await dialogUp();
    const items = () => controls(modalRoot()).filter((c) => c.attrs.name === "item");
    expect(items().map((i) => i.attrs["aria-label"]).slice(0, 2)).toEqual(["Item 1", "Item 2"]);
    items()[1]!.value = "";
    press(button(modalRoot(), "Save"));
    expect(alerts(modalRoot())[0]!.textContent).toBe("Fill in every item, or remove it.");
    expect(invalid(modalRoot())).toEqual([items()[1]]);
    expect(doc().activeElement).toBe(items()[1]);
    items()[1]!.value = "fine";
    fail("PUT", "/api/admin/repos/r1/ready", 400, "items: too many");
    press(button(modalRoot(), "Save"));
    await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe("items: too many"));
    expect(invalid(modalRoot())).toEqual([]);
  });
  it("transfer: an empty and an unknown e-mail mark the e-mail", async () => {
    void m.adminRepos.transferDialog(r);
    await dialogUp();
    press(button(modalRoot(), "Transfer"));
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "email")]);
    named(modalRoot(), "email").value = "nobody@example.com";
    fail("POST", "/api/admin/repos/r1/transfer", 404, "no account has that e-mail");
    press(button(modalRoot(), "Transfer"));
    await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe("no account has that e-mail"));
    expect(invalid(modalRoot())).toEqual([named(modalRoot(), "email")]);
    expect(doc().activeElement).toBe(named(modalRoot(), "email"));
  });
});

// ---- watchers and the monitor -------------------------------------------------------------------

describe("watcher dialogs", () => {
  const repos = [repo()];
  const flows = [{ name: "issue-gitflow" }];
  it("have no violations", async () => {
    void m.watcherForm.repoWatcherDialog({ repos, flows, existing: null });
    await dialogUp();
    noViolations(modalRoot());
    for (const b of controls(modalRoot()).filter((c) => c.attrs.type === "checkbox")) expect(b.parent!.tag).toBe("label");
    modalRoot().replaceChildren();
    void m.watcherForm.repoWatcherDialog({ repos, flows, existing: watchers[0] });
    await dialogUp();
    noViolations(modalRoot());
    modalRoot().replaceChildren();
    void m.watcherForm.monitorDialog(null, vi.fn());
    await dialogUp();
    noViolations(modalRoot());
  });
  it("no repository is an alert", async () => {
    void m.watcherForm.repoWatcherDialog({ repos: [], flows, existing: null });
    await dialogUp();
    expect(alerts(modalRoot()).map((a) => a.textContent)).toContain("No repositories yet. Add one under My repositories.");
  });
  it("a bad vars line and the server's sentences mark the field", async () => {
    void m.watcherForm.repoWatcherDialog({ repos, flows, existing: null });
    await dialogUp();
    const vars = withPlaceholder(modalRoot(), "test_cmd");
    vars.value = "oops";
    press(button(modalRoot(), "Save watcher"));
    expect(alerts(modalRoot())[0]!.textContent).toBe('vars: "oops" should be name=value');
    expect(invalid(modalRoot())).toEqual([vars]);
    expect(doc().activeElement).toBe(vars);
    vars.value = "";
    withPlaceholder(modalRoot(), "my-repo").value = "w";
    const id = withPlaceholder(modalRoot(), "my-repo");
    const cases: [string, FakeElement][] = [
      ["task: a schedule watcher needs a task", withPlaceholder(modalRoot(), "What the chore")],
      ['a watcher with the id "w" exists already; choose another id', id],
      ["every: not an interval", withPlaceholder(modalRoot(), "5m")],
      ["flow: unknown flow", controls(modalRoot()).find((c) => c.attrs.list === "watcher-flows")!],
      ["max_per_tick: too big", controls(modalRoot()).find((c) => c.attrs.type === "number")!],
    ];
    for (const [message, field] of cases) {
      fail("POST", "/api/admin/repos/r1/watchers", 400, message);
      press(button(modalRoot(), "Save watcher"));
      await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe(message));
      expect(invalid(modalRoot())).toEqual([field]);
      expect(doc().activeElement).toBe(field);
    }
  });
  it("the monitor dialog marks the id and the interval", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("every: not an interval"))
      .mockRejectedValueOnce(new Error('a watcher "monitor" already exists'))
      .mockRejectedValueOnce(new Error('invalid config: {"path": ["watchers", 0, "id"]}'))
      .mockRejectedValueOnce(new Error("the watcher id monitor is used by a repository"))
      .mockRejectedValueOnce(new Error("something else"));
    void m.watcherForm.monitorDialog(null, save);
    await dialogUp();
    const [id, every] = controls(modalRoot());
    for (const [message, field] of [["every: not an interval", every], ['a watcher "monitor" already exists', id], ['invalid config: {"path": ["watchers", 0, "id"]}', id],
      ["the watcher id monitor is used by a repository", id], ["something else", undefined]] as const) {
      press(button(modalRoot(), "Save watcher"));
      await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe(message));
      expect(invalid(modalRoot())).toEqual(field ? [field] : []);
    }
  });
});

describe("mute forms", () => {
  it("have no violations", async () => {
    for (const [target, opts] of [[{ finding: "f1" }, {}], [{ pick: true }, {}], [{ finding: "f1" }, { notProblem: true }]] as const) {
      void m.monitor.muteForm(target, monitorState.detectors, opts);
      await dialogUp();
      noViolations(modalRoot());
      modalRoot().replaceChildren();
    }
  });
  it("an empty reason marks the reason; the server's sentences mark the matching control", async () => {
    void m.monitor.muteForm({ pick: true }, monitorState.detectors);
    await dialogUp();
    const reason = withPlaceholder(modalRoot(), "Why");
    press(button(modalRoot(), "Mute"));
    expect(alerts(modalRoot())[0]!.textContent).toBe("Give a reason.");
    expect(invalid(modalRoot())).toEqual([reason]);
    expect(doc().activeElement).toBe(reason);
    reason.value = "noise";
    const [detector, , hours] = [modalRoot().all("select")[0]!, 0, modalRoot().all("select")[1]!];
    for (const [message, field] of [['"hours" must be a number above 0 and at most 8760', hours], ["unknown detector", detector]] as const) {
      fail("POST", "/api/monitor/mutes", 400, message);
      press(button(modalRoot(), "Mute"));
      await vi.waitFor(() => expect(alerts(modalRoot())[0]!.textContent).toBe(message));
      expect(invalid(modalRoot())).toEqual([field]);
    }
  });
});

// ---- Problems, Audit, Models, Settings ----------------------------------------------------------

describe("Problems", () => {
  it("an empty threshold marks its input; a server error names the threshold", async () => {
    routes = { "GET /api/monitor": monitorState, "GET /api/config": config };
    await m.problems.renderProblems(main());
    const input = controls(main()).find((c) => c.attrs["aria-label"] === "stuck-run resumes")!;
    input.value = "";
    const save = main().all("button").find((b) => b.textContent === "Save")!;
    press(save);
    await settle();
    const line = alerts(main()).find((a) => a.textContent === "Give a number.")!;
    expect(line.attrs.role).toBe("alert");
    expect(invalid(main())).toEqual([input]);
    expect(doc().activeElement).toBe(input);
    input.value = "5";
    fail("PUT", "/api/config", 400, 'invalid config: {"path": ["monitor", "stuck_run", "resumes"]}');
    press(save);
    await vi.waitFor(() => expect(line.textContent).toContain("invalid config"));
    expect(invalid(main())).toEqual([input]);
  });
  it("the load error is an alert", async () => {
    fail("GET", "/api/monitor", 500, "broken");
    await m.problems.renderProblems(main());
    expect(alerts(main())).toHaveLength(1);
    expect(alerts(main())[0]!.textContent).toContain("The problems could not be loaded. broken");
  });
});

describe("Audit", () => {
  it("From after To marks both dates, keeps the focus, and a valid range clears it", async () => {
    routes = { "GET /api/users": USERS, "GET /api/audit": { more: false, entries: [] } };
    m.audit.renderAudit(main());
    await vi.waitFor(() => expect(main().all("p").some((d) => d.textContent === "No entries.")).toBe(true));
    const from = named(main(), "from");
    const to = named(main(), "to");
    const user = named(main(), "user");
    user.focus();
    from.value = "2026-10-05";
    to.value = "2026-10-01";
    from.fire("change");
    await settle();
    expect(invalid(main())).toEqual([from, to]);
    expect(alerts(main())[0]!.textContent).toContain("The From date is after the To date.");
    expect(doc().activeElement).toBe(user);
    to.value = "2026-10-09";
    to.fire("change");
    await vi.waitFor(() => expect(invalid(main())).toEqual([]));
  });
  it("a load error is an alert", async () => {
    routes = { "GET /api/users": USERS };
    fail("GET", "/api/audit", 500, "no log");
    m.audit.renderAudit(main());
    await vi.waitFor(() => expect(alerts(main())).toHaveLength(1));
    expect(alerts(main())[0]!.textContent).toContain("no log");
  });
});

describe("Models", () => {
  const show = async () => {
    routes = { "GET /api/config": config, "GET /api/providers": providers };
    await m.models.renderModels(main());
  };
  it("names the routing controls", async () => {
    await show();
    const labels = controls(main()).map((c) => c.attrs["aria-label"]);
    for (const l of ["Step of rule 1", "Flow of rule 1", "From visit of rule 1", "Model of rule 1", "Model to try"]) expect(labels).toContain(l);
    const buttons = main().all("button").map((b) => b.attrs["aria-label"]);
    expect(buttons).toContain("Remove rule 1");
    expect(buttons).toContain("Move rule 1 up");
    expect(buttons).toContain("Reload");
  });
  it("a bad provider name marks the name and the toast is an alert", async () => {
    await show();
    const name = withPlaceholder(main(), "my-proxy");
    name.value = "Bad Name";
    press(button(main(), "Add provider"));
    await settle();
    expect(invalid(main())).toEqual([name]);
    expect(doc().activeElement).toBe(name);
    expect(document.getElementById("toast")!.getAttribute("role")).toBe("alert");
  });
  it("a rule without a model and the server's rule paths mark the model", async () => {
    await show();
    press(button(main(), "+ Rule"));
    press(button(main(), "Save routing"));
    await settle();
    const models = controls(main()).filter((c) => (c.attrs["aria-label"] ?? "").startsWith("Model of rule"));
    expect(invalid(main())).toEqual([models[1]]);
    expect(doc().activeElement).toBe(models[1]);
    models[1]!.value = "opus";
    models[1]!.fire("input", { target: models[1] });
    fail("PUT", "/api/config", 400, 'invalid config: {"path": ["router", "rules", 0, "model"]}');
    press(button(main(), "Save routing"));
    await vi.waitFor(() => expect(invalid(main())).toEqual([models[0]]));
  });
  it("a provider error from the server marks the field", async () => {
    await show();
    const name = withPlaceholder(main(), "my-proxy");
    name.value = "good";
    fail("PUT", "/api/config", 400, 'invalid config: {"path": ["providers", "good", "base_url"]}');
    press(button(main(), "Add provider"));
    await vi.waitFor(() => expect(invalid(main())).toEqual([withPlaceholder(main(), "http://localhost")]));
  });
  it("a refused model test (spec required) marks the model input, and a new try clears it", async () => {
    await show();
    const spec = controls(main()).find((c) => c.attrs["aria-label"] === "Model to try")!;
    spec.value = "";
    fail("POST", "/api/providers/test", 400, "spec required");
    press(button(main(), "Test"));
    await vi.waitFor(() => expect(invalid(main())).toEqual([spec]));
    expect(doc().activeElement).toBe(spec);
    spec.value = "haiku";
    routes["POST /api/providers/test"] = { ok: true, target: "haiku", seconds: 1 };
    press(button(main(), "Test"));
    await vi.waitFor(() => expect(invalid(main())).toEqual([]));
  });
  it("a failed model test is an alert", async () => {
    await show();
    routes["POST /api/providers/test"] = { ok: false, target: "haiku", seconds: 1, error: "no answer" };
    press(button(main(), "Test"));
    await vi.waitFor(() => expect(alerts(main()).map((a) => a.textContent.trim())).toEqual(["no answer"]));
  });
});

describe("Settings", () => {
  const show = async () => {
    routes = { "GET /api/config": config, "GET /api/info": { configPath: "/x/config.yaml", spentToday: 0, listening: "127.0.0.1" } };
    await m.admin.renderSettings(main());
  };
  it("a refused save is an alert", async () => {
    await show();
    fail("PUT", "/api/config", 400, "invalid config: nope");
    press(button(main(), "Save"));
    await vi.waitFor(() => expect(alerts(main()).map((a) => a.textContent)).toEqual(["invalid config: nope"]));
    expect(invalid(main())).toEqual([]);
  });
  it("a sentence that names a setting marks its control", async () => {
    await show();
    fail("PUT", "/api/config", 400, 'invalid config: allowed_hosts must keep "mymac.local", the name you are using now');
    press(button(main(), "Save"));
    await vi.waitFor(() => expect(invalid(main())).toEqual([withPlaceholder(main(), "mymac.local")]));
    expect(doc().activeElement).toBe(withPlaceholder(main(), "mymac.local"));
    routes["PUT /api/config"] = config;
    press(button(main(), "Save"));
    await vi.waitFor(() => expect(invalid(main())).toEqual([]));
  });
});

describe("Overview", () => {
  it("has no violations, named tables and a read-out failure notice", async () => {
    const operations = await import("../ui/operations.js" as string);
    (globalThis as any).location = { hash: "#/operations" };
    routes["GET /api/health"] = { ok: true, summary: "All good", problems: [], repos: [] };
    routes["GET /api/stats"] = { byUser: [] };
    routes["GET /api/info"] = { spentToday: 0 };
    routes["GET /api/queue"] = { active: [], pending: [], concurrency: 1 };
    routes["GET /api/watchers"] = [];
    routes["GET /api/providers"] = { agents: [{ agent: "claude", installed: true, detail: "1" }], providers: [] };
    routes["GET /api/audit"] = { entries: [{ time: "2026-10-01T08:00:00.000Z", actor: { type: "system" }, action: "x", target: null }] };
    fail("GET", "/api/queue", 500, "queue broke");
    await operations.renderOperations(main());
    noViolations(main());
    tablesOk(main());
    expect(alerts(main()).map((a) => a.textContent)).toEqual(["Not available. queue broke"]);
  });
});
