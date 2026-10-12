import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rf: any;
let c: any;
beforeAll(async () => {
  restore = installFakeDom();
  rf = await import("../ui/runs-filter.js" as string);
  c = await import("../ui/context.js" as string);
});
afterAll(() => restore());

const FULL = "#/runs?q=boom&repo=acme%2Fapp&flow=build&status=failed&time=7d&owner=u1&needs=1&view=failed";
const full = { q: "boom", repo: "acme/app", flow: "build", status: "failed", time: "7d", owner: "u1", needs: true, view: "failed" };

describe("parseFilter", () => {
  it("reads all eight keys", () => {
    expect(rf.parseFilter(FULL)).toEqual(full);
  });
  it("gives the empty filter for no query, odd input and unknown keys", () => {
    expect(rf.parseFilter("#/runs")).toEqual(rf.emptyFilter());
    for (const x of [undefined, null, 5, {}]) expect(rf.parseFilter(x as any)).toEqual(rf.emptyFilter());
    expect(rf.parseFilter("#/runs?x=1&__proto__=2")).toEqual(rf.emptyFilter());
  });
  it("drops wrong values", () => {
    expect(rf.parseFilter("#/runs?status=nope&time=1y&view=all&needs=2&repo=bad&owner=a%20b")).toEqual(rf.emptyFilter());
  });
  it("limits the search to 200 characters and drops blank text", () => {
    expect(rf.parseFilter(`#/runs?q=${"a".repeat(200)}`).q).toHaveLength(200);
    expect(rf.parseFilter(`#/runs?q=${"a".repeat(201)}`).q).toBe("");
    expect(rf.parseFilter("#/runs?q=%20%20").q).toBe("");
    expect(rf.parseFilter("#/runs?q=%20a%20").q).toBe("a");
  });
  it("reads repo=all as no repository, skips bad encoding and lets the first key win", () => {
    expect(rf.parseFilter("#/runs?repo=all").repo).toBe("");
    expect(rf.parseFilter("#/runs?q=%E0%A4%A&flow=f").flow).toBe("f");
    expect(rf.parseFilter("#/runs?q=%E0%A4%A").q).toBe("");
    expect(rf.parseFilter("#/runs?flow=a&flow=b").flow).toBe("a");
  });
});

describe("filterHash", () => {
  it("writes the keys in a fixed order", () => {
    expect(rf.filterHash(full)).toBe(FULL);
    expect(rf.filterHash({ view: "failed", owner: "u1", q: "x" })).toBe("#/runs?q=x&owner=u1&view=failed");
  });
  it("writes #/runs for the empty filter and repo=all on request", () => {
    expect(rf.filterHash(rf.emptyFilter())).toBe("#/runs");
    expect(rf.filterHash(rf.emptyFilter(), { allRepos: true })).toBe("#/runs?repo=all");
    expect(rf.filterHash({ ...rf.emptyFilter(), owner: "u1" }, { allRepos: true })).toBe("#/runs?repo=all&owner=u1");
    expect(rf.filterHash({ repo: "a/b" }, { allRepos: true })).toBe("#/runs?repo=a%2Fb");
  });
  it("round-trips and keeps today's addresses", () => {
    expect(rf.parseFilter(rf.filterHash(full))).toEqual(full);
    expect(rf.filterHash(rf.parseFilter("#/runs?repo=acme%2Fapp&owner=u1"))).toBe("#/runs?repo=acme%2Fapp&owner=u1");
  });
  it("leaves out values the address would not read back", () => {
    expect(rf.filterHash({ status: "nope", repo: "bad", q: "a".repeat(201) })).toBe("#/runs");
  });
});

describe("sinceOf and filterQuery", () => {
  const now = new Date(2026, 5, 15, 13, 30).getTime();
  it("is local midnight today, 7 or 30 days before", () => {
    expect(rf.sinceOf("today", now)).toBe(new Date(2026, 5, 15).toISOString());
    expect(rf.sinceOf("7d", now)).toBe(new Date(2026, 5, 8).toISOString());
    expect(rf.sinceOf("30d", now)).toBe(new Date(2026, 4, 16).toISOString());
    expect(rf.sinceOf("", now)).toBe("");
    expect(rf.sinceOf("1y", now)).toBe("");
    expect(rf.sinceOf("today", now)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
  it("gives only the set keys, never needs or view", () => {
    expect(rf.filterQuery(rf.emptyFilter(), now)).toEqual({});
    expect(rf.filterQuery(full, now)).toEqual({ q: "boom", repo: "acme/app", flow: "build", status: "failed", since: rf.sinceOf("7d", now), owner: "u1" });
    expect(rf.filterQuery({ ...rf.emptyFilter(), needs: true, view: "needs" }, now)).toEqual({});
  });
  it("asks for the archived runs in the Archived view only, with the other keys", () => {
    expect(rf.filterQuery({ ...rf.emptyFilter(), view: "archived" }, now)).toEqual({ archived: "1" });
    expect(rf.filterQuery({ ...rf.emptyFilter(), q: "x", repo: "a/b", view: "archived" }, now)).toEqual({ q: "x", repo: "a/b", archived: "1" });
    expect(rf.filterQuery({ ...rf.emptyFilter(), view: "failed" }, now)).toEqual({});
  });
  it("keeps view=archived in the address", () => {
    expect(rf.parseFilter("#/runs?view=archived").view).toBe("archived");
    expect(rf.filterHash({ view: "archived" })).toBe("#/runs?view=archived");
  });
});

describe("canonRepos and serverKey", () => {
  it("finds every spelling in the list", () => {
    expect(rf.canonRepos("ACME/app", ["Acme/App", "other/x"])).toEqual(["Acme/App"]);
    expect(rf.canonRepos("a/b", ["acme/app"])).toEqual([]);
    expect(rf.canonRepos("acme/app", ["acme/app", "Acme/App"])).toEqual(["acme/app", "Acme/App"]);
    expect(rf.canonRepos("a/b", undefined)).toEqual([]);
    expect(rf.canonRepos("", ["a/b"])).toEqual([]);
  });
  it("changes only with what the server is asked", () => {
    expect(rf.serverKey({ ...full, needs: false, view: "" })).toBe(rf.serverKey(full));
    expect(rf.serverKey({ ...full, q: "other" })).not.toBe(rf.serverKey(full));
  });
  it("changes when the view goes to or from Archived, not between other views", () => {
    expect(rf.serverKey({ ...full, view: "archived" })).not.toBe(rf.serverKey({ ...full, view: "" }));
    expect(rf.serverKey({ ...full, view: "failed" })).toBe(rf.serverKey({ ...full, view: "" }));
  });
});

describe("jobMatches", () => {
  const now = new Date(2026, 5, 15, 13, 30).getTime();
  const job = { runId: "q9", githubRepo: "Acme/App", flow: "build", enqueuedAt: new Date(2026, 5, 15, 9).toISOString(), ownerName: "Ann", issue: "7", task: "fix login\nmore" };
  const ok = (f: object, o: object = { now }) => rf.jobMatches(job, { ...rf.emptyFilter(), ...f }, o);
  it("matches with no filter and with each key alone", () => {
    expect(ok({})).toBe(true);
    expect(ok({ view: "archived" })).toBe(false); // an archived run has no queued job
    expect(ok({ repo: "acme/app" })).toBe(true);
    expect(ok({ repo: "other/x" })).toBe(false);
    expect(ok({ flow: "build" })).toBe(true);
    expect(ok({ flow: "other" })).toBe(false);
    expect(ok({ time: "today" })).toBe(true);
    expect(ok({ time: "today" }, { now: now + 2 * 86_400_000 })).toBe(false);
    expect(ok({ owner: "u1" }, { now, ownerName: "Ann" })).toBe(true);
    expect(ok({ owner: "u1" }, { now, ownerName: "Bob" })).toBe(false);
    expect(ok({ owner: "u1" })).toBe(false); // an unknown owner hides the job
  });
  it("hides the job under a status", () => {
    expect(ok({ status: "running" })).toBe(false);
  });
  it("searches id, flow, repository, #issue, repo#issue and the first line of the task", () => {
    for (const q of ["q9", "BUI", "acme/app", "#7", "acme/app#7", "login"]) expect(ok({ q }), q).toBe(true);
    for (const q of ["more", "#8", "zzz"]) expect(ok({ q }), q).toBe(false);
  });
});

describe("isActive, isServerActive and countText", () => {
  it("tell what is set", () => {
    expect(rf.isActive(rf.emptyFilter())).toBe(false);
    expect(rf.isActive({ ...rf.emptyFilter(), needs: true })).toBe(true);
    expect(rf.isServerActive({ ...rf.emptyFilter(), needs: true, view: "failed" })).toBe(false);
    expect(rf.isServerActive({ ...rf.emptyFilter(), time: "30d" })).toBe(true);
  });
  it("counts", () => {
    expect(rf.countText(0)).toBe("0 runs match.");
    expect(rf.countText(1)).toBe("1 run matches.");
    expect(rf.countText(2)).toBe("2 runs match.");
  });
});

describe("the context keeps the Runs filter", () => {
  const ctx = { active: true, repo: "a/b", own: true };
  it("chosenHash keeps the other keys", () => {
    expect(c.chosenHash("admin", "#/runs?q=x&status=failed&needs=1&view=failed", ctx)).toBe("#/runs?q=x&repo=a%2Fb&status=failed&needs=1&view=failed");
    expect(c.chosenHash("admin", "#/runs?owner=u1", ctx)).toBe("#/runs?repo=a%2Fb&owner=u1");
  });
  it("clearedHash keeps the other keys and writes repo=all", () => {
    expect(c.clearedHash("admin", "#/runs?flow=f&time=7d", ctx)).toBe("#/runs?repo=all&flow=f&time=7d");
    expect(c.clearedHash("admin", "#/runs?owner=u1", ctx)).toBe("#/runs?repo=all&owner=u1");
    expect(c.clearedHash("admin", "#/runs?repo=x%2Fy&q=a", ctx)).toBe("#/runs?repo=x%2Fy&q=a");
  });
});
