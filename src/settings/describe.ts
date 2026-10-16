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
  additionalProperties?: Node | boolean;
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

let keyCache: string[] | undefined;

/**
 * Every key of `ConfigSchema`, down to the leaves. A list of records (`watchers`, `router.rules`) or a record of records
 * (`providers`) counts once, by its item shape, with the segment `*`; a list or record of plain values is one key.
 */
export function settingKeys(): string[] {
  if (keyCache) return keyCache;
  const root = z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any", reused: "inline" }) as Node;
  const keys: string[] = [];
  const walk = (n: Node, key: string): void => {
    if (n.type === "object" && n.properties) {
      for (const [k, v] of Object.entries(n.properties)) walk(v, key ? `${key}.${k}` : k);
      return;
    }
    if (leafOf(key, n)) return void keys.push(key);
    const item = n.type === "array" ? n.items : n.type === "object" && typeof n.additionalProperties === "object" ? n.additionalProperties : undefined;
    if (item?.type === "object" && item.properties) return void walk(item, `${key}.*`);
    keys.push(key);
  };
  walk(root, "");
  keyCache = keys;
  return keys;
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
  // No generated control can edit these safely: src/settings/exceptions.ts says why.
  if (key === "help.disabled_accounts" || key === "help.sensitive_patterns") return false;
  if (["ui.redesign", "default_model", "router.fallback", "router.fallback_on", "isolate_agents", "cost_limits", "daily_budget_usd", "concurrency", "protected_branches", "hotfix_to_main", "secret_scan"].includes(key)) return true;
  return ["monitor.", "step_env.", "skills.", "sandbox.", "server.", "audit.", "notify.", "bot.", "github_app.", "self_update.", "failure_summary.", "help."].some((p) => key.startsWith(p));
}

type Text = { label: string; help: string; effect: SettingEffect; control?: string };

const M = (label: string, help: string): Text => ({ label, help, effect: "now", control: "problems.js" });
const N = (label: string, help: string): Text => ({ label, help, effect: "new-runs" });
/** A setting edited by a hand-built control of ui/admin.js (or another file under ui/). */
const A = (label: string, help: string, effect: SettingEffect, control = "admin.js"): Text => ({ label, help, effect, control });

/** A setting drawn by the generated control (no `control` file); it takes effect at once. */
const G = (label: string, help: string): Text => ({ label, help, effect: "now" });

export const SETTING_TEXTS: Record<string, Text> = {
  "ui.redesign": A("Redesigned pages", "Show the redesigned pages, which are still being built.", "now"),
  default_model: A("Default model", "The model of agent steps that name none in the step, the flow or a routing rule.", "new-runs", "models.js"),
  "router.fallback": A("Fallback models", "Models tried in order when an agent step hits a rate or usage limit, or a budget for free targets.", "new-runs", "models.js"),
  "router.fallback_on": A("Fall back on", "Whether a rate limit, a used-up budget or both make an agent step try the fallback models.", "new-runs", "models.js"),
  "help.enabled": G("Ask SCF", "Switch on the help assistant; off, nobody can ask."),
  "help.actions": G("Ask SCF may propose actions", "Lets Ask SCF propose to resume or cancel a person's own run, and later carry it out after they confirm; off, it only explains."),
  "help.audience": G("Who may ask", "Every account, or administrators only; not set means every account."),
  "help.keep_days": G("Keep conversations (days)", "A conversation nobody changed for this many days is deleted; not set means 90."),
  "help.model": G("Ask SCF model", "The model that answers, a Claude Code target; not set means the default model."),
  "help.timeout_seconds": G("Time for one answer (seconds)", "A turn that takes longer is stopped."),
  "help.max_parallel": G("Answers at the same time", "Turns answered at the same time, over all accounts."),
  "help.max_queued": G("Questions that may wait", "Turns that may wait for a free place; one more is refused."),
  "help.turns_per_user_per_day": G("Questions per account per day", "Turns one account may start per day, counted in UTC."),
  "help.max_cost_usd_per_turn": G("Most cost of one answer ($)", "The most one turn may cost; not applied without cost limits or for a model without a price."),
  "help.daily_budget_usd": G("Daily budget of Ask SCF ($)", "The most all turns of a day may cost together; not set means no daily limit."),
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
  "step_env.pass": A("Variables for all steps", "Variables of the server that every step of a user's run may also see; a name, or a prefix ending in _*.", "new-runs", "admin-sections.js"),
  "step_env.agent_pass": A("Variables for agent steps", "Variables of the server that only agent steps of a user's run may also see; a name, or a prefix ending in _*.", "new-runs", "admin-sections.js"),
  "sandbox.claude": A("Sandbox Claude Code", "The default for flows that do not set their own: run Claude Code inside the sandbox.", "new-runs"),
  "sandbox.docker_image": A("Docker image", "The default Docker image for flows that do not set their own sandbox.", "new-runs"),
  "sandbox.user_read": A("Extra readable paths", "Absolute paths a sandboxed shell step of a user's run may read, besides its own folder.", "new-runs", "admin-sections.js"),
  "skills.builtin": N("Built-in skills", "Scan the skills shipped with the Foundry."),
  "skills.roots": N("Skill folders", "Extra folders, managed by an administrator, where skill packages are read from."),
  "skills.repository": N("Repository skills", "Also read the skills in the repository's own skills folder; off means repository skills are never loaded."),
  "skills.releases.allow_unreleased": N("Allow unreleased skills", "For development only: folders that are not an approved release are loaded too."),
  "skills.releases.keys": N("Trusted release keys", "Ed25519 public keys of the publishers you trust; once set, every approved release must be signed by one of them."),
  "skills.releases.deployment.repository": N("Deployment repository", "The GitHub repository (owner/name or host/owner/name) that holds your deployed config, where `scf skills release propose` opens its pull request."),
  "skills.releases.deployment.file": N("Deployment config file", "The YAML config file in the deployment repository, relative to its top, whose skills.releases.approved list the pull request extends."),
  "skills.releases.approved": N("Approved releases", "The catalogue releases this installation accepts, each with its catalogue id, version and digest, and optionally the local folder (artifact) that `scf skills release adopt` copies it from."),
  "skills.catalogue.max_candidates": N("Catalogue: most skills", "The most skills a planner's catalogue lists."),
  "skills.catalogue.max_tokens": N("Catalogue: size limit", "The size limit of the catalogue a planner gets, in tokens."),
  "skills.catalogue.include": N("Catalogue: always include", "Skill ids that are always in the catalogue."),
  "skills.catalogue.exclude": N("Catalogue: never include", "Skill ids that are never in the catalogue; this wins over the list of ids to include."),
  "skills.selection.max_skills": N("Selection: most skills", "The most skills the resolver may select for one plan."),
  "skills.selection.max_skill_tokens": N("Selection: size of one skill", "The size limit of one selected skill, in tokens."),
  "skills.selection.max_tokens": N("Selection: size limit", "The size limit of all selected skills together, in tokens."),
  "skills.selection.include": N("Selection: always select", "Skill ids that are always selected; this is not an approval, they still need a pin."),
  "skills.selection.exclude": N("Selection: never select", "Skill ids that are never selected."),
  "skills.selection.exclusive": N("Selection: one skill per capability", "Capabilities only one skill may provide in a run; a run offers, locks and loads only the canonical provider, and stops on a tie it cannot settle."),
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
  "skills.update_check.folder": G("Catalogue clone for source checks", "Absolute path of a clone of the catalogue repository; the server checks its due skill sources there and opens pull requests with its own git and gh sign-in; not set means off."),
  "skills.update_check.every": G("Look for due source checks every", "How often the server looks for due sources, like 30m or 6h, from 5m to 24h; each source keeps its own update cadence."),
  isolate_agents: A("Isolate agents", "Run agent steps without your personal setup: no MCP servers, plugins, skills, hooks or user settings.", "new-runs", "admin-sections.js"),
  cost_limits: A("Enforce cost limits", "Stop runs at the run, step and daily budgets; off still records costs but never stops a run because of money.", "new-runs"),
  daily_budget_usd: A("Daily budget ($)", "When today's spending reaches this, runs pause and resume the next day.", "new-runs"),
  concurrency: A("Runs at the same time", "The most runs that work at the same time, over all repositories.", "now"),
  "server.listen": A("Listen on", "The address the server answers on: 127.0.0.1 or ::1 for this computer only, 0.0.0.0 or :: for all networks.", "restart"),
  "server.allowed_hosts": A("Allowed host names", "Host names, besides localhost, that people may type to reach this page.", "now"),
  "server.allow_insecure_http": A("Allow plain HTTP", "Accept other computers over plain HTTP, which sends passwords and cookies unencrypted.", "now"),
  "audit.retention_days": A("Keep the audit log (days)", "Audit lines older than this are removed when the server starts and once a day.", "now"),
  protected_branches: A("Protected branches", "Pushes to these branches are refused during runs; glob patterns are allowed.", "new-runs"),
  hotfix_to_main: A("Hotfixes", "Build bug stories of the built-in issue-gitflow on a hotfix branch and merge them into main without a person.", "new-runs"),
  secret_scan: A("Secret scan", "Refuse pushes whose new commits add secrets such as API keys, private keys or .env files.", "new-runs"),
  "self_update.enabled": A("Self-update", "Build, test and restart on new commits of main of the Foundry's own repository without a person.", "now"),
  "self_update.repo": A("Self-update repository", "The repository, as owner/name, that updates may come from.", "now"),
  "sandbox.user_runs": A("OS sandbox for user runs", "required: a shell step of a user's run runs in the OS sandbox or the run is refused; off: it may run without it.", "new-runs"),
  "notify.macos": A("macOS notifications", "Show a macOS notification when something waits for you.", "now"),
  "notify.slack_webhook": A("Slack webhook", "The Slack address that gets the same notifications; it is never shown.", "now"),
  "notify.command": A("Command", "A shell command run when a run ends, with $FACTORY_STATUS, $FACTORY_RUN_ID and $FACTORY_MESSAGE set.", "new-runs"),
  "notify.on": A("Run the command when a run is", "The run outcomes that run the command.", "new-runs"),
  "notify.successes": A("Notify on success", "Also notify when a run succeeds.", "now"),
  "notify.throttle_minutes": A("Minutes between notifications", "At most one notification in this many minutes.", "now"),
  "notify.quiet_hours.from": A("Quiet hours from", "No notifications from this time, on this computer's clock.", "now"),
  "notify.quiet_hours.to": A("Quiet hours to", "No notifications until this time.", "now"),
  "notify.daily_summary_at": A("Daily summary at", "The time, as HH:MM, a short summary is sent once a day.", "now"),
  "bot.name": A("Commit author name", "The name on commits of runs; without it your git name is used.", "new-runs"),
  "bot.email": A("Commit author email", "The e-mail on commits of runs; without it your git e-mail is used.", "new-runs"),
  "bot.gh_token_env": A("Bot token variable", "The name of a server variable that holds the bot's GitHub token, used as GH_TOKEN.", "new-runs"),
  "github_app.app_id": A("App ID", "The ID of the GitHub App.", "now"),
  "github_app.slug": A("App name (slug)", "The last part of https://github.com/apps/<name>.", "now"),
  "github_app.private_key_path": A("Private key file", "The .pem file of the app, readable only by the server's account.", "now"),
  "github_app.installation_id": A("Installation ID", "Only for the bot identity: runs then commit and comment as the app.", "new-runs"),
  "failure_summary.enabled": A("Failure summary", "Ask a small model for one sentence on why a run failed; off uses the rules text only.", "new-runs", "admin-sections.js"),
  "failure_summary.model": A("Failure summary model", "The model that writes the sentence, such as haiku, or ollama:<model> for a local one.", "new-runs", "admin-sections.js"),
};

export interface ItemSettingText {
  label: string;
  help: string;
  effect: SettingEffect;
  /** Every item field (the part of the key after `*.`) with the file under ui/ that edits it. */
  fields: Record<string, string>;
}

const on = (file: string, names: string[]): Record<string, string> => Object.fromEntries(names.map((n) => [n, file]));

/**
 * Lists of records (`watchers`, `providers`, `router.rules`): they count once, by their item shape. A new item field fails
 * tests/settings-inventory.test.ts until it is listed here with the module that edits it, or is an exception.
 */
export const ITEM_SETTINGS: Record<string, ItemSettingText> = {
  watchers: {
    label: "Watchers",
    help: "What each watcher follows and how it starts runs, with the variables of its flow.",
    effect: "now",
    fields: {
      ...on("watcher-form.js", ["id", "enabled", "source", "flow", "github_repo", "label", "every", "max_per_tick", "vars", "task", "branch", "exclude_labels", "at", "timezone", "owner"]),
      ...on("watcher-options.js", [
        "priority_labels", "status_labels.working", "status_labels.done", "status_labels.needs_info", "status_labels.waiting", "status_labels.failed",
        "wait_for_dependencies", "dependency_done_labels", "precheck_flow", "auto_defaults", "remove_on_done", "comment_on_failure", "status_comment",
        "pause_while_pr_open", "one_at_a_time",
      ]),
    },
  },
  providers: {
    label: "Providers",
    help: "Where a model runs: its kind, address, key variable and default model.",
    effect: "new-runs",
    fields: on("models.js", ["kind", "base_url", "api_key_env", "default_model"]),
  },
  "router.rules": {
    label: "Routing rules",
    help: "The first rule that matches a step picks its model.",
    effect: "new-runs",
    fields: on("models.js", ["step", "flow", "min_visit", "model"]),
  },
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
