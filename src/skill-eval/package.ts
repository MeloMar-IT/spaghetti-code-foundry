import { cpSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addSkillPins } from "../skills/lock.js";
import { normalizeSkill, type NormalizedSkill, type NormalizeOrigin } from "../skills/normalize.js";
import { scanSkill } from "../skills/scan.js";
import { foundryPackageFiles, loadSkillPackage, readRegular } from "../skills/package.js";
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
    mkdirSync(dir, { recursive: true });
    for (const f of foundryPackageFiles(pkg)) {
      const target = join(dir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
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

// ── A skill folder in a working tree (`scf skills effect skills/<name>`) ──

/** The origin of a skill read from a folder: it has no source and no commit. */
export const LOCAL_SKILL_ORIGIN: NormalizeOrigin = { source: "local", repository: "local", repositoryKey: "local", commit: "0".repeat(40) };

type Files = { path: string; content: Uint8Array }[];

/**
 * Reads a skill folder strictly: a link, a file that is not regular, a file over `fileBytes`, more than `files` files, a path over
 * `pathChars` or `pathSegments`, or a total over `totalBytes` is a problem, never skipped. All limits apply to the whole folder.
 */
export function readSkillFolder(dir: string): { files: Files; problems: string[] } {
  const L = SKILL_LIMITS;
  const files: Files = [];
  const problems: string[] = [];
  let total = 0;
  let count = 0;
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) problems.push(`${path} is a symbolic link`);
      else if (st.isDirectory()) walk(full, path);
      else if (!st.isFile()) problems.push(`${path} is not a regular file`);
      else if (path.length > L.pathChars || path.split("/").length > L.pathSegments) {
        problems.push(`path ${path.slice(0, 60)} is too long or too deep (at most ${L.pathChars} characters, ${L.pathSegments} parts)`);
      } else if (++count > L.files) {
        if (count === L.files + 1) problems.push(`more than ${L.files} files`);
      } else {
        const bytes = readRegular(full, L.fileBytes);
        if (bytes === "large") problems.push(`${path} is larger than ${L.fileBytes} bytes`);
        else if (typeof bytes === "string") problems.push(`${path} cannot be read (${bytes})`);
        else {
          total += bytes.length;
          files.push({ path, content: bytes });
        }
      }
    }
  };
  try {
    walk(dir, "");
  } catch {
    problems.push("the skill folder cannot be read");
  }
  if (total > L.totalBytes) problems.push(`the folder is larger than ${L.totalBytes} bytes in all`);
  return { files, problems };
}

/**
 * Operations knowledge names dangerous commands, system paths and installs: a runbook says when `DROP TABLE` or `rm -rf` is wrong.
 * In the Markdown of a local skill (written and reviewed in the skill library) such findings are notes. Scripts, data files and
 * fixtures stay strict, and so do the rules that never belong in a skill: secrets, prompt injection, telling the agent to skip a
 * safety check, obfuscation, payloads, a download run in a shell, a reverse shell and the upload of a credential file. The notes go
 * to the reviewer of the skill-write flow, who judges them.
 */
const DOCS_RULE_FAMILIES: readonly string[] = ["destructive-action", "path-escape", "hidden-dependency", "unsafe-network"];
const DOCS_STRICT_RULES: ReadonlySet<string> = new Set([
  "hidden-dependency.download-run", "unsafe-network.reverse-shell", "unsafe-network.upload-secret-file", "path-escape.file-path",
]);
export function describedInDocs(rule: string, path: string): boolean {
  if (!/\.md$/i.test(path) || path.startsWith("evals/")) return false;
  return DOCS_RULE_FAMILIES.includes(rule.split(".")[0]!) && !DOCS_STRICT_RULES.has(rule);
}

/**
 * readSkillFolder, then the scanner over ALL files (high and medium findings are problems, low ones and describedInDocs ones are notes;
 * never the matched text),
 * then `evals/**` is dropped and the rest normalized. The returned `files` are the complete folder.
 */
export function loadLocalSkill(dir: string, origin: NormalizeOrigin = LOCAL_SKILL_ORIGIN): { skill?: NormalizedSkill; files: Files; problems: string[]; notes: string[] } {
  const read = readSkillFolder(dir);
  const problems = [...read.problems];
  const notes: string[] = [];
  if (problems.length > 0) return { files: read.files, problems, notes };
  for (const f of scanSkill({ root: "skill", files: read.files }).findings) {
    const where = f.line ? `${f.path} line ${f.line}` : f.path;
    if (f.severity === "low" || describedInDocs(f.rule, f.path)) notes.push(`scan: ${f.rule} in ${where}`);
    else problems.push(`scan: ${f.rule} in ${where}`);
  }
  const kept = read.files.filter((f) => f.path !== "evals" && !f.path.startsWith("evals/"));
  const result = normalizeSkill(origin, { root: "skill", files: kept });
  if (!result.ok) for (const r of result.reasons) problems.push(`normalize: ${r}`);
  return { skill: result.ok ? result.skill : undefined, files: read.files, problems, notes };
}

/** Pins the arm's skill in the lock of the current data folder. Call it after `switchDataFolder`: it writes the arm's `skills.lock.json`. */
export function pinArmSkill(key: string, digest: string): void {
  addSkillPins([{ key, digest }]);
}
