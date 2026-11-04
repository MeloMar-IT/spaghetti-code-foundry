import { describe, expect, it } from "vitest";
import { gapSignals, repairKindOf, reviewKindOf, type GapInput } from "../src/skills/gap-signals.js";
import { profileTechnologies, skillCoversTechnology } from "../src/skills/catalogue.js";
import type { RepoProfile } from "../src/skills/repo-profile.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const step = (id: string, o: Record<string, unknown> = {}) => ({ id, type: "agent", visit: 1, ok: true, output: "", startedAt: "2026-11-01T00:00:00Z", ...o });
const techStep = (name = "nodejs", confidence = "high", version?: string) =>
  step("plan", { skillCatalogue: { entries: 1, omitted: 0, estimatedTokens: 1, technologies: [{ name, confidence, ...(version ? { version } : {}) }] } });
function mk(id: string, o: { repo?: string; age?: number; status?: string; history?: any[]; unresolved?: any[]; tech?: any } = {}): any {
  return {
    runId: id, status: o.status ?? "succeeded", vars: { github_repo: o.repo ?? "Acme/App" },
    startedAt: new Date(NOW - (o.age ?? 1) * DAY).toISOString(),
    history: o.history ?? [o.tech ?? techStep()],
    ...(o.unresolved ? { skillPlan: { action: "stop", unresolved: o.unresolved } } : {}),
  };
}
const skill = (id: string, extra: Record<string, unknown> = {}): any => ({ id, active: true, pkg: { capabilities: [] }, ...extra });
const input = (runs: any[], more: Partial<GapInput> = {}): GapInput => ({ now: NOW, runs, findings: [], skills: [], ...more });
const topics = (i: GapInput) => gapSignals(i).map((s) => s.topic).sort();
const reviewRun = (id: string, age = 1, line = "- [high] unhandled rejection in the loader") =>
  mk(id, { age, history: [techStep(), step("review_code", { output: line })] });

describe("signal 1: unknown skill", () => {
  it("fires for code unknown, not for unpinned", () => {
    const r = mk("r1", { unresolved: [{ id: "rust-async", code: "unknown" }, { id: "other-skill", code: "unpinned" }], tech: step("x") });
    const s = gapSignals(input([r]));
    expect(s.map((x) => [x.topic, x.kind, x.repo])).toEqual([["rust-async", "unknown", "acme/app"]]);
  });
});

describe("signal 1: a skill installed after the run", () => {
  it("is not an unknown gap once it is in the registry, and still is when inactive", () => {
    const r = mk("r1", { unresolved: [{ id: "rust-async", code: "unknown" }], tech: step("x") });
    expect(topics(input([r]))).toEqual(["rust-async"]);
    expect(topics(input([r], { skills: [skill("rust-async")] }))).toEqual([]);
    expect(topics(input([r], { skills: [skill("rust-async", { active: false })] }))).toEqual(["rust-async"]);
  });
});

describe("signal 2: uncovered technology", () => {
  it("fires within 30 days and not after", () => {
    expect(topics(input([mk("a", { age: 29 })]))).toEqual(["nodejs"]);
    expect(topics(input([mk("a", { age: 31 })]))).toEqual([]);
  });
  it("ignores low confidence and covered technologies; a skill installed later stops it", () => {
    expect(topics(input([mk("a", { tech: techStep("nodejs", "low") })]))).toEqual([]);
    const r = mk("a");
    expect(topics(input([r]))).toEqual(["nodejs"]);
    expect(topics(input([r], { skills: [skill("nodejs")] }))).toEqual([]);
    expect(topics(input([r], { skills: [{ ...skill("x"), pkg: { capabilities: ["nodejs"] } }] }))).toEqual([]);
    expect(topics(input([r], { skills: [skill("nodejs", { active: false })] }))).toEqual(["nodejs"]);
    expect(topics(input([r], { skills: [skill("nodejs", { trust: "unapproved" })] }))).toEqual(["nodejs"]);
  });
  it("fires for python and keeps a node version", () => {
    expect(topics(input([mk("a", { tech: techStep("python", "medium") })]))).toEqual(["python"]);
    const s = gapSignals(input([mk("a", { tech: techStep("nodejs", "high", "20.11.0") })]));
    expect(s[0]!.evidence.technology).toEqual({ name: "nodejs", version: "20.11.0" });
  });
});

describe("signal 3: repeated review finding", () => {
  it("fires with 3 runs in 14 days", () => {
    const runs = [reviewRun("a"), reviewRun("b"), reviewRun("c")];
    expect(topics(input(runs, { skills: [skill("nodejs")] }))).toEqual(["nodejs-error-handling"]);
  });
  it("does not fire for 2 runs, a low line or an old run", () => {
    const sk = { skills: [skill("nodejs")] };
    expect(topics(input([reviewRun("a"), reviewRun("b")], sk))).toEqual([]);
    expect(topics(input([reviewRun("a"), reviewRun("b"), reviewRun("c", 1, "- [low] unhandled rejection")], sk))).toEqual([]);
    expect(topics(input([reviewRun("a"), reviewRun("b"), reviewRun("c", 15)], sk))).toEqual([]);
  });
  it("uses the kind alone without a technology", () => {
    const bare = (id: string) => mk(id, { history: [step("review_code", { output: "1. [medium] missing validation of user input" })] });
    expect(topics(input([bare("a"), bare("b"), bare("c")]))).toEqual(["input-validation"]);
  });
  it("classifies word forms of ordinary findings", () => {
    expect(reviewKindOf("[high] security issue in the parser")).toBe("security");
    expect(reviewKindOf("[medium] a vulnerability in the parser")).toBe("security");
    expect(reviewKindOf("[medium] concurrency bug in the cache")).toBe("concurrency");
    expect(reviewKindOf("[medium] validation is missing")).toBe("input-validation");
    expect(reviewKindOf("[high] compatibility break with v1")).toBe("compatibility");
  });
  it("reads only high and medium lines", () => {
    expect(reviewKindOf("[high] a race condition")).toBe("concurrency");
    expect(reviewKindOf("**[medium]** possible sql injection")).toBe("security");
    expect(reviewKindOf("[low] unhandled rejection")).toBeUndefined();
    expect(reviewKindOf("note: [high] unhandled rejection")).toBeUndefined();
  });
});

describe("signal 4: failed or repaired several times", () => {
  const sk = { skills: [skill("nodejs")] };
  const fixes = (n: number, id = "fix_tests") => Array.from({ length: n }, (_, i) => step(id, { visit: i + 1 }));
  const failing = (id: string, age = 1) => mk(id, { age, status: "failed", history: [techStep(), step("run_tests", { ok: false, error: "boom" })] });
  it("fires on 3 failed test runs, not on 2", () => {
    expect(topics(input([failing("a"), failing("b"), failing("c")], sk))).toEqual(["nodejs-testing"]);
    expect(topics(input([failing("a"), failing("b")], sk))).toEqual([]);
    expect(topics(input([failing("a"), failing("b"), failing("c", 15)], sk))).toEqual([]);
  });
  it("fires on one run with 3 visits to one fix step", () => {
    expect(topics(input([mk("a", { history: [techStep(), ...fixes(3)] })], sk))).toEqual(["nodejs-testing"]);
    expect(topics(input([mk("a", { history: [techStep(), ...fixes(2)] })], sk))).toEqual([]);
  });
  it("uses a build topic for a build fix step", () => {
    expect(topics(input([mk("a", { history: [techStep(), ...fixes(3, "fix_build")] })], sk))).toEqual(["nodejs-build"]);
    expect(repairKindOf("fix_things")).toBe("repair");
    expect(repairKindOf("fix_review", "security")).toBe("security");
  });
  it("fires on one failed run plus an open project finding, not a gone one", () => {
    const f = (gone: boolean) => [{ detector: "same-step-failing", about: "project" as const, repo: "acme/app", gone }];
    expect(topics(input([failing("a")], { ...sk, findings: f(false) }))).toEqual(["nodejs-testing"]);
    expect(topics(input([failing("a")], { ...sk, findings: f(true) }))).toEqual([]);
  });
  it("needs a known technology", () => {
    const r = (id: string) => mk(id, { status: "failed", history: [step("run_tests", { ok: false, error: "x" })] });
    expect(topics(input([r("a"), r("b"), r("c")]))).toEqual([]);
  });
});

describe("merging", () => {
  it("keeps one repository per topic, the one with the most runs", () => {
    const runs = [mk("a", { repo: "x/one" }), mk("b", { repo: "x/two" }), mk("c", { repo: "x/two" })];
    const s = gapSignals(input(runs));
    expect(s).toHaveLength(1);
    expect(s[0]!.repo).toBe("x/two");
    expect(s[0]!.evidence.runs).toEqual(["b", "c"]);
  });
  it("drops a bad topic, a bad run id and a bad repository", () => {
    expect(topics(input([mk("a", { unresolved: [{ id: "Bad Id/../x", code: "unknown" }], tech: step("x") })]))).toEqual([]);
    expect(topics(input([mk("bad id!", { tech: techStep("python") })]))).toEqual([]);
    expect(topics(input([mk("a", { repo: "no-slash", tech: techStep("python") })]))).toEqual([]);
  });
});

describe("profileTechnologies", () => {
  const f = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({ kind, name, path: "a.py", detector: "d", reason: "r", ...extra });
  const prof = (findings: any[]): RepoProfile => ({ version: 1, limits: {} as any, stats: { files: 0, directories: 0, bytesRead: 0 }, truncated: { files: false, bytes: false, findings: false }, skipped: {}, findings }) as any;
  it("reads languages and the node version from engines", () => {
    const t = profileTechnologies(prof([f("language", "python", { count: 6 }), f("language", "markdown", { count: 9 }), f("dependency", "node", { value: ">=20.1.0", reason: "declared in engines of package.json", path: "package.json" })]));
    expect(t.map((x) => x.name)).toEqual(["nodejs", "python"]);
    expect(t[0]).toMatchObject({ name: "nodejs", version: "20.1.0", confidence: "high" });
    expect(t[1]).toMatchObject({ name: "python", confidence: "high" });
  });
  it("covers by id or capability of an active skill", () => {
    expect(skillCoversTechnology([skill("python")], "python")).toBe(true);
    expect(skillCoversTechnology([skill("python", { active: false })], "python")).toBe(false);
  });
});
