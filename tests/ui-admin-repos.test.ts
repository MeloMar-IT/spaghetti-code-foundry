import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READY } from "../src/refinement/ready-list.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin-repos.js" as string);
  api = (await import("../ui/api.js" as string)).api;
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

type Answer = { status: number; error: string };
let repos: any[];
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let heldGets: (() => void)[][];
/** The next GETs fail with these answers (in order) instead of returning the list. */
let getFails: (Answer | "throw")[];
const realFetch = globalThis.fetch;
let nextId = 1;

beforeEach(() => {
  repos = [];
  sent = [];
  answers = [];
  heldGets = [];
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  getFails = [];
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET" && url === "/api/repos/methods") return reply({ methods: ["github-token", "ssh-deploy-key", "https-token", "github-app", "none"], githubApp: { available: true } });
    if (init.method === "GET" && url.startsWith("/api/runs")) return reply([]);
    if (init.method === "GET") {
      const failed = getFails.shift();
      if (failed === "throw") throw new TypeError("fetch failed");
      if (failed) return reply({ error: failed.error }, failed.status);
      const snapshot = [...repos];
      const wait = heldGets.shift();
      if (wait) await new Promise<void>((r) => wait.push(r));
      return reply(snapshot);
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.shift();
    return answer ? reply({ error: answer.error }, answer.status) : reply({});
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
const byClass = (el: FakeElement, cls: string) => walk(el).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const rec = (over: object = {}) => ({
  id: `r${nextId++}`,
  url: "https://github.com/o/a",
  method: "github-token",
  settings: {},
  ready: { items: DEFAULT_READY.map(({ id, text }) => ({ id, text, rule: id })), isDefault: true },
  account: { name: "Ann", email: "ann@example.com", role: "user", status: "active" },
  ...over,
});
const show = () => ui.renderAllRepos(main());
const errText = (el: FakeElement) => byClass(el, "status").filter((e) => (e.attrs.class ?? "").split(" ").includes("bad")).map((e) => e.textContent).join("");

describe("pure functions", () => {
  it("settingsBody sends every setting, trimmed", () => {
    expect(ui.settingsBody({ testCommand: " npm test ", docs: " a.md \n\n b.md\n", protectedBranches: "release/*\n", mainBranch: " main", developBranch: "" })).toEqual({
      testCommand: "npm test",
      docs: ["a.md", "b.md"],
      protectedBranches: ["release/*"],
      mainBranch: "main",
      developBranch: "",
      releaseRecipe: "",
      questions: { decide_technical: true },
    });
    expect(ui.settingsBody({ decideTechnical: false }).questions).toEqual({ decide_technical: false });
    expect(ui.settingsBody({ releaseRecipe: "builds:\n  - x\n" }).releaseRecipe).toBe("builds:\n  - x\n");
    expect(ui.settingsBody()).toEqual({ testCommand: "", docs: [], protectedBranches: [], mainBranch: "", developBranch: "", releaseRecipe: "", questions: { decide_technical: true } });
  });

  it("ownerText and sortRepos", () => {
    expect(ui.ownerText(rec())).toBe("Ann (ann@example.com)");
    expect(ui.ownerText({ account: null })).toBe("Unknown account");
    expect(ui.ownerText({})).toBe("Unknown account");
    const bob = rec({ url: "z", account: { name: "Bob", email: "bob@example.com", role: "user", status: "active" } });
    const a2 = rec({ url: "b" });
    const a1 = rec({ url: "a" });
    expect(ui.sortRepos([bob, a2, a1]).map((r: any) => r.url)).toEqual(["a", "b", "z"]);
  });

  it("allAttention adds the app list and the watcher problem after the usual states", () => {
    const ok = { at: "2026-01-01T00:00:00Z", ok: true, checks: [] };
    const failed = { at: "2026-01-01T00:00:00Z", ok: false, checks: [{ check: "clone", ok: false, message: "no" }] };
    expect(ui.allAttention(rec({ offAppList: true, connection: ok }))).toMatchObject({ level: "bad", text: "Not on the app list", action: null });
    expect(ui.allAttention(rec({ offAppList: true, connection: ok })).detail).toBeTruthy();
    expect(ui.allAttention(rec({ watcherProblem: "broken", connection: ok }))).toEqual({ level: "warn", text: "Watcher problem", detail: "broken", action: null });
    expect(ui.allAttention(rec({ offAppList: true, watcherProblem: "broken", connection: ok }))).toMatchObject({ text: "Not on the app list" });
    expect(ui.allAttention(rec({ offAppList: true, watcherProblem: "broken", connection: failed }))).toMatchObject({ text: "Last test failed", action: "test" });
    expect(ui.allAttention(rec({ method: "none", offAppList: true }))).toMatchObject({ text: "Needs authentication" });
    expect(ui.allAttention(rec({ connection: ok }))).toMatchObject({ level: "ok", text: "Nothing to do" });
    const admin = { name: "Root", email: "root@example.com", role: "admin", status: "active" };
    expect(ui.allAttention(rec({ method: "none", account: admin, connection: ok })).text).toBe("Nothing to do");
  });
});

describe("the page", () => {
  it("lists URL, owner, method label and connection status, with Open on every row and no admin buttons", async () => {
    repos = [rec(), rec({ url: "https://github.com/o/b", method: "none" })];
    await show();
    const text = main().textContent;
    for (const t of ["https://github.com/o/a", "Ann (ann@example.com)", "GitHub · fine-grained token", "Read not checked, Write not checked, GitHub API not checked", "Not tested yet", "Needs authentication", "Repositories", "The repositories of all accounts"]) {
      expect(text).toContain(t);
    }
    expect(walk(main()).filter((e) => e.tag === "th").map((e) => e.textContent)).toContain("Owner");
    const rows = walk(main()).filter((e) => e.tag === "tr" && e.attrs["data-repo"]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const open = walk(r).find((e) => e.tag === "a" && e.textContent === "Open")!;
      expect(open.attrs.href).toBe(`#/repos/${r.attrs["data-repo"]}`);
    }
    for (const t of ["Settings", "Definition of Ready", "Transfer", "+ Add repository", "Change authentication"]) expect(button(main(), t), t).toBeUndefined();
  });

  it("draws the Mine / All / Credentials switch with All current", async () => {
    repos = [rec()];
    await show();
    const links = walk(byClass(main(), "scope-switch")[0]!).filter((e) => e.tag === "a");
    expect(links.map((e) => [e.textContent, e.attrs.href, e.attrs["aria-current"]])).toEqual([["Mine", "#/repos", undefined], ["All", "#/all-repos", "page"], ["Credentials", "#/credentials", undefined]]);
  });

  describe("the method filter", () => {
    const gone: string[] = [];
    const go = (h: string) => { gone.push(h); };
    const urls = () => walk(main()).filter((e) => e.tag === "tr" && e.attrs["data-repo"]).map((e) => byClass(e, "mono")[0]!.attrs.title);
    const chips = () => byClass(main(), "filter-chip").map((e) => e.textContent);
    beforeEach(() => {
      gone.length = 0;
      repos = [rec({ url: "https://github.com/o/app", method: "github-app" }), rec({ url: "https://github.com/o/tok" })];
    });

    it("lists only the repositories with that method, with a chip", async () => {
      await ui.renderAllRepos(main(), { query: { method: "github-app" }, go });
      expect(urls()).toEqual(["https://github.com/o/app"]);
      expect(chips()).toEqual(["Authentication: GitHub App×"]);
    });

    it("shows all again with Clear filters", async () => {
      await ui.renderAllRepos(main(), { query: { method: "github-app" }, go });
      press(button(main(), "Clear filters"));
      expect(urls()).toHaveLength(2);
      expect(gone).toEqual(["#/all-repos"]);
    });

    it("says so when no repository uses the method", async () => {
      await ui.renderAllRepos(main(), { query: { method: "ssh-deploy-key" }, go });
      expect(main().textContent).toContain("No repository uses this authentication.");
    });

    it("removes only the chip that was pressed", async () => {
      await ui.renderAllRepos(main(), { query: { repo: "o/app", method: "github-app" }, go });
      expect(chips()).toHaveLength(2);
      press(walk(main()).find((e) => e.tag === "button" && (e.attrs["aria-label"] ?? "").startsWith("Remove filter Repository")));
      expect(gone).toEqual(["#/all-repos?method=github-app"]);
      expect(chips()).toEqual(["Authentication: GitHub App×"]);
      press(walk(main()).find((e) => e.tag === "button" && (e.attrs["aria-label"] ?? "").startsWith("Remove filter Authentication")));
      expect(gone[1]).toBe("#/all-repos");
      expect(chips()).toEqual([]);
    });
  });

  it("shows the app as the identity of an app repository", async () => {
    repos = [rec({ method: "github-app" })];
    await show();
    expect(main().textContent).toContain("GitHub · GitHub AppRead not checked, Write not checked, GitHub API not checked, limited to this repository");
  });

  it("sorts by attention, then owner e-mail, then address", async () => {
    const ok = { at: new Date().toISOString(), ok: true, checks: [] };
    const bob = { name: "Bob", email: "bob@example.com", role: "user", status: "active" };
    repos = [
      rec({ url: "https://github.com/o/ok", connection: ok }),
      rec({ url: "https://github.com/o/z", account: bob }),
      rec({ url: "https://github.com/o/b" }),
      rec({ url: "https://github.com/o/a" }),
      rec({ url: "https://github.com/o/bad", method: "none" }),
    ];
    await show();
    const urls = walk(main()).filter((e) => e.tag === "tr" && e.attrs["data-repo"]).map((e) => e.attrs.title ?? byClass(e, "mono")[0]!.attrs.title);
    expect(urls).toEqual(["https://github.com/o/bad", "https://github.com/o/a", "https://github.com/o/b", "https://github.com/o/z", "https://github.com/o/ok"]);
  });

  it("offers only Test connection in Next step, also when the app is not installed, and posts the test", async () => {
    const failed = { at: new Date().toISOString(), ok: false, checks: [{ check: "github-api", ok: false, code: "app-not-installed", message: "The app is not installed." }] };
    const r = rec({ method: "github-app", connection: failed });
    repos = [r];
    await show();
    const cell = byClass(main(), "next-step")[0]!;
    expect(cell.textContent).toContain("Last test failed");
    expect(walk(cell).filter((e) => e.tag === "button").map((e) => e.textContent)).toEqual(["Test again"]);
    expect(walk(cell).some((e) => e.tag === "a")).toBe(false);
    press(button(cell, "Test again"));
    await flush();
    expect(sent[0]).toMatchObject({ method: "POST", url: `/api/repos/${r.id}/test` });
  });

  it("shows no deploy-key banner and no methods banner", async () => {
    repos = [rec({ method: "ssh-deploy-key", publicKey: "ssh-ed25519 AAAA" })];
    await show();
    expect(main().textContent).not.toContain("with write access");
    expect(main().textContent).not.toContain("sign-in methods");
  });

  it("reads none as the server's own access for an admin's repository", async () => {
    repos = [rec({ method: "none", account: { name: "Root", email: "root@example.com", role: "admin", status: "active" } })];
    await show();
    expect(main().textContent).toContain("GitHub · the server's own access");
    expect(main().textContent).not.toContain("Needs authentication");
  });

  it("does not call a user's none repository legacy", async () => {
    repos = [rec({ method: "none", account: { name: "Bob", email: "bob@example.com", role: "user", status: "active" } })];
    await show();
    expect(main().textContent).not.toContain("legacy");
  });

  it("shows an unknown account and a blocked owner", async () => {
    repos = [rec({ account: null }), rec({ account: { name: "Bob", email: "bob@example.com", role: "user", status: "blocked" } })];
    await show();
    expect(main().textContent).toContain("Unknown account");
    expect(byClass(main(), "pill").map((e) => e.textContent)).toContain("blocked");
  });

  it("marks a repository that is not on the app list or has a watcher problem, and only then", async () => {
    const ok = { at: new Date().toISOString(), ok: true, checks: [] };
    repos = [
      rec({ url: "https://github.com/o/a", method: "github-app", offAppList: true, connection: ok }),
      rec({ url: "https://github.com/o/b", method: "github-app", connection: ok }),
      rec({ url: "https://github.com/o/c", watcherProblem: "The flow is gone.", connection: ok }),
    ];
    await show();
    const rows = walk(main()).filter((e) => e.tag === "tr" && e.attrs["data-repo"]);
    expect(rows[0]!.textContent).toContain("Not on the app list");
    expect(rows[1]!.textContent).toContain("Watcher problem");
    expect(rows[1]!.textContent).toContain("The flow is gone.");
    expect(rows[2]!.textContent).toContain("Nothing to do");
  });

  it("shows the empty list text", async () => {
    await show();
    expect(main().textContent).toContain("No repositories yet.");
  });
});

describe("settings dialog", () => {
  const S = { testCommand: "npm test", docs: ["a.md", "b.md"], protectedBranches: ["release/*"], mainBranch: "main", developBranch: "develop", releaseRecipe: "builds:\n  - name: x" };
  let closed: Promise<any>;
  const open = async (r = rec({ settings: S }), options?: object) => {
    closed = ui.settingsDialog(r, options);
    await flush();
    return r;
  };

  it("is prefilled and explains the pattern", async () => {
    await open();
    expect(field(root(), "testCommand")!.value).toBe("npm test");
    expect(field(root(), "docs")!.value).toBe("a.md\nb.md");
    expect(field(root(), "protectedBranches")!.value).toBe("release/*");
    expect(field(root(), "mainBranch")!.value).toBe("main");
    expect(field(root(), "developBranch")!.value).toBe("develop");
    expect(root().textContent).toContain("? one character");
    expect(root().textContent).toContain('Runs use the release-build recipe and "Decide technical questions itself"; the other settings not yet.');
    expect(field(root(), "decideTechnical")!.checked).toBe(true);
    expect(root().textContent).toContain("Decide technical questions itself");
    expect(root().textContent).toContain("Off: you are asked every question.");
  });

  it("saves with the exact body, shows the toast, closes and resolves with the server's row", async () => {
    const r = await open();
    field(root(), "docs")!.value = "x.md";
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: `/api/admin/repos/${r.id}/settings`, body: { ...S, docs: ["x.md"], questions: { decide_technical: true } } }]);
    expect(toastText()).toBe("Settings saved");
    expect(root().children).toHaveLength(0);
    expect(await closed).toEqual({});
  });

  it("starts unchecked when the setting is off, and sends the checkbox", async () => {
    await open(rec({ settings: { ...S, questions: { decide_technical: false } } }));
    expect(field(root(), "decideTechnical")!.checked).toBe(false);
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent[0]!.body.questions).toEqual({ decide_technical: false });
  });

  it("sends true after the box is checked", async () => {
    await open(rec({ settings: { ...S, questions: { decide_technical: false } } }));
    field(root(), "decideTechnical")!.checked = true;
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent[0]!.body.questions).toEqual({ decide_technical: true });
  });

  it("keeps a stored off in a section save", async () => {
    await open(rec({ settings: { ...S, questions: { decide_technical: false } } }), { only: ["mainBranch"] });
    expect(walk(root()).some((e) => e.attrs.name === "decideTechnical")).toBe(false);
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent[0]!.body.questions).toEqual({ decide_technical: false });
  });

  it("marks the checkbox for a 400 about questions", async () => {
    await open();
    answers.push({ status: 400, error: "questions.decide_technical must be true or false" });
    press(button(root(), "Save"));
    await flush();
    expect(field(root(), "decideTechnical")!.attrs["aria-invalid"]).toBe("true");
  });

  it("resolves with nothing when it is closed without a save", async () => {
    await open();
    (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
    expect(await closed).toBeUndefined();
  });

  describe("with only some fields", () => {
    const BRANCHES = ["mainBranch", "developBranch", "protectedBranches"];
    const names = () => walk(root()).filter((e) => ["input", "textarea"].includes(e.tag)).map((e) => e.attrs.name);

    it("draws only those fields and sends the other settings from current(), not from the record", async () => {
      const current = vi.fn(async () => ({ testCommand: "make test", docs: ["fresh.md"], protectedBranches: ["x"], mainBranch: "trunk", developBranch: "" }));
      const r = await open(rec({ settings: S }), { only: BRANCHES, title: "Branches", current });
      expect(names()).toEqual(["protectedBranches", "mainBranch", "developBranch"]);
      expect(root().textContent).toContain("Branches");
      expect(root().textContent).not.toContain("Runs do not use these settings yet.");
      field(root(), "mainBranch")!.value = "main2";
      press(button(root(), "Save"));
      await flush();
      await flush();
      expect(current).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([{ method: "PUT", url: `/api/admin/repos/${r.id}/settings`, body: { testCommand: "make test", docs: ["fresh.md"], protectedBranches: ["release/*"], mainBranch: "main2", developBranch: "develop", releaseRecipe: "", questions: { decide_technical: true } } }]);
    });

    it("falls back to the record's own settings without current()", async () => {
      await open(rec({ settings: S }), { only: ["testCommand", "docs"] });
      field(root(), "testCommand")!.value = "pnpm test";
      press(button(root(), "Save"));
      await flush();
      await flush();
      expect(sent[0]!.body).toEqual({ ...S, testCommand: "pnpm test", questions: { decide_technical: true } });
    });

    it("shows the sentence of a failed current() and sends nothing", async () => {
      await open(rec({ settings: S }), { only: BRANCHES, current: async () => { throw new Error("This repository is gone. Reload the page."); } });
      press(button(root(), "Save"));
      await flush();
      expect(errText(root())).toContain("This repository is gone.");
      expect(sent).toEqual([]);
      expect(button(root(), "Save")!.disabled).toBeFalsy();
    });

    it("marks the field for a 400 about it", async () => {
      await open(rec({ settings: S }), { only: BRANCHES });
      answers.push({ status: 400, error: "mainBranch must be a valid git branch name" });
      press(button(root(), "Save"));
      await flush();
      expect(errText(root())).toContain("mainBranch must be a valid git branch name");
      expect(field(root(), "mainBranch")!.attrs["aria-invalid"]).toBe("true");
    });
  });

  it("shows a 400 in the dialog and enables the button again", async () => {
    await open();
    answers.push({ status: 400, error: "mainBranch must be a valid git branch name" });
    press(button(root(), "Save"));
    await flush();
    expect(errText(root())).toContain("mainBranch must be a valid git branch name");
    expect(button(root(), "Save")!.disabled).toBeFalsy();
    expect(root().children).not.toHaveLength(0);
  });
});

describe("Definition of Ready dialog", () => {
  const inputs = () => walk(root()).filter((e) => e.tag === "input" && e.attrs.name === "item");
  const texts = () => inputs().map((e) => e.value);
  const rowButton = (n: number, text: string) => walk(root()).filter((e) => e.tag === "button" && e.textContent === text)[n];
  const open = async (r = rec()) => {
    ui.readyDialog(r);
    await flush();
    return r;
  };
  const D = DEFAULT_READY.map(({ id, text }) => ({ id, text }));

  it("READY_DEFAULTS equals the server's default list", () => {
    expect(ui.READY_DEFAULTS).toEqual(D);
  });

  it("readyBody trims and leaves out a missing id", () => {
    expect(ui.readyBody([{ id: "value", text: " a " }, { text: " b" }, { id: "c-1", text: "c" }])).toEqual({ items: [{ id: "value", text: "a" }, { text: "b" }, { id: "c-1", text: "c" }] });
  });

  it("is prefilled with the seven items, with labels on the buttons", async () => {
    await open();
    expect(texts()).toEqual(D.map((d) => d.text));
    expect(inputs()[0]!.attrs.maxlength).toBe("200");
    expect(rowButton(1, "Up")!.attrs["aria-label"]).toBe("Move item 2 up");
    expect(root().textContent).toContain("Back to the default drops the items you added and your wording.");
  });

  it("turns Up off on the first row, Down on the last, and Remove with one row", async () => {
    await open(rec({ ready: { items: [{ id: "a", text: "one" }, { id: "b", text: "two" }], isDefault: false } }));
    expect(rowButton(0, "Up")!.attrs.disabled).toBeDefined();
    expect(rowButton(1, "Up")!.attrs.disabled).toBeUndefined();
    expect(rowButton(1, "Down")!.attrs.disabled).toBeDefined();
    press(rowButton(0, "Remove"));
    expect(texts()).toEqual(["two"]);
    expect(rowButton(0, "Remove")!.attrs.disabled).toBeDefined();
  });

  it("rewords, moves, removes and adds, then saves with the exact body", async () => {
    const r = await open();
    inputs()[0]!.value = "  value reworded ";
    press(rowButton(0, "Down"));
    expect(texts().slice(0, 2)).toEqual([D[1]!.text, "  value reworded "]);
    press(rowButton(6, "Remove"));
    press(button(root(), "+ Add item"));
    inputs()[inputs().length - 1]!.value = "my own";
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent).toEqual([{
      method: "PUT",
      url: `/api/admin/repos/${r.id}/ready`,
      body: { items: [{ id: "standalone", text: D[1]!.text }, { id: "value", text: "value reworded" }, ...D.slice(2, 6), { text: "my own" }] },
    }]);
    expect(toastText()).toBe("Definition of Ready saved");
    expect(root().children).toHaveLength(0);
  });

  it("keeps what was typed when another row is moved", async () => {
    await open();
    inputs()[3]!.value = "typed";
    press(rowButton(0, "Down"));
    expect(texts()).toContain("typed");
  });

  it("puts a removed default item back with its id", async () => {
    const r = await open();
    press(rowButton(6, "Remove"));
    const back = button(root(), `Add back: ${D[6]!.text}`);
    press(back);
    expect(button(root(), `Add back: ${D[6]!.text}`)).toBeUndefined();
    press(button(root(), "Save"));
    await flush();
    expect(sent[0]!.body).toEqual({ items: D });
    expect(sent[0]!.url).toBe(`/api/admin/repos/${r.id}/ready`);
  });

  it("Back to the default refills the seven texts and drops a custom row", async () => {
    await open(rec({ ready: { items: [{ id: "c-1", text: "custom" }], isDefault: false } }));
    expect(texts()).toEqual(["custom"]);
    press(button(root(), "Back to the default"));
    expect(texts()).toEqual(D.map((d) => d.text));
  });

  it("shows a message for an empty item and sends nothing", async () => {
    await open();
    press(button(root(), "+ Add item"));
    press(button(root(), "Save"));
    await flush();
    expect(errText(root())).toContain("Fill in every item, or remove it.");
    expect(sent).toEqual([]);
  });

  it("shows a 400 in the dialog and enables Save again", async () => {
    await open();
    answers.push({ status: 400, error: "two items have the same text" });
    press(button(root(), "Save"));
    await flush();
    expect(errText(root())).toContain("two items have the same text");
    expect(button(root(), "Save")!.disabled).toBeFalsy();
    expect(root().children).not.toHaveLength(0);
  });

  it("sets a text with markup as the value and sends it unchanged", async () => {
    await open(rec({ ready: { items: [{ id: "c-1", text: "<img src=x>" }], isDefault: false } }));
    expect(inputs()[0]!.value).toBe("<img src=x>");
    expect(walk(root()).some((e) => e.tag === "img")).toBe(false);
    press(button(root(), "Save"));
    await flush();
    expect(sent[0]!.body).toEqual({ items: [{ id: "c-1", text: "<img src=x>" }] });
  });
});

describe("transfer dialog", () => {
  let closed: Promise<any>;
  const open = async (r = rec()) => {
    closed = ui.transferDialog(r);
    await flush();
    return r;
  };

  it("asks for the e-mail and sends nothing when it is empty", async () => {
    await open();
    press(button(root(), "Transfer"));
    await flush();
    expect(errText(root())).toBe("Fill in the e-mail of the new owner.");
    expect(sent).toEqual([]);
    expect(root().textContent).toContain("Owner now: Ann (ann@example.com)");
  });

  it("sends the e-mail, shows the toast and resolves with the server's row", async () => {
    const r = await open();
    field(root(), "email")!.value = " bob@example.com ";
    press(button(root(), "Transfer"));
    await flush();
    await flush();
    expect(sent).toEqual([{ method: "POST", url: `/api/admin/repos/${r.id}/transfer`, body: { email: "bob@example.com" } }]);
    expect(toastText()).toBe("Repository transferred");
    expect(root().children).toHaveLength(0);
    expect(await closed).toEqual({});
  });

  it("explains the token wipe for a token method only", async () => {
    await open();
    expect(root().textContent).toContain("The stored token is deleted.");
    expect(root().textContent).toContain("If the new owner is an admin, the repository uses the server's own access until then.");
    root().replaceChildren();
    await open(rec({ method: "none" }));
    expect(root().textContent).not.toContain("The stored token is deleted.");
    expect(root().textContent).not.toContain("stays with it");
  });

  it("shows a refusal (400, 409) in the dialog", async () => {
    await open();
    field(root(), "email")!.value = "x@example.com";
    for (const [status, error] of [[400, "that account has 50 repositories already"], [409, "that account is blocked"]] as const) {
      answers.push({ status, error });
      press(button(root(), "Transfer"));
      await flush();
      expect(errText(root())).toBe(error);
      expect(button(root(), "Transfer")!.disabled).toBeFalsy();
    }
  });
});

describe("a wish from the command palette", () => {
  let wishes: any;
  beforeAll(async () => {
    wishes = await import("../ui/palette-data.js" as string);
  });
  beforeEach(() => {
    wishes.resetWishes();
    (document as any).activeElement = null;
  });
  const rowOf = (id: string) => walk(main()).find((e) => e.tag === "tr" && e.attrs["data-repo"] === id)!;

  it("focuses the row of a wish that came before the page was drawn", async () => {
    repos = [rec({ id: "x1" }), rec({ id: "x2" })];
    wishes.sendWish("all-repos", { repo: "x2" });
    await show();
    expect(rowOf("x2").attrs.tabindex).toBe("-1");
    expect((document as any).activeElement).toBe(rowOf("x2"));
  });

  it("does the same on the page that is open, and leaves the focus alone for an unknown id", async () => {
    repos = [rec({ id: "x1" })];
    await show();
    wishes.sendWish("all-repos", { repo: "nope" });
    expect((document as any).activeElement).toBeNull();
    wishes.sendWish("all-repos", { repo: "x1" });
    expect((document as any).activeElement).toBe(rowOf("x1"));
  });

  it("frees the slot when the page is left", async () => {
    repos = [rec({ id: "x1" })];
    const cleanup = await show();
    cleanup();
    wishes.sendWish("all-repos", { repo: "x1" });
    expect((document as any).activeElement).toBeNull();
    expect(wishes.takeWish("all-repos")).toEqual({ repo: "x1" });
  });

  // the list module is shared by Mine and All: an old render ending must not remove the handler of the newer one
  it("keeps the handler of All when a slow Mine render is released and cleaned up afterwards", async () => {
    const lists = await import("../ui/repos.js" as string);
    (globalThis as any).location = { hash: "#/repos" };
    repos = [rec({ id: "x1" })];
    const gate: (() => void)[] = [];
    heldGets.push(gate); // the list request of Mine is held
    const mineMain = (document as any).createElement("div") as FakeElement;
    const slowMine = lists.renderRepos(mineMain, { admin: true, switcher: true });
    await flush();
    (globalThis as any).location = { hash: "#/all-repos" };
    gate.forEach((r) => r());
    const offMine = await slowMine;
    const offAll = await show();
    offMine();
    wishes.sendWish("all-repos", { repo: "x1" });
    expect((document as any).activeElement).toBe(rowOf("x1"));
    offAll();
  });

  it("keeps the handler of Mine when an All render is cleaned up after Mine started", async () => {
    const lists = await import("../ui/repos.js" as string);
    (globalThis as any).location = { hash: "#/all-repos" };
    repos = [rec({ id: "x1" })];
    const offAll = await show();
    (globalThis as any).location = { hash: "#/repos" };
    const offMine = await lists.renderRepos(main(), { admin: true, switcher: true });
    offAll();
    expect(main().textContent).toContain("My repositories");
    wishes.sendWish("repos", { repo: "x1" });
    expect((document as any).activeElement).toBe(rowOf("x1"));
    offMine();
  });
});

describe("late answers", () => {
  it("draws nothing after the person left the page", async () => {
    (globalThis as any).location = { hash: "#/all-repos" };
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    const loading = ui.renderAllRepos(main());
    await flush();
    (globalThis as any).location = { hash: "#/runs" };
    main().textContent = "Runs page";
    gate.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("Runs page");
  });

  it("draws only the newest of overlapping loads", async () => {
    (globalThis as any).location = { hash: "#/all-repos" };
    repos = [rec()];
    const older: (() => void)[] = [];
    heldGets.push(older);
    const first = ui.renderAllRepos(main());
    await flush();
    repos = [];
    const second = ui.renderAllRepos(main());
    await flush();
    older.forEach((f) => f());
    await Promise.all([first, second]);
    expect(main().textContent).toContain("No repositories yet.");
  });
});

describe("the repository filter", () => {
  const owner2 = { name: "Bob", email: "bob@example.com", role: "user", status: "active" };
  const setup = () => {
    repos = [rec({ url: "https://github.com/o/a" }), rec({ url: "git@github.com:O/A.git", account: owner2 }), rec({ url: "https://github.com/o/b" })];
  };
  const urls = () => byClass(main(), "mono").map((e) => e.textContent);
  const setHash = (hash: string) => {
    (globalThis as any).location = { hash };
  };
  // Test connection posts, then loads the list again
  const retest = () => walk(main()).find((e) => e.tag === "button" && e.textContent === "Test connection");

  it("shows the matching records of all owners and the chip", async () => {
    setup();
    setHash("#/all-repos?repo=o%2Fa");
    await ui.renderAllRepos(main(), { query: { repo: "o/a" }, go: () => {} });
    expect(urls().sort()).toEqual(["git@github.com:O/A.git", "https://github.com/o/a"]);
    expect(main().textContent).toContain("Repository: o/a");
  });

  it("matches ssh:// and repeated .git addresses", async () => {
    repos = [rec({ url: "ssh://git@github.com/o/a.git.git" }), rec({ url: "https://github.com/o/b" })];
    await ui.renderAllRepos(main(), { query: { repo: "o/a" }, go: () => {} });
    expect(urls()).toEqual(["ssh://git@github.com/o/a.git.git"]);
  });

  it("draws the same page without a filter", async () => {
    setup();
    await show();
    expect(byClass(main(), "filter-bar")).toHaveLength(0);
    expect(urls()).toHaveLength(3);
  });

  it("says the repository is not in the list, also for an empty list, and clears without a new request", async () => {
    setup();
    const go = vi.fn();
    await ui.renderAllRepos(main(), { query: { repo: "x/y" }, go });
    expect(main().textContent).toContain("This repository is not in your list. It may have been removed, or you may not have access.");
    expect(main().all("table")).toHaveLength(0);
    press(button(main(), "Clear filters")); // the bar's button comes first
    expect(go).toHaveBeenCalledWith("#/all-repos");
    expect(urls()).toHaveLength(3);
    expect(byClass(main(), "filter-bar")).toHaveLength(0);
    repos = [];
    await ui.renderAllRepos(main(), { query: { repo: "x/y" }, go });
    expect(main().textContent).toContain("This repository is not in your list.");
  });

  it("removes the filter with the chip's ×, without a new request", async () => {
    setup();
    const go = vi.fn();
    await ui.renderAllRepos(main(), { query: { repo: "o/a" }, go });
    const before = (globalThis as any).fetch;
    let gets = 0;
    (globalThis as any).fetch = (...a: any[]) => (gets++, before(...a));
    press(button(main(), "×"));
    expect(go).toHaveBeenCalledWith("#/all-repos");
    expect(urls()).toHaveLength(3);
    expect(gets).toBe(0);
  });

  it("keeps the filter on reload", async () => {
    setup();
    setHash("#/all-repos?repo=o%2Fa");
    await ui.renderAllRepos(main(), { query: { repo: "o/a" }, go: () => {} });
    press(retest());
    await flush();
    await flush();
    expect(urls()).toHaveLength(2);
    expect(main().textContent).toContain("Repository: o/a");
  });

  it("a filter removed while a reload runs stays removed", async () => {
    setup();
    setHash("#/all-repos?repo=o%2Fa");
    await ui.renderAllRepos(main(), { query: { repo: "o/a" }, go: () => {} });
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    press(retest());
    await flush();
    await flush();
    press(button(main(), "×")); // the old page is still drawn while the reload waits
    expect(urls()).toHaveLength(3);
    gate.forEach((r) => r());
    await flush();
    await flush();
    expect(urls()).toHaveLength(3);
    expect(byClass(main(), "filter-bar")).toHaveLength(0);
  });

  it("accepts an address with a query and still drops a late answer", async () => {
    setup();
    setHash("#/all-repos?repo=o%2Fa");
    main().textContent = "old";
    await ui.renderAllRepos(main(), { query: { repo: "o/a" }, go: () => {} });
    expect(main().textContent).not.toBe("old");
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    const loading = ui.renderAllRepos(main(), { query: { repo: "o/a" }, go: () => {} });
    await flush();
    setHash("#/runs?repo=o%2Fa");
    main().textContent = "Runs page";
    gate.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("Runs page");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");

  it("links the page and imports it", async () => {
    const ia = (await import("../ui/ia.js" as string)) as { subnavFor: (r: string, d: string) => { href: string; label: string }[] };
    expect(ia.subnavFor("admin", "administration")).toContainEqual({ id: "all-repos", href: "#/all-repos", label: "All repositories", section: "access" });
    const app = read("app.js");
    expect(app).toContain('from "./admin-repos.js"');
    expect(app).toContain('section === "all-repos"');
  });

  it("uses the right routes", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await api.allRepos();
    await api.setRepoSettings("a b", {});
    await api.setRepoReady("a b", { items: null });
    await api.transferRepo("a b", "x@y.io");
    expect(seen).toEqual(["GET /api/admin/repos", "PUT /api/admin/repos/a%20b/settings", "PUT /api/admin/repos/a%20b/ready", "POST /api/admin/repos/a%20b/transfer"]);
  });

  describe("states", () => {
    const failedConnection = { at: new Date().toISOString(), ok: false, checks: [{ check: "clone", ok: false, code: "bad-token", message: "The host did not accept the token." }] };

    it("draws a skeleton while the list loads", async () => {
      const gate: (() => void)[] = [];
      heldGets.push(gate);
      const loading = show();
      await flush();
      expect(main().textContent).toContain("Repositories");
      expect(byClass(main(), "skeleton")).toHaveLength(1);
      expect(walk(main()).some((e) => e.attrs["aria-busy"] === "true")).toBe(true);
      expect(walk(main()).some((e) => e.tag === "button")).toBe(false);
      gate.forEach((r) => r());
      await loading;
      expect(byClass(main(), "skeleton")).toHaveLength(0);
    });

    it("shows a server error with Retry, and Retry loads again", async () => {
      getFails.push({ status: 500, error: "the store is broken" });
      await show();
      expect(byClass(main(), "state-error")[0]!.attrs["data-kind"]).toBe("server");
      expect(main().textContent).toContain("The repositories could not be loaded. the store is broken");
      repos = [rec()];
      press(button(main(), "Retry"));
      await flush();
      expect(byClass(main(), "state-error")).toHaveLength(0);
      expect(main().textContent).toContain("https://github.com/o/a");
    });

    it("shows a network failure as offline", async () => {
      getFails.push("throw");
      await show();
      expect(byClass(main(), "state-error")[0]!.attrs["data-kind"]).toBe("offline");
    });

    it("shows a 403 as a permission state with a link to My repositories", async () => {
      getFails.push({ status: 403, error: "admin only" });
      await show();
      const box = byClass(main(), "state-permission")[0]!;
      expect(box.textContent).toContain("Only an admin can see the repositories of all accounts.");
      expect(walk(box).find((e) => e.tag === "a")!.attrs.href).toBe("#/repos");
      expect(button(main(), "Retry")).toBeUndefined();
    });

    it("disposing an older render does not stop a newer one that is still loading", async () => {
      (globalThis as any).location = { hash: "#/all-repos" };
      repos = [rec()];
      const a: (() => void)[] = [];
      const b: (() => void)[] = [];
      heldGets.push(a, b);
      const first = show();
      await flush();
      const second = show();
      await flush();
      a.forEach((r) => r());
      (await first)();
      b.forEach((r) => r());
      await second;
      expect(main().textContent).toContain("https://github.com/o/a");
      expect(byClass(main(), "skeleton")).toHaveLength(0);
    });

    it("draws an empty list through the empty box", async () => {
      await show();
      expect(byClass(main(), "empty")[0]!.textContent).toContain("No repositories yet.");
    });

    it("shows a failed connection with its reasons, and Test again", async () => {
      repos = [rec({ connection: failedConnection })];
      await show();
      const problem = walk(main()).find((e) => e.attrs["data-state"] === "provider-failure")!;
      expect(problem.textContent).toContain("Connection failed");
      expect(problem.textContent).toContain("Read: The host did not accept the token.");
      expect(button(main(), "Test again")).toBeDefined();
      expect(button(main(), "Test connection")).toBeUndefined();
    });
  });

  it("never gives the page to a user", () => {
    expect(auth.userHash("#/all-repos")).toBe("#/runs");
    expect(auth.otherDisplay({ role: "user" }, "admin", "#/all-repos")).toBe("/user/");
    expect(auth.otherDisplay({ role: "admin" }, "admin", "#/all-repos")).toBe("");
  });
});

