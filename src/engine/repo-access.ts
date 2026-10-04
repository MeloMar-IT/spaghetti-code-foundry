import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RepoAccess, repoAccess } from "../auth/repos.js";
import { isRefinementRun } from "../auth/run-owner.js";
import type { Step } from "../flow/schema.js";
import { isRepoReadStep } from "./guards.js";
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
    GH_TOKEN: access.token,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_HOST: "github.com",
    ...(ghDir ? { GH_CONFIG_DIR: ghDir } : {}),
    GH_PROMPT_DISABLED: "1",
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
