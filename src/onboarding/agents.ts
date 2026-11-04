import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConfigSchema, RouterRuleSchema, configVersion, editConfigText, parseConfigText, type Config } from "../config.js";
import { usageThreshold } from "../ops/limits.js";

/**
 * The answers about Claude Code and Codex (#769) and the six settings they give. Pure: no files, no clock except `now`
 * passed in. The files and the locking are in agents-store.ts.
 */

export const AGENT_SETTING_KEYS = ["concurrency", "governor.usage_percent", "governor.priority", "default_model", "router.fallback", "router.rules"] as const;
export type AgentSettingKey = (typeof AGENT_SETTING_KEYS)[number];

export type RouterRule = z.infer<typeof RouterRuleSchema>;
export type Priority = "normal" | "low" | "background";

/** Review steps (`plan_review`, `review_1`, `cross_review`, …) but not `address_review_*`. */
export const REVIEW_STEPS = "^(plan_|cross_)?review(_\\d+)?$";
/** Steps that fix failed tests. */
export const FIX_STEPS = "^fix_";

export const AgentAnswersSchema = z
  .object({
    have: z.enum(["claude", "codex", "both", "none"]),
    plans: z
      .object({
        claude: z.enum(["pro", "max", "api-key", "unknown"]).optional(),
        codex: z.enum(["plus", "pro", "api-key", "unknown"]).optional(),
      })
      .strict()
      .default({}),
    share: z.enum(["claude", "codex", "even", "auto"]).optional(),
    busy: z.enum(["little", "normal", "fast"]),
  })
  .strict();
export type AgentAnswers = z.infer<typeof AgentAnswersSchema>;

export const AgentsRequestSchema = z
  .object({ answers: AgentAnswersSchema, replace: z.array(z.enum(AGENT_SETTING_KEYS)).max(6).default([]) })
  .strict();

/** The values of the six settings, as stored and compared: `null` = not set. */
export interface AgentValues {
  concurrency: number;
  "governor.usage_percent": number | null;
  "governor.priority": Priority;
  default_model: string | null;
  "router.fallback": string[];
  "router.rules": RouterRule[];
}

const AppliedSchema = z
  .object({
    concurrency: z.number().int().positive().optional(),
    "governor.usage_percent": z.number().int().min(1).max(100).nullable().optional(),
    "governor.priority": z.enum(["normal", "low", "background"]).optional(),
    default_model: z.string().nullable().optional(),
    "router.fallback": z.array(z.string().min(1)).optional(),
    "router.rules": z.array(RouterRuleSchema).optional(),
  })
  .strict();

/** What `agents.json` holds. `pending`: a save that wrote the record first and may not have finished (see `settle`). */
export const StoredAgentsSchema = z
  .object({
    version: z.literal(1),
    answers: AgentAnswersSchema.nullable(),
    applied: AppliedSchema,
    at: z.string(),
    /** `to`: the configVersion of config.yaml that the save wrote. Only that file state proves the save committed. */
    pending: z.object({ answers: AgentAnswersSchema, applied: AppliedSchema, at: z.string(), to: z.string() }).strict().optional(),
  })
  .strict();
export type StoredAgents = z.infer<typeof StoredAgentsSchema>;

export interface AgentSettings {
  concurrency: number;
  governor: { usage_percent: number; priority: Priority };
  default_model?: string;
  router: { fallback: string[]; rules: RouterRule[] };
}

type Plan = [runs: number, percent: number];
const SMALLEST: Plan = [1, 60];
const PLAN: Record<"claude" | "codex", Record<string, Plan>> = {
  claude: { pro: [1, 70], max: [2, 80], "api-key": [1, 60], unknown: [1, 60] },
  codex: { plus: [1, 70], pro: [2, 80], "api-key": [1, 60], unknown: [1, 60] },
};

const toolsOf = (a: AgentAnswers): ("claude" | "codex")[] => (a.have === "both" ? ["claude", "codex"] : a.have === "none" ? [] : [a.have]);

function routing(a: AgentAnswers): AgentSettings["router"] & { default_model?: string } {
  if (a.have === "none") return { fallback: [], rules: [] };
  if (a.have === "claude") return { default_model: "sonnet", fallback: [], rules: [{ agent: "codex", model: "sonnet" }] };
  if (a.have === "codex") return { fallback: [], rules: [{ agent: "claude", model: "codex" }] };
  switch (a.share ?? "auto") {
    case "claude":
      return { default_model: "sonnet", fallback: ["codex"], rules: [] };
    case "codex":
      return { fallback: ["sonnet"], rules: [{ agent: "claude", model: "codex" }] };
    case "even":
      return { fallback: ["codex", "sonnet"], rules: [{ step: REVIEW_STEPS, model: "codex" }, { step: FIX_STEPS, model: "codex" }] };
    default:
      return { fallback: ["codex"], rules: [] };
  }
}

/** The settings these answers give. `default_model` is never `codex`: Ask SCF needs Claude Code. */
export function settingsFor(a: AgentAnswers): AgentSettings {
  const plans = toolsOf(a).map((t) => PLAN[t][a.plans[t] ?? "unknown"] ?? SMALLEST);
  const runs = plans.length ? Math.min(...plans.map((p) => p[0])) : SMALLEST[0];
  const percent = plans.length ? Math.min(...plans.map((p) => p[1])) : SMALLEST[1];
  const { default_model, ...router } = routing(a);
  const busy = {
    little: { concurrency: 1, usage_percent: 50, priority: "background" as Priority },
    normal: { concurrency: runs, usage_percent: percent, priority: "low" as Priority },
    fast: { concurrency: runs, usage_percent: 90, priority: "normal" as Priority },
  }[a.busy];
  return {
    concurrency: busy.concurrency,
    governor: { usage_percent: busy.usage_percent, priority: busy.priority },
    ...(default_model ? { default_model } : {}),
    router,
  };
}

export function valuesOf(s: AgentSettings): AgentValues {
  return {
    concurrency: s.concurrency,
    "governor.usage_percent": s.governor.usage_percent,
    "governor.priority": s.governor.priority,
    default_model: s.default_model ?? null,
    "router.fallback": [...s.router.fallback],
    "router.rules": s.router.rules.map((r) => ({ ...r })),
  };
}

export function currentValues(c: Config): AgentValues {
  return {
    concurrency: c.concurrency,
    "governor.usage_percent": c.governor.usage_percent ?? null,
    "governor.priority": c.governor.priority,
    default_model: c.default_model ?? null,
    "router.fallback": [...c.router.fallback],
    "router.rules": c.router.rules.map((r) => ({ ...r })),
  };
}

const same = (a: unknown, b: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
const defaults = () => currentValues(ConfigSchema.parse({}));

/** The request body, checked. The message is built from schema paths and fixed words, never from the values sent. */
export function parseAgentsRequest(body: unknown): { answers: AgentAnswers; replace: AgentSettingKey[] } {
  const r = AgentsRequestSchema.safeParse(body);
  if (r.success) return r.data;
  const words: Record<string, string> = { unrecognized_keys: "unknown key", invalid_value: "not one of the allowed answers", invalid_type: "missing or of the wrong type" };
  const lines = new Set(r.error.issues.map((i) => `${i.path.map(String).join(".") || "(top level)"}: ${words[i.code] ?? "not valid"}`));
  throw new Error(`invalid answers: ${[...lines].slice(0, 10).join("; ")}`);
}

/**
 * Keep or replace. The baseline of a key is the value the answers last applied, else the built-in default. A key whose
 * current value differs from it was set by hand: it is kept (and its old applied entry stays) unless `replace` names it.
 */
export function keptKeys(current: AgentValues, want: AgentValues, applied: Partial<AgentValues> | undefined, replace: readonly AgentSettingKey[] = []) {
  const base = defaults();
  const old = applied ?? {};
  const changed: AgentSettingKey[] = [];
  const kept: AgentSettingKey[] = [];
  const next: Record<string, unknown> = {};
  for (const k of AGENT_SETTING_KEYS) {
    const baseline = Object.hasOwn(old, k) ? old[k] : base[k];
    if (!same(current[k], baseline) && !replace.includes(k)) {
      kept.push(k);
      if (Object.hasOwn(old, k)) next[k] = old[k];
      continue;
    }
    next[k] = want[k];
    if (!same(current[k], want[k])) changed.push(k);
  }
  return { changed, kept, applied: next as Partial<AgentValues> };
}

/**
 * A save writes the record with a `pending` entry first, then config.yaml, then the final record. A leftover `pending`
 * is settled by the file's version: it is promoted only when config.yaml is exactly the file the save wrote. Otherwise
 * (the write failed, or someone edited the file since) it is dropped, and the values that differ from the old record
 * count as set by hand: they are kept, never overwritten.
 */
export function settle(stored: StoredAgents | null, version: string): StoredAgents | null {
  if (!stored?.pending) return stored;
  const p = stored.pending;
  if (version === p.to) return { version: 1, answers: p.answers, applied: p.applied, at: p.at };
  return stored.answers === null ? null : { version: 1, answers: stored.answers, applied: stored.applied, at: stored.at };
}

export interface ApplyResult {
  text: string;
  before: Config;
  config: Config;
  changed: AgentSettingKey[];
  kept: AgentSettingKey[];
  record: StoredAgents;
  /** The stored record after `settle`. */
  settled: StoredAgents | null;
}

/** The new config text, and the record to store. `stored` is settled here. Throws what `parseConfigText` and `editConfigText` throw. */
export function applyAnswers(o: { text: string; stored: StoredAgents | null; answers: AgentAnswers; replace: readonly AgentSettingKey[]; now: Date }): ApplyResult {
  const before = parseConfigText(o.text);
  const current = currentValues(before);
  const stored = settle(o.stored, configVersion(o.text));
  const want = valuesOf(settingsFor(o.answers));
  const k = keptKeys(current, want, stored?.applied, o.replace);
  let text = o.text;
  let config = before;
  if (k.changed.length) {
    const body = JSON.parse(JSON.stringify(before));
    for (const key of k.changed) setPath(body, key, want[key]);
    const out = editConfigText(o.text, body);
    text = out.text;
    config = out.config;
  }
  const unchanged = stored?.answers && same(stored.answers, o.answers) && same(stored.applied, k.applied);
  const record: StoredAgents = { version: 1, answers: o.answers, applied: k.applied, at: unchanged ? stored.at : o.now.toISOString() };
  return { text, before, config, changed: k.changed, kept: k.kept, record, settled: stored };
}

/** Sets a dotted path in a plain object; `null` removes the key. */
function setPath(body: Record<string, any>, key: string, value: unknown): void {
  const parts = key.split(".");
  let at = body;
  for (const p of parts.slice(0, -1)) at = (at[p] ??= {});
  const last = parts[parts.length - 1]!;
  if (value === null) delete at[last];
  else at[last] = value;
}

export interface AgentStatus {
  applied: boolean;
  kept: readonly AgentSettingKey[];
  current: AgentValues;
  floor?: number;
  limits?: { auto: boolean; readings: ("claude" | "codex")[] };
}

const PLAN_TEXT: Record<string, string> = { pro: "Pro plan", max: "Max plan", plus: "Plus plan", "api-key": "an API key" };
const KEPT_LABEL: Record<AgentSettingKey, string> = {
  concurrency: "runs at the same time",
  "governor.usage_percent": "the usage threshold",
  "governor.priority": "the priority of runs",
  default_model: "the default model",
  "router.fallback": "the fallback tools",
  "router.rules": "the routing rules",
};
const plural = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

/** What the settings in effect do, in plain words. */
export function summaryLines(a: AgentAnswers, status: AgentStatus): string[] {
  const cur = status.current;
  const out: string[] = [];
  const tools = toolsOf(a);
  out.push(
    a.have === "both" ? "You use Claude Code and Codex."
      : a.have === "claude" ? "You use Claude Code."
        : a.have === "codex" ? "You use Codex."
          : "You have neither Claude Code nor Codex yet. Set one up on the Setup check page first.",
  );
  for (const t of tools) {
    const name = t === "claude" ? "Claude Code" : "Codex";
    const plan = a.plans[t];
    out.push(plan && plan !== "unknown" ? `${name}: ${PLAN_TEXT[plan]}.` : `${name}: plan not known, so the Foundry starts with the smallest setting.`);
  }
  out.push(`Up to ${plural(cur.concurrency)} at the same time.`);
  const pct = cur["governor.usage_percent"];
  const t = usageThreshold(pct ?? undefined, status.floor, cur.concurrency);
  if (!t) out.push("No usage threshold is set.");
  else if (t.runs >= cur.concurrency) out.push(`The usage threshold is ${t.percent}% of a weekly limit; with ${plural(cur.concurrency)} at the same time it lowers nothing.`);
  else {
    out.push(`When about ${t.percent}% of a weekly limit is used, the Foundry goes down to ${plural(t.runs)} at the same time.`);
    const l = status.limits;
    if (l && !l.auto) out.push("Slowing down is off, so this does not happen yet (`scf limits auto on`).");
    else if (l && !l.readings.length) out.push("It needs a usage reading first (`scf limits set claude|codex <percent used> <next reset>`).");
    else if (l) out.push("It works only while the reading matches the runs recorded since the week began (see `scf limits`).");
  }
  out.push(
    cur["governor.priority"] === "background" ? "Runs work in the background, so this computer stays quick for you."
      : cur["governor.priority"] === "low" ? "Runs give way a little to your other programs."
        : "Runs get the computer's full speed.",
  );
  if (status.kept.some((k) => k === "default_model" || k === "router.fallback" || k === "router.rules")) out.push("An admin set the routing by hand; see the Models page.");
  else if (a.have === "claude") out.push("Claude Code runs every step, also the ones made for Codex.");
  else if (a.have === "codex") out.push("Codex runs every step. Ask SCF needs Claude Code, so it does not work with Codex alone.");
  else if (a.have === "both") {
    const share = a.share ?? "auto";
    out.push(
      share === "claude" ? "Claude Code does most of the work. When it hits a limit, Codex takes over."
        : share === "codex" ? "Codex does most of the work. When it hits a limit, Claude Code takes over."
          : share === "even" ? "Claude Code plans and writes the code; Codex reviews it and fixes failed tests. Each takes over when the other hits a limit."
            : "The Foundry picks the tool for each step. When Claude Code hits a limit, Codex takes over.",
    );
  }
  if (!status.applied) out.push("These settings are not applied yet.");
  if (status.kept.length) out.push(`Kept as an admin set them: ${status.kept.map((k) => KEPT_LABEL[k]).join(", ")}.`);
  return out;
}

export interface AgentsView {
  answers: AgentAnswers | null;
  appliedAt?: string;
  settings: AgentValues | null;
  current: AgentValues;
  kept: AgentSettingKey[];
  summary: string[];
}

/** The answers, the settings they give, the values in effect, and the settings an admin changed by hand. */
export function agentsView(stored: StoredAgents | null, config: Config, version: string, limits?: AgentStatus["limits"]): AgentsView {
  const current = currentValues(config);
  const s = settle(stored, version);
  if (!s?.answers) return { answers: null, settings: null, current, kept: [], summary: [] };
  const want = valuesOf(settingsFor(s.answers));
  const { kept } = keptKeys(current, want, s.applied);
  const status: AgentStatus = { applied: kept.length < AGENT_SETTING_KEYS.length, kept, current, floor: config.governor.floor, limits };
  return { answers: s.answers, appliedAt: s.at, settings: want, current, kept, summary: summaryLines(s.answers, status) };
}
