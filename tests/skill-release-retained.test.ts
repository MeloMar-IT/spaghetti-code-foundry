import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { skillsCommand } from "../src/skills/cli.js";
import { SKILL_LOCK_FILE } from "../src/skills/lock.js";
import { clearSkillRegistryCache, discoverSkills, findSkill, type SkillRegistry } from "../src/skills/registry.js";
import type { ApprovedRelease } from "../src/skills/release.js";
import { listStoredReleases, releaseStorePath, storeSources } from "../src/skills/release-store.js";
import { resolveSkills } from "../src/skills/resolve.js";
import { RunSkillLockSchema, verifyRunSkillLock, writeRunSkillLock, type RunSkillLock } from "../src/skills/run-lock.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

let base: string;
let home: string;
let builtin: string;
let userHome: string;
let n = 0;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "skillret-")));
  home = join(base, "home");
  builtin = join(base, "builtin");
  userHome = join(base, "user");
  for (const d of [home, builtin, userHome]) mkdirSync(d);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearSkillRegistryCache();
});

function pkg(root: string, id: string, version: string): void {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: ${version}\n`);
}

/** Puts a schema-2 release into the store (not into any config). Returns its approved entry. */
function store(catalogue: string, version: string, skills: Record<string, string>, folder = join(catalogue, version)): ApprovedRelease {
  const scratch = join(base, `scratch-${n++}`);
  for (const [id, v] of Object.entries(skills)) pkg(scratch, id, v);
  const { approved } = writeV2Release(scratch, { catalogue, version });
  const dest = join(home, "skill-releases", folder);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(scratch, dest, { recursive: true });
  return approved;
}

const cfg = (approved: ApprovedRelease[], over: Record<string, unknown> = {}, allow = false) =>
  ConfigSchema.parse({ skills: { roots: [], releases: { allow_unreleased: allow, approved }, ...over } }).skills;
const discover = (skills: ReturnType<typeof cfg>): SkillRegistry => discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {} });
const pin = (reg: SkillRegistry, ...keys: string[]) => {
  const file = join(home, SKILL_LOCK_FILE);
  const pins: Record<string, { digest: string; pinnedAt: string }> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).pins : {};
  for (const k of keys) pins[k] = { digest: reg.byKey.get(k)!.digest, pinnedAt: "2026-01-01T00:00:00Z" };
  writeFileSync(file, JSON.stringify({ version: 1, pins }));
};
const lockOf = (id: string, version: string, digest: string): RunSkillLock =>
  RunSkillLockSchema.parse({
    version: 1,
    runId: "r1",
    createdAt: "2026-01-01T00:00:00Z",
    planHash: "sha256:" + "d".repeat(64),
    estimatedTokens: 10,
    skills: [{ id, version, digest, source: "admin", role: "coder", selection: "requested", requiredBy: [], estimatedTokens: 10 }],
  });

describe("retained approved releases", () => {
  it("keeps an old lock valid after a newer release is approved, and drops it when the approval is removed", () => {
    const a1 = store("c", "1.0.0", { x: "1.0.0" });
    let reg = discover(cfg([a1]));
    pin(reg, "x@1.0.0");
    reg = discover(cfg([a1]));
    const first = resolveSkills(reg, ["x"]);
    expect(first.selected.map((s) => `${s.id}@${s.version}`)).toEqual(["x@1.0.0"]);
    const old = lockOf("x", "1.0.0", reg.byKey.get("x@1.0.0")!.digest);
    expect(verifyRunSkillLock(old, reg)).toEqual([]);

    const a2 = store("c", "1.1.0", { x: "1.1.0" });
    reg = discover(cfg([a1, a2]));
    expect(findSkill(reg, "x")!.version).toBe("1.1.0");
    // Approval is not a pin (Q1): the new package is active but not selectable yet.
    expect(resolveSkills(reg, ["x"]).selected).toEqual([]);
    expect(verifyRunSkillLock(old, reg)).toEqual([]);

    pin(reg, "x@1.1.0");
    reg = discover(cfg([a1, a2]));
    expect(verifyRunSkillLock(old, reg)).toEqual([]);
    expect(resolveSkills(reg, ["x"]).selected.map((s) => `${s.id}@${s.version}`)).toEqual(["x@1.1.0"]);
    expect(reg.byKey.get("x@1.0.0")).toMatchObject({ active: false, shadowedBy: "x@1.1.0", label: "release c@1.0.0" });
    expect(findSkill(reg, "x", "1.0.0")!.version).toBe("1.0.0");
    // A shadowed package is never offered to a planner.
    const offered = buildSkillCatalogue(reg).entries.filter((e) => e.id === "x");
    expect(offered.map((e) => e.version)).toEqual(["1.1.0"]);

    reg = discover(cfg([a2]));
    expect(verifyRunSkillLock(old, reg).map((p) => p.code)).toEqual(["missing"]);
    expect(reg.notes.some((x) => x.kind === "unapproved-release" && x.text.includes("release c@1.0.0 is published but not in skills.releases.approved"))).toBe(true);
    for (const v of ["1.0.0", "1.1.0"]) expect(existsSync(join(home, "skill-releases", "c", v, "catalogue-release.json"))).toBe(true);
  });

  it("reads releases newest first by semver, after the data folder and before skills.roots", () => {
    const list = ["1.9.0", "2.0.0-rc.1", "1.10.0", "2.0.0"].map((v) => store("c", v, { x: v }));
    store("a-cat", "0.1.0", { y: "0.1.0" });
    const all = [...list, store("a-cat", "0.1.0", { y: "0.1.0" })].reverse();
    const root = join(base, "root0");
    pkg(root, "z", "1.0.0");
    const reg = discover(cfg(all, { roots: [root] }));
    expect(reg.sources.map((s) => s.label)).toEqual([
      "data folder",
      "release a-cat@0.1.0",
      "release c@2.0.0",
      "release c@2.0.0-rc.1",
      "release c@1.10.0",
      "release c@1.9.0",
      "skills.roots[0]",
      "built-in",
    ]);
    expect(findSkill(reg, "x")!.version).toBe("2.0.0");
  });

  it("does not load an unapproved folder, even with allow_unreleased, and says so in a note", () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    store("c", "1.1.0", { x: "1.1.0" });
    for (const allow of [false, true]) {
      const reg = discover(cfg([a], {}, allow));
      expect(reg.problems.filter((p) => p.kind !== "lock")).toEqual([]);
      expect(reg.sources.some((s) => s.label === "release c@1.1.0")).toBe(false);
      expect(reg.byKey.has("x@1.1.0")).toBe(false);
      expect(reg.notes.map((x) => x.text)).toContain('release c@1.1.0 is published but not in skills.releases.approved, so it is not loaded; see "scf skills release list".');
    }
  });

  it("refuses a wrong digest, a folder that holds another version and a schema-1 manifest", () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    const reg = discover(cfg([{ ...a, digest: "sha256:" + "0".repeat(64) }], {}, true));
    expect(reg.problems.map((p) => p.kind)).toContain("root-refused");
    expect(reg.byKey.size).toBe(0);

    // c/1.2.0 holds the release c@1.0.0
    const b = store("c", "1.0.0", { x: "1.0.0" }, join("c", "1.2.0"));
    const reg2 = discover(cfg([a, { catalogue: "c", version: "1.2.0", digest: b.digest }]));
    const refused = reg2.problems.find((p) => p.kind === "root-refused")!;
    expect(refused.label).toBe("release c@1.2.0");
    expect(refused.reason).toBe("the release folder does not hold c@1.2.0");
    expect(reg2.byKey.get("x@1.0.0")!.label).toBe("release c@1.0.0");

    const dir = join(home, "skill-releases", "c", "1.0.0");
    const m = JSON.parse(readFileSync(join(dir, "catalogue-release.json"), "utf8"));
    writeFileSync(join(dir, "catalogue-release.json"), JSON.stringify({ ...m, schema: 1, skills: m.skills.map((s: { id: string; version: string; digest: string }) => ({ id: s.id, version: s.version, digest: s.digest })) }));
    const reg3 = discover(cfg([a], {}, true));
    expect(reg3.problems.some((p) => p.kind === "root-refused" && p.label === "release c@1.0.0")).toBe(true);
    expect(reg3.byKey.size).toBe(0);
  });

  it("ignores temporary folders, files and odd names without a note", () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    mkdirSync(join(home, "skill-releases", ".tmp-abc"));
    writeFileSync(join(home, "skill-releases", "file.txt"), "x");
    mkdirSync(join(home, "skill-releases", "Bad_Name", "1.0.0"), { recursive: true });
    mkdirSync(join(home, "skill-releases", "c", "1.0"), { recursive: true });
    const reg = discover(cfg([a]));
    expect(reg.problems.filter((p) => p.kind !== "lock")).toEqual([]);
    expect(reg.notes).toEqual([]);
  });

  it("does not follow links in the store", () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    const outside = join(base, "outside");
    cpSync(join(home, "skill-releases", "c"), join(outside, "c"), { recursive: true });
    symlinkSync(join(outside, "c"), join(home, "skill-releases", "d"));
    mkdirSync(join(home, "skill-releases", "e"));
    symlinkSync(join(outside, "c", "1.0.0"), join(home, "skill-releases", "e", "1.0.0"));
    expect(listStoredReleases(home).releases.map((r) => `${r.catalogue}@${r.version}`)).toEqual(["c@1.0.0"]);

    const linked = join(base, "home2");
    mkdirSync(linked);
    symlinkSync(join(home, "skill-releases"), join(linked, "skill-releases"));
    const reg = discoverSkills(cfg([a]), { home: linked, builtinRoot: builtin, userHome, env: {} });
    const p = reg.problems.filter((x) => x.label === "release store");
    expect(p).toHaveLength(1);
    expect(p[0]!.kind).toBe("root-refused");
    expect(reg.byKey.size).toBe(0);
    // with nothing approved it is only a note
    expect(discoverSkills(cfg([]), { home: linked, builtinRoot: builtin, userHome, env: {} }).problems.filter((x) => x.label === "release store")).toEqual([]);
  });

  it("never loads or shows a folder whose name looks like a credential", () => {
    const secret = "sk-ant-" + "a".repeat(20);
    const a = store(secret, "1.0.0", { x: "1.0.0" }, join(secret, "1.0.0"));
    const reg = discover(cfg([a]));
    expect(reg.byKey.size).toBe(0);
    expect(JSON.stringify({ s: reg.sources, n: reg.notes, p: reg.problems })).not.toContain(secret);
    expect(reg.notes.some((x) => x.kind === "release-store")).toBe(true);
  });

  it("has no count limit on the store, and caps the notes", () => {
    const a = store("c", "0.0.1", { x: "0.0.1" });
    for (let i = 1; i <= 501; i++) mkdirSync(join(home, "skill-releases", "c", `1.0.${i}`));
    const listing = listStoredReleases(home);
    expect(listing.releases).toHaveLength(502);
    const reg = discover(cfg([a]));
    expect(reg.byKey.has("x@0.0.1")).toBe(true);
    const notes = reg.notes.filter((x) => x.kind === "unapproved-release");
    expect(notes).toHaveLength(21);
    expect(notes[20]!.text).toBe("… and 481 more unapproved releases");
  });

  it("ignores store paths in skills.roots with a note, and loads the release once", () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    const written = join(home, "skill-releases", "c", "1.0.0");
    const alias = join(base, "alias");
    symlinkSync(written, alias);
    const reg = discover(cfg([a], { roots: [written, alias] }));
    expect(reg.problems.filter((p) => p.kind !== "lock")).toEqual([]);
    expect(reg.notes.filter((x) => x.kind === "store-root")).toHaveLength(2);
    expect(reg.byKey.get("x@1.0.0")!.label).toBe("release c@1.0.0");
    // without approval, allow_unreleased does not bring it back
    const reg2 = discover(cfg([], { roots: [written] }, true));
    expect(reg2.byKey.size).toBe(0);
    expect(reg2.sources.map((s) => s.label)).not.toContain("skills.roots[0]");
  });

  it("treats an unchanged package shared by two approved releases as one, not a duplicate", () => {
    const a1 = store("c", "1.0.0", { x: "1.0.0", y: "1.0.0" });
    const a2 = store("c", "1.1.0", { x: "1.1.0", y: "1.0.0" });
    const reg = discover(cfg([a1, a2]));
    expect(reg.problems.filter((p) => p.kind !== "lock")).toEqual([]);
    expect(reg.byKey.get("y@1.0.0")!.label).toBe("release c@1.1.0");
    expect(findSkill(reg, "y")!.active).toBe(true);
    expect(reg.byKey.has("x@1.0.0")).toBe(true);
  });

  it("keeps an old lock valid when the registry limits are crossed by newer releases", () => {
    const a1 = store("c", "1.0.0", { x: "1.0.0" });
    const a2 = store("c", "1.1.0", { x: "1.1.0", w: "1.0.0", v: "1.0.0" });
    const skills = cfg([a1, a2]);
    const reg = discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {}, limits: { skills: 1 } });
    expect(reg.problems.filter((p) => p.kind === "too-many")).toEqual([]);
    pin(reg, "x@1.0.0");
    const again = discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {}, limits: { skills: 1 } });
    expect(verifyRunSkillLock(lockOf("x", "1.0.0", again.byKey.get("x@1.0.0")!.digest), again)).toEqual([]);
  });

  it("reports a catalogue folder that cannot be read", () => {
    if (process.getuid?.() === 0) return;
    const a = store("c", "1.0.0", { x: "1.0.0" });
    store("d", "1.0.0", { y: "1.0.0" });
    const dir = join(home, "skill-releases", "c");
    chmodSync(dir, 0o000);
    try {
      const listing = listStoredReleases(home);
      expect(listing.unreadable).toBe(1);
      expect(listing.releases.map((r) => r.catalogue)).toEqual(["d"]);
      const reg = discover(cfg([a]));
      expect(reg.problems.find((p) => p.label === "release store")).toMatchObject({ kind: "root-refused" });
      expect(discover(cfg([])).notes.some((x) => x.kind === "release-store")).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("reports an unreadable store root", () => {
    if (process.getuid?.() === 0) return;
    store("c", "1.0.0", { x: "1.0.0" });
    const dir = join(home, "skill-releases");
    chmodSync(dir, 0o000);
    try {
      expect(listStoredReleases(home).refused).toBe("not readable, not scanned");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("works without a store", () => {
    const reg = discover(cfg([]));
    expect(reg.problems.filter((p) => p.kind !== "lock")).toEqual([]);
    expect(releaseStorePath(join(home, "other"), home)).toBe(false);
    expect(storeSources({ releases: [], hidden: 0, unreadable: 0 }, []).sources).toEqual([]);
  });
});

describe("scf skills with the release store", () => {
  const run = async (positionals: string[], skills: ReturnType<typeof cfg>) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals, values: {} }, (l) => void lines.push(l), { home, builtinRoot: builtin, userHome, env: {}, skills });
    return { code, lines };
  };

  it("prints a NOTE for an unapproved release and exits 0", async () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    store("c", "1.1.0", { x: "1.1.0" });
    const r = await run([], cfg([a]));
    expect(r.code).toBe(0);
    expect(r.lines).toContain('NOTE release c@1.1.0 is published but not in skills.releases.approved, so it is not loaded; see "scf skills release list".');
  });

  it("release list shows state, run locks and pin hints", async () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    store("c", "1.1.0", { x: "1.1.0" });
    const reg = discover(cfg([a]));
    const d = reg.byKey.get("x@1.0.0")!.digest;
    const runs = join(home, "runs");
    mkdirSync(join(runs, "r1"), { recursive: true });
    mkdirSync(join(runs, "r2"));
    mkdirSync(join(runs, "r3"));
    writeRunSkillLock(join(runs, "r1"), lockOf("x", "1.0.0", d));
    writeRunSkillLock(join(runs, "r3"), lockOf("x", "1.1.0", "sha256:" + "e".repeat(64)));
    writeFileSync(join(runs, "r2", "skill-lock.json"), "{ not json");
    const r = await run(["release", "list"], cfg([a]));
    expect(r.code).toBe(0);
    const text = r.lines.join("\n");
    expect(r.lines[0]).toMatch(/^RELEASE c@1\.1\.0 sha256:[0-9a-f]{64} unapproved 1 skill, not locked by any run$/);
    expect(r.lines[1]).toBe(`RELEASE c@1.0.0 ${(await run(["release", "list"], cfg([a]))).lines[1]!.split(" ")[2]} approved 1 skill, locked by 1 run`);
    expect(r.lines[2]).toBe(`PIN scf skills pin x@1.0.0 ${d}`);
    expect(r.lines.at(-1)).toBe("OK 2 releases");
    expect(text).not.toContain("x@1.1.0 sha256");
    expect(existsSync(join(home, "skill-releases", "c", "1.1.0"))).toBe(true);
  });

  it("release list: no PIN line once pinned, and an empty store", async () => {
    const a = store("c", "1.0.0", { x: "1.0.0" });
    pin(discover(cfg([a])), "x@1.0.0");
    const r = await run(["release", "list"], cfg([a]));
    expect(r.lines.some((l) => l.startsWith("PIN "))).toBe(false);
    rmSync(join(home, "skill-releases"), { recursive: true });
    const e = await run(["release", "list"], cfg([]));
    expect(e).toEqual({ code: 0, lines: ["No releases are published"] });
  });

  it("release list: a damaged release is invalid and a credential name is not shown", async () => {
    store("c", "1.0.0", { x: "1.0.0" });
    writeFileSync(join(home, "skill-releases", "c", "1.0.0", "x", "SKILL.md"), "changed");
    const secret = "sk-ant-" + "b".repeat(20);
    mkdirSync(join(home, "skill-releases", secret, "1.0.0"), { recursive: true });
    const r = await run(["release", "list"], cfg([]));
    expect(r.lines.some((l) => l.startsWith("RELEASE c@1.0.0 invalid: "))).toBe(true);
    expect(r.lines).toContain("RELEASE (name not shown) invalid: the folder name looks like a credential");
    expect(r.lines.join("\n")).not.toContain(secret);
  });

  it("release list does not say 'no releases' when a catalogue folder cannot be read", async () => {
    if (process.getuid?.() === 0) return;
    const a = store("c", "1.0.0", { x: "1.0.0" });
    const dir = join(home, "skill-releases", "c");
    chmodSync(dir, 0o000);
    try {
      const r = await run(["release", "list"], cfg([a]));
      expect(r.code).toBe(1);
      expect(r.lines.some((l) => l.startsWith("PROBLEM 1 catalogue folder"))).toBe(true);
      expect(r.lines).not.toContain("No releases are published");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("release list takes no operand", async () => {
    await expect(run(["release", "list", "extra"], cfg([]))).rejects.toThrow(/scf skills release/);
  });
});
