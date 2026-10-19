import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogueError,
  commitFile,
  createPullRequest,
  defaultBranch,
  deleteOwnBranch,
  openPullRequest,
  pushNewBranch,
  readBlob,
  remoteBranchHead,
  type CatalogueContext,
  type CatalogueErrorCode,
} from "../skill-import/catalogue-git.js";
import { Interrupted, tickFor, withSignal } from "../skill-import/update-common.js";
import { detectBuilds, RECIPE_FILE, suggestRecipe } from "./init.js";

// `scf release-build init --repo <owner/name> [--write]`: shallow-clones the repository into a temporary folder, prints a suggested
// recipe and, with --write, proposes it as a pull request from the new branch release-build-recipe. Never touches the default branch.

export const INIT_USAGE = "usage: scf release-build init --repo <owner/name> [--write]";
export const RECIPE_BRANCH = "release-build-recipe";

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const HEX_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CLONE_TIMEOUT_MS = 300_000;
const GIT_TIMEOUT_MS = 120_000;
const NOTHING = "nothing was proposed";
const DELETE_BY_HAND = `the branch ${RECIPE_BRANCH} may still be on GitHub: delete it by hand`;
const PR_BODY = [
  "This recipe was suggested by `scf release-build init` from the build files of the repository.",
  "",
  "Every guessed line has a comment. It is a guess: check the commands, the artifacts and the names, then merge.",
  "",
].join("\n");

export interface InitOptions {
  /** Where the temporary clone goes (default: the system temporary folder). */
  tmpRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests only: runs just before the push, to simulate a race or an interrupt. */
  beforePush?: () => void;
}

const SENTENCES: Partial<Record<CatalogueErrorCode, string>> = {
  "no-git": "git was not found",
  "no-gh": "gh was not found",
  timeout: "a git or gh call took too long",
  "no-default-branch": "the default branch of the repository is not known",
  "commit-failed": "the commit could not be made (is a git identity set?)",
  "push-failed": "the push failed",
  "gh-failed": "a gh call failed",
};
const sentence = (e: CatalogueError) => SENTENCES[e.code] ?? "a git call failed";

/** A local git call with a time limit; the output, or undefined on any failure. */
function localGit(ctx: CatalogueContext, args: string[]): Buffer | undefined {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined && !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE)$/.test(k)) env[k] = v;
  const r = spawnSync("git", args, {
    cwd: ctx.cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  return r.error || r.status !== 0 ? undefined : r.stdout;
}

export async function releaseBuildCommand(
  positionals: string[],
  values: { repo?: string; write?: boolean },
  out: (line: string) => void,
  err: (line: string) => void = () => {},
  opts: InitOptions = {},
): Promise<number> {
  if (positionals[0] !== "init" || positionals.length > 1 || !values.repo || !REPO_RE.test(values.repo)) throw new Error(INIT_USAGE);
  const repo = values.repo;
  const env = opts.env ?? process.env;
  const name = repo.split("/")[1]!;

  return withSignal(async (signal) => {
    const tick = tickFor(signal);
    const tmp = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "scf-release-init-"));
    let commit: string | undefined;
    try {
      // 1. the shallow clone
      const dir = join(tmp, "repo");
      const clone = spawnSync(env.FACTORY_GH_BIN || "gh", ["repo", "clone", repo, dir, "--", "--depth", "1", "-q"], {
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CLONE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf8",
      });
      if (clone.error || clone.status !== 0) {
        const why = (clone.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "timed out" : (clone.stderr ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) || "gh failed";
        err(`could not clone ${repo}: ${why}`);
        return 1;
      }
      await tick();

      // 2. the files of the default branch (tracked ones only) and a reader that refuses links and large files
      const ctx: CatalogueContext = { cwd: dir, env };
      const base = localGit(ctx, ["rev-parse", "--verify", "HEAD^{commit}"])?.toString("utf8").trim();
      const listing = base && HEX_RE.test(base) ? localGit(ctx, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", base]) : undefined;
      if (!base || !listing) {
        err(`could not read the files of ${repo}`);
        return 1;
      }
      const files = listing.toString("utf8").split("\0").filter(Boolean);
      const read = (p: string): string | undefined => {
        try {
          return readBlob(ctx, base, p)?.content.toString("utf8");
        } catch {
          return undefined;
        }
      };
      await tick();

      const builds = detectBuilds(files, read, { name });
      const text = suggestRecipe(files, read, { name });
      const exists = files.includes(RECIPE_FILE);

      // 3. print mode
      if (!values.write) {
        out(text.trimEnd());
        if (exists) err(`this repository already has ${RECIPE_FILE}`);
        if (builds.length === 0) err("no known build file was found; the output is a template");
        return 0;
      }

      // 4. the refusals of --write
      const refuse = (why: string): number => {
        err(`${why}; ${NOTHING}`);
        return 1;
      };
      if (exists) return refuse(`this repository already has ${RECIPE_FILE}`);
      if (files.includes(".factory")) return refuse(".factory is not a folder in this repository");
      if (builds.length === 0) return refuse("no known build file was found");
      let target: string;
      try {
        target = defaultBranch(ctx);
        if (target === RECIPE_BRANCH) return refuse(`the default branch is called ${RECIPE_BRANCH}`);
        if (remoteBranchHead(ctx, RECIPE_BRANCH) !== undefined) return refuse(`the branch ${RECIPE_BRANCH} already exists on GitHub; delete it and try again`);
      } catch (e) {
        if (!(e instanceof CatalogueError)) throw e;
        return refuse(sentence(e));
      }
      await tick();

      // 5. commit (temporary index, the working copy stays as it is) and push (create-only)
      commit = commitFile(ctx, base, RECIPE_FILE, Buffer.from(text, "utf8"), "100644", "Add a suggested release-build recipe");
      await tick();
      opts.beforePush?.();
      try {
        pushNewBranch(ctx, RECIPE_BRANCH, commit);
      } catch (e) {
        if (!(e instanceof CatalogueError)) throw e;
        deleteOwnBranch(ctx, RECIPE_BRANCH, commit);
        let head: string | undefined;
        try {
          head = remoteBranchHead(ctx, RECIPE_BRANCH);
        } catch {
          // not known
        }
        return refuse(head !== undefined && head !== commit ? `the branch ${RECIPE_BRANCH} already exists on GitHub; delete it and try again` : "the push failed");
      }
      const pushed = commit;
      const cleanup = (): boolean => deleteOwnBranch(ctx, RECIPE_BRANCH, pushed);
      const leftover = (why: string): number => {
        err(cleanup() ? `${why}; nothing was left behind` : `${why}; ${DELETE_BY_HAND}`);
        return 1;
      };
      try {
        await tick();
      } catch (e) {
        if (!(e instanceof Interrupted)) throw e;
        err(cleanup() ? `interrupted; ${NOTHING}` : `interrupted; ${DELETE_BY_HAND}`);
        return 1;
      }

      // 6. the pull request
      let url: string | undefined;
      try {
        url = createPullRequest(ctx, { repo, base: target, head: RECIPE_BRANCH, title: "Add a release-build recipe", body: PR_BODY });
      } catch (e) {
        if (!(e instanceof CatalogueError)) throw e;
      }
      if (url === undefined) {
        // gh may have made the pull request before it failed
        try {
          url = openPullRequest(ctx, repo, RECIPE_BRANCH);
        } catch {
          // not known
        }
      }
      if (url === undefined) return leftover("could not open the pull request");
      out(text.trimEnd());
      out(`pull request: ${url}`);
      return 0;
    } catch (e) {
      if (e instanceof Interrupted) {
        err(`interrupted; ${NOTHING}`);
        return 1;
      }
      if (e instanceof CatalogueError) {
        err(`${sentence(e)}; ${NOTHING}`);
        return 1;
      }
      throw e;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
