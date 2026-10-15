import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkProfileEvaluation,
  findProfileEvaluation,
  MAX_PROFILE_EVALUATIONS,
  parseProfileEvaluations,
  readProfileEvaluations,
  type ProfileEvaluationRecord,
} from "../src/skills/profile-evaluations.js";

const TODAY = "2026-10-13";
const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
// built from pieces: tools/secret-scan reads this file too
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  skill: "lib-a", digest: D1, kind: "correctness", verdict: "passed", owner: "@octocat", reviewed: "2026-10-01", expires: "2027-01-01", ...over,
});
const file = (evaluations: unknown, over: Record<string, unknown> = {}) => ({ schema: 1, evaluations, ...over });
const problems = (raw: unknown) => parseProfileEvaluations(raw, TODAY).problems.map((p) => `${p.where}: ${p.message}`);

describe("parseProfileEvaluations", () => {
  it("accepts a passed and a failed record, with and without report", () => {
    const r = parseProfileEvaluations(file([rec({ report: D2 }), rec({ kind: "security", verdict: "failed" })]), TODAY);
    expect(r.problems).toEqual([]);
    expect(r.manifest!.evaluations).toHaveLength(2);
    expect(r.manifest!.evaluations[0]!.report).toBe(D2);
    expect(r.manifest!.evaluations[1]).not.toHaveProperty("report");
  });

  it("accepts the largest file, with a report on every record", () => {
    const list = Array.from({ length: MAX_PROFILE_EVALUATIONS }, (_, i) => rec({ skill: `skill-${i}`, report: D2 }));
    const r = parseProfileEvaluations(file(list), TODAY);
    expect(r.problems).toEqual([]);
    expect(r.manifest!.evaluations).toHaveLength(MAX_PROFILE_EVALUATIONS);
  });

  it("refuses more than the maximum", () => {
    const list = Array.from({ length: MAX_PROFILE_EVALUATIONS + 1 }, (_, i) => rec({ skill: `skill-${i}` }));
    expect(problems(file(list))).toEqual([`evaluations: must hold at most ${MAX_PROFILE_EVALUATIONS} evaluations`]);
  });

  it("refuses unknown keys, a wrong schema and a list that is not a list", () => {
    expect(problems(file([], { extra: 1 }))).toEqual(['file: unknown key "extra"']);
    expect(problems(file([], { schema: 2 }))).toEqual(["schema: schema must be 1"]);
    expect(problems(file({}))).toEqual(["evaluations: must be a list"]);
    expect(problems([])).toEqual(["file: must be a map with schema and evaluations"]);
    expect(problems(file([rec({ note: "x" })]))).toEqual(['evaluations[0] (lib-a/correctness): unknown key "note"']);
  });

  it.each(["skill", "digest", "kind", "verdict", "owner", "reviewed", "expires"])("requires %s", (field) => {
    const r = rec();
    delete r[field];
    expect(problems(file([r]))).toEqual([expect.stringContaining(`${field}: is required`)]);
  });

  it("refuses bad values", () => {
    expect(problems(file([rec({ verdict: "ok" })]))[0]).toContain('verdict: must be "passed" or "failed"');
    expect(problems(file([rec({ owner: "octocat" })]))[0]).toContain("owner: must be a GitHub user or team");
    expect(problems(file([rec({ owner: "@-x" })]))[0]).toContain("owner: must be a GitHub user or team");
    expect(problems(file([rec({ digest: "sha256:abc" })]))[0]).toContain("digest: must be a package digest");
    expect(problems(file([rec({ report: "sha256:abc" })]))[0]).toContain("report: must be a digest");
    expect(problems(file([rec({ skill: "lib-*" })]))[0]).toContain("skill: wildcards are not allowed");
    expect(problems(file([rec({ kind: "Not A Slug" })]))[0]).toContain("kind: must be a lower-case slug");
    expect(problems(file([rec({ kind: 5 })]))[0]).toContain("kind: must be text; put it in quotes");
    expect(problems(file([rec({ kind: "a\u0007b" })]))[0]).toContain("kind: holds a control or invisible character");
    expect(problems(file([rec({ owner: null })]))[0]).toContain("owner: must not be blank");
  });

  it("never repeats a credential-like value", () => {
    const text = JSON.stringify(problems(file([rec({ kind: TOKEN }), rec({ owner: TOKEN, skill: "lib-b" })])));
    expect(text).toContain("holds what looks like a credential");
    expect(text).not.toContain(TOKEN);
  });

  it("checks dates", () => {
    expect(problems(file([rec({ reviewed: "2026-10-14" })]))[0]).toContain("reviewed: must not be in the future");
    expect(problems(file([rec({ expires: "2026-09-30" })]))[0]).toContain("expires: must not be before reviewed");
    expect(problems(file([rec({ reviewed: "2026-01-01", expires: "2027-01-02" })]))[0]).toContain("expires: must be at most 365 days after reviewed");
    expect(problems(file([rec({ reviewed: "2026-01-01", expires: "2027-01-01" })]))).toEqual([]);
    expect(problems(file([rec({ reviewed: "2026-02-30" })]))[0]).toContain("reviewed: must be a date like 2026-10-13");
    expect(parseProfileEvaluations(file([]), "tomorrow").problems[0]!.where).toBe("today");
  });

  it("refuses the same skill, digest and kind twice", () => {
    expect(problems(file([rec(), rec({ verdict: "failed" })]))).toEqual(["evaluations[1] (lib-a/correctness): is already listed by evaluations[0]"]);
    expect(problems(file([rec(), rec({ digest: D2 }), rec({ kind: "security" })]))).toEqual([]);
  });

  it("refuses a file with a YAML alias value", () => {
    const shared = {};
    expect(problems(file([rec({ report: shared }), rec({ skill: "lib-b", report: shared })]))[0]).toContain("same value twice");
  });
});

describe("checkProfileEvaluation", () => {
  it("returns the entry or the problems", () => {
    expect(checkProfileEvaluation(rec(), 20000).problems).not.toEqual([]);
    expect(checkProfileEvaluation(null, 99999).problems).toEqual([{ field: "", message: "must be a map" }]);
  });
});

describe("readProfileEvaluations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "profeval-")));
    dirs.push(d);
    return d;
  };
  const yamlOf = (...r: Record<string, unknown>[]) =>
    ["schema: 1", "evaluations:", ...r.flatMap((e) => Object.entries(e).map(([k, v], i) => `${i === 0 ? "  - " : "    "}${k}: '${v}'`))].join("\n") + "\n";

  it("reads a valid file, and a missing file is none", () => {
    const d = dir();
    expect(readProfileEvaluations(join(d, "x.yaml"), TODAY)).toEqual({ state: "none" });
    writeFileSync(join(d, "x.yaml"), yamlOf(rec()));
    const r = readProfileEvaluations(join(d, "x.yaml"), TODAY);
    expect(r.state).toBe("ok");
  });

  it("refuses a link, a folder, a large file, an alias and bad YAML", () => {
    const d = dir();
    writeFileSync(join(d, "real.yaml"), yamlOf(rec()));
    symlinkSync(join(d, "real.yaml"), join(d, "link.yaml"));
    mkdirSync(join(d, "folder.yaml"));
    writeFileSync(join(d, "alias.yaml"), "schema: 1\nevaluations: &a []\nother: *a\n");
    writeFileSync(join(d, "bad.yaml"), "schema: 1\nevaluations: [\n");
    const msg = (f: string, max?: number) => {
      const r = readProfileEvaluations(join(d, f), TODAY, max);
      return r.state === "invalid" ? r.problems[0]!.message : r.state;
    };
    expect(msg("link.yaml")).toBe("is a symbolic link");
    expect(msg("folder.yaml")).toBe("is not a readable regular file");
    expect(msg("real.yaml", 10)).toBe("is larger than 10 bytes");
    expect(msg("alias.yaml")).toMatch(/^is not valid YAML/);
    expect(msg("bad.yaml")).toMatch(/^is not valid YAML \([A-Z_]+ at line \d+, column \d+\)$/);
  });

  it("prints no warning and no value for a credential-bearing unknown tag", () => {
    const d = dir();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(d, "tag.yaml"), `schema: 1\nevaluations:\n  - skill: !secret ${TOKEN}\n`);
    const r = readProfileEvaluations(join(d, "tag.yaml"), TODAY);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("findProfileEvaluation", () => {
  const ok = (over: Record<string, unknown> = {}) => rec(over) as unknown as ProfileEvaluationRecord;
  const find = (records: ProfileEvaluationRecord[], digest = D1, kind = "correctness") => findProfileEvaluation(records, "lib-a", kind, digest, TODAY).state;

  it("passed, failed, expired and expires today", () => {
    expect(find([ok()])).toBe("passed");
    expect(find([ok({ verdict: "failed" })])).toBe("failed");
    expect(find([ok({ expires: "2026-10-12" })])).toBe("expired");
    expect(find([ok({ expires: TODAY })])).toBe("passed");
  });

  it("another digest and not recorded", () => {
    expect(find([ok({ digest: D2 })])).toBe("other-digest");
    expect(find([ok({ kind: "security" })])).toBe("not-recorded");
    expect(find([])).toBe("not-recorded");
    expect(findProfileEvaluation([ok({ skill: "lib-b" })], "lib-a", "correctness", D1, TODAY).state).toBe("not-recorded");
  });

  it("ignores a record the parser would refuse", () => {
    expect(find([ok({ owner: "nobody" })])).toBe("not-recorded");
    expect(find([ok({ reviewed: "2026-12-01", expires: "2027-01-01" })])).toBe("not-recorded");
    expect(find([null as unknown as ProfileEvaluationRecord])).toBe("not-recorded");
  });

  it("throws for a bad today", () => {
    expect(() => findProfileEvaluation([], "lib-a", "correctness", D1, "soon")).toThrow(TypeError);
  });
});
