import { join } from "node:path";
import { ownDir } from "../engine/os-sandbox.js";
import { LOCAL_KINDS, type Target } from "./targets.js";

/**
 * Agent steps of a user's run that is held by the OS sandbox ("boxed"): they sign in by a token variable of the server only,
 * and keep their own agent folders in the run folder. The Mac's own agent login, files and Keychain are out of reach.
 */

/** The sentence for a step that has no key. */
export const noAgentKey = (name: string): string =>
  `This agent has no key on this server. An admin must set ${name} for the server; a user's run cannot use the Mac's own agent login.`;

/** The variable names that would sign this target in, for the sentence. */
export function agentKeyNames(t: Target): string {
  if (t.agent === "codex") return "OPENAI_API_KEY or CODEX_API_KEY";
  if (t.provider.kind === "anthropic-compatible") return t.provider.api_key_env ?? `api_key_env for the ${t.providerName} provider`;
  return "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN";
}

const has = (env: Record<string, string | undefined>, name: string): boolean => Boolean(env[name]);

/**
 * The sentence when the environment this step would really get holds no key for its agent and provider, else undefined.
 * Local providers need none. For Claude on a compatible provider, `claudeProviderEnv` already put the key (or "none") in ANTHROPIC_AUTH_TOKEN.
 */
export function missingAgentKey(t: Target, env: Record<string, string | undefined>): string | undefined {
  const kind = t.provider.kind;
  if (LOCAL_KINDS.includes(kind)) return undefined;
  let ok: boolean;
  if (t.agent === "codex") ok = has(env, "OPENAI_API_KEY") || has(env, "CODEX_API_KEY");
  else if (kind === "anthropic-compatible") ok = Boolean(t.provider.api_key_env) && has(env, "ANTHROPIC_AUTH_TOKEN") && env.ANTHROPIC_AUTH_TOKEN !== "none";
  else ok = has(env, "CLAUDE_CODE_OAUTH_TOKEN") || has(env, "ANTHROPIC_API_KEY") || has(env, "ANTHROPIC_AUTH_TOKEN");
  return ok ? undefined : noAgentKey(agentKeyNames(t));
}

/** The private agent folders of a run (after `sandboxHomeEnv` made `home`). They start empty and are the same for every step of the run. */
export function agentHomeEnv(runDir: string): { CLAUDE_CONFIG_DIR: string; CODEX_HOME: string } {
  const claude = join(runDir, "home", ".claude");
  const codex = join(runDir, "home", ".codex");
  ownDir(claude);
  ownDir(codex);
  return { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
}

/** Codex reads CODEX_API_KEY; when only OPENAI_API_KEY is set, pass its value as CODEX_API_KEY too. */
export function codexKeyEnv(t: Target, env: Record<string, string | undefined>): Record<string, string> {
  if (t.agent !== "codex" || t.provider.kind !== "openai" || has(env, "CODEX_API_KEY") || !env.OPENAI_API_KEY) return {};
  return { CODEX_API_KEY: env.OPENAI_API_KEY };
}

/** Removes the named variables from `extra` (a flow's `agent_env`); returns the names removed. */
export function dropLoginVars(extra: Record<string, string>, names: readonly string[]): string[] {
  const dropped: string[] = [];
  for (const n of names) {
    if (n in extra) {
      delete extra[n];
      dropped.push(n);
    }
  }
  return dropped;
}

/** Only a local model is free in a boxed run: Codex there signs in by key and is paid. */
export const freeWhenBoxed = (t: Target): boolean => LOCAL_KINDS.includes(t.provider.kind);
