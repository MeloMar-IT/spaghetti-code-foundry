import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEPS_MARK, foundryDependsOn, mergeDependsOn, withoutFoundryPart } from "../src/queue/deps.js";
import {
  findCycle, issueLookup, judgeWaitsFor, landedCommit, parseWaitsFor, recordWaitsFor, waitsForQuestion,
  type GhCall, type WaitIssue, type WaitsForRequest,
} from "../src/queue/waits-for.js";

const mk = (number: number, title: string, body = "", state = "OPEN"): WaitIssue => ({ number, title, state, body });
const dep = (...ns: number[]) => "### Depends on\n" + ns.map((n) => "#" + n).join(", ");
const req = (issues: number[], reason = ""): WaitsForRequest => ({ issues, reason });

interface Call { args: string[]; input?: string }
interface Opts {
  unlisted?: number[];
  garble?: Set<number>;
  before?: (c: Call, st: Map<number, WaitIssue>) => void;
  after?: (c: Call, st: Map<number, WaitIssue>) => void;
}
function fakeGh(init: WaitIssue[], opts: Opts = {}) {
  const st = new Map(init.map((i) => [i.number, { ...i }]));
  const calls: Call[] = [];
  const gh: GhCall = (args, input) => {
    const c = { args, input };
    calls.push(c);
    opts.before?.(c, st);
    let out = "";
    const key = `${args[0]} ${args[1]}`;
    if (key === "issue list") out = JSON.stringify([...st.values()].filter((i) => !opts.unlisted?.includes(i.number)));
    else if (key === "issue view") {
      const n = Number(args[2]);
      if (opts.garble?.has(n)) return "not json";
      const i = st.get(n);
      if (!i) throw Object.assign(new Error("gh failed"), { stderr: "GraphQL: Could not resolve to an Issue with the number of " + n });
      out = JSON.stringify(i);
    } else if (key === "issue edit") st.get(Number(args[2]))!.body = input ?? "";
    else throw new Error("unexpected " + args.join(" "));
    opts.after?.(c, st);
    return out;
  };
  const kinds = () => calls.map((c) => `${c.args[0]} ${c.args[1]}`);
  return { gh, st, calls, kinds, edits: () => calls.filter((c) => c.args[1] === "edit"), views: () => calls.filter((c) => c.args[1] === "view") };
}
const isEdit = (c: Call) => c.args[1] === "edit";

describe("parseWaitsFor", () => {
  it("reads issues with any separator, sorted and unique", () => {
    expect(parseWaitsFor("WAITS_FOR: #12, #5 and #12;#7")?.issues).toEqual([5, 7, 12]);
  });
  it("lets the last WAITS_FOR line win and reads the reason", () => {
    const r = parseWaitsFor("WAITS_FOR: #1\nWAITS_FOR_REASON: first\nWAITS_FOR: #2\nWAITS_FOR_REASON:  needs the api ");
    expect(r).toEqual({ issues: [2], reason: "needs the api" });
    expect(parseWaitsFor("WAITS_FOR: #2")?.reason).toBe("");
  });
  it("gives undefined without a WAITS_FOR line", () => {
    expect(parseWaitsFor("nothing")).toBeUndefined();
    expect(parseWaitsFor("WAITS_FOR_REASON: only a reason")).toBeUndefined();
  });
  it("is an error for none or more than 10 issues", () => {
    expect(parseWaitsFor("WAITS_FOR: none")?.error).toMatch(/no issue/);
    expect(parseWaitsFor("WAITS_FOR: " + Array.from({ length: 11 }, (_, i) => "#" + (i + 1)).join(" "))?.error).toMatch(/more than 10/);
  });
  it("does not parse injection tokens as numbers", () => {
    const r = parseWaitsFor("WAITS_FOR: #12$(rm -rf ~) `#13` #14abc #1234567890 owner/repo#15 ##16 #0 #17");
    expect(r?.issues).toEqual([17]);
  });
  it("handles CRLF and leading spaces", () => {
    expect(parseWaitsFor("x\r\n  WAITS_FOR: #4\r\n")?.issues).toEqual([4]);
  });
});

describe("landedCommit", () => {
  const c = (message: string) => [{ sha: "abc1234567", message }];
  it("finds Resolve, Merge, Fixes and closes", () => {
    for (const m of ["Resolve #5: x", "Merge #5: x", "Fixes #5", "fix: closes #5", "CLOSES #5"]) expect(landedCommit(5, c(m))).toBe("abc1234567");
  });
  it("ignores other mentions", () => {
    for (const m of ["Refs #5", "#5 done", "Fixes owner/repo#5", "Resolve #55", "Merge pull request #5 from a/b"]) expect(landedCommit(5, c(m))).toBeUndefined();
  });
  it("returns the first matching commit", () => {
    expect(landedCommit(5, [{ sha: "a", message: "x" }, { sha: "b", message: "Fixes #5" }, { sha: "c", message: "Fixes #5" }])).toBe("b");
  });
});

describe("issueLookup", () => {
  const issues = [mk(5, "Five", "b5"), mk(12, "Twelve")];
  it("makes one list call with exact arguments and views missing issues once", () => {
    const f = fakeGh([...issues, mk(9, "Nine")], { unlisted: [9] });
    const l = issueLookup(f.gh, "o/r");
    expect(f.calls[0]!.args).toEqual(["issue", "list", "--repo", "o/r", "--state", "all", "--limit", "500", "--json", "number,title,state,body"]);
    expect(l.get(5)?.body).toBe("b5");
    expect(f.calls).toHaveLength(1);
    expect(l.has(9)).toBe(false);
    expect(l.get(9)?.title).toBe("Nine");
    expect(f.calls[1]!.args).toEqual(["issue", "view", "9", "--repo", "o/r", "--json", "number,title,state,body"]);
    l.get(9);
    expect(f.calls).toHaveLength(2);
    expect(l.all.map((i) => i.number)).toContain(9);
  });
  it("gives undefined for a not-found issue and throws for other errors", () => {
    const f = fakeGh(issues);
    expect(issueLookup(f.gh, "o/r").get(99)).toBeUndefined();
    const bad: GhCall = (a) => { if (a[1] === "list") return "[]"; throw new Error("HTTP 502"); };
    expect(() => issueLookup(bad, "o/r").get(1)).toThrow(/502/);
  });
  it("throws for a malformed view and a bad repository", () => {
    const f = fakeGh(issues, { garble: new Set([5]) });
    expect(() => issueLookup(f.gh, "o/r").fresh(5)).toThrow(/Unexpected answer/);
    expect(() => issueLookup(f.gh, "a b/c")).toThrow(/Not a repository/);
    expect(() => issueLookup(f.gh, "x")).toThrow(/Not a repository/);
  });
  it("fresh always calls; bad entries are dropped and states upper-cased", () => {
    const gh: GhCall = (a) => (a[1] === "list" ? JSON.stringify([{ number: 1, title: "a", state: "closed" }, { number: "x", title: "b" }, { number: 2 }]) : JSON.stringify(mk(1, "a")));
    const l = issueLookup(gh, "o/r");
    expect(l.all).toEqual([{ number: 1, title: "a", state: "CLOSED", body: "" }]);
    const f = fakeGh(issues);
    const l2 = issueLookup(f.gh, "o/r");
    l2.fresh(5); l2.fresh(5);
    expect(f.views()).toHaveLength(2);
  });
});

describe("judgeWaitsFor", () => {
  const self = mk(12, "Story 12 — Self thing", "x");
  const judge = (issues: WaitIssue[], r: WaitsForRequest, commits: { sha: string; message: string }[] = [], opts: Opts = {}, me = self) => {
    const f = fakeGh([me, ...issues], opts);
    return { j: judgeWaitsFor(me, r, issueLookup(f.gh, "o/r"), commits), f };
  };
  it("puts an open issue on the wait list", () => {
    expect(judge([mk(5, "Five")], req([5])).j).toEqual({ wait: [5], already: [], problems: [] });
  });
  it("reports self, loop guard, unknown, closed without commit and open with commit", () => {
    expect(judge([], req([12])).j.problems).toEqual(["#12 is this issue itself."]);
    const guarded = mk(12, "S", mergeDependsOn("x", [5], "r"));
    expect(judge([mk(5, "Five")], req([5]), [], {}, guarded).j.problems).toEqual(["#5 is already waited for: this issue waited for it before."]);
    expect(judge([], req([77])).j.problems).toEqual(["#77 was not found in this repository."]);
    expect(judge([mk(5, "F", "", "CLOSED")], req([5])).j.problems).toEqual(["#5 is closed, but no commit for it landed."]);
    expect(judge([mk(5, "F")], req([5]), [{ sha: "abcdef123", message: "Resolve #5" }]).j.problems).toEqual(["#5 is still open, but its work already landed (commit abcdef1)."]);
  });
  it("keeps closed issues with a commit in already", () => {
    const commits = [{ sha: "abcdef123", message: "Merge #6: x" }];
    expect(judge([mk(5, "F"), mk(6, "S", "", "CLOSED")], req([5, 6]), commits).j).toEqual({ wait: [5], already: [{ issue: 6, commit: "abcdef123" }], problems: [] });
    expect(judge([mk(6, "S", "", "CLOSED")], req([6]), commits).j.problems).toEqual(["Nothing left to wait for: #6 (commit abcdef1) already landed."]);
  });
  it("returns a request error without looking anything up", () => {
    const { j, f } = judge([mk(5, "F")], { issues: [], reason: "", error: "bad" });
    expect(j.problems).toEqual(["bad"]);
    expect(f.calls).toHaveLength(1);
  });
  it("finds direct, indirect, title-only and marked-part cycles", () => {
    expect(judge([mk(5, "F", dep(12))], req([5])).j.problems[0]).toBe("Waiting for #5 would make a loop: #12 → #5 → #12.");
    expect(judge([mk(5, "F", dep(6)), mk(6, "S", dep(12))], req([5])).j.problems[0]).toBe("Waiting for #5 would make a loop: #12 → #5 → #6 → #12.");
    expect(judge([mk(5, "F", "### Depends on\nStory 12 — Self thing")], req([5])).j.problems[0]).toMatch(/loop/);
    expect(judge([mk(5, "F", mergeDependsOn("x", [12], "r"))], req([5])).j.problems[0]).toMatch(/loop/);
  });
  it("finds a cycle through an issue missing from the list, by a view", () => {
    const { j, f } = judge([mk(5, "F", dep(9)), mk(9, "N", dep(12))], req([5]), [], { unlisted: [9] });
    expect(j.problems[0]).toMatch(/#12 → #5 → #9 → #12/);
    expect(f.views().some((c) => c.args[2] === "9")).toBe(true);
  });
  it("uses the title of a viewed issue to resolve a reworded story", () => {
    const me = mk(12, "Website Story 5 — Thing", "x");
    const { j } = judge(
      [mk(6, "Website Story 6 — Six", dep(9)), mk(9, "Website Story 9 — Docs", "### Depends on\nStory 5 — reworded")],
      req([6]), [], { unlisted: [9] }, me,
    );
    expect(j.problems[0]).toMatch(/#12 → #6 → #9 → #12/);
  });
  it("does not follow a closed issue", () => {
    expect(judge([mk(5, "F", dep(6)), mk(6, "S", dep(12), "CLOSED")], req([5])).j.problems).toEqual([]);
  });
  it("is a problem when the view limit is reached", () => {
    const chain = Array.from({ length: 61 }, (_, i) => mk(100 + i, "C" + i, dep(101 + i)));
    const { j, f } = judge([mk(5, "F", dep(100)), ...chain], req([5]), [], { unlisted: chain.map((c) => c.number) });
    expect(j.problems).toEqual(["Could not finish the cycle check: it needed more than 50 extra issue views."]);
    expect(f.views()).toHaveLength(50);
  });
  it("is a problem when the node limit is reached", () => {
    const chain = Array.from({ length: 600 }, (_, i) => mk(100 + i, "Item " + i, dep(101 + i)));
    expect(judge(chain, req([100])).j.problems).toEqual(["Could not finish the cycle check: it needed more than 500 issues."]);
  });
  it("is a problem when a view is malformed", () => {
    const { j } = judge([mk(5, "F", dep(9)), mk(9, "N")], req([5]), [], { unlisted: [9], garble: new Set([9]) });
    expect(j.problems[0]).toMatch(/Could not finish the cycle check/);
  });
  it("skips the cycle walk when another problem is found", () => {
    const { j, f } = judge([mk(6, "S", dep(12))], req([6, 999]));
    expect(j.problems).toEqual(["#999 was not found in this repository."]);
    expect(f.views().map((c) => c.args[2])).toEqual(["999"]);
  });
  it("findCycle returns a cycle found before a limit", () => {
    const f = fakeGh([self, mk(5, "F", dep(12))]);
    expect(findCycle(self, [5], issueLookup(f.gh, "o/r"), { views: 0, nodes: 5 }).cycle).toEqual([12, 5, 12]);
  });
});

describe("recordWaitsFor", () => {
  const base = () => [mk(12, "Self", "Original text"), mk(5, "Five", "y")];
  it("records with one edit, body on stdin, and keeps the person's text", () => {
    const f = fakeGh(base());
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5], "needs it"), []);
    expect(r).toEqual({ outcome: "recorded", wait: [5], already: [], problems: [] });
    expect(f.kinds()).toEqual(["issue list", "issue view", "issue edit", "issue view", "issue view"]);
    expect(f.edits()[0]!.args).toEqual(["issue", "edit", "12", "--repo", "o/r", "--body-file", "-"]);
    const body = f.st.get(12)!.body;
    expect(foundryDependsOn(body)).toEqual([5]);
    expect(f.edits()[0]!.input).toBe(body);
    expect(withoutFoundryPart(body)).toContain("Original text");
  });
  it("keeps a person's edit made between the list and the view", () => {
    let n = 0;
    const f = fakeGh(base(), { before: (c, st) => { if (c.args[1] === "view" && c.args[2] === "12" && ++n === 1) st.get(12)!.body += "\nperson note"; } });
    expect(recordWaitsFor(f.gh, "o/r", 12, req([5]), []).outcome).toBe("recorded");
    const body = f.st.get(12)!.body;
    expect(body).toContain("person note");
    expect(foundryDependsOn(body)).toEqual([5]);
  });
  it("writes again when a person's edit replaces our write", () => {
    let n = 0;
    const f = fakeGh(base(), { after: (c, st) => { if (isEdit(c) && ++n === 1) st.get(12)!.body = "changed by person"; } });
    expect(recordWaitsFor(f.gh, "o/r", 12, req([5]), []).outcome).toBe("recorded");
    expect(f.edits()).toHaveLength(2);
    const body = f.st.get(12)!.body;
    expect(body).toContain("changed by person");
    expect(foundryDependsOn(body)).toEqual([5]);
  });
  it("gives a problem when the issue keeps changing", () => {
    let n = 0;
    const f = fakeGh(base(), { after: (c, st) => { if (isEdit(c)) st.get(12)!.body = "churn " + ++n; } });
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5]), []);
    expect(r.outcome).toBe("problem");
    expect(r.problems).toEqual(["The issue changed while it was being updated."]);
    expect(f.edits()).toHaveLength(2);
  });
  it("does not edit when already recorded (even with another reason) or invalid", () => {
    let n = 0;
    const f = fakeGh(base(), { before: (c, st) => { if (c.args[1] === "view" && c.args[2] === "12" && ++n === 1) st.get(12)!.body = mergeDependsOn("x", [5], "old"); } });
    expect(recordWaitsFor(f.gh, "o/r", 12, req([5], "new"), []).outcome).toBe("unchanged");
    expect(f.edits()).toHaveLength(0);
    const g = fakeGh([mk(12, "Self"), mk(5, "F", "", "CLOSED")]);
    const r = recordWaitsFor(g.gh, "o/r", 12, req([5]), []);
    expect(r.outcome).toBe("problem");
    expect(g.edits()).toHaveLength(0);
  });
  it("undoes the write when the reverse dependency appears (no heading before)", () => {
    const f = fakeGh(base(), { after: (c, st) => { if (isEdit(c) && c.args[2] === "12") st.get(5)!.body = dep(12); } });
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5]), []);
    expect(r.outcome).toBe("problem");
    expect(r.problems[0]).toMatch(/Waiting for #5 would make a loop/);
    expect(f.edits()).toHaveLength(2);
    const body = f.st.get(12)!.body;
    expect(body).not.toContain(DEPS_MARK);
    expect(body).toContain("Original text");
  });
  it("undoes to the original body when a Depends on heading existed", () => {
    const orig = "Text\n\n### Depends on\n#3";
    const f = fakeGh([mk(12, "Self", orig), mk(5, "Five", "y"), mk(3, "Three")], { after: (c, st) => { if (isEdit(c) && c.args[2] === "12") st.get(5)!.body = dep(12); } });
    expect(recordWaitsFor(f.gh, "o/r", 12, req([5]), []).outcome).toBe("problem");
    expect(f.st.get(12)!.body).toBe(orig);
  });
  it("undoes only its own additions", () => {
    let n = 0;
    const f = fakeGh([mk(12, "Self", "x"), mk(5, "Five", "y"), mk(7, "Seven", "z")], {
      before: (c, st) => { if (c.args[1] === "view" && c.args[2] === "12" && ++n === 1) st.get(12)!.body = mergeDependsOn("x", [5], "someone"); },
      after: (c, st) => { if (isEdit(c)) st.get(7)!.body = dep(12); },
    });
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5, 7]), []);
    expect(r.outcome).toBe("problem");
    expect(foundryDependsOn(f.st.get(12)!.body)).toEqual([5]);
  });
  it("reports when the undo cannot be verified", () => {
    let n = 0;
    const f = fakeGh(base(), {
      after: (c, st) => {
        if (!isEdit(c)) return;
        if (++n === 1) st.get(5)!.body = dep(12);
        else st.get(12)!.body = mergeDependsOn(st.get(12)!.body, [5], "again");
      },
    });
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5]), []);
    expect(r.outcome).toBe("problem");
    expect(r.problems.join("\n")).toMatch(/Could not take #5/);
  });
  it("undoes when the re-check fails with an exception or a malformed view", () => {
    for (const mode of ["throw", "garble"]) {
      const garble = new Set<number>();
      let wrote = false;
      const f = fakeGh([mk(12, "Self", "Original"), mk(5, "F", dep(9)), mk(9, "N", "")], {
        unlisted: [9], garble,
        before: (c) => { if (mode === "throw" && wrote && c.args[1] === "view" && c.args[2] === "9") throw new Error("HTTP 502"); },
        after: (c) => { if (isEdit(c)) { wrote = true; if (mode === "garble") garble.add(9); } },
      });
      const r = recordWaitsFor(f.gh, "o/r", 12, req([5]), []);
      expect(r.outcome).toBe("problem");
      expect(r.problems[0]).toMatch(/Could not finish the cycle check/);
      expect(foundryDependsOn(f.st.get(12)!.body)).toEqual([]);
    }
  });
  it("undoes the write when the read-back after it fails and a cycle appeared", () => {
    let edited = false;
    let failed = false;
    const f = fakeGh(base(), {
      after: (c, st) => { if (isEdit(c)) { edited = true; if (c.args[2] === "12") st.get(5)!.body = dep(12); } },
      before: (c) => { if (edited && !failed && c.args[1] === "view" && c.args[2] === "12") { failed = true; throw new Error("HTTP 502"); } },
    });
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5]), []);
    expect(r.outcome).toBe("problem");
    expect(r.problems).toEqual(["Could not read or update the issue on GitHub: HTTP 502"]);
    expect(foundryDependsOn(f.st.get(12)!.body)).toEqual([]);
    expect(f.st.get(12)!.body).toContain("Original text");
  });
  it("accepts a person's text change that keeps the Foundry block after one retry", () => {
    let n = 0;
    const f = fakeGh(base(), { after: (c, st) => { if (isEdit(c) && c.args[2] === "12" && ++n === 1) st.get(12)!.body = mergeDependsOn("person 1", [5], "r"); } });
    expect(recordWaitsFor(f.gh, "o/r", 12, req([5]), []).outcome).toBe("recorded");
    expect(f.edits()).toHaveLength(2);
    const body = f.st.get(12)!.body;
    expect(body).toContain("person 1");
    expect(foundryDependsOn(body)).toEqual([5]);
  });
  it("gives a problem after a second mismatch that keeps the Foundry block, and undoes", () => {
    let n = 0;
    const f = fakeGh(base(), { after: (c, st) => { if (isEdit(c) && c.args[2] === "12" && ++n <= 2) st.get(12)!.body = mergeDependsOn(`person ${n}`, [5], "r"); } });
    const r = recordWaitsFor(f.gh, "o/r", 12, req([5]), []);
    expect(r.outcome).toBe("problem");
    expect(r.problems).toEqual(["The issue changed while it was being updated."]);
    expect(f.edits()).toHaveLength(3);
    const body = f.st.get(12)!.body;
    expect(body).not.toContain(DEPS_MARK);
    expect(body).toContain("person 2");
  });
  it("turns a gh error into a problem", () => {
    const r = recordWaitsFor(() => { throw new Error("boom\nsecond line"); }, "o/r", 12, req([5]), []);
    expect(r).toMatchObject({ outcome: "problem", problems: ["Could not read or update the issue on GitHub: boom"] });
  });
  it("gives a problem when the issue itself is unknown", () => {
    const f = fakeGh([mk(5, "Five")]);
    expect(recordWaitsFor(f.gh, "o/r", 12, req([5]), []).problems).toEqual(["#12 was not found."]);
  });
});

describe("waitsForQuestion", () => {
  it("lists the issues, the problems and the cleaned reason", () => {
    const q = waitsForQuestion(12, req([5, 7], "needs #3 <b>"), ["first problem", "second problem"]);
    expect(q).toContain("#12 to wait for #5, #7");
    expect(q).toContain("- first problem\n- second problem");
    expect(q).toContain("Reason given: needs issue 3 b");
    expect(waitsForQuestion(12, req([5]), ["p"])).not.toContain("Reason given");
  });
});

describe("fake-gh fixture: issue view and edit", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  it("answers a view, fails for a missing issue, and shows an edited body", () => {
    dir = mkdtempSync(join(tmpdir(), "waits-fake-"));
    const env = { ...process.env, FAKE_GH_LOG: join(dir, "log"), FAKE_GH_ISSUES: JSON.stringify([{ number: 5, title: "Five", state: "open", body: "old" }]) };
    const fixture = join(import.meta.dirname, "fixtures", "fake-gh.sh");
    const gh = (args: string[], input?: string) => execFileSync("sh", [fixture, ...args], { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const view = (n: string) => JSON.parse(gh(["issue", "view", n, "--repo", "o/r", "--json", "number,title,state,body"]));
    expect(view("5")).toEqual({ number: 5, title: "Five", state: "OPEN", body: "old" });
    expect(() => view("6")).toThrow(/Could not resolve to an Issue/);
    gh(["issue", "edit", "5", "--repo", "o/r", "--body-file", "-"], "new body");
    expect(view("5").body).toBe("new body");
    expect(readFileSync(join(dir, "log"), "utf8")).toContain("--- issue body edit: issue edit 5 --repo o/r --body-file -\nnew body");
  });
});
