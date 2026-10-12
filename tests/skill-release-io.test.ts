import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";

vi.mock("../src/skills/package.js", async (orig) => {
  const real = await orig<typeof import("../src/skills/package.js")>();
  return {
    ...real,
    readRegular: (p: string, limit: number) => {
      if (p.endsWith("catalogue-release.json") && p.includes("broken")) throw Object.assign(new Error("secret detail"), { code: "EIO" });
      return real.readRegular(p, limit);
    },
  };
});

const { loadSkillPackage } = await import("../src/skills/package.js");
const { discoverSkills } = await import("../src/skills/registry.js");
const { readRelease, releaseDigest } = await import("../src/skills/release.js");

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pkg(root: string, id: string) {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
}

describe("a read error in a release manifest", () => {
  it("refuses only that source; the next one still loads", () => {
    const base = mkdtempSync(join(tmpdir(), "relio-"));
    tmps.push(base);
    const bad = join(base, "broken");
    const good = join(base, "good");
    pkg(bad, "a");
    writeFileSync(join(bad, "catalogue-release.json"), "{}");
    pkg(good, "b");
    const m = {
      schema: 1 as const,
      catalogue: "acme",
      version: "1.0.0",
      createdAt: "2026-01-02T03:04:05Z",
      source: { repository: "github.com/a/b", commit: "a".repeat(40) },
      skills: [{ id: "b", version: "1.0.0", digest: loadSkillPackage(join(good, "b")).digest }],
    };
    writeFileSync(join(good, "catalogue-release.json"), JSON.stringify(m));
    const home = join(base, "home");
    mkdirSync(home);
    const skills = ConfigSchema.parse({
      skills: { builtin: false, roots: [bad, good], releases: { approved: [{ catalogue: "acme", version: "1.0.0", digest: releaseDigest(m) }] } },
    }).skills;
    expect(readRelease(bad)).toEqual({ state: "invalid", reason: "cannot be read (EIO)" });
    const reg = discoverSkills(skills, { home, userHome: join(base, "u"), env: {} });
    expect(reg.skills.map((s) => s.key)).toEqual(["b@1.0.0"]);
    expect(reg.sources[1]).toMatchObject({ status: "refused", packages: 0 });
    expect(JSON.stringify(reg.problems)).not.toContain("secret detail");
  });
});
