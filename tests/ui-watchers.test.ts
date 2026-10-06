import { readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let admin: any;
let form: any;
beforeAll(async () => {
  restore = installFakeDom();
  admin = await import("../ui/admin.js" as string);
  form = await import("../ui/watcher-form.js" as string);
});
afterAll(() => restore());

type Answer = { status: number; error: string };
let repos: any[];
let watchers: any[];
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let hold: { release?: () => void; promise?: Promise<void> } | undefined;
const realFetch = globalThis.fetch;

const ann = { name: "Ann", email: "ann@example.com", role: "user", status: "active" };
const repo = (over: object = {}) => ({ id: "r1", url: "https://github.com/o/a", method: "github-token", settings: {}, account: ann, ...over });
const stored = (over: object = {}) => ({
  id: "w", repoId: "r1", source: "issues", enabled: true, github_repo: "o/a", flow: "issue-gitflow", label: "go", every: "5m", max_per_tick: 1,
  state: { name: "running" }, status: { id: "w", lastActions: [] }, ...over,
});

beforeEach(() => {
  repos = [repo()];
  watchers = [];
  sent = [];
  answers = [];
  hold = undefined;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      if (url === "/api/watchers") return reply(watchers);
      if (url === "/api/admin/repos") return reply(repos);
      return reply([]);
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (hold?.promise) await hold.promise;
    const answer = answers.shift();
    return answer ? reply({ error: answer.error }, answer.status) : reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any).confirm;
});

const flush = () => new Promise((r) => setTimeout(r, 5));
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const buttons = (el: FakeElement) => walk(el).filter((e) => e.tag === "button").map((e) => e.textContent);
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const draw = async () => {
  const main = new FakeElement("div");
  await admin.renderWatchers(main);
  return main;
};
const cardOf = (main: FakeElement, id: string) => walk(main).find((e) => e.attrs.class === "card" && e.textContent.startsWith(id))!;
const inputs = (el: FakeElement) => walk(el).filter((e) => e.tag === "input");
const labelled = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "label" && e.textContent.startsWith(text))!;
const inputOf = (el: FakeElement, text: string) => walk(labelled(el, text)).find((e) => e.tag === "input" || e.tag === "textarea")!;

describe("pure functions", () => {
  const base = { id: "w", source: "issues", flow: "issue-gitflow", label: "go", exclude: "a, b,", every: "5m", max: "2", enabled: true, vars: { k: "v" }, task: "", branch: "", at: "", timezone: "" };

  it("repoWatcherBody for an add has an id, no null, and passes the API's schema", async () => {
    const { RepoWatcherSchema } = await import("../src/config.js");
    for (const v of [base, { ...base, source: "schedule", task: " chore ", at: "17:00", timezone: "Europe/Berlin", every: "1d" }]) {
      const body = form.repoWatcherBody(v, false);
      expect(body.id).toBe("w");
      expect(Object.values(body).includes(null)).toBe(false);
      expect("github_repo" in body || "owner" in body || "repoId" in body).toBe(false);
      expect(RepoWatcherSchema.safeParse(body).success).toBe(true);
    }
    const issues = form.repoWatcherBody(base, false);
    expect(issues.exclude_labels).toEqual(["a", "b"]);
    expect(issues.max_per_tick).toBe(2);
    expect("task" in issues || "at" in issues || "branch" in issues).toBe(false);
  });

  it("repoWatcherBody for an edit has no id and clears options with null", () => {
    const body = form.repoWatcherBody(base, true);
    expect("id" in body).toBe(false);
    expect([body.task, body.at, body.timezone, body.branch]).toEqual([null, null, null, null]);
    const ci = form.repoWatcherBody({ ...base, source: "ci-failures", branch: "" }, true);
    expect(ci.branch).toBeNull();
    expect(form.repoWatcherBody({ ...base, source: "ci-failures", branch: "dev" }, true).branch).toBe("dev");
  });

  it("parseVars reads lines, keeps '=' in a value, and names a bad line", () => {
    expect(form.parseVars("a=1\n\n b = x=y ")).toEqual({ vars: { a: "1", b: "x=y" } });
    expect(form.parseVars("")).toEqual({ vars: {} });
    expect(form.parseVars("a=1\noops")).toEqual({ error: 'vars: "oops" should be name=value' });
    expect(form.parseVars("=x").error).toBeDefined();
  });

  it("repoChoices splits on watcherProblem and keeps the reason", () => {
    const a = repo({ id: "a", url: "https://github.com/o/b" });
    const b = repo({ id: "b", url: "https://github.com/o/a" });
    const c = repo({ id: "c", url: "ssh://x/c", watcherProblem: "nope" });
    const r = form.repoChoices([a, c, b]);
    expect(r.available.map((x: any) => x.id)).toEqual(["b", "a"]);
    expect(r.unavailable).toEqual([{ repo: c, reason: "nope" }]);
  });

  it("watcherGroups sorts repositories, skips empty ones, and sends the rest to their sections", () => {
    const bob = { ...ann, name: "Bob", email: "bob@example.com" };
    const rs = [repo({ id: "r2", account: bob }), repo({ id: "r1" }), repo({ id: "r3", account: bob, url: "https://github.com/o/z" })];
    const ws = [
      stored({ id: "x", repoId: "r2" }), stored({ id: "y", repoId: "r1" }), stored({ id: "lost", repoId: "nope" }),
      { id: "m", source: "monitor", enabled: true, every: "1h" }, { id: "f", source: "issues", github_repo: "o/f", enabled: true },
    ];
    const g = admin.watcherGroups(ws, rs);
    expect(g.groups.map((x: any) => [x.repo.id, x.watchers.map((w: any) => w.id)])).toEqual([["r1", ["y"]], ["r2", ["x"]]]);
    expect(g.gone.map((w: any) => w.id)).toEqual(["lost"]);
    expect(g.monitor.map((w: any) => w.id)).toEqual(["m"]);
    expect(g.file.map((w: any) => w.id)).toEqual(["f"]);
  });
});

describe("the page", () => {
  it("groups by repository and shows the owner, not an owner field", async () => {
    repos = [repo(), repo({ id: "r2", url: "https://github.com/o/b", account: { ...ann, name: "Bob", email: "bob@example.com", status: "blocked" } })];
    watchers = [stored(), stored({ id: "v", repoId: "r2" })];
    const main = await draw();
    const text = main.textContent;
    expect(text).toContain("https://github.com/o/a");
    expect(text).toContain("Owner: Ann (ann@example.com)");
    expect(text).toContain("Owner: Bob (bob@example.com) blocked");
    expect(text).not.toContain("name@example.com");
  });

  it("a file watcher is read-only, with a note and Check now", async () => {
    watchers = [{ id: "f", source: "issues", enabled: true, github_repo: "o/f", flow: "issue-gitflow", label: "go", every: "5m", max_per_tick: 1 }];
    const main = await draw();
    const card = cardOf(main, "f");
    expect(card.textContent).toContain("moves to its repository at the next update");
    expect(buttons(card)).toEqual(["Check now"]);
    sent = [];
    press(button(card, "Check now"));
    await flush();
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/watchers/f/tick" });
  });

  it("Disable and Enable use the repository API, never PUT /api/config", async () => {
    watchers = [stored()];
    let main = await draw();
    press(button(cardOf(main, "w"), "Disable"));
    await flush();
    expect(sent[0]).toEqual({ method: "PUT", url: "/api/admin/repos/r1/watchers/w", body: { enabled: false } });
    watchers = [stored({ enabled: false })];
    main = await draw();
    press(button(cardOf(main, "w"), "Enable"));
    await flush();
    expect(sent[1]!.body).toEqual({ enabled: true });
    expect(sent.some((s) => s.url === "/api/config")).toBe(false);
  });

  it("Delete asks first, then sends the DELETE", async () => {
    watchers = [stored()];
    const main = await draw();
    (globalThis as any).confirm = () => false;
    press(button(cardOf(main, "w"), "Delete"));
    await flush();
    expect(sent).toEqual([]);
    (globalThis as any).confirm = () => true;
    press(button(cardOf(main, "w"), "Delete"));
    await flush();
    expect(sent).toEqual([{ method: "DELETE", url: "/api/admin/repos/r1/watchers/w", body: undefined }]);
  });

  it("shows the server's sentence as it is when Disable or Delete fails", async () => {
    watchers = [stored()];
    const main = await draw();
    answers = [{ status: 409, error: "the sentence of the server" }];
    press(button(cardOf(main, "w"), "Disable"));
    await flush();
    expect(toastText()).toBe("the sentence of the server");
    answers = [{ status: 404, error: "no such watcher" }];
    (globalThis as any).confirm = () => true;
    press(button(cardOf(await draw(), "w"), "Delete"));
    await flush();
    expect(toastText()).toBe("no such watcher");
    expect(sent.some((s) => s.url === "/api/config")).toBe(false);
  });

  it("a watcher with a problem shows it and has no Check now", async () => {
    watchers = [stored({ problem: "the owner of this repository is blocked", state: { name: "error" } })];
    const card = cardOf(await draw(), "w");
    expect(card.textContent).toContain("the owner of this repository is blocked");
    expect(buttons(card)).not.toContain("Check now");
    expect(buttons(card)).toContain("Edit");
  });

  it("a watcher of a repository that is gone can only be deleted", async () => {
    watchers = [stored({ repoId: "gone", problem: "this watcher's repository is not connected any more; delete the watcher" })];
    const main = await draw();
    expect(main.textContent).toContain("Repository not connected any more");
    const card = cardOf(main, "w");
    expect(buttons(card)).toEqual(["Delete"]);
    expect(card.textContent).toContain("not connected any more");
  });

  it("the monitor stays in config.yaml: Edit then Save sends PUT /api/config", async () => {
    watchers = [{ id: "mon", source: "monitor", enabled: true, every: "1h", state: { name: "running" }, status: { id: "mon", lastActions: [] } }];
    const configs: any[] = [];
    const get = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => (url === "/api/config" && init.method === "GET"
      ? { ok: true, status: 200, statusText: "x", json: async () => ({ watchers: [{ id: "mon", source: "monitor", every: "1h", enabled: true }] }) }
      : (init.method === "PUT" && configs.push(JSON.parse(init.body)), get(url, init)));
    const main = await draw();
    expect(main.textContent).toContain("The Foundry itself");
    expect(buttons(main)).not.toContain("+ Add the monitor");
    press(button(cardOf(main, "mon"), "Edit"));
    inputOf(root(), "Check every").value = "30m";
    press(button(root(), "Save watcher"));
    await flush();
    expect(configs[0].watchers).toEqual([{ id: "mon", source: "monitor", every: "30m", enabled: true }]);
  });

  it("+ Add the monitor shows only when there is none", async () => {
    watchers = [];
    expect(buttons(await draw())).toContain("+ Add the monitor");
  });

  it("an empty page offers to add a watcher", async () => {
    const main = await draw();
    expect(main.textContent).toContain("No watchers yet.");
    expect(buttons(main).filter((b) => b === "+ Add watcher")).toHaveLength(2);
  });
});

describe("the dialog", () => {
  const open = (extra: object = {}) => {
    const done = form.repoWatcherDialog({ repos, flows: [{ name: "issue-gitflow" }], existing: null, ...extra });
    return done as Promise<unknown>;
  };

  it("lists only available repositories and the others with their reason", async () => {
    repos = [repo(), repo({ id: "r2", url: "ssh://git@x/y.git", method: "ssh-deploy-key", watcherProblem: "a watcher needs a GitHub repository" })];
    void open();
    const select = field(root(), "repo")!;
    expect(walk(select).map((o) => o.value)).toEqual(["r1"]);
    expect(root().textContent).toContain("Not available:");
    expect(root().textContent).toContain("ssh://git@x/y.git — a watcher needs a GitHub repository");
    expect(inputs(root()).some((i) => i.attrs.placeholder === "name@example.com")).toBe(false);
    expect(walk(field(root(), "source")!).map((o) => o.value)).not.toContain("monitor");
  });

  it("Save posts to the chosen repository with the body", async () => {
    const done = open();
    inputOf(root(), "Id").value = "w1";
    inputOf(root(), "Trigger label").value = "go";
    press(button(root(), "Save watcher"));
    expect(await done).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url).toBe("/api/admin/repos/r1/watchers");
    expect(sent[0]!.body).toMatchObject({ id: "w1", source: "issues", flow: "issue-gitflow", label: "go", every: "5m", max_per_tick: 1, enabled: true, vars: {}, exclude_labels: [] });
    expect(sent[0]!.body.owner).toBeUndefined();
  });

  it("without an available repository Save is off and sends nothing", async () => {
    repos = [repo({ watcherProblem: "nope" })];
    void open();
    expect(field(root(), "repo")).toBeUndefined();
    expect(root().textContent).toContain("No connected repository can have a watcher.");
    const save = button(root(), "Save watcher")!;
    expect(save.attrs.disabled).toBeDefined();
    save.click();
    await flush();
    expect(sent).toEqual([]);
  });

  it("an answer of the API stays in the dialog, as it is", async () => {
    answers = [{ status: 409, error: 'a watcher with the id "w" exists already; choose another id' }];
    let closed = false;
    void open().then(() => (closed = true));
    inputOf(root(), "Id").value = "w";
    press(button(root(), "Save watcher"));
    await flush();
    expect(closed).toBe(false);
    expect(root().textContent).toContain('a watcher with the id "w" exists already; choose another id');
    expect(button(root(), "Save watcher")!.disabled).toBe(false);
  });

  it("a double click sends one request, and Escape does nothing while it runs", async () => {
    let release!: () => void;
    hold = { promise: new Promise<void>((r) => (release = r)) };
    const done = open();
    inputOf(root(), "Id").value = "w";
    const save = button(root(), "Save watcher")!;
    save.click();
    save.click();
    await flush();
    expect(sent).toHaveLength(1);
    for (const fn of (document as any).listeners.keydown ?? []) fn({ key: "Escape" });
    expect(root().children.length).toBeGreaterThan(0);
    release();
    expect(await done).toBe(true);
  });

  it("Edit sends PUT to the watcher's repository, without id, and the id is fixed", async () => {
    const existing = stored({ repoId: "r9", task: "old", at: "07:00" });
    const done = open({ existing });
    const id = inputOf(root(), "Id");
    expect(id.attrs.disabled).toBeDefined();
    expect(root().textContent).not.toContain("Not available");
    press(button(root(), "Save watcher"));
    expect(await done).toBe(true);
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toBe("/api/admin/repos/r9/watchers/w");
    expect("id" in sent[0]!.body).toBe(false);
    expect(sent[0]!.body).toMatchObject({ task: null, at: null, timezone: null, branch: null });
  });

  it("a failed Edit keeps the dialog open with the server's text", async () => {
    answers = [{ status: 400, error: "task: a schedule watcher needs a task" }];
    let closed = false;
    void open({ existing: stored() }).then(() => (closed = true));
    press(button(root(), "Save watcher"));
    await flush();
    expect(closed).toBe(false);
    expect(root().textContent).toContain("task: a schedule watcher needs a task");
  });

  it("a bad vars line shows an error and sends nothing", async () => {
    void open();
    inputOf(root(), "Variables for each run").value = "oops";
    press(button(root(), "Save watcher"));
    await flush();
    expect(sent).toEqual([]);
    expect(root().textContent).toContain('vars: "oops" should be name=value');
  });
});

describe("the user side", () => {
  const ui = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ui(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

  it("no file in ui/user/ knows about watchers or imports the admin page", () => {
    const files = ui("ui/user").filter((f) => /\.(js|html)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/watcher/i);
      expect(text, f).not.toMatch(/admin\.js|watcher-form\.js/);
    }
  });

  it("the admin page has the Watchers link", () => {
    expect(readFileSync("ui/index.html", "utf8")).toMatch(/#\/watchers/);
  });
});
