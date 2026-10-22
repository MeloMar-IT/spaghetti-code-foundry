import { hasStoredSignIn } from "../auth/repos.js";
import { getUser } from "../auth/users.js";
import type { Config } from "../config.js";
import type { Engine } from "./execute.js";
import { NO_COMMIT_IDENTITY } from "./guards.js";

export type CommitIdentity = { name: string; email: string };

/** The variables that carry a commit name. A sandboxed step is given these by name. */
export const IDENTITY_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;

/** Names an `agent_env` may not set in an isolated step: the login, git settings, ssh and the config folders of the machine. */
export const ISOLATED_AGENT_ENV = /^(GH_.*|GITHUB_.*|GIT_.*|SSH_.*|XDG_.*|LC_ALL)$/;

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** Does a run of this owner on this repository run without the machine's login? Fails closed. */
export function stepIsolated(owner: string | undefined, githubRepo: string | undefined): boolean {
  if (!owner) return false;
  try {
    const user = getUser(owner);
    if (!user || user.role !== "admin") return true;
    return hasStoredSignIn(owner, githubRepo ?? "");
  } catch {
    return true;
  }
}

/** The owner's id when the owner is a user; undefined without an owner or for a readable admin. Fails closed like `stepIsolated`. */
export function userAccount(owner: string | undefined): string | undefined {
  if (!owner) return undefined;
  try {
    const user = getUser(owner);
    return user && user.role === "admin" ? undefined : owner;
  } catch {
    return owner;
  }
}

/** Why a user's run in the server's own folder stops before any step. */
export const INPLACE_REFUSED = "This flow works directly in the server's folder, so only an admin can run it.";

/** Why a user's run in a branch of the server's folder stops before any step. */
export const WORKTREE_REFUSED = "This flow works in a branch of the server's folder, so only an admin can run it.";

/** The reason a user's run of this workspace mode is refused; undefined when it may run. Fails closed like `userAccount`. */
export function workspaceRefused(workspace: string | undefined, owner: string | undefined): string | undefined {
  if (workspace !== "inplace" && workspace !== "worktree") return undefined;
  if (!userAccount(owner)) return undefined;
  return workspace === "inplace" ? INPLACE_REFUSED : WORKTREE_REFUSED;
}

/** Name and e-mail for commits: the bot's from Settings, else the owner's account (field by field). Undefined when one is missing. */
export function commitIdentity(config: Pick<Config, "bot">, owner: string | undefined): CommitIdentity | undefined {
  let user: CommitIdentity | undefined;
  try {
    user = owner ? getUser(owner) : undefined;
  } catch {
    user = undefined;
  }
  const name = config.bot.name || user?.name;
  const email = config.bot.email || user?.email;
  return name && email ? { name, email } : undefined;
}

/** Every variable that may hold a GitHub token: the usual ones, the bot's own and their FACTORY_ / SCF_ twins. */
export function tokenVarNames(config: Pick<Config, "bot">): string[] {
  const names = new Set(TOKEN_VARS);
  const own = config.bot.gh_token_env;
  if (own) {
    names.add(own);
    if (own.startsWith("FACTORY_")) names.add(`SCF_${own.slice(8)}`);
    else if (own.startsWith("SCF_")) names.add(`FACTORY_${own.slice(4)}`);
  }
  return [...names];
}

/** Variables that take the machine's sign-ins away from a process: tokens, ssh, git credential and config entries, and an empty `gh` folder. `undefined` removes an inherited variable. */
export function noMachineSignIn(config: Pick<Config, "bot">, ghDir: string): Record<string, string | undefined> {
  const tokens: Record<string, string | undefined> = {};
  for (const name of tokenVarNames(config)) tokens[name] = undefined;
  return {
    ...tokens,
    SSH_AUTH_SOCK: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    SSH_ASKPASS: undefined,
    GH_CONFIG_DIR: ghDir,
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS: "",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
  };
}

/**
 * Where the next `GIT_CONFIG_KEY_<n>` entry goes. A valid `GIT_CONFIG_COUNT` (digits, at most 1000) is used as it is;
 * a negative, non-numeric or huge one is replaced by the number of contiguous keys from 0, so a bad count from
 * `agent_env` can never cancel the entries we append (git reads every entry up to the count).
 */
export function nextConfigIndex(env: Record<string, string | undefined>): number {
  const raw = env.GIT_CONFIG_COUNT;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n <= 1000) return n;
  }
  let i = 0;
  while (env[`GIT_CONFIG_KEY_${i}`] !== undefined) i++;
  return i;
}

/** The env that takes every Git and GitHub sign-in away from an agent step; the machine's git settings stay. Applied after agent_env. `undefined` removes an inherited variable. Environment only, not an OS sandbox. */
export function agentNoSignInEnv(config: Pick<Config, "bot">, ghDir: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const tokens: Record<string, string | undefined> = {};
  for (const name of tokenVarNames(config)) tokens[name] = undefined;
  const n = nextConfigIndex(env);
  return {
    ...tokens,
    SSH_AUTH_SOCK: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    SSH_ASKPASS: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GH_CONFIG_DIR: ghDir,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${n}`]: "",
  };
}

/**
 * The env that makes a step act without the machine's login: no token, an empty `gh` folder, git without the machine's
 * settings, helpers, ssh agent and keys, no prompts, and the commit name. Added after the engine's own GIT_CONFIG entries
 * (core.hooksPath stays). `undefined` removes an inherited variable. This is the environment only, not an OS sandbox.
 */
export function isolationEnv(env: Record<string, string | undefined>, config: Pick<Config, "bot">, ghDir: string, who: CommitIdentity): Record<string, string | undefined> {
  const n = nextConfigIndex(env);
  return {
    ...noMachineSignIn(config, ghDir),
    GIT_TRACE: undefined,
    GIT_TRACE_PACKET: undefined,
    GIT_TRACE_CURL: undefined,
    GIT_CURL_VERBOSE: undefined,
    GIT_CONFIG_COUNT: String(n + 3),
    // a commit never guesses a name from the machine; no helper and no extra header from the workspace's .git/config
    [`GIT_CONFIG_KEY_${n}`]: "user.useConfigOnly",
    [`GIT_CONFIG_VALUE_${n}`]: "true",
    [`GIT_CONFIG_KEY_${n + 1}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${n + 1}`]: "",
    [`GIT_CONFIG_KEY_${n + 2}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${n + 2}`]: "",
    GIT_AUTHOR_NAME: who.name,
    GIT_COMMITTER_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_EMAIL: who.email,
  };
}

/**
 * How a step of this run acts: undefined with the machine's login; `{ who }` isolated, with the commit identity;
 * `{ refused }` isolated but nobody to commit as. `holds` is a step that gets the repository's own credential.
 */
export function stepIsolation(
  engine: Pick<Engine, "summary" | "config">,
  vars: Record<string, string>,
  holds = false,
): { who: CommitIdentity } | { refused: string } | undefined {
  const { owner } = engine.summary;
  if (!holds && !stepIsolated(owner, vars.github_repo)) return undefined;
  const who = commitIdentity(engine.config, owner);
  return who ? { who } : { refused: NO_COMMIT_IDENTITY };
}
