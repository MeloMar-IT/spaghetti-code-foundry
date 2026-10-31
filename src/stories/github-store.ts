import type { CheckRun } from "../delivery/handoff.js";
import * as github from "../github.js";
import { gh, ghInherit, ghJson } from "../github.js";
import type { Comment, Issue, RestIssue, UpsertOptions, UpsertResult } from "../github.js";
import type { ChangeActivity, ChangeId, ChangeRef, ChangeState, GhCall, GhRunner, MergedChange, OpenChange, ReviewComment, StoryState, StoryStore, SyncStories, SyncStory } from "./store.js";

const whole = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= max;

/** A number that ends up in an argument or an API path: only a positive whole number may. */
function number(n: unknown, what: string): number {
  if (!whole(n)) throw new Error(`not ${what}`);
  return n;
}

/** A pull request as gh takes it: its number or its https address. Anything else could become a gh option. */
function changeRef(pr: ChangeId): string {
  if (typeof pr === "number" && whole(pr)) return String(pr);
  if (typeof pr === "string" && (/^[0-9]{1,15}$/.test(pr) || /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[0-9]+$/.test(pr))) return pr;
  throw new Error("not a pull request");
}

// The jq programs of the old pull_ticket step, byte for byte: what tools/story saves must not change.
const FOUNDRY_IDS = String.raw`[.comments[] | select(.viewerDidAuthor == true and ((.body // "") | contains("<!-- claude-factory") or contains("<!-- spaghetti-code-foundry"))) | (.url // "") | select(test("#issuecomment-[0-9]+$")) | capture("#issuecomment-(?<id>[0-9]+)$").id | tonumber]`;
const TICKET_TEXT = String.raw`
  "# #\(.number): \(.title)\n\(.url)\nLabels: \([.labels[].name] | join(", "))\n\n\(.body // "" | gsub("(?m)^--- comment by"; "> --- comment by"))\n"
  + ([.comments[] | "\n--- comment by \(.author.login)\(if .viewerDidAuthor == true and ((.body // "") | contains("<!-- claude-factory") or contains("<!-- spaghetti-code-foundry")) then " (Foundry)" else "" end):\n\(.body // "" | gsub("(?m)^--- comment by"; "> --- comment by"))"] | join("\n"))`;

// The programs of the flow steps that moved here, as the shell lines had them (without the doubled backslashes of build-flows.mjs).
const PLAIN_TEXT = String.raw`
    "# #\(.number): \(.title)\nLabels: \([.labels[].name] | join(", "))\n\n\(.body)\n"
    + ([.comments[] | "\n--- comment by \(.author.login):\n\(.body)"] | join("\n"))`;
const AUTHORS_QUERY = String.raw`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){author{login} lastEditedBy{login}}}}`;
const AUTHORS_JQ = String.raw`.data.repository.issue | [(.author.login // ""), (.lastEditedBy.login // "")] | join(" ")`;
const CHANGE_TEXT = String.raw`"# PR #\(.number // "") \(.title)\n\(.body)\n"`;
const REVIEW_COMMENTS = String.raw`.[] | select(.body | (contains("claude-factory") or contains("spaghetti-code-foundry")) | not) | "--- \(.user.login) on \(.path):\(.line // .original_line):\n\(.body)\n"`;
const REVIEWS = String.raw`
  (.reviews[] | select(.body != "") | "--- review by \(.author.login) (\(.state)):\n\(.body)\n"),
  (.comments[] | select(.body | (contains("claude-factory") or contains("spaghetti-code-foundry")) | not) | "--- \(.author.login):\n\(.body)\n")`;

/** A branch as gh takes it: it must not become an option. Empty passes (a detached HEAD sends one today). */
function branchRef(branch: string): string {
  if (typeof branch !== "string" || branch.startsWith("-") || /\s/.test(branch)) throw new Error("not a branch");
  return branch;
}

/** A comma list of JSON field names for `--json`: it cannot become an option. */
function fieldList(s: unknown): string {
  if (typeof s !== "string" || !/^[A-Za-z]+(?:,[A-Za-z]+)*$/.test(s)) throw new Error("not a field list");
  return s;
}

const listSize =(n: unknown, max = 1000): number => {
  if (!whole(n, max)) throw new Error("not a list size");
  return n;
};

/** The gh arguments of the after-merge sweep: issues in any state with an /overrule in a comment, updated since `since` (YYYY-MM-DD). */
export function overruleSearchArgs(repo: string, since: string, limit: number): string[] {
  return ["issue", "list", "--repo", repo, "--state", "all", "--search", `overrule in:comments updated:>=${since}`,
    "--limit", String(limit), "--json", "number,updatedAt"];
}

/** A story from a gh answer; undefined when it is not one. */
function toStory(x: unknown): SyncStory | undefined {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Number.isInteger(o.number) || (o.number as number) <= 0 || typeof o.title !== "string") return undefined;
  return { number: o.number as number, title: o.title, state: typeof o.state === "string" ? o.state.toUpperCase() : "OPEN", body: typeof o.body === "string" ? o.body : "" };
}

function isNotFound(e: unknown): boolean {
  const o = e as { stderr?: unknown; message?: unknown } | undefined;
  return /Could not resolve to an Issue|Not Found|HTTP 404/i.test(`${typeof o?.stderr === "string" ? o.stderr : ""}\n${typeof o?.message === "string" ? o.message : ""}`);
}

/**
 * The stories of one GitHub repository. It wraps the functions of src/github.ts (same arguments, same timeouts) and calls gh
 * itself where there is no such function. It holds no gh session: gh reads the session of the caller (`withGhEnv`) at each call.
 */
export class GitHubStore implements StoryStore {
  constructor(readonly repo: string) {}

  listByLabel(label: string, timeoutMs?: number): Promise<RestIssue[]> {
    return github.listIssuesByLabel(this.repo, label, timeoutMs);
  }
  async listOpenWithLabel(label: string, o: { limit: number; timeoutMs?: number }): Promise<Issue[]> {
    if (!whole(o.limit, 1000)) throw new Error("not a list size");
    return ghJson<Issue[]>(
      ["issue", "list", "--repo", this.repo, "--label", label, "--state", "open", "--limit", String(o.limit), "--json", "number,title,labels,body,createdAt,updatedAt"],
      undefined,
      o.timeoutMs,
    );
  }
  async listOpenWithAnyLabel(label: string, anyOf: string[], o: { limit: number; timeoutMs?: number }): Promise<Issue[]> {
    const limit = listSize(o.limit);
    const any = anyOf.map((l) => `"${l.replace(/"/g, "")}"`).join(",");
    return ghJson<Issue[]>(
      ["issue", "list", "--repo", this.repo, "--label", label, "--state", "open", "--limit", String(limit),
        "--search", `label:${any} sort:created-asc`, "--json", "number,title,labels,body,createdAt,updatedAt"],
      undefined,
      o.timeoutMs,
    );
  }
  async listClosedWithAnyLabel(anyOf: string[], o: { limit: number; timeoutMs?: number }): Promise<Issue[]> {
    const limit = listSize(o.limit);
    const any = anyOf.map((l) => `"${l}"`).join(",");
    return ghJson<Issue[]>(
      ["issue", "list", "--repo", this.repo, "--state", "closed", "--limit", String(limit),
        "--search", `label:${any} sort:updated-desc`, "--json", "number,title,labels,state"],
      undefined,
      o.timeoutMs,
    );
  }
  async listWithBodies(limit: number, timeoutMs?: number): Promise<Issue[]> {
    return ghJson<Issue[]>(
      ["issue", "list", "--repo", this.repo, "--state", "all", "--limit", String(listSize(limit)), "--json", "number,title,labels,state,body"],
      undefined,
      timeoutMs,
    );
  }
  async isClosed(issue: number, timeoutMs?: number): Promise<boolean> {
    number(issue, "an issue number");
    const out = await gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "state", "--jq", ".state"], undefined, timeoutMs);
    return out.trim().toUpperCase() === "CLOSED";
  }
  async stateAndLabels(issue: number, timeoutMs?: number): Promise<{ state: string; labels: { name: string }[] }> {
    number(issue, "an issue number");
    return ghJson<{ state: string; labels: { name: string }[] }>(["issue", "view", String(issue), "--repo", this.repo, "--json", "state,labels"], undefined, timeoutMs);
  }
  async searchOverrules(o: { since: string; limit: number; timeoutMs?: number }): Promise<{ number: number; updatedAt?: string }[]> {
    const limit = listSize(o.limit);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.since)) throw new Error("not a date");
    const got = await ghJson<unknown>(overruleSearchArgs(this.repo, o.since, limit), undefined, o.timeoutMs);
    return Array.isArray(got) ? (got as { number: number; updatedAt?: string }[]) : [];
  }
  listOpenByLabelPages(label: string, o: { fromPage: number; pages: number; timeoutMs?: number }) {
    return github.listOpenIssuesByLabelPages(this.repo, label, o);
  }
  listOpen(o: { pages: number; timeoutMs?: number }) {
    return github.listOpenIssues(this.repo, o);
  }
  listAll(o: { pages: number; timeoutMs?: number }) {
    return github.listAllIssues(this.repo, o);
  }
  listNewest(timeoutMs?: number): Promise<RestIssue[]> {
    return github.listNewestIssues(this.repo, timeoutMs);
  }
  listNewestCut(timeoutMs?: number) {
    return github.listNewestIssuesCut(this.repo, timeoutMs);
  }
  get(issue: number, timeoutMs?: number): Promise<RestIssue | undefined> {
    return github.restIssue(this.repo, issue, timeoutMs);
  }
  states(numbers: number[], o?: { timeoutMs?: number; before?: () => void; env?: NodeJS.ProcessEnv }): Promise<Map<number, StoryState>> {
    return github.issueStates(this.repo, numbers, o?.timeoutMs, o?.before, o?.env);
  }
  state(issue: number, o?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<StoryState> {
    return github.issueState(this.repo, issue, o?.timeoutMs, o?.env);
  }
  create(o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<RestIssue> {
    return github.createIssue(this.repo, o, timeoutMs);
  }
  edit(issue: number, o: { title?: string; body: string }, timeoutMs?: number): Promise<RestIssue> {
    return github.updateIssue(this.repo, issue, o, timeoutMs);
  }
  async setLabels(issue: number, add: string | undefined, remove: string[], timeoutMs?: number): Promise<void> {
    await github.setLabels(this.repo, issue, add, remove, timeoutMs);
  }
  ensureLabel(name: string, color: string, description: string): Promise<void> {
    return github.ensureLabel(this.repo, name, color, description);
  }
  createLabelIfMissing(name: string, color: string, description: string, timeoutMs?: number): Promise<void> {
    return github.createLabelIfMissing(this.repo, name, color, description, timeoutMs);
  }
  labels(timeoutMs?: number): Promise<string[]> {
    return github.repoLabels(this.repo, timeoutMs);
  }
  comments(issue: number, timeoutMs?: number): Promise<Comment[]> {
    return github.issueComments(this.repo, issue, timeoutMs);
  }
  comment(issue: number, body: string, timeoutMs?: number): Promise<string | undefined> {
    return github.commentOnIssue(this.repo, issue, body, timeoutMs);
  }
  async stepIssue(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "body,number,title,updatedAt"], undefined, timeoutMs);
  }
  async stepBody(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "body", "--jq", ".body"], undefined, timeoutMs);
  }
  async stepText(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "number,title,body,url,labels,comments", "--jq", TICKET_TEXT], undefined, timeoutMs);
  }
  async stepComments(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["api", "--paginate", `repos/${this.repo}/issues/${issue}/comments?per_page=100`, "--jq", ".[] | {id, html_url, created_at, updated_at, body}"], undefined, timeoutMs);
  }
  async stepFoundryComments(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "comments", "--jq", FOUNDRY_IDS], undefined, timeoutMs);
  }
  async stepComment(issue: number, body: string, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "comment", String(issue), "--repo", this.repo, "--body-file", "-"], undefined, timeoutMs, body);
  }
  /** Creates the issue with gh itself (not the REST call), so a label that cannot be set fails the call. The text goes through stdin. */
  async stepCreate(o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<string> {
    return gh(this.createArgs(o), undefined, timeoutMs, o.body);
  }
  async stepTitle(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "title", "-q", ".title"], undefined, timeoutMs);
  }
  async stepLabels(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "labels", "--jq", ".labels[].name"], undefined, timeoutMs);
  }
  async stepCommentsAndLabels(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "comments,labels"], undefined, timeoutMs);
  }
  async stepPlainText(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    return gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "number,title,body,labels,comments", "--jq", PLAIN_TEXT], undefined, timeoutMs);
  }
  async stepAuthors(issue: number, timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    const [owner, name] = this.repo.split("/");
    return gh(["api", "graphql", "-F", `n=${issue}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-f", `query=${AUTHORS_QUERY}`, "--jq", AUTHORS_JQ], undefined, timeoutMs);
  }
  async stepClose(issue: number, reason: "completed" | "not planned", timeoutMs?: number): Promise<string> {
    number(issue, "an issue number");
    if (reason !== "completed" && reason !== "not planned") throw new Error("not a close reason");
    return gh(["issue", "close", String(issue), "--repo", this.repo, "--reason", reason], undefined, timeoutMs);
  }
  async stepFindChange(branch: string, timeoutMs?: number): Promise<string> {
    return gh(["pr", "view", branchRef(branch), "--repo", this.repo, "--json", "url", "-q", ".url"], undefined, timeoutMs);
  }
  async stepReviewDecision(branch: string, timeoutMs?: number): Promise<string> {
    return gh(["pr", "view", branchRef(branch), "--repo", this.repo, "--json", "reviewDecision", "-q", ".reviewDecision"], undefined, timeoutMs);
  }
  async stepListChanges(o: { head: string; base: string }, timeoutMs?: number): Promise<string> {
    return gh(["pr", "list", "--repo", this.repo, "--head", branchRef(o.head), "--base", branchRef(o.base), "--state", "open", "--json", "number,headRefName,state"], undefined, timeoutMs);
  }
  async stepCommentOnChange(pr: ChangeId, body: string, timeoutMs?: number): Promise<string> {
    return gh(["pr", "comment", changeRef(pr), "--repo", this.repo, "--body-file", "-"], undefined, timeoutMs, body);
  }
  async stepSetReady(pr: ChangeId, ready: boolean, timeoutMs?: number): Promise<string> {
    return gh(["pr", "ready", changeRef(pr), "--repo", this.repo, ...(ready ? [] : ["--undo"])], undefined, timeoutMs);
  }
  async stepChangeText(pr: number, timeoutMs?: number): Promise<string> {
    number(pr, "a pull request number");
    return gh(["pr", "view", String(pr), "--repo", this.repo, "--json", "number,title,body", "-q", CHANGE_TEXT], undefined, timeoutMs);
  }
  async stepReviewComments(pr: number, timeoutMs?: number): Promise<string> {
    number(pr, "a pull request number");
    return gh(["api", `repos/${this.repo}/pulls/${pr}/comments`, "--jq", REVIEW_COMMENTS], undefined, timeoutMs);
  }
  async stepReviews(pr: number, timeoutMs?: number): Promise<string> {
    number(pr, "a pull request number");
    return gh(["pr", "view", String(pr), "--repo", this.repo, "--json", "reviews,comments", "--jq", REVIEWS], undefined, timeoutMs);
  }
  async stepOpenStories(o: { limit: number; comments: boolean }): Promise<number> {
    const limit = listSize(o.limit);
    return ghInherit(["issue", "list", "--repo", this.repo, "--state", "open", "--limit", String(limit), "--json", o.comments ? "number,title,body,labels,comments" : "number,title,body,labels"]);
  }
  private createArgs(o: { title: string; labels: string[] }): string[] {
    return ["issue", "create", "--repo", this.repo, "--title", o.title, "--body-file", "-", ...o.labels.flatMap((l) => ["--label", l])];
  }
  private updateChangeArgs(pr: ChangeId, o: { title?: string }): string[] {
    return ["pr", "edit", changeRef(pr), "--repo", this.repo, ...(o.title !== undefined ? ["--title", o.title] : []), "--body-file", "-"];
  }
  private openChangeArgs(o: { head: string; base?: string; title: string; draft?: boolean }): string[] {
    return ["pr", "create", "--repo", this.repo, ...(o.base ? ["--base", o.base] : []), "--head", o.head, "--title", o.title, "--body-file", "-", ...(o.draft ? ["--draft"] : [])];
  }
  async stepOpenChange(o: { head: string; base?: string; title: string; body: string; draft?: boolean }): Promise<number> {
    branchRef(o.head);
    if (o.base) branchRef(o.base);
    return ghInherit(this.openChangeArgs(o), o.body);
  }
  async stepChecks(branch: string): Promise<number> {
    return ghInherit(["pr", "checks", branchRef(branch), "--repo", this.repo, "--watch", "--fail-fast", "--interval", "20"]);
  }
  async stepCheckout(pr: ChangeId): Promise<number> {
    return ghInherit(["pr", "checkout", changeRef(pr), "--repo", this.repo, "--force"]);
  }
  async stepMerge(branch: string): Promise<number> {
    const ref = branchRef(branch);
    return ghInherit(["pr", "merge", ref, "--repo", this.repo, "--squash", "--delete-branch"]);
  }
  upsertStatusComment(issue: number, body: string, o: UpsertOptions): Promise<UpsertResult> {
    return github.upsertStatusComment(this.repo, issue, body, o);
  }
  close(issue: number, reason: "completed" | "not_planned", timeoutMs?: number): Promise<RestIssue> {
    return github.closeIssue(this.repo, issue, reason, timeoutMs);
  }
  async reopen(issue: number, timeoutMs?: number): Promise<RestIssue> {
    number(issue, "an issue number");
    const out = await gh(["api", `repos/${this.repo}/issues/${issue}`, "-X", "PATCH", "--input", "-"], undefined, timeoutMs, JSON.stringify({ state: "open" }));
    const opened = JSON.parse(out.trim()) as RestIssue;
    if (!opened || opened.number !== issue || opened.state !== "open") throw new Error("GitHub did not report the issue as open");
    return opened;
  }

  async findChange(branch: string, timeoutMs?: number): Promise<ChangeRef | undefined> {
    if (!branch) throw new Error("no branch");
    const list = await ghJson<unknown[]>(
      ["pr", "list", "--repo", this.repo, "--head", branch, "--state", "open", "--json", "number,url,headRefName,state", "--limit", "20"],
      undefined,
      timeoutMs,
    );
    for (const e of Array.isArray(list) ? list : []) {
      const p = e as { number?: unknown; url?: unknown; headRefName?: unknown; state?: unknown } | null;
      if (p && p.headRefName === branch && typeof p.state === "string" && p.state.toUpperCase() === "OPEN" && typeof p.number === "number" && typeof p.url === "string") {
        return { number: p.number, url: p.url, headRefName: branch, state: p.state };
      }
    }
    return undefined;
  }
  changeState(pr: number, timeoutMs?: number): Promise<ChangeState> {
    return github.pullState(this.repo, pr, timeoutMs);
  }
  /** `--name=value`: a head, base or title that starts with "-" stays a value. The caller's runner starts gh. */
  openChangeWith<R>(o: { head: string; base: string; title: string; body: string; draft?: boolean }, run: GhRunner<R>): Promise<R> {
    return run(["pr", "create", `--repo=${this.repo}`, `--head=${o.head}`, `--base=${o.base}`, `--title=${o.title}`, "--body-file", "-", ...(o.draft ? ["--draft"] : [])], o.body);
  }
  async openChange(o: { head: string; base?: string; title: string; body: string; draft?: boolean }, timeoutMs?: number): Promise<string> {
    const out = await gh(this.openChangeArgs(o), undefined, timeoutMs, o.body);
    const url = out.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    if (!url || !/^https:\/\/\S+\/pull\/\d+$/.test(url)) throw new Error("GitHub did not report the new pull request");
    return url;
  }
  async updateChange(pr: ChangeId, o: { title?: string; body: string }, timeoutMs?: number): Promise<void> {
    await gh(this.updateChangeArgs(pr, o), undefined, timeoutMs, o.body);
  }
  async mergeChange(pr: ChangeId, timeoutMs?: number): Promise<void> {
    await gh(["pr", "merge", changeRef(pr), "--repo", this.repo, "--squash", "--delete-branch"], undefined, timeoutMs);
  }
  async closeChange(pr: ChangeId, timeoutMs?: number): Promise<void> {
    await gh(["pr", "close", changeRef(pr), "--repo", this.repo], undefined, timeoutMs);
  }
  changeComments(pr: number, timeoutMs?: number): Promise<Comment[]> {
    return github.prComments(this.repo, pr, timeoutMs);
  }
  commentOnChange(pr: number, body: string, timeoutMs?: number): Promise<string | undefined> {
    return github.commentOnPullRequest(this.repo, pr, body, timeoutMs);
  }
  async mergedChanges(limit: number, timeoutMs?: number): Promise<MergedChange[]> {
    if (!whole(limit, 1000)) throw new Error("not a list size");
    return ghJson<MergedChange[]>(
      ["pr", "list", "--repo", this.repo, "--state", "merged", "--limit", String(limit), "--json", "number,title,url,mergedAt,baseRefName,body"],
      undefined,
      timeoutMs,
    );
  }
  async checks(sha: string, timeoutMs = 30_000): Promise<CheckRun[]> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("not a commit");
    const out = await gh(["api", `repos/${this.repo}/commits/${sha}/check-runs?per_page=100`], undefined, timeoutMs);
    const list = (JSON.parse(out) as { check_runs?: unknown } | null)?.check_runs;
    if (!Array.isArray(list)) throw new Error("no check runs list");
    const runs: CheckRun[] = [];
    for (const e of list as unknown[]) {
      const r = e as { name?: unknown; status?: unknown; conclusion?: unknown } | null;
      if (!r || typeof r.name !== "string" || typeof r.status !== "string") continue;
      runs.push({ name: r.name, status: r.status, conclusion: typeof r.conclusion === "string" ? r.conclusion : null });
    }
    return runs;
  }
  async reviewComments(pr: number, timeoutMs?: number): Promise<ReviewComment[]> {
    number(pr, "a pull request number");
    return ghJson<ReviewComment[]>(["api", `repos/${this.repo}/pulls/${pr}/comments`], undefined, timeoutMs);
  }
  async openChanges(limit: number, timeoutMs?: number): Promise<OpenChange[]> {
    return ghJson<OpenChange[]>(
      ["pr", "list", "--repo", this.repo, "--state", "open", "--limit", String(listSize(limit)), "--json", "number,headRefName,state,url,title,createdAt"],
      undefined,
      timeoutMs,
    );
  }
  async changeActivity(pr: number, timeoutMs?: number): Promise<ChangeActivity> {
    number(pr, "a pull request number");
    return ghJson<ChangeActivity>(["pr", "view", String(pr), "--repo", this.repo, "--json", "comments,reviews,commits"], undefined, timeoutMs);
  }

  async probeAccess<R>(run: GhRunner<R>): Promise<{ stories: PromiseSettledResult<R>; changes: PromiseSettledResult<R> }> {
    const probe = (path: string) => run(["api", `repos/${this.repo}/${path}`, "--hostname", "github.com"], "");
    const [stories, changes] = await Promise.allSettled([probe("issues?per_page=1"), probe("pulls?per_page=1&state=all")]);
    return { stories: stories!, changes: changes! };
  }

  sync(run: GhCall): SyncStories {
    const repo = this.repo;
    const createArgs = (o: { title: string; labels: string[] }) => this.createArgs(o);
    const updateChangeArgs = (pr: ChangeId, o: { title?: string }) => this.updateChangeArgs(pr, o);
    const openChangeArgs = (o: { head: string; base?: string; title: string; draft?: boolean }) => this.openChangeArgs(o);
    return {
      get(n) {
        number(n, "an issue number");
        let out: string;
        try { out = run(["issue", "view", String(n), "--repo", repo, "--json", "number,title,state,body"]); }
        catch (e) { if (isNotFound(e)) return undefined; throw e; }
        let story: SyncStory | undefined;
        try { story = toStory(JSON.parse(out)); } catch { story = undefined; }
        if (!story || story.number !== n) throw new Error(`Unexpected answer from gh for #${n}.`);
        return story;
      },
      list(limit) {
        const out = run(["issue", "list", "--repo", repo, "--state", "all", "--limit", String(listSize(limit)), "--json", "number,title,state,body"]);
        const parsed: unknown = JSON.parse(out);
        if (!Array.isArray(parsed)) throw new Error("Unexpected answer from gh for the issue list.");
        return parsed.map(toStory).filter((i): i is SyncStory => !!i);
      },
      setBody(n, body) {
        number(n, "an issue number");
        run(["issue", "edit", String(n), "--repo", repo, "--body-file", "-"], body);
      },
      view(n, fields) {
        number(n, "an issue number");
        return run(["issue", "view", String(n), "--repo", repo, "--json", fieldList(fields)]);
      },
      openList(limit, fields) {
        return run(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(listSize(limit)), "--json", fieldList(fields)]);
      },
      create(o) {
        return run(createArgs(o), o.body);
      },
      comment(n, body) {
        number(n, "an issue number");
        return run(["issue", "comment", String(n), "--repo", repo, "--body-file", "-"], body);
      },
      setLabels(n, add, remove) {
        number(n, "an issue number");
        run(["issue", "edit", String(n), "--repo", repo, ...remove.flatMap((l) => ["--remove-label", l]), ...(add ? ["--add-label", add] : [])]);
      },
      close(n, reason) {
        number(n, "an issue number");
        if (reason !== "completed" && reason !== "not planned") throw new Error("not a close reason");
        run(["issue", "close", String(n), "--repo", repo, "--reason", reason]);
      },
      viewer() {
        return run(["api", "user", "--jq", ".login"]);
      },
      listChanges(o) {
        if (o.state !== "open" && o.state !== "all") throw new Error("not a state");
        return run(["pr", "list", "--repo", repo, ...(o.head !== undefined ? ["--head", branchRef(o.head)] : []), "--state", o.state,
          "--limit", String(listSize(o.limit)), "--json", fieldList(o.fields)]);
      },
      viewChange(pr, fields) {
        return run(["pr", "view", changeRef(pr), "--repo", repo, "--json", fieldList(fields)]);
      },
      openChange(o) {
        branchRef(o.head);
        if (o.base) branchRef(o.base);
        return run(openChangeArgs(o), o.body);
      },
      updateChange(pr, o) {
        run(updateChangeArgs(pr, o), o.body);
      },
      requestReview(pr, who) {
        if (typeof who !== "string" || !who || who.startsWith("-") || /\s/.test(who)) throw new Error("not a reviewer");
        run(["pr", "edit", changeRef(pr), "--repo", repo, "--add-reviewer", who]);
      },
    };
  }
}
