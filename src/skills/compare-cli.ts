import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OVERRIDES_FILE } from "./choice-rules.js";
import { planSkillChoices } from "./choices.js";
import { compareFailed, compareLines, compareWithBuiltins, type BuiltinSkill } from "./compare.js";
import { COMPARE_BUILTINS } from "./community-rules.js";
import { SkillImportError, type ImportRecord } from "./import-plan.js";
import { normalizeImport } from "./normalize.js";
import { loadSkillPackage, readRegular } from "./package.js";
import { readChoiceFile } from "./project-pins.js";
import { BUILTIN_SKILLS } from "./registry.js";
import { UNRESOLVED_HIGH_RISK_DEFAULT } from "./resolve-rules.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";

type FileEntry = { path: string; content: Uint8Array };

const FILE_LIMIT = 4 * 1048576;
const FILES_MAX = 500;

/** Every regular file below `dir`, with its original bytes. Links and other entries are left out. */
function readTree(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (abs: string, rel: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length > FILES_MAX) return;
      const path = rel ? `${rel}/${d.name}` : d.name;
      const full = join(abs, d.name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, path);
      else if (st.isFile()) {
        const r = readRegular(full, FILE_LIMIT);
        if (typeof r !== "string") out.push({ path, content: r });
      }
    }
  };
  walk(dir, "");
  return out;
}

class BuiltinReadError extends Error {
  constructor(readonly id: string) {
    super(`the built-in skill ${id} cannot be read`);
  }
}

/** The built-in skills to compare with, straight from their folders: no configuration, data folder or lock file is read. */
export function loadBuiltins(root: string): BuiltinSkill[] {
  const skills: BuiltinSkill[] = [];
  for (const id of COMPARE_BUILTINS) {
    const dir = join(root, id);
    try {
      const pkg = loadSkillPackage(dir);
      const key = `${pkg.id}@${pkg.version}`;
      skills.push({ key, id: pkg.id, version: pkg.version, source: "builtin", label: "built-in", dir, active: true, trust: "builtin", pin: "unpinned", digest: pkg.digest, pkg, files: readTree(dir) });
    } catch {
      throw new BuiltinReadError(id);
    }
  }
  return skills;
}

/**
 * `scf skills compare`, after the staged import was read and proven: normalizes it, compares it with the built-in java and
 * spring-boot skills and prints the report. Reads only. Returns 1 for a conflict, a blocking collision or a PROBLEM.
 */
export function compareStaged(
  staged: { source: SkillLibrarySource; commit: string; record: ImportRecord; files: ReadonlyMap<string, Uint8Array> },
  out: (line: string) => void,
  opts: { cwd: string; now: Date; builtinRoot?: string },
): number {
  const { source, record, files } = staged;

  let builtins: BuiltinSkill[];
  try {
    builtins = loadBuiltins(opts.builtinRoot ?? BUILTIN_SKILLS);
  } catch (e) {
    if (!(e instanceof BuiltinReadError)) throw e;
    out(`PROBLEM ${e.message}`);
    return 1;
  }

  const read = readChoiceFile(resolve(opts.cwd, OVERRIDES_FILE), "overrides");
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const exclusive = [...new Set(builtins.flatMap((s) => s.pkg.capabilities ?? []))];
  // No repository is given, so only the overrides of scope all apply.
  const overrides = read.state === "ok" ? planSkillChoices({ overrides: read.items, now: opts.now, exclusive }).overrides : {};

  try {
    const { skills, report: norm } = normalizeImport({ record: { ...record, rejected: [] }, files });
    const report = compareWithBuiltins({
      source, skills, builtins, overrides, highRisk: UNRESOLVED_HIGH_RISK_DEFAULT,
    });
    for (const line of compareLines(report, norm.quarantined)) out(line);
    return compareFailed(report) ? 1 : 0;
  } catch (e) {
    if (e instanceof SkillImportError) {
      out(`PROBLEM ${shownValue(e.message)}`);
      return 1;
    }
    throw e;
  }
}
