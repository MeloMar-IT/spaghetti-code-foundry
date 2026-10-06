import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RepoAccess, repoAccess } from "../auth/repos.js";
import { isRefinementRun } from "../auth/run-owner.js";
import type { Config } from "../config.js";
import type { Step } from "../flow/schema.js";
import { GithubAppError, installationTokenInfo, repoApp } from "../github-app.js";
import { sshKeyEnv } from "../repos/connect.js";
import { APP_BROKEN_RUN, APP_FAILED_RUN, APP_NOT_INSTALLED_RUN, APP_NOT_SET_UP_RUN, APP_RATE_LIMIT_RUN, APP_REFUSED_RUN, APP_UNREACHABLE_RUN, DEPLOY_KEY_NO_GH, isRepoReadStep } from "./guards.js";
import type { RunSummary } from "./state.js";

/** The helper git calls for a password: it answers only the "get" call, from the step's environment. */
export const HELPER = '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$SCF_GIT_USERNAME" "$SCF_GIT_PASSWORD"; }; f';

type StepFlags = Pick<Step, "id"> & { type?: string; repo_access?: boolean };

/** Does this step sign in with the stored token of its repository? The flag, or (for runs saved before it) the grant by name. */
export function wantsRepoAccess(step: StepFlags, depth: number, flowName: string, source: string | undefined): boolean {
  return (step.type === "shell" && step.repo_access === true) || isRepoReadStep(step, depth, flowName, source);
}

/**
 * What the step may use: undefined when it is not a token step, or when the run has no owner and is no refinement run
 * (as before the owners existed). Looked up now, so a changed token is used by the next step.
 */
export function stepRepoAccess(
  step: StepFlags,
  depth: number,
  flowName: string,
  summary: Pick<RunSummary, "source" | "owner">,
  vars: Record<string, string>,
): RepoAccess | undefined {
  if (!wantsRepoAccess(step, depth, flowName, summary.source)) return undefined;
  const refinement = isRefinementRun(summary.source);
  if (!summary.owner && !refinement) return undefined;
  return repoAccess(summary.owner, vars.github_repo ?? "", { unlisted: refinement ? "refuse" : "admin-server" });
}

/** A new, empty folder for `gh` (its own settings and saved sign-ins are not used). Remove it when the step ends. */
export const ghConfigDir = (): string => mkdtempSync(join(tmpdir(), "scf-gh-"));

export const removeGhConfigDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/** What makes `gh` use only this token: it replaces the host's variables, gh gets an empty settings folder. `undefined` removes a variable. */
export function ghTokenEnv(token: string, ghDir = ""): Record<string, string | undefined> {
  return {
    GH_TOKEN: token,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_HOST: "github.com",
    ...(ghDir ? { GH_CONFIG_DIR: ghDir } : {}),
    GH_PROMPT_DISABLED: "1",
  };
}

/**
 * The env that makes a step use only the stored token: it replaces the bot's GH_TOKEN, gh gets an empty settings folder,
 * and git ignores the server's settings and speaks https only. The credential helper is added after the engine's own
 * GIT_CONFIG entries (core.hooksPath stays). Nothing for the server's own access. `undefined` removes an inherited variable.
 */
export function repoTokenEnv(access: RepoAccess, env: Record<string, string>, ghDir = ""): Record<string, string | undefined> {
  if (access.kind !== "token") return {};
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  let origin = "https://github.com";
  try {
    const u = new URL(access.url);
    if (u.protocol === "https:") origin = u.origin;
  } catch {
    // keep github.com
  }
  return {
    GIT_TRACE: undefined,
    GIT_TRACE_PACKET: undefined,
    GIT_TRACE_CURL: undefined,
    GIT_TRACE_CURL_NO_DATA: undefined,
    GIT_CURL_VERBOSE: undefined,
    GIT_TRACE_REDACT: "1",
    ...ghTokenEnv(access.token, ghDir),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS: "",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    LC_ALL: "C", // a refusal is recognised by its English text
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: String(n + 3),
    // an empty value clears every helper read so far (the workspace's .git/config); then ours, for this host only
    [`GIT_CONFIG_KEY_${n}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${n}`]: "",
    [`GIT_CONFIG_KEY_${n + 1}`]: `credential.${origin}.helper`,
    [`GIT_CONFIG_VALUE_${n + 1}`]: HELPER,
    // no extra header (an Authorization header) from the workspace's .git/config
    [`GIT_CONFIG_KEY_${n + 2}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${n + 2}`]: "",
    SCF_GIT_USERNAME: access.username,
    SCF_GIT_PASSWORD: access.token,
    FACTORY_REPO_URL: access.url,
    SCF_REPO_URL: access.url,
  };
}

// ── The GitHub App: a new token for one step ──

export type AppTokenResult = { ok: true; token: string; expires: number } | { ok: false; reason: string };

/**
 * A new installation token limited to the repository, for one step. Never cached, never stored. A failure is a fixed sentence:
 * no text of GitHub, no request, no key path.
 */
export async function appTokenAccess(access: Extract<RepoAccess, { kind: "app" }>, config: Pick<Config, "github_app">, timeoutMs = 20_000): Promise<AppTokenResult> {
  const app = repoApp(config);
  if (!app) return { ok: false, reason: APP_NOT_SET_UP_RUN };
  try {
    const t = await installationTokenInfo(app, access.installationId, { repository: access.github.split("/")[1], fresh: true, timeoutMs });
    return { ok: true, ...t };
  } catch (e) {
    if (!(e instanceof GithubAppError)) return { ok: false, reason: APP_FAILED_RUN };
    if (e.code === "key") return { ok: false, reason: APP_BROKEN_RUN };
    if (e.code === "unreachable") return { ok: false, reason: APP_UNREACHABLE_RUN };
    if (e.code === "answer") return { ok: false, reason: APP_FAILED_RUN };
    if (e.rateLimited) return { ok: false, reason: APP_RATE_LIMIT_RUN };
    if (e.status === 401) return { ok: false, reason: APP_BROKEN_RUN };
    if (e.status === 404 || e.status === 422) return { ok: false, reason: APP_NOT_INSTALLED_RUN };
    if (e.status === 403) return { ok: false, reason: APP_REFUSED_RUN };
    return { ok: false, reason: APP_FAILED_RUN };
  }
}

// ── The deploy key: a folder in the run folder, only while the step runs ──

export const signInDir = (runDir: string): string => join(runDir, "sign-in");

/** When a process started, as `ps` prints it ("" when that cannot be told). */
export function processStart(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

const rmTree = (path: string): void => rmSync(path, { recursive: true, force: true });

/**
 * Removes the sign-in folder of a run. A link is removed as a link (what it points to stays). The key goes first; when the
 * folder cannot be emptied, its mode is set back once and it is tried again. Returns false (never throws) when something is left.
 */
export function removeSignInDir(runDir: string, rm: (path: string) => void = rmTree): boolean {
  const dir = signInDir(runDir);
  try {
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        unlinkSync(dir);
        return true;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw e;
    }
    const attempt = () => {
      try {
        rm(join(dir, "key"));
      } catch {
        // the folder is removed next; that decides
      }
      rm(dir);
    };
    try {
      attempt();
    } catch {
      chmodSync(dir, 0o700);
      attempt();
    }
    return !existsSync(dir);
  } catch {
    return false;
  }
}

const standIn = (marker: string) =>
  `#!/bin/sh\n# Stand-in for gh in a step that signs in with a deploy key: it gives git access only.\n: > ${JSON.stringify(marker)}\nprintf '%s\\n' '${DEPLOY_KEY_NO_GH}' >&2\nexit 1\n`;

/**
 * Makes the sign-in folder (0700) with the key (0600), the holder note and the `gh` stand-in, and returns the step's env and the
 * stand-in's marker. Throws when something cannot be written; the caller then removes the folder.
 */
export function prepareKeyStep(access: Extract<RepoAccess, { kind: "key" }>, runDir: string, env: Record<string, string>, ghDir = ""): { env: Record<string, string | undefined>; marker: string } {
  const dir = signInDir(runDir);
  if (!removeSignInDir(runDir)) throw new Error("a sign-in folder is left");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const ssh = sshKeyEnv(dir, access.key);
  writeFileSync(join(dir, "holder"), `${process.pid}\n${processStart(process.pid)}\n`, { mode: 0o600 });
  const bin = join(dir, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const marker = join(dir, "gh-called");
  writeFileSync(join(bin, "gh"), standIn(marker), { mode: 0o700 });
  chmodSync(join(bin, "gh"), 0o700);
  return { env: repoKeyEnv(access, env, ssh, `${bin}:${env.PATH ?? process.env.PATH ?? ""}`, marker, ghDir), marker };
}

/**
 * The env that makes a step use only the deploy key: git ignores the agent, the account's ssh files and the server's settings
 * and speaks ssh only; there is no GH_TOKEN (the `gh` stand-in answers instead). `undefined` removes an inherited variable.
 */
export function repoKeyEnv(
  access: Extract<RepoAccess, { kind: "key" }>,
  env: Record<string, string>,
  ssh: { SCF_SSH_KEY: string; SCF_KNOWN_HOSTS: string; GIT_SSH_COMMAND: string },
  path: string,
  marker: string,
  ghDir = "",
): Record<string, string | undefined> {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  return {
    ...ssh,
    SSH_AUTH_SOCK: undefined,
    GIT_SSH: undefined,
    GIT_TRACE: undefined,
    GIT_TRACE_PACKET: undefined,
    GIT_TRACE_CURL: undefined,
    GIT_CURL_VERBOSE: undefined,
    GH_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_HOST: "github.com",
    ...(ghDir ? { GH_CONFIG_DIR: ghDir } : {}),
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS: "",
    GIT_ALLOW_PROTOCOL: "ssh",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    LC_ALL: "C",
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "credential.helper", // no helper from the workspace's .git/config
    [`GIT_CONFIG_VALUE_${n}`]: "",
    PATH: path,
    SCF_NO_GH_MARKER: marker,
    FACTORY_REPO_URL: access.url,
    SCF_REPO_URL: access.url,
  };
}

/** Did a step call the `gh` stand-in? Read it before the folder is removed. */
export const ghStandInCalled = (marker: string): boolean => existsSync(marker);

/** Does this holder note name a process that still runs as the one that wrote it? An unknown start time counts as alive. */
function holderAlive(dir: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(dir, "holder"), "utf8");
  } catch {
    return false;
  }
  const [pidText = "", start = ""] = text.split("\n");
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const now = processStart(pid);
  return !start || !now || start === now;
}

/**
 * At server start: removes the sign-in folder of every run whose holder does not run any more (or has no holder note).
 * A pid that was reused by another process has another start time. Counts what was removed and what could not be.
 */
export function sweepSignInDirs(runsDir: string): { removed: number; failed: number } {
  const out = { removed: 0, failed: 0 };
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const runDir = join(runsDir, name);
    const dir = signInDir(runDir);
    let link: boolean;
    try {
      link = lstatSync(dir).isSymbolicLink();
    } catch {
      continue;
    }
    if (!link && holderAlive(dir)) continue;
    if (removeSignInDir(runDir)) out.removed++;
    else out.failed++;
  }
  return out;
}
