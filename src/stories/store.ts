import type { CheckRun } from "../delivery/handoff.js";
import type { Comment, Issue, RestIssue, UpsertOptions, UpsertResult } from "../github.js";
import { GitHubStore } from "./github-store.js";

export type StoryState = "open" | "closed";
export type ChangeState = "open" | "merged" | "closed" | "gone" | "unknown";
/** An open pull request found by its branch. */
export interface ChangeRef { number: number; url: string; headRefName: string; state: string }
/** One merged pull request as gh lists it; the caller checks the fields. */
export interface MergedChange { number?: unknown; title?: unknown; url?: unknown; mergedAt?: unknown; baseRefName?: unknown; body?: unknown }
/** A line comment of a review. */
export interface ReviewComment { body: string; created_at: string; user?: { login: string }; path?: string; line?: number | null; original_line?: number | null }
/** A pull request by number, or its https address. */
export type ChangeId = number | string;

/** Runs gh with these arguments (and the text on stdin) and returns its output. It throws when gh fails; the error's `stderr`, or its `message`, carries gh's text. */
export type GhCall = (args: string[], input?: string) => string;

/** Runs one gh call for a caller that owns its process: its exact environment, sign-in and limits. The text goes on stdin. */
export type GhRunner<R> = (args: string[], stdin: string) => Promise<R>;
/** A story as the synchronous part sees it. `state` is upper case. */
export interface SyncStory { number: number; title: string; state: string; body: string }
/** The synchronous view of the stories, bound to the runner of the caller (for tools that run gh themselves). */
export interface SyncStories {
  /** undefined only for a confirmed not-found; a malformed answer or another gh error throws. */
  get(issue: number): SyncStory | undefined;
  /** Malformed entries are dropped; an answer that is not a list throws. */
  list(limit: number): SyncStory[];
  /** The body goes on stdin. */
  setBody(issue: number, body: string): void;
  // The rest return the text of gh, unchanged: the caller parses it and keeps its own handling of a bad answer.
  /** `fields` is a comma list of JSON field names. */
  view(issue: number, fields: string): string;
  openList(limit: number, fields: string): string;
  create(o: { title: string; body: string; labels: string[] }): string;
  comment(issue: number, body: string): string;
  /** Removals come first. */
  setLabels(issue: number, add: string | undefined, remove: string[]): void;
  close(issue: number, reason: "completed" | "not planned"): void;
  /** The login gh acts as. */
  viewer(): string;
  listChanges(o: { state: "open" | "all"; limit: number; fields: string; head?: string }): string;
  viewChange(pr: ChangeId, fields: string): string;
  openChange(o: { head: string; base?: string; title: string; body: string; draft?: boolean }): string;
  updateChange(pr: ChangeId, o: { title?: string; body: string }): void;
  requestReview(pr: ChangeId, who: string): void;
}
/** An open pull request as the watcher lists it. */
export interface OpenChange { number: number; headRefName: string; state: string; url?: string; title?: string; createdAt?: string }
/** The conversation of a pull request. */
export interface ChangeActivity {
  comments: Comment[];
  reviews: { author: { login: string }; body: string; state: string; submittedAt: string }[];
  commits: { committedDate: string }[];
}

/**
 * Everything the Foundry does with the stories (issues) of one repository and with their change requests (pull requests).
 * A store is bound to one repository. It keeps no gh session: each call runs in the session of the caller (`withGhEnv`).
 */
export interface StoryStore {
  readonly repo: string;
  // stories
  listByLabel(label: string, timeoutMs?: number): Promise<RestIssue[]>;
  listOpenWithLabel(label: string, o: { limit: number; timeoutMs?: number }): Promise<Issue[]>;
  listOpenWithAnyLabel(label: string, anyOf: string[], o: { limit: number; timeoutMs?: number }): Promise<Issue[]>;
  listClosedWithAnyLabel(anyOf: string[], o: { limit: number; timeoutMs?: number }): Promise<Issue[]>;
  listWithBodies(limit: number, timeoutMs?: number): Promise<Issue[]>;
  isClosed(issue: number, timeoutMs?: number): Promise<boolean>;
  stateAndLabels(issue: number, timeoutMs?: number): Promise<{ state: string; labels: { name: string }[] }>;
  searchOverrules(o: { since: string; limit: number; timeoutMs?: number }): Promise<{ number: number; updatedAt?: string }[]>;
  listOpenByLabelPages(label: string, o: { fromPage: number; pages: number; timeoutMs?: number }): Promise<{ pages: Map<number, RestIssue[]>; next: number }>;
  listOpen(o: { pages: number; timeoutMs?: number }): Promise<{ issues: RestIssue[]; cut: boolean }>;
  listAll(o: { pages: number; timeoutMs?: number }): Promise<{ issues: RestIssue[]; cut: boolean }>;
  listNewest(timeoutMs?: number): Promise<RestIssue[]>;
  listNewestCut(timeoutMs?: number): Promise<{ issues: RestIssue[]; cut: boolean }>;
  get(issue: number, timeoutMs?: number): Promise<RestIssue | undefined>;
  states(numbers: number[], o?: { timeoutMs?: number; before?: () => void; env?: NodeJS.ProcessEnv }): Promise<Map<number, StoryState>>;
  state(issue: number, o?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<StoryState>;
  create(o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<RestIssue>;
  edit(issue: number, o: { title?: string; body: string }, timeoutMs?: number): Promise<RestIssue>;
  setLabels(issue: number, add: string | undefined, remove: string[], timeoutMs?: number): Promise<void>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  createLabelIfMissing(name: string, color: string, description: string, timeoutMs?: number): Promise<void>;
  labels(timeoutMs?: number): Promise<string[]>;
  comments(issue: number, timeoutMs?: number): Promise<Comment[]>;
  comment(issue: number, body: string, timeoutMs?: number): Promise<string | undefined>;
  // What flow steps save and print (tools/story): the text of gh, unchanged. A later store makes the same text itself.
  stepIssue(issue: number, timeoutMs?: number): Promise<string>;
  stepBody(issue: number, timeoutMs?: number): Promise<string>;
  stepText(issue: number, timeoutMs?: number): Promise<string>;
  stepComments(issue: number, timeoutMs?: number): Promise<string>;
  stepFoundryComments(issue: number, timeoutMs?: number): Promise<string>;
  stepComment(issue: number, body: string, timeoutMs?: number): Promise<string>;
  stepCreate(o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<string>;
  // Those returning a number run gh with the stdout and stderr of this process and return its exit status (a shell's: 128 + the signal).
  stepTitle(issue: number, timeoutMs?: number): Promise<string>;
  stepLabels(issue: number, timeoutMs?: number): Promise<string>;
  stepCommentsAndLabels(issue: number, timeoutMs?: number): Promise<string>;
  stepPlainText(issue: number, timeoutMs?: number): Promise<string>;
  stepAuthors(issue: number, timeoutMs?: number): Promise<string>;
  stepClose(issue: number, reason: "completed" | "not planned", timeoutMs?: number): Promise<string>;
  stepFindChange(branch: string, timeoutMs?: number): Promise<string>;
  stepReviewDecision(branch: string, timeoutMs?: number): Promise<string>;
  stepListChanges(o: { head: string; base: string }, timeoutMs?: number): Promise<string>;
  stepCommentOnChange(pr: ChangeId, body: string, timeoutMs?: number): Promise<string>;
  stepSetReady(pr: ChangeId, ready: boolean, timeoutMs?: number): Promise<string>;
  stepChangeText(pr: number, timeoutMs?: number): Promise<string>;
  stepReviewComments(pr: number, timeoutMs?: number): Promise<string>;
  stepReviews(pr: number, timeoutMs?: number): Promise<string>;
  stepOpenStories(o: { limit: number; comments: boolean }): Promise<number>;
  stepOpenChange(o: { head: string; base?: string; title: string; body: string; draft?: boolean }): Promise<number>;
  stepChecks(branch: string): Promise<number>;
  stepCheckout(pr: ChangeId): Promise<number>;
  stepMerge(branch: string): Promise<number>;
  upsertStatusComment(issue: number, body: string, o: UpsertOptions): Promise<UpsertResult>;
  close(issue: number, reason: "completed" | "not_planned", timeoutMs?: number): Promise<RestIssue>;
  reopen(issue: number, timeoutMs?: number): Promise<RestIssue>;
  // change requests (pull requests)
  findChange(branch: string, timeoutMs?: number): Promise<ChangeRef | undefined>;
  changeState(pr: number, timeoutMs?: number): Promise<ChangeState>;
  openChange(o: { head: string; base?: string; title: string; body: string; draft?: boolean }, timeoutMs?: number): Promise<string>;
  openChangeWith<R>(o: { head: string; base: string; title: string; body: string; draft?: boolean }, run: GhRunner<R>): Promise<R>;
  updateChange(pr: ChangeId, o: { title?: string; body: string }, timeoutMs?: number): Promise<void>;
  mergeChange(pr: ChangeId, timeoutMs?: number): Promise<void>;
  closeChange(pr: ChangeId, timeoutMs?: number): Promise<void>;
  changeComments(pr: number, timeoutMs?: number): Promise<Comment[]>;
  commentOnChange(pr: number, body: string, timeoutMs?: number): Promise<string | undefined>;
  mergedChanges(limit: number, timeoutMs?: number): Promise<MergedChange[]>;
  checks(sha: string, timeoutMs?: number): Promise<CheckRun[]>;
  reviewComments(pr: number, timeoutMs?: number): Promise<ReviewComment[]>;
  openChanges(limit: number, timeoutMs?: number): Promise<OpenChange[]>;
  changeActivity(pr: number, timeoutMs?: number): Promise<ChangeActivity>;
  // synchronous part
  sync(run: GhCall): SyncStories;
  /** Reads one page of the stories and of the pull requests with the caller's runner; one failing does not stop the other. */
  probeAccess<R>(run: GhRunner<R>): Promise<{ stories: PromiseSettledResult<R>; changes: PromiseSettledResult<R> }>;
}

const stores = new Map<string, StoryStore>();

/** The store of a repository: today always GitHub. One instance per repository string. */
export function storeFor(repo: string): StoryStore {
  let s = stores.get(repo);
  if (!s) {
    s = new GitHubStore(repo);
    stores.set(repo, s);
  }
  return s;
}
