import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { noMachineSignIn } from "../engine/isolation.js";
import { ownDir } from "../engine/os-sandbox.js";
import { shortEnv } from "../engine/short-env.js";
import type { Config, ProviderConfig } from "../config.js";
import type { PolicyDecision } from "../policy/schema.js";
import { checkToolCall } from "../tool-profile/resolve.js";
import type { ToolProfile } from "../tool-profile/schema.js";
import { CODEX_LOGIN_FILE, CODEX_LOGIN_NOT_RETURNED, lendCodexLogin, returnCodexLogin, type CodexLoginReturn } from "./codex-login.js";

export const CODEX_HOME_UNKNOWN = "the Codex folder of that session is not known (it ran before this version)";
export const CODEX_HOME_CHANGED = "it ran in another Codex folder (the sandbox, the isolation mode or CODEX_HOME changed)";

/** The person's own Codex folder: CODEX_HOME, else ~/.codex. */
export function personalCodexDir(o: { codexHome?: string; home?: string }): string {
  return resolve(o.codexHome || join(o.home ?? homedir(), ".codex"));
}

/** Which Codex folder a session used: "run" (the run's own folder) or "personal:<12 hex>" (a fingerprint of the path, never the path). */
export function codexHomeId(o: { run: boolean; codexHome?: string; home?: string }): string {
  if (o.run) return "run";
  return "personal:" + createHash("sha256").update(personalCodexDir(o)).digest("hex").slice(0, 12);
}

/** Why a step must not resume a session recorded with `recorded`; undefined when it may. */
export function codexResumeRefusal(recorded: unknown, now: string): string | undefined {
  if (typeof recorded !== "string" || recorded === "") return CODEX_HOME_UNKNOWN;
  return recorded === now ? undefined : CODEX_HOME_CHANGED;
}

export type CodexIsolation = "off" | "private" | "login";

/** off: not isolated. private: a local model or a key, so the run's clean Codex folder holds no login. login: the run's clean folder with a copy of the Codex login only. */
export function codexIsolationMode(o: { isolate: boolean; local: boolean; hasKey: boolean }): CodexIsolation {
  if (!o.isolate) return "off";
  return o.local || o.hasKey ? "private" : "login";
}

/** Runs started by the server (UI, watchers, evaluations) are always isolated; CLI runs and runs without a source follow `isolate`. */
export function codexMustIsolate(o: { source?: string; isolate: boolean }): boolean {
  return o.isolate || Boolean(o.source && o.source !== "cli");
}

export const CODEX_HOME_REFUSED = "Codex isolation: ";

/** The name of the command rules file the Foundry writes, and its text. */
export const CODEX_PUSH_RULES = "foundry.rules";
export const CODEX_PUSH_RULES_TEXT = `# Written by Spaghetti Code Foundry for this run: pushing is done by the flow, never by the agent.
prefix_rule(
    pattern = ["git", "push"],
    decision = "forbidden",
)
`;

/** What is removed from the clean Codex folder before every session: every file that can carry configuration. */
export const CODEX_CONFIG_ENTRIES: readonly string[] = ["config.toml", "managed_config.toml", ".env", "AGENTS.md", "AGENTS.override.md", "skills", "rules", "plugins", "hooks", "hooks.json", "prompts"];

/** Makes the clean Codex folder of a run and empties it of configuration. `sessions/` and other state stay, so a session can be resumed. */
export function cleanCodexHome(
  runDir: string,
  o: { push: boolean; login: boolean },
  make: (path: string) => void = ownDir,
): { CODEX_HOME: string; HOME: string; GH_CONFIG_DIR: string } | { refused: string } {
  const home = join(runDir, "home");
  const dir = join(home, ".codex");
  const gh = join(home, ".config", "gh");
  try {
    make(home);
    make(dir);
    // rm on the entry itself: a link is removed, never followed
    for (const name of CODEX_CONFIG_ENTRIES) rmSync(join(dir, name), { recursive: true, force: true });
    rmSync(join(home, ".agents"), { recursive: true, force: true });
    rmSync(join(dir, "." + CODEX_LOGIN_FILE + ".tmp"), { recursive: true, force: true });
    if (!o.login) rmSync(join(dir, CODEX_LOGIN_FILE), { recursive: true, force: true });
    const rules = join(dir, "rules");
    make(rules);
    if (!o.push) {
      const file = join(rules, CODEX_PUSH_RULES);
      const tmp = join(rules, "." + CODEX_PUSH_RULES + ".tmp");
      rmSync(tmp, { force: true });
      writeFileSync(tmp, CODEX_PUSH_RULES_TEXT, { flag: "wx", mode: 0o600 });
      renameSync(tmp, file);
    }
    make(join(home, ".config"));
    rmSync(gh, { recursive: true, force: true });
    make(gh);
  } catch {
    return { refused: CODEX_HOME_REFUSED + "the clean Codex folder could not be made" };
  }
  // HOME too: Codex also reads personal skills from $HOME/.agents/skills, whatever CODEX_HOME is
  return { CODEX_HOME: dir, HOME: home, GH_CONFIG_DIR: gh };
}

/** May this session push? Only when the profile grants `git push` on the repository and the policy allows it. No policy is evaluated at run time yet, so today this is false. */
export function codexPushAllowed(profile: ToolProfile | undefined, repository: string | undefined, policy?: Pick<PolicyDecision, "outcome">): boolean {
  if (!profile || !repository || policy?.outcome !== "allow") return false;
  try {
    return checkToolCall(profile, { kind: "git", operation: "push", target: repository }).outcome === "allow";
  } catch {
    return false;
  }
}

/** A clean Codex session with no OS sandbox and no Codex sandbox cannot be kept from pushing. */
export const CODEX_PUSH_UNHELD = CODEX_HOME_REFUSED + "a Codex step with bypassPermissions and no sandbox could push: set sandbox: true or another permission_mode";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface PrepareCleanCodex {
  runDir: string;
  env: Record<string, string | undefined>;
  config: Pick<Config, "bot" | "step_env" | "providers">;
  kind: ProviderConfig["kind"];
  short: boolean;
  isolated: boolean;
  boxed: boolean;
  mode: CodexIsolation | undefined;
  sandbox: CodexSandboxMode;
  /** The person's own Codex folder (where the login is). */
  personal: string;
  /** The tool profile of the session: it decides whether the session may push. */
  profile: ToolProfile;
  /** The repository the run works on, as "owner/name". */
  repo?: string;
}

export interface CleanCodex {
  env: Record<string, string | undefined>;
  cleanEnv: boolean;
  push: boolean;
  /** Returns the login copy after the session. */
  done: () => CodexLoginReturn;
}

/**
 * Makes the clean Codex folder of a session (cleaned again before every session) and the environment it runs in. A
 * refusal is final; `access` is set when no login could be lent.
 */
export function prepareCleanCodex(o: PrepareCleanCodex): CleanCodex | { refused: string; access?: boolean } {
  const push = codexPushAllowed(o.profile, o.repo);
  if (!push && !o.boxed && o.sandbox === "danger-full-access") return { refused: CODEX_PUSH_UNHELD };
  const login = o.mode === "login";
  if (!login) {
    const back = returnCodexLogin(o.runDir);
    if (back === "write-back-failed" || back === "not-removed") return { refused: CODEX_HOME_REFUSED + CODEX_LOGIN_NOT_RETURNED };
  }
  const made = cleanCodexHome(o.runDir, { push, login });
  if ("refused" in made) return { refused: made.refused };
  let env = o.env;
  let cleanEnv = o.short;
  if (!o.boxed) {
    env = { ...env, CODEX_HOME: made.CODEX_HOME, HOME: made.HOME };
    if (!o.short) env = shortEnv(env, o.config, { agent: "codex", kind: o.kind });
    cleanEnv = true;
    if (!o.isolated) env = { ...env, ...noMachineSignIn(o.config, made.GH_CONFIG_DIR) };
  }
  if (login) {
    const lent = lendCodexLogin(o.runDir, o.personal);
    if ("refused" in lent) return { refused: lent.refused, access: true };
  }
  return { env, cleanEnv, push, done: () => returnCodexLogin(o.runDir) };
}

/** The log line of a mode; undefined for "off". */
export function codexIsolationLine(mode: CodexIsolation): string | undefined {
  switch (mode) {
    case "private": return "Codex: a clean Codex folder for this run (no personal config, MCP servers, plugins, hooks, skills, AGENTS.md, command rules or machine sign-ins); it signs in with a key or a local model";
    case "login": return "Codex: a clean Codex folder for this run with a copy of the Codex login only (no personal config, MCP servers, plugins, hooks, skills, AGENTS.md, command rules or machine sign-ins); the copy is removed after the session";
    default: return undefined;
  }
}

/** The log line (with its mark) for what happened to the lent login; undefined when there is nothing to say. Never holds a path or content. */
export function codexLoginReturnLine(r: CodexLoginReturn): string | undefined {
  switch (r) {
    case "written-back": return "· Codex: the refreshed Codex login was written back to the personal Codex folder";
    case "write-back-failed": return "! Codex: the refreshed Codex login could not be written back; the copy stays in this run and is tried again";
    case "not-removed": return "! Codex: the copy of the Codex login in this run could not be removed";
    default: return undefined;
  }
}

export const CODEX_PUSH_BLOCKED_LINE = "Codex: git push is blocked in this session (a Foundry command rule, no sign-in and no network)";
