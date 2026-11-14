/**
 * Data classes (#869): every API rule has one class of data. A service account's scope may hold `class:<name>` for a grantable class,
 * which covers the GET rules of that class (never a change: POST, PUT and DELETE are granted by their own key). The sixth class,
 * `secret`, is not listed here: it is exactly the set of rules that can never be granted (`NEVER_GRANTED` in permissions.ts), so the
 * two cannot drift apart. A rule with no class fails a test; it does not break the module load.
 */
export type DataClass = "inbox" | "summary" | "log" | "diff" | "admin" | "secret";

export const DATA_CLASSES: readonly DataClass[] = ["inbox", "summary", "log", "diff", "admin", "secret"];
export type GrantableClass = Exclude<DataClass, "secret">;
export const GRANTABLE_CLASSES: readonly GrantableClass[] = ["inbox", "summary", "log", "diff", "admin"];

/** The rule keys (`METHOD path`) of each grantable class. Families of the inbox class are in INBOX_FAMILIES. */
export const CLASS_KEYS: Readonly<Record<GrantableClass, readonly string[]>> = {
  diff: ["GET runs/:id/diff"],
  log: ["GET runs/:id/events", "GET runs/:id/transcript/:n", "GET audit", "GET repos/:id/preview"],
  inbox: [
    "POST runs/:id/not-now", "POST runs/:id/answer", "POST runs/:id/approve", "POST runs/:id/reject", "POST runs/:id/checks/add", "POST runs/:id/checks",
    "GET your-turn", "POST your-turn/dismiss", "POST your-turn/restore", "GET your-turn/detail", "POST your-turn/act", "GET your-turn/mine", "GET clarity", "GET notices",
  ],
  summary: [
    "GET stats", "GET queue", "GET runs", "GET run-owners", "GET run-filters", "GET outcomes", "POST runs", "GET runs/:id",
    "POST runs/:id/cancel", "POST runs/:id/archive", "POST runs/:id/unarchive", "POST runs/:id/resume", "GET runs/:id/evidence", "GET runs/:id/context",
    "GET next", "GET board", "GET search", "GET since", "GET feed","GET repos", "GET repos/:id/ready", "GET repos/:id/epics", "GET repos/:id/epics/:issue", "GET repos/:id/safe-points",
  ],
  admin: [
    "GET info", "GET watchers", "POST watchers/:id/tick", "POST watchers/:id/pause", "POST watchers/:id/resume", "GET governor", "GET busy", "POST busy", "DELETE busy",
    "GET monitor", "GET monitor/findings/:id", "POST monitor/story", "POST monitor/off", "POST monitor/on", "POST monitor/mutes", "DELETE monitor/mutes/:id", "POST monitor/retry",
    "POST clean", "GET providers", "POST providers/test", "GET onboarding/progress", "PUT onboarding/progress", "DELETE onboarding/progress",
    "POST onboarding/sign-in", "POST onboarding/test-call", "GET starters", "POST starters/:id/project", "GET setup-check", "GET evals",
    "GET flows", "GET flows/:name", "PUT flows/:name", "DELETE flows/:name", "GET promotions", "POST promotions",
    "GET blocks", "PUT blocks/:id", "DELETE blocks/:id", "POST validate", "POST generate",
    "GET runs/:id/issue-limit", "PUT runs/:id/issue-limit", "GET health", "GET me/view", "PUT me/view",
    "GET skills/lifecycle", "POST skills/lifecycle", "POST skills/lifecycle/allow-run",
    "GET repos/methods", "POST repos", "PUT repos/:id/auth", "POST repos/:id/move-to-github", "POST repos/:id/test", "POST repos/:id/safe-points/restore",
    "POST repos/:id/preview", "DELETE repos/:id/preview", "DELETE repos/:id", "DELETE repos/:owner/:name",
    "GET admin/repos", "GET admin/repos/:id/budget", "PUT admin/repos/:id/budget", "PUT admin/repos/:id/workspace", "PUT admin/repos/:id/ready",
    "POST admin/repos/:id/transfer", "GET admin/repos/:id/watchers", "POST admin/repos/:id/watchers", "PUT admin/repos/:id/watchers/:wid", "DELETE admin/repos/:id/watchers/:wid",
    "GET admin/components", "GET help/usage",
  ],
};

/** Every rule whose path is one of these or starts with one of these plus `/` is in the inbox class (unless CLASS_KEYS names it). */
export const INBOX_FAMILIES: readonly string[] = ["changes", "refinement", "help"];

/**
 * Admin-only rules that never touch the data of a repository: they stay open to a service account while a repository is
 * closed to service accounts (`services: none`). `POST skills/lifecycle` is not here: it returns a scan across all runs.
 */
export const REPO_FREE: ReadonlySet<string> = new Set([
  "GET governor", "GET busy", "POST busy", "DELETE busy", "GET providers", "POST providers/test", "POST onboarding/sign-in", "POST onboarding/test-call",
  "GET starters", "POST starters/:id/project", "GET setup-check", "GET flows/:name", "PUT flows/:name", "DELETE flows/:name",
  "GET blocks", "PUT blocks/:id", "DELETE blocks/:id", "POST validate", "GET promotions", "POST promotions", "GET skills/lifecycle", "GET admin/components", "GET help/usage",
]);
