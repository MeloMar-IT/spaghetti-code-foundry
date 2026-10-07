import { KNOWN_KEY_VARS, providerKeyVars, type Agent } from "../agents/targets.js";
import { STEP_ENV_NAME, STEP_ENV_REFUSED, type Config, type ProviderConfig } from "../config.js";
import { inheritedEnv } from "../steps/process.js";
import { userAccount } from "./isolation.js";

/** What every step of a user's run inherits from the server: a short, fixed list of harmless names. */
export const SHORT_ENV: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "TZ", "TERM"];

/** Where the server keeps its data: tools of a step find the folder by these (and their SCF_ twins). */
export const SERVER_SETUP_ENV: readonly string[] = ["FACTORY_HOME", "FACTORY_LOCK_DIR", "SCF_HOME", "SCF_LOCK_DIR"];

/**
 * What an agent step inherits for its own login: exact names, no prefixes (a prefix would also pass unrelated secrets).
 * `own` is for the provider kind the agent logs in to itself (claude: anthropic, codex: openai), `other` for every kind.
 */
export const AGENT_ENV: Record<Agent, { own: readonly string[]; other: readonly string[] }> = {
  claude: { own: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"], other: ["CLAUDE_CONFIG_DIR"] },
  codex: { own: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"], other: ["CODEX_HOME"] },
};

const OWN_KIND: Record<Agent, ProviderConfig["kind"]> = { claude: "anthropic", codex: "openai" };

export type AgentNeed = { agent: Agent; kind: ProviderConfig["kind"] };

/** Does a run of this owner get the short environment? True for a user; fails closed like `userAccount`. */
export function shortEnvRun(owner: string | undefined): boolean {
  return userAccount(owner) !== undefined;
}

/** Entries of SCF_STEP_ENV_PASS / FACTORY_STEP_ENV_PASS (comma separated) that pass the setting's rule; others are ignored. */
export function serverPassList(env: NodeJS.ProcessEnv = process.env): string[] {
  const text = `${env.SCF_STEP_ENV_PASS ?? ""},${env.FACTORY_STEP_ENV_PASS ?? ""}`;
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((n) => n && STEP_ENV_NAME.test(n) && !STEP_ENV_REFUSED.test(n));
}

const matches = (list: readonly string[], name: string) => list.some((e) => (e.endsWith("_*") ? name.startsWith(e.slice(0, -1)) : e === name));

/**
 * The whole environment of a step of a user's run: the inherited names that are allowed, then `stepEnv` on top
 * (`undefined` removes). A provider key variable is never passed by an admin list. `need` is omitted for a shell step.
 */
export function shortEnv(
  stepEnv: Record<string, string | undefined>,
  config: Pick<Config, "step_env" | "providers">,
  need?: AgentNeed,
  source: NodeJS.ProcessEnv = inheritedEnv(),
): Record<string, string> {
  const keys = new Set([...providerKeyVars(config), ...KNOWN_KEY_VARS]);
  const listed = [...config.step_env.pass, ...serverPassList(), ...(need ? [...config.step_env.agent_pass] : [])];
  const exact = new Set<string>([...SHORT_ENV, ...SERVER_SETUP_ENV]);
  if (need) {
    const a = AGENT_ENV[need.agent];
    for (const n of a.other) exact.add(n);
    if (need.kind === OWN_KIND[need.agent]) for (const n of a.own) exact.add(n);
  }
  // A variable the config names as a provider's key never rides on a fixed name (`api_key_env: HOME`): only the
  // selected agent's own login names stay.
  const own = need && need.kind === OWN_KIND[need.agent] ? AGENT_ENV[need.agent].own : [];
  for (const p of Object.values(config.providers)) if (p.api_key_env && !own.includes(p.api_key_env)) exact.delete(p.api_key_env);
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (exact.has(name) || (matches(listed, name) && !keys.has(name))) out[name] = value;
  }
  for (const [name, value] of Object.entries(stepEnv)) out[name] = value;
  for (const [name, value] of Object.entries(out)) if (value === undefined) delete out[name];
  return out as Record<string, string>;
}
