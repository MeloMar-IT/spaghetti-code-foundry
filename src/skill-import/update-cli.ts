import { resolve } from "node:path";
import { SOURCE_CONNECTORS, connectorSource } from "../skills/connectors.js";
import { reviewLines } from "../skills/import-review.js";
import { readStagedImport } from "../skills/import-stage.js";
import { reviewStaged } from "../skills/review-cli.js";
import { sourceChangeLine, type SourceChange } from "../skills/source-change.js";
import type { ImportGates } from "../skills/source-update.js";
import { changesSince, newImportGates } from "./update-changes.js";
import { isDeepStrictEqual } from "node:util";
import { SKILL_ID_RE } from "../skills/schema.js";
import { addConnectorEntry, changeApproved, checkEdit, communityReview, REVIEW_PENDING_NOTE, updateBranch, updateBranchPrefix, updatePullRequest, type UpdatePullRequestInput } from "../skills/source-update.js";
import type { UpdateCheckOutcome } from "../skills/update-schedule.js";
import { updateDue } from "./update-due.js";
import { askReviewer, catalogueSentence, INTERRUPTED, Interrupted, NOTHING, resolverSentence, reviewerConfirmed, sameBytes, tickFor, withSignal, workingFile } from "./update-common.js";
import { OWNER_RE, readSources, shownValue, sourcesFromBytes, SOURCES_FILE, type SkillLibrarySource, type SourceReview } from "../skills/sources.js";
import {
  CatalogueError,
  commitFile,
  createPullRequest,
  defaultBranch,
  deleteOwnBranch,
  editPullRequest,
  fetchBase,
  openPullRequest,
  openSourcePullRequests,
  originRepo,
  pullRequestReviewers,
  pullRequestText,
  pushNewBranch,
  readBlob,
  showPrefix,
  type Blob,
  type CatalogueContext,
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
export const UPDATE_DUE_USAGE = "usage: scf skills update --due [--all]";

/** The input of a due run: the entries of skill-sources.yaml as they are on origin/<base>. */
export interface DueInput {
  sources: readonly SkillLibrarySource[];
}

const defaultResolve: NonNullable<SkillUpdateOptions["resolve"]> = async (repository, track, o) =>
  track === undefined ? { commit: await resolveHead(repository, o) } : resolveTrack(repository, track, o);


/** `scf skills update`. `positionals` are the operands after "update"; the syntax is checked before anything is read. */
export async function skillUpdateCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillUpdateOptions = {},
): Promise<number> {
  const { owner, reviewer, licence, due, all, ...rest } = args.values;
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) throw syntax(`scf skills update: unexpected option --${k}`);
  for (const [name, v] of [["due", due], ["all", all]] as const) {
    if (v !== undefined && v !== true) throw syntax(`scf skills update: --${name} takes no value`);
  }
  if (due === true || all === true) {
    const dueSyntax = (why: string) => new Error(`${why}\n${UPDATE_DUE_USAGE}`);
    if (due !== true) throw dueSyntax("scf skills update: --all needs --due");
    if (args.positionals.length > 0) throw dueSyntax("scf skills update: --due cannot be used with a source id");
    if (owner !== undefined || reviewer !== undefined || licence !== undefined) {
      throw dueSyntax("scf skills update: --due takes no --owner, --reviewer or --licence; a community source names its reviewer in update.reviewer");
    }
  }
  const [id] = args.positionals;
  if (due === true) return withSignal((signal) => updateDue({ all: all === true }, out, opts, signal, updateSource));
  if (args.positionals.length !== 1 || id === undefined) throw syntax("scf skills update: expects one source id");
  if (!SKILL_ID_RE.test(id)) throw syntax("scf skills update: the source id must be a lower-case slug");
  for (const [name, v] of [["owner", owner], ["reviewer", reviewer], ["licence", licence]] as const) {
    if (v !== undefined && (typeof v !== "string" || v === "")) throw syntax(`scf skills update: --${name} needs a value`);
  }
  if (typeof owner === "string" && !OWNER_RE.test(owner)) throw syntax("scf skills update: --owner must be a GitHub user or team like @octocat or @acme/skills");
  if (typeof reviewer === "string" && !OWNER_RE.test(reviewer)) throw syntax("scf skills update: --reviewer must be a GitHub user or team like @octocat or @acme/skills");

  const given = { owner, reviewer, licence } as { owner?: string; reviewer?: string; licence?: string };
  return withSignal(async (signal) => (await updateSource(id, given, out, opts, signal)) === "PROBLEM" ? 1 : 0);
}

/** One source: the outcome of `run`, with an interrupt and a git or gh failure turned into PROBLEM (the line is printed). */
export async function updateSource(
  id: string,
  given: { owner?: string; reviewer?: string; licence?: string },
  out: (line: string) => void,
  opts: SkillUpdateOptions,
  signal: AbortSignal,
  due?: DueInput,
): Promise<UpdateCheckOutcome> {
  try {
    return await run(id, given, out, opts, signal, due);
  } catch (e) {
    if (e instanceof Interrupted) {
      out(INTERRUPTED);
      return "PROBLEM";
    }
    if (e instanceof CatalogueError) {
      out(`PROBLEM ${catalogueSentence(e.code)}`);
      return "PROBLEM";
    }
    throw e;
  }
}

interface UpdateRun {
  id: string;
  commit: string;
  c12: string;
  branch: string;
  repo: string;
  ctx: CatalogueContext;
  cwd: string;
  today: string;
  track: string | undefined;
  existing: SkillLibrarySource | undefined;
  out: (line: string) => void;
  opts: SkillUpdateOptions;
  signal: AbortSignal;
  tick: () => Promise<void>;
  /** An unattended `--due` run: the reviewer comes from update.reviewer and is asked after the pull request is opened. */
  due: boolean;
}

const openLine = (url: string, id: string, c12: string) => `OPEN ${url} for ${id}@${c12}; no second pull request was opened`;

/** Fetches the default branch and checks that skill-sources.yaml here is the one on origin. A string is the problem sentence. */
async function baseState(
  ctx: CatalogueContext,
  file: string | undefined,
  path: string,
  tick: () => Promise<void>,
): Promise<string | { base: string; baseCommit: string; blob: Blob | undefined }> {
  const base = defaultBranch(ctx);
  await tick();
  const baseCommit = fetchBase(ctx, base);
  await tick();
  const blob = readBlob(ctx, baseCommit, path);
  await tick();
  if (file === undefined) return { base, baseCommit, blob };
  const working = workingFile(file);
  if (working === "unreadable" || !sameBytes(blob?.content, working)) {
    return `${SOURCES_FILE} in this folder differs from ${SOURCES_FILE} on origin/${base}; commit, restore or pull it and try again; ${NOTHING}`;
  }
  return { base, baseCommit, blob };
}

/** Stages the commit, reviews it and builds the input of the title and body. "PROBLEM": the run ends there (the line is printed). */
async function proposalInput(r: UpdateRun, candidate: SkillLibrarySource, review: SourceReview | undefined): Promise<UpdatePullRequestInput | "PROBLEM"> {
  const { id, commit, out, opts, signal, tick, cwd, today, existing } = r;
  const oldCommit = existing?.ref.approved;
  const staged = await stageSource(candidate, commit, out, { home: opts.home, remote: opts.remote, env: opts.env, open: opts.open, now: opts.now, signal });
  if (staged.code !== 0 || !staged.done) return "PROBLEM";
  const read2 = readStagedImport(id, commit, { home: opts.home });
  if (read2.state !== "ok") {
    out(`PROBLEM the staged import could not be read back; ${NOTHING}`);
    return "PROBLEM";
  }
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
        const s = await stageSource(src, c, () => {}, { home: opts.home, remote: opts.remote, env: opts.env, open: opts.open, now: opts.now, signal });
        await tick();
        return s.code === 0 && s.done !== undefined;
      },
    });
    await tick();
    out(sourceChangeLine(change, oldCommit));
    // The gates of the new import hold whether or not the old commit could be compared.
    if (change === "not-compared") gates = newImportGates({ next: { source: candidate, staged: read2, review: report }, cwd, home: opts.home });
  }
  out(reviewLines(report).at(-1)!);

  // Older open pull requests of this source are only named; they are never touched.
  // Commits have no order here, so "older" means a pull request opened before this one. A new proposal has no pull request
  // yet: every other open one is older. A pull request with no known time is never called older than a known one.
  const open = openSourcePullRequests(r.ctx, r.repo, updateBranchPrefix(id));
  const own = open.find((p) => p.branch === r.branch);
  const supersedes = open.filter((p) => p !== own && (own === undefined || (p.createdAt !== undefined && own.createdAt !== undefined && p.createdAt < own.createdAt)));
  await tick();
  return { source: candidate, oldCommit, commit, track: r.track, review, rejected: read2.record.rejected, report, change, gates, supersedes };
}

/**
 * The pull request of this branch is open: rebuild its text from the proposal the branch holds and edit it when the text differs.
 * The branch is never pushed again. A branch that does not hold this proposal is only reported.
 */
async function refresh(r: UpdateRun, url: string, path: string): Promise<UpdateCheckOutcome> {
  const { id, commit, c12, branch, out, tick } = r;
  const problem = (text: string): "PROBLEM" => {
    out(`PROBLEM ${text}`);
    return "PROBLEM";
  };
  const was = "it was left as it was";
  let blob: Blob | undefined;
  try {
    const head = fetchBase(r.ctx, branch);
    await tick();
    blob = readBlob(r.ctx, head, path);
    await tick();
  } catch (e) {
    if (e instanceof CatalogueError && (e.code === "fetch-failed" || e.code === "read-failed")) {
      return problem(`the branch ${branch} of the pull request ${url} could not be read from origin; ${was}`);
    }
    throw e;
  }
  const entry = blob && proposedEntry(blob.content, id, commit, r.today);
  if (!entry) {
    out(openLine(url, id, c12));
    return "OPEN";
  }
  // The review claim is the one the creation path makes: only an enabled community entry carries it.
  const review = entry.status === "enabled" && entry.trust === "community" ? entry.review : undefined;
  const input = await proposalInput({ ...r, track: entry.ref.track }, entry, review);
  if (input === "PROBLEM") return input;

  let current: { title: string; body: string };
  try {
    current = pullRequestText(r.ctx, r.repo, url);
  } catch (e) {
    if (e instanceof CatalogueError && e.code === "gh-failed") return problem(`the pull request ${url} could not be read with gh; ${was}`);
    throw e;
  }
  await tick();
  // The note of an unattended run stays as it is, so edits never flip it on and off.
  const pending = review !== undefined && current.body.includes(REVIEW_PENDING_NOTE);
  if (r.due && pending && review) {
    // The claim in the pull request must be the configured reviewer; after update.reviewer was corrected it no longer is.
    const configured = r.existing?.update.reviewer;
    if (configured !== review.by) {
      return problem(
        `the pull request ${url} names ${review.by} as the reviewer, but update.reviewer is ${configured ?? "not set"}; close the pull request and delete its branch ${branch}, then the next --due run opens one that names the right reviewer`,
      );
    }
    // The reviewer is named; check that GitHub holds the request, and ask again when it does not.
    let asked = false;
    try {
      asked = reviewerConfirmed(pullRequestReviewers(r.ctx, r.repo, url), review.by) || askReviewer(r.ctx, r.repo, url, review.by);
    } catch (e) {
      if (!(e instanceof CatalogueError)) throw e;
    }
    if (!asked) return problem(`the pull request ${url} is open, but gh could not confirm or ask ${review.by} to review it; ${was}; the next --due run tries again`);
    await tick();
  }
  const text = updatePullRequest({ ...input, reviewPending: pending });
  if (current.title === text.title && Buffer.from(current.body).equals(Buffer.from(text.body))) {
    out(openLine(url, id, c12));
    return "OPEN";
  }
  try {
    editPullRequest(r.ctx, { repo: r.repo, url, title: text.title, body: text.body });
  } catch (e) {
    if (e instanceof CatalogueError && e.code === "gh-failed") return problem(`gh could not update the pull request ${url}; ${was}`);
    throw e;
  }
  out(`UPDATED ${url} for ${id}@${c12}; nothing is approved until it is merged`);
  return "UPDATED";
}

/** The enabled entry `id` of the branch file when it proposes `commit`. */
function proposedEntry(content: Buffer, id: string, commit: string, today: string): SkillLibrarySource | undefined {
  const read = sourcesFromBytes(content, today);
  if (read.state !== "ok") return undefined;
  const entry = read.manifest.sources.find((s) => s.id === id);
  return entry && entry.status === "enabled" && entry.ref.approved === commit ? entry : undefined;
}

async function run(
  id: string,
  given0: { owner?: string; reviewer?: string; licence?: string },
  out: (line: string) => void,
  opts: SkillUpdateOptions,
  signal: AbortSignal,
  dueInput?: DueInput,
): Promise<UpdateCheckOutcome> {
  const problem = (text: string): "PROBLEM" => {
    out(`PROBLEM ${text}`);
    return "PROBLEM";
  };
  let given = given0;
  const tick = tickFor(signal);
  const due = dueInput !== undefined;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const ctx: CatalogueContext = { cwd, env: opts.env ?? process.env };
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);

  const prefix = showPrefix(ctx);
  await tick();
  const repo = originRepo(ctx);
  await tick();
  if (repo === undefined) return problem("the address of origin is not a GitHub repository address; the pull request needs it");

  const file = resolve(cwd, SOURCES_FILE);
  let sources: readonly SkillLibrarySource[];
  if (dueInput) sources = dueInput.sources;
  else {
    const read = readSources(file, undefined, today);
    if (read.state === "invalid") {
      for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
      return "PROBLEM";
    }
    sources = read.state === "ok" ? read.manifest.sources : [];
  }
  // An unattended run takes the reviewer from update.reviewer, and only for an enabled community entry.
  const listed = sources.find((s) => s.id === id);
  if (due && listed && listed.status === "enabled" && listed.trust === "community") given = { ...given, reviewer: listed.update.reviewer };
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
  // An unattended run has no options to check: its values come from a validated file.
  if (!due) {
    const early = communityReview(shape, { commit: "0".repeat(40), reviewer: given.reviewer, licence: given.licence, today });
    const needsReview = shape.status === "enabled" && shape.trust === "community";
    if ("problem" in early && (!needsReview || given.reviewer !== undefined)) return problem(early.problem);
  }

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
    return "UNCHANGED";
  }

  const branch = updateBranch(id, commit);
  const already = openPullRequest(ctx, repo, branch);
  await tick();

  const path = prefix + SOURCES_FILE;
  const state = await baseState(ctx, due ? undefined : file, path, tick);
  if (typeof state === "string") return problem(state);
  const { base, baseCommit, blob } = state;
  if (due && existing) {
    // The list was read before; the entry must still be the one on origin now.
    const again = blob && sourcesFromBytes(blob.content, today);
    const now = again && again.state === "ok" ? again.manifest.sources.find((s) => s.id === id) : undefined;
    if (!isDeepStrictEqual(now, existing)) return problem(`the entry changed on origin/${base} while it was checked; ${NOTHING}`);
  }
  const r: UpdateRun = { id, commit, c12, branch, repo, ctx, cwd, today, track, existing, out, opts, signal, tick, due };
  if (already !== undefined) return refresh(r, already, path);
  const beforeText = blob?.content.toString("utf8");

  // The review record, when the entry is an enabled community entry: stated by a person, confirmed by the merge.
  const decided = communityReview(shape, { commit, reviewer: given.reviewer, licence: given.licence, today });
  if ("problem" in decided) {
    if (!due) return problem(decided.problem);
    return problem(
      decided.missing === "reviewer"
        ? `needs update.reviewer: an enabled community source needs a reviewer; name a GitHub user or team in update.reviewer of ${SOURCES_FILE}; ${NOTHING}`
        : decided.missing === "licence"
          ? `needs --licence: the licence that was reviewed is not clear; licence.allow lists more than one; ${NOTHING}`
          : `${decided.problem}; ${NOTHING}`,
    );
  }
  const review: SourceReview | undefined = decided.review;

  const edited =
    existing !== undefined
      ? changeApproved(beforeText ?? "", id, commit, review)
      : addConnectorEntry(beforeText, connectorSource(connector!, { commit, owner: given.owner!, review }));
  if ("problem" in edited) return problem(`${edited.problem}; ${NOTHING}`);
  const checked = checkEdit(beforeText, edited.text, id, commit, today, review);
  if ("problem" in checked) return problem(`${checked.problem}; ${NOTHING}`);
  const candidate = checked.entry;

  const input = await proposalInput(r, candidate, review);
  if (input === "PROBLEM") return input;
  const pr = updatePullRequest({ ...input, reviewPending: due && review !== undefined });
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
      out(openLine(competing, id, c12));
      return "OPEN";
    }
    const sentence = catalogueSentence(e.code);
    return cleaned ? problem(sentence) : leftover(sentence);
  }
  try {
    await tick();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    out(cleanup() ? INTERRUPTED : `PROBLEM the update was interrupted; the branch ${branch} may still be on origin: delete it by hand`);
    return "PROBLEM";
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
  // An unattended run asks the named reviewer after the pull request exists; the pull request stays when gh cannot.
  const asked = !due || review === undefined || askReviewer(ctx, repo, url, review.by);
  let interrupted = false;
  try {
    await tick();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    interrupted = true;
  }
  if (!asked) {
    return problem(`opened ${url} for ${id}@${c12}, but gh could not ask ${review!.by} to review it; ask them on GitHub or fix update.reviewer; the next --due run tries again`);
  }
  out(`OK opened ${url} for ${id}@${c12}; nothing is approved until it is merged${interrupted ? " (interrupted after the pull request was opened)" : ""}`);
  return "OK";
}
