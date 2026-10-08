import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredSkill } from "../src/skills/registry.js";
import type { SkillRequest } from "../src/skills/request.js";
import { resolveSkills } from "../src/skills/resolve.js";
import {
  MAX_RUN_SKILL_LOCK_BYTES, RUN_SKILL_LOCK_FILE, RunSkillLockSchema, buildRunSkillLock, integrityReason, planHashOf, readRunSkillLock,
  runSkillLockSummary, safeText, serializeRunSkillLock, verifyRunSkillLock, writeRunSkillLock,
} from "../src/skills/run-lock.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "runlock-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
function sk(id: string, o: { version?: string; digest?: string; pin?: string; trust?: string; deps?: string[]; active?: boolean } = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "data folder", dir: "/secret/dir", active: o.active ?? true,
    trust: o.trust ?? "approved", pin: o.pin ?? "pinned", digest: o.digest ?? digestOf("a"),
    pkg: { id, version, description: `About ${id}.`, instructions: "Do it.", roles: [], dependencies: (o.deps ?? []).map((d) => ({ id: d })), conflicts: [] },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });
const request = (...items: { id: string; reason?: string; evidence?: string[] }[]): SkillRequest => ({
  version: 1,
  skills: items.map((i) => ({ id: i.id, reason: i.reason ?? "Needed for the change", evidence: i.evidence ?? ["catalogue:" + i.id] })),
});
const PH = digestOf("c");
function lockOf(r: ReturnType<typeof reg>, req: SkillRequest, commit?: string) {
  const resolution = resolveSkills(r, req.skills.map((s) => s.id));
  return buildRunSkillLock({ runId: "run-1", resolution, request: req, sourceOf: () => "admin", planHash: PH, commit, now: new Date("2026-01-01T00:00:00Z") });
}

describe("buildRunSkillLock", () => {
  it("follows the load order and takes reason and evidence from the request; a dependency has none", () => {
    const r = reg(sk("a", { deps: ["b"] }), sk("b", { version: "2.1.0", digest: digestOf("b") }));
    const lock = lockOf(r, request({ id: "a", evidence: ["path:src/x.ts", "issue:#12"] }));
    expect(lock.skills.map((s) => `${s.id}@${s.version}`)).toEqual(["b@2.1.0", "a@1.0.0"]);
    const [dep, a] = lock.skills;
    expect(dep).toMatchObject({ selection: "dependency", requiredBy: ["a"], source: "admin", role: "coder" });
    expect(dep!.reason).toBeUndefined();
    expect(dep!.evidence).toBeUndefined();
    expect(a).toMatchObject({ selection: "requested", reason: "Needed for the change", evidence: ["path:src/x.ts", "issue:#12"] });
    expect(lock.planHash).toBe(PH);
  });
  it("omits the commit unless it is a full hash", () => {
    const r = reg(sk("a"));
    expect("commit" in lockOf(r, request({ id: "a" }), "")).toBe(false);
    expect("commit" in lockOf(r, request({ id: "a" }), "HEAD")).toBe(false);
    expect(lockOf(r, request({ id: "a" }), "f".repeat(40)).commit).toBe("f".repeat(40));
  });
});

describe("privacy", () => {
  it("keeps no registry path, label or folder name", () => {
    const text = serializeRunSkillLock(lockOf(reg(sk("a")), request({ id: "a" })));
    expect(text).not.toContain("/secret");
    expect(text).not.toContain("data folder");
  });
  it.each([
    "/etc/passwd", "~/.ssh/id_rsa", "C:\\Users\\me\\x", "\\\\host\\share", "see /Users/me/project", "file:///x", "https://example.com/x",
    "token=abc", "Authorization: Bearer abc", "ghp_abcdefghijklmnop", "sk-abcdefghijkl", "-----BEGIN PRIVATE KEY", "A".repeat(40),
  ])("does not store the text %j", (t) => {
    expect(safeText(t)).toBe(false);
    const lock = lockOf(reg(sk("a")), request({ id: "a", reason: t, evidence: [`catalogue:${t}`] }));
    expect(lock.skills[0]!.reason).toBeUndefined();
    expect(lock.skills[0]!.evidence).toEqual(["catalogue:omitted"]);
    expect(serializeRunSkillLock(lock)).not.toContain(t);
  });
  it("keeps only the number of an issue, never its text", () => {
    const lock = lockOf(reg(sk("a")), request({ id: "a", evidence: ["issue:#7", "issue:the login page crashes when the name is empty", "path:src/a.ts"] }));
    expect(lock.skills[0]!.evidence).toEqual(["issue:#7", "issue:omitted", "path:src/a.ts"]);
  });
  it("is checked again when a lock is read", () => {
    const lock = lockOf(reg(sk("a")), request({ id: "a" }));
    const bad = (patch: object) => RunSkillLockSchema.safeParse({ ...lock, skills: [{ ...lock.skills[0], ...patch }] }).success;
    expect(bad({})).toBe(true);
    expect(bad({ evidence: ["path:/etc/passwd"] })).toBe(false);
    expect(bad({ evidence: ["path:../x"] })).toBe(false);
    expect(bad({ evidence: ["issue:full text of the issue"] })).toBe(false);
    expect(bad({ reason: "x".repeat(301) })).toBe(false);
    expect(bad({ reason: "password: hunter2" })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(RunSkillLockSchema.safeParse({ ...lock, extra: 1 }).success).toBe(false);
  });
  it("accepts any run id the run state accepts", () => {
    const lock = lockOf(reg(sk("a")), request({ id: "a" }));
    expect(RunSkillLockSchema.safeParse({ ...lock, runId: "x".repeat(100) }).success).toBe(true);
    expect(RunSkillLockSchema.safeParse({ ...lock, runId: "../x" }).success).toBe(false);
  });
});

describe("save and load", () => {
  it("round-trips with mode 0600, a digest of the bytes and no temporary file", () => {
    const dir = tmp();
    const lock = lockOf(reg(sk("a")), request({ id: "a" }));
    const { lockDigest } = writeRunSkillLock(dir, lock);
    expect(readdirSync(dir)).toEqual([RUN_SKILL_LOCK_FILE]);
    expect(statSync(join(dir, RUN_SKILL_LOCK_FILE)).mode & 0o777).toBe(0o600);
    expect(lockDigest).toBe("sha256:" + createHash("sha256").update(readFileSync(join(dir, RUN_SKILL_LOCK_FILE))).digest("hex"));
    const back = readRunSkillLock(dir);
    expect(back).toEqual({ ok: true, lock, lockDigest });
    const sum = runSkillLockSummary(lock, lockDigest);
    expect(sum).toMatchObject({ version: 1, lockDigest, planHash: PH, skills: [{ id: "a", version: "1.0.0", digest: digestOf("a"), selection: "requested" }] });
  });
  it("reports missing, invalid and unreadable files", () => {
    const dir = tmp();
    const file = join(dir, RUN_SKILL_LOCK_FILE);
    expect(readRunSkillLock(dir)).toEqual({ ok: false, reason: "missing" });
    writeFileSync(file, "{not json");
    expect(readRunSkillLock(dir)).toEqual({ ok: false, reason: "invalid" });
    const lock = lockOf(reg(sk("a")), request({ id: "a" }));
    writeFileSync(file, JSON.stringify({ ...lock, version: 2 }));
    expect(readRunSkillLock(dir)).toEqual({ ok: false, reason: "invalid" });
    writeFileSync(file, JSON.stringify({ ...lock, extra: true }));
    expect(readRunSkillLock(dir)).toEqual({ ok: false, reason: "invalid" });
    writeFileSync(file, " ".repeat(MAX_RUN_SKILL_LOCK_BYTES + 1));
    expect(readRunSkillLock(dir)).toEqual({ ok: false, reason: "unreadable" });
    rmSync(file);
    writeFileSync(join(dir, "other"), serializeRunSkillLock(lock));
    symlinkSync(join(dir, "other"), file);
    expect(readRunSkillLock(dir)).toEqual({ ok: false, reason: "unreadable" });
  });
  it("refuses to write a lock over the limit and leaves no file", () => {
    const dir = tmp();
    const lock = lockOf(reg(sk("a")), request({ id: "a" }));
    expect(() => writeRunSkillLock(dir, { ...lock, createdAt: "x".repeat(MAX_RUN_SKILL_LOCK_BYTES) })).toThrow();
    expect(existsSync(join(dir, RUN_SKILL_LOCK_FILE))).toBe(false);
  });
});

describe("verifyRunSkillLock", () => {
  const lock = lockOf(reg(sk("a")), request({ id: "a" }));
  it("passes an unchanged registry, also when a newer version became the active default", () => {
    expect(verifyRunSkillLock(lock, reg(sk("a")))).toEqual([]);
    expect(verifyRunSkillLock(lock, reg(sk("a", { version: "2.0.0", digest: digestOf("d") }), sk("a", { active: false })))).toEqual([]);
  });
  it("reports a changed digest with both digests", () => {
    const [p] = verifyRunSkillLock(lock, reg(sk("a", { digest: digestOf("e") })));
    expect(p).toEqual({ key: "a@1.0.0", code: "changed", expected: digestOf("a"), actual: digestOf("e") });
    expect(integrityReason(p!)).toBe(`skill integrity: a@1.0.0 changed since this run locked it (locked ${digestOf("a")}, now ${digestOf("e")})`);
  });
  it("reports a missing package, even when another version exists", () => {
    expect(verifyRunSkillLock(lock, reg()).map((p) => p.code)).toEqual(["missing"]);
    expect(verifyRunSkillLock(lock, reg(sk("a", { version: "2.0.0" }))).map((p) => p.code)).toEqual(["missing"]);
  });
  it.each([
    ["unpinned", { pin: "unpinned" }],
    ["unverified", { pin: "unverified" }],
    ["changed", { pin: "mismatch" }],
    ["unapproved", { trust: "unapproved", pin: "unpinned" }],
  ])("reports %s", (code, over) => {
    expect(verifyRunSkillLock(lock, reg(sk("a", over))).map((p) => p.code)).toEqual([code]);
    expect(integrityReason(verifyRunSkillLock(lock, reg(sk("a", over)))[0]!)).toMatch(/^skill integrity: a@1\.0\.0 /);
  });
});

describe("planHashOf", () => {
  it("is stable and differs for different text", () => {
    expect(planHashOf("plan")).toBe(planHashOf("plan"));
    expect(planHashOf("plan")).not.toBe(planHashOf("plan2"));
    expect(planHashOf("plan")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
