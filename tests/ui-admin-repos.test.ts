import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    });
    expect(ui.settingsBody()).toEqual({ testCommand: "", docs: [], protectedBranches: [], mainBranch: "", developBranch: "" });
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
});

describe("the page", () => {
  it("lists URL, owner, method label and connection status, with Settings and Transfer on every row", async () => {
    repos = [rec(), rec({ url: "https://github.com/o/b", method: "none" })];
    await show();
    const text = main().textContent;
    for (const t of ["https://github.com/o/a", "Ann (ann@example.com)", "GitHub fine-grained personal access token", "Not tested yet", "Needs authentication", "Repositories", "The repositories of all accounts"]) {
      expect(text).toContain(t);
    }
    const rows = walk(main()).filter((e) => e.tag === "tr").slice(1);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(walk(r).filter((e) => e.tag === "button").map((e) => e.textContent)).toEqual(["Settings", "Definition of Ready", "Transfer"]);
  });

  it("reads none as the server's own access for an admin's repository", async () => {
    repos = [rec({ method: "none", account: { name: "Root", email: "root@example.com", role: "admin", status: "active" } })];
    await show();
    expect(main().textContent).toContain("The server's own access (legacy)");
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

  it("marks a repository that is not on the app list, and only then", async () => {
    repos = [rec({ method: "github-app", offAppList: true }), rec({ url: "https://github.com/o/b", method: "github-app" })];
    await show();
    const marks = byClass(main(), "pill").map((e) => e.textContent).filter((t) => t === "not on the app list");
    expect(marks).toHaveLength(1);
    const rows = walk(main()).filter((e) => e.tag === "tr").slice(1);
    expect(rows[0]!.textContent).toContain("not on the app list");
    expect(rows[1]!.textContent).not.toContain("not on the app list");
  });

  it("shows the empty list text", async () => {
    await show();
    expect(main().textContent).toContain("No repositories yet.");
  });
});

describe("settings dialog", () => {
  const S = { testCommand: "npm test", docs: ["a.md", "b.md"], protectedBranches: ["release/*"], mainBranch: "main", developBranch: "develop" };
  const open = async (r = rec({ settings: S })) => {
    repos = [r];
    await show();
    press(button(main(), "Settings"));
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
    expect(root().textContent).toContain("Runs do not use these settings yet.");
  });

  it("saves with the exact body, shows the toast, closes and reloads", async () => {
    const r = await open();
    field(root(), "docs")!.value = "x.md";
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: `/api/admin/repos/${r.id}/settings`, body: { ...S, docs: ["x.md"] } }]);
    expect(toastText()).toBe("Settings saved");
    expect(root().children).toHaveLength(0);
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
    repos = [r];
    await show();
    press(button(main(), "Definition of Ready"));
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
  const open = async (r = rec()) => {
    repos = [r];
    await show();
    press(button(main(), "Transfer"));
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

  it("sends the e-mail, shows the toast and reloads", async () => {
    const r = await open();
    field(root(), "email")!.value = " bob@example.com ";
    press(button(root(), "Transfer"));
    await flush();
    await flush();
    expect(sent).toEqual([{ method: "POST", url: `/api/admin/repos/${r.id}/transfer`, body: { email: "bob@example.com" } }]);
    expect(toastText()).toBe("Repository transferred");
    expect(root().children).toHaveLength(0);
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

    it("keeps the rows and says so when the reload after a dialog fails, and Retry clears it", async () => {
      const r = rec();
      repos = [r];
      await show();
      press(button(main(), "Settings"));
      press(button(root(), "Save"));
      getFails.push({ status: 500, error: "down" });
      await flush();
      await flush();
      expect(toastText()).toBe("Settings saved");
      expect(main().textContent).toContain(r.url);
      expect(byClass(main(), "stale-note")[0]!.attrs.class).toContain("failed");
      press(button(byClass(main(), "stale-note")[0]!, "Retry"));
      await flush();
      expect(byClass(main(), "stale-note")).toHaveLength(0);
    });

    it("shows a failed connection with its reasons, and no test button", async () => {
      repos = [rec({ connection: failedConnection })];
      await show();
      const problem = walk(main()).find((e) => e.attrs["data-state"] === "provider-failure")!;
      expect(problem.textContent).toContain("Connection failed");
      expect(problem.textContent).toContain("Read: The host did not accept the token.");
      expect(button(main(), "Test again")).toBeUndefined();
      expect(button(main(), "Test connection")).toBeUndefined();
    });
  });

  it("never gives the page to a user", () => {
    expect(auth.userHash("#/all-repos")).toBe("#/runs");
    expect(auth.otherDisplay({ role: "user" }, "admin", "#/all-repos")).toBe("/user/");
    expect(auth.otherDisplay({ role: "admin" }, "admin", "#/all-repos")).toBe("");
  });
});
