import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DETAIL_MAX, writeAudit } from "../auth/audit.js";
import { StoreError, dataHome } from "../auth/store.js";
import { loadConfig } from "../config.js";
import { acquireLock, releaseLock } from "../home-migrate.js";
import { readApprovals, recordApprovedRef } from "../skills/approvals.js";
import { buildAutoRelease, rejectedFailures } from "../skills/auto-release.js";
import { readAutoUpdates, recordAutoUpdate, type AutoSkillFailure, type AutoUpdateEntry } from "../skills/auto-updates.js";
import { approveAutoRelease } from "../skills/auto-approve.js";
import { scoreImport, type EvaluateCliOptions } from "../skills/evaluate-cli.js";
import { EVALUATION_SUITE_DEFAULT } from "../skills/evaluation-rules.js";
import { readEvaluationSuite } from "../skills/evaluation-suite.js";
import { publishRelease, ReleaseStoreError } from "../skills/release-store.js";
import { sourceQualifiedId } from "../skills/normalize.js";
import { shownValue, type SkillLibrarySource, type SourcesManifest } from "../skills/sources.js";
import type { UpdateCheckOutcome } from "../skills/update-schedule.js";
import { stageSource } from "./cli.js";
import { LsRemoteError } from "./ls-remote.js";
import { NOTHING, resolverSentence, tickFor } from "./update-common.js";
import { sourceCredential } from "./source-access.js";
import { openFailureIssues } from "./update-issues.js";
import type { GitCredential } from "./git-tree.js";
import type { SkillUpdateOptions } from "./update-cli.js";

// The automatic update of a first-party source with `update.auto: true` (#799). One chain per source, under a lock in the data folder:
// find the commit, stage it, run the gates and the evaluation, publish a release, approve it, record the commit and the result.
// Nothing here opens a pull request or touches skill-sources.yaml; the only gh calls open issues for the skills that failed (#800). The lines, audit details and records hold checked ids,
// digests, commits and fixed sentences only; the upstream text is never copied.

/** An enabled first-party source with `update.auto`: the only kind this path handles. */
export function autoSource(sources: readonly SkillLibrarySource[], id: string): SkillLibrarySource | undefined {
  const s = sources.find((x) => x.id === id);
  return s && s.status === "enabled" && s.trust === "first-party" && s.update.auto === true ? s : undefined;
}

const NOT_RELEASED = "nothing was released";
const lockName = (id: string) => `skill-auto-update-${id}.lock`;
const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
/** The line the agent scoring prints for an interrupt or a runner error (fixed text, no upstream text). */
const EVALUATION_INTERRUPTED = "PROBLEM the evaluation was interrupted";
/**
 * A scoring line that ends the evaluation of the whole source. A line that names one skill (its id, or a skill that did not normalize)
 * only costs that skill: it gets no record, so the gate refuses it as not judged. The same goes for a scored skill that failed.
 */
const hardProblemOf = (ids: ReadonlySet<string>) => (l: string) => {
  if (!l.startsWith("PROBLEM ")) return false;
  if (l === EVALUATION_INTERRUPTED) return true;
  if (/^PROBLEM .*: not normalized \(/.test(l)) return false;
  const named = /^PROBLEM ([^:\s]+): /.exec(l);
  return !(named && ids.has(named[1]!));
};

export async function autoUpdate(
  source: SkillLibrarySource,
  out: (line: string) => void,
  opts: SkillUpdateOptions,
  signal: AbortSignal,
  deps: { resolve: NonNullable<SkillUpdateOptions["resolve"]>; sources: readonly SkillLibrarySource[] },
): Promise<UpdateCheckOutcome> {
  const id = source.id;
  const by = opts.auditBy ?? "cli";
  const problem = (text: string): "PROBLEM" => {
    out(`PROBLEM ${text}`);
    return "PROBLEM";
  };
  const home = dataHome();
  if (opts.home !== undefined && resolve(opts.home) !== resolve(home)) {
    return problem(`the automatic update works in the data folder only; ${NOT_RELEASED}`);
  }
  const tick = tickFor(signal);
  const now = opts.now ?? new Date();
  let target = id;
  let noted = false;
  /** One audit line for a step. A failure to write it is one NOTE, never a stop. */
  const step = (name: string, ok: boolean, detail: string): void => {
    try {
      writeAudit(by, { action: "skill-auto-update", result: ok ? "ok" : "failed", target, detail: `${name}: ${detail}`.slice(0, DETAIL_MAX) }, 0);
    } catch {
      if (!noted) out("NOTE audit: audit.jsonl could not be written; the update goes on");
      noted = true;
    }
  };
  const fail = (name: string, text: string): "PROBLEM" => {
    step(name, false, text);
    return problem(text);
  };
  const note = (file: string) => out(`NOTE ${file} could not be written to the data folder`);

  // One chain per source at a time. A second run is refused at once (waiting would block this process).
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, lockName(id));
  if (!acquireLock(lock, 0)) return problem(`another automatic update of ${id} is running; ${NOT_RELEASED}`);
  try {
    // 1. The credential of a private source.
    let credential: GitCredential | undefined;
    if (source.access) {
      const got = await (opts.access ?? sourceCredential)(source);
      if (!got.ok) return fail("fetch", got.problem);
      credential = got.credential;
    }
    await tick();

    // 2. The commit of the track.
    let found;
    try {
      found = await deps.resolve(source.repository, source.ref.track, { signal, remote: opts.remote, env: opts.env, ...(credential ? { credential } : {}) });
    } catch (e) {
      if (e instanceof LsRemoteError) return fail("fetch", resolverSentence(e.code, source.repositoryKey).replace(NOTHING, NOT_RELEASED));
      throw e;
    }
    await tick();
    if ("missing" in found) {
      const name = shownValue(source.ref.track ?? "HEAD");
      return fail(
        "fetch",
        found.missing === "ambiguous"
          ? `the upstream repository has both a branch and a tag named ${name}; a track must name only one of them; ${NOT_RELEASED}`
          : `the upstream repository has no branch or tag named ${name}; ${NOT_RELEASED}`,
      );
    }
    const commit = found.commit;
    const c12 = commit.slice(0, 12);
    target = `${id}@${c12}`;
    step("fetch", true, `commit ${c12}`);

    const approvals = readApprovals({ home });
    if (approvals.state === "unreadable") return fail("fetch", `skill-approvals.json in the data folder ${approvals.reason}; ${NOT_RELEASED}`);
    const mine = approvals.state === "ok" ? approvals.sources[id] : undefined;
    const storedRef = mine && mine.repositoryKey === source.repositoryKey ? mine.ref?.approved : undefined;
    const previous = readAutoUpdates({ home });
    const last = previous.state === "ok" ? previous.sources[id] : undefined;
    const keep = new Set(deps.sources.map((s) => s.id));
    const at = stamp(now);
    const save = (entry: AutoUpdateEntry) => {
      try {
        recordAutoUpdate(id, entry, { home, keep });
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        note("skill-auto-updates.json");
      }
    };

    // 3. Nothing new upstream.
    if (storedRef === commit || (last && last.commit === commit && (last.result === "released" || last.result === "unchanged"))) {
      const same = last && last.commit === commit;
      step("compare", true, "unchanged");
      save({ at, commit, result: "unchanged", ...(same && last.release ? { release: last.release } : {}), failed: same ? last.failed : [] });
      out(`UNCHANGED ${id} is at ${c12} (approved in the data folder); nothing to release`);
      return "UNCHANGED";
    }

    // 4. Quarantine. The candidate counts as approved only for the reads of this run; the data folder gets the commit at the end.
    const candidateSource: SkillLibrarySource = { ...source, ref: { ...source.ref, approved: commit } } as SkillLibrarySource;
    const candidates: SourcesManifest = { schema: 1, sources: deps.sources.map((s) => (s.id === id ? candidateSource : s)) };
    const staged = await stageSource(candidateSource, commit, () => {}, {
      home,
      remote: opts.remote,
      env: opts.env,
      open: opts.open,
      now: opts.now,
      signal,
      ...(credential ? { credential } : {}),
    });
    await tick();
    /** One issue in the source's repository for each failed skill (#800). It never throws and never changes the outcome. */
    const fileIssues = async (failed: readonly AutoSkillFailure[]): Promise<void> => {
      let label: string;
      try {
        label = (opts.skills ?? loadConfig().skills).authoring.label;
      } catch {
        out("NOTE the skill settings could not be read; no issue was opened");
        return;
      }
      await openFailureIssues({
        source,
        failed,
        label,
        env: opts.env ?? process.env,
        cwd: resolve(opts.cwd ?? process.cwd()),
        signal,
        tick: async () => {
          try {
            await tick();
          } catch {
            // the caller checks the signal
          }
        },
        access: opts.issueAccess ?? ((s) => sourceCredential(s, { permissions: { issues: "write" } })),
        out,
        audit: (ok, d) => step("issue", ok, d),
      });
    };
    const failedRecord = async (result: AutoUpdateEntry["result"], failed: AutoSkillFailure[], release?: AutoUpdateEntry["release"]): Promise<void> => {
      save({ at, commit, result, ...(release ? { release } : {}), failed });
      if (failed.length > 0) await fileIssues(failed);
    };
    const blockedLines = (failed: readonly AutoSkillFailure[]) => failed.forEach((f) => out(`BLOCKED ${f.skill} ${f.gate}: ${f.message}`));
    if (staged.rejected) {
      // The import worked and refused every skill: not a fetch failure.
      const failed = rejectedFailures(id, staged.rejected.length);
      blockedLines(failed);
      await failedRecord("blocked", failed);
      step("import", false, `${failed.length} skills refused`);
      return problem(`no skill of ${id}@${c12} passed the gates; ${NOT_RELEASED}`);
    }
    if (staged.code !== 0 || !staged.done) return fail("import", `the commit ${c12} of ${source.repositoryKey} could not be fetched or read; ${NOT_RELEASED}`);
    step("import", true, `${staged.done.record.skills.length} skills staged, ${staged.done.record.rejected.length} refused`);
    // The ids the gates use (the same as buildAutoRelease), so the scoring lines of one skill can be told from a source-wide failure.
    const origin = { source: staged.done.record.source, repositoryKey: staged.done.record.repositoryKey };
    const ids = new Set(staged.done.record.skills.map((s) => sourceQualifiedId(origin, s.name)));

    // 5. The evaluation suite, when the catalogue folder has one.
    const cwd = resolve(opts.cwd ?? process.cwd());
    const skills = opts.skills ?? loadConfig().skills;
    const evalOpts: EvaluateCliOptions = {
      cwd,
      home,
      today: now.toISOString().slice(0, 10),
      now,
      skills,
      discover: { home, ...(opts.env ? { env: opts.env } : {}) },
      sources: candidates,
    };
    const suite = readEvaluationSuite(resolve(cwd, EVALUATION_SUITE_DEFAULT));
    if (suite.state === "invalid") return fail("evaluation", `the evaluation suite of the catalogue is not valid; ${NOT_RELEASED}`);
    let evaluation: "required" | "not-run" = "not-run";
    if (suite.state === "ok") {
      evaluation = "required";
      const lines: string[] = [];
      const sink = (l: string) => void lines.push(l);
      if ((suite.suite.instructions?.scenarios.length ?? 0) > 0) {
        const agentScore = opts.agentScore ?? (async (...a: Parameters<NonNullable<SkillUpdateOptions["agentScore"]>>) => (await import("../skill-eval/score.js")).scoreImportWithAgent(...a));
        await agentScore(id, undefined, sink, { ...evalOpts, signal });
      } else {
        scoreImport(id, undefined, sink, evalOpts);
      }
      await tick();
      if (signal.aborted || lines.some(hardProblemOf(ids))) return fail("evaluation", `the evaluation could not run; ${NOT_RELEASED}`);
    }
    step("evaluation", true, evaluation === "required" ? "scored" : "no suite");

    // 6. The gates and the version rules.
    const built = buildAutoRelease({ source: candidateSource, commit, sources: candidates, evaluation, createdAt: stamp(now) }, { ...evalOpts, discover: evalOpts.discover });
    if (built.state === "problem") {
      step("gates", false, "release could not be built");
      return problem(`${built.text}; ${NOT_RELEASED}`);
    }
    if (built.state === "blocked") {
      blockedLines(built.failed);
      await failedRecord("blocked", built.failed);
      step("gates", false, `no skill passed; ${built.failed.length} failed`);
      return problem(`no skill of ${id}@${c12} passed the gates; ${NOT_RELEASED}`);
    }
    blockedLines(built.failed);
    if (built.state === "unchanged") {
      await failedRecord("unchanged", built.failed, undefined);
      step("gates", true, `no skill changed since ${built.base.catalogue}@${built.base.version}`);
      out(`UNCHANGED ${id}@${c12}: no skill changed since ${built.base.catalogue}@${built.base.version}; nothing to release`);
      return "UNCHANGED";
    }
    const { target: rel, built: release } = built;
    const label = `${rel.catalogue}@${rel.version}`;
    step("gates", true, `${release.content.manifest.skills.length} skills passed, ${built.failed.length} failed`);
    const relRecord = { catalogue: rel.catalogue, version: rel.version, digest: release.digest };

    // 7. From here on nothing waits for the network: publish, approve and record the commit run one after the other.
    let published;
    try {
      published = publishRelease(release.content, { home });
    } catch (e) {
      if (!(e instanceof ReleaseStoreError)) throw e;
      return fail("publish", `${e.message}; ${NOT_RELEASED}`);
    }
    if (published.state === "refused") return fail("publish", `${label} is already in the release store with other content; ${NOT_RELEASED}`);
    step("publish", true, `${label} ${release.digest}`);

    const approved = approveAutoRelease({ sourceId: id, catalogue: rel.catalogue, version: rel.version }, { releases: skills.releases, sources: deps.sources, by, log: (l) => out(`NOTE ${l}`) });
    if (approved.state === "refused") {
      await failedRecord("failed", built.failed, relRecord);
      return problem(`${label} was published but not approved: ${approved.reason}`);
    }

    let ref: ReturnType<typeof recordApprovedRef> | undefined;
    try {
      ref = recordApprovedRef(id, source.repositoryKey, commit, { home, at: now, expectedPrevious: storedRef ?? null });
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      note("skill-approvals.json");
    }
    if (ref === "stale") {
      await failedRecord("failed", built.failed, relRecord);
      return fail("ref", `the approved commit of ${id} changed while the update ran; ${label} was approved, but ${c12} was not recorded`);
    }
    if (ref !== undefined) step("ref", true, c12);
    await failedRecord("released", built.failed, relRecord);
    out(`RELEASED ${label} ${release.digest} ${release.content.manifest.skills.length} skills from ${id}@${c12}; approved automatically`);
    return "OK";
  } finally {
    releaseLock(lock);
  }
}
