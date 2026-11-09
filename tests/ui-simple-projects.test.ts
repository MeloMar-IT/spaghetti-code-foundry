import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The Simple accounts on the Users page: the View column, the filter, and the projects with their daily caps.
let restore: () => void;
let ui: any;
let repos: any;
let ia: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/users.js" as string);
  repos = await import("../ui/admin-repos.js" as string);
  ia = await import("../ui/ia.js" as string);
});
afterAll(() => restore());

const user = (over: object = {}) => ({
  id: "u1", name: "Ann", email: "ann@example.com", role: "user", view: "simple", status: "active", created: "2026-01-01T00:00:00.000Z",
  lastSignIn: new Date().toISOString(), runs: 0, hasPassword: true, lockedUntil: null, ...over,
});
const USERS = [
  user({ id: "me", name: "Root", email: "root@example.com", role: "admin", view: "admin" }),
  user({ id: "a", name: "Ann", email: "ann@example.com" }),
  user({ id: "b", name: "Bob", email: "bob@example.com", view: "advanced" }),
  user({ id: "c", name: "Cy", email: "cy@example.com" }),
];
const REPOS = [
  { id: "r1", owner: "a", github: "acme/one", url: "https://github.com/acme/one" },
  { id: "r2", owner: "a", localName: "local-two", url: "/x/local-two" },
  { id: "r3", owner: "b", github: "acme/bob", url: "https://github.com/acme/bob" },
];

let budgets: Record<string, any>;
let sent: { method: string; url: string; body: any }[];
let calls: string[];
let reposFail: boolean;
let budgetFail: Set<string>;
let putError: { status: number; error: string } | undefined;
let putDefault: number | null | undefined; // when set, the PUT answer reports this default (e.g. null: the default was switched off)
let go: any;
const realFetch = globalThis.fetch;

beforeEach(() => {
  budgets = {
    r1: { id: "r1", dailyBudgetUsd: null, defaultUsd: 5, spentTodayUsd: 1.2, enforced: true },
    r2: { id: "r2", dailyBudgetUsd: 2.5, defaultUsd: 5, spentTodayUsd: 0, enforced: true },
    r3: { id: "r3", dailyBudgetUsd: null, defaultUsd: 5, spentTodayUsd: 0, enforced: true },
  };
  sent = [];
  calls = [];
  reposFail = false;
  budgetFail = new Set();
  putError = undefined;
  putDefault = undefined;
  go = vi.fn();
  delete (globalThis as any).location;
  (document as any).getElementById("main").replaceChildren();
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    calls.push(`${init.method} ${url}`);
    if (url === "/api/users/limits") return reply({ defaults: {}, users: {} });
    if (url === "/api/users") return reply(USERS.map((u) => ({ ...u })));
    if (url === "/api/admin/repos") return reposFail ? reply({ error: "broken" }, 500) : reply(REPOS);
    const m = /^\/api\/admin\/repos\/([^/]+)\/budget$/.exec(url);
    if (m) {
      const id = m[1]!;
      if (init.method === "GET") return budgetFail.has(id) ? reply({ error: "broken" }, 500) : reply(budgets[id]);
      const body = JSON.parse(init.body!);
      sent.push({ method: init.method, url, body });
      if (putError) return reply({ error: putError.error }, putError.status);
      budgets[id] = { ...budgets[id], dailyBudgetUsd: body.dailyBudgetUsd, ...(putDefault !== undefined ? { defaultUsd: putDefault } : {}) };
      return reply(budgets[id]);
    }
    return reply({ error: "unexpected" }, 404);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const tableRows = () => main().all("tr").filter((r) => r.all("td").length);
const names = () => tableRows().map((r) => r.all("td")[0]!.textContent.replace(" (you)", "")).filter((t) => /^(Root|Ann|Bob|Cy)/.test(t));
const box = (title: string) => main().all("div").find((d) => d.all("h3").some((x) => x.textContent.startsWith(title)) && !d.all("h2").length)!;
const rowOf = (label: string) => main().all("tr").find((r) => r.all("td")[0]?.textContent === label)!;
const input = (row: FakeElement) => row.all("input").find((i) => i.attrs.name === "cap")!;
const save = (row: FakeElement) => row.all("button").find((b) => b.textContent === "Save")!;
const show = async (over: object = {}) => {
  await ui.renderUsers(main(), { me: "me", go, ...over });
  await flush();
  await flush();
};
const toggle = () => main().all("input").find((i) => i.attrs.name === "simpleOnly")!;

describe("pure functions", () => {
  it("reads a cap", () => {
    expect(repos.readCap("")).toEqual({ value: null });
    expect(repos.readCap("  ")).toEqual({ value: null });
    expect(repos.readCap("2.5")).toEqual({ value: 2.5 });
    for (const bad of ["0", "-1", "abc", "1e3", "2000000"]) expect(repos.readCap(bad)).toEqual({ problem: repos.CAP_PROBLEM });
  });
  it("words the cap in effect", () => {
    expect(repos.capText({ dailyBudgetUsd: 2.5, defaultUsd: 5 })).toBe("$2.5 (own)");
    expect(repos.capText({ dailyBudgetUsd: null, defaultUsd: 5 })).toBe("$5 (default)");
    expect(repos.capText({ dailyBudgetUsd: null, defaultUsd: null })).toBe("no cap");
  });
  it("lists the projects of an owner by label", () => {
    expect(repos.projectsOf(REPOS, "a").map((r: any) => r.id)).toEqual(["r1", "r2"]);
    expect(repos.projectLabel({ url: "u" })).toBe("u");
    expect(repos.projectLabel({ localName: "l", url: "u" })).toBe("l");
    expect(ui.isSimple({})).toBe(false);
    expect(ui.isSimple({ view: "simple" })).toBe(true);
  });
  it("keeps view=simple in the address and drops other values", () => {
    expect(ia.resolve("admin", "#/users?view=simple").query).toEqual({ view: "simple" });
    expect(ia.resolve("admin", "#/users?view=other").query).toEqual({});
  });
});

describe("the Users page", () => {
  it("marks Simple accounts and makes no project calls without the filter", async () => {
    await show();
    expect(names()).toEqual(["Root", "Ann", "Bob", "Cy"]);
    expect(tableRows()[1]!.all("span").some((s) => s.textContent === "Simple" && s.attrs.class === "pill sem-accent")).toBe(true);
    expect(tableRows()[2]!.textContent).toContain("Advanced");
    expect(calls.some((c) => c.includes("/api/admin/repos"))).toBe(false);
  });

  it("filters with the checkbox and keeps the choice in the address", async () => {
    await show();
    toggle().fire("change");
    await flush();
    await flush();
    expect(go).toHaveBeenLastCalledWith("#/users?view=simple");
    expect(names()).toEqual(["Ann", "Cy"]);
    toggle().fire("change");
    await flush();
    expect(go).toHaveBeenLastCalledWith("#/users");
    expect(names()).toEqual(["Root", "Ann", "Bob", "Cy"]);
  });

  it("lists the projects of each Simple account", async () => {
    await show({ query: { view: "simple" } });
    expect(names()).toEqual(["Ann", "Cy"]);
    expect(box("Ann").textContent).toContain("Ann (ann@example.com)");
    expect(rowOf("acme/one").textContent).toContain("$1.20");
    expect(rowOf("acme/one").textContent).toContain("$5 (default)");
    expect(rowOf("local-two").textContent).toContain("$2.5 (own)");
    expect(input(rowOf("local-two")).value).toBe("2.5");
    expect(box("Cy").textContent).toContain("No projects.");
    expect(main().textContent).not.toContain("acme/bob");
  });

  it("changes a cap, then clears it on the same row", async () => {
    await show({ query: { view: "simple" } });
    const row = rowOf("acme/one");
    input(row).value = "3";
    save(row).click();
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/admin/repos/r1/budget", body: { dailyBudgetUsd: 3 } }]);
    expect(row.textContent).toContain("$3 (own)");
    expect(toastText()).toBe("Cap saved");
    expect(save(row).disabled).toBe(false);
    input(row).value = "";
    save(row).click();
    await flush();
    expect(sent[1]!.body).toEqual({ dailyBudgetUsd: null });
    expect(row.textContent).toContain("$5 (default)");
    expect(toastText()).toBe("Cap cleared");
  });

  it("takes the default from the server's answer, so a switched-off default reads no cap", async () => {
    await show({ query: { view: "simple" } });
    const row = rowOf("acme/one");
    expect(row.textContent).toContain("$5 (default)");
    putDefault = null; // the admin switched the default off while the page was open
    input(row).value = "";
    save(row).click();
    await flush();
    expect(sent[0]!.body).toEqual({ dailyBudgetUsd: null });
    expect(row.textContent).toContain("no cap");
    expect(row.textContent).not.toContain("$5 (default)");
    expect(input(row).placeholder).toBe("no cap");
  });

  it("refuses a bad value without sending, and shows a server refusal on the row", async () => {
    await show({ query: { view: "simple" } });
    const row = rowOf("acme/one");
    input(row).value = "0";
    save(row).click();
    await flush();
    expect(sent).toEqual([]);
    expect(row.textContent).toContain(repos.CAP_PROBLEM);
    putError = { status: 400, error: "dailyBudgetUsd must be a number above 0, or null" };
    input(row).value = "4";
    save(row).click();
    await flush();
    expect(row.textContent).toContain("dailyBudgetUsd must be a number above 0, or null");
    expect(save(row).disabled).toBe(false);
  });

  it("says when cost limits are off", async () => {
    budgets.r1.enforced = false;
    await show({ query: { view: "simple" } });
    expect(main().textContent).toContain("Cost limits are off in Settings");
  });

  it("keeps the table when the projects cannot be loaded, and marks one unreadable cap", async () => {
    reposFail = true;
    await show({ query: { view: "simple" } });
    expect(names()).toEqual(["Ann", "Cy"]);
    expect(main().textContent).toContain("The projects could not be loaded.");
    reposFail = false;
    budgetFail.add("r2");
    await show({ query: { view: "simple" } });
    expect(rowOf("local-two").textContent).toContain("not available");
    expect(input(rowOf("local-two"))).toBeUndefined();
    expect(input(rowOf("acme/one"))).toBeDefined();
  });

  it("shows no field and no button when read-only", async () => {
    await show({ query: { view: "simple" }, readOnly: true });
    expect(rowOf("local-two").textContent).toContain("$2.5 (own)");
    expect(main().all("input").some((i) => i.attrs.name === "cap")).toBe(false);
    expect(main().all("button").some((b) => b.textContent === "Save")).toBe(false);
    expect(toggle()).toBeDefined();
  });

  it("draws nothing for a late answer after the person left the page", async () => {
    (globalThis as any).location = { hash: "#/users?view=simple" };
    const into = new FakeElement("div");
    const done = repos.renderSimpleProjects(into, [USERS[1]], { live: () => (globalThis as any).location.hash.startsWith("#/users") });
    (globalThis as any).location = { hash: "#/runs" };
    await done;
    expect(into.all("h2")).toHaveLength(0);
  });
});
