import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { CANONICAL_REGISTRY_TIER } from "../src/skills/canonical-rules.js";
import { skillsCommand } from "../src/skills/cli.js";
import { SKILL_LOCK_FILE } from "../src/skills/lock.js";
import { clearSkillRegistryCache, discoverSkills, findSkill, selectSkill, SkillIntegrityError, type SkillRegistry } from "../src/skills/registry.js";
import type { ApprovedRelease } from "../src/skills/release.js";
import { rawPublicKey, signApproval } from "../src/skills/release-signature.js";
import { resolveSkills } from "../src/skills/resolve.js";
import { RunSkillLockSchema, buildRunSkillLock, planHashOf, verifyRunSkillLock } from "../src/skills/run-lock.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

let base: string;
let home: string;
let builtin: string;
let userHome: string;
let n = 0;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "skillcat-")));
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

function store(catalogue: string, version: string, skills: Record<string, string>): { approved: ApprovedRelease; dir: string } {
  const scratch = join(base, `scratch-${n++}`);
  for (const [id, v] of Object.entries(skills)) pkg(scratch, id, v);
  const { approved } = writeV2Release(scratch, { catalogue, version });
  const dir = join(home, "skill-releases", catalogue, version);
  mkdirSync(join(dir, ".."), { recursive: true });
  cpSync(scratch, dir, { recursive: true });
  return { approved, dir };
}

const cfg = (approved: ApprovedRelease[], over: Record<string, unknown> = {}, releases: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ skills: { roots: [], releases: { allow_unreleased: false, approved, ...releases }, ...over } }).skills;
const discover = (skills: ReturnType<typeof cfg>): SkillRegistry => discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {} });
const writePins = (pins: Record<string, string>) =>
  writeFileSync(join(home, SKILL_LOCK_FILE), JSON.stringify({ version: 1, pins: Object.fromEntries(Object.entries(pins).map(([k, digest]) => [k, { digest, pinnedAt: "2026-01-01T00:00:00Z" }])) }));
const lockOf = (digest: string, source: string) =>
  RunSkillLockSchema.parse({
    version: 1, runId: "r1", createdAt: "2026-01-01T00:00:00Z", planHash: "sha256:" + "d".repeat(64), estimatedTokens: 10,
    skills: [{ id: "x", version: "1.0.0", digest, source, role: "coder", selection: "requested", requiredBy: [], estimatedTokens: 10 }],
  });

describe("catalogue source", () => {
  it("registers an approved release as catalogue, pinned, with no lock file", () => {
    const { approved } = store("c", "1.0.0", { x: "1.0.0" });
    const reg = discover(cfg([approved]));
    expect(reg.byKey.get("x@1.0.0")).toMatchObject({ source: "catalogue", trust: "approved", pin: "pinned", label: "release c@1.0.0" });
    expect(selectSkill(reg, "x", "1.0.0").id).toBe("x");
    expect(resolveSkills(reg, ["x"]).selected.map((s) => s.id)).toEqual(["x"]);
    expect(existsSync(join(home, SKILL_LOCK_FILE))).toBe(false);
  });

  it("keeps a hand pin with another digest a mismatch, and the same digest pinned", () => {
    const { approved } = store("c", "1.0.0", { x: "1.0.0" });
    const digest = discover(cfg([approved])).byKey.get("x@1.0.0")!.digest;
    writePins({ "x@1.0.0": "sha256:" + "0".repeat(64) });
    const bad = discover(cfg([approved]));
    expect(bad.byKey.get("x@1.0.0")!.pin).toBe("mismatch");
    expect(bad.problems.find((p) => p.kind === "integrity")).toMatchObject({ source: "catalogue" });
    expect(() => selectSkill(bad, "x", "1.0.0")).toThrow(SkillIntegrityError);
    writePins({ "x@1.0.0": digest });
    expect(discover(cfg([approved])).byKey.get("x@1.0.0")!.pin).toBe("pinned");
  });

  it("leaves catalogue packages unverified when the lock cannot be read", () => {
    const { approved } = store("c", "1.0.0", { x: "1.0.0" });
    writeFileSync(join(home, SKILL_LOCK_FILE), "{ bad");
    expect(discover(cfg([approved])).byKey.get("x@1.0.0")!.pin).toBe("unverified");
  });

  it("keeps the data folder and skills.roots admin and unpinned; a data folder copy wins", () => {
    const { approved } = store("c", "1.0.0", { x: "1.0.0", y: "1.0.0" });
    const root = join(base, "root0");
    pkg(root, "z", "1.0.0");
    pkg(join(home, "skills"), "x", "1.0.0");
    const reg = discover(cfg([approved], { roots: [root] }, { allow_unreleased: true }));
    expect(reg.byKey.get("z@1.0.0")).toMatchObject({ source: "admin", pin: "unpinned" });
    expect(reg.byKey.get("y@1.0.0")).toMatchObject({ source: "catalogue", pin: "pinned" });
    expect(reg.byKey.get("x@1.0.0")).toMatchObject({ source: "admin", pin: "unpinned", label: "data folder" });
    expect(reg.problems.some((p) => p.kind === "duplicate" && p.source === "catalogue")).toBe(true);
  });

  it("adds no candidates from a refused release", () => {
    const wrong = store("c", "1.0.0", { x: "1.0.0" });
    const reg1 = discover(cfg([{ ...wrong.approved, digest: "sha256:" + "1".repeat(64) }]));
    expect(reg1.byKey.size).toBe(0);
    expect(buildSkillCatalogue(reg1).entries.filter((e) => e.id === "x")).toEqual([]);
    const tampered = store("d", "1.0.0", { x: "1.0.0" });
    writeFileSync(join(tampered.dir, "x", "SKILL.md"), "changed");
    const reg2 = discover(cfg([tampered.approved]));
    expect(reg2.byKey.size).toBe(0);
    expect(buildSkillCatalogue(reg2).entries.filter((e) => e.id === "x")).toEqual([]);
  });

  it("with keys, refuses an unsigned release and loads a signed one as catalogue", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { approved } = store("c", "1.0.0", { x: "1.0.0" });
    const keys = [{ id: "k1", ed25519: rawPublicKey(publicKey) }];
    expect(discover(cfg([approved], {}, { keys })).byKey.size).toBe(0);
    const signed = { ...approved, key: "k1", signature: signApproval(approved, privateKey) };
    expect(discover(cfg([signed], {}, { keys })).byKey.get("x@1.0.0")).toMatchObject({ source: "catalogue", pin: "pinned" });
  });

  it("writes catalogue to the run lock and still accepts admin and catalogue entries", () => {
    const { approved } = store("c", "1.0.0", { x: "1.0.0" });
    const reg = discover(cfg([approved]));
    const digest = reg.byKey.get("x@1.0.0")!.digest;
    const request = { version: 1 as const, skills: [{ id: "x", reason: "Needed", evidence: ["catalogue:x"] }] };
    const built = buildRunSkillLock({ runId: "r1", resolution: resolveSkills(reg, ["x"]), request, sourceOf: () => "catalogue", planHash: planHashOf("p") });
    expect(built.skills[0]!.source).toBe("catalogue");
    for (const source of ["admin", "catalogue"]) expect(verifyRunSkillLock(lockOf(digest, source), reg)).toEqual([]);
    expect(() => lockOf(digest, "repository")).toThrow();
  });

  it("verifies a run lock after a newer release is approved", () => {
    const a1 = store("c", "1.0.0", { x: "1.0.0" }).approved;
    const old = lockOf(discover(cfg([a1])).byKey.get("x@1.0.0")!.digest, "catalogue");
    const a2 = store("c", "1.1.0", { x: "1.1.0" }).approved;
    const reg = discover(cfg([a1, a2]));
    expect(verifyRunSkillLock(old, reg)).toEqual([]);
    expect(findSkill(reg, "x")!.version).toBe("1.1.0");
    expect(reg.byKey.get("x@1.0.0")!.pin).toBe("pinned");
    expect(reg.byKey.get("x@1.1.0")!.pin).toBe("pinned");
  });

  it("shows the source in scf skills", async () => {
    const { approved } = store("c", "1.0.0", { x: "1.0.0" });
    const lines: string[] = [];
    await skillsCommand({ positionals: [], values: {} }, (l) => void lines.push(l), { home, builtinRoot: builtin, userHome, env: {}, skills: cfg([approved]) });
    expect(lines.find((l) => l.startsWith("x "))).toContain("] catalogue approved pinned sha256:");
  });

  it("ranks catalogue with built-ins and keeps admin local", () => {
    expect(CANONICAL_REGISTRY_TIER.catalogue).toBe("scf-curated");
    expect(CANONICAL_REGISTRY_TIER.admin).toBe("local");
  });
});
