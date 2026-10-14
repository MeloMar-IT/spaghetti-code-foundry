import { resolve } from "node:path";
import { credentialProblem } from "./credential-scan.js";
import type { ImportRecord } from "./import-plan.js";
import { readStagedImport } from "./import-stage.js";
import { readSources, shownValue, SOURCES_FILE, type SkillLibrarySource } from "./sources.js";

// Reads a staged import for the offline skill commands (scan, assess, promote check, review). Read-only.

/** Free text from a record is printed only when it holds no credential. */
export const hidden = (s: string): string => (credentialProblem(s) ? "(hidden)" : s);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type StagedOk = Extract<ReturnType<typeof readStagedImport>, { state: "ok" }>;
export interface StagedImport { source: SkillLibrarySource; commit: string; record: ImportRecord; files: Map<string, Uint8Array>; licence: StagedOk["licence"] }

/**
 * Finds the source, checks its approved commit, reads the staged import and proves it matches import.json. Prints a PROBLEM and
 * returns undefined when it cannot. `between` runs after the source is found and before the staged import is read; false stops
 * (it has printed its own PROBLEM).
 */
export function stagedImport(id: string, out: (line: string) => void, opts: { cwd: string; home?: string }, between?: () => boolean, done = "scanned"): StagedImport | undefined {
  const problem = (text: string): undefined => {
    out(`PROBLEM ${text}`);
    return undefined;
  };
  const sources = readSources(resolve(opts.cwd, SOURCES_FILE));
  if (sources.state === "none") return problem("the skill source file does not exist");
  if (sources.state === "invalid") {
    for (const p of sources.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return undefined;
  }
  const source = sources.manifest.sources.find((s) => s.id === id);
  if (!source) return problem(`unknown source ${shownValue(id)}`);
  const commit = source.ref.approved;
  if (!commit) return problem(`source ${source.id} has no approved commit (ref.approved)`);
  if (between && !between()) return undefined;

  const staged = readStagedImport(source.id, commit, { home: opts.home });
  if (staged.state === "none") return problem(`no staged import of ${source.id} at ${commit.slice(0, 12)}; run "scf skills import ${source.id}" first`);
  if (staged.state === "invalid") return problem(`the staged import does not match import.json: ${staged.problem}; nothing was ${done}`);
  if (staged.record.repositoryKey !== source.repositoryKey) return problem(`the staged import is from another repository; nothing was ${done}`);
  return { source, commit, record: staged.record, files: staged.files, licence: staged.licence };
}

/** The files of one skill, with paths relative to its root. */
export function filesOf(root: string, files: ReadonlyMap<string, Uint8Array>): { path: string; content: Uint8Array }[] {
  const mine: { path: string; content: Uint8Array }[] = [];
  for (const [path, content] of files) {
    if (root === "." || path === root || path.startsWith(root + "/")) mine.push({ path: root === "." ? path : path.slice(root.length + 1), content });
  }
  return mine;
}
