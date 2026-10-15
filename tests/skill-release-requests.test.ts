import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SKILLS_USAGE, skillsCommand } from "../src/skills/cli.js";
import { findReleaseRequest, parseReleaseRequests, readReleaseRequests } from "../src/skills/release-requests.js";

const TODAY = "2026-10-13";
// Built from pieces: tools/secret-scan reads this file too.
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);

const base = mkdtempSync(join(tmpdir(), "scf-release-requests-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const skills = (n: number) => Array.from({ length: n }, (_, i) => ({ source: "lib", id: `skill-${i}` }));
const entry = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  catalogue: "acme",
  version: "1.0.0",
  skills: [{ source: "lib", id: "alpha" }, { source: "lib", id: "beta" }],
  review: { by: "@octocat", on: "2026-10-01" },
  revoked: [{ id: "beta", version: "1.0.0", on: "2026-10-02", reason: "found a bad instruction" }],
  ...o,
});
const unreviewed = () => ({ catalogue: "acme", version: "1.1.0", skills: [{ source: "lib", id: "alpha" }] });
const valid = (o: Record<string, unknown> = {}) => ({ schema: 1, repository: "github.com/acme/scf-skills", releases: [entry(), unreviewed()], ...o });
const text = (p: { where: string; message: string }[]) => p.map((x) => `${x.where}: ${x.message}`).join("\n");
const refuse = (raw: unknown) => text(parseReleaseRequests(raw, TODAY).problems);
const refuseEntry = (o: Record<string, unknown>) => refuse(valid({ releases: [entry(o)] }));

describe("parseReleaseRequests", () => {
  it("accepts a valid file and keeps optional keys absent", () => {
    const r = parseReleaseRequests(valid(), TODAY);
    expect(r.problems).toEqual([]);
    expect(r.manifest).toEqual(valid());
    expect(Object.keys(r.manifest!.releases[1]!)).toEqual(["catalogue", "version", "skills"]);
  });
  it("accepts the boundaries", () => {
    const at = (releases: unknown[]) => parseReleaseRequests(valid({ releases }), TODAY).problems;
    expect(at([entry({ skills: skills(500), revoked: undefined })])).toEqual([]);
    expect(text(at([entry({ skills: skills(501), revoked: undefined })]))).toContain("releases[0].skills: must list at most 500 skills");
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...unreviewed(), version: `1.0.${i}` }));
    expect(at(many(200))).toEqual([]);
    expect(text(at(many(201)))).toContain("releases: must list at most 200 releases");
    expect(at([entry({ review: { by: "@octocat", on: TODAY } })])).toEqual([]);
    expect(at([entry({ revoked: [{ id: "beta", version: "1.0.0", on: TODAY, reason: "x".repeat(200) }] })])).toEqual([]);
  });
  it("refuses each broken field with its place", () => {
    const { repository: _r, ...noRepo } = valid();
    expect(refuse(noRepo)).toBe("repository: is required");
    expect(refuse(valid({ repository: "-bad" }))).toBe("repository: must be like github.com/acme/scf-skills");
    expect(refuse(valid({ schema: 2 }))).toBe("schema: must be 1");
    expect(refuse(valid({ releases: [] }))).toBe("releases: must list at least one release");
    expect(refuse(valid({ extra: 1 }))).toBe("file: has a key that is not known");
    expect(refuseEntry({ extra: 1 })).toBe("releases[0]: has a key that is not known");
    expect(refuseEntry({ review: { by: "@octocat", on: "2026-10-01", x: 1 } })).toBe("releases[0].review: has a key that is not known");
    expect(refuseEntry({ revoked: [{ id: "beta", version: "1.0.0", on: "2026-10-02", reason: "r", x: 1 }] })).toBe("releases[0].revoked[0]: has a key that is not known");
    expect(refuseEntry({ catalogue: "Bad Name" })).toContain("releases[0].catalogue: must be a lower-case slug");
    expect(refuseEntry({ version: "1.0" })).toContain("releases[0].version: must be a version like 1.2.3");
    expect(refuseEntry({ skills: [], revoked: undefined })).toBe("releases[0].skills: must list at least one skill");
    expect(refuseEntry({ skills: [{ source: "lib", id: "a" }, { source: "other", id: "a" }], revoked: undefined })).toBe("releases[0].skills[1].id: listed twice");
    expect(refuse(valid({ releases: [entry(), entry()] }))).toBe("releases[1]: has the same catalogue and version as releases[0]");
    expect(refuseEntry({ review: { by: "octocat", on: "2026-10-01" } })).toContain("releases[0].review.by: must be a GitHub user or team");
  });
  it("refuses unreal and future days", () => {
    expect(refuseEntry({ review: { by: "@octocat", on: "2026-02-30" } })).toBe("releases[0].review.on: must be a real date like 2026-01-31");
    expect(refuseEntry({ review: { by: "@octocat", on: "2026-10-14" } })).toBe("releases[0].review.on: must not be after today");
    expect(refuseEntry({ revoked: [{ id: "beta", version: "1.0.0", on: "2026-10-14", reason: "r" }] })).toBe("releases[0].revoked[0].on: must not be after today");
  });
  it("refuses bad revocations", () => {
    const rev = (o: Record<string, unknown>) => refuseEntry({ revoked: [{ id: "beta", version: "1.0.0", on: "2026-10-02", reason: "r", ...o }] });
    expect(rev({ id: "gamma" })).toBe("releases[0].revoked[0].id: is not in skills");
    expect(refuseEntry({ revoked: [{ id: "beta", version: "1.0.0", on: TODAY, reason: "r" }, { id: "beta", version: "1.0.1", on: TODAY, reason: "r" }] })).toBe("releases[0].revoked[1].id: listed twice");
    expect(rev({ reason: "two\nlines" })).toContain("releases[0].revoked[0].reason: holds a control character");
    expect(rev({ reason: "x".repeat(201) })).toBe("releases[0].revoked[0].reason: must be 1–200 characters, trimmed");
    expect(rev({ reason: " x" })).toBe("releases[0].revoked[0].reason: must be 1–200 characters, trimmed");
    expect(rev({ reason: "" })).toBe("releases[0].revoked[0].reason: must be 1–200 characters, trimmed");
  });
  it("refuses a document that is not a map and a bad today", () => {
    expect(refuse([])).toBe("file: must be a map with schema, repository and releases");
    expect(refuse("x")).toBe("file: must be a map with schema, repository and releases");
    expect(text(parseReleaseRequests(valid(), "tomorrow").problems)).toBe("today: must be a date like 2026-10-13");
  });
  it("never repeats file content in a problem", () => {
    const p = parseReleaseRequests(valid({ "zz-distinctive-key": 1, repository: TOKEN, releases: [entry({ revoked: [{ id: "beta", version: "1.0.0", on: TODAY, reason: TOKEN }] })] }), TODAY).problems;
    expect(p.length).toBeGreaterThan(0);
    const json = JSON.stringify(p);
    expect(json).not.toContain("zz-distinctive-key");
    expect(json).not.toContain(TOKEN);
  });
  it("finds a release by catalogue and version", () => {
    const m = parseReleaseRequests(valid(), TODAY).manifest!;
    expect(findReleaseRequest(m, "acme", "1.1.0")?.skills).toHaveLength(1);
    expect(findReleaseRequest(m, "acme", "9.9.9")).toBeUndefined();
  });
});

describe("readReleaseRequests", () => {
  const yaml = "schema: 1\nrepository: github.com/acme/scf-skills\nreleases:\n  - catalogue: acme\n    version: 1.0.0\n    skills:\n      - source: lib\n        id: alpha\n";
  const put = (name: string, content: string) => {
    const p = join(base, name);
    writeFileSync(p, content);
    return p;
  };
  const refused = (r: ReturnType<typeof readReleaseRequests>) => (r.state === "invalid" ? text(r.problems) : r.state);

  it("returns none for a missing file and ok for a valid one", () => {
    expect(readReleaseRequests(join(base, "missing.yaml"), TODAY)).toEqual({ state: "none" });
    expect(readReleaseRequests(put("ok.yaml", yaml), TODAY).state).toBe("ok");
  });
  it("refuses a symlink, a directory and a large file", () => {
    const ok = put("target.yaml", yaml);
    symlinkSync(ok, join(base, "link.yaml"));
    mkdirSync(join(base, "dir.yaml"));
    expect(refused(readReleaseRequests(join(base, "link.yaml"), TODAY))).toBe("file: is a symbolic link");
    expect(refused(readReleaseRequests(join(base, "dir.yaml"), TODAY))).toBe("file: is not a readable regular file");
    expect(refused(readReleaseRequests(ok, TODAY, 10))).toBe("file: is larger than 10 bytes");
  });
  it("refuses invalid YAML and aliases without repeating the file or its path", () => {
    const bad = put("bad.yaml", "releases: [\n");
    const r1 = refused(readReleaseRequests(bad, TODAY));
    expect(r1).toMatch(/^file: is not valid YAML/);
    expect(r1).not.toContain(base);
    const alias = put("alias.yaml", "schema: 1\nrepository: &r github.com/acme/zz-secret-name\nreleases: *r\n");
    const r2 = refused(readReleaseRequests(alias, TODAY));
    expect(r2).toMatch(/^file: is not valid YAML/);
    expect(r2).not.toContain("zz-secret-name");
  });
  it("prints no YAML warning for a duplicate key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      readReleaseRequests(put("dup.yaml", yaml + "schema: 1\n"), TODAY);
      expect(warn).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      emit.mockRestore();
    }
  });
});

describe("scf skills releases check", () => {
  const dir = mkdtempSync(join(base, "cwd-"));
  const run = async (operands: string[], values: Record<string, unknown> = {}) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["releases", ...operands], values }, (l) => void lines.push(l), { cwd: dir, today: TODAY });
    return { code, lines };
  };
  const yamlOf = (o: Record<string, unknown>) =>
    JSON.stringify(o); // JSON is YAML

  it("prints one line per release and OK, for the default file", async () => {
    writeFileSync(join(dir, "skill-releases.yaml"), yamlOf(valid()));
    const r = await run(["check"]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      "acme@1.0.0 2 skills, 1 revoked, reviewed by @octocat on 2026-10-01",
      "acme@1.1.0 1 skills, 0 revoked, NOT REVIEWED",
      "OK 2 releases for github.com/acme/scf-skills",
    ]);
  });
  it("accepts the skill-releases.yaml committed in this repository", async () => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["releases", "check"], values: {} }, (l) => void lines.push(l), { cwd: process.cwd(), today: TODAY });
    expect(lines.at(-1)).toMatch(/^OK \d+ releases for /);
    expect(code).toBe(0);
  });
  it("reads a named file", async () => {
    writeFileSync(join(dir, "named.yaml"), yamlOf(valid()));
    expect((await run(["check", "named.yaml"])).code).toBe(0);
  });
  it("prints PROBLEM lines and exits 1 for an invalid file", async () => {
    writeFileSync(join(dir, "bad.yaml"), yamlOf({ schema: 1, releases: [entry()] }));
    const r = await run(["check", "bad.yaml"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM repository: is required"]);
  });
  it("says so for a missing file", async () => {
    const r = await run(["check", "nope.yaml"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM the release request file does not exist"]);
  });
  it("rejects bad syntax with the usage", async () => {
    for (const operands of [[], ["verify"], ["check", "a", "b"]]) await expect(run(operands)).rejects.toThrow(SKILLS_USAGE);
    await expect(run(["check"], { repo: "x" })).rejects.toThrow(SKILLS_USAGE);
    expect(SKILLS_USAGE).toContain("scf skills releases check [<file>]");
  });
});
