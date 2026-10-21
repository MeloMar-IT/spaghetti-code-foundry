import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OUTCOME_DEFINITIONS } from "../src/outcomes.js";
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
let outcomeUrls: string[];
let outcomeAnswers: (() => { status: number; body: unknown })[];
const realFetch = globalThis.fetch;
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
const good = () => ({
  values: { flows: ["feature", "fix"], models: ["m1"], policies: ["p@1"] },
  definitions: OUTCOME_DEFINITIONS,
  measures: OUTCOME_DEFINITIONS.map((d) => ({ id: d.id, value: null, detail: {}, counted: 0, excluded: 0 })),
});
let n = 1;
const rec = (url = "https://github.com/o/a") => ({ id: `r${n++}`, url, method: "github-token", added: "2026-03-04T10:00:00.000Z" });

beforeEach(() => {
  repos = [];
  outcomeUrls = [];
  outcomeAnswers = [];
  delete (globalThis as any).location;
  (globalThis as any).fetch = async (url: string, init: { method: string }) => {
    if (init.method === "GET" && url.startsWith("/api/outcomes")) {
      outcomeUrls.push(url);
      const a = outcomeAnswers.shift();
      return a ? (({ status, body }) => reply(body, status))(a()) : reply(good());
    }
    if (init.method === "GET" && url === "/api/repos/methods") return reply({ methods: ["github-token"], githubApp: { available: false } });
    if (init.method === "GET" && url.startsWith("/api/runs")) return reply([]);
    if (init.method === "GET" && url.endsWith("/ready")) return reply({ items: [], isDefault: true });
    if (init.method === "GET") return reply([...repos]);
    if (init.method === "POST" && url.endsWith("/test")) return reply({ at: new Date().toISOString(), ok: true, checks: [] });
    return reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const section = (id: string) => walk(main()).find((e) => e.attrs.id === `repo-section-${id}`)!;
const select = (name: string) => walk(section("outcomes")).find((e) => e.tag === "select" && e.attrs.name === name)!;
const labelOf = (text: string) => walk(section("outcomes")).find((e) => e.tag === "label" && e.textContent.startsWith(text))!;
const choose = async (name: string, value: string) => {
  const s = select(name);
  s.value = value;
  s.fire("change", { target: s });
  await flush();
};
const show = async (r: any, admin: boolean) => {
  repos = [r];
  await view.renderRepo(main(), { id: r.id, admin, nav: () => {} });
  await flush();
};

describe("the Outcomes card on the repository page", () => {
  it("user session: no cost, returning users, model or policy filter; says what is for admins", async () => {
    await show(rec(), false);
    expect(section("outcomes")).toBeDefined();
    expect(outcomeUrls).toEqual(["/api/outcomes?repo=o%2Fa&days=30"]);
    expect(labelOf("Model route").hidden).toBe(true);
    expect(labelOf("Policy version").hidden).toBe(true);
    expect(labelOf("Repository").hidden).toBe(true);
    const text = section("outcomes").textContent;
    expect(text).not.toContain("Cost per successful run");
    expect(text).not.toContain("Returning users");
    expect(text).toContain("1 measure to read with this is for admins only.");
    await choose("flow", "feature");
    await choose("days", "7");
    expect(outcomeUrls.slice(1)).toEqual(["/api/outcomes?repo=o%2Fa&flow=feature&days=30", "/api/outcomes?repo=o%2Fa&flow=feature&days=7"]);
    expect(outcomeUrls.some((u) => /model=|policy=/.test(u))).toBe(false);
  });

  it("admin session: model and policy filters, cost row, no admins-only note", async () => {
    await show(rec(), true);
    expect(labelOf("Model route").hidden).toBe(false);
    expect(labelOf("Policy version").hidden).toBe(false);
    expect(section("outcomes").textContent).toContain("Cost per successful run");
    expect(section("outcomes").textContent).not.toContain("for admins only");
    await choose("model", "m1");
    expect(outcomeUrls.at(-1)).toBe("/api/outcomes?repo=o%2Fa&model=m1&days=30");
  });

  it("a failed load shows a note with Retry; the rest of the page works", async () => {
    outcomeAnswers.push(() => ({ status: 500, body: { error: "boom" } }));
    await show(rec(), false);
    const card = section("outcomes");
    expect(card.textContent).toContain("Could not load the outcomes.");
    expect(button(main(), "Test connection")).toBeDefined();
    expect(button(main(), "Remove")).toBeDefined();
    button(card, "Retry")!.click();
    await flush();
    expect(outcomeUrls.length).toBe(2);
    expect(section("outcomes").textContent).not.toContain("Could not load");
    expect(walk(section("outcomes")).some((e) => e.tag === "table")).toBe(true);
  });

  it("a redraw does not load the card again and keeps the filter", async () => {
    await show(rec(), false);
    await choose("flow", "fix");
    expect(outcomeUrls.length).toBe(2);
    button(main(), "Test connection")!.click();
    await flush();
    expect(outcomeUrls.length).toBe(2);
    expect(select("flow").value).toBe("fix");
  });

  it("a repository that is not on GitHub gets a note and no request", async () => {
    await show(rec("https://git.example.org/x/y"), false);
    expect(section("outcomes").textContent).toContain("Outcomes are measured for GitHub repositories only.");
    expect(outcomeUrls).toEqual([]);
  });

  it.each([
    ["https://github.com/Acme/App.git.git", "acme%2Fapp"],
    ["ssh://git@github.com/acme/app", "acme%2Fapp"],
    ["ssh://github.com/acme/app", "acme%2Fapp"],
    ["git@github.com:/acme/app", "acme%2Fapp"],
    ["git@github.com:acme/app.git", "acme%2Fapp"],
  ])("asks for the canonical name of %s", async (url, name) => {
    await show(rec(url), false);
    expect(outcomeUrls).toEqual([`/api/outcomes?repo=${name}&days=30`]);
  });

  it("ui/outcomes.js does not import the dashboard", () => {
    expect(readFileSync(new URL("../ui/outcomes.js", import.meta.url), "utf8")).not.toContain("dashboard.js");
  });
});
