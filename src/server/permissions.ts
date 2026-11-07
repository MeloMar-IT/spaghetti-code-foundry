import { listFlows, type FlowListing } from "../flow/load.js";
import type { User } from "../auth/users.js";
import { isRefinementFlow } from "../flow/usage.js";
import type { Flow } from "../flow/schema.js";
import { HttpError, NAME_RE } from "./http.js";
import type { ApiContext } from "./server.js";
import { checkScope } from "./workspace-scope.js";

/**
 * Who may make which API call. An admin may make every call in the table; a user only the calls marked `yes`,
 * and the calls marked `own` on runs the user started (any other run answers 404, like an unknown one). A call that is not in the table is answered with 404.
 * A GET call with `?as=<id>` from an admin with a running view is answered with the rules of that user (see view-as.ts); `GET /api/session` ignores it.
 * The routes /api/session, /api/setup and /api/set-password need no session and are not in the table.
 */
export type UserAccess = "yes" | "no" | "own";

export interface Rule {
  method: string;
  /** Segments after /api; `:id` matches exactly one segment. */
  path: string;
  user: UserAccess;
  /** One short line for the table in the guide. */
  note: string;
  /** How the rule is kept to the caller's workspaces (#817). */
  scope: RuleScope;
}

/**
 * How a rule is kept to workspaces (#817): `admin` (admin-only route, install-wide), `run` (names one run; `authorize()` checks the
 * run's workspace), `repo` (names a repository by id), `repo-name` (by `owner/name`), `session` (names a refinement session),
 * `list` (a list, search, count, or a repository or run named in the body or query; the handler filters), `none` (not about
 * runs, repositories or sessions of a workspace).
 */
export type RuleScope = "admin" | "run" | "repo" | "repo-name" | "session" | "list" | "none";

/** The scope of every `yes` rule that is not a `repo`, `session` or `none` rule by its path (see scopeOfYes). */
const LIST_PATHS = new Set(["queue", "runs", "run-filters", "outcomes", "search", "repos", "refinement", "refinement/backlog", "help/context", "help/conversations/:id/actions", "help/conversations/:id/actions/confirm", "help/conversations/:id/handoffs"]);
const NONE_PATHS = new Set(["plugins/ui","flows", "password", "me/view", "credentials", "credentials/:id", "repos/methods", "onboarding/progress"]);

function scopeOfYes(path: string): RuleScope | undefined {
  if (path === "repos/methods") return "none";
  if (path === "repos/:owner/:name") return "repo-name";
  if (path.startsWith("repos/:id")) return "repo";
  if (path.startsWith("refinement/:id")) return "session";
  if (LIST_PATHS.has(path)) return "list";
  if (NONE_PATHS.has(path) || path.startsWith("help/")) return "none";
  return undefined;
}

/** A rule. `scope` defaults to `admin` for `no` and `run` for `own`; a `yes` rule needs one (given, or from scopeOfYes), else it cannot be built. */
const r = (method: string, path: string, user: UserAccess, note: string, scope?: RuleScope): Rule => {
  const s = scope ?? (user === "no" ? "admin" : user === "own" ? "run" : scopeOfYes(path));
  if (s === undefined) throw new Error(`rule ${method} ${path} needs a scope`);
  return { method, path, user, note, scope: s };
};

export const RULES: Rule[] = [
  r("GET", "info", "no", "server settings and today's cost"),
  r("GET", "config", "no", "read the settings from `config.yaml`; the `X-Config-Version` header names this version of the file. The Slack webhook is not returned: `notify.slack_webhook_set` says whether one is set. `plugins` is not returned"),
  r("GET", "plugins", "no", "the plugins loaded at server start, in order (label, module, version and what each registered), and plugin problems; never their options"),
  r("GET", "plugins/ui", "yes", "the pages and menu items that plugins added and your role may see (`pages`: plugin, id, title, module address, roles; `menu`: plugin, page, label); never a folder, a file path or a plugin option. With `?as=` the role of the viewed user"),
  r("PUT", "config", "no", "change the settings (not `plugins`: a body with that key is refused with 400, they are set in `config.yaml` only). With an `X-Config-Version` header from a read, a stale version is refused with 409 (reload first); the answer carries the new version. Without the header nothing is checked. A `notify.slack_webhook` left out keeps the stored webhook; `null` removes it; a string sets it. A broken `config.yaml` answers 400 with the line number. A refused save answers 400 and lists its problems as `issues` (`path`, `message`; at most 50) next to `error`"),
  r("GET", "settings", "no", "the description of the settings (label, help, kind, range, default, when a change takes effect) and the start-up settings with their values; no secret"),
  r("POST", "settings/reset", "no", "remove one described setting from `config.yaml` so it takes its default (a parent left empty goes too; comments above it stay). With an `X-Config-Version` header a stale version is refused with 409; the answer carries the new version and `removed`"),
  r("GET", "restart", "no", "which saved settings need a restart, whether the server can restart itself, and whether a restart waits (why, since when, active runs)"),
  r("POST", "restart", "no", "restart when no story is running: no new runs start until the active runs are done, and the watchers keep running (only a move of the data folder stops them); only when the server runs under the supervisor; writes an audit line"),
  r("DELETE", "restart", "no", "cancel a restart asked for after a settings change: runs and watchers start again; writes an audit line"),
  r("GET", "watchers", "no", "list the watchers"),
  r("POST", "watchers/:id/tick", "no", "run a watcher now"),
  r("GET", "governor", "no", "the load governor for the Overview page: the runs at once now and the caps that hold with their reasons, the free cores, the load of other programs with the top 5 programs by name, the Foundry's own load, and the changes of the cap in the last 24 hours; admins only, as it names programs"),
  r("GET", "busy", "no", "busy mode (\"I'm using this machine\"): whether it holds, the switch set by hand (since, until) and the program of `governor.busy_apps` that is running"),
  r("POST", "busy", "no", "switch busy mode on: at most `governor.busy_runs` runs at once and new run processes start at background priority; `hours` (above 0, at most 24) sets an end, without it busy mode stays on until it is switched off"),
  r("DELETE", "busy", "no", "switch busy mode off; busy mode that comes from a running program of `governor.busy_apps` stays until the program ends"),
  r("GET", "monitor", "no", "whether the monitor makes bug stories (on, off, quiet after a restart, or stopped by the circuit breaker), when it last checked, how many stories it made today, its findings with their states, its detectors and its mutes, and the monitor's settings with their ranges, defaults, values and whether config.yaml states them"),
  r("GET", "monitor/findings/:id", "no", "the evidence, bug stories and runs of one finding of the monitor"),
  r("POST", "monitor/story", "no", "make the bug story of one finding of the monitor now (the waiting rules do not apply; the off switch, mutes and the two tries do)"),
  r("POST", "monitor/off", "no", "stop the monitor from making bug stories"),
  r("POST", "monitor/on", "no", "let the monitor make bug stories again"),
  r("POST", "monitor/mutes", "no", "mute one detector or one finding of the monitor, with a reason, for a time or for good"),
  r("DELETE", "monitor/mutes/:id", "no", "end a mute"),
  r("POST", "monitor/retry", "no", "let the monitor try again for a finding that waits for a person (two bug stories did not fix it)"),
  r("POST", "clean", "no", "clean up old runs"),
  r("GET", "providers", "no", "agent providers"),
  r("GET", "onboarding/progress", "yes", "where this account is in the Get started guide: `{ step, answers, at }`, or `{ step: null, answers: {} }` when nothing is saved; only your own account"),
  r("PUT", "onboarding/progress", "yes", "save where this account is in the Get started guide (`step`: one of the guide's steps; optional `answers`: an object of at most 20 keys, each a lowercase name, at most 16384 bytes as JSON and nested at most 8 deep); the guide's own answers are checked too (`starter`, `about` with `who` and `what`, `name`, `style`, `where`: `local` or `github`; length limits, no control characters); a bad body answers 400 without the value, answers that are too large 413; replaces the saved entry, but `repoId` (the made project) and `making` (a project being made) are only set by the server and stay as stored; only your own account"),
  r("DELETE", "onboarding/progress", "yes", "clear where this account is in the Get started guide; answers 200 also when nothing is saved; only your own account"),
  r("POST", "onboarding/sign-in", "no", "start the sign-in of Claude Code (`claude auth login`) or Codex (`codex login`) on the computer that runs the Foundry (`tool`: `claude` or `codex`); its window opens there; fixed arguments, no shell, closed stdin, a 5-minute limit, one at a time per tool, stopped when the server stops; answers `started`, `done`, `missing` or `failed` in plain words, never the tool's output; admins only, as it runs on the server machine"),
  r("GET", "onboarding/agents", "no", "the answers about Claude Code and Codex (which tools, which plan, how to share, how busy), the settings they give, the current values of those six settings, the ones kept because an admin set them by hand, and a summary in plain words; admins only"),
  r("PUT", "onboarding/agents", "no", "save the answers (`answers`) and write the settings they give to `config.yaml` (`concurrency`, `governor.usage_percent`, `governor.priority`, `default_model`, `router.fallback`, `router.rules`); a setting an admin set by hand is kept and listed in `kept` unless `replace` names it; the same answers again change nothing; bad answers answer 400; with an `X-Config-Version` header a stale version is refused with 409; admins only"),
  r("GET", "starters", "no", "the starters you can make a project from (`id`, `title`, `description`, `needs`, `source`: `built-in` or `own`) and the broken own ones (`id`, `source`, `problem`); never a folder path; admins only"),
  r("POST", "starters/:id/project", "no", "make a new project from a starter (`name`, optional `parent`, an existing absolute folder outside the data folder): a git folder with `main` and `develop`, connected as a local repository with the starter's test command and tested; answers 201 with `repo` and `connection`; with `guide: true` one project is made per account and recorded in the guide answers once it is complete: a repeat answers 200 with `existing: true` and the same id, 409 when the guide was started again meanwhile, a progress file that cannot be used answers a fixed 500; 409 when the folder exists or the starter is broken, 404 for an unknown or hidden starter; any failure removes what it made; writes the audit line `repo-add`; admins only"),  r("POST", "onboarding/test-call", "no", "one tiny call through Claude Code (`haiku`) or Codex (its default model, low effort) (`tool`): no tools, no personal hooks or setup, a fixed prompt; answers `ok`, `missing`, `signed-out` or `failed` with a plain explanation, never the tool's output; admins only"),
  r("GET", "setup-check", "no","the setup check: whether git, Claude Code, Codex and their sign-ins (and with `need=node` Node.js) are ready on this computer, in plain words with a command or link to fix each; runs only fixed version, help and sign-in checks; admins only, as it describes the server machine"),
  r("POST", "providers/test", "no", "test a provider"),
  r("GET", "evals", "no", "eval reports"),
  r("GET", "stats", "no", "statistics"),
  r("GET", "flows", "yes", "list flows (a user sees the published flows only; an admin gets that list with `?published=1`)"),
  r("GET", "flows/:name", "no", "read a flow"),
  r("PUT", "flows/:name", "no", "save a flow"),
  r("DELETE", "flows/:name", "no", "delete a flow"),
  r("GET", "promotions", "no", "whether each component (`?kind=` and `?id=` narrow the list; `id` needs `kind`) is promoted, can be promoted or is blocked: its kind, id, version and hash, the promotion record (report ids and hashes) or the blocking suites with what to do; no report content"),
  r("POST", "promotions", "no", "promote one component (`kind`, `id`, `reportId` of a passing safety report) and write its record; a component that is blocked answers 409 with the `blocking` list and writes nothing; writes an audit line"),
  r("GET", "blocks", "no", "list blocks"),
  r("PUT", "blocks/:id", "no", "save a block"),
  r("DELETE", "blocks/:id", "no", "delete a block"),
  r("POST", "validate", "no", "check a flow; answers `{ ok, flow }` or `{ ok: false, error, issues }` (`issues` is `[{ path, message }]`, empty for a YAML syntax error)"),
  r("POST", "generate", "no", "write a flow with AI"),
  r("GET", "queue", "yes", "the queue (a user sees their own queued runs and how many are ahead)"),
  r("GET", "runs", "yes", "list runs that are not archived (a user sees their own); `?archived=1` lists the archived ones; `q`, `repo`, `flow`, `status` and `since` narrow the list before the 200-run cap"),
  r("GET", "run-owners", "no", "the accounts that have runs, for the owner filter"),
  r("GET", "run-filters", "yes", "the repositories and flows of the runs you can see, for the filter menus"),
  r("GET", "outcomes", "yes", "the outcome measures of the runs you can see over the last `days` (1 to 90, default 30), with optional `repo` and `flow`, and for an admin `model` (`agent:provider:model`) and `policy` (`id@version`); a user sees no cost, no returning users and no model or policy values"),
  r("GET", "autonomy", "no", "the autonomy level of every repository and flow and its promotion gate: whether it has earned the next level, with the checks evidence completeness, eval pass rate, policy conformance, operational SLOs and approval (pending), any waiting promotion request with its token, who asked and who may approve it, the level of the newest run, and the accountable owner; read-only, changes nothing"),
  r("GET", "autonomy/history", "no", "the changes of the autonomy levels, newest first: every audit line whose action starts with `autonomy-` (at most 500, with `more` when older ones exist); `?target=repos:<id>` or `?target=flows:<name>` reads one component; read-only"),
  r("POST", "autonomy/promote", "no", "ask for one autonomy level more for a repository or flow (`kind` `repos` or `flows`, `id`, `to`, `reason` of 1 to 200 characters); `to` must be one level above the current one and the promotion gate must pass (else 409 with `gate`); the answer carries the request `token`; writes an audit line"),
  r("POST", "autonomy/approve", "no", "carry out a waiting promotion request (`kind`, `id`, `to`, `token`); only the accountable owner may approve, and a move to `guarded-write` or `delivery-handoff` needs an approver who did not ask (unless there is one active admin); the level and the gate are checked again, and a request that no longer fits expires (409); writes an audit line"),
  r("POST", "autonomy/demote", "no", "lower an autonomy level at once (`kind`, `id`, `to`, `reason`); any admin, no gate; the component can go up again only through promote and approve; writes an audit line"),
  r("POST", "runs", "yes", "start a run (a user: a published flow and own repositories; an admin with `likeUser: true` follows the same rules; a release-build flow: a user may build only the repository's default branch (its `mainBranch` setting, else `main`), also when the published flow fixes the ref)"),
  r("GET", "runs/:id", "own", "read a run (a user: without costs and setup)"),
  r("POST", "runs/:id/cancel", "own", "cancel a run that runs, is queued, waits or is stopped"),
  r("POST", "runs/:id/archive", "own", "archive a finished run: it leaves the list of runs (`GET /api/runs?archived=1` lists the archived ones); nothing is deleted"),
  r("POST", "runs/:id/unarchive", "own", "take a run out of the archive again"),
  r("POST", "runs/:id/resume", "own", "resume a run (an architect run: ask again from its refinement session); 409 when its issue is closed on GitHub (see \"A run of a closed issue\" in chapter 3)"),
  r("POST", "runs/:id/answer", "own", "answer the questions a run stopped with; the run continues with the answer"),
  r("POST", "runs/:id/approve", "own", "approve a run, with a note; 409 for a closed issue, as for resume"),
  r("POST", "runs/:id/reject", "own", "reject a run, with a note; 409 for a closed issue, as for resume"),
  r("GET", "runs/:id/events", "own", "follow a run live (a user: without costs and setup)"),
  r("GET", "runs/:id/diff", "own", "the changes of a run"),
  r("GET", "runs/:id/evidence", "own", "the evidence of a run: its manifest, whether it still verifies, and the hashes of the files it names (never their content; a user: without models, policy rules, pack hashes and account ids; `policyDecisions` holds the grouped policy decisions of the run); `state` is `not_available` for a run without a manifest"),
  r("GET", "runs/:id/context", "own", "the context sources of a run and the ones left out, each with a status and a next action (never source text; a user: no address, id or owners for any entry, and only kind, classification, selection and freshness for confidential and restricted sources); `state` is `absent` for a run without a bundle"),
  r("GET", "runs/:id/transcript/:n", "no", "the transcript of a step"),
  r("GET", "next", "no", "what happens next, for all runs"),
  r("GET", "health", "no", "server health"),
  r("GET", "board", "no", "the board of all work"),
  r("GET", "search", "yes", "find runs, repositories, refinement sessions and flows by text or id (a user: their own and the flows they can start; an admin: all accounts and the board's issues)"),
  r("GET", "since", "no", "what changed since a time"),
  r("GET", "your-turn", "no", "what waits for you"),
  r("POST", "your-turn/dismiss", "no", "dismiss an item"),
  r("POST", "your-turn/restore", "no", "restore dismissed items; with `{ \"key\": \"…\" }` only that item"),
  r("GET", "your-turn/detail", "yes", "the questions, plan or split of an item; a user: only an item of a project they own whose watcher does not use the server's own GitHub login (any other item: 404, as for an unknown one)", "list"),
  r("POST", "your-turn/act", "yes", "answer, approve, reject or retry an item, as a comment on the issue (on a local project: on the story, with no GitHub call); retry of a closed issue is 409, as for resume; a user: only on an item of a project they own, not with the server's own GitHub login (any other item: 404), and the answer is that of `your-turn/mine`", "list"),
  r("GET", "your-turn/mine", "yes", "the items you may answer, approve or retry: `{ items: [{ key, kind, runId?, acts }] }` with opaque keys (a user: only items of projects they own, not with the server's own GitHub login; an admin: all); no repository name and no comment text", "list"),
  r("GET", "clarity", "no", "how long items waited for you, and what Your turn missed"),
  r("POST", "password", "yes", "change your own password (the other sessions of the account end)"),
  r("GET", "me/view", "yes", "your view (Simple, Advanced or Admin) and the views your role may choose; without a choice an admin gets Admin and a user Advanced; also the contact text of the Help page (`helpContact`, empty when not set)"),
  r("PUT", "me/view", "yes", "choose your view (`view`: `simple`, `advanced` or `admin`); it is kept for your account and used at the next sign-in on any device; a view your role may not use is refused with 403. The view changes only what the display shows, never what the server allows"),
  r("GET", "credentials", "yes", "your stored credentials"),
  r("POST", "credentials", "yes", "store a credential"),
  r("DELETE", "credentials/:id", "yes", "remove a credential"),
  r("GET", "users", "no", "list the accounts"),
  r("GET", "users/limits", "no", "the default limits for all accounts and the overrides per account (all three are enforced)"),
  r("PUT", "users/limits", "no", "set or clear the default limits: runs at the same time, runs per day, daily budget in USD (null clears one)"),
  r("POST", "users", "no", "add an account without a password; the answer has its one-time set-password token"),
  r("PUT", "users/:id", "no", "change the name, e-mail or role of an account"),
  r("PUT", "users/:id/limits", "no", "set or clear the limits of one account; a cleared one follows the default again"),
  r("POST", "users/:id/block", "no", "block an account, end its sessions and cancel its queued jobs"),
  r("POST", "users/:id/unblock", "no", "unblock an account"),
  r("POST", "users/:id/link", "no", "a new set-password token for an account without a password"),
  r("POST", "users/:id/reset", "no", "take the password of an account away, end its sessions and give a one-time set-password token"),
  r("POST", "users/:id/unlock", "no", "remove the lock after too many wrong tries (a short wait for the address can remain)"),
  r("GET", "users/:id/app-repos", "no", "the repositories an account may connect through the GitHub App"),
  r("PUT", "users/:id/app-repos", "no", "set the repositories an account may connect through the GitHub App (`owner/name` or `owner/*`); an empty list allows none"),
  r("DELETE", "users/:id", "no", "delete an account with its sessions, repositories, refinement sessions, Ask SCF conversations and stored credentials"),
  r("GET", "skills/lifecycle", "no", "the skill versions that are deprecated, quarantined, retired or revoked (a release revocation wins over a local state), and a `problem` when the lifecycle record cannot be read"),
  r("POST", "skills/lifecycle", "no", "set the lifecycle state of one approved or built-in skill version (`key`, `state`, `reason`, optional `replacement`); the answer has the `transition` and the `lockedRuns`; a revoked version never changes again (409)"),
  r("POST", "skills/lifecycle/allow-run", "no", "let one run go on with a quarantined skill version (`runId`, `key`, `reason`); the version is checked against the skills folder of the run's own workspace; 409 for a revoked version or a run that does not lock it; resume the run afterwards"),
  r("GET", "audit", "no", "read the audit log, newest first, with filters"),
  r("GET", "audit/export", "no", "download the audit log as CSV, with the same filters"),
  r("GET", "repos", "yes", "your repositories, each with its autonomy level"),
  r("GET", "repos/methods", "yes", "the sign-in methods you may choose (`none` and `local` only for an admin), and the link to install the GitHub App"),
  r("POST", "repos", "yes", "add a repository (a URL, and a token or a deploy key for it; an admin may also add `local`: the absolute path of a git repository on this machine, whose stories stay in `.scf/stories/`)"),
  r("PUT", "repos/:id/auth", "yes", "change the method, user name, token or address of your repository, or make a new deploy key"),
  r("POST", "repos/:id/move-to-github", "no", "move your local project to GitHub: create a private repository with your GitHub token sign-in (or use one of your GitHub repositories), push all branches and tags (never forced), move the stories, then move the watchers and settings and remove the local record; `dryRun` changes nothing and answers a single-use `confirm` token (valid for 10 minutes, none when a story cannot go along); a real move needs that token and stops with 409 (\"Nothing was published\") when it is missing, used, expired, for another request, or when the branches, tags or stories changed since the check; safe to repeat"),
  r("POST", "repos/:id/publish-remote", "no", "Yes, publish for the plain push to the folder's remote (only the owner of the local project): `{ dryRun: true, settings? }` shows the remote of the develop and of the main branch (addresses without sign-in), the branches and the tags, and answers a single-use `confirm` token; `{ confirm, settings? }` then saves the settings and turns `pushRemote` on in one step; 409 when the token does not fit, the remotes or the settings changed since the check, or the folder has no remote; writes an audit line"),
  r("POST", "repos/:id/test", "yes", "test the connection of your repository (an admin: any repository); the result is saved as its connection status"),
  r("GET", "repos/:id/ready", "yes", "the Definition of Ready of your repository (an admin: any repository)"),
  r("GET", "repos/:id/epics", "yes", "the epics of your repository with counts, growth, the expected finish and what holds each up, from what the watchers saved (no call to GitHub); saves the day's forecast (an admin: any repository)"),
  r("GET", "repos/:id/epics/:issue", "yes", "one epic of your repository: its stories in build order, chains and critical path, the series per day, the pace, the median story time and the forecast per day (an admin: any repository)"),
  r("POST", "repos/:id/preview", "yes", "start the develop version, or the version of a run that waits for your check (`version`, `runId`), of your repository (an admin: any repository) in a folder of its own; replaces a running one; answers 202"),
  r("GET", "repos/:id/preview", "yes", "the state, URL, reason, version and redacted output of the preview of your repository (an admin: any repository)"),
  r("DELETE", "repos/:id/preview", "yes", "stop the preview of your repository and remove its folder"),
  r("DELETE", "repos/:id", "yes", "remove your repository and its stored token or key"),
  r("DELETE", "repos/:owner/:name", "yes", "remove a GitHub repository by name (old form)"),
  r("GET", "admin/repos", "no", "the repositories of all accounts, with their settings and autonomy level"),
  r("PUT", "admin/repos/:id/settings", "no", "set the test command, docs, protected branches, branch names, release-build recipe (`releaseRecipe`, YAML text up to 16384 characters, checked like `.factory/release-build.yaml`) and the decide-technical-questions switch (`questions: { decide_technical: boolean }`, on unless `false`) of a repository; writes an audit line. It cannot turn `pushRemote` on (409): that is the owner's Yes, publish (`POST repos/:id/publish-remote`); keeping it on and turning it off work"),
  r("GET", "admin/repos/:id/budget", "no", "the daily spending cap of a repository, the Simple default, the cap in effect and today's spend"),
  r("PUT", "admin/repos/:id/budget", "no", "set (a number above 0) or clear (null) the daily spending cap of a repository; writes an audit line"),
  r("PUT", "admin/repos/:id/workspace", "no", "set the workspace of a repository (`workspace`: an id from `workspaces` in config.yaml or from a plugin; `null` or `default` puts it back in the default workspace); writes an audit line"),
  r("PUT", "admin/repos/:id/ready", "no", "set the Definition of Ready of a repository, or put the default list back"),
  r("POST", "admin/repos/:id/transfer", "no", "move a repository to another account, by e-mail"),
  r("GET", "admin/repos/:id/watchers", "no", "the watchers of a repository, with status and holds"),
  r("POST", "admin/repos/:id/watchers", "no", "add a watcher to a repository (GitHub, with a sign-in that can call the GitHub API)"),
  r("PUT", "admin/repos/:id/watchers/:wid", "no", "change a watcher of a repository, or enable or disable it"),
  r("DELETE", "admin/repos/:id/watchers/:wid", "no", "delete a watcher of a repository"),
  r("POST", "admin/view-as", "no", "start a read-only view of one user's display for 30 minutes (GET calls with ?as=<id> are then answered as for that user); writes an audit line"),
  r("DELETE", "admin/view-as", "no", "end the view of a user's display"),
  r("GET", "admin/credentials", "no", "the stored credentials of all accounts, without any secret"),
  r("GET", "admin/components", "no", "the kind, id, version, owner, risk, lifecycle, approved version, last review, evaluation suite and status of each component, and the read problems as fixed text; no paths"),
  r("GET", "refinement", "yes", "your refinement sessions and the repositories a new one can use: your GitHub names, then your local projects (`local:<slug>-<id8>`) (an admin: the sessions of all accounts, with the owner)"),
  r("POST", "refinement", "yes", "start a refinement session on one of your GitHub repositories or local projects, from an idea; from an open issue only on a GitHub repository (read with the repository's sign-in; 409 when the Foundry is building or has built the issue, or you have an open session for it; 400 `bad-repo` for a local name with an issue; 403 `not-yours` for a local project that is not yours; 400 `bad-repo` for a malformed name); with `guide: true` (and nothing else) the session of the Get started guide on the guide's local project, made once from the saved answers (201, then 200 with the same session; 409 without a project of the guide or outside your workspaces)"),
  r("GET", "refinement/backlog", "yes", "the open issues of one of your GitHub repositories (`?repo=owner/name`) that the Foundry is not building and has not built, newest first, each with four checks done by code: acceptance criteria, value sentence, \"Depends on\" issues exist, no open questions; read with the repository's sign-in; GitHub's newest 100 issues and pull requests are read, and `cut` says when that page was full so older open issues may be missing; no architect run starts and nothing is written (an admin who is not the owner: 403)"),
  r("GET", "refinement/:id", "yes", "read your refinement session, with the architect's brief and state and the talk (an admin: any session)"),
  r("PUT", "refinement/:id", "yes", "rename your refinement session"),
  r("POST", "refinement/:id/drop", "yes", "drop your refinement session (an admin: any session); it is removed after 30 days, and its architect run is cancelled"),
  r("POST", "refinement/:id/restore", "yes", "restore your dropped refinement session"),
  r("POST", "refinement/:id/source/remove-build-label", "yes", "remove the build label from the issue your refinement session came from, with the repository's sign-in (an admin who is not the owner: 403)"),
  r("POST", "refinement/:id/architect", "yes", "ask the architect to read the repository for your refinement session, or resume a paused read (one read per account at a time)"),
  r("POST", "refinement/:id/round", "yes", "ask the architect for a round of questions in your refinement session, or resume a paused round (one architect run per account at a time); `words: \"simple\"` asks for plain words"),
  r("POST", "refinement/:id/understand", "yes", "ask the architect to write 1 to 5 story drafts from the idea, the brief and the answered questions of your refinement session, linked by Depends on, or resume a paused run (one architect run per account at a time); `words: \"simple\"` asks for plain words; drafts it wrote before that are not on GitHub are replaced"),
  r("POST", "refinement/:id/ask", "yes", "ask the architect a question of your own in your refinement session, or resume a paused answer (one architect run per account at a time)"),
  r("POST", "refinement/:id/questions/:qid/answer", "yes", "answer a question of the architect in your refinement session: an option, your own text, or \"I don't know yet\""),
  r("POST", "refinement/:id/proposals/:pid/accept", "yes", "accept a proposed entry of your refinement session: it goes into its rules, examples or open questions"),
  r("POST", "refinement/:id/proposals/:pid/reject", "yes", "reject a proposed entry of your refinement session; it is removed"),
  r("PUT", "refinement/:id/map/:eid", "yes", "change the text of a rule, example or open question of your refinement session"),
  r("DELETE", "refinement/:id/map/:eid", "yes", "remove a rule, example or open question from your refinement session"),
  r("POST", "refinement/:id/drafts", "yes", "add an empty story draft to your refinement session (at most 20)"),
  r("PUT", "refinement/:id/drafts/:did", "yes", "save what you typed in a story draft of your refinement session; only the fields in the body change"),
  r("DELETE", "refinement/:id/drafts/:did", "yes", "remove a story draft from your refinement session"),
  r("POST", "refinement/:id/drafts/:did/suggest", "yes", "ask the architect for a suggestion for one field of a story draft of your refinement session, or resume a paused one (one architect run per account at a time)"),
  r("POST", "refinement/:id/drafts/:did/review", "yes", "ask the architect to review a story draft of your refinement session, or resume a paused review (one architect run per account at a time); no field changes"),
  r("POST", "refinement/:id/publish", "yes", "publish the ready story drafts of your refinement session as GitHub issues, with the repository's sign-in; a draft that has an issue is not created again, a split original is skipped, and `leftBehind` names split originals that still hold criteria; in a session that came from an issue, the draft that stands for it replaces the title and text of that issue first (one comment holds the old text, labels are added and kept) and is answered as `updated`, and a closed issue or one the Foundry builds is refused (409) with nothing written; when the issue's title or text changed on GitHub since the session read it, nothing is written and the answer is 409 with `changedOnGithub` (both versions and `seen`): send `source: { keep: \"mine\" | \"github\", seen }` to choose; a split source issue is replaced once all its parts are on GitHub (the issues that depend on it get the parts under \"Depends on\" and a comment with the old and new text, every trigger label of an issues watcher of the repository is taken off it, and it gets a comment naming the parts; it is then closed as not planned; it stays open, to be closed by hand, when more than 1,000 open issues were read, a dependant must be changed or checked by hand, or it is a story of the monitor, and an original closed in another way is left so) and the answer has `replaced: { issue, parts, dependants: [{ issue, outcome }], closed: \"not_planned\" | \"other\" | \"open\", closedAt? }`; an original that the Foundry builds is refused (409) before the first write, and so is a closed one unless its replacement had started already (it is then left closed), and a failed publish is finished by publishing again (an admin who is not the owner: 403); on a local project the stories are made in `.scf/stories/` with no GitHub sign-in, `go` is the build label, and 403 `not-yours` when the project is not yours (also if it was moved while the publish waited for the lock)"),
  r("PUT", "refinement/:id/drafts/:did/review-label", "yes", "choose whether a story draft of your refinement session gets the review label when it is published; nothing is sent to GitHub"),
  r("POST", "refinement/:id/drafts/:did/split", "yes", "ask the architect for ways to split a story draft of your refinement session, with an optional way of your own, or resume a paused one (one architect run per account at a time); nothing is split and no field changes"),
  r("POST", "refinement/:id/drafts/:did/split/confirm", "yes", "confirm a split of a story draft of your refinement session: each part becomes a new draft and the original is kept as a record; no architect run starts"),
  r("POST", "refinement/:id/drafts/:did/criteria/:cid/move", "yes", "move an acceptance criterion between a split story draft of your refinement session and its parts, or between two parts"),
  r("POST", "refinement/:id/drafts/:did/merge", "yes", "merge another story draft of your refinement session into this one; the other draft is removed and no architect run starts"),
  r("POST", "refinement/:id/drafts/:did/impact","yes", "ask the architect what a story draft of your refinement session touches, how risky it is and how big it is, or resume a paused one (one architect run per account at a time); no field changes"),
  r("POST", "refinement/:id/drafts/:did/move-to-notes", "yes", "move a text of a story draft of your refinement session that has a plan or how remark to the notes for the builder, as a wish"),
  r("POST", "refinement/:id/drafts/:did/ready-check", "yes", "check a story draft of your refinement session against the Definition of Ready of its repository: by code, and the architect judges what code cannot decide, or resume a paused check (one architect run per account at a time); no field changes"),
  r("POST", "refinement/:id/drafts/:did/ready/:item/accept", "yes", "accept an item of the Definition of Ready anyway for a story draft of your refinement session, with a reason; not for the implementation plan item"),
  r("DELETE", "refinement/:id/drafts/:did/ready/:item/accept", "yes", "remove the \"accepted anyway\" mark of an item from a story draft of your refinement session"),
  r("POST", "refinement/:id/drafts/:did/suggestions/:sid/accept", "yes", "accept a suggestion of the architect for a story draft of your refinement session, as it is or with your own text; it goes into the draft"),
  r("POST", "refinement/:id/drafts/:did/suggestions/:sid/reject", "yes", "reject a suggestion for a story draft of your refinement session, with an optional reason; it is removed"),
  r("PUT", "refinement/:id/epic", "yes", "set or clear the Epic of your refinement session"),
  r("GET", "refinement/:id/publish", "yes", "read the publish plan of your refinement session: the issues that would be created, their order, labels and dependencies (a split original is not listed: its parts are, and a draft that depended on the original depends on each part; `leftBehind: [{ draft, title, criteria }]` names split originals that still hold criteria, and is left out when there are none); an item with `updates: N` replaces issue #N of the session's source and is in `willUpdate`, not in `willCreate`, and `notChanged: N` says no draft stands for that issue, `replaces: { issue, parts, ready, cut?, staysOpen?, dependants }` says the issue was split and a publish will replace it by its parts, with the open issues that depend on it (`before` and `after` of their Depends on text, or `byHand`); `staysOpen` says the issue gets the comment but is not closed, and `changedOnGithub` is set when the issue it would update changed on GitHub; it reads the labels, the issue and the open issues from GitHub with the repository's sign-in and creates nothing (an admin who is not the owner: 403); on a local project it reads the local stories in `.scf/stories/` with no GitHub sign-in, `go` is the build label, and 403 `not-yours` when the project is not yours"),
  r("GET", "help/conversations", "yes", "your Ask SCF conversations, last changed first, without their messages (`?archived=1`: the archived ones), whether Ask SCF is switched on and whether it is paused (then you can read but not ask), and the limits; only your own, for an admin too, and not in a view of a user's display"),
  r("GET", "help/conversations/:id", "yes", "read one of your Ask SCF conversations with its messages; a conversation of another account answers 404 like an unknown one, a deleted one 410"),
  r("POST", "help/conversations/:id/complete", "yes", "close one of your Ask SCF conversations: it stays readable and takes no new question"),
  r("POST", "help/conversations/:id/feedback", "yes", "rate an answer in one of your Ask SCF conversations: helpful or not helpful, with optional reasons from a fixed list and no free text; vote null (or none) takes it back; only counts are kept in the quality numbers; works while Ask SCF is paused"),
  r("POST", "help/conversations/:id/archive", "yes", "move one of your Ask SCF conversations to the archive"),
  r("POST", "help/conversations/:id/restore", "yes", "take one of your Ask SCF conversations out of the archive; it gets the state it had"),
  r("DELETE", "help/conversations/:id", "yes", "delete one of your Ask SCF conversations: its title and messages are removed at once and cannot be brought back"),
  r("POST", "help/conversations", "yes", "ask Ask SCF a question in a new conversation (`question`, and optionally `context`: the page and one selected thing); answers 202 with the conversation, whose reply is `pending` until the turn ends; one turn per account at a time (409), 429 when the queue is full or your turns of today are used, 503 while Ask SCF is switched off"),
  r("POST", "help/conversations/:id/messages", "yes", "ask the next question in one of your Ask SCF conversations; the same answers as for a new one"),
  r("POST", "help/conversations/:id/retry", "yes", "try the failed or stopped last answer of one of your Ask SCF conversations again; no message is added, and it counts as a turn of today"),
  r("POST", "help/conversations/:id/cancel", "yes", "stop the answer that is being written in one of your Ask SCF conversations"),
  r("POST", "help/conversations/:id/actions", "yes", "follow an offer of an Ask SCF reply (`message`, `offer`): the server checks again that you may open its page and answers `{type, to}`, or runs a read-only check (read it again, test the connection) and stores its result as a check message of the conversation, answering `{type, outcome, conversation}`; 404 when the thing is gone or you can no longer see it, 403 when you may not do it now, 409 when the conversation is not open, is waiting, is full, changed while the check ran, or already runs a check, 410 for a deleted conversation. Or see what an action Ask SCF proposed in one of your answers would do (`message`, `index`): the server describes it in its own words and gives a confirmation token that works once for 5 minutes; nothing changes. 503 while Ask SCF or its actions are switched off"),
  r("POST", "help/conversations/:id/actions/confirm", "yes", "carry out a previewed action with its token (`token`, `message`, `index`): the server checks the token, that the run did not change since the preview, the settings, your account and the rule of the same button on the run's page (your own runs only, an admin too), then reads the result back from the run and answers `{ outcome, stored }`; 409 for a token that is used, expired or does not fit, or a run that changed; writes an audit line"),
  r("POST", "help/conversations/:id/actions/cancel", "yes", "drop the confirmation token of a preview (`token`); nothing changes"),
  r("GET", "help/conversations/:id/handoffs", "yes", "the pages you may take one answer of your Ask SCF conversation to (`?message=`), with what each would copy; checked again for your account now; nothing is written"),
  r("POST", "help/conversations/:id/handoffs", "yes", "record that you took an answer of your Ask SCF conversation to another page (`message`, `offer`, and the `page` and `fill` you saw); only the conversation changes, never the target; 409 when the offer, its page or what it copies changed"),
  r("POST", "help/context", "yes", "what Ask SCF would take from a page context, before you send it with a question: the envelope as it would be kept (the page, the selected things, the filters, the marked text; what is too much is cut and named), its size and the limits, the page it is for your role, and the things on it that the server finds for your account; a thing that does not exist and one you may not see are only counted together; nothing is stored and no model is called; 400 for a context that holds anything else, 503 while Ask SCF is switched off"),
  r("GET", "help/export", "yes", "all your Ask SCF conversations with their messages, as one JSON document to keep (also the archived ones; not the deleted ones); only your own, for an admin too; writes an audit line without any text of a conversation"),
  r("GET", "help/usage", "no", "Ask SCF for administrators: whether it is on, the provider and model that answer (or why none can), the limits, the rollout stage (off, paused, administrators, pilot, everyone), what runs and waits now, turns, failures, cost and tokens per account and day, and the quality numbers (daily counts of answers, failures, limits, sources, votes and latency buckets, with no account); no question and no answer"),
];

/** The key of a rule, e.g. "POST runs/:id/approve". */
export const ruleKey = (rule: Rule) => `${rule.method} ${rule.path}`;

/** The rule for a call: the exact method and number of segments, and `:x` matches one segment. */
export function findRule(method: string, seg: string[]): Rule | undefined {
  return RULES.find((rule) => {
    if (rule.method !== method) return false;
    const parts = rule.path.split("/");
    return parts.length === seg.length && parts.every((p, i) => p.startsWith(":") || p === seg[i]);
  });
}

/**
 * Throws 403 when the user may not make the call, and 404 for a run that is not theirs. An admin always passes. Ownership is read from the run (or its
 * queue entry), never from the request. Then the rule's scope is checked (see workspace-scope.ts): an object of the user's that is outside their
 * workspaces answers 404, the same as an unknown one.
 */
export function authorize(ctx: ApiContext, user: User, rule: Rule, seg: string[]): void {
  if (user.role === "admin") return;
  if (rule.user === "no") throw new HttpError(403, "not allowed for your role");
  // The same answer as for a run that does not exist: a guessed id tells nothing.
  if (rule.user === "own" && ctx.scheduler.ownerOf(seg[1] ?? "") !== user.id) throw new HttpError(404, "run not found");
  checkScope(ctx, user, rule.scope, seg);
}

/**
 * A route a plugin registered: one file it serves at /plugins/<plugin>/<path>. Plugin routes are not in RULES, but they
 * follow the same law: no rule is 404, no session is 401, a role not listed is 403, and an admin passes every rule.
 */
export interface PluginRule {
  plugin: string;
  method: "GET";
  /** The path of the file inside the plugin's folder, e.g. "report.js". */
  path: string;
  roles: ("admin" | "user")[];
  note: string;
}

/** The rule of a plugin call: the exact plugin, the GET method and the file path. */
export function findPluginRule(entries: readonly { name: string; rules: readonly PluginRule[] }[], method: string, plugin: string, path: string): PluginRule | undefined {
  if (method !== "GET") return undefined;
  return entries.find((e) => e.name === plugin)?.rules.find((x) => x.method === "GET" && x.path === path);
}

/** Throws 403 when the user's role is not in the rule. An admin always passes. */
export function authorizePlugin(user: User, rule: PluginRule): void {
  if (user.role === "admin" || rule.roles.includes(user.role as "user")) return;
  throw new HttpError(403, "not allowed for your role");
}

/** The flows a user may see and start: valid, published ones whose name a run can use. The list and the start check both use this. */
export function publishedFlows(repo: string): FlowListing[] {
  return listFlows(repo).filter((f) => !f.error && NAME_RE.test(f.name) && f.published === true && !isRefinementFlow(f.name));
}

/** True for the release-build flow, or any flow with a shell step that runs the release-build tool. */
export function isReleaseBuildFlow(flow: Flow): boolean {
  return flow.name === "release-build" || flow.steps.some((s) => s.type === "shell" && s.run.includes("$FACTORY_TOOLS/release-build"));
}

/** Only an admin may choose the method "none" (the server's own access) or "local" (a folder on this machine). Throws 403. */
export function checkRepoMethod(user: Pick<User, "role">, method: unknown): void {
  if (user.role === "admin") return;
  if (method === "none") throw new HttpError(403, 'only an admin may choose "none" (the server\'s own access)');
  if (method === "local") throw new HttpError(403, 'only an admin may choose "local" (a folder on this machine)');
}

/**
 * A user (or an admin who starts like one) may build only the default branch of the repository. Finds the ref the run would build
 * (the given value, the fixed value, or the default branch) and refuses it with 403 unless it is exactly the default branch.
 * Returns the run's variables with `ref` set to that ref.
 */
export function checkReleaseRef(flow: Flow, given: Record<string, string>, runVars: Record<string, string>, defaultBranch: string): Record<string, string> {
  const spec = flow.publish?.vars.ref;
  const repo = runVars.github_repo ?? "the repository";
  let ref = defaultBranch;
  if (spec?.mode === "input") {
    if (given.ref !== undefined && given.ref !== "") ref = given.ref;
  } else if (spec?.mode === "fixed") {
    ref = runVars.ref ?? "";
    if (ref !== defaultBranch) {
      throw new HttpError(403, `this published flow builds "${ref}", not the default branch "${defaultBranch}" of ${repo}; only an admin can start it`);
    }
  }
  if (ref !== defaultBranch) {
    throw new HttpError(403, `you can build only the default branch of ${repo} ("${defaultBranch}"), not "${ref}"; only an admin can build another ref`);
  }
  return { ...runVars, ref };
}

/** The table for the guide, in Markdown. */
export function permissionTable(): string {
  const cell = (a: UserAccess) => (a === "yes" ? "yes" : a === "own" ? "own runs" : "no");
  return [
    "| Call | Admin | User | What it does |",
    "|---|---|---|---|",
    ...RULES.map((rule) => `| \`${rule.method} /api/${rule.path}\` | yes | ${cell(rule.user)} | ${rule.note} |`),
  ].join("\n");
}
