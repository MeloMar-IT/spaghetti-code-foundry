import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/repos.js" as string);
});
afterAll(() => restore());

type Fail = { status: number; error: string } | "throw";
let repos: any[];
let repoGets: (Fail | undefined)[]; // one entry per GET of the list; undefined: it works
let methodsGets: (Fail | undefined)[];
let postAnswers: (Fail | undefined)[];
let gate: (() => void)[] | undefined; // holds the next list GET
let testResult: any;
let sent: string[];
const realFetch = globalThis.fetch;
const TOKEN = ["github", "pat", ""].join("_") + "Qw7".repeat(12);
const URL_A = "https://github.com/o/a";
const SSH = "git@github.com:o/b.git";
let nextId = 1;
const rec = (over: object = {}) => ({ id: `r${nextId++}`, url: URL_A, method: "github-token", ...over });
const deployRec = (over: object = {}) => rec({ url: SSH, method: "ssh-deploy-key", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIpublickeyforthetest", ...over });
const failedConn = () => ({
  at: new Date().toISOString(),
  ok: false,
  checks: [{ check: "clone", ok: false, code: "bad-token", message: "The host did not accept the token." }],
});
const goodConn = () => ({ at: new Date().toISOString(), ok: true, checks: [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }] });

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
const failed = (f: Fail) => {
  if (f === "throw") throw new TypeError("fetch failed");
  return reply({ error: f.error }, f.status);
};

beforeEach(() => {
  repos = [];
  repoGets = [];
  methodsGets = [];
  postAnswers = [];
  gate = undefined;
  sent = [];
  testResult = goodConn();
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET" && url === "/api/repos/methods") {
      const f = methodsGets.shift();
      return f ? failed(f) : reply({ methods: ["github-token", "https-token", "ssh-deploy-key", "none"], githubApp: { available: false } });
    }
    if (init.method === "GET") {
      const f = repoGets.shift();
      const wait = gate;
      gate = undefined;
      if (wait) await new Promise<void>((r) => wait.push(r));
      return f ? failed(f) : reply([...repos]);
    }
    sent.push(`${init.method} ${url}`);
    const f = postAnswers.shift();
    if (f) return failed(f);
    if (init.method === "POST" && url.endsWith("/test")) {
      repos = repos.map((r) => (`/api/repos/${r.id}/test` === url ? { ...r, connection: testResult } : r));
      return reply(testResult);
    }
    if (init.method === "POST") {
      const body = JSON.parse(init.body!);
      const made = body.method === "ssh-deploy-key" ? deployRec({ url: body.url }) : rec({ url: body.url, method: body.method });
      repos.push(made);
      return reply(made, 201);
    }
    if (init.method === "DELETE") repos = repos.filter((r) => `/api/repos/${r.id}` !== url);
    return reply({});
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
const buttons = (el: FakeElement) => walk(el).filter((e) => e.tag === "button").map((e) => e.textContent);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const show = (opts: object = {}) => ui.renderRepos(main(), opts);
const banners = () => walk(main()).filter((e) => e.attrs["data-kind"] === "warn");

describe("pure helpers", () => {
  it("needsDeployKey lists deploy-key repositories whose connection does not work", () => {
    const ok = deployRec({ connection: goodConn() });
    const bad = deployRec({ connection: failedConn() });
    const fresh = deployRec();
    const noKey = deployRec({ publicKey: undefined });
    const token = rec();
    expect(ui.needsDeployKey([ok, bad, fresh, noKey, token])).toEqual([bad, fresh]);
  });

  it("explainRepoError writes method ids as names, handles a TypeError and no message", () => {
    const quoted = ui.explainRepoError(Object.assign(new Error('the method "https-token" is not allowed'), { status: 400 }), "It failed.");
    expect(quoted.what).toContain("It failed. the method HTTPS user name + token is not allowed");
    expect(quoted.kind).toBe("other");
    const net = ui.explainRepoError(new TypeError("fetch failed"), "It failed.");
    expect(net.what).toBe("It failed. Could not reach the server.");
    expect(net.kind).toBe("offline");
    expect(ui.explainRepoError({ status: 500 }, "It failed.").what).toBe("It failed.");
  });

  it("loadFailed picks a permission state for a 403 and an error state otherwise", () => {
    const opts = { what: "Not loaded.", denied: "No.", onRetry: () => {} };
    expect(byClass(ui.loadFailed({ status: 403 }, opts), "state-permission").length + ((ui.loadFailed({ status: 403 }, opts).attrs.class ?? "").includes("state-permission") ? 1 : 0)).toBeGreaterThan(0);
    expect(ui.loadFailed({ status: 500, message: "x" }, opts).attrs["data-kind"]).toBe("server");
  });

  it("connectionProblem is null when nothing is wrong", () => {
    expect(ui.connectionProblem(rec())).toBeNull();
    expect(ui.connectionProblem(rec({ connection: goodConn() }))).toBeNull();
    expect(ui.connectionProblem(rec({ connection: failedConn() })).textContent).toContain("Connection failed");
  });
});

describe("renderRepos states", () => {
  it("draws a skeleton while the list loads, then the table", async () => {
    repos = [rec()];
    const g: (() => void)[] = [];
    gate = g;
    const loading = show();
    await flush();
    expect(main().textContent).toContain("My repositories");
    expect(walk(main()).some((e) => e.attrs["aria-busy"] === "true")).toBe(true);
    expect(walk(main()).some((e) => e.tag === "button")).toBe(false);
    g.forEach((r) => r());
    await loading;
    expect(walk(main()).some((e) => e.attrs["aria-busy"] === "true")).toBe(false);
    expect(main().textContent).toContain(URL_A);
  });

  it("shows a server error with Retry, and Retry draws the list", async () => {
    repos = [rec()];
    repoGets.push({ status: 500, error: "the store is broken" });
    await show();
    const box = byClass(main(), "state-error")[0]!;
    expect(box.attrs["data-kind"]).toBe("server");
    expect(box.textContent).toContain("Your repositories could not be loaded. the store is broken");
    press(button(main(), "Retry"));
    await flush();
    expect(byClass(main(), "state-error")).toHaveLength(0);
    expect(main().textContent).toContain(URL_A);
  });

  it("shows a network failure as offline", async () => {
    repoGets.push("throw");
    await show();
    const box = byClass(main(), "state-error")[0]!;
    expect(box.attrs["data-kind"]).toBe("offline");
    expect(box.textContent).toContain("Could not reach the server.");
  });

  it("shows a 403 as a permission state without Retry", async () => {
    repoGets.push({ status: 403, error: "no" });
    await show();
    expect(byClass(main(), "state-permission")).toHaveLength(1);
    expect(button(main(), "Retry")).toBeUndefined();
  });

  it("partial: methods failing shows the list, a note and no Add button; Retry brings Add back", async () => {
    repos = [rec()];
    methodsGets.push({ status: 404, error: "not found" });
    await show();
    expect(main().textContent).toContain(URL_A);
    expect(buttons(main())).not.toContain("+ Add repository");
    expect(banners().map((b) => b.textContent).join("")).toContain("You cannot add a repository now.");
    press(button(banners()[0]!, "Retry"));
    await flush();
    expect(buttons(main())).toContain("+ Add repository");
    expect(banners()).toHaveLength(0);
  });

  it("partial with an empty list has no Add button in the empty box either", async () => {
    methodsGets.push("throw");
    await show();
    expect(byClass(main(), "empty")).toHaveLength(1);
    expect(buttons(main())).not.toContain("+ Add repository");
  });

  it("stale: a removal works but the reload fails; the row stays with a note, the toast is not an error", async () => {
    const r = rec();
    repos = [r, rec({ url: "https://github.com/o/z" })];
    await show();
    press(button(main(), "Remove"));
    await flush();
    repoGets.push({ status: 500, error: "down" });
    press(button(root(), "Remove"));
    await flush();
    await flush();
    expect(sent).toEqual([`DELETE /api/repos/${r.id}`]);
    expect(toastText()).toBe("Repository removed");
    expect(byClass(main(), "stale-note")[0]!.attrs.class).toContain("failed");
    expect(main().textContent).not.toContain(URL_A); // the removed row is gone from what is shown
    expect(main().textContent).toContain("https://github.com/o/z");
    press(button(byClass(main(), "stale-note")[0]!, "Retry"));
    await flush();
    expect(byClass(main(), "stale-note")).toHaveLength(0);
  });

  it("provider failure: a failed test stays on the row after reloads, with one test button", async () => {
    const r = rec();
    repos = [r];
    testResult = failedConn();
    await show();
    press(button(main(), "Test connection"));
    await flush();
    const row = () => walk(main()).find((e) => e.attrs["data-state"] === "provider-failure")!;
    expect(row().textContent).toContain("Connection failed");
    expect(row().textContent).toContain("Read: The host did not accept the token.");
    expect(buttons(main()).filter((t) => /^Test /.test(t ?? ""))).toEqual(["Test again"]);
    // another reload keeps it
    press(button(main(), "Change authentication"));
    await flush();
    expect(row()).toBeDefined();
    // a good test clears it
    testResult = goodConn();
    press(button(main(), "Test again"));
    await flush();
    expect(walk(main()).some((e) => e.attrs["data-state"] === "provider-failure")).toBe(false);
    expect(buttons(main())).toContain("Test connection");
  });

  it("provider failure is kept on the row when the reload after the test fails", async () => {
    repos = [rec()];
    testResult = failedConn();
    await show();
    repoGets.push({ status: 500, error: "down" });
    press(button(main(), "Test connection"));
    await flush();
    await flush();
    expect(walk(main()).some((e) => e.attrs["data-state"] === "provider-failure")).toBe(true);
    expect(byClass(main(), "stale-note")).toHaveLength(1);
  });

  it("a good test clears the deploy-key banner even when the reload fails", async () => {
    repos = [deployRec()];
    await show();
    expect(banners()).toHaveLength(1);
    repoGets.push({ status: 500, error: "down" });
    press(button(main(), "Test connection"));
    await flush();
    await flush();
    expect(banners()).toHaveLength(0);
  });

  it("a test call that failed shows its reason on the row until the next test starts", async () => {
    repos = [rec()];
    await show();
    postAnswers.push({ status: 409, error: "a test of this repository is running already; wait for it to finish" });
    press(button(main(), "Test connection"));
    await flush();
    expect(main().textContent).toContain("The test could not run. a test of this repository is running already");
    // survives a reload
    press(button(main(), "Change authentication"));
    await flush();
    expect(main().textContent).toContain("The test could not run.");
    press(button(main(), "Test again"));
    await flush();
    expect(main().textContent).not.toContain("The test could not run.");
    expect(sent.filter((s) => s.endsWith("/test"))).toHaveLength(2);
  });

  it("the deploy-key follow-up stays as a banner after the toast is gone and ends when the connection works", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    await flush();
    const select = walk(root()).find((e) => e.attrs.name === "method")!;
    select.value = "ssh-deploy-key";
    select.dispatch?.("change");
    walk(root()).find((e) => e.attrs.name === "url")!.value = SSH;
    press(button(root(), "Add repository"));
    await flush();
    await flush();
    expect(toastText()).toBe("Repository added");
    expect(banners()[0]!.textContent).toContain(SSH);
    (document as any).getElementById("toast").textContent = "";
    await show();
    expect(banners()[0]!.textContent).toContain(SSH);
    expect(banners()[0]!.textContent).toContain("Add the public key as a deploy key with write access");
    repos = repos.map((r) => ({ ...r, connection: goodConn() }));
    await show();
    expect(banners()).toHaveLength(0);
  });

  it("a created deploy-key repository and its banner show even when the reload fails", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    await flush();
    const select = walk(root()).find((e) => e.attrs.name === "method")!;
    select.value = "ssh-deploy-key";
    select.dispatch?.("change");
    walk(root()).find((e) => e.attrs.name === "url")!.value = SSH;
    repoGets.push({ status: 500, error: "down" });
    press(button(root(), "Add repository"));
    await flush();
    await flush();
    expect(main().textContent).toContain(SSH);
    expect(banners()[0]!.textContent).toContain(SSH);
  });

  it("a token repository gives no follow-up", async () => {
    repos = [rec()];
    await show();
    expect(banners()).toHaveLength(0);
  });

  it("read-only: no action buttons in any state", async () => {
    const allowed = ["Copy", "Retry"];
    const only = () => buttons(main()).every((t) => allowed.includes(t ?? ""));
    // loading
    const g: (() => void)[] = [];
    gate = g;
    const loading = show({ readOnly: true });
    await flush();
    expect(only()).toBe(true);
    g.forEach((r) => r());
    await loading;
    // empty
    expect(only()).toBe(true);
    // error
    repoGets.push({ status: 500, error: "x" });
    await show({ readOnly: true });
    expect(only()).toBe(true);
    // methods failed
    repos = [rec({ connection: failedConn() }), deployRec()];
    methodsGets.push({ status: 500, error: "x" });
    await show({ readOnly: true });
    expect(only()).toBe(true);
    expect(main().textContent).not.toContain("You cannot add a repository now.");
    expect(buttons(main())).not.toContain("Test again");
    expect(banners()[0]!.textContent).not.toContain("press Test connection");
    expect(main().textContent).toContain("Connection failed");
  });

  it("never shows a secret", async () => {
    repos = [rec({ connection: failedConn() }), deployRec()];
    await show();
    expect(main().textContent).not.toContain(TOKEN);
    expect(main().textContent).not.toContain("token=");
  });

  it("draws nothing for an error that arrives after the person left the page", async () => {
    (globalThis as any).location = { hash: "#/repos" };
    const g: (() => void)[] = [];
    gate = g;
    repoGets.push({ status: 500, error: "late" });
    const loading = show();
    await flush();
    (globalThis as any).location = { hash: "#/runs" };
    main().textContent = "other";
    g.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("other");
  });

  it("of two overlapping reloads only the newest draws", async () => {
    (globalThis as any).location = { hash: "#/repos" };
    repos = [rec()];
    await show();
    const older: (() => void)[] = [];
    gate = older;
    repos = [rec({ url: "https://github.com/o/old" })];
    press(button(main(), "Change authentication"));
    await flush();
    // the dialog is open; closing it with Escape runs the first reload, which waits on the gate
    (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
    await flush();
    repos = [rec({ url: "https://github.com/o/new" })];
    press(button(main(), "Change authentication"));
    await flush();
    (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
    await flush();
    older.forEach((r) => r());
    await flush();
    expect(main().textContent).toContain("https://github.com/o/new");
    expect(main().textContent).not.toContain("https://github.com/o/old");
  });

  it("disposing an older render does not stop a newer one that is still loading", async () => {
    (globalThis as any).location = { hash: "#/repos" };
    repos = [rec()];
    const a: (() => void)[] = [];
    const b: (() => void)[] = [];
    gate = a;
    const first = show();
    await flush();
    gate = b;
    const second = show();
    await flush();
    a.forEach((r) => r());
    (await first)(); // the router disposes the render it no longer wants
    b.forEach((r) => r());
    await second;
    expect(main().textContent).toContain(URL_A);
    expect(walk(main()).some((e) => e.attrs["aria-busy"] === "true")).toBe(false);
  });

  it("does not use a native dialog", () => {
    expect(readFileSync(new URL("../ui/repos.js", import.meta.url), "utf8")).not.toMatch(/\bconfirm\(/);
  });
});
