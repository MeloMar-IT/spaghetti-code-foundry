import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessions = vi.hoisted(() => ({ list: [] as unknown[], fail: false }));
vi.mock("../src/refinement/store.js", () => ({
  listSessions: () => {
    if (sessions.fail) throw new Error("unreadable");
    return sessions.list;
  },
}));

import { issueFamily } from "../src/engine/issue-limit.js";
import { readSplitLinks, rememberSplit, SPLIT_LINKS_FILE } from "../src/engine/split-links.js";

let base: string;
let runs: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "factory-issue-limit-ref-"));
  runs = join(base, "runs");
  mkdirSync(runs);
  sessions.list = [];
  sessions.fail = false;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (id: string, issue: number, cost: number) => {
  mkdirSync(join(runs, id));
  writeFileSync(join(runs, id, "run.json"), JSON.stringify({ runId: id, startedAt: "2026-11-07T10:00:00Z", totalCostUsd: cost, vars: { github_repo: "acme/app", issue: String(issue) }, history: [] }));
};

describe("parts made by a refinement session (replacedBy)", () => {
  it("count with the replaced issue, without any create_split record", () => {
    put("20261107-100001-aaaa", 5, 1);
    put("20261107-100002-aaaa", 40, 2);
    put("20261107-100003-aaaa", 41, 4);
    sessions.list = [{ repo: "Acme/App", source: { issue: 5, replacedBy: [40, 41] } }, { repo: "acme/other", source: { issue: 5, replacedBy: [99] } }];
    const f = issueFamily(runs, { project: { githubRepo: "acme/app" }, issue: 41 });
    expect(f.root).toBe(5);
    expect(f.issues).toEqual([5, 40, 41]);
    expect(f.spentUsd).toBe(7);
  });

  it("still counts the parts after the refinement session is gone (dropped and removed)", () => {
    put("20261107-100001-aaaa", 5, 1);
    put("20261107-100002-aaaa", 40, 2);
    put("20261107-100003-aaaa", 41, 4);
    rememberSplit(base, "Acme/App", 5, [40, 41]);
    sessions.list = []; // the session expired and was removed
    const f = issueFamily(runs, { project: { githubRepo: "acme/app" }, issue: 40 });
    expect(f.root).toBe(5);
    expect(f.issues).toEqual([5, 40, 41]);
    expect(f.spentUsd).toBe(7);
    // the override of the root reaches the part too: the family key is the same
    expect(issueFamily(runs, { project: { githubRepo: "acme/app" }, issue: 41 }).root).toBe(5);
  });

  it("keeps the links of different parents apart and ignores bad entries", () => {
    rememberSplit(base, "acme/app", 5, [40]);
    rememberSplit(base, "acme/app", 5, [41, 40]);
    rememberSplit(base, "acme/other", 9, [50]);
    writeFileSync(join(base, SPLIT_LINKS_FILE), JSON.stringify({ "github:acme/app#5": [40, 41], "github:acme/app#x": [1], "github:acme/app#6": ["7"] }));
    expect(readSplitLinks(base)).toEqual({ "github:acme/app#5": [40, 41] });
    rememberSplit(base, "acme/app", 5, [42]);
    expect(readSplitLinks(base)["github:acme/app#5"]).toEqual([40, 41, 42]);
  });

  it("fails closed when the sessions cannot be read", () => {
    sessions.fail = true;
    expect(() => issueFamily(runs, { project: { githubRepo: "acme/app" }, issue: 5 })).toThrow();
  });
});
