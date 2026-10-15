import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SOURCE_CONNECTORS, connectorSource } from "../skills/connectors.js";
import { reviewLines } from "../skills/import-review.js";
import { readStagedImport } from "../skills/import-stage.js";
import { reviewStaged } from "../skills/review-cli.js";
import { sourceChangeLine, type SourceChange } from "../skills/source-change.js";
import type { ImportGates } from "../skills/source-update.js";
import { changesSince, newImportGates } from "./update-changes.js";
import { SKILL_ID_RE } from "../skills/schema.js";
import { addConnectorEntry, changeApproved, checkEdit, communityReview, updateBranch, updatePullRequest } from "../skills/source-update.js";
import { OWNER_RE, readSources, shownValue, SOURCES_FILE, type SkillLibrarySource, type SourceReview } from "../skills/sources.js";
import {
  CatalogueError,
  commitFile,
  createPullRequest,
  defaultBranch,
  deleteOwnBranch,
  fetchBase,
  openPullRequest,
  originRepo,
  pushNewBranch,
  readBlob,
  showPrefix,
  type CatalogueContext,
  type CatalogueErrorCode,
} from "./catalogue-git.js";
import { stageSource, type SkillImportOptions } from "./cli.js";
import { LsRemoteError, resolveHead, resolveTrack, type TrackResult } from "./ls-remote.js";

// `scf skills update <source-id>`: finds the upstream commit, stages it in the quarantine with the checks of `scf skills import`,
// builds the review report and opens a pull request that changes only skill-sources.yaml. Nothing is approved until the pull
// request is merged, and nothing is promoted. Prints checked fields and fixed sentences only; the text of git and gh never
// reaches the output.

export const UPDATE_USAGE = "usage: scf skills update <source-id> [--owner <@user>] [--reviewer <@user>] [--licence <id>]";

export interface SkillUpdateOptions extends Omit<SkillImportOptions, "cwd"> {
  cwd?: string;
  /** Tests: reads the upstream commit of a branch or tag (no track: HEAD). */
  resolve?: (repository: string, track: string | undefined, o: { signal: AbortSignal; remote?: string; env?: NodeJS.ProcessEnv }) => Promise<TrackResult>;
}

const syntax = (why: string) => new Error(`${why}\n${UPDATE_USAGE}`);
const NOTHING = "nothing was proposed";
const INTERRUPTED = `PROBLEM the update was interrupted; ${NOTHING}`;

class Interrupted extends Error {}

const defaultResolve: NonNullable<SkillUpdateOptions["resolve"]> = async (repository, track, o) =>
  track === undefined ? { commit: await resolveHead(repository, o) } : resolveTrack(repository, track, o);

function resolverSentence(code: LsRemoteError["code"], key: string): string {
  switch (code) {
    case "no-git":
      return "git was not found; install git and try again";
    case "unreachable":
      return `the upstream repository ${key} could not be reached; ${NOTHING}`;
    case "timeout":
      return `git did not answer in 20 seconds; ${NOTHING}`;
    case "interrupted":
      return `the update was interrupted; ${NOTHING}`;
    case "bad-answer":
      return `the answer of the upstream repository could not be read; ${NOTHING}`;
  }
}

function catalogueSentence(code: CatalogueErrorCode, gh: "list" | "create" = "list"): string {
  switch (code) {
    case "no-git":
      return "git was not found; install git and try again";
    case "not-a-repository":
      return "this folder is not in a git work tree; run the command in a clone of the catalogue repository";
    case "no-origin":
      return "this clone has no remote named origin";
    case "no-default-branch":
      return "the default branch of origin is not known; run: git remote set-head origin --auto";
    case "fetch-failed":
      return `the default branch could not be fetched from origin; ${NOTHING}`;
    case "read-failed":
      return `skill-sources.yaml could not be read from origin; ${NOTHING}`;
    case "commit-failed":
      return `the commit of the proposal could not be made; ${NOTHING}`;
    case "push-failed":
      return "the branch could not be pushed to origin; no pull request was opened";
    case "delete-failed":
      return "the branch on origin could not be checked";
    case "no-gh":
      return "gh was not found; install the GitHub CLI and try again";
    case "gh-failed":
      return gh === "list" ? `the open pull requests could not be listed with gh; ${NOTHING}` : "gh could not open the pull request";
    case "timeout":
      return "git or gh did not finish in 120 seconds";
  }
}

const sameBytes = (a: Buffer | undefined, b: Buffer | undefined) => (a === undefined || b === undefined ? a === b : a.equals(b));

/** The bytes of the file in the working copy, undefined when there is none; a link or another kind of file is "unreadable". */
function workingFile(path: string): Buffer | undefined | "unreadable" {
  try {
    const st = lstatSync(path);
    return st.isFile() ? readFileSync(path) : "unreadable";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
  }
}

/** `scf skills update`. `positionals` are the operands after "update"; the syntax is checked before anything is read. */
export async function skillUpdateCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillUpdateOptions = {},
): Promise<number> {
  const { owner, reviewer, licence, ...rest } = args.values;
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) throw syntax(`scf skills update: unexpected option --${k}`);
  const [id] = args.positionals;
  if (args.positionals.length !== 1 || id === undefined) throw syntax("scf skills update: expects one source id");
  if (!SKILL_ID_RE.test(id)) throw syntax("scf skills update: the source id must be a lower-case slug");
  for (const [name, v] of [["owner", owner], ["reviewer", reviewer], ["licence", licence]] as const) {
    if (v !== undefined && (typeof v !== "string" || v === "")) throw syntax(`scf skills update: --${name} needs a value`);
  }
  if (typeof owner === "string" && !OWNER_RE.test(owner)) throw syntax("scf skills update: --owner must be a GitHub user or team like @octocat or @acme/skills");
  if (typeof reviewer === "string" && !OWNER_RE.test(reviewer)) throw syntax("scf skills update: --reviewer must be a GitHub user or team like @octocat or @acme/skills");

  const aborter = new AbortController();
  const onSignal = () => aborter.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await run(id, { owner, reviewer, licence } as { owner?: string; reviewer?: string; licence?: string }, out, opts, aborter.signal);
  } catch (e) {
    if (e instanceof Interrupted) {
      out(INTERRUPTED);
      return 1;
    }
    if (e instanceof CatalogueError) {
      out(`PROBLEM ${catalogueSentence(e.code)}`);
      return 1;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function run(
  id: string,
  given: { owner?: string; reviewer?: string; licence?: string },
  out: (line: string) => void,
  opts: SkillUpdateOptions,
  signal: AbortSignal,
): Promise<number> {
  const problem = (text: string): number => {
    out(`PROBLEM ${text}`);
    return 1;
  };
  // A signal that came in while a synchronous call ran is delivered by the next event-loop turns.
  const tick = async () => {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    if (signal.aborted) throw new Interrupted();
  };
  const cwd = resolve(opts.cwd ?? process.cwd());
  const ctx: CatalogueContext = { cwd, env: opts.env ?? process.env };
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);

  const prefix = showPrefix(ctx);
  await tick();
  const repo = originRepo(ctx);
  await tick();
  if (repo === undefined) return problem("the address of origin is not a GitHub repository address; the pull request needs it");

  const file = resolve(cwd, SOURCES_FILE);
  const read = readSources(file, undefined, today);
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const sources = read.state === "ok" ? read.manifest.sources : [];
  const existing = sources.find((s) => s.id === id);
  const connector = existing ? undefined : SOURCE_CONNECTORS.find((c) => c.id === id);

  if (existing) {
    if (existing.status !== "enabled") return problem(`the source ${id} is ${existing.status}; only an enabled source can be updated`);
    if (given.owner !== undefined) return problem(`--owner is only for a connector that has no entry yet; ${id} already has one`);
  } else if (connector) {
    if (given.owner === undefined) return problem(`the connector ${id} has no entry yet; give --owner <@user> for the new entry`);
    const used = sources.find((s) => s.repositoryKey === connector.repositoryKey);
    if (used) return problem(`the repository of the connector ${id} is already used by the source ${used.id}; update that source`);
  } else {
    return problem(`no source and no connector with the id ${shownValue(id)}`);
  }

  // The shape of the entry as it will be, with a stand-in commit. Option mistakes end here, before any network call. A missing
  // --reviewer waits: UNCHANGED and an open pull request need no review, only a new proposal does.
  const shape: SkillLibrarySource = existing ?? connectorSource(connector!, { commit: "0".repeat(40), owner: given.owner! });
  const early = communityReview(shape, { commit: "0".repeat(40), reviewer: given.reviewer, licence: given.licence, today });
  const needsReview = shape.status === "enabled" && shape.trust === "community";
  if ("problem" in early && (!needsReview || given.reviewer !== undefined)) return problem(early.problem);

  const repository = shape.repository;
  const track = existing ? existing.ref.track : connector!.track;
  let found: TrackResult;
  try {
    found = await (opts.resolve ?? defaultResolve)(repository, track, { signal, remote: opts.remote, env: opts.env });
  } catch (e) {
    if (e instanceof LsRemoteError) return problem(resolverSentence(e.code, shape.repositoryKey));
    throw e;
  }
  await tick();
  if ("missing" in found) {
    const name = shownValue(track ?? "HEAD");
    return problem(
      found.missing === "ambiguous"
        ? `the upstream repository has both a branch and a tag named ${name}; a track must name only one of them; ${NOTHING}`
        : `the upstream repository has no branch or tag named ${name}; ${NOTHING}`,
    );
  }
  const commit = found.commit;
  const c12 = commit.slice(0, 12);
  const oldCommit = existing?.ref.approved;
  if (oldCommit === commit) {
    out(`UNCHANGED ${id} is at ${c12} (ref.approved); nothing to propose`);
    return 0;
  }

  const branch = updateBranch(id, commit);
  const already = openPullRequest(ctx, repo, branch);
  await tick();
  if (already !== undefined) {
    out(`OPEN ${already} for ${id}@${c12}; no second pull request was opened`);
    return 0;
  }

  const base = defaultBranch(ctx);
  await tick();
  const baseCommit = fetchBase(ctx, base);
  await tick();
  const path = prefix + SOURCES_FILE;
  const blob = readBlob(ctx, baseCommit, path);
  await tick();
  const working = workingFile(file);
  if (working === "unreadable" || !sameBytes(blob?.content, working)) {
    return problem(`${SOURCES_FILE} in this folder differs from ${SOURCES_FILE} on origin/${base}; commit, restore or pull it and try again; ${NOTHING}`);
  }
  const beforeText = blob?.content.toString("utf8");

  // The review record, when the entry is an enabled community entry: stated by a person, confirmed by the merge.
  const decided = communityReview(shape, { commit, reviewer: given.reviewer, licence: given.licence, today });
  if ("problem" in decided) return problem(decided.problem);
  const review: SourceReview | undefined = decided.review;

  const edited =
    existing !== undefined
      ? changeApproved(beforeText ?? "", id, commit, review)
      : addConnectorEntry(beforeText, connectorSource(connector!, { commit, owner: given.owner!, review }));
  if ("problem" in edited) return problem(`${edited.problem}; ${NOTHING}`);
  const checked = checkEdit(beforeText, edited.text, id, commit, today, review);
  if ("problem" in checked) return problem(`${checked.problem}; ${NOTHING}`);
  const candidate = checked.entry;

  const staged = await stageSource(candidate, commit, out, { home: opts.home, remote: opts.remote, env: opts.env, open: opts.open, now: opts.now, signal });
  if (staged.code !== 0 || !staged.done) return staged.code === 0 ? 1 : staged.code;
  const read2 = readStagedImport(id, commit, { home: opts.home });
  if (read2.state !== "ok") return problem(`the staged import could not be read back; ${NOTHING}`);
  const report = reviewStaged({ source: candidate, commit, record: read2.record, files: read2.files, licence: read2.licence }, { home: opts.home });
  await tick();

  // What changed since the approved commit. An old commit that is not in quarantine is staged first, silently; a failure only
  // means it could not be compared.
  let change: SourceChange | "not-compared" | undefined;
  let gates: ImportGates | undefined;
  if (oldCommit !== undefined && existing !== undefined) {
    change = await changesSince({
      old: existing,
      oldCommit,
      next: { source: candidate, staged: read2, review: report },
      cwd,
      home: opts.home,
      today,
      stage: async (src, c) => {
        const r = await stageSource(src, c, () => {}, { home: opts.home, remote: opts.remote, env: opts.env, open: opts.open, now: opts.now, signal });
        await tick();
        return r.code === 0 && r.done !== undefined;
      },
    });
    await tick();
    out(sourceChangeLine(change, oldCommit));
    // The gates of the new import hold whether or not the old commit could be compared.
    if (change === "not-compared") gates = newImportGates({ next: { source: candidate, staged: read2, review: report }, cwd, home: opts.home });
  }
  out(reviewLines(report).at(-1)!);

  const pr = updatePullRequest({ source: candidate, oldCommit, commit, track, review, rejected: read2.record.rejected, report, change, gates });
  const proposal = commitFile(ctx, baseCommit, path, Buffer.from(edited.text, "utf8"), blob?.mode ?? "100644", `Skill source ${id}: propose ${c12}`);
  await tick();

  // From here on a branch may exist on origin; it is deleted only while it still holds this commit.
  const cleanup = (): boolean => deleteOwnBranch(ctx, branch, proposal);
  const leftover = (text: string) => problem(`${text}; the branch ${branch} may still be on origin: delete it by hand`);
  try {
    pushNewBranch(ctx, branch, proposal);
  } catch (e) {
    if (!(e instanceof CatalogueError)) throw e;
    const cleaned = cleanup();
    let competing: string | undefined;
    try {
      competing = openPullRequest(ctx, repo, branch);
    } catch {
      // not known; the push failure is reported
    }
    if (competing !== undefined) {
      out(`OPEN ${competing} for ${id}@${c12}; no second pull request was opened`);
      return 0;
    }
    const sentence = catalogueSentence(e.code);
    return cleaned ? problem(sentence) : leftover(sentence);
  }
  try {
    await tick();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    out(cleanup() ? INTERRUPTED : `PROBLEM the update was interrupted; the branch ${branch} may still be on origin: delete it by hand`);
    return 1;
  }

  let url: string | undefined;
  let failure: CatalogueError | undefined;
  try {
    url = createPullRequest(ctx, { repo, base, head: branch, title: pr.title, body: pr.body });
  } catch (e) {
    if (!(e instanceof CatalogueError)) throw e;
    failure = e;
  }
  if (url === undefined) {
    // gh may have made the pull request before it failed: look before the branch is removed
    try {
      url = openPullRequest(ctx, repo, branch);
    } catch {
      // not known
    }
  }
  if (url === undefined) {
    const cleaned = cleanup();
    const sentence = catalogueSentence(failure?.code ?? "gh-failed", "create");
    return cleaned ? problem(sentence) : leftover(sentence);
  }
  let interrupted = false;
  try {
    await tick();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    interrupted = true;
  }
  out(`OK opened ${url} for ${id}@${c12}; nothing is approved until it is merged${interrupted ? " (interrupted after the pull request was opened)" : ""}`);
  return 0;
}
