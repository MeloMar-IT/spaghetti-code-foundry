import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let view: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/repos.js" as string);
  view = await import("../ui/repo-view.js" as string);
});
afterAll(() => restore());

type Answer = { status: number; error: string };
let repos: any[];
let sent: string[];
let answers: Answer[];
let runsAnswer: any[];
let runsFail: boolean;
let methodsAnswer: any;
let repoGets: (Answer | undefined)[];
let gates: { reposGet?: (() => void)[]; put?: (() => void)[]; test?: (() => void)[] };
let testResult: any;
const realFetch = globalThis.fetch;
const APP_URL = "https://github.com/apps/foundry-app/installations/new";
const SSH = "git@github.com:o/a.git";
let n = 1;
const rec = (over: object = {}) => ({ id: `r${n++}`, url: "https://github.com/o/a", method: "github-token", added: "2026-03-04T10:00:00.000Z", ...over });
const deployRec = (over: object = {}) => rec({ url: SSH, method: "ssh-deploy-key", publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIkey${n}`, ...over });
const goodConn = () => ({
  at: new Date().toISOString(), ok: true,
  checks: [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }, { check: "push", ok: true, code: "ok", message: "Write access works." }, { check: "github-api", ok: true, code: "ok", message: "Issues work." }],
});
const badConn = () => ({
  at: new Date().toISOString(), ok: false,
  checks: [{ check: "clone", ok: false, code: "bad-token", message: "The host did not accept the token." }, { check: "push", ok: false, skipped: true, code: "skipped", message: "Not checked." }],
});

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
const wait = (list?: (() => void)[]) => (list ? new Promise<void>((r) => list.push(r)) : undefined);

beforeEach(() => {
  repos = [];
  sent = [];
  answers = [];
  runsAnswer = [];
  runsFail = false;
  repoGets = [];
  gates = {};
  testResult = goodConn();
  methodsAnswer = { methods: ["github-token", "https-token", "ssh-deploy-key", "none"], githubApp: { available: false } };
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET" && url === "/api/repos/methods") return methodsAnswer ? reply(methodsAnswer) : reply({ error: "x" }, 404);
    if (init.method === "GET" && url.startsWith("/api/runs")) {
      if (runsFail) return reply({ error: "x" }, 500);
      const status = new URL(url, "http://x").searchParams.get("status");
      return reply(runsAnswer.filter((r) => !status || r.status === status));
    }
    if (init.method === "GET" && url.startsWith("/api/outcomes")) return reply({ values: { flows: [] }, definitions: [], measures: [] });
    if (init.method === "GET" && url.endsWith("/ready")) return reply({ items: [{ id: "a", text: "first" }], isDefault: true });
    if (init.method === "GET") {
      const f = repoGets.shift();
      const g = gates.reposGet;
      gates.reposGet = undefined;
      const snapshot = [...repos];
      if (g) await wait(g);
      return f ? reply({ error: f.error }, f.status) : reply(snapshot);
    }
    sent.push(`${init.method} ${url}`);
    if (init.method === "PUT") {
      const g = gates.put;
      gates.put = undefined;
      if (g) await wait(g);
    }
    if (init.method === "POST" && url.endsWith("/test")) {
      const g = gates.test;
      gates.test = undefined;
      if (g) await wait(g);
    }
    const a = answers.shift();
    if (a) return reply({ error: a.error }, a.status);
    if (init.method === "POST" && url.endsWith("/test")) {
      repos = repos.map((r) => (`/api/repos/${r.id}/test` === url ? { ...r, connection: testResult } : r));
      return reply(testResult);
    }
    if (init.method === "PUT") {
      const at = repos.findIndex((r) => `/api/repos/${r.id}/auth` === url);
      repos[at] = { ...repos[at], publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAInew${n++}` };
      return reply(repos[at]);
    }
    if (init.method === "DELETE") repos = repos.filter((r) => `/api/repos/${r.id}` !== url);
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
const section = (id: string) => walk(main()).find((e) => e.attrs.id === `repo-section-${id}`)!;
const titles = () => walk(main()).filter((e) => e.tag === "section" && (e.attrs.id ?? "").startsWith("repo-section-")).map((e) => e.attrs.id!.replace("repo-section-", ""));
const answerDialog = async (label: string) => {
  await flush();
  press(button(root(), label));
};
const show = async (r: any, opts: object = {}) => {
  repos = [r];
  const navs: string[] = [];
  const off = await view.renderRepo(main(), { id: r.id, nav: (h: string) => navs.push(h), ...opts });
  return { navs, off };
};

describe("a source that returns foreign and back", () => {
  it("hides the owner-only actions and uses the returned back link", async () => {
    const r = deployRec();
    repos = [r];
    const source = { load: async () => ({ repo: r, foreign: true, back: { label: "Repositories", href: "#/all-repos" } }) };
    await view.renderRepo(main(), { id: r.id, admin: true, nav: () => {}, source });
    expect(button(main(), "Change authentication")).toBeUndefined();
    expect(button(main(), "Remove")).toBeUndefined();
    expect(button(main(), "Generate a new key")).toBeUndefined();
    expect(section("danger").textContent).toContain("Only the owner can remove this repository or generate a new key.");
    expect(walk(main()).find((e) => e.tag === "a" && e.textContent === "Repositories")!.attrs.href).toBe("#/all-repos");
  });
});

describe("the sections", () => {
  it("draws Overview, Connection and Dangerous actions in that order, the last one as a fail card", async () => {
    await show(rec());
    expect(titles()).toEqual(["overview", "connection", "outcomes", "danger"]);
    expect(section("danger").attrs.class).toContain("scf-card--fail");
    expect(section("overview").attrs.class).toContain("scf-card--neutral");
    expect(button(section("danger"), "Generate a new key")).toBeUndefined();
    expect(button(section("danger"), "Remove")).toBeDefined();
    expect(section("connection").textContent).not.toContain("Public key");
  });

  it("shows provider, identity and scope of a token, a deploy key and a repository on another host", async () => {
    await show(rec({ method: "https-token", username: "ann" }));
    expect(section("connection").textContent).toContain("ProviderGitHubIdentitytoken of annScopeRead not checked, Write not checked, GitHub API not checked");
    expect(section("connection").textContent).not.toContain("User name");
    await show(rec());
    expect(section("connection").textContent).toContain("Identityfine-grained token");
    await show(deployRec());
    expect(section("connection").textContent).toContain("Identitydeploy key ssh-ed25519");
    expect(section("connection").textContent).toContain("GitHub API not checked, limited to this repository");
    await show(rec({ url: "https://Git.Example.org/x/y", method: "https-token", username: "bob" }));
    expect(section("connection").textContent).toContain("Providergit.example.org");
  });

  it("shows the result of the last test in the scope, with a skipped check as not checked", async () => {
    await show(rec({ connection: badConn() }));
    expect(section("connection").textContent).toContain("Read failed, Write not checked, GitHub API not checked");
    await show(rec({ connection: goodConn() }));
    expect(section("connection").textContent).toContain("Read works, Write works, GitHub API works");
  });

  it("never asks for the stored credentials", async () => {
    const urls: string[] = [];
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = (url: string, init: any) => (urls.push(url), real(url, init));
    await show(rec());
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes("/api/admin/credentials"))).toBe(false);
  });

  it("shows the key with Copy and the hint for a deploy key, and Generate a new key under danger", async () => {
    const r = deployRec();
    await show(r);
    expect(section("connection").textContent).toContain(r.publicKey);
    expect(section("connection").textContent).toContain(ui.DEPLOY_KEY_HINT);
    expect(button(section("connection"), "Copy")).toBeDefined();
    expect(button(section("danger"), "Generate a new key")).toBeDefined();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    press(button(section("connection"), "Copy"));
    await flush();
    expect(writeText).toHaveBeenCalledWith(r.publicKey);
    expect(toastText()).toBe("Public key copied");
    vi.stubGlobal("navigator", {});
    press(button(section("connection"), "Copy"));
    await flush();
    expect(toastText()).toBe("Could not copy. Select the key and copy it yourself.");
  });

  it("shows the install link for a GitHub App, and the removed line when the app is gone", async () => {
    methodsAnswer = { methods: ["github-app"], githubApp: { available: true, installUrl: APP_URL } };
    await show(rec({ method: "github-app" }));
    expect(walk(section("connection")).find((e) => e.tag === "a")!.attrs.href).toBe(APP_URL);
    methodsAnswer = { methods: ["github-token"], githubApp: { available: false } };
    await show(rec({ method: "github-app" }));
    expect(section("connection").textContent).toContain("The administrator removed the GitHub App.");
    expect(walk(section("connection")).some((e) => e.tag === "a")).toBe(false);
  });

  it("offers the install link as the next action for an app that is not installed", async () => {
    methodsAnswer = { methods: ["github-app"], githubApp: { available: true, installUrl: APP_URL } };
    const c = { ...badConn(), checks: [{ check: "github-api", ok: false, code: "app-not-installed", message: "The app is not installed." }] };
    await show(rec({ method: "github-app", connection: c }));
    expect(walk(section("overview")).find((e) => e.tag === "a" && e.attrs.href === APP_URL)).toBeDefined();
  });

  it("Overview: name link, address, state, next action, runs and the added date", async () => {
    runsAnswer = [{ status: "running", vars: { github_repo: "o/a" } }, { status: "waiting", vars: { github_repo: "o/a" } }];
    const r = rec({ github: "o/a" });
    await show(r);
    const text = section("overview").textContent;
    expect(text).toContain("o/a");
    expect(text).toContain(r.url);
    expect(text).toContain("Test connection");
    expect(text).toContain(new Date(r.added).toLocaleDateString());
    expect(walk(section("overview")).find((e) => e.tag === "a")!.attrs.href).toBe("https://github.com/o/a");
    await flush();
    expect(walk(section("overview")).find((e) => e.attrs["data-runs"] === r.id)!.textContent).toBe("2");
    runsFail = true;
    await show(r);
    await flush();
    expect(walk(section("overview")).find((e) => e.attrs["data-runs"] === r.id)!.textContent).toBe("—");
    await show({ ...r, added: undefined });
    expect(section("overview").textContent).toContain("Added");
    expect(section("overview").textContent).not.toContain("Invalid");
  });

  it("Overview shows the autonomy level: a user is told only an admin can change it, an admin gets the link", async () => {
    await show(rec({ autonomy: "plan-only" }));
    const text = section("overview").textContent;
    expect(text).toContain("Autonomy level");
    expect(text).toContain("plan-only");
    expect(text).toContain("Only an admin can change it.");
    expect(walk(section("overview")).some((e) => e.tag === "a" && e.attrs.href === "#/autonomy")).toBe(false);
    expect(walk(section("overview")).some((e) => e.tag === "button" && /autonomy|promote|demote/i.test(e.textContent))).toBe(false);
    await show(rec({ autonomy: "observe" }), { admin: true });
    const link = walk(section("overview")).find((e) => e.tag === "a" && e.attrs.href === "#/autonomy");
    expect(link).toBeDefined();
    expect(section("overview").textContent).not.toContain("Only an admin can change it.");
  });

  it("Overview has no autonomy row when the record has no level", async () => {
    await show(rec());
    expect(section("overview").textContent).not.toContain("Autonomy level");
  });

  it("Overview says there is nothing to do for a connected repository", async () => {
    await show(rec({ connection: goodConn() }));
    expect(section("overview").textContent).toContain("Nothing to do");
  });

  it("Connection lists every check of a good test, and says when there was none", async () => {
    await show(rec({ connection: goodConn() }));
    const lines = byClass(section("connection"), "status").map((e) => e.textContent);
    expect(lines).toEqual(["Read: The repository can be read.", "Write: Write access works.", "GitHub API: Issues work."]);
    expect(section("connection").textContent).toContain("Connected");
    await show(rec());
    expect(section("connection").textContent).toContain("Not tested yet");
  });

  it("Connection shows a test that could not run, with Test again", async () => {
    await show(rec());
    answers.push({ status: 409, error: "a test of this repository is running already" });
    press(button(section("connection"), "Test connection"));
    await flush();
    await flush();
    expect(section("connection").textContent).toContain("The test could not run. a test of this repository is running already");
    expect(button(section("connection"), "Test again")).toBeDefined();
    testResult = badConn();
    press(button(section("connection"), "Test again"));
    await flush();
    await flush();
    expect(section("connection").textContent).not.toContain("The test could not run.");
    expect(section("connection").textContent).toContain("Read: The host did not accept the token.");
  });

  it("opens the Definition of Ready dialog and the authentication dialog", async () => {
    await show(rec());
    press(button(section("overview"), "Definition of Ready"));
    await flush();
    expect(root().textContent).toContain("The default list.");
    (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
    await flush();
    press(button(section("connection"), "Change authentication"));
    expect(root().textContent).toContain("Change authentication");
  });

  it("takes extra sections in order, and skips one that is not shown", async () => {
    const sections = [
      { id: "one", title: "One", show: () => true, draw: () => "first" },
      { id: "hidden", title: "Hidden", show: () => false, draw: () => "no" },
      ...view.SECTIONS,
    ];
    await show(rec(), { sections });
    expect(titles()).toEqual(["one", "overview", "connection", "outcomes", "danger"]);
    expect(view.SECTIONS.at(-1).id).toBe("danger");
  });
});

describe("unknown repository, name and loading", () => {
  it("says no such repository with a link back, and names nothing", async () => {
    const onName = vi.fn();
    repos = [rec()];
    await view.renderRepo(main(), { id: "other", onName });
    expect(main().textContent).toContain(view.NO_REPO);
    expect(walk(main()).find((e) => e.tag === "a")!.attrs.href).toBe("#/repos");
    expect(onName).not.toHaveBeenCalled();
  });

  it("names the page with the repository name", async () => {
    const onName = vi.fn();
    await show(rec({ github: "o/a" }), { onName });
    expect(onName).toHaveBeenCalledWith("o/a");
    expect(walk(main()).find((e) => e.tag === "h1")!.textContent).toBe("o/a");
    expect(walk(main()).find((e) => e.tag === "a" && e.attrs.href === "#/repos")!.textContent).toContain("My repositories");
  });

  it("shows an error with Retry on a failed first load, and a permission state on 403", async () => {
    repos = [rec()];
    repoGets.push({ status: 500, error: "down" });
    await view.renderRepo(main(), { id: repos[0].id });
    expect(buttons().map((b) => b.textContent)).toContain("Retry");
    press(button(main(), "Retry"));
    await flush();
    expect(main().textContent).toContain("https://github.com/o/a");
    repoGets.push({ status: 403, error: "no" });
    await view.renderRepo(main(), { id: repos[0].id });
    expect(main().textContent).toContain("You are not allowed to see this repository.");
  });

  it("tolerates a failed methods call", async () => {
    methodsAnswer = undefined;
    await show(rec());
    expect(titles()).toEqual(["overview", "connection", "outcomes", "danger"]);
  });
});

describe("read-only", () => {
  it("shows the three sections with no button and no install link", async () => {
    methodsAnswer = { methods: ["github-app"], githubApp: { available: true, installUrl: APP_URL } };
    const c = { ...badConn(), checks: [{ check: "github-api", ok: false, code: "app-not-installed", message: "The app is not installed." }] };
    await show(rec({ method: "github-app", connection: c }), { readOnly: true });
    expect(titles()).toEqual(["overview", "connection", "outcomes", "danger"]);
    expect(buttons()).toEqual([]);
    expect(walk(main()).some((e) => e.attrs.href === APP_URL)).toBe(false);
    expect(section("danger").textContent).toContain("Remove is not available in a read-only view.");
    expect(section("connection").textContent).toContain("The app is not installed.");
    expect(section("connection").textContent).toContain("Failed");
  });

  it("names both actions for a deploy key and hides Copy", async () => {
    const r = deployRec();
    await show(r, { readOnly: true });
    expect(buttons()).toEqual([]);
    expect(section("connection").textContent).toContain(r.publicKey);
    expect(section("danger").textContent).toContain("Generate a new key and Remove are not available in a read-only view.");
  });
});

describe("the questions", () => {
  it("Remove names the address, the settings and the watchers, and the credential only where there is one", () => {
    const text = (method: string) => ui.removeQuestion({ url: "https://github.com/o/a", method }).text as string;
    for (const m of ["ssh-deploy-key", "github-token", "https-token", "github-app", "none"]) {
      expect(text(m)).toContain("https://github.com/o/a");
      expect(text(m)).toContain("settings");
      expect(text(m)).toContain("watchers");
    }
    expect(text("ssh-deploy-key")).toContain("stored key");
    expect(text("ssh-deploy-key")).not.toContain("token");
    for (const m of ["github-token", "https-token"]) {
      expect(text(m)).toContain("stored token");
      expect(text(m)).not.toContain("key");
    }
    expect(text("github-app")).toContain("The app stays installed on GitHub.");
    expect(text("github-app")).not.toContain("token");
    expect(text("none")).not.toMatch(/token|stored key|app stays/);
    expect(ui.removeQuestion({ url: "u", method: "none" })).toMatchObject({ title: "Remove repository", confirm: "Remove" });
  });

  it("Generate a new key names the address", () => {
    expect(ui.newKeyQuestion({ url: SSH })).toEqual({
      title: "Generate a new key",
      text: `Generate a new key for ${SSH}? The old key is deleted and stops working. Add the new public key as a deploy key and remove the old one.`,
      confirm: "Generate a new key",
    });
  });

  it("Remove on the view asks first, Cancel sends nothing, Confirm removes and goes back", async () => {
    const r = rec({ method: "github-app" });
    const { navs } = await show(r);
    press(button(section("danger"), "Remove"));
    await flush();
    expect(root().textContent).toContain(`Remove ${r.url} from the Foundry?`);
    press(button(root(), "Cancel"));
    await flush();
    expect(sent).toEqual([]);
    expect(button(section("danger"), "Remove")!.disabled).toBeFalsy();
    press(button(section("danger"), "Remove"));
    await answerDialog("Remove");
    await flush();
    expect(sent).toEqual([`DELETE /api/repos/${r.id}`]);
    expect(toastText()).toBe("Repository removed");
    expect(navs).toEqual(["#/repos"]);
  });

  it("a 500 on Remove shows the alert with Try again, and the retry sends a DELETE without a question", async () => {
    const r = rec();
    const { navs } = await show(r);
    answers.push({ status: 500, error: "an old key is still in the Keychain" });
    press(button(section("danger"), "Remove"));
    await answerDialog("Remove");
    await flush();
    const alert = walk(main()).find((e) => e.attrs.role === "alert")!;
    expect(alert.textContent).toContain("an old key is still in the Keychain");
    press(button(alert, "Try again"));
    await flush();
    expect(root().children).toHaveLength(0);
    expect(sent).toEqual([`DELETE /api/repos/${r.id}`, `DELETE /api/repos/${r.id}`]);
    expect(navs).toEqual(["#/repos"]);
  });

  it("a 409 on Remove shows the alert and no Try again", async () => {
    await show(rec());
    answers.push({ status: 409, error: "a run is using it" });
    press(button(section("danger"), "Remove"));
    await answerDialog("Remove");
    await flush();
    expect(walk(main()).find((e) => e.attrs.role === "alert")!.textContent).toBe("a run is using it");
    expect(button(main(), "Try again")).toBeUndefined();
  });

  it("Generate a new key sends nothing before the question, then shows the new key; a failure shows the alert", async () => {
    const r = deployRec();
    await show(r);
    press(button(section("danger"), "Generate a new key"));
    await flush();
    expect(sent).toEqual([]);
    await answerDialog("Generate a new key");
    await flush();
    await flush();
    expect(sent).toEqual([`PUT /api/repos/${r.id}/auth`]);
    expect(toastText()).toBe("New key generated");
    expect(section("connection").textContent).toContain(repos[0].publicKey);
    expect(section("connection").textContent).not.toContain(r.publicKey);
    answers.push({ status: 500, error: "the SSH key could not be made" });
    press(button(section("danger"), "Generate a new key"));
    await answerDialog("Generate a new key");
    await flush();
    await flush();
    expect(walk(main()).find((e) => e.attrs.role === "alert")!.textContent).toBe("the SSH key could not be made");
  });
});

describe("one action at a time", () => {
  it("keeps every action button disabled while a new key is made, also when the runs answer arrives", async () => {
    const r = deployRec();
    runsAnswer = [{ status: "running", vars: { github_repo: "o/a" } }];
    await show({ ...r, github: "o/a" });
    gates.put = [];
    press(button(section("danger"), "Generate a new key"));
    await answerDialog("Generate a new key");
    await flush();
    expect(sent).toEqual([`PUT /api/repos/${r.id}/auth`]);
    await flush();
    expect(walk(section("overview")).find((e) => e.attrs["data-runs"] === r.id)!.textContent).toBe("1");
    const all = buttons().filter((b) => b.attrs["data-action"]);
    expect(all.length).toBeGreaterThan(2);
    expect(all.every((b) => b.disabled)).toBe(true);
    press(button(section("danger"), "Generate a new key"));
    await flush();
    expect(root().children).toHaveLength(0);
    expect(sent).toHaveLength(1);
    gates.put?.length;
  });

  it("enables the buttons again after the action", async () => {
    const r = deployRec();
    await show(r);
    press(button(section("danger"), "Generate a new key"));
    await answerDialog("Generate a new key");
    await flush();
    await flush();
    expect(buttons().filter((b) => b.attrs["data-action"]).every((b) => !b.disabled)).toBe(true);
  });

  it("locks the second test control while the first test runs: one POST", async () => {
    const r = rec();
    await show(r);
    const tests = buttons().filter((b) => b.textContent === "Test connection");
    expect(tests).toHaveLength(2);
    gates.test = [];
    press(tests[0]);
    await flush();
    expect(tests[1]!.disabled).toBe(true);
    press(tests[1]);
    await flush();
    expect(sent).toEqual([`POST /api/repos/${r.id}/test`]);
    gates.test = undefined;
  });

  it("draws the action buttons disabled when the page is drawn again while an action is pending", async () => {
    const r = rec();
    await show(r);
    repoGets.push({ status: 500, error: "down" });
    gates.test = [];
    // the test is held after its POST started; a reload from the stale note path would redraw: use the held POST's page
    press(button(section("connection"), "Test connection"));
    await flush();
    expect(buttons().filter((b) => b.attrs["data-action"]).every((b) => b.disabled)).toBe(true);
  });
});

describe("a stale load", () => {
  const hold = async (id: string, opts: object = {}) => {
    const g: (() => void)[] = [];
    gates.reposGet = g;
    const done = view.renderRepo(main(), { id, nav: () => {}, ...opts });
    await flush();
    return { release: () => g.forEach((r) => r()), done };
  };

  it("draws nothing after the cleanup", async () => {
    const r = rec();
    repos = [r];
    (globalThis as any).location = { hash: `#/repos/${r.id}` };
    const onName = vi.fn();
    const h = await hold(r.id, { onName });
    main().textContent = "other";
    const off = await Promise.race([flush().then(() => null)]);
    expect(off).toBeNull();
    h.release();
    const stop = await h.done;
    stop();
    expect(onName).toHaveBeenCalledTimes(1); // it was live when it answered
  });

  it("draws nothing when the hash has moved to the list or to another repository", async () => {
    const r = rec();
    repos = [r];
    for (const hash of ["#/repos", "#/repos/other"]) {
      (globalThis as any).location = { hash: `#/repos/${r.id}` };
      const h = await hold(r.id);
      main().textContent = "other";
      (globalThis as any).location = { hash };
      h.release();
      await h.done;
      expect(main().textContent, hash).toBe("other");
    }
  });

  it("draws nothing for an older render once a newer one took over", async () => {
    const r = rec();
    repos = [r];
    (globalThis as any).location = { hash: `#/repos/${r.id}` };
    const h = await hold(r.id);
    main().textContent = "other";
    const off = await view.renderRepo(main(), { id: r.id, nav: () => {} });
    expect(main().textContent).toContain(r.url);
    main().textContent = "newer";
    h.release();
    await h.done;
    expect(main().textContent).toBe("newer");
    off();
  });

  it("decodes the address when it checks the page", async () => {
    const r = rec({ id: "a b" });
    repos = [r];
    (globalThis as any).location = { hash: "#/repos/a%20b" };
    await view.renderRepo(main(), { id: r.id, nav: () => {} });
    expect(main().textContent).toContain(r.url);
    (globalThis as any).location = { hash: "#/repos/a%20b/x" };
    main().textContent = "other";
    await view.renderRepo(main(), { id: r.id, nav: () => {} });
    expect(main().textContent).toBe("other");
  });

  it("keeps the page with a stale note when a reload fails, and the newest reload draws", async () => {
    const r = rec();
    await show(r);
    repoGets.push({ status: 500, error: "down" });
    press(button(section("connection"), "Test connection"));
    await flush();
    await flush();
    expect(byClass(main(), "stale-note")[0]!.attrs.class).toContain("failed");
    expect(section("overview").textContent).toContain(r.url);
  });
});

describe("shared helpers", () => {
  it("repoHref escapes the id", () => {
    expect(ui.repoHref({ id: "r1" })).toBe("#/repos/r1");
    expect(ui.repoHref({ id: "a b/c" })).toBe("#/repos/a%20b%2Fc");
  });

  it("connectionLines with all returns every check of a good test", () => {
    expect(ui.connectionLines({ connection: goodConn() }, { all: true }).map((l: any) => l.text)).toEqual([
      "Read: The repository can be read.", "Write: Write access works.", "GitHub API: Issues work.",
    ]);
    expect(ui.connectionLines({ connection: goodConn() })).toEqual([]);
    expect(ui.connectionLines({}, { all: true })).toEqual([]);
  });

  it("fillRuns writes the count, a dash with a title, or dots", () => {
    const el = new FakeElement("span");
    ui.fillRuns(el, undefined, { github: "o/a" });
    expect(el.textContent).toBe("…");
    ui.fillRuns(el, null, { github: "o/a" });
    expect(el.textContent).toBe("—");
    expect(el.attrs.title).toBe("The runs could not be loaded.");
    ui.fillRuns(el, [{ status: "running", vars: { github_repo: "o/a" } }], { github: "o/a" });
    expect(el.textContent).toBe("1");
    expect(el.attrs.title).toBeUndefined();
  });
});
