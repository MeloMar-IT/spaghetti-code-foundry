import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefinementRun } from "../auth/run-owner.js";
import { appJwt, installationToken } from "../github-app.js";
import type { Config } from "../config.js";
import { FACTORY_HOME, flowDir, parseFlow } from "../flow/load.js";
import type { Flow, Step } from "../flow/schema.js";

const ZERO = "0000000000000000000000000000000000000000";

const PRE_PUSH = `#!/bin/sh
# Installed by Spaghetti Code Foundry: refuse pushes to protected branches, and pushes that add secrets.
while read local_ref local_sha remote_ref remote_sha; do
  branch=\${remote_ref#refs/heads/}
  set -f
  # The one exception: the hotfix merge step may push (not delete) the branch it was granted. FACTORY_PUSH_ALLOW
  # is "<branch>:<token>"; it counts only when the engine wrote that token (a file next to this hook) for the
  # running step, so a step that just sets the variable itself gets nothing.
  allowed=0
  if [ -n "$FACTORY_PUSH_ALLOW" ] && [ "$local_sha" != "${ZERO}" ]; then
    allow_branch=\${FACTORY_PUSH_ALLOW%%:*}; allow_token=\${FACTORY_PUSH_ALLOW#*:}
    case "$allow_token" in ""|*[!0-9a-f]*) ;; *)
      [ "$allow_branch" = "$branch" ] && [ "$(cat "$(dirname "$0")/allow/$allow_token" 2>/dev/null)" = "$branch" ] && allowed=1 ;;
    esac
  fi
  if [ "$allowed" != 1 ]; then
    for pattern in $FACTORY_PROTECTED_BRANCHES; do
      case "$branch" in
        $pattern) echo "Spaghetti Code Foundry: pushing to protected branch '$branch' is blocked" >&2; exit 1 ;;
      esac
    done
  fi
  set +f
  if [ -n "$FACTORY_SECRET_SCAN" ] && [ "$local_sha" != "${ZERO}" ]; then
    if [ "$remote_sha" = "${ZERO}" ]; then
      "$FACTORY_SECRET_SCAN" "$local_sha" --not --remotes || exit 1
    else
      "$FACTORY_SECRET_SCAN" "$remote_sha..$local_sha" || exit 1
    fi
  fi
done
exit 0
`;

/**
 * Env that makes every git command in the run use our pre-push hook, which refuses
 * pushes to protected branches and (with secretScan) pushes whose new commits contain
 * secrets. GIT_CONFIG_* applies to all git processes, including the ones agents start.
 * Note: this replaces the repo's own git hooks during runs.
 */
export function protectedBranchEnv(patterns: string[], secretScan = false): Record<string, string> {
  if (!patterns.length && !secretScan) return {};
  const dir = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "hooks");
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  writeFileSync(hook, PRE_PUSH);
  chmodSync(hook, 0o755);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: dir,
    FACTORY_PROTECTED_BRANCHES: patterns.join(" "),
    ...(secretScan ? { FACTORY_SECRET_SCAN: join(TOOLS_DIR, "secret-scan") } : {}),
  };
}

// ── Hotfixes: the one push to a protected branch ──

/** The flow and the step that may push to main: only the merge step of the unchanged built-in issue-gitflow. */
export const HOTFIX_FLOW = "issue-gitflow";
export const HOTFIX_PUSH_STEP = "push_main";

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

let shipped: string | undefined;
function shippedGitflow(): string | undefined {
  if (shipped !== undefined) return shipped;
  const file = join(flowDir("builtin", ""), `${HOTFIX_FLOW}.yaml`);
  if (!existsSync(file)) return undefined;
  return (shipped = canonical(parseFlow(readFileSync(file, "utf8"), file)));
}

/**
 * Is the hotfix path allowed for this run? "off": the setting is off. "other": the flow is not the
 * built-in issue-gitflow (any changed step, variable default, limit or sandbox counts as changed).
 * "on": the setting is on and the flow is the shipped one. Fails closed.
 */
export function hotfixState(flow: Flow, config: Pick<Config, "hotfix_to_main">): "on" | "off" | "other" {
  if (!config.hotfix_to_main) return "off";
  try {
    const want = shippedGitflow();
    return want !== undefined && flow.name === HOTFIX_FLOW && canonical(flow) === want ? "on" : "other";
  } catch {
    return "other";
  }
}

/** Branch names the exception may name: plain names, no glob characters, no spaces or shell syntax. */
const PUSH_ALLOW_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** FACTORY_PUSH_ALLOW for a step: set only for push_main of the unchanged shipped flow (top level). */
export function pushAllowEnv(step: Pick<Step, "id">, depth: number, vars: Record<string, string>, state: "on" | "off" | "other"): Record<string, string> {
  const branch = vars.main_branch ?? "";
  if (step.id !== HOTFIX_PUSH_STEP || depth !== 0 || state !== "on" || !PUSH_ALLOW_OK.test(branch)) return {};
  return { FACTORY_PUSH_ALLOW: branch };
}

/**
 * Let one step push `branch` past the hook: writes a one-time token the hook checks and returns the
 * FACTORY_PUSH_ALLOW value for that step. Call revoke() when the step ends.
 */
export function grantPush(branch: string): { env: Record<string, string>; revoke: () => void } {
  const dir = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "hooks", "allow");
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const file = join(dir, token);
  writeFileSync(file, branch, { mode: 0o600 });
  return { env: { FACTORY_PUSH_ALLOW: `${branch}:${token}` }, revoke: () => rmSync(file, { force: true }) };
}

// ── The architect reads with the repository's own token ──

/** The flow whose clone and issue list get the stored token (a literal: src/flow/usage.ts would make an import cycle; a test pins it). */
export const REPO_READ_FLOW = "refine-brief";
export const REPO_READ_STEPS: readonly string[] = ["clone", "list_issues"];
export const TOKEN_REFUSED_REASON = "GitHub refused the token of this repository; check its access to Contents and Issues, or set a new token under My repositories";

/** The run fails with this when a token step is refused (not a refinement run). */
export const TOKEN_REFUSED_RUN = "GitHub refused the token of this repository; reconnect the repository under My repositories";

/** Messages of gh and git for a token that GitHub did not accept or that cannot reach the repository. */
const TOKEN_REFUSED = new RegExp(
  [
    "HTTP 401",
    "Bad credentials",
    "Could not resolve to a Repository",
    "Resource not accessible by (?:personal access token|integration)",
    "SAML enforcement",
    "SAML SSO",
    "forbids access via a (?:fine-grained )?personal access token",
    "Authentication failed for",
    "Invalid username or (?:password|token)",
    "Repository not found",
    "repository '.*' not found",
    "Write access to repository not granted",
    "Permission to .* denied",
    "The requested URL returned error: 40[13]",
    "terminal prompts disabled",
  ].join("|"),
  "i",
);

// ── A deploy key or the GitHub App in a run: fixed sentences (never text of GitHub, a key path or a token) ──

export const KEY_REFUSED_RUN = "GitHub refused the deploy key of this repository; reconnect the repository under My repositories";
export const APP_REFUSED_RUN = "GitHub refused the app's token for this repository; reconnect the repository under My repositories";
export const DEPLOY_KEY_NO_GH = "a deploy key gives git access only; choose a token or the GitHub App under My repositories";
export const APP_NOT_SET_UP_RUN = "the GitHub App is not set up on this server; ask an admin, or choose a token under My repositories";
export const APP_NOT_INSTALLED_RUN = "the GitHub App is not installed on this repository; install it, then press Test connection under My repositories";
export const APP_BROKEN_RUN = "the GitHub App of this server is not working; ask an admin to check the GitHub App settings";
export const KEY_NOT_READY = "the deploy key could not be made ready for the step; resume the run to try the step again";
export const APP_UNREACHABLE_RUN = "GitHub could not be reached for the app's token; resume the run to try the step again";
export const APP_RATE_LIMIT_RUN = "GitHub's request limit is used up, so no app token could be made; wait a while, then resume the run";
export const APP_FAILED_RUN = "the app's token could not be made; resume the run to try the step again";
export const APP_TOKEN_EXPIRED = "the app's token ran out during the step (a token lives one hour); resume the run to get a new one";
export const SIGN_IN_NOT_REMOVED = "the sign-in folder of this run could not be removed; ask an admin to delete the folder \"sign-in\" in the run folder, then resume the run";

/** Every sentence above that failure.ts, errors.ts and the architect must recognise as it is. */
export const SIGN_IN_SENTENCES: readonly string[] = [
  KEY_REFUSED_RUN, APP_REFUSED_RUN, DEPLOY_KEY_NO_GH, APP_NOT_SET_UP_RUN, APP_NOT_INSTALLED_RUN, APP_BROKEN_RUN,
  KEY_NOT_READY, APP_UNREACHABLE_RUN, APP_RATE_LIMIT_RUN, APP_FAILED_RUN, APP_TOKEN_EXPIRED, SIGN_IN_NOT_REMOVED,
];

/** What git and ssh say when a host does not accept a deploy key (or the key has no access). Narrower than classifyGit: test output must not match. */
const KEY_REFUSED = /Permission denied \(publickey|ERROR: Permission to .* denied|Repository not found|Write access to repository not granted|key you are authenticating with has been marked as read only/i;

/** Did a command fail because the host refused the deploy key? */
export const keyRefused = (output: string): boolean => KEY_REFUSED.test(output);

/** Did a command fail because GitHub refused the token? A rate limit is not a refusal. */
export const tokenRefused = (output: string): boolean => TOKEN_REFUSED.test(output) && !/rate limit|abuse detection/i.test(output);

/** The grant: the clone and the issue list of the unchanged name `refine-brief`, at the top level, in a run the server started for a refinement session. */
export function isRepoReadStep(step: Pick<Step, "id">, depth: number, flowName: string, source: string | undefined): boolean {
  return flowName === REPO_READ_FLOW && REPO_READ_STEPS.includes(step.id) && depth === 0 && isRefinementRun(source);
}

// ── The running Foundry's own build ──

const selfCache = new Map<string, { sha: string; repo: string } | undefined>();

/**
 * The commit a checkout was at when first asked (once per process) and its GitHub repository as
 * "owner/name" in lower case. Undefined for a folder that is not a git checkout with a GitHub origin.
 */
export const selfDir = (): string => process.env.FACTORY_SELF_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function selfBuild(dir = selfDir()): { sha: string; repo: string } | undefined {
  if (selfCache.has(dir)) return selfCache.get(dir);
  let found: { sha: string; repo: string } | undefined;
  try {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const sha = git("rev-parse", "HEAD");
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(git("remote", "get-url", "origin"));
    if (/^[0-9a-f]{40}$/.test(sha) && m) found = { sha, repo: `${m[1]}/${m[2]}`.toLowerCase() };
  } catch {
    // not a git checkout, or no origin
  }
  selfCache.set(dir, found);
  return found;
}

const containsYes = new Set<string>();

/**
 * Does the running build (the commit `selfBuild()` read) contain this commit? False for anything but 40 lower-case hex digits,
 * when the build is unknown, and on any error. Only a "yes" is remembered: a "no" is asked again at the next check.
 */
export function selfContains(commit: string, dir = selfDir()): boolean {
  if (!/^[0-9a-f]{40}$/.test(commit)) return false;
  const key = `${dir}\0${commit}`;
  if (containsYes.has(key)) return true;
  const build = selfBuild(dir);
  if (!build) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, build.sha], { cwd: dir, stdio: "ignore", timeout: 10_000 });
    containsYes.add(key);
    return true;
  } catch {
    return false;
  }
}

/** FACTORY_SELF_SHA and FACTORY_SELF_REPO for steps ("" when unknown). */
export function selfEnv(): Record<string, string> {
  const b = selfBuild();
  return { FACTORY_SELF_SHA: b?.sha ?? "", FACTORY_SELF_REPO: b?.repo ?? "" };
}

// ── GitHub App installation tokens ──

export { appJwt };

/** Env for acting as the bot: git author/committer and the token gh (and git via gh) uses. */
export async function identityEnv(config: Config): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const { name, email, gh_token_env } = config.bot;
  if (name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
  if (email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email;
  if (config.github_app?.installation_id) env.GH_TOKEN = await installationToken(config.github_app, config.github_app.installation_id);
  else if (gh_token_env) {
    const t = process.env[gh_token_env];
    if (!t) throw new Error(`bot.gh_token_env is "${gh_token_env}" but that env var is not set`);
    env.GH_TOKEN = t;
  }
  return env;
}

// ── Docker sandbox for shell steps ──

/** Wrap a shell command so it runs in a container with only the workspace mounted. */
export const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tools");

export function dockerCommand(image: string, workdir: string, command: string, envNames: string[]): { cmd: string; args: string[] } {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const args = [
    "run", "--rm", "-i",
    "--user", `${uid}:${gid}`,
    "-v", `${workdir}:/work`,
    "-v", `${TOOLS_DIR}:/factory-tools:ro`,
    "-w", "/work",
    "-e", "HOME=/tmp",
    "-e", "FACTORY_TOOLS=/factory-tools",
    "-e", "SCF_TOOLS=/factory-tools",
    ...envNames.filter((n) => n !== "FACTORY_TOOLS" && n !== "SCF_TOOLS").flatMap((n) => ["-e", n]), // values come from our env, not the command line
    image, "sh", "-c", command,
  ];
  return { cmd: "docker", args };
}
