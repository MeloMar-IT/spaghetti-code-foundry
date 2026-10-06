import { listFlows, type FlowListing } from "../flow/load.js";
import type { User } from "../auth/users.js";
import { isRefinementFlow } from "../flow/usage.js";
import { HttpError, NAME_RE } from "./http.js";
import type { ApiContext } from "./server.js";

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
}

const r = (method: string, path: string, user: UserAccess, note: string): Rule => ({ method, path, user, note });

export const RULES: Rule[] = [
  r("GET", "info", "no", "server settings and today's cost"),
  r("GET", "config", "no", "read the settings"),
  r("PUT", "config", "no", "change the settings"),
  r("GET", "watchers", "no", "list the watchers"),
  r("POST", "watchers/:id/tick", "no", "run a watcher now"),
  r("GET", "monitor", "no", "whether the monitor makes bug stories (on, off, quiet after a restart, or stopped by the circuit breaker), when it last checked, how many stories it made today, its findings with their states, its detectors and its mutes"),
  r("GET", "monitor/findings/:id", "no", "the evidence, bug stories and runs of one finding of the monitor"),
  r("POST", "monitor/story", "no", "make the bug story of one finding of the monitor now (the waiting rules do not apply; the off switch, mutes and the two tries do)"),
  r("POST", "monitor/off", "no", "stop the monitor from making bug stories"),
  r("POST", "monitor/on", "no", "let the monitor make bug stories again"),
  r("POST", "monitor/mutes", "no", "mute one detector or one finding of the monitor, with a reason, for a time or for good"),
  r("DELETE", "monitor/mutes/:id", "no", "end a mute"),
  r("POST", "monitor/retry", "no", "let the monitor try again for a finding that waits for a person (two bug stories did not fix it)"),
  r("POST", "clean", "no", "clean up old runs"),
  r("GET", "providers", "no", "agent providers"),
  r("POST", "providers/test", "no", "test a provider"),
  r("GET", "evals", "no", "eval reports"),
  r("GET", "stats", "no", "statistics"),
  r("GET", "flows", "yes", "list flows (a user sees the published flows only; an admin gets that list with `?published=1`)"),
  r("GET", "flows/:name", "no", "read a flow"),
  r("PUT", "flows/:name", "no", "save a flow"),
  r("DELETE", "flows/:name", "no", "delete a flow"),
  r("GET", "blocks", "no", "list blocks"),
  r("PUT", "blocks/:id", "no", "save a block"),
  r("DELETE", "blocks/:id", "no", "delete a block"),
  r("POST", "validate", "no", "check a flow"),
  r("POST", "generate", "no", "write a flow with AI"),
  r("GET", "queue", "yes", "the queue (a user sees their own queued runs and how many are ahead)"),
  r("GET", "runs", "yes", "list runs (a user sees their own)"),
  r("GET", "run-owners", "no", "the accounts that have runs, for the owner filter"),
  r("POST", "runs", "yes", "start a run (a user: a published flow and own repositories; an admin with `likeUser: true` follows the same rules)"),
  r("GET", "runs/:id", "own", "read a run (a user: without costs and setup)"),
  r("POST", "runs/:id/cancel", "own", "cancel a run"),
  r("POST", "runs/:id/resume", "own", "resume a run (an architect run: ask again from its refinement session); 409 when its issue is closed on GitHub (see \"A run of a closed issue\" in chapter 3)"),
  r("POST", "runs/:id/answer", "own", "answer the questions a run stopped with; the run continues with the answer"),
  r("POST", "runs/:id/approve", "own", "approve a run, with a note; 409 for a closed issue, as for resume"),
  r("POST", "runs/:id/reject", "own", "reject a run, with a note; 409 for a closed issue, as for resume"),
  r("GET", "runs/:id/events", "own", "follow a run live (a user: without costs and setup)"),
  r("GET", "runs/:id/diff", "own", "the changes of a run"),
  r("GET", "runs/:id/transcript/:n", "no", "the transcript of a step"),
  r("GET", "next", "no", "what happens next, for all runs"),
  r("GET", "health", "no", "server health"),
  r("GET", "board", "no", "the board of all work"),
  r("GET", "since", "no", "what changed since a time"),
  r("GET", "your-turn", "no", "what waits for you"),
  r("POST", "your-turn/dismiss", "no", "dismiss an item"),
  r("POST", "your-turn/restore", "no", "restore dismissed items"),
  r("GET", "your-turn/detail", "no", "the questions, plan or split of an item"),
  r("POST", "your-turn/act", "no", "answer, approve, reject or retry an item, as a comment on the issue; retry of a closed issue is 409, as for resume"),
  r("GET", "clarity", "no", "how long items waited for you, and what Your turn missed"),
  r("POST", "password", "yes", "change your own password (the other sessions of the account end)"),
  r("GET", "credentials", "yes", "your stored credentials"),
  r("POST", "credentials", "yes", "store a credential"),
  r("DELETE", "credentials/:id", "yes", "remove a credential"),
  r("GET", "users", "no", "list the accounts"),
  r("POST", "users", "no", "add an account without a password; the answer has its one-time set-password token"),
  r("PUT", "users/:id", "no", "change the name, e-mail or role of an account"),
  r("POST", "users/:id/block", "no", "block an account, end its sessions and cancel its queued jobs"),
  r("POST", "users/:id/unblock", "no", "unblock an account"),
  r("POST", "users/:id/link", "no", "a new set-password token for an account without a password"),
  r("POST", "users/:id/reset", "no", "take the password of an account away, end its sessions and give a one-time set-password token"),
  r("POST", "users/:id/unlock", "no", "remove the lock after too many wrong tries (a short wait for the address can remain)"),
  r("DELETE", "users/:id", "no", "delete an account with its sessions, repositories, refinement sessions and stored credentials"),
  r("GET", "audit", "no", "read the audit log, newest first, with filters"),
  r("GET", "audit/export", "no", "download the audit log as CSV, with the same filters"),
  r("GET", "repos", "yes", "your repositories"),
  r("GET", "repos/methods", "yes", "the sign-in methods you may choose, and the link to install the GitHub App"),
  r("POST", "repos", "yes", "add a repository (a URL, and a token or a deploy key for it)"),
  r("PUT", "repos/:id/auth", "yes", "change the method, user name, token or address of your repository, or make a new deploy key"),
  r("POST", "repos/:id/test", "yes", "test the connection of your repository (an admin: any repository); the result is saved as its connection status"),
  r("GET", "repos/:id/ready", "yes", "the Definition of Ready of your repository (an admin: any repository)"),
  r("DELETE", "repos/:id", "yes", "remove your repository and its stored token or key"),
  r("DELETE", "repos/:owner/:name", "yes", "remove a GitHub repository by name (old form)"),
  r("GET", "admin/repos", "no", "the repositories of all accounts, with their settings"),
  r("PUT", "admin/repos/:id/settings", "no", "set the test command, docs, protected branches and branch names of a repository"),
  r("PUT", "admin/repos/:id/ready", "no", "set the Definition of Ready of a repository, or put the default list back"),
  r("POST", "admin/repos/:id/transfer", "no", "move a repository to another account, by e-mail"),
  r("GET", "admin/repos/:id/watchers", "no", "the watchers of a repository, with status and holds"),
  r("POST", "admin/repos/:id/watchers", "no", "add a watcher to a repository (GitHub, with a sign-in that can call the GitHub API)"),
  r("PUT", "admin/repos/:id/watchers/:wid", "no", "change a watcher of a repository, or enable or disable it"),
  r("DELETE", "admin/repos/:id/watchers/:wid", "no", "delete a watcher of a repository"),
  r("POST", "admin/view-as", "no", "start a read-only view of one user's display for 30 minutes (GET calls with ?as=<id> are then answered as for that user); writes an audit line"),
  r("DELETE", "admin/view-as", "no", "end the view of a user's display"),
  r("GET", "admin/credentials", "no", "the stored credentials of all accounts, without any secret"),
  r("GET", "refinement", "yes", "your refinement sessions and the repositories a new one can use (an admin: the sessions of all accounts, with the owner)"),
  r("POST", "refinement", "yes", "start a refinement session on one of your GitHub repositories"),
  r("GET", "refinement/:id", "yes", "read your refinement session, with the architect's brief and state and the talk (an admin: any session)"),
  r("PUT", "refinement/:id", "yes", "rename your refinement session"),
  r("POST", "refinement/:id/drop", "yes", "drop your refinement session (an admin: any session); it is removed after 30 days, and its architect run is cancelled"),
  r("POST", "refinement/:id/restore", "yes", "restore your dropped refinement session"),
  r("POST", "refinement/:id/architect", "yes", "ask the architect to read the repository for your refinement session, or resume a paused read (one read per account at a time)"),
  r("POST", "refinement/:id/round", "yes", "ask the architect for a round of questions in your refinement session, or resume a paused round (one architect run per account at a time)"),
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
  r("POST", "refinement/:id/drafts/:did/impact", "yes", "ask the architect what a story draft of your refinement session touches, how risky it is and how big it is, or resume a paused one (one architect run per account at a time); no field changes"),
  r("POST", "refinement/:id/drafts/:did/move-to-notes", "yes", "move a text of a story draft of your refinement session that has a plan or how remark to the notes for the builder, as a wish"),
  r("POST", "refinement/:id/drafts/:did/suggestions/:sid/accept", "yes", "accept a suggestion of the architect for a story draft of your refinement session, as it is or with your own text; it goes into the draft"),
  r("POST", "refinement/:id/drafts/:did/suggestions/:sid/reject", "yes", "reject a suggestion for a story draft of your refinement session, with an optional reason; it is removed"),
  r("PUT", "refinement/:id/epic", "yes", "set or clear the Epic of your refinement session"),
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
 * queue entry), never from the request.
 */
export function authorize(ctx: ApiContext, user: User, rule: Rule, seg: string[]): void {
  if (user.role === "admin" || rule.user === "yes") return;
  if (rule.user === "no") throw new HttpError(403, "not allowed for your role");
  // The same answer as for a run that does not exist: a guessed id tells nothing.
  if (ctx.scheduler.ownerOf(seg[1] ?? "") !== user.id) throw new HttpError(404, "run not found");
}

/** The flows a user may see and start: valid, published ones whose name a run can use. The list and the start check both use this. */
export function publishedFlows(repo: string): FlowListing[] {
  return listFlows(repo).filter((f) => !f.error && NAME_RE.test(f.name) && f.published === true && !isRefinementFlow(f.name));
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
