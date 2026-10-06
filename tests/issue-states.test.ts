import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ISSUE_STATE_BATCH, issueState, issueStates } from "../src/github.js";
import {
  dropIssueStates, issueStatesDir, knownIssueState, markIssueCheckFailed, noteIssueState, readIssueStates, saveIssueStates, storedIssueRepos,
} from "../src/issue-states.js";
import { fakeGithub } from "./helpers/fake-github.js";

const run = promisify(execFile);
const T1 = new Date("2026-01-02T03:04:05.000Z");
const T2 = new Date("2026-01-03T03:04:05.000Z");
const states = (o: Record<number, "open" | "closed">) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
const fileFor = (repo: string) => join(issueStatesDir(), `${encodeURIComponent(repo)}.json`);

describe("issue state store", () => {
  beforeEach(() => rmSync(issueStatesDir(), { recursive: true, force: true }));

  it("has nothing without a file", () => {
    expect(knownIssueState("a/b", 4)).toBeUndefined();
    expect(readIssueStates("a/b")).toBeUndefined();
    expect(storedIssueRepos()).toEqual([]);
  });

  it("stores open and closed with times; an issue not stored is undefined", () => {
    saveIssueStates("a/b", states({ 4: "closed", 5: "open" }), T1);
    expect(knownIssueState("a/b", 4)).toBe("closed");
    expect(knownIssueState("a/b", "5")).toBe("open");
    expect(knownIssueState("a/b", "005")).toBe("open");
    expect(knownIssueState("a/b", 6)).toBeUndefined();
    const r = readIssueStates("a/b")!;
    expect(r.checkedAt).toBe(T1.toISOString());
    expect(r.failedAt).toBeUndefined();
    expect(r.issues["4"]).toEqual({ state: "closed", at: T1.toISOString() });
  });

  it("replaces the entry with exactly the new issues", () => {
    saveIssueStates("a/b", states({ 4: "closed", 5: "open" }), T1);
    saveIssueStates("a/b", states({ 7: "open" }), T2);
    expect(Object.keys(readIssueStates("a/b")!.issues)).toEqual(["7"]);
    expect(knownIssueState("a/b", 4)).toBeUndefined();
  });

  it("a failed check without a file makes every issue unknown", () => {
    markIssueCheckFailed("a/b", T1);
    expect(knownIssueState("a/b", 4)).toBe("unknown");
  });

  it("a failed check keeps the stored states; a later save clears it", () => {
    saveIssueStates("a/b", states({ 4: "closed" }), T1);
    markIssueCheckFailed("a/b", T2);
    expect(knownIssueState("a/b", 4)).toBe("closed");
    expect(knownIssueState("a/b", 9)).toBe("unknown");
    expect(readIssueStates("a/b")).toMatchObject({ checkedAt: T1.toISOString(), failedAt: T2.toISOString() });
    saveIssueStates("a/b", states({ 4: "closed" }), T2);
    expect(readIssueStates("a/b")!.failedAt).toBeUndefined();
    expect(knownIssueState("a/b", 9)).toBeUndefined();
  });

  it("noteIssueState updates one issue and leaves checkedAt; no entry means nothing happens", () => {
    noteIssueState("a/b", 4, "closed", T2);
    expect(readIssueStates("a/b")).toBeUndefined();
    saveIssueStates("a/b", states({ 4: "open", 5: "open" }), T1);
    noteIssueState("a/b", 4, "closed", T2);
    const r = readIssueStates("a/b")!;
    expect(r.issues["4"]).toEqual({ state: "closed", at: T2.toISOString() });
    expect(r.issues["5"]!.state).toBe("open");
    expect(r.checkedAt).toBe(T1.toISOString());
  });

  it("dropIssueStates removes the file and the cache; a second drop is fine", () => {
    saveIssueStates("a/b", states({ 4: "open" }), T1);
    expect(knownIssueState("a/b", 4)).toBe("open");
    dropIssueStates("a/b");
    expect(knownIssueState("a/b", 4)).toBeUndefined();
    expect(readdirSync(issueStatesDir())).toEqual([]);
    expect(() => dropIssueStates("a/b")).not.toThrow();
  });

  it("a broken or oddly shaped file reads as no entry", () => {
    mkdirSync(issueStatesDir(), { recursive: true });
    const good = { repo: "a/b", checkedAt: T1.toISOString(), issues: { "4": { state: "open", at: T1.toISOString() } } };
    const bad: unknown[] = [
      "{ nope",
      [],
      null,
      { ...good, issues: [] },
      { ...good, issues: { "4": { state: "merged", at: T1.toISOString() } } },
      { ...good, issues: { "4": { state: "open", at: "yesterday" } } },
      { ...good, issues: { "4": { state: "open" } } },
      { ...good, issues: { "04": { state: "open", at: T1.toISOString() } } },
      { ...good, issues: { "0": { state: "open", at: T1.toISOString() } } },
      { ...good, issues: { "2147483648": { state: "open", at: T1.toISOString() } } },
      { ...good, issues: { x: { state: "open", at: T1.toISOString() } } },
      { ...good, failedAt: 7 },
      { ...good, checkedAt: "soon" },
      { ...good, repo: 5 },
      { ...good, repo: "c/d" },
    ];
    for (const b of bad) {
      writeFileSync(fileFor("a/b"), typeof b === "string" ? b : JSON.stringify(b));
      expect(readIssueStates("a/b"), JSON.stringify(b)).toBeUndefined();
      expect(knownIssueState("a/b", 4), JSON.stringify(b)).toBeUndefined();
    }
    writeFileSync(fileFor("a/b"), JSON.stringify(good));
    expect(knownIssueState("a/b", 4)).toBe("open");
  });

  it("sees a file that was rewritten by hand", () => {
    saveIssueStates("a/b", states({ 4: "open" }), T1);
    expect(knownIssueState("a/b", 4)).toBe("open");
    writeFileSync(fileFor("a/b"), JSON.stringify({ repo: "a/b", issues: { "4": { state: "closed", at: T1.toISOString() }, "8": { state: "open", at: T1.toISOString() } } }));
    expect(knownIssueState("a/b", 4)).toBe("closed");
    expect(knownIssueState("a/b", 8)).toBe("open");
  });

  it("keeps two repositories apart and leaves no temporary file", () => {
    saveIssueStates("a/b", states({ 1: "open" }), T1);
    saveIssueStates("c/d", states({ 1: "closed" }), T1);
    expect(knownIssueState("a/b", 1)).toBe("open");
    expect(knownIssueState("c/d", 1)).toBe("closed");
    expect(storedIssueRepos().sort()).toEqual(["a/b", "c/d"]);
    expect(readdirSync(issueStatesDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("two processes writing two repositories do not overwrite each other", async () => {
    const script = `
      const m = await import(${JSON.stringify(resolve("dist/issue-states.js"))});
      const repo = process.argv[1];
      for (let i = 1; i <= 150; i++) m.saveIssueStates(repo, new Map([[i, i % 2 ? "open" : "closed"]]));
    `;
    await Promise.all(["a/b", "c/d"].map((repo) => run(process.execPath, ["--input-type=module", "-e", script, repo], { env: process.env })));
    expect(Object.keys(readIssueStates("a/b")!.issues)).toEqual(["150"]);
    expect(Object.keys(readIssueStates("c/d")!.issues)).toEqual(["150"]);
    expect(readdirSync(issueStatesDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("repository names stay inside the folder", () => {
    for (const repo of ["a/..", "a.b/c-d", "../x/y"]) {
      saveIssueStates(repo, states({ 1: "open" }), T1);
      expect(knownIssueState(repo, 1)).toBe("open");
    }
    expect(readdirSync(issueStatesDir())).toHaveLength(3);
    expect(storedIssueRepos().sort()).toEqual(["../x/y", "a.b/c-d", "a/.."]);
  });
});

describe("issueStates (GitHub)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => { gh = fakeGithub(); });
  afterEach(() => {
    for (const k of ["FAKE_GH_FRESH", "FAKE_GH_FAIL", "FAKE_GH_GRAPHQL_MISSING", "FAKE_GH_GRAPHQL_FAIL_AFTER", "FAKE_GH_GRAPHQL_MAX"]) delete process.env[k];
    gh.restore();
  });
  const calls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh api graphql"));
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("makes no call for an empty list", async () => {
    expect((await issueStates("acme/app", [])).size).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("asks once and maps the states", async () => {
    process.env.FAKE_GH_FRESH = JSON.stringify([{ number: 4, state: "CLOSED" }]);
    expect(await issueStates("acme/app", [4, 5])).toEqual(states({ 4: "closed", 5: "open" }));
    expect(calls()).toEqual(["gh api graphql --input -"]);
  });

  it("leaves out duplicate and invalid numbers", async () => {
    const r = await issueStates("acme/app", [3, 3, 0, -1, 1.5, NaN, 2147483648]);
    expect([...r.keys()]).toEqual([3]);
  });

  it("splits only above 500 numbers", async () => {
    expect(ISSUE_STATE_BATCH).toBe(500);
    expect((await issueStates("acme/app", many(500))).size).toBe(500);
    expect(calls()).toHaveLength(1);
    expect((await issueStates("acme/app", many(501))).size).toBe(501);
    expect(calls()).toHaveLength(3);
  });

  it("rejects when the call fails, the query is too large, or the repository is not owner/name", async () => {
    process.env.FAKE_GH_FAIL = "api graphql";
    await expect(issueStates("acme/app", [1])).rejects.toThrow();
    delete process.env.FAKE_GH_FAIL;
    process.env.FAKE_GH_GRAPHQL_MAX = "3";
    await expect(issueStates("acme/app", many(4))).rejects.toThrow();
    delete process.env.FAKE_GH_GRAPHQL_MAX;
    await expect(issueStates("acme", [1])).rejects.toThrow(/not a repository/);
    await expect(issueStates("/app", [1])).rejects.toThrow(/not a repository/);
  });

  it("rejects the whole call on a GraphQL error, such as a deleted issue", async () => {
    process.env.FAKE_GH_GRAPHQL_MISSING = "5";
    await expect(issueStates("acme/app", [4, 5, 6])).rejects.toThrow();
  });

  it("rejects when a later chunk fails, with no partial answer", async () => {
    process.env.FAKE_GH_GRAPHQL_FAIL_AFTER = "1";
    await expect(issueStates("acme/app", many(501))).rejects.toThrow();
    expect(calls()).toHaveLength(2);
  });

  it("stops asking when `before` throws", async () => {
    let n = 0;
    await expect(issueStates("acme/app", many(1001), undefined, () => { if (++n > 1) throw new Error("given up"); })).rejects.toThrow("given up");
    expect(calls()).toHaveLength(1);
  });

  it("issueState gives one value and rejects an invalid number", async () => {
    process.env.FAKE_GH_FRESH = JSON.stringify([{ number: 4, state: "CLOSED" }]);
    expect(await issueState("acme/app", 4)).toBe("closed");
    expect(await issueState("acme/app", 5)).toBe("open");
    await expect(issueState("acme/app", 0)).rejects.toThrow("not an issue number");
    expect(readFileSync(join(gh.tmp, "gh.log"), "utf8")).toContain("gh api graphql");
  });
});
