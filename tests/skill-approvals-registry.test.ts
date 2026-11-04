import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { approvalsPath, updateSourceApprovals } from "../src/skills/approvals.js";
import { skillsCommand } from "../src/skills/cli.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import type { ApprovedRelease } from "../src/skills/release.js";
import { rawPublicKey, signApproval, type ReleaseKey } from "../src/skills/release-signature.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

// Releases approved in the data folder (skill-approvals.json) next to skills.releases.approved.

let base: string;
let home: string;
let builtin: string;
let userHome: string;
let n = 0;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "skillappr-")));
  home = join(base, "home");
  builtin = join(base, "builtin");
  userHome = join(base, "user");
  for (const d of [home, builtin, userHome]) mkdirSync(d);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearSkillRegistryCache();
});

function store(catalogue: string, version: string, skill = "alpha"): { dir: string; approved: ApprovedRelease } {
  const scratch = join(base, `scratch-${n++}`);
  const d = join(scratch, skill);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${skill}\ndescription: A test skill called ${skill}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${skill}\nversion: ${version}\n`);
  const { approved } = writeV2Release(scratch, { catalogue, version });
  const dest = join(home, "skill-releases", catalogue, version);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(scratch, dest, { recursive: true });
  return { dir: dest, approved };
}
const approveInStore = (a: ApprovedRelease): void => {
  updateSourceApprovals(
    (cur) => {
      const s = cur.src ?? { repositoryKey: "github.com/acme/skills", releases: [] };
      s.releases.push({ ...a, at: "2026-01-01T00:00:00Z" } as never);
      cur.src = s;
      return cur;
    },
    { home },
  );
};
const cfg = (approved: ApprovedRelease[], keys: ReleaseKey[] = [], allow = false) =>
  ConfigSchema.parse({ skills: { roots: [], releases: { allow_unreleased: allow, approved, keys } } }).skills;
const discover = (skills: ReturnType<typeof cfg>) => discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {} });
const run = async (args: string[], skills: ReturnType<typeof cfg>) => {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["release", ...args], values: {} }, (l) => lines.push(l), { home, skills, cwd: base, builtinRoot: builtin, userHome, env: {} });
  return { code, lines };
};

describe("a release approved only in the data folder", () => {
  it("loads from the catalogue source", () => {
    const { approved } = store("acme", "1.0.0");
    approveInStore(approved);
    const reg = discover(cfg([]));
    expect(reg.byKey.has("alpha@1.0.0")).toBe(true);
    expect(reg.byKey.get("alpha@1.0.0")!.source).toBe("catalogue");
    expect(reg.problems).toEqual([]);
  });

  it("is not loaded without the approval", () => {
    store("acme", "1.0.0");
    expect(discover(cfg([])).byKey.size).toBe(0);
  });

  it("is root-missing when the release folder is gone", () => {
    const { dir, approved } = store("acme", "1.0.0");
    approveInStore(approved);
    rmSync(dir, { recursive: true });
    expect(discover(cfg([])).problems.some((p) => p.kind === "root-missing")).toBe(true);
  });

  it("an unreadable file is a problem while config entries still load", () => {
    const { approved } = store("acme", "1.0.0");
    writeFileSync(approvalsPath(home), "{");
    const reg = discover(cfg([approved]));
    expect(reg.byKey.has("alpha@1.0.0")).toBe(true);
    expect(reg.problems.some((p) => p.kind === "root-unreadable" && p.reason.includes("skill-approvals.json"))).toBe(true);
  });
});

describe("signatures", () => {
  const k1 = generateKeyPairSync("ed25519").privateKey;
  const keys: ReleaseKey[] = [{ id: "k1", ed25519: rawPublicKey(k1) }];
  it("an unsigned entry is refused", () => {
    const { approved } = store("acme", "1.0.0");
    approveInStore(approved);
    const reg = discover(cfg([], keys));
    expect(reg.byKey.size).toBe(0);
    expect(reg.problems.some((p) => p.kind === "root-refused" && p.reason.includes("not signed by a trusted key"))).toBe(true);
  });
  it("a bad signature is refused", () => {
    const { approved } = store("acme", "1.0.0");
    approveInStore({ ...approved, key: "k1", signature: Buffer.alloc(64, 2).toString("base64") });
    const reg = discover(cfg([], keys));
    expect(reg.byKey.size).toBe(0);
    expect(reg.problems.some((p) => p.reason.includes("signature does not verify"))).toBe(true);
  });
  it("a valid signature loads, and list and verify show it", async () => {
    const { dir, approved } = store("acme", "1.0.0");
    approveInStore({ ...approved, key: "k1", signature: signApproval(approved, k1) });
    const skills = cfg([], keys);
    expect(discover(skills).byKey.has("alpha@1.0.0")).toBe(true);
    const list = await run(["list"], skills);
    expect(list.code).toBe(0);
    expect(list.lines.join("\n")).toMatch(/approved.*SIGNED k1/);
    const verify = await run(["verify", dir], skills);
    expect(verify.lines.join("\n")).toContain("APPROVED SIGNED k1");
  });
});

describe("a conflict between the config and the data folder", () => {
  it("is refused in the store and in an administrator root with allow_unreleased, and listed", async () => {
    const { dir, approved } = store("acme", "1.0.0");
    const other = { ...approved, digest: `sha256:${"e".repeat(64)}` };
    approveInStore(other);
    const skills = cfg([approved], [], true);
    const reg = discover(skills);
    expect(reg.byKey.size).toBe(0);
    expect(reg.problems.some((p) => p.kind === "root-refused" && p.reason.includes("different digests"))).toBe(true);

    const root = join(base, "admin");
    cpSync(dir, root, { recursive: true });
    const withRoot = ConfigSchema.parse({ skills: { roots: [root], releases: { allow_unreleased: true, approved: [approved] } } }).skills;
    const reg2 = discover(withRoot);
    expect([...reg2.byKey.keys()]).toEqual([]);
    expect(reg2.problems.filter((p) => p.reason.includes("different digests")).length).toBeGreaterThan(0);

    const list = await run(["list"], skills);
    expect(list.code).toBe(1);
    expect(list.lines.some((l) => l.startsWith("PROBLEM acme@1.0.0 is approved with different digests"))).toBe(true);
  });
});

describe("scf skills sources check", () => {
  it("shows auto and the ref from the data folder", async () => {
    const file = join(base, "skill-sources.yaml");
    const c1 = "0123456789abcdef0123456789abcdef01234567";
    const c2 = "fedcba9876543210fedcba9876543210fedcba98";
    writeFileSync(
      file,
      `schema: 1\nsources:\n  - id: s1\n    repository: https://github.com/acme/skills\n    status: enabled\n    ref: {track: main, approved: ${c1}}\n    paths: [skills]\n    adapter: agent-skills\n    trust: first-party\n    licence: {allow: [MIT]}\n    update: {cadence: weekly, auto: true}\n    owner: '@octocat'\n`,
    );
    updateSourceApprovals(() => ({ s1: { repositoryKey: "github.com/acme/skills", ref: { approved: c2, at: "2026-01-01T00:00:00Z" }, releases: [] } }), { home });
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["sources", "check", file], values: {} }, (l) => lines.push(l), { home, cwd: base, skills: cfg([]), builtinRoot: builtin, userHome, env: {} });
    expect(code).toBe(0);
    expect(lines[0]).toContain(c2.slice(0, 12));
    expect(lines[0]).toContain(" auto (approved in the data folder)");
  });
});
