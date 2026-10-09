import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import {
  MAX_PLAN_RECORD_BYTES, PlanRecordSchema, parsePlanCommentFacts, planChanges, planCommentRefOf, planRecordKey, pickPlanRecord,
  planStoreSettings, prunePlanRecords, readPlanRecords, storableRequest, technologyHashOf, writePlanRecord, type PlanRecord,
} from "../src/skills/plan-record.js";
import type { RepoProfile } from "../src/skills/repo-profile.js";
import { SKILL_DIGEST_RE } from "../src/skills/schema.js";

const digestOf = (c: string) => "sha256:" + c.repeat(64);
const hexOf = (c: string) => c.repeat(64);
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plan-record-"));
});
afterEach(() => {
  planStoreSettings.waitMs = 2000;
  rmSync(home, { recursive: true, force: true });
});

const rec = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  version: 1,
  repo: "a/x",
  issue: "5",
  runId: "run-1",
  planHash: digestOf("a"),
  commentId: "100",
  commentSha256: digestOf("b"),
  request: { version: 1, skills: [{ id: "typescript", reason: "The change is in TypeScript.", evidence: ["path:src/a.ts"] }] },
  createdAt: new Date().toISOString(),
  ...over,
});
/** A record that differs from the others by its comment ID (and so its plan hash). */
const recN = (n: number, over: Partial<PlanRecord> = {}) => rec({ commentId: String(n), planHash: "sha256:" + n.toString(16).padStart(64, "0"), ...over });
const dir5 = () => join(home, "skill-plans", "a", "x", "5");
const fact = (id: string, sha: string, mine = true, later = 0) => ({ id, sha256: sha, mine, later });
const read = (repo = "a/x", issue = "5") => readPlanRecords(repo, issue, { home });

describe("plan record store", () => {
  it("writes a record to its folder and reads it back", () => {
    writePlanRecord(rec(), { home });
    const file = join(dir5(), hexOf("a") + ".json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir5()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(read()).toEqual({ records: [rec({ createdAt: JSON.parse(readFileSync(file, "utf8")).createdAt })] });
  });

  it("does not show a record for another repository or issue; case and a leading zero do not matter", () => {
    writePlanRecord(rec(), { home });
    expect(read("b/x", "5")).toEqual({ records: [] });
    expect(read("a/x", "6")).toEqual({ records: [] });
    expect(read("A/X.git", "005")).toMatchObject({ records: [{ repo: "a/x" }] });
  });

  it("gives a key only for a valid repository and issue", () => {
    for (const r of ["a", "a/b/c", "../x", "a/..", "a/x y", "owner/repo", "-a/x", "a/..git"]) expect(planRecordKey(r, "5"), r).toBeUndefined();
    for (const i of ["abc", "0", "5a", "", "1234567890"]) expect(planRecordKey("a/x", i), i).toBeUndefined();
    expect(planRecordKey("A/X.git", "004")).toEqual({ owner: "a", name: "x", issue: "4" });
  });

  it("refuses a record that is not safe to store", () => {
    const bad = [
      rec({ request: { version: 1, skills: [{ id: "typescript", reason: "see /Users/me/x", evidence: ["path:src/a.ts"] }] } }),
      rec({ request: { version: 1, skills: [{ id: "typescript", reason: "ok", evidence: ["issue:some text"] }] } }),
      { ...rec(), extra: 1 } as PlanRecord,
      rec({ commentId: "12a" }),
      rec({ createdAt: "Oct 9 2026" }),
      rec({ repo: "owner/repo" }),
    ];
    for (const r of bad) expect(() => writePlanRecord(r, { home })).toThrow();
    expect(readdirSync(home)).toEqual([]);
  });

  it("projects a request with storableRequest", () => {
    const out = storableRequest({
      version: 1,
      skills: [
        { id: "a-skill", reason: "/Users/me/x", evidence: ["issue:asks for it", "issue:#12", "path:src/a.ts", "catalogue:typescript: high"] },
        { id: "b-skill", reason: "token ghp_abcdefgh123", evidence: ["issue:one", "issue:two"] },
      ],
    });
    expect(out.skills[0]).toEqual({ id: "a-skill", reason: "omitted", evidence: ["issue:omitted", "issue:#12", "path:src/a.ts", "catalogue:typescript: high"] });
    expect(out.skills[1]).toEqual({ id: "b-skill", reason: "omitted", evidence: ["issue:omitted"] });
    expect(PlanRecordSchema.safeParse(rec({ request: out })).success).toBe(true);
  });

  it("reads 'invalid' for anything that is not exactly a record", () => {
    const file = join(dir5(), hexOf("a") + ".json");
    const fresh = (put: (dir: string) => void) => {
      rmSync(join(home, "skill-plans"), { recursive: true, force: true });
      mkdirSync(dir5(), { recursive: true });
      put(dir5());
      expect(read()).toBe("invalid");
    };
    const text = (r: PlanRecord) => JSON.stringify(r);
    fresh((d) => writeFileSync(join(d, hexOf("a") + ".json"), "{ garbage"));
    fresh((d) => {
      writeFileSync(join(home, "real.json"), text(rec()));
      symlinkSync(join(home, "real.json"), join(d, hexOf("a") + ".json"));
    });
    fresh((d) => writeFileSync(join(d, hexOf("a") + ".json"), " ".repeat(MAX_PLAN_RECORD_BYTES + 1)));
    fresh((d) => writeFileSync(join(d, hexOf("c") + ".json"), text(rec())));
    fresh((d) => writeFileSync(join(d, "notes.txt"), "hi"));
    fresh((d) => writeFileSync(join(d, hexOf("a") + ".json"), text(rec({ repo: "b/x" }))));
    fresh((d) => writeFileSync(join(d, hexOf("a") + ".json"), text(rec({ issue: "6" }))));
    fresh((d) => {
      writeFileSync(join(d, hexOf("a") + ".json"), text(rec()));
      writeFileSync(join(d, hexOf("c") + ".json"), text(rec({ planHash: digestOf("c") })));
    });
    fresh((d) => writeFileSync(join(d, "purged.json"), "nope"));
    expect(file).toContain("skill-plans");
  });

  it("reads 'invalid' when a folder on the way is a link", () => {
    mkdirSync(join(home, "outside", "x", "5"), { recursive: true });
    mkdirSync(join(home, "skill-plans"));
    symlinkSync(join(home, "outside"), join(home, "skill-plans", "a"));
    expect(read()).toBe("invalid");
    expect(() => writePlanRecord(rec(), { home })).toThrow();
    expect(readdirSync(join(home, "outside", "x", "5"))).toEqual([]);
    rmSync(join(home, "skill-plans"), { recursive: true });
    mkdirSync(join(home, "skill-plans", "a", "x"), { recursive: true });
    symlinkSync(join(home, "outside", "x", "5"), join(home, "skill-plans", "a", "x", "5"));
    expect(read()).toBe("invalid");
    rmSync(join(home, "skill-plans"), { recursive: true });
    symlinkSync(join(home, "outside"), join(home, "skill-plans"));
    expect(read()).toBe("invalid");
    expect(() => writePlanRecord(rec(), { home })).toThrow();
    expect(prunePlanRecords({ olderThanMs: 0, home })).toBe(0);
  });

  it("reads 'invalid', not an error, when the issue folder cannot be listed", () => {
    writePlanRecord(rec(), { home });
    chmodSync(dir5(), 0o000);
    try {
      // as root the folder stays readable; the read must not throw either way
      expect(() => read()).not.toThrow();
      if (process.getuid?.() !== 0) expect(read()).toBe("invalid");
    } finally {
      chmodSync(dir5(), 0o700);
    }
  });

  it("skips temporary files and leaves a link in their place alone", () => {
    writePlanRecord(rec(), { home });
    writeFileSync(join(home, "target"), "keep");
    symlinkSync(join(home, "target"), join(dir5(), hexOf("a") + ".json.1.tmp"));
    expect(read()).toMatchObject({ records: [{ commentId: "100" }] });
    writePlanRecord(recN(7), { home });
    expect(readFileSync(join(home, "target"), "utf8")).toBe("keep");
  });

  it("throws StoreError when the lock is held", () => {
    mkdirSync(join(home, "skill-plans.lock"));
    writeFileSync(join(home, "skill-plans.lock", "pid"), String(process.pid));
    planStoreSettings.waitMs = 0;
    const locked = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ kind: "locked" }));
    locked(() => writePlanRecord(rec(), { home }));
    expect(() => writePlanRecord(rec(), { home })).toThrow(StoreError);
    locked(() => prunePlanRecords({ olderThanMs: 0, home }));
    expect(prunePlanRecords({ olderThanMs: 0, dryRun: true, home })).toBe(0);
    expect(readdirSync(home)).toEqual(["skill-plans.lock"]);
  });
});

describe("plan record retention", () => {
  it("keeps the 20 records with the highest comment IDs", () => {
    const ids = Array.from({ length: 22 }, (_, i) => i + 1);
    const shuffled = [...ids.filter((n) => n % 2 === 0).reverse(), ...ids.filter((n) => n % 2 === 1)];
    for (const n of shuffled) writePlanRecord(recN(n), { home });
    const r = read();
    expect(r).not.toBe("invalid");
    expect((r as { records: PlanRecord[] }).records.map((x) => x.commentId)).toEqual(ids.slice(2).map(String));
  });

  it("replaces the record of the same comment", () => {
    writePlanRecord(rec(), { home });
    writePlanRecord(rec({ planHash: digestOf("c") }), { home });
    expect(read()).toMatchObject({ records: [{ planHash: digestOf("c") }] });
  });

  const old = (days: number) => new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();
  const day = 86_400_000;

  it("prunes by age and counts; a dry run only counts", () => {
    writePlanRecord(recN(1, { createdAt: old(10) }), { home });
    writePlanRecord(recN(2), { home });
    expect(prunePlanRecords({ olderThanMs: day, dryRun: true, home })).toBe(1);
    expect((read() as { records: unknown[] }).records).toHaveLength(2);
    expect(readdirSync(dir5()).some((f) => f === "purged.json")).toBe(false);
    expect(prunePlanRecords({ olderThanMs: day, home })).toBe(1);
    expect((read() as { records: PlanRecord[] }).records.map((r) => r.commentId)).toEqual(["2"]);
    expect(readdirSync(dir5()).includes("purged.json")).toBe(false);
  });

  it("leaves a note with the skill IDs when the last record goes, and a new write removes it", () => {
    const skill = (id: string) => ({ id, reason: "ok", evidence: ["issue:#1"] });
    writePlanRecord(recN(1, { createdAt: old(10), request: { version: 1, skills: [skill("zeta"), skill("alpha")] } }), { home });
    expect(prunePlanRecords({ olderThanMs: day, home })).toBe(1);
    expect(read()).toMatchObject({ records: [], purged: { skills: ["alpha", "zeta"] } });
    writePlanRecord(recN(2), { home });
    expect(readdirSync(dir5()).includes("purged.json")).toBe(false);
    expect((read() as { purged?: unknown }).purged).toBeUndefined();
  });

  it("does not remove what is not a valid record", () => {
    writePlanRecord(recN(1, { createdAt: old(10) }), { home });
    writeFileSync(join(dir5(), "notes.txt"), "hi");
    expect(prunePlanRecords({ olderThanMs: day, home })).toBe(1);
    expect(readFileSync(join(dir5(), "notes.txt"), "utf8")).toBe("hi");
  });

  it("gives 0 without a store", () => {
    expect(prunePlanRecords({ olderThanMs: 0, home })).toBe(0);
  });
});

describe("pickPlanRecord", () => {
  const S = digestOf("b");
  const r100 = rec();
  const one = { records: [r100] };
  const kind = (read: Parameters<typeof pickPlanRecord>[0], facts: Parameters<typeof pickPlanRecord>[1]) => pickPlanRecord(read, facts).kind;

  it("finds the record of an unchanged plan comment of ours", () => {
    expect(pickPlanRecord(one, { comments: [fact("100", S, true, 2)] })).toEqual({ kind: "record", record: r100, later: 2 });
  });
  it("never pairs with a copy that is not ours", () => {
    expect(kind(one, { comments: [fact("100", S), fact("150", S, false)] })).toBe("record");
    expect(kind(one, { comments: [fact("150", S, false)] })).toBe("comment-missing");
    expect(kind(one, { comments: [fact("100", S, false)] })).toBe("comment-missing");
  });
  it("sees a deleted original", () => {
    expect(kind(one, { comments: [] })).toBe("comment-missing");
    expect(kind(one, { comments: [fact("50", S)] })).toBe("comment-missing");
  });
  it("sees an edited original", () => {
    expect(kind(one, { comments: [fact("100", digestOf("c"))] })).toBe("comment-changed");
  });
  it("sees a newer plan without a record", () => {
    expect(kind(one, { comments: [fact("100", S), fact("200", digestOf("d"))] })).toBe("newer-plan");
  });
  it("uses the newest record whatever the order of the writes", () => {
    writePlanRecord(recN(200, { commentSha256: S }), { home });
    writePlanRecord(recN(100, { commentSha256: S }), { home });
    expect(pickPlanRecord(read(), { comments: [fact("200", S)] })).toMatchObject({ kind: "record", record: { commentId: "200" } });
  });
  it("compares long IDs as numbers", () => {
    const big = rec({ commentId: "12345678901234567890" });
    expect(kind({ records: [big] }, { comments: [fact("9999999999999999999", S)] })).toBe("comment-missing");
    expect(kind({ records: [big] }, { comments: [fact("12345678901234567890", S)] })).toBe("record");
  });
  it("tells a purged, an empty and an unreadable store apart", () => {
    const purged = { skills: ["a"], at: new Date().toISOString() };
    expect(kind({ records: [], purged }, undefined)).toBe("record-purged");
    expect(kind({ records: [] }, { comments: [fact("100", S)] })).toBe("none");
    expect(kind({ records: [] }, undefined)).toBe("none");
    expect(kind("invalid", { comments: [] })).toBe("check-unreadable");
    expect(kind(one, undefined)).toBe("check-unreadable");
  });
});

describe("planChanges and technologyHashOf", () => {
  it("reports what changed, in a fixed order", () => {
    expect(planChanges({ later: 0, pathsChanged: false })).toEqual([]);
    expect(planChanges({ later: 1, pathsChanged: false })).toEqual(["comments"]);
    expect(planChanges({ later: 3, pathsChanged: true, technologyThen: "x", technologyNow: "y" })).toEqual(["comments", "code", "technology"]);
    expect(planChanges({ later: 0, pathsChanged: false, technologyThen: "x" })).toEqual([]);
    expect(planChanges({ later: 0, pathsChanged: false, technologyNow: "x" })).toEqual([]);
    expect(planChanges({ later: 0, pathsChanged: false, technologyThen: "x", technologyNow: "x" })).toEqual([]);
  });

  const finding = (name: string, over: Record<string, unknown> = {}) => ({ kind: "dependency", name, value: "1.0.0", path: "package.json", detector: "deps", reason: "r", ...over });
  const profile = (findings: unknown[], stats = { files: 1, directories: 1, bytesRead: 1 }) => ({ version: 1, stats, findings }) as unknown as RepoProfile;

  it("ignores paths, counts, stats, order and values; changes with a new dependency", () => {
    const base = technologyHashOf(profile([finding("react"), finding("vite")]));
    expect(base).toMatch(SKILL_DIGEST_RE);
    expect(technologyHashOf(profile([finding("vite", { path: "web/package.json", count: 9, value: "2.0.0" }), finding("react")], { files: 99, directories: 9, bytesRead: 5 }))).toBe(base);
    expect(technologyHashOf(profile([finding("react"), finding("vite"), finding("zod")]))).not.toBe(base);
  });
});

describe("parsers", () => {
  const line = (o: unknown) => `PLAN_COMMENTS: ${JSON.stringify(o)}`;
  const c = (over: Record<string, unknown> = {}) => ({ id: "1", sha256: digestOf("a"), mine: true, later: 0, ...over });
  it("parsePlanCommentFacts", () => {
    const ok = line({ version: 1, comments: [c()] });
    expect(parsePlanCommentFacts(`noise\n${ok}\nmore\n`)).toEqual({ comments: [c()] });
    expect(parsePlanCommentFacts("nothing")).toBeUndefined();
    expect(parsePlanCommentFacts(`${ok}\n${ok}`)).toBeUndefined();
    expect(parsePlanCommentFacts(line({ version: 1, comments: [c({ x: 1 })] }))).toBeUndefined();
    expect(parsePlanCommentFacts(line({ version: 1, comments: [c({ sha256: "sha256:zz" })] }))).toBeUndefined();
    expect(parsePlanCommentFacts(line({ version: 1, comments: [c({ later: -1 })] }))).toBeUndefined();
    expect(parsePlanCommentFacts(line({ version: 1, comments: [c({ mine: "yes" })] }))).toBeUndefined();
    expect(parsePlanCommentFacts(line({ version: 1, comments: Array.from({ length: 31 }, () => c()) }))).toBeUndefined();
    expect(parsePlanCommentFacts("PLAN_COMMENTS: {oops")).toBeUndefined();
    expect(parsePlanCommentFacts(` ${ok}`)).toBeUndefined();
  });
  it("planCommentRefOf", () => {
    const url = "https://github.com/a/x/issues/5#issuecomment-123";
    const sha = `PLAN_COMMENT_SHA256: ${digestOf("a")}`;
    expect(planCommentRefOf(`posted\n${url}\n${sha}\n`)).toEqual({ id: "123", sha256: digestOf("a") });
    expect(planCommentRefOf(sha)).toBeUndefined();
    expect(planCommentRefOf(`${url}\n${url}\n${sha}`)).toBeUndefined();
    expect(planCommentRefOf(url)).toBeUndefined();
    expect(planCommentRefOf(`${url}\n${sha}\n${sha}`)).toBeUndefined();
    expect(planCommentRefOf(`${url}\nPLAN_COMMENT_SHA256: sha256:abc`)).toBeUndefined();
  });
});
