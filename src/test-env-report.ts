// Files the Docker version story when a run ends, whether or not a watcher watches the repository (see test-env-story.ts).
// The Foundry does it, never the test step. The sign-in is the one of the run: the stored repository of the run's owner; the
// server's own `gh` login only for a run that works with it anyway. A user's or a team's run without a sign-in files nothing.
import { findOwnedRepo } from "./auth/repos.js";
import { isLocalRepoName } from "./auth/local-name.js";
import type { Config } from "./config.js";
import { shortEnvRun } from "./engine/short-env.js";
import type { RunSummary } from "./engine/state.js";
import { withGhEnv } from "./github.js";
import { repoGhIdentity, type RepoGhIdentity } from "./queue/gh-identity.js";
import { storeFor, type StoryStore } from "./stories/store.js";
import { dockerApiProblem, dockerApiStateFile, fileDockerApiStories, needsDockerApiStory } from "./test-env-story.js";

export interface DockerApiReport {
  /** The run that ended. */
  run: RunSummary;
  /** Other runs: those with the same repository, owner and workspace that have no story yet are tried again. */
  others?: () => RunSummary[];
  runsDir: string;
  config: () => Config;
  log: (m: string) => void;
  /** Tests replace these. */
  ghIdentity?: (repoId: string) => RepoGhIdentity;
  store?: (repo: string) => Pick<StoryStore, "listAll" | "create">;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Never rejects: a problem is one log line, and the next run of the repository that ends tries again. */
export async function reportDockerApi(o: DockerApiReport): Promise<void> {
  try {
    const { run } = o;
    const repo = run.vars?.github_repo;
    if (!repo || run.localTest) return;
    const same = (r: RunSummary) => r.runId !== run.runId && !r.localTest && r.vars?.github_repo === repo && r.owner === run.owner && r.workspace === run.workspace;
    const runs = [run, ...(o.others?.() ?? []).filter(same)].filter(needsDockerApiStory);
    if (!runs.length) return;
    const local = isLocalRepoName(repo);
    if (!local && !GITHUB_NAME.test(repo)) return;
    const stored = !local && run.owner ? findOwnedRepo(run.owner, repo) : undefined;
    if (!local && !stored && shortEnvRun(run.owner, run.workspace)) {
      o.log(`${repo}: no Docker version story — the run's owner has no sign-in for this repository`);
      return;
    }
    const identity = stored ? (o.ghIdentity?.(stored.id) ?? repoGhIdentity(stored.id, { config: o.config, log: o.log })) : undefined;
    try {
      const session = await identity?.prepare();
      await withGhEnv(session, () =>
        fileDockerApiStories({ repo, runs, store: (o.store ?? storeFor)(repo), stateFile: dockerApiStateFile(o.runsDir), log: (m) => o.log(`${repo}: ${m}`) }),
      );
    } finally {
      identity?.dispose();
    }
  } catch (e) {
    o.log(dockerApiProblem(e));
  }
}
