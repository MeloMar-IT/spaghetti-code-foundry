import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { reviewFailed, reviewImport, reviewLines, reviewMarkdown, reviewProblemsMarkdown, type ExistingSkill, type ImportReview } from "./import-review.js";
import { readRegular, skillDigest } from "./package.js";
import { discoverSkills, type DiscoverOptions } from "./registry.js";
import { SKILL_LIMITS } from "./schema.js";
import { hidden, stagedImport, type StagedImport } from "./staged-import.js";

// `scf skills review`: reads the sources file, the staged import and the registered skills. Writes nothing.

export interface ReviewCommandOptions {
  cwd: string;
  home?: string;
  markdown: boolean;
  skills?: Config["skills"];
  discover?: DiscoverOptions;
}

/** The files `skillDigest` covers for one registered skill, or undefined when they cannot be read or no longer match. */
function filesOfRegistered(dir: string, folders: readonly { path: string; content: Uint8Array }[], digest: string): { path: string; content: Uint8Array }[] | undefined {
  const files: { path: string; content: Uint8Array }[] = [];
  for (const [name, limit, optional] of [["SKILL.md", SKILL_LIMITS.skillMdBytes, false], ["skill.yaml", SKILL_LIMITS.manifestBytes, false], ["REVIEW.md", SKILL_LIMITS.reviewMdBytes, true]] as const) {
    const r = readRegular(join(dir, name), limit);
    if (typeof r === "string") {
      if (optional && r === "other") continue;
      return undefined;
    }
    files.push({ path: name, content: r });
  }
  files.push(...folders);
  return skillDigest(files) === digest ? files : undefined;
}

/** The review of a staged import against the built-in and administrator skills. Reads only; writes nothing. */
export function reviewStaged(staged: StagedImport, opts: Pick<ReviewCommandOptions, "home" | "skills" | "discover">): ImportReview {
  const { source, record, files } = staged;

  // The repository is never read: only built-in and administrator skills are compared.
  const reg = discoverSkills(opts.skills ?? loadConfig().skills, { ...opts.discover, home: opts.home, repo: undefined });
  const problems: string[] = [];
  for (const p of reg.problems) {
    if (p.kind === "lock" || p.kind === "integrity") continue;
    problems.push(hidden(`existing skills (${p.label}${p.package ? "/" + p.package : ""}): ${p.reason}`));
  }
  // Every registered version, also a shadowed one: an import can mirror any of them.
  const existing: ExistingSkill[] = [];
  for (const s of reg.skills) {
    if (s.source !== "builtin" && s.source !== "admin") continue;
    const read = filesOfRegistered(s.dir, Object.values(s.pkg.files).flat(), s.digest);
    if (!read) problems.push(hidden(`existing skill ${s.key} (${s.label}) changed while it was read; it was not compared`));
    else existing.push({ skill: s, files: read });
  }

  return reviewImport({
    source,
    record,
    files,
    evidence: staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] },
    existing,
    problems,
  });
}

/** Returns 1 when the review failed or a PROBLEM was printed. */
export function reviewCommand(id: string, out: (line: string) => void, opts: ReviewCommandOptions): number {
  const printed: string[] = [];
  const staged = stagedImport(id, opts.markdown ? (l) => void printed.push(l) : out, opts, undefined, "reviewed");
  if (!staged) {
    if (opts.markdown) for (const l of reviewProblemsMarkdown(id, printed).replace(/\n$/, "").split("\n")) out(l);
    return 1;
  }
  const review = reviewStaged(staged, opts);
  const lines = opts.markdown ? reviewMarkdown(review).replace(/\n$/, "").split("\n") : reviewLines(review);
  for (const l of lines) out(l);
  return reviewFailed(review) ? 1 : 0;
}
