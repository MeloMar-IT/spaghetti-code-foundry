import { z } from "zod";
import { ConfigSchema } from "../config.js";

export type SettingKind = "number" | "yes-no" | "text" | "list" | "choice";
export type SettingEffect = "now" | "new-runs" | "restart";

export const EFFECT_TEXT: Record<SettingEffect, string> = {
  now: "at once",
  "new-runs": "when a run starts or resumes",
  restart: "after a restart",
};

export interface SettingLeaf {
  key: string;
  kind: SettingKind;
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  maxItems?: number;
  fields?: { key: string; kind: "text" }[];
  choices?: string[];
}

export interface SettingDescription extends SettingLeaf {
  label: string;
  help: string;
  default: unknown;
  optional: boolean;
  effect: SettingEffect;
  effectText: string;
  /** "generated", or a file under ui/ that has its own editor. */
  control: string;
}

export interface StartupSetting {
  key: string;
  label: string;
  value: string | number;
  change: string;
  effectText: string;
}

type Node = {
  type?: string;
  properties?: Record<string, Node>;
  items?: Node;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  maxItems?: number;
};

let cache: { leaves: SettingLeaf[]; unsupported: string[] } | undefined;

/** Zod adds the safe-integer limits to `.int()`; they are not a rule of the setting. */
const real = (n: number | undefined): number | undefined => (n === undefined || Math.abs(n) === Number.MAX_SAFE_INTEGER ? undefined : n);

function leafOf(key: string, n: Node): SettingLeaf | undefined {
  if (n.type === "integer" || n.type === "number") {
    const leaf: SettingLeaf = { key, kind: "number", integer: n.type === "integer" };
    const min = real(n.minimum);
    const max = real(n.maximum);
    const ex = real(n.exclusiveMinimum);
    if (min !== undefined) leaf.min = min;
    if (max !== undefined) leaf.max = max;
    if (ex !== undefined) leaf.exclusiveMin = ex;
    return leaf;
  }
  if (n.type === "boolean") return { key, kind: "yes-no" };
  if (n.type === "string") return n.enum ? { key, kind: "choice", choices: n.enum.map(String) } : { key, kind: "text" };
  if (n.type === "array" && n.items) {
    const leaf: SettingLeaf = { key, kind: "list" };
    if (n.maxItems !== undefined) leaf.maxItems = n.maxItems;
    if (n.items.type === "string") return leaf;
    const props = n.items.type === "object" ? Object.entries(n.items.properties ?? {}) : [];
    if (props.length > 0 && props.every(([, p]) => p.type === "string")) {
      leaf.fields = props.map(([k]) => ({ key: k, kind: "text" as const }));
      return leaf;
    }
  }
  return undefined;
}

function load(): { leaves: SettingLeaf[]; unsupported: string[] } {
  if (cache) return cache;
  const root = z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any", reused: "inline" }) as Node;
  const leaves: SettingLeaf[] = [];
  const unsupported: string[] = [];
  const walk = (n: Node, key: string): void => {
    if (n.type === "object" && n.properties) {
      for (const [k, v] of Object.entries(n.properties)) walk(v, key ? `${key}.${k}` : k);
      return;
    }
    const leaf = leafOf(key, n);
    if (leaf) leaves.push(leaf);
    else unsupported.push(key);
  };
  walk(root, "");
  cache = { leaves, unsupported };
  return cache;
}

/** Every setting of `ConfigSchema` that one control can edit, in schema order. */
export function schemaLeaves(): SettingLeaf[] {
  return load().leaves;
}

/** Keys the schema has but no single control can edit (lists of records with numbers, maps). */
export function unsupportedSettings(): string[] {
  return load().unsupported;
}

/** Whether the key is one of the described settings. The prefixes end in a dot: `monitoring` is not covered. */
export function isCovered(key: string): boolean {
  if (key === "isolate_agents") return true;
  if (key === "sandbox.user_runs") return false;
  return ["monitor.", "step_env.", "skills.", "sandbox."].some((p) => key.startsWith(p));
}

type Text = { label: string; help: string; effect: SettingEffect; control?: string };

const M = (label: string, help: string): Text => ({ label, help, effect: "now", control: "problems.js" });
const N = (label: string, help: string): Text => ({ label, help, effect: "new-runs" });

export const SETTING_TEXTS: Record<string, Text> = {
  "monitor.restart_loop.resumes": M("Resumes before a restart loop", "The same run resumed more than this many times within the time below is reported."),
  "monitor.restart_loop.within_minutes": M("Restart loop window (minutes)", "The time in which the resumes of one run are counted."),
  "monitor.watcher_error.checks": M("Failed checks of a watcher", "A watcher whose check failed more than this many checks in a row is reported."),
  "monitor.github_limit.percent": M("GitHub limit used (percent)", "More than this share of GitHub's hourly request limit used is reported."),
  "monitor.watcher_silent.intervals": M("Silent watcher (intervals)", "An enabled watcher that finished no check for this many times its interval is reported."),
  "monitor.unexplained_failure.runs": M("Unexplained failures", "This many failed runs with an error the Foundry cannot explain are reported."),
  "monitor.unexplained_failure.within_hours": M("Unexplained failures window (hours)", "The time in which unexplained failures are counted."),
  "monitor.stuck_run.extra_minutes": M("Stuck run: extra minutes", "A run that wrote nothing to its log for longer than its step's timeout plus this many minutes is reported."),
  "monitor.stuck_run.no_timeout_minutes": M("Stuck run: minutes without a timeout", "The time a step without a timeout may stay silent before its run is reported."),
  "monitor.same_step_failing.issues": M("Same step failing: issues", "The same step of the same flow ending a run as failed for this many different issues is reported."),
  "monitor.same_step_failing.within_hours": M("Same step failing window (hours)", "The time in which the failures of the same step are counted."),
  "monitor.label_mismatch.checks": M("Label mismatch (checks)", "An issue label that did not match its newest run for more than this many checks is reported."),
  "monitor.orphan_lock.minutes": M("Orphan lock (minutes)", "A lock held by a run that is not running for longer than this is reported."),
  "monitor.queue_stalled.minutes": M("Queue stalled (minutes)", "Queued jobs with free slots and nothing started for this long are reported."),
  "monitor.restart_overdue.hours": M("Restart overdue (hours)", "A new version is installed and the server waited longer than this to restart."),
  "monitor.develop_red.failures": M("Develop red: failures", "The tests after a merge into develop failed this many times in a row."),
  "monitor.develop_red.within_hours": M("Develop red window (hours)", "How far back the failed tests after merges are looked at."),
  "monitor.slow_step.factor": M("Slow step: factor", "A step that took more than this many times its usual time counts as slow."),
  "monitor.slow_step.times": M("Slow step: times", "A report is made when steps were slow this many times within the window below."),
  "monitor.slow_step.within_hours": M("Slow step window (hours)", "The time in which slow steps are counted."),
  "monitor.report_to": M("Repository for bug stories", "The repository where the monitor writes bug stories; without it findings are only shown."),
  "monitor.report_limits.per_day": M("Bug stories per day", "The most new bug stories the monitor writes in one day."),
  "monitor.report_limits.per_check": M("Bug stories per check", "The most new bug stories the monitor writes in one check."),
  "monitor.cooldown_minutes": M("Quiet time after start (minutes)", "For this long after the server started no bug story is made; 0 means no quiet time."),
  "monitor.fix_wait_days": M("Days to wait for a fix", "A closed bug story whose fix is not running yet is watched anyway after this many days."),
  "monitor.breaker.new_findings": M("Breaker: new findings", "Bug stories stop when more than this many different findings first appear within the window below."),
  "monitor.breaker.within_minutes": M("Breaker window (minutes)", "The time in which new findings are counted."),
  "monitor.breaker.failed_fixes": M("Breaker: failed fixes", "Bug stories stop when the newest runs of bug stories, this many, all failed."),
  "step_env.pass": N("Variables for all steps", "Variables of the server that every step of a user's run may also see; a name, or a prefix ending in _*."),
  "step_env.agent_pass": N("Variables for agent steps", "Variables of the server that only agent steps of a user's run may also see; a name, or a prefix ending in _*."),
  "sandbox.claude": N("Sandbox Claude Code", "The default for flows that do not set their own: run Claude Code inside the sandbox."),
  "sandbox.docker_image": N("Docker image", "The default Docker image for flows that do not set their own sandbox."),
  "sandbox.user_read": N("Extra readable paths", "Absolute paths a sandboxed shell step of a user's run may read, besides its own folder."),
  "skills.builtin": N("Built-in skills", "Scan the skills shipped with the Foundry."),
  "skills.roots": N("Skill folders", "Extra folders, managed by an administrator, where skill packages are read from."),
  "skills.repository": N("Repository skills", "Also read the skills in the repository's own skills folder; off means repository skills are never loaded."),
  "skills.releases.allow_unreleased": N("Allow unreleased skills", "For development only: folders that are not an approved release are loaded too."),
  "skills.releases.approved": N("Approved releases", "The catalogue releases this installation accepts, one per line."),
  "skills.catalogue.max_candidates": N("Catalogue: most skills", "The most skills a planner's catalogue lists."),
  "skills.catalogue.max_tokens": N("Catalogue: size limit", "The size limit of the catalogue a planner gets, in tokens."),
  "skills.catalogue.include": N("Catalogue: always include", "Skill ids that are always in the catalogue."),
  "skills.catalogue.exclude": N("Catalogue: never include", "Skill ids that are never in the catalogue; this wins over the list of ids to include."),
  "skills.selection.max_skills": N("Selection: most skills", "The most skills the resolver may select for one plan."),
  "skills.selection.max_skill_tokens": N("Selection: size of one skill", "The size limit of one selected skill, in tokens."),
  "skills.selection.max_tokens": N("Selection: size limit", "The size limit of all selected skills together, in tokens."),
  "skills.selection.include": N("Selection: always select", "Skill ids that are always selected; this is not an approval, they still need a pin."),
  "skills.selection.exclude": N("Selection: never select", "Skill ids that are never selected."),
  "skills.review.max_tokens": N("Review checks: size limit", "The size limit of the review checks a reviewer session gets, in tokens."),
  "skills.review.max_skill_tokens": N("Review checks: size of one skill", "The size limit of the review checks of one skill, in tokens."),
  "skills.unresolved.unknown": N("Unknown skill", "What to do with a requested skill that does not exist."),
  "skills.unresolved.missing": N("Missing skill", "What to do with a requested skill that is not installed."),
  "skills.unresolved.untrusted": N("Untrusted skill", "What to do with a requested skill that is not from an approved release."),
  "skills.unresolved.conflict": N("Conflicting skill", "What to do with a requested skill that conflicts with another one."),
  "skills.unresolved.oversized": N("Oversized skill", "What to do with a requested skill that does not fit the size limits."),
  "skills.unresolved.high_risk": N("High-risk terms", "Ids, categories and capabilities that count as high risk; a high-risk skill always stops the run."),
  "skills.tools.shell": N("Skills may ask for a shell", "Whether a skill may ask for the shell tool."),
  "skills.tools.network": N("Skills may ask for the network", "Whether a skill may ask for network access."),
  "skills.tools.filesystem": N("Skills file access", "The most file access a skill may ask for."),
  "skills.tools.missing": N("Skill tool not available", "What to do when a tool a skill asks for is not available."),
  isolate_agents: N("Isolate agents", "Run agent steps without your personal setup: no MCP servers, plugins, skills, hooks or user settings."),
};

/** Walks `value` down the dotted key. */
export function settingValue(obj: unknown, key: string): unknown {
  let cur: any = obj;
  for (const part of key.split(".")) cur = cur?.[part];
  return cur;
}

/** The covered settings: the schema leaves joined with their texts. Throws when a covered leaf has no text. */
export function describeSettings(): SettingDescription[] {
  const defaults = ConfigSchema.parse({});
  return schemaLeaves()
    .filter((l) => isCovered(l.key))
    .map((l) => {
      const t = SETTING_TEXTS[l.key];
      if (!t) throw new Error(`no text for the setting ${l.key}`);
      const def = settingValue(defaults, l.key);
      return { ...l, label: t.label, help: t.help, default: def, optional: def === undefined, effect: t.effect, effectText: EFFECT_TEXT[t.effect], control: t.control ?? "generated" };
    });
}

/** The settings that are not in config.yaml: they come from the start of the server and change with a restart. */
export function startupSettings(v: { home: string; port: number; repo: string; claudeBin: string; codexBin: string; ghBin: string }): StartupSetting[] {
  const e = EFFECT_TEXT.restart;
  return [
    { key: "FACTORY_HOME", label: "Data folder", value: v.home, change: "Set FACTORY_HOME before the start.", effectText: e },
    { key: "port", label: "Port", value: v.port, change: "Start with --port.", effectText: e },
    { key: "repo", label: "Repository", value: v.repo, change: "Start with --repo, or in the folder.", effectText: e },
    { key: "FACTORY_CLAUDE_BIN", label: "Claude Code program", value: v.claudeBin, change: "Set FACTORY_CLAUDE_BIN before the start.", effectText: e },
    { key: "FACTORY_CODEX_BIN", label: "Codex program", value: v.codexBin, change: "Set FACTORY_CODEX_BIN before the start.", effectText: e },
    { key: "FACTORY_GH_BIN", label: "GitHub program", value: v.ghBin, change: "Set FACTORY_GH_BIN before the start.", effectText: e },
  ];
}
