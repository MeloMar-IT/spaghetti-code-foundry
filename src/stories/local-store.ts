import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../engine/policy-store.js";
import type { Comment, Issue, RestIssue, UpsertOptions, UpsertResult } from "../github.js";
import { isStatusComment, sameBody, STATUS_MARKER } from "../github.js";
import { checkDirs, type Entry, GO_LABEL, hasLabel, isOpenState, MAX_BYTES, scan, shownLabels, STORIES_DIR, type StoryView, storyNames, toComments, toIssue, toRest, toView, UNREADABLE_TITLE, updatedMs, withLabels } from "./local-map.js";
import { checkFields, commentLines, foundryIds, jsonText, pickFields, plainText, ticketText } from "./local-text.js";
import { type FileStory, type FileStoryState, formatStoryFile, GITHUB_REPO_RE, GO_STATE, highestCommentId, nextCommentId, storyFileName, withCommentIds } from "./story-file.js";
import { commitStory, type StoryChange } from "./story-commit.js";
import { pidAlive, type StoryLockOptions, withStoryLock, withStoryLockSync } from "./story-lock.js";
import type { ChangeActivity, ChangeId, ChangeRef, ChangeState, GhCall, GhRunner, MergedChange, OpenChange, ReviewComment, StoryState, StoryStore, SyncStories, SyncStory } from "./store.js";
import type { CheckRun } from "../delivery/handoff.js";

export { STORIES_DIR, UNREADABLE_TITLE };
export { StoryCommitError } from "./story-commit.js";
export const NO_CHANGES = "Pull requests are not available for a local project";
export const NEXT_NUMBER_FILE = "next-number";

export interface LocalStoreOptions {
  /** How long a write waits for the lock (default 10 s). */
  lockWaitMs?: number;
  lockPollMs?: number;
  alive?: (pid: number) => boolean;
  now?: () => Date;
  /** The name written on comments (default "Foundry"). */
  author?: string;
  onStale?: StoryLockOptions["onStale"];
  /** Commit each change with git (default true). */
  commit?: boolean;
  /** Commit on this branch instead of the checked-out one, leaving the checkout alone (a connected repository uses `scf/stories`). */
  branch?: string;
}

const whole = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= max;
function num(n: unknown): number {
  if (!whole(n)) throw new Error("not an issue number");
  return n;
}
function listSize(n: unknown, max = 1000): number {
  if (!whole(n, max)) throw new Error("not a list size");
  return n;
}
function pageCount(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number of 1 or more`);
}
const noChanges = (): never => { throw new Error(NO_CHANGES); };
const notYet = (name: string): never => { throw new Error(`${name} is not yet available for a local project`); };
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const desc = (a: Entry, b: Entry): number => b.n - a.n;
const noCheck = (): void => {};
/** `recommit`: nothing changes in the file, but commit it again (an earlier write saved it and then failed to commit). */
type Change<T> = (s: FileStory, now: string) => { story?: FileStory; out: T; recommit?: boolean };

/** The store shows `go` as open. */
const plain = (s: FileStoryState): StoryState => (s === "closed" ? "closed" : "open");
const reasonOf = (reason: unknown): "completed" | "not_planned" => {
  if (reason !== "completed" && reason !== "not planned") throw new Error("not a close reason");
  return reason === "completed" ? "completed" : "not_planned";
};

/** Stories kept as files in `<dir>/.scf/stories/`. It has no cache: every call reads the files again. */
export class LocalStore implements StoryStore {
  private readonly lock: Omit<StoryLockOptions, "waitMs">;
  private readonly lockWaitMs: number;
  private readonly now: () => Date;
  private readonly author: string;
  private readonly commit: boolean;
  private readonly branch: string | undefined;

  constructor(private readonly dir: string, readonly repo: string, o: LocalStoreOptions = {}) {
    this.commit = o.commit ?? true;
    this.branch = o.branch;
    this.lockWaitMs = o.lockWaitMs ?? 10_000;
    this.lock = { pollMs: o.lockPollMs ?? 50, alive: o.alive ?? pidAlive, onStale: o.onStale };
    this.now = o.now ?? (() => new Date());
    this.author = o.author ?? "Foundry";
  }

  private get folder(): string { return join(this.dir, STORIES_DIR); }
  private all(): Entry[] { return scan(this.dir); }
  private open(): Entry[] { return this.all().filter((e) => !e.ok || isOpenState(e.story.state)); }

  /** A readable story; rejects when it is missing or broken. */
  private need(entries: Entry[], n: number): Entry & { ok: true } {
    const e = entries.find((x) => x.n === n);
    if (!e) throw new Error(`story #${n} does not exist in ${STORIES_DIR}/`);
    if (!e.ok) throw new Error(`story #${n} cannot be read (${e.rel}): ${e.reason}. Fix the file by hand; the Foundry does not change it`);
    return e;
  }

  // reads
  async listByLabel(label: string): Promise<RestIssue[]> {
    return this.all().filter((e) => hasLabel(e, label)).sort(desc).slice(0, 100).map(toRest);
  }
  async listOpenWithLabel(label: string, o: { limit: number }): Promise<Issue[]> {
    const limit = listSize(o.limit);
    return this.open().filter((e) => hasLabel(e, label)).sort(desc).slice(0, limit).map(toIssue);
  }
  async listOpenWithAnyLabel(label: string, anyOf: string[], o: { limit: number }): Promise<Issue[]> {
    const limit = listSize(o.limit);
    return this.open().filter((e) => hasLabel(e, label) && anyOf.some((l) => hasLabel(e, l))).slice(0, limit).map(toIssue);
  }
  async listClosedWithAnyLabel(anyOf: string[], o: { limit: number }): Promise<Issue[]> {
    const limit = listSize(o.limit);
    return this.all().filter((e) => e.ok && e.story.state === "closed" && anyOf.some((l) => hasLabel(e, l)))
      .sort((a, b) => updatedMs(b) - updatedMs(a) || b.n - a.n).slice(0, limit).map(toIssue);
  }
  async listWithBodies(limit: number): Promise<Issue[]> {
    return this.all().sort(desc).slice(0, listSize(limit)).map(toIssue);
  }
  async isClosed(issue: number): Promise<boolean> {
    return (await this.state(num(issue))) === "closed";
  }
  async stateAndLabels(issue: number): Promise<{ state: string; labels: { name: string }[] }> {
    const e = this.need(this.all(), num(issue));
    return { state: plain(e.story.state).toUpperCase(), labels: shownLabels(e.story).map((name) => ({ name })) };
  }
  async searchOverrules(o: { since: string; limit: number }): Promise<{ number: number; updatedAt?: string }[]> {
    const limit = listSize(o.limit);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.since) || Number.isNaN(Date.parse(o.since))) throw new Error("not a date");
    const since = Date.parse(o.since);
    return this.all().filter((e) => e.ok && Math.max(updatedMs(e), e.mtimeMs) >= since && e.story.comments.some((c) => /overrule/i.test(c.body)))
      .sort(desc).slice(0, limit).map((e) => ({ number: e.n, updatedAt: toRest(e).updated_at }));
  }
  async listOpenByLabelPages(label: string, o: { fromPage: number; pages: number }): Promise<{ pages: Map<number, RestIssue[]>; next: number }> {
    pageCount(o.pages, "pages");
    pageCount(o.fromPage, "fromPage");
    const list = this.open().filter((e) => hasLabel(e, label)).map(toRest);
    const pages = new Map<number, RestIssue[]>();
    for (let p = o.fromPage; p < o.fromPage + o.pages; p++) {
      const page = list.slice((p - 1) * 100, p * 100);
      pages.set(p, page);
      if (page.length < 100) return { pages, next: 1 };
    }
    return { pages, next: o.fromPage + o.pages };
  }
  async listOpen(o: { pages: number }): Promise<{ issues: RestIssue[]; cut: boolean }> {
    pageCount(o.pages, "pages");
    const list = this.open();
    return { issues: list.slice(0, o.pages * 100).map(toRest), cut: list.length > o.pages * 100 };
  }
  async listAll(o: { pages: number }): Promise<{ issues: RestIssue[]; cut: boolean }> {
    pageCount(o.pages, "pages");
    const list = this.all().sort(desc);
    return { issues: list.slice(0, o.pages * 100).map(toRest), cut: list.length > o.pages * 100 };
  }
  async listNewest(): Promise<RestIssue[]> {
    return (await this.listNewestCut()).issues;
  }
  async listNewestCut(): Promise<{ issues: RestIssue[]; cut: boolean }> {
    const list = this.all().sort(desc);
    return { issues: list.slice(0, 100).map(toRest), cut: list.length >= 100 };
  }
  async get(issue: number): Promise<RestIssue | undefined> {
    const n = num(issue);
    const e = this.all().find((x) => x.n === n);
    return e && toRest(e);
  }
  async states(numbers: number[], o?: { before?: () => void }): Promise<Map<number, StoryState>> {
    o?.before?.();
    const entries = this.all();
    const out = new Map<number, StoryState>();
    for (const n of new Set(numbers.filter((x) => whole(x)))) out.set(n, plain(this.need(entries, n).story.state));
    return out;
  }
  async state(issue: number): Promise<StoryState> {
    return plain(this.need(this.all(), num(issue)).story.state);
  }
  async labels(): Promise<string[]> {
    const names = new Set<string>();
    for (const e of this.all()) if (e.ok) shownLabels(e.story).forEach((l) => names.add(l));
    return [...names].sort();
  }
  async ensureLabel(_name: string, _color: string, _description: string): Promise<void> {}
  async createLabelIfMissing(_name: string, _color: string, _description: string, _timeoutMs?: number): Promise<void> {}
  async comments(issue: number): Promise<Comment[]> {
    return toComments(this.need(this.all(), num(issue)), this.author);
  }

  // writes
  /** Reads the story under the lock, lets `change` edit it and saves it in one rename. `change` returns no story when nothing changes. */
  private async write<T>(issue: number, what: StoryChange, o: { timeoutMs?: number; deadline?: number }, change: Change<T>): Promise<{ entry: Entry; out: T }> {
    const n = num(issue);
    if (!checkDirs(this.dir, false)) throw new Error(`${STORIES_DIR} does not exist`);
    const left = (): number => (o.deadline === undefined ? Infinity : o.deadline - Date.now());
    const outOfTime = (): never => { throw new Error("out of time"); };
    if (left() <= 0) outOfTime();
    const waitMs = Math.min(this.lockWaitMs, o.timeoutMs ?? Infinity, left());
    try {
      return await withStoryLock(this.folder, { ...this.lock, waitMs }, (held) => this.applyChange(n, what, change, held, () => { if (left() <= 0) outOfTime(); }, () => Math.min(o.timeoutMs ?? Infinity, left())));
    } catch (e) {
      if (/^the stories are locked/.test((e as Error).message) && o.deadline !== undefined && left() <= 0) outOfTime();
      throw e;
    }
  }

  /** The same write for the synchronous part: it blocks the thread while it waits for the lock. */
  private writeNow<T>(issue: number, what: StoryChange, change: Change<T>): { entry: Entry; out: T } {
    const n = num(issue);
    if (!checkDirs(this.dir, false)) throw new Error(`${STORIES_DIR} does not exist`);
    return withStoryLockSync(this.folder, { ...this.lock, waitMs: this.lockWaitMs }, (held) => this.applyChange(n, what, change, held));
  }

  /** The body of a write, under the lock. Every comment has an id before `change` sees the story and when it is saved. */
  private applyChange<T>(n: number, what: StoryChange, change: Change<T>, held: () => boolean, check: () => void = noCheck, budget?: () => number): { entry: Entry; out: T } {
    check();
    const e = this.need(this.all(), n);
    const now = this.now().toISOString();
    const before = structuredClone(e.story);
    before.comments = withCommentIds(before.comments, before.commentTop);
    before.commentTop = highestCommentId(before);
    const r = change(before, now);
    if (!r.story) {
      if (r.recommit) this.commitFiles(n, [e.rel], what, budget?.());
      return { entry: e, out: r.out };
    }
    // The high-water mark survives a removed comment: an id that was used is never given out again.
    const comments = withCommentIds(r.story.comments, r.story.commentTop);
    const story = { ...r.story, comments, commentTop: highestCommentId({ comments, commentTop: r.story.commentTop }), updatedAt: now };
    const text = this.checked(formatStoryFile(story));
    if (!held()) throw new Error("the lock was lost; try again");
    writeAtomic(join(this.folder, e.file), text);
    this.commitFiles(n, [e.rel], what, budget?.());
    return { entry: { ...e, story, mtimeMs: Date.parse(now) }, out: r.out };
  }

  /** One commit of the files just written, under the lock. `budgetMs` is the time left for git. */
  private commitFiles(n: number, files: string[], what: StoryChange, budgetMs?: number): void {
    if (this.commit) commitStory(this.dir, n, files, what, { budgetMs, branch: this.branch });
  }

  private checked(text: string): string {
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("the story would be larger than 1 MiB");
    return text;
  }

  private nextNumber(): number | undefined {
    const p = join(this.folder, NEXT_NUMBER_FILE);
    let st;
    try { st = lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    const bad = (why: string): never => { throw new Error(`${STORIES_DIR}/${NEXT_NUMBER_FILE} ${why}; fix or delete the file`); };
    if (!st.isFile()) bad("is a link or not a plain file");
    const text = readFileSync(p, "utf8").trim();
    const n = /^\d+$/.test(text) ? Number(text) : 0;
    if (!whole(n)) bad("does not hold a number");
    return n;
  }

  async create(o: { title: string; body: string; labels: string[] }, timeoutMs?: number, guard?: () => void): Promise<RestIssue> {
    if (typeof o.title !== "string" || !o.title.trim()) throw new Error("the story title is empty");
    checkDirs(this.dir, true);
    const wait = Math.min(this.lockWaitMs, timeoutMs ?? Infinity);
    return withStoryLock(this.folder, { ...this.lock, waitMs: wait }, (held) => this.makeStory(o, held, timeoutMs, guard));
  }
  /** Commits a story saved by `create` whose commit failed, with the number file. Same checks as `create`; `guard` runs under the lock first. */
  async commitCreated(issue: number, timeoutMs?: number, guard?: () => void): Promise<void> {
    const n = num(issue);
    if (!checkDirs(this.dir, false)) throw new Error(`${STORIES_DIR} does not exist`);
    await withStoryLock(this.folder, { ...this.lock, waitMs: Math.min(this.lockWaitMs, timeoutMs ?? Infinity) }, (held) => {
      if (!held()) throw new Error("the lock was lost; try again");
      guard?.();
      const counter = this.nextNumber() === undefined ? [] : [`${STORIES_DIR}/${NEXT_NUMBER_FILE}`];
      this.commitFiles(n, [...counter, this.need(this.all(), n).rel], "created", timeoutMs);
    });
  }
  private createNow(o: { title: string; body: string; labels: string[] }): RestIssue {
    if (typeof o.title !== "string" || !o.title.trim()) throw new Error("the story title is empty");
    checkDirs(this.dir, true);
    return withStoryLockSync(this.folder, { ...this.lock, waitMs: this.lockWaitMs }, (held) => this.makeStory(o, held));
  }
  /** The body of `create`, under the lock. */
  private makeStory(o: { title: string; body: string; labels: string[] }, held: () => boolean, timeoutMs?: number, guard?: () => void): RestIssue {
    const unique = o.labels.filter((l, i) => o.labels.findIndex((x) => same(x, l)) === i);
    const labels = unique.filter((l) => !same(l, GO_LABEL));
    const names = storyNames(this.folder);
    const n = Math.max(this.nextNumber() ?? 0, Math.max(0, ...names.keys()) + 1, 1);
    const now = this.now().toISOString();
    const story: FileStory = { number: n, title: o.title, state: labels.length < unique.length ? GO_STATE : "open", kind: "story", labels, dependsOn: [], createdAt: now, updatedAt: now, body: o.body, comments: [] };
    const text = this.checked(formatStoryFile(story));
    const file = storyFileName(n, o.title);
    if (!held()) throw new Error("the lock was lost; try again");
    guard?.();
    // The number goes first: a crash leaves a gap, never a reused number.
    writeAtomic(join(this.folder, NEXT_NUMBER_FILE), `${n + 1}\n`);
    writeAtomic(join(this.folder, file), text);
    this.commitFiles(n, [`${STORIES_DIR}/${NEXT_NUMBER_FILE}`, `${STORIES_DIR}/${file}`], "created", timeoutMs);
    return toRest({ ok: true, n, file, rel: `${STORIES_DIR}/${file}`, mtimeMs: Date.parse(now), story });
  }
  async edit(issue: number, o: { title?: string; body: string }, timeoutMs?: number): Promise<RestIssue> {
    const r = await this.write(issue, "edited", { timeoutMs }, (s) => ({ story: { ...s, title: o.title ?? s.title, body: o.body }, out: undefined }));
    return toRest(r.entry);
  }
  async setLabels(issue: number, add: string | undefined, remove: string[], timeoutMs?: number, guard?: () => void): Promise<void> {
    await this.write(issue, "labels", { timeoutMs }, (s) => { guard?.(); return { story: withLabels(s, add, remove), out: undefined }; });
  }
  async comment(issue: number, body: string, timeoutMs?: number): Promise<string | undefined> {
    const r = await this.write(issue, "comment", { timeoutMs }, (s, now) => this.addComment(s, now, body));
    return r.out;
  }
  private addComment(s: FileStory, now: string, body: string): { story: FileStory; out: string } {
    const id = nextCommentId(s.comments, s.commentTop);
    return { story: { ...s, comments: [...s.comments, { id, author: this.author, createdAt: now, body }] }, out: String(id) };
  }
  /**
   * Records that the story is GitHub issue `gh` of `repo`. The same pair again writes nothing, but commits the file if it is not
   * committed yet (the file is saved before git is called, so a failed commit would stay missing). A different number or
   * repository is refused: a saved mapping is never overwritten.
   */
  async setGithubIssue(issue: number, gh: number, repo: string, timeoutMs?: number): Promise<void> {
    if (!whole(gh)) throw new Error("not an issue number");
    if (!GITHUB_REPO_RE.test(repo)) throw new Error("not a repository name");
    await this.write(issue, "moved", { timeoutMs }, (s) => {
      if (s.githubIssue !== undefined || s.githubRepo !== undefined) {
        if (s.githubIssue === gh && s.githubRepo === repo) return { out: undefined, recommit: true };
        throw new Error(`story #${issue} was already moved to ${s.githubRepo ?? "another repository"}#${s.githubIssue ?? "?"}`);
      }
      return { story: { ...s, githubIssue: gh, githubRepo: repo }, out: undefined };
    });
  }
  /** Records that the move finished everything for the story's issue. Needs `setGithubIssue` first. */
  async markGithubDone(issue: number, timeoutMs?: number): Promise<void> {
    await this.write(issue, "moved", { timeoutMs }, (s) => {
      if (s.githubIssue === undefined) throw new Error(`story #${issue} has no GitHub issue yet`);
      if (s.githubDone) return { out: undefined, recommit: true };
      return { story: { ...s, githubDone: true }, out: undefined };
    });
  }
  async upsertStatusComment(issue: number, body: string, o: UpsertOptions): Promise<UpsertResult> {
    if (o.on === "pr") noChanges();
    const match = o.match ?? isStatusComment;
    const author = this.author;
    const text = isStatusComment({ body }) ? body : `${body}\n\n${STATUS_MARKER}`;
    const r = await this.write(issue, "status", { timeoutMs: o.timeoutMs, deadline: o.deadline }, (s, now) => {
      const ours: number[] = [];
      s.comments.forEach((c, i) => {
        const asComment: Comment = { author: { login: c.author }, body: c.body, createdAt: c.createdAt, viewerDidAuthor: c.author === author };
        if (c.author === author && match(asComment)) ours.push(i);
      });
      const none: UpsertResult = { changed: false, removed: 0, left: 0, login: author };
      if (!ours.length) {
        if (!o.create) return { out: none };
        const id = nextCommentId(s.comments, s.commentTop);
        const comments = [...s.comments, { id, author, createdAt: now, body: text }];
        return { story: { ...s, comments }, out: { id: String(id), changed: true, created: true, removed: 0, left: 0, login: author } };
      }
      const first = ours[0]!;
      const id = String(s.comments[first]!.id);
      const changed = !sameBody(s.comments[first]!.body, text);
      const extra = new Set(ours.slice(1));
      if (!changed && !extra.size) return { out: { ...none, id } };
      const comments = s.comments.flatMap((c, i) => (extra.has(i) ? [] : i === first && changed ? [{ ...c, body: text }] : [c]));
      return { story: { ...s, comments }, out: { id, changed, removed: extra.size, left: 0, login: author } };
    });
    return r.out;
  }
  async close(issue: number, reason: "completed" | "not_planned", timeoutMs?: number): Promise<RestIssue> {
    // Closing a closed story changes nothing: no write, no commit, closedAt stays.
    const r = await this.write(issue, "closed", { timeoutMs }, (s, now) => (s.state === "closed" ? { out: undefined } : { story: { ...s, state: "closed", closedAt: now }, out: undefined }));
    return { ...toRest(r.entry), state_reason: reason };
  }
  async reopen(issue: number, timeoutMs?: number): Promise<RestIssue> {
    const r = await this.write(issue, "reopened", { timeoutMs }, (s) => {
      const { closedAt: _closed, ...rest } = s;
      return { story: { ...rest, state: "open" }, out: undefined };
    });
    return { ...toRest(r.entry), state_reason: "reopened" };
  }

  // what flow steps save and print: the text of gh, made from the files (see local-text.ts)
  /** The story as gh shows it; rejects when it is missing or broken. */
  private one(issue: number): StoryView {
    return toView(this.need(this.all(), num(issue)), this.author);
  }
  async stepIssue(issue: number): Promise<string> { return jsonText(pickFields(this.one(issue), "body,number,title,updatedAt")); }
  async stepBody(issue: number): Promise<string> { return `${this.one(issue).body}\n`; }
  async stepText(issue: number): Promise<string> { return ticketText(this.one(issue)); }
  async stepComments(issue: number): Promise<string> { return commentLines(this.one(issue)); }
  async stepFoundryComments(issue: number): Promise<string> { return foundryIds(this.one(issue)); }
  async stepComment(issue: number, body: string, timeoutMs?: number): Promise<string> {
    const id = await this.comment(issue, body, timeoutMs);
    return `${this.need(this.all(), num(issue)).rel}#issuecomment-${id}\n`;
  }
  /** The address of the new story: its file and `#<number>`, which the tools read the number from. */
  async stepCreate(o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<string> {
    const r = await this.create(o, timeoutMs);
    return `${r.html_url}#${r.number}\n`;
  }
  async stepTitle(issue: number): Promise<string> { return `${this.one(issue).title}\n`; }
  async stepLabels(issue: number): Promise<string> { return this.one(issue).labels.map((l) => `${l.name}\n`).join(""); }
  async stepCommentsAndLabels(issue: number): Promise<string> { return jsonText(pickFields(this.one(issue), "comments,labels")); }
  async stepPlainText(issue: number): Promise<string> { return plainText(this.one(issue)); }
  /** A story file records no author and no editor: the answer gh gives when both are empty. */
  async stepAuthors(issue: number): Promise<string> {
    num(issue);
    return " \n";
  }
  async stepClose(issue: number, reason: "completed" | "not planned", timeoutMs?: number): Promise<string> {
    num(issue);
    await this.close(issue, reasonOf(reason), timeoutMs);
    return "";
  }
  async stepFindChange(): Promise<string> { return notYet("stepFindChange"); }
  async stepReviewDecision(): Promise<string> { return notYet("stepReviewDecision"); }
  async stepListChanges(): Promise<string> { return notYet("stepListChanges"); }
  async stepCommentOnChange(): Promise<string> { return notYet("stepCommentOnChange"); }
  async stepSetReady(): Promise<string> { return notYet("stepSetReady"); }
  async stepChangeText(): Promise<string> { return notYet("stepChangeText"); }
  async stepReviewComments(): Promise<string> { return notYet("stepReviewComments"); }
  async stepReviews(): Promise<string> { return notYet("stepReviews"); }
  async stepOpenStories(o: { limit: number; comments: boolean }): Promise<number> {
    process.stdout.write(this.openJson(listSize(o.limit), o.comments ? "number,title,body,labels,comments" : "number,title,body,labels"));
    return 0;
  }
  /** The open stories, newest first, as a JSON list with these fields. A broken file is listed as "cannot be read". */
  private openJson(limit: number, fields: string): string {
    checkFields(fields);
    return jsonText(this.open().sort(desc).slice(0, limit).map((e) => pickFields(toView(e, this.author), fields)));
  }
  async stepOpenChange(): Promise<number> { return notYet("stepOpenChange"); }
  async stepChecks(): Promise<number> { return notYet("stepChecks"); }
  async stepCheckout(): Promise<number> { return notYet("stepCheckout"); }
  async stepMerge(): Promise<number> { return notYet("stepMerge"); }
  /**
   * The synchronous part works on the files and never calls `run`. A write blocks the thread while it waits for the lock, so
   * only a tool in its own process may use it, never the server.
   */
  sync(_run: GhCall): SyncStories {
    const story = (e: Entry): SyncStory => { const r = toRest(e); return { number: r.number, title: r.title, state: r.state.toUpperCase(), body: r.body ?? "" }; };
    return {
      get: (n) => {
        const e = this.all().find((x) => x.n === num(n));
        return e && story(this.need([e], e.n));
      },
      list: (limit) => this.all().sort(desc).slice(0, listSize(limit)).map(story),
      setBody: (n, body) => { this.writeNow(n, "edited", (s) => ({ story: { ...s, body }, out: undefined })); },
      view: (n, fields) => {
        checkFields(fields);
        return jsonText(pickFields(this.one(n), fields));
      },
      openList: (limit, fields) => this.openJson(listSize(limit), fields),
      create: (o) => {
        const r = this.createNow(o);
        return `${r.html_url}#${r.number}\n`;
      },
      comment: (n, body) => {
        const { out: id } = this.writeNow(n, "comment", (s, now) => this.addComment(s, now, body));
        return `${this.need(this.all(), n).rel}#issuecomment-${id}\n`;
      },
      setLabels: (n, add, remove) => { this.writeNow(n, "labels", (s) => ({ story: withLabels(s, add, remove), out: undefined })); },
      close: (n, reason) => {
        reasonOf(reason);
        num(n);
        this.writeNow(n, "closed", (s, now) => (s.state === "closed" ? { out: undefined } : { story: { ...s, state: "closed", closedAt: now }, out: undefined }));
      },
      viewer: () => `${this.author}\n`,
      listChanges: () => noChanges(),
      viewChange: () => noChanges(),
      openChange: () => noChanges(),
      updateChange: () => noChanges(),
      requestReview: () => noChanges(),
    };
  }

  // pull requests: a local project has none
  async findChange(_branch: string): Promise<ChangeRef | undefined> { return noChanges(); }
  async changeState(_pr: number): Promise<ChangeState> { return noChanges(); }
  async openChange(_o: { head: string; base?: string; title: string; body: string; draft?: boolean }): Promise<string> { return noChanges(); }
  async openChangeWith<R>(_o: { head: string; base: string; title: string; body: string; draft?: boolean }, _run: GhRunner<R>): Promise<R> { return noChanges(); }
  async updateChange(_pr: ChangeId, _o: { title?: string; body: string }): Promise<void> { return noChanges(); }
  async mergeChange(_pr: ChangeId): Promise<void> { return noChanges(); }
  async closeChange(_pr: ChangeId): Promise<void> { return noChanges(); }
  async changeComments(_pr: number): Promise<Comment[]> { return noChanges(); }
  async commentOnChange(_pr: number, _body: string): Promise<string | undefined> { return noChanges(); }
  async mergedChanges(_limit: number): Promise<MergedChange[]> { return noChanges(); }
  async checks(_sha: string): Promise<CheckRun[]> { return noChanges(); }
  async reviewComments(_pr: number): Promise<ReviewComment[]> { return noChanges(); }
  async openChanges(_limit: number): Promise<OpenChange[]> { return noChanges(); }
  async changeActivity(_pr: number): Promise<ChangeActivity> { return noChanges(); }
  async probeAccess<R>(_run: GhRunner<R>): Promise<{ stories: PromiseSettledResult<R>; changes: PromiseSettledResult<R> }> { return noChanges(); }
}
