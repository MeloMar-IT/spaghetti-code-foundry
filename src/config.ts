import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { editYamlText, removeYamlKey } from "./config-edit.js";
import { validGithubName } from "./auth/repo-url.js";
import { FACTORY_HOME } from "./flow/load.js";
import { BASELINE_POLICY_ID } from "./policy/baseline.js";
import { PATTERN_LIMIT, PATTERN_MAX, usablePattern } from "./help/patterns.js";
import { CATALOGUE_COST, CATALOGUE_DEFAULTS, CATALOGUE_RANGE } from "./skills/catalogue-rules.js";
import { CANONICAL_LIMITS } from "./skills/canonical-rules.js";
import { RESOLVE_DEFAULTS, RESOLVE_RANGE } from "./skills/resolve-rules.js";
import { decodeBase64Exact, MAX_RELEASE_KEYS } from "./skills/release-signature.js";
import { artifactPathProblem, relativePathProblem, REVIEW_DEFAULTS, REVIEW_RANGE, SKILL_DIGEST_RE, SkillIdSchema, SkillVersionSchema, ToolPolicySchema, UnresolvedPolicySchema } from "./skills/schema.js";

const watcherShape = {
    id: z.string().regex(/^[\w-]+$/),
    enabled: z.boolean().default(true),
    /**
     * issues: labelled issues → flow. pr-feedback: new review comments on factory PRs → flow.
     * ci-failures: CI red on the default branch → ci-fix. schedule: run a chore every `every`.
     */
    source: z.enum(["issues", "pr-feedback", "ci-failures", "schedule", "monitor"]).default("issues"),
    /** "default": the flow for the source (issues → issue-gitflow, schedule → release-daily). */
    flow: z.string().default("default"),
    /** Empty for a monitor (source "monitor": checks the Foundry itself, only one allowed). */
    github_repo: z.string().default(""),
    label: z.string().default("claude-factory"),
    every: z.string().default("5m"),
    max_per_tick: z.number().int().positive().default(1),
    /** issues: stories with one of these labels (not case sensitive) go before all other stories. */
    priority_labels: z.array(z.string()).default(["bug"]),
    vars: z.record(z.string(), z.string()).default({}),
    /** schedule: what the chore should do (the run's task). */
    task: z.string().max(5000).optional(),
    /** ci-failures: branch to watch (default: the repo's default branch). */
    branch: z.string().regex(/^[\w./-]+$/).optional(),
    /** issues: skip issues that carry any of these labels. */
    exclude_labels: z.array(z.string()).default([]),
    /** issues: your own names for the status labels (default factory:working, factory:done, …). */
    status_labels: z
      .object({ working: z.string(), done: z.string(), needs_info: z.string(), waiting: z.string(), failed: z.string() })
      .partial()
      .strict()
      .default({}),
    /** issues: don't start an issue while an issue named under "Depends on" / "Blocked by" is not done. */
    wait_for_dependencies: z.boolean().default(true),
    /** issues: a dependency also counts as done (besides closed) when it has one of these labels. */
    dependency_done_labels: z.array(z.string()).default([]),
    /**
     * issues: before starting new issues, run this flow once over all of them (e.g. epic-questions,
     * which asks every owner decision up front). Issues it asks about wait for an answer.
     */
    precheck_flow: z.string().optional(),
    /**
     * issues: answer the Foundry's questions with its own recommendations (a `/defaults` comment on the
     * issue) instead of waiting for a person. At most twice per issue; after that a person answers.
     */
    auto_defaults: z.boolean().default(false),
    /** issues: labels to remove when a run succeeds (e.g. the trigger label). */
    remove_on_done: z.array(z.string()).default([]),
    /** issues: post the failure reason and the failing step's output on the issue. */
    comment_on_failure: z.boolean().default(true),
    /** issues: keep one status comment on every issue the watcher follows (edited, never a second one). */
    status_comment: z.boolean().default(true),
    /** Start nothing while an open PR's head branch starts with this (e.g. factory/daily-). */
    pause_while_pr_open: z.string().optional(),
    /** Never run two of this watcher's runs at the same time (they share a branch). */
    one_at_a_time: z.boolean().default(false),
    /** schedule: run once a day at this time ("17:00") instead of every `every`. */
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").optional(),
    /** schedule: IANA time zone for `at`, e.g. Europe/Berlin (default: this Mac's). */
    timezone: z.string().optional(),
    /** schedule: after each new commit on the main branch, build the release files (release-build) when the repository has a recipe. */
    release_build: z.boolean().default(false),
    /** The e-mail of the account that owns this watcher's runs (default: the first admin). Only an admin can set it. */
    owner: z.string().max(254).optional(),
};

const scheduleNeedsTask = (w: { source: string; task?: string }) => w.source !== "schedule" || !!w.task?.trim();
const releaseNeedsSchedule = (w: { source: string; release_build?: boolean }) => !w.release_build || w.source === "schedule";
const zoneKnown = (w: { timezone?: string }) => !w.timezone || validTimeZone(w.timezone);

/**
 * The options of a watcher that belongs to a repository (stored in repo-watchers.json): the same as in config.yaml,
 * except `github_repo` and `owner`, which come from the repository record, and without source "monitor".
 */
const { github_repo: _repo, owner: _owner, ...repoWatcherShape } = watcherShape;
const RepoWatcherSchema = z
  .object({ ...repoWatcherShape, source: z.enum(["issues", "pr-feedback", "ci-failures", "schedule"]).default("issues") })
  .strict()
  .refine(scheduleNeedsTask, { message: "a schedule watcher needs a task", path: ["task"] })
  .refine(zoneKnown, { message: "unknown time zone (use e.g. Europe/Berlin)", path: ["timezone"] })
  .refine(releaseNeedsSchedule, { message: "only a schedule watcher builds release files", path: ["release_build"] });

const WatcherSchema = z
  .object(watcherShape)
  .strict()
  .refine(scheduleNeedsTask, { message: "a schedule watcher needs a task", path: ["task"] })
  .refine(zoneKnown, { message: "unknown time zone (use e.g. Europe/Berlin)", path: ["timezone"] })
  .refine(releaseNeedsSchedule, { message: "only a schedule watcher builds release files", path: ["release_build"] })
  .superRefine((w, ctx) => {
    if (w.source !== "monitor") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(w.github_repo)) ctx.addIssue({ code: "custom", message: "owner/repo", path: ["github_repo"] });
      return;
    }
    const no = (path: string, set: boolean) => set && ctx.addIssue({ code: "custom", message: "a monitor does not use this", path: [path] });
    no("github_repo", w.github_repo !== "");
    no("flow", w.flow !== "default");
    no("precheck_flow", w.precheck_flow !== undefined);
    no("owner", w.owner !== undefined);
  });

/** Thresholds of the monitor watcher. */
const MonitorSchema = z
  .object({
    /** The same run resumed more than `resumes` times within `within_minutes` (at most 49: run.json keeps the last 50 resumes). */
    restart_loop: z.object({ resumes: z.number().int().min(1).max(49).default(5), within_minutes: z.number().int().min(1).max(1440).default(10) }).strict().prefault({}),
    /** A watcher's check failed for more than `checks` checks in a row. */
    watcher_error: z.object({ checks: z.number().int().min(1).max(1000).default(3) }).strict().prefault({}),
    /** More than `percent` of GitHub's hourly request limit used. */
    github_limit: z.object({ percent: z.number().min(1).max(100).default(80) }).strict().prefault({}),
    /** An enabled watcher finished no check for `intervals` times its interval. */
    watcher_silent: z.object({ intervals: z.number().min(1).max(1000).default(5) }).strict().prefault({}),
    /** At least `runs` failed runs with an error the Foundry cannot explain, within `within_hours`. */
    unexplained_failure: z.object({ runs: z.number().int().min(1).max(1000).default(1), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** A running run wrote nothing to its log for longer than its step's timeout plus `extra_minutes`; a step without a timeout counts `no_timeout_minutes`. */
    stuck_run: z.object({ extra_minutes: z.number().int().min(1).max(1440).default(10), no_timeout_minutes: z.number().int().min(1).max(10080).default(120) }).strict().prefault({}),
    /** The same step of the same flow ended a run as failed for `issues` different issues within `within_hours`. */
    same_step_failing: z.object({ issues: z.number().int().min(2).max(1000).default(3), within_hours: z.number().int().min(1).max(168).default(24) }).strict().prefault({}),
    /** An issue's status label did not match its newest run for more than `checks` checks. */
    label_mismatch: z.object({ checks: z.number().int().min(1).max(1000).default(3) }).strict().prefault({}),
    /** A lock is held by a run that is not running for more than `minutes`. */
    orphan_lock: z.object({ minutes: z.number().int().min(1).max(1440).default(10) }).strict().prefault({}),
    /** Jobs are queued, slots are free and nothing started for `minutes`. */
    queue_stalled: z.object({ minutes: z.number().int().min(1).max(1440).default(15) }).strict().prefault({}),
    /** A new version is installed and the server waited more than `hours` to restart. */
    restart_overdue: z.object({ hours: z.number().min(0.1).max(168).default(2) }).strict().prefault({}),
    /** The tests after a merge into develop failed `failures` times in a row; looks back `within_hours`. */
    develop_red: z.object({ failures: z.number().int().min(1).max(100).default(2), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** A step took more than `factor` times its usual time, `times` times within `within_hours`. */
    slow_step: z.object({ factor: z.number().min(1.5).max(100).default(3), times: z.number().int().min(1).max(1000).default(3), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** Decisions with policy.unavailable or policy.invalid: `decisions` or more within `within_hours`. */
    policy_service_failure: z.object({ decisions: z.number().int().min(1).max(1000).default(1), within_hours: z.number().int().min(1).max(720).default(1) }).strict().prefault({}),
    /** `runs` runs ended over 2 minutes ago without evidence.json (or with an incomplete stream), within `within_hours`. */
    evidence_finalization: z.object({ runs: z.number().int().min(1).max(1000).default(1), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** The p95 of a step's durations is above `minutes`, from at least `min_visits` visits within `within_hours`. */
    step_latency_p95: z.object({ minutes: z.number().min(1).max(10080).default(60), min_visits: z.number().int().min(1).max(1000).default(5), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** The same tool was refused `times` times in one repository within `within_hours`. */
    repeated_tool_denial: z.object({ times: z.number().int().min(1).max(1000).default(3), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** A step wrote more than `factor` times the median output of its flow + step, and more than `min_tokens`; the median needs `min_samples` visits. */
    abnormal_output: z.object({ factor: z.number().min(1.5).max(100).default(5), min_tokens: z.number().int().min(1).max(10_000_000).default(20000), min_samples: z.number().int().min(2).max(1000).default(5), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** The repository (owner/repo) where the monitor writes bug stories. Without it, findings are only shown. */
    report_to: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo").optional(),
    /** At most `per_day` new bug stories a day and `per_check` in one check (at most 3: it bounds the GitHub calls of a check). */
    report_limits: z.object({ per_day: z.number().int().min(1).max(50).default(3), per_check: z.number().int().min(1).max(3).default(1) }).strict().prefault({}),
    /** For this many minutes after the server started no bug story is made and none becomes owed (0: no quiet time). */
    cooldown_minutes: z.number().int().min(0).max(1440).default(10),
    /** A closed bug story whose fix is not running yet is watched anyway after this many days (the 24-hour clock starts then). */
    fix_wait_days: z.number().int().min(1).max(365).default(7),
    /** The circuit breaker: bug stories stop when more than `new_findings` different findings first appear within `within_minutes`, or when the newest `failed_fixes` finished runs of bug stories all failed. */
    breaker: z.object({ new_findings: z.number().int().min(1).max(499).default(5), within_minutes: z.number().int().min(1).max(1440).default(60), failed_fixes: z.number().int().min(1).max(100).default(3) }).strict().prefault({}),
  })
  .strict();

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const PROVIDER_KINDS = ["anthropic", "openai", "ollama", "lmstudio", "anthropic-compatible"] as const;

/** Where an agent's model runs. anthropic/anthropic-compatible serve Claude Code, openai serves Codex, local ones serve both. */
const ProviderSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS),
    base_url: z.string().url().optional(),
    /** Env var holding the API key (anthropic-compatible). */
    api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    /** Model used when a step names the provider but no model. */
    default_model: z.string().optional(),
    /** USD per million tokens, for providers that report tokens but no cost (Codex with an API key). */
    price: z.object({ input_per_mtok: z.number().nonnegative(), output_per_mtok: z.number().nonnegative() }).strict().optional(),
  })
  .strict();

const RouterRuleSchema = z
  .object({
    /** Regex on the step id. */
    step: z.string().optional(),
    /** Regex on the flow name. */
    flow: z.string().optional(),
    /** Only from this visit on (2 = retries / fix loops). */
    min_visit: z.number().int().positive().optional(),
    /** Model spec, e.g. sonnet, codex, codex:gpt-5, ollama:qwen3-coder. */
    model: z.string().min(1),
  })
  .strict();

const RouterSchema = z
  .object({
    /** First matching rule picks the model for agent steps that don't name one. */
    rules: z.array(RouterRuleSchema).default([]),
    /** Tried in order when an agent step hits a rate/usage limit, or (for free targets) when a budget is used up. */
    fallback: z.array(z.string().min(1)).default([]),
    fallback_on: z.array(z.enum(["rate_limit", "budget"])).default(["rate_limit", "budget"]),
  })
  .strict()
  .prefault({});

/** One allowed host entry: a DNS name, IPv4 address or bracketed IPv6 address, with an optional port. */
export function hostEntryOk(entry: string): boolean {
  let host = entry;
  let port: string | undefined;
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end < 0) return false;
    const rest = entry.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":")) return false;
    if (rest) port = rest.slice(1);
    host = entry.slice(1, end);
    if (isIP(host) !== 6) return false;
  } else {
    const i = entry.lastIndexOf(":");
    if (i >= 0) {
      port = entry.slice(i + 1);
      host = entry.slice(0, i);
    }
    if (host.length === 0 || host.length > 253) return false;
    if (!host.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l))) return false;
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  return true;
}

const ServerSchema = z
  .object({
    /** Address to listen on. Only these four: the Mac itself or all networks. Needs a restart. */
    listen: z.enum(["127.0.0.1", "::1", "0.0.0.0", "::"]).default("127.0.0.1"),
    /** Host names (optionally with port) accepted besides localhost, e.g. "mymac.local". */
    allowed_hosts: z.array(z.string().transform((s) => s.toLowerCase()).refine(hostEntryOk, "not a host name")).default([]),
    /** Accept requests from other computers over plain HTTP. Passwords and cookies are then unencrypted. */
    allow_insecure_http: z.boolean().default(false),
  })
  .strict()
  .prefault({});

const AuditSchema = z
  .object({
    /** Audit lines older than this many days are removed (at start and once a day). */
    retention_days: z.number().int().min(1).max(3650).default(180),
  })
  .strict()
  .prefault({});

const SelfUpdateSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** "owner/name": updates come only when the checkout's origin is this GitHub repository. */
    repo: z.string().refine(validGithubName, "not a GitHub repository name (owner/name)").optional(),
  })
  .strict()
  .refine((u) => !u.enabled || u.repo, { message: "name the repository the Foundry may update from (owner/name)", path: ["repo"] })
  .prefault({});

/** A name, or a prefix ending in `_*`, that an admin may list in `step_env`. */
export const STEP_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*(_\*)?$/;
/** Names that never go on that list: the engine's own, the login and git and ssh settings. */
export const STEP_ENV_REFUSED = /^(FACTORY_|SCF_|GH_|GITHUB_|GIT_|SSH_)/;
const stepEnvName = z.string().refine((n) => STEP_ENV_NAME.test(n) && !STEP_ENV_REFUSED.test(n), "not a variable name the steps of a user's run may get");

/** The interval of `skills.update_check.every` in ms: `<n>m` or `<n>h` from 5m to 24h; undefined for anything else. */
export function updateEveryMs(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^([1-9]\d{0,3})(m|h)$/.exec(text);
  if (!m) return undefined;
  const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
  return ms >= 300_000 && ms <= 86_400_000 ? ms : undefined;
}

/** `owner/name` or `host/owner/name`. */
export const DEPLOYMENT_REPOSITORY_RE = /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
/** An OTLP/HTTP address: http(s), no user or password, no query or fragment, no whitespace or control characters; plain http only for this machine. */
function isOtlpEndpoint(s: string): boolean {
  if (/[\s\p{Cc}]/u.test(s) || s.includes("?") || s.includes("#")) return false;
  if (!URL.canParse(s)) return false;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "" || u.hostname === "") return false;
  return u.protocol === "https:" || LOOPBACK.test(u.hostname);
}

export const OtlpSchema = z
  .object({
    /** Send the telemetry events to an OpenTelemetry collector (OTLP/HTTP, JSON logs). */
    enabled: z.boolean().default(false),
    /** The logs address of the collector, e.g. http://127.0.0.1:4318/v1/logs. */
    endpoint: z
      .string()
      .max(2048)
      .refine(isOtlpEndpoint, "must be an http(s) address without user, password, ? or #; plain http only for 127.0.0.1, ::1 or localhost")
      .optional(),
    /** How long one request may take. */
    timeout_ms: z.number().int().min(100).max(60_000).default(5000),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.enabled && !o.endpoint) ctx.addIssue({ code: "custom", path: ["endpoint"], message: "is needed when enabled is true" });
  });
export type OtlpConfig = z.infer<typeof OtlpSchema>;

export const TelemetrySchema = z
  .object({
    /** Write the local telemetry files. */
    local: z.boolean().default(true),
    /** Telemetry files older than this many days (UTC) are removed. */
    keep_days: z.number().int().min(1).max(365).default(30),
    /** The optional OTLP exporter. */
    otlp: OtlpSchema.prefault({}),
  })
  .strict();
export type TelemetryConfig = z.infer<typeof TelemetrySchema>;

/** A list of at most 20 policy ids, each once; the built-in baseline is always asked and cannot be listed. */
const policyIds = () =>
  z
    .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "must be a policy id: lower-case letters, digits, . _ or -"))
    .max(20)
    .refine((l) => new Set(l).size === l.length, "names the same pack twice")
    .refine((l) => !l.includes(BASELINE_POLICY_ID), `${BASELINE_POLICY_ID} is built in and always asked: leave it out`);

export const ConfigSchema = z
  .object({
    /** Where and for whom the web UI is reachable. */
    server: ServerSchema,
    /** The audit log (`audit.jsonl`): how long lines are kept. */
    audit: AuditSchema,
    /** Model spec for agent steps with no model anywhere (flow, step or router). */
    default_model: z.string().optional(),
    /** Extra or overridden providers; anthropic, openai, ollama and lmstudio are built in. */
    providers: z.record(z.string().regex(/^[a-z][\w-]*$/), ProviderSchema).default({}),
    router: RouterSchema,
    /**
     * false: costs are still recorded and reported, but nothing stops on money — no run limit
     * (`limits.max_cost_usd`), no step limit (`max_budget_usd`), no daily budget. For fixed-price
     * subscriptions. Usage limits reported by Claude/Codex themselves still pause runs.
     */
    cost_limits: z.boolean().default(true),
    /** Stop starting new work once today's spend reaches this. */
    daily_budget_usd: z.number().positive().optional(),
    /** Max runs executing at the same time (across all repos). */
    concurrency: z.number().int().positive().default(2),
    /** Pushes to these branches are refused (glob patterns). */
    protected_branches: z.array(z.string()).default(["main", "master", "develop", "release/*"]),
    /**
     * Build bug stories of the built-in issue-gitflow as hotfixes: after the reviews and a green test run
     * they are merged into main (and develop) without a person. Off: bug stories are built as features.
     */
    hotfix_to_main: z.boolean().default(false),
    /**
     * Run agent steps without your personal setup: Claude Code skips MCP servers, plugins, skills,
     * hooks and user settings; Codex skips `~/.codex/config.toml`, or uses a private folder with a key
     * or a local model. Smaller context every turn and no off-task detours.
     */
    isolate_agents: z.boolean().default(true),
    /** Block pushes whose new commits add secrets (API keys, private keys, .env files). */
    secret_scan: z.boolean().default(true),
    /** The redesigned pages (still being built); off by default. */
    ui: z.object({ redesign: z.boolean().default(false) }).strict().prefault({}),
    notify: z
      .object({
        macos: z.boolean().default(true),
        slack_webhook: z.string().url().optional(),
        /** Shell command run with FACTORY_EVENT, FACTORY_RUN_ID, FACTORY_STATUS, FACTORY_MESSAGE in env. */
        command: z.string().optional(),
        /** Which run outcomes run the command (macOS and Slack tell only what waits for you). */
        on: z.array(z.enum(["succeeded", "failed", "stopped", "waiting", "cancelled"])).default(["succeeded", "failed", "stopped", "waiting"]),
        /** Also tell when a run succeeds. */
        successes: z.boolean().default(false),
        /** At most one notification in this many minutes. */
        throttle_minutes: z.number().int().min(1).default(5),
        /** No notifications between these times ("HH:MM", this machine's clock; may cross midnight). */
        quiet_hours: z.object({ from: clock, to: clock }).strict().optional(),
        /** "HH:MM": send a short summary once a day. */
        daily_summary_at: clock.optional(),
      })
      .strict()
      .prefault({}),
    /** The one-sentence reason a model writes for a failed run (a small call; the rules text is the fallback). */
    failure_summary: z
      .object({ enabled: z.boolean().default(true), model: z.string().default("haiku") })
      .strict()
      .default({ enabled: true, model: "haiku" }),
    /**
     * Ask SCF, the help assistant: off until an admin switches it on. A turn is one question; it runs through the
     * provider of `model` with no tools, and stops at these limits.
     */
    help: z
      .object({
        enabled: z.boolean().default(false),
        /** Lets Ask SCF propose a resume or cancel of a person's own run (and, after #568, carry it out once they confirm). Off: every proposed action is dropped. */
        actions: z.boolean().default(false),
        /**
         * Emergency stop: nobody can ask, try again or check a page; turns that already run finish and every account keeps
         * reading, exporting and deleting its conversations. `enabled: false` is "never set up" and shows no button.
         */
        paused: z.boolean().default(false),
        /** Who may ask when Ask SCF is on: every account (also without the setting), administrators only, or administrators and `pilot_accounts`. */
        audience: z.enum(["everyone", "admins", "pilot"]).optional(),
        /** With `audience: "pilot"`: the accounts (by id) that may ask besides the administrators. */
        pilot_accounts: z.array(z.uuid()).max(1000).optional(),
        /** Accounts (by id) that may not ask, whatever their role. They keep reading, exporting and deleting their conversations. */
        disabled_accounts: z.array(z.uuid()).max(1000).optional(),
        /** A conversation that is not changed for this many days is deleted; without it 90. A lower number deletes older ones at once. */
        keep_days: z.number().int().min(1).max(3650).optional(),
        /** Model spec for a help turn; without it `default_model`. Only a Claude Code target can answer: it is the one that runs with no tools at all. */
        model: z.string().optional(),
        /** A turn that takes longer is stopped. */
        timeout_seconds: z.number().int().min(5).max(600).default(60),
        /** Turns answered at the same time, over all accounts. One account has one turn at a time. */
        max_parallel: z.number().int().min(1).max(8).default(1),
        /** Turns that may wait for a free place; one more is refused. */
        max_queued: z.number().int().min(0).max(100).default(10),
        /** Turns one account may start per day (UTC). */
        turns_per_user_per_day: z.number().int().min(1).max(10_000).default(30),
        /** The most one turn may cost (not applied with `cost_limits: false` or a model without a price). */
        max_cost_usd_per_turn: z.number().positive().max(100).default(0.1),
        /** The most all help turns of a day may cost together; without it only the limits above apply. */
        daily_budget_usd: z.number().positive().optional(),
        /**
         * Regular expressions (no flags; upper and lower case are the same) for texts this install keeps private, besides the stored
         * credentials and the common shapes of tokens and keys. What matches is taken out of every text before Ask SCF stores it or sends it to a model.
         */
        sensitive_patterns: z.array(z.string().min(1).max(PATTERN_MAX).refine(usablePattern, { message: "not a regular expression, or one that matches the empty text" })).max(PATTERN_LIMIT).optional(),
      })
      .strict()
      .prefault({}),
    /** Commit/comment as a bot instead of you. */
    bot: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        /** Name of an env var holding a GitHub token for the bot account (used as GH_TOKEN). */
        gh_token_env: z.string().optional(),
      })
      .strict()
      .default({}),
    /** GitHub App identity (takes precedence over bot.gh_token_env). */
    github_app: z
      .object({
        app_id: z.string(),
        /** Only for the bot identity (runs commit and comment as the app). */
        installation_id: z.string().optional(),
        private_key_path: z.string(),
        /** The app's name in https://github.com/apps/<slug>; needed for the repository method "GitHub App". */
        slug: z.string().regex(/^[A-Za-z0-9-]{1,100}$/, "the app name may only have letters, digits and -").optional(),
      })
      .strict()
      .optional(),
    /** Variables of the server that steps of a user's run may also see (a name, or a prefix ending in _*). */
    step_env: z
      .object({
        /** All steps. */
        pass: z.array(stepEnvName).max(100).default([]),
        /** Agent steps only. */
        agent_pass: z.array(stepEnvName).max(100).default([]),
      })
      .strict()
      .prefault({}),
    /** Defaults for flows that don't set their own sandbox. */
    sandbox: z
      .object({
        claude: z.boolean().optional(),
        docker_image: z.string().optional(),
        /** `required`: a shell step of a user's run is held in an OS sandbox, or the run is refused. `off`: allowed without it. */
        user_runs: z.enum(["required", "off"]).default("required"),
        /** Absolute paths a sandboxed shell step of a user's run may read, besides its own folder (for example a node folder under the home). */
        user_read: z.array(z.string().refine((p) => isAbsolute(p), "must be an absolute path")).max(50).default([]),
      })
      .strict()
      .default({ user_runs: "required", user_read: [] }),
    watchers: z.array(WatcherSchema).default([]),
    /** Thresholds of the monitor watcher. */
    monitor: MonitorSchema.prefault({}),
    /** Where approved skill packages are read from. Personal agent folders (.claude, .codex) are never scanned. */
    skills: z
      .object({
        /** Scan the skills shipped with the Foundry. */
        builtin: z.boolean().default(true),
        /** Extra administrator-managed folders (absolute). <data folder>/skills is always scanned. */
        roots: z
          .array(
            z
              .string()
              .refine((p) => isAbsolute(p), "must be an absolute path")
              .refine((p) => !p.split(/[\\/]/).some((s) => s === ".claude" || s === ".codex"), "personal agent folders are never scanned"),
          )
          .max(20)
          .default([]),
        /** Also read <repo>/.claude-factory/skills. Off: repository skills are never loaded. */
        repository: z.boolean().default(false),
        /** Catalogue releases this installation accepts. Administrator folders load only as one of them. */
        releases: z
          .object({
            /** Development only: administrator folders that are not an approved release are loaded too. */
            allow_unreleased: z.boolean().default(false),
            approved: z
              .array(
                z
                  .object({
                    catalogue: SkillIdSchema,
                    version: SkillVersionSchema,
                    digest: z.string().regex(SKILL_DIGEST_RE, "must be sha256: and 64 hex digits"),
                    key: SkillIdSchema.optional(),
                    signature: z.string().refine((s) => !!decodeBase64Exact(s, 64), "must be base64 of 64 bytes").optional(),
                    /** Absolute local folder of this release (schema 2); `scf skills release adopt` copies it into the release store. */
                    artifact: z
                      .string()
                      .superRefine((p, ctx) => {
                        const m = artifactPathProblem(p);
                        if (m) ctx.addIssue({ code: "custom", message: m });
                      })
                      .optional(),
                  })
                  .strict(),
              )
              .max(50)
              .default([]),
            /** Trusted Ed25519 public keys. Once set, every approved release must be signed by one of them. */
            keys: z.array(z.object({ id: SkillIdSchema, ed25519: z.string() }).strict()).max(MAX_RELEASE_KEYS).default([]),
            /** The deployment repository `scf skills release propose` opens its pull request in, and the config file in it. */
            deployment: z
              .object({
                repository: z.string().regex(DEPLOYMENT_REPOSITORY_RE, "must be owner/name or host/owner/name"),
                file: z
                  .string()
                  .max(300)
                  .superRefine((p, ctx) => {
                    const m = relativePathProblem(p) ?? (/[\u0000-\u001f\u007f]/.test(p) ? "path has a control character" : /\.ya?ml$/.test(p) ? undefined : "must end in .yaml or .yml");
                    if (m) ctx.addIssue({ code: "custom", message: m });
                  }),
              })
              .strict()
              .optional(),
          })
          .strict()
          .superRefine((r, ctx) => {
            const ids = new Set<string>();
            r.keys.forEach((k, i) => {
              if (!decodeBase64Exact(k.ed25519, 32)) ctx.addIssue({ code: "custom", path: ["keys", i, "ed25519"], message: "must be base64 of a 32-byte Ed25519 public key" });
              if (ids.has(k.id)) ctx.addIssue({ code: "custom", path: ["keys", i, "id"], message: `"${k.id}" is listed twice` });
              ids.add(k.id);
            });
            r.approved.forEach((a, i) => {
              if ((a.key === undefined) !== (a.signature === undefined)) ctx.addIssue({ code: "custom", path: ["approved", i], message: "needs both key and signature" });
              else if (a.key !== undefined && !ids.has(a.key)) ctx.addIssue({ code: "custom", path: ["approved", i, "key"], message: `"${a.key}" is not in skills.releases.keys` });
            });
            const seen = new Set<string>();
            r.approved.forEach((a, i) => {
              const k = `${a.catalogue}@${a.version}`;
              if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["approved", i], message: `${k} is listed twice` });
              seen.add(k);
            });
          })
          .prefault({}),
        /** Limits and pin/exclude lists of the skill catalogue a planner gets. Installation-wide. */
        catalogue: z
          .object({
            max_candidates: z.number().int().min(CATALOGUE_RANGE.maxCandidates[0]).max(CATALOGUE_RANGE.maxCandidates[1]).default(CATALOGUE_DEFAULTS.maxCandidates),
            max_tokens: z.number().int().min(CATALOGUE_RANGE.maxTokens[0]).max(CATALOGUE_RANGE.maxTokens[1]).default(CATALOGUE_DEFAULTS.maxTokens),
            /** Skill ids that are always in the catalogue. */
            include: z.array(SkillIdSchema).max(CATALOGUE_RANGE.include).default([]),
            /** Skill ids that are never in the catalogue. Wins over include. */
            exclude: z.array(SkillIdSchema).max(CATALOGUE_RANGE.exclude).default([]),
          })
          .strict()
          .superRefine((c, ctx) => {
            const dup = (key: "include" | "exclude") =>
              c[key].forEach((id, i) => {
                if (c[key].indexOf(id) !== i) ctx.addIssue({ code: "custom", path: [key, i], message: `duplicate "${id}"` });
              });
            dup("include");
            dup("exclude");
            if (c.include.length > c.max_candidates) ctx.addIssue({ code: "custom", path: ["include"], message: "more pinned skills than max_candidates" });
            if (CATALOGUE_COST.header + CATALOGUE_COST.minimalEntry * c.include.length > c.max_tokens)
              ctx.addIssue({ code: "custom", path: ["include"], message: "the pinned skills do not fit max_tokens" });
          })
          .prefault({}),
        /** What the skill resolver may select for a plan: limits, mandatory ids (include) and refused ids (exclude). Installation-wide. */
        selection: z
          .object({
            max_skills: z.number().int().min(RESOLVE_RANGE.maxSkills[0]).max(RESOLVE_RANGE.maxSkills[1]).default(RESOLVE_DEFAULTS.maxSkills),
            max_skill_tokens: z.number().int().min(RESOLVE_RANGE.maxSkillTokens[0]).max(RESOLVE_RANGE.maxSkillTokens[1]).default(RESOLVE_DEFAULTS.maxSkillTokens),
            max_tokens: z.number().int().min(RESOLVE_RANGE.maxTokens[0]).max(RESOLVE_RANGE.maxTokens[1]).default(RESOLVE_DEFAULTS.maxTokens),
            /** Skill ids that are always selected. Not an approval: they still need a pin. */
            include: z.array(SkillIdSchema).max(RESOLVE_RANGE.include).default([]),
            /** Skill ids that are never selected. */
            exclude: z.array(SkillIdSchema).max(RESOLVE_RANGE.exclude).default([]),
            /** Capabilities only one skill may provide in a run. A run offers, locks and loads only the canonical provider. */
            exclusive: z.array(SkillIdSchema).max(CANONICAL_LIMITS.exclusive).default([]),
          })
          .strict()
          .superRefine((c, ctx) => {
            for (const key of ["include", "exclude", "exclusive"] as const)
              c[key].forEach((id, i) => {
                if (c[key].indexOf(id) !== i) ctx.addIssue({ code: "custom", path: [key, i], message: `duplicate "${id}"` });
              });
            if (c.include.length > c.max_skills) ctx.addIssue({ code: "custom", path: ["include"], message: "more mandatory skills than max_skills" });
            c.include.forEach((id, i) => {
              if (c.exclude.includes(id)) ctx.addIssue({ code: "custom", path: ["include", i], message: `"${id}" is also in exclude` });
            });
          })
          .prefault({}),
        /** The review checks (REVIEW.md) a reviewer session gets. Applied below selection.max_tokens and below the coding block of the same run. */
        review: z
          .object({
            max_tokens: z.number().int().min(REVIEW_RANGE.maxTokens[0]).max(REVIEW_RANGE.maxTokens[1]).default(REVIEW_DEFAULTS.maxTokens),
            max_skill_tokens: z.number().int().min(REVIEW_RANGE.maxSkillTokens[0]).max(REVIEW_RANGE.maxSkillTokens[1]).default(REVIEW_DEFAULTS.maxSkillTokens),
          })
          .strict()
          .prefault({}),
        /** What to do with a requested skill that cannot be used. */
        unresolved: UnresolvedPolicySchema,
        /** Which tools a skill may ask for. Decides whether a run may go past the plan gate with a skill; it never limits a session. */
        tools: ToolPolicySchema,
        /** The server runs the due skill-source checks from this catalogue clone, every `every`. No folder: off. */
        update_check: z
          .object({
            folder: z
              .string()
              .refine((p) => isAbsolute(p), "must be an absolute path")
              .refine((p) => !p.split(/[\\/]/).some((s) => /^\.(?:claude|codex)$/i.test(s)), "personal agent folders (.claude, .codex) cannot be used")
              .optional(),
            every: z.string().default("1h").refine((s) => updateEveryMs(s) !== undefined, "an interval like 30m or 6h, from 5m to 24h"),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .superRefine((s, ctx) => {
        s.selection.include.forEach((id, i) => {
          if (s.catalogue.exclude.includes(id))
            ctx.addIssue({ code: "custom", path: ["selection", "include", i], message: `a mandatory skill is excluded from the catalogue ("${id}")` });
        });
      })
      .prefault({}),
    /** The running Foundry updates itself from main of its own repository after a hotfix. Off by default. */
    self_update: SelfUpdateSchema,
    /**
     * Policy packs asked at every boundary of a run, in observe mode (decisions are recorded, nothing is stopped).
     * The built-in baseline (foundry.baseline) is always asked. Files: <data folder>/policies/<id>.json, in three layers:
     * `mandatory` (overlays), `repositories` (per "owner/name"), `packs` (optional). The most restrictive decision wins.
     */
    policy: z
      .object({
        packs: policyIds().default([]),
        mandatory: policyIds().default([]),
        repositories: z
          .record(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/, 'must be a repository as "owner/name" in lower case'), policyIds())
          .refine((r) => Object.keys(r).length <= 20, "at most 20 repositories")
          .default({}),
      })
      .strict()
      .prefault({}),
    /** Lifecycle telemetry: one value-free event per line in <data folder>/telemetry/events-YYYY-MM-DD.jsonl (the UTC day). */
    telemetry: TelemetrySchema.prefault({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const monitors = c.watchers.filter((w) => w.source === "monitor");
    if (monitors.length > 1) ctx.addIssue({ code: "custom", message: "only one monitor watcher is allowed", path: ["watchers"] });
    const m = monitors[0];
    if (m && c.watchers.some((w) => w !== m && w.id === m.id)) ctx.addIssue({ code: "custom", message: `the id "${m.id}" of the monitor is used by another watcher`, path: ["watchers"] });
  });

/** A watcher as the server runs it: from config.yaml, or from the repository store (then with `repoId` and the owner's account id). */
export type WatcherConfig = z.infer<typeof WatcherSchema> & { repoId?: string; ownerId?: string };
export type Config = Omit<z.infer<typeof ConfigSchema>, "watchers"> & { watchers: WatcherConfig[] };
export type ServerConfig = z.infer<typeof ServerSchema>;
export type SkillsConfig = Config["skills"];
export type SelfUpdateConfig = z.infer<typeof SelfUpdateSchema>;
export type MonitorConfig = z.infer<typeof MonitorSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type RouterConfig = z.infer<typeof RouterSchema>;
export { WatcherSchema, RepoWatcherSchema };
export type RepoWatcherOptions = z.infer<typeof RepoWatcherSchema>;

export const CONFIG_PATH = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "config.yaml");

export const STALE_CONFIG = "the settings changed since you loaded them — reload first";

/** The text of config.yaml; "" when there is no file. */
export function readConfigText(path = CONFIG_PATH()): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Names one state of the file: sha256 of its text, hex. */
export function configVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The settings in this text. */
export function parseConfigText(text: string, path = CONFIG_PATH()): Config {
  const res = ConfigSchema.safeParse(parse(text) ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigIssuesError(`${path}: invalid config\n${issues}`);
  }
  return res.data;
}

/** The file is YAML but not valid settings; the message is built from key paths and rules, not from lines of the file. */
export class ConfigIssuesError extends Error {}

export function loadConfig(path = CONFIG_PATH()): Config {
  if (!existsSync(path)) return ConfigSchema.parse({});
  return parseConfigText(readConfigText(path), path);
}

const round = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

/** `text` with `body` applied in place. Throws a ZodError for a bad body, an Error for unreadable text. */
export function editConfigText(text: string, body: unknown, path = CONFIG_PATH()): { text: string; config: Config } {
  const next = ConfigSchema.parse(body);
  const before = parseConfigText(text, path);
  const out = editYamlText(text, before, next, ConfigSchema.parse({}));
  const again = ConfigSchema.safeParse(parse(out) ?? {});
  if (!again.success || !isDeepStrictEqual(round(again.data), round(next))) {
    throw new Error("this change cannot be written to config.yaml without touching other settings; edit the file by hand");
  }
  return { text: out, config: next };
}

/** `text` without the setting `key` (dotted), so it takes its default. Throws for unreadable or invalid text, or when other settings would change. */
export function resetConfigText(text: string, key: string, path = CONFIG_PATH()): { text: string; config: Config } {
  const before = parseConfigText(text, path);
  const want = round(before) as Record<string, unknown>;
  const parts = key.split(".");
  let at: unknown = want;
  for (const p of parts.slice(0, -1)) at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[p] : undefined;
  if (typeof at === "object" && at !== null) delete (at as Record<string, unknown>)[parts[parts.length - 1]!];
  const expected = ConfigSchema.parse(want);
  const out = removeYamlKey(text, parts);
  const again = ConfigSchema.safeParse(parse(out) ?? {});
  if (!again.success || !isDeepStrictEqual(round(again.data), round(expected))) {
    throw new Error("this setting cannot be removed from config.yaml without touching other settings; edit the file by hand");
  }
  return { text: out, config: again.data };
}

export function saveConfig(config: unknown, path = CONFIG_PATH()): Config {
  const text = readConfigText(path);
  const out = editConfigText(text, config, path);
  if (out.text !== text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out.text);
  }
  return out.config;
}

/** Per-repo settings in <repo>/.claude-factory/config.yaml (e.g. test_cmd). */
const RepoConfigSchema = z
  .object({ vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).default({}) })
  .passthrough();

export function loadRepoVars(repo: string): Record<string, string> {
  const p = join(repo, ".claude-factory", "config.yaml");
  if (!existsSync(p)) return {};
  const res = RepoConfigSchema.safeParse(parse(readFileSync(p, "utf8")) ?? {});
  if (!res.success) throw new Error(`${p}: invalid repo config`);
  return res.data.vars;
}
