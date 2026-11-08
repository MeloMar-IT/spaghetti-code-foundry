import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { checkIssueLimitBody, ISSUE_LIMITS_FILE, issueFamily, issueKey, issueLimitState, issueLimitStop, issueOfRun, readIssueLimits, setIssueLimit } from "../src/engine/issue-limit.js";
import { ISSUE_LIMIT_UNCHECKED, isIssueLimitStop, issueLimitReason, type RunSummary } from "../src/engine/state.js";

let base: string;
let runs: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "factory-issue-limit-"));
  runs = join(base, "runs");
  mkdirSync(runs);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const REPO = "acme/app";
let seq = 0;
/** Writes a run.json by hand. `steps` are history records. */
function put(issue: number | undefined, cost: number, o: { id?: string; repo?: string; dir?: string; history?: unknown[]; status?: string } = {}): string {
  const id = o.id ?? `20261107-1000${String(++seq).padStart(2, "0")}-aaaa`;
  const dir = o.dir ?? runs;
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(
    join(dir, id, "run.json"),
    JSON.stringify({ runId: id, startedAt: "2026-11-07T10:00:00Z", totalCostUsd: cost, status: o.status ?? "succeeded", vars: { github_repo: o.repo ?? REPO, ...(issue !== undefined ? { issue: String(issue) } : {}) }, history: o.history ?? [] }),
  );
  return id;
}
const split = (parent: number, parts: number[]) => ({ id: "create_split", ok: true, output: `SPLIT: ${parts.map((p) => `#${p}`).join(" ")} — #${parent} closed` });
const summary = (issue: number | undefined, cost = 0, id = "20261107-999999-live", repo = REPO): RunSummary => ({ runId: id, totalCostUsd: cost, vars: { github_repo: repo, ...(issue !== undefined ? { issue: String(issue) } : {}) } }) as unknown as RunSummary;
const cfg = (limit?: number, costLimits = true) => ({ ...ConfigSchema.parse(limit === undefined ? {} : { limits: { issue_cost_usd: limit } }), cost_limits: costLimits });

describe("issueOfRun and issueKey", () => {
  it("reads GitHub and local runs; refuses a missing or invalid issue", () => {
    expect(issueOfRun({ vars: { github_repo: "Acme/App", issue: "5" } })).toEqual({ project: { githubRepo: "Acme/App" }, issue: 5 });
    expect(issueOfRun({ vars: { repo_id: "r1", issue: "7" } })).toEqual({ project: { repoId: "r1" }, issue: 7 });
    for (const bad of [undefined, "", "0", "-1", "1.5", "x", "12345678901", "05"]) expect(issueOfRun({ vars: { github_repo: REPO, ...(bad !== undefined ? { issue: bad } : {}) } }), String(bad)).toBeUndefined();
    expect(issueOfRun({ vars: { issue: "5" } })).toBeUndefined();
  });
  it("the key is lower case for GitHub", () => {
    expect(issueKey({ project: { githubRepo: "Acme/App" }, issue: 5 })).toBe("github:acme/app#5");
    expect(issueKey({ project: { repoId: "r1" }, issue: 5 })).toBe("local:r1#5");
  });
});

describe("issueFamily", () => {
  const fam = (issue: number, except?: string, repo = REPO) => issueFamily(runs, { project: { githubRepo: repo }, issue }, except);

  it("adds up the runs of one issue, and leaves out other issues, other projects and the excluded run", () => {
    put(5, 1);
    put(5, 2);
    put(6, 10);
    put(5, 100, { repo: "acme/other" });
    const mine = put(5, 4);
    expect(fam(5).spentUsd).toBe(7);
    expect(fam(5, mine).spentUsd).toBe(3);
    expect(fam(5, undefined, "ACME/APP").spentUsd).toBe(7);
  });

  it("skips a cost that is not finite", () => {
    put(5, 1);
    put(5, Number.NaN as unknown as number);
    expect(fam(5).spentUsd).toBe(1);
  });

  it("links the parts of a split: the spend of a part counts the parent and its siblings", () => {
    put(5, 1, { history: [split(5, [6, 7])] });
    put(6, 2);
    put(7, 4);
    const f = fam(7);
    expect(f.root).toBe(5);
    expect(f.issues).toEqual([5, 6, 7]);
    expect(f.spentUsd).toBe(7);
    expect(fam(5).spentUsd).toBe(7);
  });

  it("`already split:` links too, and nested splits count", () => {
    put(5, 1, { history: [{ id: "create_split", ok: true, output: "already split: #6 #7" }] });
    put(7, 2, { history: [split(7, [8])] });
    put(8, 4);
    const f = fam(8);
    expect(f.root).toBe(5);
    expect(f.issues).toEqual([5, 6, 7, 8]);
    expect(f.spentUsd).toBe(7);
  });

  it("does not link a failed, nested or other record", () => {
    put(5, 1, { history: [{ ...split(5, [6]), ok: false }, { ...split(5, [7]), parent: "x" }, { ...split(5, [8]), id: "other" }] });
    put(6, 2);
    expect(fam(6).root).toBe(6);
    expect(fam(6).spentUsd).toBe(2);
  });

  it("a cycle ends", () => {
    put(5, 1, { history: [split(5, [6])] });
    put(6, 2, { history: [split(6, [5])] });
    const f = fam(6);
    expect(f.spentUsd).toBe(3);
  });

  it("counts runs kept in a workspace folder", () => {
    put(5, 1);
    put(5, 2, { dir: join(base, "workspaces", "team-a", "runs") });
    expect(fam(5).spentUsd).toBe(3);
  });

  it("refuses a family of more than 500 issues rather than cutting it short", () => {
    put(1, 1, { history: [split(1, Array.from({ length: 501 }, (_, i) => i + 2))] });
    expect(() => fam(1)).toThrow(/too many/);
  });

  it("throws when a run file or a folder cannot be read", () => {
    put(5, 1);
    mkdirSync(join(runs, "broken"));
    writeFileSync(join(runs, "broken", "run.json"), "{ not json");
    expect(() => fam(5)).toThrow();
  });

  it("throws when a workspace's runs folder cannot be listed", () => {
    if (process.getuid?.() === 0) return;
    const w = join(base, "workspaces", "team-a", "runs");
    mkdirSync(w, { recursive: true });
    chmodSync(w, 0o000);
    try {
      expect(() => fam(5)).toThrow();
    } finally {
      chmodSync(w, 0o755);
    }
  });
});

describe("the overrides", () => {
  it("sets, keeps and clears; the file is private", () => {
    expect(setIssueLimit("github:acme/app#5", 3, "u1", base)).toEqual({ changed: true });
    expect(readIssueLimits(base)["github:acme/app#5"]).toMatchObject({ usd: 3, by: "u1" });
    expect(setIssueLimit("github:acme/app#5", 3, "u1", base)).toEqual({ changed: false });
    expect(statSync(join(base, ISSUE_LIMITS_FILE)).mode & 0o777).toBe(0o600);
    expect(setIssueLimit("github:acme/app#5", null, "u1", base)).toEqual({ changed: true });
    expect(readIssueLimits(base)).toEqual({});
    expect(setIssueLimit("github:acme/app#5", null, "u1", base)).toEqual({ changed: false });
  });
  it("a missing, invalid or linked file reads as empty", () => {
    expect(readIssueLimits(base)).toEqual({});
    writeFileSync(join(base, ISSUE_LIMITS_FILE), "{ nope");
    expect(readIssueLimits(base)).toEqual({});
    rmSync(join(base, ISSUE_LIMITS_FILE));
    writeFileSync(join(base, "other.json"), JSON.stringify({ k: { usd: 5, by: "a", at: "x" } }));
    symlinkSync(join(base, "other.json"), join(base, ISSUE_LIMITS_FILE));
    expect(readIssueLimits(base)).toEqual({});
    expect(existsSync(join(base, "other.json"))).toBe(true);
  });
  it("ignores entries with a bad amount", () => {
    writeFileSync(join(base, ISSUE_LIMITS_FILE), JSON.stringify({ a: { usd: -1 }, b: { usd: "5" }, c: { usd: 2, by: "x", at: "y" } }));
    expect(Object.keys(readIssueLimits(base))).toEqual(["c"]);
  });
  it("checkIssueLimitBody accepts only { limitUsd } with a number in range, or null", () => {
    expect(checkIssueLimitBody({ limitUsd: 1.5 })).toBe(1.5);
    expect(checkIssueLimitBody({ limitUsd: null })).toBeNull();
    for (const bad of [null, [], {}, { limitUsd: 0 }, { limitUsd: -1 }, { limitUsd: "2" }, { limitUsd: Infinity }, { limitUsd: 2_000_000 }, { limitUsd: 1, extra: 1 }, "x"]) {
      expect(() => checkIssueLimitBody(bad), JSON.stringify(bad)).toThrow("limitUsd must be a number above 0, or null");
    }
  });
});

describe("issueLimitStop", () => {
  it("is undefined without a limit, with cost_limits false, or without an issue", () => {
    put(5, 100);
    expect(issueLimitStop(runs, summary(5), cfg())).toBeUndefined();
    expect(issueLimitStop(runs, summary(5), cfg(1, false))).toBeUndefined();
    expect(issueLimitStop(runs, summary(undefined), cfg(1))).toBeUndefined();
  });

  it("stops when the files and the live run reach the limit, with both amounts", () => {
    put(5, 0.02);
    const r = issueLimitStop(runs, summary(5), cfg(0.015));
    expect(r).toBe(issueLimitReason(0.02, 0.015));
    expect(r).toMatch(/^the issue's spending limit is reached/);
    expect(isIssueLimitStop(r)).toBe(true);
    expect(issueLimitStop(runs, summary(5, 0.01), cfg(0.015))).toBeDefined(); // 0.02 + 0.01 live
    expect(issueLimitStop(runs, summary(5), cfg(0.03))).toBeUndefined();
  });

  it("does not count the run's own file twice", () => {
    const id = put(5, 0.01);
    expect(issueLimitStop(runs, summary(5, 0.01, id), cfg(0.015))).toBeUndefined();
  });

  it("a run of a part stops on the spend of the whole family", () => {
    put(5, 0.02, { history: [split(5, [6, 7])] });
    put(6, 0.01);
    expect(issueLimitStop(runs, summary(7, 0), cfg(0.03))).toBeDefined();
    expect(issueLimitStop(runs, summary(7, 0), cfg(0.04))).toBeUndefined();
  });

  it("an override of the root applies to a part, and only while the setting is on", () => {
    put(5, 0.05, { history: [split(5, [6, 7])] });
    expect(issueLimitStop(runs, summary(7), cfg(0.04), base)).toBeDefined();
    setIssueLimit(issueKey({ project: { githubRepo: REPO }, issue: 5 }), 1, "u1", base);
    expect(issueLimitStop(runs, summary(7), cfg(0.04), base)).toBeUndefined();
    expect(issueLimitStop(runs, summary(7), cfg(), base)).toBeUndefined();
    const st = issueLimitState(runs, summary(7), cfg(0.04), base)!;
    expect(st).toMatchObject({ issue: 7, root: 5, defaultUsd: 0.04, overrideUsd: 1, limitUsd: 1, enforced: true });
  });

  it("fails closed when the spend cannot be read", () => {
    const id = put(5, 0.001);
    writeFileSync(join(runs, id, "run.json"), "{ broken");
    expect(issueLimitStop(runs, summary(5), cfg(100))).toBe(ISSUE_LIMIT_UNCHECKED);
    expect(isIssueLimitStop(ISSUE_LIMIT_UNCHECKED)).toBe(true);
  });
});
