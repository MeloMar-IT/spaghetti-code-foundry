import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRunBriefs, taskLineOf, type RunBrief } from "../src/engine/state.js";
import { HttpError } from "../src/server/http.js";
import { matchesRun, parseRunFilter, runFilterValues, type RunFilter } from "../src/server/run-filter.js";

const p = (s: string) => new URLSearchParams(s);
const brief = (over: Partial<RunBrief> = {}): RunBrief => ({
  runId: "20260101-000000-abcd", flow: "quick", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z",
  runDir: "/x", dirName: "d", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});
const filt = (over: Partial<RunFilter> = {}): RunFilter => ({ archived: false, admin: true, ...over });
const bad = (s: string, admin = true) => {
  try {
    parseRunFilter(p(s), admin);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return (e as HttpError).message;
  }
  throw new Error(`no error for ${s}`);
};

describe("parseRunFilter", () => {
  it("gives only archived and admin without parameters", () => {
    expect(parseRunFilter(p(""), true)).toEqual({ archived: false, admin: true });
    expect(parseRunFilter(p(""), false)).toEqual({ archived: false, admin: false });
  });
  it("reads archived", () => {
    expect(parseRunFilter(p("archived=1"), true).archived).toBe(true);
    for (const v of ["0", "", "true"]) expect(bad(`archived=${v}`)).toBe("invalid archived");
  });
  it("reads owner for an admin only", () => {
    expect(parseRunFilter(p("owner=abc-1"), true).owner).toBe("abc-1");
    expect(bad("owner=a/b")).toBe("invalid owner");
    expect(bad(`owner=${"a".repeat(65)}`)).toBe("invalid owner");
    expect(parseRunFilter(p("owner=a/b"), false).owner).toBeUndefined();
    expect(parseRunFilter(p("owner=abc"), false).owner).toBeUndefined();
  });
  it("reads q", () => {
    expect(parseRunFilter(p("q=  FooBar "), true).q).toBe("foobar");
    expect("q" in parseRunFilter(p("q="), true)).toBe(false);
    expect("q" in parseRunFilter(p("q=%20%20"), true)).toBe(false);
    expect(parseRunFilter(p(`q=${"a".repeat(200)}`), true).q).toHaveLength(200);
    expect(bad(`q=${"a".repeat(201)}`)).toBe("q can have at most 200 characters");
    expect([...parseRunFilter(new URLSearchParams({ q: "😀".repeat(200) }), true).q!]).toHaveLength(200);
    expect(bad(`q=${encodeURIComponent("😀".repeat(201))}`)).toBe("q can have at most 200 characters");
  });
  it("reads status", () => {
    for (const s of ["running", "succeeded", "failed", "cancelled", "stopped", "waiting"]) expect(parseRunFilter(p(`status=${s}`), true).status).toBe(s);
    for (const v of ["done", "Running", ""]) expect(bad(`status=${v}`)).toContain("running, succeeded, failed, cancelled, stopped, waiting");
  });
  it("reads repo and flow exactly", () => {
    expect(bad("repo=")).toBe("invalid repo");
    expect(bad("flow=")).toBe("invalid flow");
    const f = parseRunFilter(p("repo=Acme%2FApp&flow=my%20flow"), true);
    expect(f.repo).toBe("Acme/App");
    expect(f.flow).toBe("my flow");
    expect(parseRunFilter(p(`flow=${"a".repeat(300)}`), true).flow).toHaveLength(300);
  });
  it("reads since strictly", () => {
    expect(parseRunFilter(p("since=2026-10-01"), true).since).toBe(Date.UTC(2026, 9, 1));
    expect(parseRunFilter(p("since=2026-10-01T08:00:00Z"), true).since).toBe(Date.UTC(2026, 9, 1, 8));
    expect(parseRunFilter(p("since=2026-10-01T08:00:00.123%2B02:00"), true).since).toBe(Date.UTC(2026, 9, 1, 6, 0, 0, 123));
    expect(parseRunFilter(p("since=2026-10-01T08:00-05:00"), true).since).toBe(Date.UTC(2026, 9, 1, 13));
    expect(parseRunFilter(p("since=2024-02-29"), true).since).toBe(Date.UTC(2024, 1, 29));
    for (const v of ["yesterday", "2026-13-45", "2026-02-30", "2025-02-29", "2026-10-01T08:00:00", "1700000000", "", "2026-10-01T25:00:00Z", "2026-10-01T08:00:00Z|"]) expect(bad(`since=${v}`)).toContain("since must be an ISO date");
  });
  it("ignores unknown parameters", () => {
    expect(parseRunFilter(p("as=x&foo=1"), true)).toEqual({ archived: false, admin: true });
  });
});

describe("matchesRun", () => {
  it("is two-way for archived", () => {
    expect(matchesRun(brief({ archived: true }), filt())).toBe(false);
    expect(matchesRun(brief({ archived: true }), filt({ archived: true }))).toBe(true);
    expect(matchesRun(brief(), filt({ archived: true }))).toBe(false);
  });
  it("filters by owner", () => {
    expect(matchesRun(brief({ owner: "a" }), filt({ owner: "a" }))).toBe(true);
    expect(matchesRun(brief({ owner: "b" }), filt({ owner: "a" }))).toBe(false);
    expect(matchesRun(brief(), filt({ owner: "a" }))).toBe(false);
  });
  it("finds q in the searched fields, without regard to case", () => {
    const b = brief({ runId: "20260101-AbCd-xyz", flow: "Fix-Flow", githubRepo: "Acme/App", issue: "7", taskLine: "Repair the Login" });
    for (const q of ["abcd-X", "fix-flow", "acme/app", "ACME/APP#7", "#7", "login"]) expect(matchesRun(b, filt({ q: q.toLowerCase() })), q).toBe(true);
    const pr = brief({ githubRepo: "acme/app", pr: "7" });
    expect(matchesRun(pr, filt({ q: "acme/app#7" }))).toBe(true);
    expect(matchesRun(pr, filt({ q: "#7" }))).toBe(true);
  });
  it("misses what is not searched", () => {
    expect(matchesRun(brief(), filt({ q: "#7" }))).toBe(false);
    expect(matchesRun(brief(), filt({ q: "#undefined" }))).toBe(false);
    expect(matchesRun(brief({ issue: "7" }), filt({ q: "acme/app#7" }))).toBe(false);
    expect(matchesRun(brief({ source: "secretsrc", owner: "secretown" }), filt({ q: "secret" }))).toBe(false);
  });
  it("tolerates a brief without a task line", () => {
    expect(matchesRun(brief(), filt({ q: "zzz", admin: false }))).toBe(false);
    expect(matchesRun(brief(), filt({ q: "quick", admin: false }))).toBe(true);
  });
  it("matches q literally", () => {
    expect(matchesRun(brief({ taskLine: "abc" }), filt({ q: ".*" }))).toBe(false);
    expect(matchesRun(brief({ taskLine: "see .* here" }), filt({ q: ".*" }))).toBe(true);
    expect(matchesRun(brief({ taskLine: "abc" }), filt({ q: "(" }))).toBe(false);
    expect(matchesRun(brief({ taskLine: "abc" }), filt({ q: "[a-z]+" }))).toBe(false);
  });
  it("matches the task line the same for a user in a refinement run", () => {
    const b = brief({ flow: "refine-round", source: "refinement 7d2b0c1e-0000-4000-8000-000000000000", taskLine: "Round one" });
    expect(matchesRun(b, filt({ q: "round one", admin: false }))).toBe(true);
    expect(matchesRun(b, filt({ q: "round one", admin: true }))).toBe(true);
  });
  it("matches status as the brief gives it", () => {
    const b = brief({ status: "failed", interrupted: true });
    expect(matchesRun(b, filt({ status: "failed" }))).toBe(true);
    expect(matchesRun(b, filt({ status: "running" }))).toBe(false);
  });
  it("matches flow and repo exactly", () => {
    expect(matchesRun(brief({ flow: "quick2" }), filt({ flow: "quick" }))).toBe(false);
    expect(matchesRun(brief({ flow: "quick" }), filt({ flow: "Quick" }))).toBe(false);
    expect(matchesRun(brief({ flow: "quick" }), filt({ flow: "quick" }))).toBe(true);
    expect(matchesRun(brief(), filt({ repo: "acme/app" }))).toBe(false);
    expect(matchesRun(brief({ githubRepo: "acme/app" }), filt({ repo: "acme/app" }))).toBe(true);
  });
  it("matches since at or after", () => {
    const t = Date.parse("2026-03-03T00:00:00.000Z");
    expect(matchesRun(brief({ startedAt: "2026-03-03T00:00:00.000Z" }), filt({ since: t }))).toBe(true);
    expect(matchesRun(brief({ startedAt: "2026-03-02T23:59:59.999Z" }), filt({ since: t }))).toBe(false);
    expect(matchesRun(brief({ startedAt: "nonsense" }), filt({ since: t }))).toBe(false);
  });
  it("needs every part of a mix", () => {
    const b = brief({ status: "failed", githubRepo: "acme/app", taskLine: "needle" });
    const f = filt({ q: "needle", status: "failed", since: Date.parse("2026-01-01"), repo: "acme/app" });
    expect(matchesRun(b, f)).toBe(true);
    for (const o of [{ q: "other" }, { status: "running" as const }, { since: Date.parse("2027-01-01") }, { repo: "x/y" }]) expect(matchesRun(b, { ...f, ...o })).toBe(false);
  });
});

describe("runFilterValues", () => {
  it("gives unique, sorted values", () => {
    const r = runFilterValues([brief({ flow: "b", githubRepo: "z/z" }), brief({ flow: "a", githubRepo: "a/a" }), brief({ flow: "b" })]);
    expect(r).toEqual({ repos: ["a/a", "z/z"], flows: ["a", "b"] });
    expect(runFilterValues([])).toEqual({ repos: [], flows: [] });
  });
});

describe("taskLineOf", () => {
  it("takes the first line", () => {
    expect(taskLineOf("a\nb")).toBe("a");
    expect(taskLineOf("  a \r\nb")).toBe("a");
    expect(taskLineOf("x".repeat(300))).toHaveLength(200);
    expect([...taskLineOf("😀".repeat(300))!]).toHaveLength(200);
    expect(taskLineOf("")).toBeUndefined();
    expect(taskLineOf("\nsecond")).toBeUndefined();
    expect(taskLineOf(5)).toBeUndefined();
  });
  it("is in the brief", () => {
    const runs = mkdtempSync(join(tmpdir(), "run-filter-briefs-"));
    try {
      for (const [id, task] of [["r1", "Fix login\nmore"], ["r2", ""]] as const) {
        const d = join(runs, id);
        mkdirSync(d);
        writeFileSync(join(d, "run.json"), JSON.stringify({ runId: id, flow: "f", task, status: "failed", startedAt: "2026-01-01T00:00:00.000Z", runDir: d }));
      }
      const by = new Map(listRunBriefs(runs).map((b) => [b.runId, b]));
      expect(by.get("r1")!.taskLine).toBe("Fix login");
      expect("taskLine" in by.get("r2")!).toBe(false);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
  it("has the issue title from the pull_ticket output, cut at 200, and none without state", () => {
    const runs = mkdtempSync(join(tmpdir(), "run-filter-briefs-"));
    try {
      const out = (title: string) => ({ next: null, visits: {}, steps: { pull_ticket: { output: `# #7: ${title}\n\nbody` } } });
      for (const [id, state] of [["r1", out("Fix login")], ["r2", out("x".repeat(300))], ["r3", undefined]] as const) {
        const d = join(runs, id);
        mkdirSync(d);
        writeFileSync(join(d, "run.json"), JSON.stringify({ runId: id, flow: "f", task: "", status: "failed", startedAt: "2026-01-01T00:00:00.000Z", runDir: d, ...(state ? { state } : {}) }));
      }
      const by = new Map(listRunBriefs(runs).map((b) => [b.runId, b]));
      expect(by.get("r1")!.issueTitle).toBe("Fix login");
      expect(by.get("r2")!.issueTitle).toBe("x".repeat(200));
      expect("issueTitle" in by.get("r3")!).toBe(false);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
});
