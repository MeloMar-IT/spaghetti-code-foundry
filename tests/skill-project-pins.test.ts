import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHOICE_LIMITS, PINS_FILE } from "../src/skills/choice-rules.js";
import { readChoiceFile, readProjectPins, type GitRun } from "../src/skills/project-pins.js";

const COMMIT = "c".repeat(40);
const BLOB = "b".repeat(40);
const VALID = `schema: 1
pins:
  - capability: cap
    target: a@1.0.0
    by: "@octocat"
    reason: Reviewed by the owners
    from: "2026-01-01T00:00:00Z"
    expires: "2027-01-01T00:00:00Z"
`;
type Answer = { status: number | null; out?: string };
function fake(answers: Record<string, Answer>) {
  const calls: string[][] = [];
  const git: GitRun = (args) => {
    calls.push([...args]);
    const key = args[0] === "cat-file" ? `cat-file ${args[1] === "-s" ? "-s" : "blob"}` : args[0]!;
    const a = answers[key] ?? { status: 128 };
    return { status: a.status, stdout: Buffer.from(a.out ?? "") };
  };
  return { git, calls };
}
const ok = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  "symbolic-ref": { status: 0, out: "refs/remotes/origin/develop\n" },
  "rev-parse": { status: 0, out: `${COMMIT}\n` },
  "ls-tree": { status: 0, out: `100644 blob ${BLOB}\t${PINS_FILE}\0` },
  "cat-file -s": { status: 0, out: `${VALID.length}\n` },
  "cat-file blob": { status: 0, out: VALID },
  ...over,
});

describe("readProjectPins", () => {
  it("uses the branch of origin/HEAD, never main or master", () => {
    const f = fake(ok());
    const r = readProjectPins("/w", { git: f.git });
    expect(r).toMatchObject({ state: "ok", source: { commit: COMMIT, blob: BLOB } });
    expect(f.calls.some((c) => c.some((a) => a.includes("main") || a.includes("master")))).toBe(false);
    expect(f.calls[1]).toContain("refs/remotes/origin/develop^{commit}");
    expect(f.calls[2]).toContain(COMMIT);
    expect(f.calls.flat().some((a) => a.startsWith("/"))).toBe(false);
  });
  it("is unreadable without a default branch, and makes no further call", () => {
    const f = fake(ok({ "symbolic-ref": { status: 1 } }));
    expect(readProjectPins("/w", { git: f.git })).toEqual({ state: "unreadable", why: "no-default-branch" });
    expect(f.calls).toHaveLength(1);
  });
  for (const status of [null, 128])
    it(`fails closed when symbolic-ref gives ${status}`, () => {
      expect(readProjectPins("/w", { git: fake(ok({ "symbolic-ref": { status } })).git })).toEqual({ state: "unreadable", why: "git-failed" });
    });
  it("refuses a symbolic ref outside origin", () => {
    expect(readProjectPins("/w", { git: fake(ok({ "symbolic-ref": { status: 0, out: "refs/heads/main\n" } })).git })).toEqual({ state: "unreadable", why: "git-failed" });
  });
  it("takes the caller's branch without symbolic-ref, and refuses a bad name", () => {
    const f = fake(ok());
    expect(readProjectPins("/w", { git: f.git, defaultBranch: "develop" }).state).toBe("ok");
    expect(f.calls.some((c) => c[0] === "symbolic-ref")).toBe(false);
    expect(readProjectPins("/w", { git: f.git, defaultBranch: "a..b" })).toEqual({ state: "unreadable", why: "no-default-branch" });
  });
  it("is none with the commit when the file is absent", () => {
    expect(readProjectPins("/w", { git: fake(ok({ "ls-tree": { status: 0, out: "" } })).git })).toEqual({ state: "none", source: { commit: COMMIT } });
  });
  it("refuses a link, a large file and bad YAML", () => {
    expect(readProjectPins("/w", { git: fake(ok({ "ls-tree": { status: 0, out: `120000 blob ${BLOB}\t${PINS_FILE}\0` } })).git }).state).toBe("invalid");
    const big = fake(ok({ "cat-file -s": { status: 0, out: `${CHOICE_LIMITS.bytes + 1}\n` } }));
    expect(readProjectPins("/w", { git: big.git }).state).toBe("invalid");
    expect(big.calls.some((c) => c[1] === "blob")).toBe(false);
    expect(readProjectPins("/w", { git: fake(ok({ "cat-file blob": { status: 0, out: "a: [" } })).git }).state).toBe("invalid");
    expect(readProjectPins("/w", { git: fake(ok({ "cat-file blob": { status: 0, out: "schema: 1\npins: 5\n" } })).git }).state).toBe("invalid");
  });
  for (const step of ["rev-parse", "ls-tree", "cat-file -s", "cat-file blob"])
    for (const status of [null, 128])
      it(`is unreadable when ${step} gives ${status}`, () => {
        expect(readProjectPins("/w", { git: fake(ok({ [step]: { status } })).git })).toEqual({ state: "unreadable", why: "git-failed" });
      });
  it("never throws", () => {
    expect(readProjectPins("/w", { git: () => { throw new Error("boom"); } })).toEqual({ state: "unreadable", why: "git-failed" });
  });
});

describe("readChoiceFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "choicefile-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const OVERRIDES = `schema: 1
overrides:
  - capability: cap
    target: a@1.0.0
    by: "@octocat"
    reason: Reviewed
    from: "2026-01-01T00:00:00Z"
    review_by: "2027-01-01T00:00:00Z"
    scope: all
`;
  it("reads valid files of both kinds", () => {
    writeFileSync(join(dir, "pins.yaml"), VALID);
    writeFileSync(join(dir, "o.yaml"), OVERRIDES);
    expect(readChoiceFile(join(dir, "pins.yaml"), "project-pins").state).toBe("ok");
    expect(readChoiceFile(join(dir, "o.yaml"), "overrides").state).toBe("ok");
  });
  it("handles missing, link, large and invalid files", () => {
    expect(readChoiceFile(join(dir, "nope.yaml"), "overrides")).toEqual({ state: "none" });
    symlinkSync(join(dir, "o.yaml"), join(dir, "link.yaml"));
    expect(readChoiceFile(join(dir, "link.yaml"), "overrides").state).toBe("invalid");
    writeFileSync(join(dir, "big.yaml"), "x".repeat(CHOICE_LIMITS.bytes + 1));
    expect(readChoiceFile(join(dir, "big.yaml"), "overrides").state).toBe("invalid");
    writeFileSync(join(dir, "bad.yaml"), "schema: 2\n");
    expect(readChoiceFile(join(dir, "bad.yaml"), "project-pins").state).toBe("invalid");
    mkdirSync(join(dir, "d"));
    expect(readChoiceFile(join(dir, "d"), "project-pins").state).toBe("invalid");
  });
});
