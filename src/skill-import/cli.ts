import { resolve } from "node:path";
import { prepareImport, SkillImportError, type RejectedSkill } from "../skills/import-plan.js";
import { publishImport } from "../skills/import-stage.js";
import { SKILL_ID_RE } from "../skills/schema.js";
import { readSources, shownValue, SOURCES_FILE } from "../skills/sources.js";
import { GitTreeError, openGitTree, type GitTreeErrorCode } from "./git-tree.js";

// `scf skills import <source-id> [<file>]`: fetches the approved commit of an enabled source and stages its skills
// into the quarantine. Prints checked fields only; git's own text never reaches the output.

export const IMPORT_USAGE = "usage: scf skills import <source-id> [<file>]";

export interface SkillImportOptions {
  cwd?: string;
  home?: string;
  /** Tests: a local repository used instead of the https address. */
  remote?: string;
  env?: NodeJS.ProcessEnv;
  open?: typeof openGitTree;
}

const syntax = (why: string) => new Error(`${why}\n${IMPORT_USAGE}`);
const INTERRUPTED = "PROBLEM the import was interrupted; nothing was staged";

function gitSentence(code: GitTreeErrorCode, key: string, commit: string): string {
  switch (code) {
    case "no-git":
      return "git was not found; install git and try again";
    case "fetch-failed":
      return `the commit could not be fetched from ${key}`;
    case "no-commit":
      return `the commit ${commit.slice(0, 12)} was not found in ${key}`;
    case "too-large":
      return "the repository is larger than 256 MiB; nothing was staged";
    case "timeout":
      return "git did not finish in 120 seconds; nothing was staged";
    case "interrupted":
      return "the import was interrupted; nothing was staged";
    case "bad-listing":
      return "the file list of the commit could not be read";
    case "read-failed":
      return "a file of the commit could not be read";
  }
}

const rejectedLines = (out: (line: string) => void, rejected: readonly RejectedSkill[]) => {
  for (const r of rejected) out(`REJECTED ${r.root}: ${r.reasons.join("; ")}`);
};

/** `scf skills import`. `positionals` are the operands after "import"; the syntax is checked before any read. */
export async function skillImportCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillImportOptions = {},
): Promise<number> {
  for (const [k, v] of Object.entries(args.values)) if (v !== undefined) throw syntax(`scf skills import: unexpected option --${k}`);
  const [id, file] = args.positionals;
  if (args.positionals.length < 1 || args.positionals.length > 2) throw syntax("scf skills import: expects a source id and at most one file");
  if (id === undefined || !SKILL_ID_RE.test(id)) throw syntax("scf skills import: the source id must be a lower-case slug");

  const read = readSources(resolve(opts.cwd ?? process.cwd(), file ?? SOURCES_FILE));
  if (read.state === "none") {
    out("PROBLEM the skill source file does not exist");
    return 1;
  }
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const source = read.manifest.sources.find((s) => s.id === id);
  if (!source) {
    out(`PROBLEM no source with the id ${id}`);
    return 1;
  }
  if (source.status !== "enabled") {
    out(`PROBLEM the source ${id} is ${source.status}; only an enabled source can be imported`);
    return 1;
  }
  const commit = source.ref.approved;
  if (commit === undefined) {
    out(`PROBLEM the source ${id} has no approved commit (ref.approved)`);
    return 1;
  }

  const aborter = new AbortController();
  const onSignal = () => aborter.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let prep: ReturnType<typeof prepareImport> | undefined;
    let failed: unknown;
    try {
      const tree = await (opts.open ?? openGitTree)(source, commit, { remote: opts.remote, env: opts.env, signal: aborter.signal });
      try {
        prep = prepareImport(source, tree);
      } finally {
        tree.close();
      }
    } catch (e) {
      failed = e;
    }
    if (failed !== undefined && !(failed instanceof GitTreeError) && !(failed instanceof SkillImportError)) throw failed;
    // A signal that came in while a synchronous git call ran is delivered by the next event-loop turns.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    if (aborter.signal.aborted) {
      out(INTERRUPTED);
      return 1;
    }
    try {
      if (failed !== undefined) throw failed;
      const done = publishImport(prep!, { home: opts.home });
      const rec = done.record;
      for (const s of rec.skills) out(`${shownValue(s.root).padEnd(40)} ${s.name} ${s.digest} ${s.files} files ${s.bytes} bytes`);
      rejectedLines(out, rec.rejected);
      out(`OK ${rec.skills.length} skills staged from ${rec.repositoryKey}@${rec.commit.slice(0, 12)} ${rec.digest} (${done.state})`);
      out(`Quarantine: ${done.dir}`);
      return rec.rejected.length > 0 ? 1 : 0;
    } catch (e) {
      if (e instanceof GitTreeError) {
        out(`PROBLEM ${gitSentence(e.code, source.repositoryKey, commit)}`);
        return 1;
      }
      if (e instanceof SkillImportError) {
        if (e.code === "nothing-staged") rejectedLines(out, e.rejected);
        out(`PROBLEM ${e.message}`);
        return 1;
      }
      throw e;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
