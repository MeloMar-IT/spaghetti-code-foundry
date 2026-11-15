import { describe, expect, it } from "vitest";
import type { RepoRecord } from "../src/auth/repos.js";
import { CrossDeps } from "../src/queue/cross-deps.js";
import { DEPS_MARK, crossDependencies, foundryDependsOn, mergeDependsOn } from "../src/queue/deps.js";
import type { RepoGhIdentity } from "../src/queue/gh-identity.js";
import {
  type CrossOptions, type CrossRead, type GhCall, issueLookup, judgeWaitsFor, normalizeWaitsFor, ownerReposFromEnv,
  parseWaitsFor, recordWaitsFor, waitsForQuestion, type WaitIssue, type WaitsForRequest,
} from "../src/queue/waits-for.js";

const mk = (number: number, title: string, body = "", state = "OPEN"): WaitIssue => ({ number, title, state, body });
const req = (issues: number[], cross: { repo: string; issue: number }[], reason = ""): WaitsForRequest => ({ issues, cross, reason });
const lib3 = { repo: "acme/lib", issue: 3 };

interface Call { args: string[]; input?: string }
/** A gh for "o/r" (the run's repository) and, for `issue view … --json number,state,stateReason`, the other repositories. */
function fakeGh(init: WaitIssue[], other: Record<string, Record<number, CrossRead>> = {}, o: { after?: (c: Call, st: Map<number, WaitIssue>) => void; before?: (c: Call) => void } = {}) {
  const st = new Map(init.map((i) => [i.number, { ...i }]));
  const calls: Call[] = [];
  const gh: GhCall = (args, input) => {
    const c = { args, input };
    calls.push(c);
    o.before?.(c);
    const repo = args[args.indexOf("--repo") + 1];
    let out = "";
    if (repo !== "o/r") {
      if (args[1] !== "view" || args.at(-1) !== "number,state,stateReason") throw new Error("unexpected " + args.join(" "));
      const n = Number(args[2]);
      const i = other[repo!]?.[n];
      if (!i) throw Object.assign(new Error("gh failed"), { stderr: "GraphQL: Could not resolve to an Issue with the number of " + n });
      return JSON.stringify({ number: n, ...i });
    }
    const key = `${args[0]} ${args[1]}`;
    if (key === "issue list") out = JSON.stringify([...st.values()]);
    else if (key === "issue view") {
      const i = st.get(Number(args[2]));
      if (!i) throw Object.assign(new Error("gh failed"), { stderr: "GraphQL: Could not resolve to an Issue" });
      out = JSON.stringify(i);
    } else if (key === "issue edit") st.get(Number(args[2]))!.body = input ?? "";
    else throw new Error("unexpected " + args.join(" "));
    o.after?.(c, st);
    return out;
  };
  return { gh, st, calls, edits: () => calls.filter((c) => c.args[1] === "edit"), otherViews: () => calls.filter((c) => c.args.includes("number,state,stateReason")) };
}
const open = { state: "OPEN", stateReason: "" };

describe("parseWaitsFor with owner/name#N", () => {
  it("reads cross references next to #N, unique in any case and sorted", () => {
    expect(parseWaitsFor("WAITS_FOR: #6, acme/lib#3")).toEqual({ issues: [6], cross: [lib3], reason: "" });
    expect(parseWaitsFor("WAITS_FOR: acme/lib#3 and Acme/Lib#3, acme/api#1")?.cross).toEqual([{ repo: "acme/api", issue: 1 }, lib3]);
  });
  it("a line with only cross references is valid", () => {
    expect(parseWaitsFor("WAITS_FOR: acme/lib#3")).toEqual({ issues: [], cross: [lib3], reason: "" });
  });
  it("counts both kinds towards the limit of 10", () => {
    const line = "WAITS_FOR: " + [...Array.from({ length: 6 }, (_, i) => "#" + (i + 1)), ...Array.from({ length: 5 }, (_, i) => `a/b#${i + 1}`)].join(" ");
    expect(parseWaitsFor(line)?.error).toBe("WAITS_FOR names more than 10 issues.");
    expect(parseWaitsFor(line.replace(" a/b#5", ""))?.error).toBeUndefined();
  });
  it("ignores addresses, code, longer words and bad names", () => {
    const r = parseWaitsFor("WAITS_FOR: github.com/acme/lib#3 `acme/lib#4` acme/lib#5x x/acme/lib#6 -acme/lib#7 #9");
    expect(r?.cross).toEqual([]);
    expect(r?.issues).toEqual([9]);
  });
  it("reads a name ending in - or . as a cross reference, never as a local #N", () => {
    expect(parseWaitsFor("WAITS_FOR: acme/lib-#8")).toEqual({ issues: [], cross: [{ repo: "acme/lib-", issue: 8 }], reason: "" });
    expect(parseWaitsFor("WAITS_FOR: acme/lib.#8")).toEqual({ issues: [], cross: [{ repo: "acme/lib.", issue: 8 }], reason: "" });
  });
  it("a mixed line keeps its local #N and drops the number inside a cross reference", () => {
    expect(parseWaitsFor("WAITS_FOR: acme/lib-#8, #9")).toEqual({ issues: [9], cross: [{ repo: "acme/lib-", issue: 8 }], reason: "" });
    expect(parseWaitsFor("WAITS_FOR: #9 acme/lib.#8")).toEqual({ issues: [9], cross: [{ repo: "acme/lib.", issue: 8 }], reason: "" });
  });
  it("a shape validGithubName refuses is neither a cross reference nor a local #N", () => {
    // "acme/.#8" and "acme/..#8": a repository name the registry never accepts; the request then names no issue
    expect(parseWaitsFor("WAITS_FOR: acme/.#8")).toEqual({ issues: [], cross: [], reason: "", error: "WAITS_FOR names no issue number." });
    expect(parseWaitsFor("WAITS_FOR: acme/..#8, #9")?.issues).toEqual([9]);
  });
});

describe("normalizeWaitsFor and ownerReposFromEnv", () => {
  it("reads a reference to the run's own repository as #N", () => {
    expect(normalizeWaitsFor(req([6], [{ repo: "O/R", issue: 4 }, lib3]), "o/r")).toEqual(req([4, 6], [lib3]));
    expect(normalizeWaitsFor({ issues: [2], reason: "" }, "o/r").cross).toEqual([]);
  });
  it("keeps only owner/name values", () => {
    expect(ownerReposFromEnv({ FACTORY_OWNER_REPOS: " acme/lib, bad name ,x,acme/app,local:p-12345678," })).toEqual(["acme/lib", "acme/app"]);
    expect(ownerReposFromEnv({})).toEqual([]);
    // names the registry accepts (a name may end in - or .)
    expect(ownerReposFromEnv({ FACTORY_OWNER_REPOS: "acme/lib-,acme/lib.,acme/.,acme/.." })).toEqual(["acme/lib-", "acme/lib."]);
  });
});

describe("judgeWaitsFor with cross references", () => {
  const self = mk(12, "Self", "x");
  const judge = (r: WaitsForRequest, reads: Record<string, CrossRead | Error | undefined>, owner = ["acme/lib"], me = self, commits: { sha: string; message: string }[] = []) => {
    const f = fakeGh([me, mk(5, "Five")]);
    const read: string[] = [];
    const cross: CrossOptions = {
      ownerRepos: owner,
      read: (repo, n) => { read.push(`${repo}#${n}`); const v = reads[`${repo}#${n}`]; if (v instanceof Error) throw v; return v; },
    };
    return { j: judgeWaitsFor(me, r, issueLookup(f.gh, "o/r"), commits, cross), read, f };
  };
  it("waits for an open issue of the owner's repository (any case)", () => {
    expect(judge(req([], [{ repo: "ACME/lib", issue: 3 }]), { "ACME/lib#3": open }).j).toMatchObject({ crossWait: [{ repo: "ACME/lib", issue: 3 }], problems: [] });
  });
  it("refuses a repository that is not the owner's, without reading it", () => {
    const { j, read } = judge(req([], [{ repo: "other/repo", issue: 3 }]), {});
    expect(j.problems).toEqual(["other/repo is not a repository of the Foundry."]);
    expect(read).toEqual([]);
  });
  it("reports not found, not planned, a failed read and an existing wait", () => {
    expect(judge(req([], [lib3]), {}).j.problems).toEqual(["acme/lib#3 was not found."]);
    expect(judge(req([], [lib3]), { "acme/lib#3": { state: "CLOSED", stateReason: "NOT_PLANNED" } }).j.problems).toEqual(["acme/lib#3 was closed as not planned."]);
    expect(judge(req([], [lib3]), { "acme/lib#3": new Error("HTTP 403: nope\nmore") }).j.problems).toEqual(["acme/lib#3 could not be read: HTTP 403: nope"]);
    const guarded = mk(12, "S", mergeDependsOn("x", [], "r", [lib3]));
    expect(judge(req([], [lib3]), { "acme/lib#3": open }, ["acme/lib"], guarded).j.problems).toEqual(["acme/lib#3 is already waited for: this issue waited for it before."]);
  });
  it("a closed issue is done; only done references leave nothing to wait for", () => {
    const done = { "acme/lib#3": { state: "CLOSED", stateReason: "COMPLETED" }, "acme/lib#4": { state: "CLOSED", stateReason: "DUPLICATE" } };
    const { j } = judge(req([5], [lib3, { repo: "acme/lib", issue: 4 }]), done);
    expect(j).toMatchObject({ wait: [5], crossDone: [lib3, { repo: "acme/lib", issue: 4 }], problems: [] });
    expect(judge(req([], [lib3]), done).j.problems).toEqual(["Nothing left to wait for: acme/lib#3 (closed) is already done."]);
  });
  it("a cross-only request runs no cycle and no commit check", () => {
    const { j, f } = judge(req([], [lib3]), { "acme/lib#3": open }, ["acme/lib"], self, [{ sha: "abc", message: "Resolve #3" }]);
    expect(j.problems).toEqual([]);
    expect(f.calls.map((c) => c.args[1])).toEqual(["list"]);
  });
});

describe("recordWaitsFor with cross references", () => {
  const base = () => [mk(7, "Self", "Original text"), mk(6, "Six")];
  it("records - owner/name#N, and the watcher holds the story on it", async () => {
    const f = fakeGh(base(), { "acme/lib": { 3: open } });
    const r = recordWaitsFor(f.gh, "o/r", 7, req([], [lib3], "needs the lib"), [], ["acme/lib"]);
    expect(r).toEqual({ outcome: "recorded", wait: [], already: [], crossWait: [lib3], crossDone: [], problems: [] });
    expect(f.otherViews()[0]!.args).toEqual(["issue", "view", "3", "--repo", "acme/lib", "--json", "number,state,stateReason"]);
    const body = f.st.get(7)!.body;
    expect(body).toContain("- acme/lib#3");
    expect(body).toContain("Original text");
    expect(foundryDependsOn(body)).toEqual([]);
    expect(crossDependencies(body, { markedOnly: true })).toEqual([lib3]);
    const rec = { id: "id-lib", owner: "ann", url: "https://github.com/acme/lib", method: "github-token", added: "2026-01-01T00:00:00Z" } as RepoRecord;
    const identity = (): RepoGhIdentity => ({ prepare: async () => ({ stamp: "lib" }), usesHostLogin: () => false, dispose: () => {} });
    const cross = new CrossDeps({
      selfRepo: "o/r", owner: "ann", rule: () => ({ doneLabels: [] }), identity, act: () => {}, warn: () => {},
      find: (owner) => (owner === "ann" ? rec : undefined),
      read: async (_repo, n) => ({ number: n, state: "open", state_reason: null, title: "T", html_url: "", created_at: "", labels: [] }),
    });
    const story = { number: 7, body };
    cross.startCheck([story]);
    expect(await cross.blockers(story, true)).toEqual([lib3]);
  });
  it("records #N and owner/name#N together", () => {
    const f = fakeGh(base(), { "acme/lib": { 3: open } });
    const r = recordWaitsFor(f.gh, "o/r", 7, req([6], [lib3]), [], ["acme/lib"]);
    expect(r.outcome).toBe("recorded");
    expect(foundryDependsOn(f.st.get(7)!.body)).toEqual([6]);
    expect(crossDependencies(f.st.get(7)!.body, { markedOnly: true })).toEqual([lib3]);
  });
  it("writes acme/lib-#8 as a cross line, never as a local #8", () => {
    const f = fakeGh(base(), { "acme/lib-": { 8: open } });
    const r = recordWaitsFor(f.gh, "o/r", 7, parseWaitsFor("WAITS_FOR: acme/lib-#8") as WaitsForRequest, [], ["acme/lib-"]);
    expect(r).toMatchObject({ outcome: "recorded", wait: [], crossWait: [{ repo: "acme/lib-", issue: 8 }] });
    const body = f.st.get(7)!.body;
    expect(body).toContain("- acme/lib-#8");
    expect(foundryDependsOn(body)).toEqual([]);
    expect(f.otherViews()[0]!.args.slice(0, 5)).toEqual(["issue", "view", "8", "--repo", "acme/lib-"]);
  });
  it("reads a reference to its own repository as #N", () => {
    const f = fakeGh(base());
    const r = recordWaitsFor(f.gh, "o/r", 7, req([], [{ repo: "o/R", issue: 6 }]), []);
    expect(r).toMatchObject({ outcome: "recorded", wait: [6], crossWait: [] });
    expect(f.otherViews()).toEqual([]);
  });
  it("refuses every cross reference without owner repositories, and writes nothing", () => {
    const f = fakeGh(base(), { "acme/lib": { 3: open } });
    const r = recordWaitsFor(f.gh, "o/r", 7, req([], [lib3]), []);
    expect(r.problems).toEqual(["acme/lib is not a repository of the Foundry."]);
    expect(f.edits()).toEqual([]);
  });
  it("closed as completed is reported as done and not written", () => {
    const f = fakeGh(base(), { "acme/lib": { 3: { state: "CLOSED", stateReason: "COMPLETED" } } });
    const r = recordWaitsFor(f.gh, "o/r", 7, req([6], [lib3]), [], ["acme/lib"]);
    expect(r).toMatchObject({ outcome: "recorded", wait: [6], crossDone: [lib3] });
    expect(f.st.get(7)!.body).not.toContain("acme/lib#3");
  });
  it("takes the cross line out again when the read-back after the write fails", () => {
    let edited = false;
    let failed = false;
    const f = fakeGh(base(), { "acme/lib": { 3: open } }, {
      after: (c) => { if (c.args[1] === "edit") edited = true; },
      before: (c) => { if (edited && !failed && c.args[1] === "view" && c.args[2] === "7") { failed = true; throw new Error("HTTP 502"); } },
    });
    const r = recordWaitsFor(f.gh, "o/r", 7, req([], [lib3]), [], ["acme/lib"]);
    expect(r.problems).toEqual(["Could not read or update the issue on GitHub: HTTP 502"]);
    expect(f.st.get(7)!.body).not.toContain("acme/lib#3");
    expect(f.st.get(7)!.body).not.toContain(DEPS_MARK);
    expect(f.st.get(7)!.body).toContain("Original text");
  });
  it("takes the cross line out again when the local part makes a loop", () => {
    const f = fakeGh(base(), { "acme/lib": { 3: open } }, { after: (c, st) => { if (c.args[1] === "edit" && c.args[2] === "7") st.get(6)!.body = "### Depends on\n#7"; } });
    const r = recordWaitsFor(f.gh, "o/r", 7, req([6], [lib3]), [], ["acme/lib"]);
    expect(r.problems[0]).toMatch(/would make a loop/);
    expect(f.st.get(7)!.body).not.toContain(DEPS_MARK);
  });
});

describe("waitsForQuestion with cross references", () => {
  it("names both kinds", () => {
    expect(waitsForQuestion(7, req([6], [lib3]), ["p"])).toContain("#7 to wait for #6, acme/lib#3, but");
  });
});
