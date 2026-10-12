import { cols, fields, pick, table, type Column } from "../render.js";
import type { Cmd, Flag } from "../spec.js";

type Obj = Record<string, unknown>;
const obj = (d: unknown): Obj => (d && typeof d === "object" && !Array.isArray(d) ? (d as Obj) : {});
const list = (d: unknown): unknown[] => (Array.isArray(d) ? d : []);

const USER_KEYS = ["id", "name", "email", "role", "status", "hasPassword", "lockedUntil", "lastSignIn", "created", "runs"];
const user = (d: unknown) => fields(obj(d).user, USER_KEYS);

/**
 * An answer with a set-password token. The token is printed because handing it over is what the call is for;
 * the server keeps only a hash, so it cannot be shown a second time.
 */
const withToken = (d: unknown) =>
  [
    user(d),
    "",
    `set-password token (shown once): ${String(obj(d).token ?? "")}`,
    `valid until: ${String(obj(d).expires ?? "")}`,
    "The account sets its password at <server address>/#/set-password/<token>.",
  ].join("\n");

const LIMIT_KEYS = ["maxConcurrent", "maxRunsPerDay", "dailyBudgetUsd"];
/** The defaults as lines, then one row per account that has limits of its own. */
function limits(d: unknown): string {
  const users = Object.entries(obj(obj(d).users)).map(([account, own]) => ({ account, ...obj(own) }));
  return [
    "defaults:",
    (fields(obj(d).defaults, LIMIT_KEYS) || "none").replace(/^/gm, "  "),
    "",
    table(users, cols("account", ...LIMIT_KEYS), "no account has limits of its own"),
  ].join("\n");
}

// "null" must be possible (it clears a limit), so the value is read as JSON: a number or null.
const limit = (key: string, what: string): Flag => ({ type: "string", as: "json", key, help: `${what}; null clears it` });
const LIMIT_FLAGS: Record<string, Flag> = {
  "max-concurrent": limit("maxConcurrent", "runs at the same time (a whole number)"),
  "max-runs-per-day": limit("maxRunsPerDay", "runs per day (a whole number)"),
  "daily-budget": limit("dailyBudgetUsd", "the budget per day in USD"),
};

const appRepos = (d: unknown) => {
  const repos = list(obj(d).repos);
  return repos.length ? repos.join("\n") : "no repositories allowed";
};

/** Who or what an audit line is about: an account by name, anything else as its text. */
const party = (v: unknown): string => {
  const p = obj(v);
  return String(p.name ?? p.text ?? p.type ?? "");
};
function audit(d: unknown): string {
  const rows = list(obj(d).entries).map((e) => ({ ...obj(e), actor: party(obj(e).actor), target: party(obj(e).target) }));
  const more = obj(d).more ? "\nThere are older lines: narrow the search with --to, or use scf audit export." : "";
  return table(rows, [...cols("time", "actor", "action", "target", "result"), { key: "detail", max: 70 }], "no audit lines") + more;
}
const AUDIT_FLAGS: Record<string, Flag> = {
  user: { type: "string", help: "only lines by or about this account (its id)" },
  action: { type: "string", help: "only this action, e.g. sign-in" },
  from: { type: "string", help: "not before this time, e.g. 2026-10-02T09:00:00Z" },
  to: { type: "string", help: "not after this time" },
};

const SECRET_COLS: Column[] = [...cols("id", "type", "name", "fingerprint", "created"), { key: "lastUsed", head: "last used" }];

const REPO_COLS: Column[] = [...cols("id"), { key: "url", max: 50 }, ...cols("method"), { key: "account.email", head: "owner" }, { key: "account.status", head: "owner status" }];
const repo = (d: unknown) => fields(d, ["id", "url", "github", "method", "account.email", "settings", "ready", "watcherProblem"]);

const WATCHER_COLS: Column[] = [...cols("id", "source", "flow", "every", "enabled"), { key: "state.name", head: "state" }];
const watcher = (d: unknown) => fields(d, ["id", "repoId", "github_repo", "owner", "source", "flow", "label", "every", "enabled", "task", "at", "timezone"]);
const WATCHER_FLAGS: Record<string, Flag> = {
  source: { type: "string", help: "issues (default), pr-feedback, ci-failures or schedule" },
  flow: { type: "string", help: "the flow to run (default: the flow for the source)" },
  label: { type: "string", help: "issues: the label that starts a run" },
  every: { type: "string", help: "how often to check, e.g. 5m" },
  task: { type: "string", help: "schedule: what the run should do" },
  at: { type: "string", help: 'schedule: once a day at this time, e.g. "17:00"' },
  "max-per-tick": { type: "string", as: "number", key: "max_per_tick", help: "how many runs one check may start" },
};

/** Accounts and administration: accounts, your own password and stored secrets, the audit log, and what only an admin may do. */
export const PEOPLE: Cmd[] = [
  // ---- accounts (admin) ----
  { area: "users", action: "list", method: "GET", path: "users",
    show: (d) => table(list(d), [...cols("id", "name", "email", "role", "status"), { key: "hasPassword", head: "password" }, { key: "lastSignIn", head: "last sign-in" }, ...cols("runs")], "no accounts") },
  { area: "users", action: "add", method: "POST", path: "users", args: ["name", "email"], fixed: { role: "user" },
    flags: { role: { type: "string", help: "admin or user (default user)" } },
    help: "add an account without a password; prints its set-password token, which is shown once", show: withToken },
  { area: "users", action: "set", method: "PUT", path: "users/:id", args: ["id"], help: "change the name or e-mail of an account",
    flags: { name: { type: "string", help: "the new name" }, email: { type: "string", help: "the new e-mail address" } }, show: user },
  { area: "users", action: "role", method: "PUT", path: "users/:id", args: ["id", "role"], help: "make an account an admin or a user",
    confirm: "This changes what the account may do: an admin can read and change everything.", show: user },
  { area: "users", action: "block", method: "POST", path: "users/:id/block", args: ["id"],
    flags: { "stop-work": { type: "boolean", help: "also stop the runs of the account that are running now" } },
    confirm: "This ends the sessions of the account and cancels its queued jobs.",
    show: (d) => `${user(d)}\ncancelled: ${JSON.stringify(obj(d).cancelled ?? null)}` },
  { area: "users", action: "unblock", method: "POST", path: "users/:id/unblock", args: ["id"], show: user },
  { area: "users", action: "unlock", method: "POST", path: "users/:id/unlock", args: ["id"], show: user },
  { area: "users", action: "link", method: "POST", path: "users/:id/link", args: ["id"],
    help: "a new set-password token for an account without a password; it is shown once and replaces the old one", show: withToken },
  { area: "users", action: "reset", method: "POST", path: "users/:id/reset", args: ["id"],
    help: "take the password of an account away and print a set-password token, which is shown once",
    confirm: "This takes the password of the account away and ends its sessions.", show: withToken },
  { area: "users", action: "remove", method: "DELETE", path: "users/:id", args: ["id"],
    confirm: "This deletes the account with its sessions, repositories, refinement sessions and stored secrets." },
  { area: "users", action: "limits", method: "GET", path: "users/limits", help: "the default limits and the limits of single accounts", show: limits },
  { area: "users", action: "set-default-limits", method: "PUT", path: "users/limits", flags: LIMIT_FLAGS, help: "set or clear the default limits for all accounts", show: limits },
  { area: "users", action: "set-limits", method: "PUT", path: "users/:id/limits", args: ["id"], flags: LIMIT_FLAGS, show: limits },
  { area: "users", action: "app-repos", method: "GET", path: "users/:id/app-repos", args: ["id"], show: appRepos },
  { area: "users", action: "set-app-repos", method: "PUT", path: "users/:id/app-repos", args: ["id"],
    flags: { repos: { type: "string", as: "list", required: true, help: 'all allowed repositories, with commas: owner/name or owner/*; "" allows none' } },
    help: "set the repositories an account may connect through the GitHub App (replaces the list)", show: appRepos },

  // ---- your own account ----
  { area: "account", action: "password", method: "POST", path: "password",
    prompts: [{ field: "current", label: "Current password", hidden: true }, { field: "password", label: "New password", hidden: true, twice: true }],
    show: () => "the password was changed; the other sessions of the account have ended" },

  // ---- your stored secrets ("credential" is a file command) ----
  { area: "secrets", action: "list", method: "GET", path: "credentials", help: "your stored secrets (never their values)", show: (d) => table(list(d), SECRET_COLS, "no stored secrets") },
  { area: "secrets", action: "add", method: "POST", path: "credentials", args: ["name"], fixed: { type: "token" },
    flags: { type: { type: "string", help: "token (default) or ssh-key; a key has many lines: give it with --data @file.json" } },
    prompts: [{ field: "secret", label: "Secret", hidden: true }],
    help: "store a secret; its value is asked for and never shown again", show: (d) => fields(d, ["id", "type", "name", "fingerprint", "created"]) },
  { area: "secrets", action: "remove", method: "DELETE", path: "credentials/:id", args: ["id"], help: "remove a stored secret",
    confirm: "This removes the stored secret; what uses it stops working.", show: () => "removed" },

  // ---- audit log (admin) ----
  { area: "audit", action: "list", method: "GET", path: "audit", flags: AUDIT_FLAGS, help: "read the audit log, newest first (at most 500 lines)", show: audit },
  { area: "audit", action: "export", method: "GET", path: "audit/export", flags: AUDIT_FLAGS, help: "print the audit log as CSV, with the same filters",
    show: (d) => (typeof d === "string" ? d.trimEnd() : JSON.stringify(d)) },

  // ---- admin: the repositories and secrets of all accounts, and the view of a user's display ----
  { area: "admin", action: "repos", method: "GET", path: "admin/repos", show: (d) => table(list(d), REPO_COLS, "no repositories") },
  { area: "admin", action: "repo-settings", method: "PUT", path: "admin/repos/:id/settings", args: ["id"],
    flags: {
      "test-command": { type: "string", help: "the command that runs the tests" },
      docs: { type: "string", as: "list", help: "paths of the documents, with commas" },
      "protected-branches": { type: "string", as: "list", help: "branch patterns nothing may push to, with commas" },
      "main-branch": { type: "string", help: "the name of the main branch" },
      "develop-branch": { type: "string", help: "the name of the develop branch" },
    },
    help: "set all settings of a repository at once; a setting you leave out is cleared",
    confirm: "This replaces all settings of the repository: a setting you do not name is cleared.", show: repo },
  { area: "admin", action: "repo-ready", method: "PUT", path: "admin/repos/:id/ready", args: ["id"],
    flags: { items: { type: "string", as: "json", required: true, help: `the whole list as JSON, e.g. '[{"text":"Has a test plan"}]'; null puts the default list back` } },
    confirm: "This replaces the Definition of Ready of the repository.", show: repo },
  { area: "admin", action: "repo-transfer", method: "POST", path: "admin/repos/:id/transfer", args: ["id", "email"],
    confirm: "This moves the repository to the other account; a personal token stored for it is removed.", show: repo },
  { area: "admin", action: "watchers", method: "GET", path: "admin/repos/:id/watchers", args: ["id"], show: (d) => table(list(d), WATCHER_COLS, "no watchers") },
  // <id> is the repository; the watcher's own id is a body field with the same name, so it is a flag
  { area: "admin", action: "watcher-add", method: "POST", path: "admin/repos/:id/watchers", args: ["id"],
    flags: { id: { type: "string", required: true, help: "the id of the new watcher (<id> is the repository)" }, ...WATCHER_FLAGS },
    help: "add a watcher to a repository (<id>) on GitHub; it starts switched on", show: watcher },
  { area: "admin", action: "watcher-set", method: "PUT", path: "admin/repos/:id/watchers/:wid", args: ["id", "wid"], flags: WATCHER_FLAGS,
    help: "change options of a watcher of a repository", show: watcher },
  { area: "admin", action: "watcher-enable", method: "PUT", path: "admin/repos/:id/watchers/:wid", args: ["id", "wid"], fixed: { enabled: true }, help: "switch a watcher of a repository on", show: watcher },
  { area: "admin", action: "watcher-disable", method: "PUT", path: "admin/repos/:id/watchers/:wid", args: ["id", "wid"], fixed: { enabled: false }, help: "switch a watcher of a repository off", show: watcher },
  { area: "admin", action: "watcher-remove", method: "DELETE", path: "admin/repos/:id/watchers/:wid", args: ["id", "wid"],
    confirm: "This deletes the watcher; it starts no more runs.", show: () => "removed" },
  { area: "admin", action: "secrets", method: "GET", path: "admin/credentials", help: "the stored secrets of all accounts (never their values)",
    show: (d) => table(list(d), [{ key: "ownerName", head: "owner" }, ...SECRET_COLS], "no stored secrets") },
  { area: "admin", action: "view-as", method: "POST", path: "admin/view-as", args: ["userId"],
    help: "start a read-only view of a user's display for 30 minutes: then scf api GET '<path>?as=<userId>'",
    show: (d) => `viewing as ${String(pick(d, "name") ?? "")} (${String(pick(d, "id") ?? "")}) for 30 minutes; read with: scf api GET '<path>?as=${String(pick(d, "id") ?? "")}'` },
  { area: "admin", action: "view-end", method: "DELETE", path: "admin/view-as", show: () => "the view has ended" },
];
