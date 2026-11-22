import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let view: any;
beforeAll(async () => {
  restore = installFakeDom();
  view = await import("../ui/repo-view.js" as string);
});
afterAll(() => restore());

let repos: any[];
let gets: string[];
let posts: { url: string; body: any }[];
let navs: string[];
let flowsAnswer: any[] | "fail";
let startAnswer: { status: number; body: unknown };
let gate: Promise<void> | undefined;
const realFetch = globalThis.fetch;
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
let n = 1;
const rec = (url = "https://github.com/o/a") => ({ id: `r${n++}`, url, method: "github-token", added: "2026-03-04T10:00:00.000Z" });

beforeEach(() => {
  repos = [];
  gets = [];
  posts = [];
  navs = [];
  flowsAnswer = [{ name: "repo-review" }];
  startAnswer = { status: 200, body: { runId: "run-1" } };
  gate = undefined;
  delete (globalThis as any).location;
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") gets.push(url);
    if (init.method === "GET" && url.startsWith("/api/flows")) return flowsAnswer === "fail" ? reply({ error: "down" }, 500) : reply(flowsAnswer);
    if (init.method === "GET" && url === "/api/repos/methods") return reply({ methods: ["github-token"], githubApp: { available: false } });
    if (init.method === "GET" && url.startsWith("/api/runs")) return reply([]);
    if (init.method === "GET" && url.endsWith("/ready")) return reply({ items: [], isDefault: true });
    if (init.method === "GET" && url.endsWith("/preview")) return reply({});
    if (init.method === "GET" && url.endsWith("/safe-points")) return reply({ branch: "develop", gitflow: true, complete: true, points: [] });
    if (init.method === "GET" && url.startsWith("/api/outcomes")) return reply({ values: { flows: [] }, definitions: [], measures: [] });
    if (init.method === "GET") return reply([...repos]);
    if (init.method === "POST" && url === "/api/runs") {
      posts.push({ url, body: JSON.parse(init.body ?? "{}") });
      if (gate) await gate;
      return reply(startAnswer.body, startAnswer.status);
    }
    return reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const review = () => walk(main()).find((e) => e.tag === "button" && e.textContent === "Review this repository");
const ready = () => walk(main()).find((e) => e.tag === "button" && e.textContent === "Definition of Ready");
const alerts = () => walk(main()).filter((e) => e.attrs.role === "alert");
const show = async (r: any, opts: { admin?: boolean; readOnly?: boolean } = {}) => {
  repos = [r];
  await view.renderRepo(main(), { id: r.id, admin: false, nav: (h: string) => navs.push(h), ...opts });
  await flush();
};

describe("the Review this repository button", () => {
  it("is shown to a user when the flow is listed", async () => {
    await show(rec());
    expect(review()?.attrs["data-action"]).toBe("review");
    expect(gets).toContain("/api/flows");
  });

  it("is shown to an admin", async () => {
    flowsAnswer = [{ name: "issue-gitflow" }, { name: "repo-review" }];
    await show(rec(), { admin: true });
    expect(review()).toBeDefined();
  });

  it("is hidden when the flow is not listed", async () => {
    flowsAnswer = [{ name: "issue-gitflow" }];
    await show(rec());
    expect(review()).toBeUndefined();
    expect(ready()).toBeDefined();
  });

  it("is hidden, without an alert, when the flows call fails", async () => {
    flowsAnswer = "fail";
    await show(rec());
    expect(review()).toBeUndefined();
    expect(alerts()).toEqual([]);
  });

  it("is hidden for an address that is not GitHub, with no flows request", async () => {
    await show(rec("https://gitlab.com/o/a"));
    expect(review()).toBeUndefined();
    expect(gets.some((u) => u.startsWith("/api/flows"))).toBe(false);
  });

  it("is hidden in a read-only view, with no flows request", async () => {
    await show(rec(), { readOnly: true });
    expect(review()).toBeUndefined();
    expect(gets.some((u) => u.startsWith("/api/flows"))).toBe(false);
  });

  it("starts the run, is off while it starts, then opens the run", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    await show(rec());
    review()!.click();
    await flush();
    expect(review()!.disabled).toBe(true);
    review()!.click();
    await flush();
    expect(posts).toEqual([{ url: "/api/runs", body: { flow: "repo-review", vars: { github_repo: "o/a" } } }]);
    release();
    await flush();
    expect(navs).toEqual(["#/runs/run-1"]);
    expect(posts).toHaveLength(1);
  });

  it("sends the lower-case name of the repository", async () => {
    await show(rec("https://github.com/O/A.git"));
    review()!.click();
    await flush();
    expect(posts[0].body.vars.github_repo).toBe("o/a");
  });

  it("shows an alert on an error, opens nothing and works again", async () => {
    startAnswer = { status: 403, body: { error: '"o/a" is not one of your repositories' } };
    await show(rec());
    review()!.click();
    await flush();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].textContent).toContain("Could not start the review.");
    expect(navs).toEqual([]);
    expect(review()!.disabled).toBe(false);
    review()!.click();
    await flush();
    expect(posts).toHaveLength(2);
  });

  it("treats an answer without a run as an error", async () => {
    startAnswer = { status: 200, body: {} };
    await show(rec());
    review()!.click();
    await flush();
    expect(alerts()).toHaveLength(1);
    expect(navs).toEqual([]);
  });
});
