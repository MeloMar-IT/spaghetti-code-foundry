import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let backlog: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  backlog = await import("../ui/refinement-backlog.js" as string);
});
afterAll(() => restore());

type Answer = { status: number; error: string };
let repos: string[];
let issues: any[];
let cut: boolean;
let sent: { method: string; url: string; body: any }[];
let backlogAnswer: Answer | undefined;
const realFetch = globalThis.fetch;

const row = (number: number, over: object = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  checks: { criteria: true, value: true, dependencies: true, questions: true },
  ...over,
});

beforeEach(() => {
  repos = ["acme/app", "acme/two"];
  issues = [];
  cut = false;
  sent = [];
  backlogAnswer = undefined;
  (globalThis as any).location = { hash: "#/refinement/backlog" };
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === "/api/refinement") return reply(init.method === "GET" ? { sessions: [], repos } : { id: "new1" }, init.method === "GET" ? 200 : 201);
    if (url.startsWith("/api/refinement/backlog")) {
      if (backlogAnswer) return reply({ error: backlogAnswer.error }, backlogAnswer.status);
      return reply({ repo: decodeURIComponent(url.split("repo=")[1]!), issues, cut });
    }
    return reply({ error: "no" }, 404);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const buttons = (text: string) => walk(main()).filter((e) => e.tag === "button" && e.textContent === text);
const links = (text: string) => walk(main()).filter((e) => e.tag === "a" && e.textContent === text);
const show = async (readOnly = false) => {
  await ui.renderRefinement(main(), { id: "backlog", readOnly });
  await flush();
};
const backlogRequests = () => sent.filter((s) => s.url.startsWith("/api/refinement/backlog"));

describe("the list page", () => {
  it("has a Backlog readiness link, and not in a preview", async () => {
    (globalThis as any).location.hash = "#/refinement";
    await ui.renderRefinement(main(), {});
    expect(links("Backlog readiness").map((a) => a.attrs.href)).toEqual(["#/refinement/backlog"]);
    await ui.renderRefinement(main(), { readOnly: true });
    expect(links("Backlog readiness")).toEqual([]);
  });
});

describe("the backlog page", () => {
  it("draws the chooser, the rows and four marks with their labels", async () => {
    issues = [row(3, { missing: [7, 9], checks: { criteria: true, value: false, dependencies: false, questions: true } }), row(2)];
    await show();
    expect(main().textContent).toContain("Backlog readiness");
    expect(walk(main()).filter((e) => e.tag === "option").map((e) => e.textContent)).toEqual(["acme/app", "acme/two"]);
    expect(backlogRequests().map((s) => s.url)).toEqual(["/api/refinement/backlog?repo=acme%2Fapp"]);
    const marks = walk(main()).filter((e) => e.tag === "span" && e.attrs["aria-label"]).map((e) => e.attrs["aria-label"]);
    expect(marks.slice(0, 4)).toEqual([
      "Acceptance criteria: yes",
      "Value sentence: no",
      "Depends on: no — not found: #7, #9",
      "No open questions: yes",
    ]);
    expect(marks).toHaveLength(8);
    expect(links("#3").map((a) => a.attrs.href)).toEqual(["https://github.com/acme/app/issues/3"]);
    expect(buttons("Refine")).toHaveLength(2);
  });

  it("shows a link only for an https address", async () => {
    issues = [row(3, { url: "javascript:alert(1)" })];
    await show();
    expect(main().textContent).toContain("#3");
    expect(links("#3")).toEqual([]);
  });

  it("starts a session with Refine and opens it", async () => {
    issues = [row(3)];
    await show();
    buttons("Refine")[0]!.click();
    await flush();
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ method: "POST", url: "/api/refinement", body: { repo: "acme/app", issue: 3 } }]);
    expect((globalThis as any).location.hash).toBe("#/refinement/new1");
  });

  it("shows Open session instead of Refine when a session is open", async () => {
    issues = [row(3, { session: "s-9" }), row(2)];
    await show();
    expect(links("Open session").map((a) => a.attrs.href)).toEqual(["#/refinement/s-9"]);
    expect(buttons("Refine")).toHaveLength(1);
  });

  it("loads the list again for another repository", async () => {
    await show();
    const select = walk(main()).find((e) => e.tag === "select")!;
    select.value = "acme/two";
    select.fire("change");
    await flush();
    expect(backlogRequests().map((s) => s.url)).toEqual(["/api/refinement/backlog?repo=acme%2Fapp", "/api/refinement/backlog?repo=acme%2Ftwo"]);
  });

  it("says when GitHub cannot be read, with a link to My repositories", async () => {
    backlogAnswer = { status: 502, error: "could not read the issues on GitHub: boom" };
    await show();
    const bad = walk(main()).filter((e) => e.attrs.class === "status bad").map((e) => e.textContent);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("could not read the issues on GitHub: boom");
    expect(bad[0]).toContain("Check the repository's sign-in");
    expect(links("Go to My repositories").map((a) => a.attrs.href)).toEqual(["#/repos"]);
  });

  it("notes a full page, an empty list and no repositories", async () => {
    cut = true;
    issues = [row(1)];
    await show();
    expect(main().textContent).toContain("full page of 100 issues and pull requests");
    cut = false;
    issues = [];
    await show();
    expect(main().textContent).toContain("No open issues to refine here.");
    repos = [];
    await show();
    expect(main().textContent).toContain("You need a GitHub repository first.");
    expect(links("Go to My repositories")).toHaveLength(1);
  });

  it("makes no request at all in a preview", async () => {
    await show(true);
    expect(sent).toEqual([]);
    expect(main().textContent).toContain("not shown in a preview");
  });
});

describe("checkMark", () => {
  it("says the check and the missing issues", () => {
    expect(backlog.checkMark(true, "Depends on").attrs["aria-label"]).toBe("Depends on: yes");
    expect(backlog.checkMark(false, "Depends on", [3]).attrs["aria-label"]).toBe("Depends on: no — not found: #3");
  });
});
