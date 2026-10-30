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

/**
 * Everything the Foundry does with the stories (issues) of one repository and with their change requests (pull requests).
 * A store is bound to one repository. It keeps no gh session: each call runs in the session of the caller (`withGhEnv`).
 */
export interface StoryStore {
  readonly repo: string;
  // stories
  listByLabel(label: string, timeoutMs?: number): Promise<RestIssue[]>;
  listOpenWithLabel(label: string, o: { limit: number; timeoutMs?: number }): Promise<Issue[]>;
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
  upsertStatusComment(issue: number, body: string, o: UpsertOptions): Promise<UpsertResult>;
  close(issue: number, reason: "completed" | "not_planned", timeoutMs?: number): Promise<RestIssue>;
  reopen(issue: number, timeoutMs?: number): Promise<RestIssue>;
  // change requests (pull requests)
  findChange(branch: string, timeoutMs?: number): Promise<ChangeRef | undefined>;
  changeState(pr: number, timeoutMs?: number): Promise<ChangeState>;
  openChange(o: { head: string; base?: string; title: string; body: string; draft?: boolean }, timeoutMs?: number): Promise<string>;
  updateChange(pr: ChangeId, o: { title?: string; body: string }, timeoutMs?: number): Promise<void>;
  mergeChange(pr: ChangeId, timeoutMs?: number): Promise<void>;
  closeChange(pr: ChangeId, timeoutMs?: number): Promise<void>;
  changeComments(pr: number, timeoutMs?: number): Promise<Comment[]>;
  commentOnChange(pr: number, body: string, timeoutMs?: number): Promise<string | undefined>;
  mergedChanges(limit: number, timeoutMs?: number): Promise<MergedChange[]>;
  checks(sha: string, timeoutMs?: number): Promise<CheckRun[]>;
  reviewComments(pr: number, timeoutMs?: number): Promise<ReviewComment[]>;
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
