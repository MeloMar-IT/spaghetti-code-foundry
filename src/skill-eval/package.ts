import { cpSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { addSkillPins } from "../skills/lock.js";
import type { NormalizedSkill } from "../skills/normalize.js";
import { loadSkillPackage, readRegular } from "../skills/package.js";
import type { RegisteredSkill } from "../skills/registry.js";
import { SKILL_LIMITS } from "../skills/schema.js";

// The skill folder of one evaluation arm (run.ts): the candidate written as a Foundry package, or a baseline copied unchanged.
// The folders are made in a temporary data folder the caller owns; nothing here touches the real data folder.

const problemOf = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0]! : "cannot be loaded").slice(0, 200);

/**
 * Writes the candidate as a Foundry package (`<skillsDir>/<id>/`, `id` as the SKILL.md name). The import's `extraFiles` are left out:
 * a Foundry package may not have them, so this digest differs from the import digest. Loads the folder again and returns its digest.
 */
export function writeCandidatePackage(skill: NormalizedSkill, skillsDir: string): { dir: string; digest: string } | { problem: string } {
  const pkg = skill.package;
  const dir = join(skillsDir, pkg.id);
  try {
    const front: Record<string, unknown> = { name: pkg.id, description: pkg.description };
    if (pkg.license !== undefined) front.license = pkg.license;
    if (pkg.compatibility !== undefined) front.compatibility = pkg.compatibility;
    if (pkg.metadata !== undefined) front.metadata = pkg.metadata;
    if (pkg.allowedTools !== undefined) front["allowed-tools"] = pkg.allowedTools;
    const manifest: Record<string, unknown> = {
      id: pkg.id,
      version: pkg.version,
      category: pkg.category,
      capabilities: pkg.capabilities,
      ...(pkg.detectors.length ? { detectors: pkg.detectors } : {}),
      ...(pkg.roles.length ? { roles: pkg.roles } : {}),
      dependencies: pkg.dependencies,
      conflicts: pkg.conflicts,
      connectors: pkg.connectors,
      tool_profile: pkg.tool_profile,
      risk: pkg.risk,
      ...(pkg.provider ? { provider: pkg.provider } : {}),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${stringify(front)}---\n\n${pkg.instructions}\n`);
    writeFileSync(join(dir, "skill.yaml"), stringify(manifest));
    if (pkg.review !== undefined) writeFileSync(join(dir, "REVIEW.md"), `${pkg.review}\n`);
    for (const list of Object.values(pkg.files)) {
      for (const f of list) {
        const target = join(dir, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content);
      }
    }
    const loaded = loadSkillPackage(dir);
    if (loaded.id !== pkg.id || loaded.version !== pkg.version) return { problem: `${pkg.id}@${pkg.version}: the written package has another id or version` };
    return { dir, digest: loaded.digest };
  } catch (e) {
    return { problem: `${pkg.id}@${pkg.version}: the package cannot be written (${problemOf(e)})` };
  }
}

/** Copies an approved skill unchanged into `<skillsDir>/<id>/` and checks that the copy has the same digest. */
export function copyBaselinePackage(b: RegisteredSkill, skillsDir: string): { dir: string } | { problem: string } {
  const dir = join(skillsDir, b.id);
  try {
    mkdirSync(skillsDir, { recursive: true });
    cpSync(b.dir, dir, { recursive: true, verbatimSymlinks: true });
    if (loadSkillPackage(dir).digest !== b.digest) return { problem: `${b.key}: the copy does not match its digest` };
    return { dir };
  } catch (e) {
    return { problem: `${b.key}: the copy cannot be made (${problemOf(e)})` };
  }
}

const SCAN_DEPTH = 8;
const SCAN_NODES = 2000;

/** The files of a package folder for the scanner: a bounded walk; links and files that are not regular are left out. */
export function packageScanFiles(dir: string): { path: string; content: Uint8Array }[] {
  const out: { path: string; content: Uint8Array }[] = [];
  let nodes = 0;
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > SCAN_DEPTH) return;
    for (const name of readdirSync(abs).sort()) {
      if (++nodes > SCAN_NODES) return;
      const full = join(abs, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, path, depth + 1);
      else if (st.isFile()) {
        const bytes = readRegular(full, SKILL_LIMITS.fileBytes);
        if (typeof bytes !== "string") out.push({ path, content: bytes });
      }
    }
  };
  walk(dir, "", 0);
  return out;
}

/** Pins the arm's skill in the lock of the current data folder. Call it after `switchDataFolder`: it writes the arm's `skills.lock.json`. */
export function pinArmSkill(key: string, digest: string): void {
  addSkillPins([{ key, digest }]);
}
