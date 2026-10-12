import { beforeAll, describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
let s: any;
beforeAll(async () => {
  s = await import("../ui/repo-status.js" as string);
});

const failed = (over: object = {}, checks?: object[]) => ({
  ok: false,
  at: "2026-01-01T00:00:00Z",
  checks: checks ?? [{ check: "clone", ok: false, code: "bad-token", message: "The host did not accept the token." }, { check: "push", ok: false, skipped: true, code: "skipped", message: "Not checked." }],
  ...over,
});
const good = { ok: true, at: "2026-01-01T00:00:00Z", checks: [] };
const rec = (over: object = {}) => ({ id: "r", url: "https://github.com/o/a", method: "github-token", ...over });
const APP_OFF = { githubApp: { available: false } };

describe("repoName", () => {
  it("prefers github, falls back to the address", () => {
    expect(s.repoName(rec({ github: "o/a" }))).toBe("o/a");
    expect(s.repoName(rec())).toBe("https://github.com/o/a");
    expect(s.repoName({})).toBe("");
    expect(s.repoName(undefined)).toBe("");
    expect(s.repoName(rec({ github: "" }))).toBe("https://github.com/o/a");
  });
  it("returns a long name whole", () => {
    const long = "o/" + "x".repeat(298);
    expect(s.repoName(rec({ github: long }))).toBe(long);
  });
});

describe("repoAttention", () => {
  it("1: needs authentication for a user with method none", () => {
    expect(s.repoAttention(rec({ method: "none" }), { admin: false })).toEqual({ level: "bad", text: "Needs authentication", action: "auth" });
  });
  it("skips rule 1 for an admin", () => {
    expect(s.repoAttention(rec({ method: "none" }), { admin: true }).text).toBe("Never tested");
  });
  it("2: the GitHub App was removed", () => {
    const r = rec({ method: "github-app" });
    expect(s.repoAttention(r, { options: APP_OFF })).toEqual({ level: "bad", text: "GitHub App removed", action: "auth" });
    expect(s.repoAttention(r, {}).text).toBe("Never tested");
    expect(s.repoAttention(r, { options: { githubApp: { available: true } } }).text).toBe("Never tested");
  });
  it("3: the last test failed, with the first failed check's message", () => {
    const a = s.repoAttention(rec({ connection: failed() }));
    expect(a).toEqual({ level: "bad", text: "Last test failed", detail: "The host did not accept the token.", action: "test" });
  });
  it("3: the install link for an app that is not installed", () => {
    const c = failed({}, [{ check: "github-api", ok: false, code: "app-not-installed", message: "Not installed." }]);
    expect(s.repoAttention(rec({ connection: c })).action).toBe("install");
  });
  it("3: no detail without a failed check", () => {
    const a = s.repoAttention(rec({ connection: failed({}, []) }));
    expect(a.detail).toBeUndefined();
    expect(a.action).toBe("test");
  });
  it("4: never tested", () => {
    expect(s.repoAttention(rec())).toEqual({ level: "warn", text: "Never tested", action: "test" });
  });
  it("5: nothing to do", () => {
    expect(s.repoAttention(rec({ connection: good }))).toEqual({ level: "ok", text: "Nothing to do", action: null });
  });
  it("keeps the order of the rules", () => {
    expect(s.repoAttention(rec({ method: "none", connection: failed() }), { admin: false }).text).toBe("Needs authentication");
    expect(s.repoAttention(rec({ method: "github-app", connection: failed() }), { options: APP_OFF }).text).toBe("GitHub App removed");
  });
});

describe("sorting and counting", () => {
  const ok = rec({ id: "ok1", connection: good });
  const ok2 = rec({ id: "ok2", connection: good });
  const warn = rec({ id: "warn" });
  const bad = rec({ id: "bad1", connection: failed() });
  const bad2 = rec({ id: "bad2", connection: failed() });
  it("puts bad first, then warn, then ok, keeping the order inside a level", () => {
    const input = [ok, warn, bad, ok2, bad2];
    const out = s.sortByAttention(input);
    expect(out.map((r: any) => r.id)).toEqual(["bad1", "bad2", "warn", "ok1", "ok2"]);
    expect(input.map((r) => r.id)).toEqual(["ok1", "warn", "bad1", "ok2", "bad2"]);
  });
  it("uses a given attention function, and the default is unchanged", () => {
    const custom = (r: any) => ({ level: r.id === "ok1" ? "bad" : "ok", text: "", action: null });
    expect(s.sortByAttention([ok, warn, bad], {}, custom).map((r: any) => r.id)).toEqual(["ok1", "warn", "bad1"]);
    expect(s.attentionCount([ok, warn, bad], {}, custom)).toBe(1);
    expect(s.attentionCount([ok, warn, bad])).toBe(2);
    expect(s.sortByAttention([ok, warn, bad]).map((r: any) => r.id)).toEqual(["bad1", "warn", "ok1"]);
  });
  it("handles 50 rows", () => {
    const rows = Array.from({ length: 50 }, (_, i) => rec({ id: `r${i}`, connection: i % 3 === 0 ? good : i % 3 === 1 ? failed() : undefined }));
    const out = s.sortByAttention(rows);
    expect(out).toHaveLength(50);
    expect(new Set(out.map((r: any) => r.id)).size).toBe(50);
    const rank = out.map((r: any) => ({ bad: 0, warn: 1, ok: 2 } as any)[s.repoAttention(r).level]);
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
    expect(s.attentionCount(rows)).toBe(rows.filter((r) => s.repoAttention(r).level !== "ok").length);
  });
  it("writes the summary", () => {
    expect(s.attentionSummary(0)).toBe("No repository needs attention.");
    expect(s.attentionSummary(1)).toBe("1 repository needs attention.");
    expect(s.attentionSummary(7)).toBe("7 repositories need attention.");
  });
});

describe("activeRuns", () => {
  const run = (status: string, repo: string | undefined) => ({ id: status, status, vars: repo ? { github_repo: repo } : undefined });
  const repo = rec({ github: "o/a" });
  it("counts running and waiting runs only", () => {
    const runs = ["running", "waiting", "succeeded", "failed", "stopped", "cancelled"].map((x) => run(x, "o/a"));
    expect(s.activeRuns(runs, repo)).toBe(2);
  });
  it("ignores case and other repositories", () => {
    expect(s.activeRuns([run("running", "O/A"), run("running", "o/b")], repo)).toBe(1);
  });
  it("is 0 without a github name or without runs", () => {
    expect(s.activeRuns([run("running", "o/a")], rec())).toBe(0);
    for (const x of [null, undefined, {}, [{ a: 1 }, null, "x"]]) expect(s.activeRuns(x, repo)).toBe(0);
    expect(s.activeRuns([run("running", undefined)], repo)).toBe(0);
  });
});

describe("matchesText", () => {
  const r = rec({ github: "Foo/Bar", url: "https://example.test/Foo/Bar" });
  it("matches the address or the name, trimmed, case ignored", () => {
    expect(s.matchesText(r, " foo/bar ")).toBe(true);
    expect(s.matchesText(r, "EXAMPLE")).toBe(true);
    expect(s.matchesText(r, "zzz")).toBe(false);
    expect(s.matchesText(r, "")).toBe(true);
    expect(s.matchesText(r, "   ")).toBe(true);
  });
});

describe("compact option", () => {
  it("round-trips through a store", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(s.readCompact(store)).toBe(false);
    s.writeCompact(store, true);
    expect(m.get("scf.repos.compact")).toBe("1");
    expect(s.readCompact(store)).toBe(true);
    s.writeCompact(store, false);
    expect(s.readCompact(store)).toBe(false);
  });
  it("never throws", () => {
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(s.readCompact(bad)).toBe(false);
    expect(() => s.writeCompact(bad, true)).not.toThrow();
    expect(s.readCompact(undefined)).toBe(false);
    expect(() => s.writeCompact(undefined, true)).not.toThrow();
  });
});
