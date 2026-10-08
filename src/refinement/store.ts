import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findOwnedRepo, listRepos, ownsRepo } from "../auth/repos.js";
import { githubKey, tryParseRepoUrl, validGithubName } from "../auth/repo-url.js";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { getUser } from "../auth/users.js";
import { RefinementError } from "./errors.js";
import { END_NO_IMPACT_DRAFT, setImpact, setReviewLabel, type ImpactRefs } from "./draft-impact.js";
import { confirmSplit, moveCriterion } from "./draft-parts.js";
import { END_NO_SPLIT_DRAFT, refuseSplit, setSplit, type SplitRefs } from "./draft-split.js";
import { acceptAnyway, checkReady, clearAll, clearChanged, openMark, removeAccepted, sessionState, setJudged, type ReadyRefs } from "./draft-ready.js";
import { readyListOf, type ReadyItem } from "./ready-list.js";
import { moveToNotes, setReview, type ReviewRefs } from "./draft-review.js";
import { draftFromStory, type StoryFields } from "./issue-import.js";
import { DRAFT_LOG_KINDS, DraftsSchema, ISSUE_URL, type Draft, EpicSchema, SUGGEST_FIELDS, acceptSuggestion, addSuggested, changeEpic, dropDraft, newDraft, rejectSuggestion, saveTyped, tiesOk, untie, type DraftChange, type DraftState, type SuggestField, type SuggestRefs } from "./draft.js";
import { ASK_MAX, DETAIL_MAX, LISTS, ROUND_LOG_LINES, TALK_LOG_KINDS, TalkSchema, accept, addAsked, addRound, answer, changeText, chars, cut, emptyTalk, isTalkKind, reject, remove, type RoundInput, type Talk, type TalkChange, type TalkLine } from "./talk.js";

export { RefinementError, type RefinementErrorCode } from "./errors.js";
export { ASKED_LOG_LINES, ROUND_LOG_LINES } from "./talk.js";

export const ARCHITECT_KINDS = ["brief", "round", "question", "suggest", "review", "impact", "ready", "split"] as const;
export type ArchitectKind = (typeof ARCHITECT_KINDS)[number];

export const refinementsPath = () => join(dataHome(), "refinements.json");

/** At most this many sessions per account; dropped sessions count until they are removed. */
export const SESSION_LIMIT = 200;
export const IDEA_MAX = 10_000;
export const TITLE_MAX = 120;
/** A session that came from an issue keeps the title of the issue; GitHub allows 256 characters. */
export const SESSION_TITLE_MAX = 256;
/** The longest issue text a session keeps as its source (GitHub's own limit). */
export const SOURCE_BODY_MAX = 65_536;
/** A session keeps at most this many log entries; the last one is kept free so the session can still be dropped. */
export const LOG_LIMIT = 1000;
/** A dropped session is removed after this long. */
/** The longest brief that is stored with a session, in characters. */
export const BRIEF_MAX = 60_000;
export const REASON_MAX = 300;
export const DROP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export const STATES = ["exploring", "drafting", "ready", "published", "dropped"] as const;
export type SessionState = (typeof STATES)[number];
const OPEN_STATES = STATES.filter((s) => s !== "dropped") as Exclude<SessionState, "dropped">[];

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_IN_IDEA = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const OLD_KINDS = ["created", "renamed", "dropped", "restored", "architect-started", "architect-resumed", "architect-brief", "architect-failed", "round-started", "architect-round", "imported"] as const;
const LogEntry = z
  .object({ at: z.iso.datetime(), by: z.uuid(), what: z.enum([...OLD_KINDS, ...TALK_LOG_KINDS, ...DRAFT_LOG_KINDS]), detail: z.string().max(DETAIL_MAX).optional(), list: z.enum(LISTS).optional() })
  .strict()
  .superRefine((l, ctx) => {
    if (!isTalkKind(l.what) && l.detail !== undefined && chars(l.detail) > TITLE_MAX) ctx.addIssue({ code: "custom", message: "too long", path: ["detail"] });
  });

const RUN_ID = z.string().regex(/^[\w-]+$/).max(100);
const BriefSchema = z.object({ text: z.string().min(1).max(BRIEF_MAX), at: z.iso.datetime(), branch: z.string().max(255).optional(), runId: RUN_ID, cut: z.boolean().optional() }).strict();
const ArchitectSchema = z
  .object({ runId: RUN_ID, at: z.iso.datetime(), failed: z.string().max(REASON_MAX).optional(), kind: z.enum(ARCHITECT_KINDS).optional(), question: z.string().min(1).max(ASK_MAX).optional(), draft: z.uuid().optional(), field: z.enum(SUGGEST_FIELDS).optional() })
  .strict()
  .refine((a) =>
    a.kind === "suggest" ? a.draft !== undefined && a.field !== undefined : a.kind === "review" || a.kind === "impact" || a.kind === "ready" || a.kind === "split" ? a.draft !== undefined && a.field === undefined : a.draft === undefined && a.field === undefined,
  );

/** Where a session came from: the issue, and its title, text and `updated_at` when it was read. */
const SourceSchema = z
  .object({
    issue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    url: z.string().max(300).regex(ISSUE_URL),
    title: z.string().min(1).max(SESSION_TITLE_MAX),
    body: z.string().max(SOURCE_BODY_MAX),
    updatedAt: z.iso.datetime(),
    buildLabel: z.string().min(1).max(100).optional(),
  })
  .strict();
export type IssueSource = z.infer<typeof SourceSchema>;

const SessionSchema = z
  .object({
    id: z.uuid(),
    owner: z.uuid(),
    repo: z.string().refine(validGithubName),
    title: z.string().min(1).max(SESSION_TITLE_MAX),
    idea: z.string().min(1).max(IDEA_MAX),
    source: SourceSchema.optional(),
    state: z.enum(STATES),
    stateBefore: z.enum(OPEN_STATES as [string, ...string[]]).optional(),
    droppedAt: z.iso.datetime().optional(),
    drafts: DraftsSchema,
    epic: EpicSchema.optional(),
    brief: BriefSchema.optional(),
    architect: ArchitectSchema.optional(),
    talk: TalkSchema.optional(),
    log: z.array(LogEntry).min(1).max(LOG_LIMIT),
    created: z.iso.datetime(),
    updated: z.iso.datetime(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: "custom", message: "invalid", path: [path] });
    if (s.state === "dropped") {
      if (s.droppedAt === undefined) issue("droppedAt");
      if (s.stateBefore === undefined) issue("stateBefore");
    } else {
      if (s.droppedAt !== undefined) issue("droppedAt");
      if (s.stateBefore !== undefined) issue("stateBefore");
    }
    // A criterion or a suggestion is tied to a rule or an example that is in the map.
    if (!tiesOk(s.drafts, s.talk)) issue("drafts");
  });

const FileSchema = z
  .object({ version: z.literal(1), sessions: z.array(SessionSchema) })
  .strict()
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    f.sessions.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["sessions", i, "id"] });
      ids.add(s.id);
    });
  });

export type Session = z.infer<typeof SessionSchema>;
export type Brief = z.infer<typeof BriefSchema>;
export type LogItem = z.infer<typeof LogEntry>;
type FileData = z.infer<typeof FileSchema>;

const EMPTY: FileData = { version: 1, sessions: [] };
const read = (): FileData => readJsonFile(refinementsPath(), FileSchema, EMPTY);
const save = (sessions: Session[]) => writeJsonFile(refinementsPath(), { version: 1, sessions });
const copy = (s: Session): Session => structuredClone(s);

export interface StoreOptions {
  now?: () => Date;
}

const clock = (opts: StoreOptions) => (opts.now ?? (() => new Date()))();
const expired = (s: Session, now: Date) => s.droppedAt !== undefined && now.getTime() - Date.parse(s.droppedAt) >= DROP_KEEP_MS;

// ---- checking input --------------------------------------------------------------------------------

function checkIdea(input: unknown): string {
  const bad = (m: string) => new RefinementError("bad-idea", m);
  if (typeof input !== "string") throw bad("describe your idea");
  const idea = input.replace(/\r\n/g, "\n").trim();
  if (!idea) throw bad("describe your idea");
  if (idea.length > IDEA_MAX) throw bad(`the idea can have at most ${IDEA_MAX} characters`);
  if (CONTROL_IN_IDEA.test(idea)) throw bad("the idea has characters that are not allowed");
  return idea;
}

function checkTitle(input: unknown): string {
  const bad = (m: string) => new RefinementError("bad-title", m);
  if (typeof input !== "string") throw bad("the title must be text");
  const title = input.trim();
  if (!title) throw bad("give a title");
  if (title.length > TITLE_MAX) throw bad(`the title can have at most ${TITLE_MAX} characters`);
  if (CONTROL.test(title)) throw bad("the title has characters that are not allowed");
  return title;
}

/** The first non-empty line of the idea, tabs as spaces, cut to the title length. */
function titleFromIdea(idea: string): string {
  const line = idea.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\t/g, " ").replace(CONTROL, " ").trim().slice(0, TITLE_MAX).trim() || "Untitled";
}

// ---- default checks (under the lock) ---------------------------------------------------------------

const defaultOwnerOk = (id: string) => getUser(id) !== undefined;

/** The name of the account's GitHub repository (from its record), or undefined when the account has no such one. */
function defaultRepoName(owner: string, name: string): string | undefined {
  const key = githubKey(name);
  for (const r of listRepos(owner)) {
    const p = tryParseRepoUrl(r.url);
    if (p?.github !== undefined && p.key === key) return key.slice("github.com/".length);
  }
  return undefined;
}

export interface CreateOptions extends StoreOptions {
  ownerOk?: (userId: string) => boolean;
  repoName?: (userId: string, name: string) => string | undefined;
}

export interface NewSession {
  repo: unknown;
  idea: unknown;
  title?: unknown;
}

// ---- reading ---------------------------------------------------------------------------------------

/** The sessions that are not expired, newest change first; of one account when `owner` is given. */
export function listSessions(owner?: string, opts: StoreOptions = {}): Session[] {
  const now = clock(opts);
  return read()
    .sessions.filter((s) => !expired(s, now) && (owner === undefined || s.owner === owner))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map(copy);
}

export function getSession(id: string, opts: StoreOptions = {}): Session | undefined {
  const now = clock(opts);
  const s = read().sessions.find((x) => x.id === id && !expired(x, now));
  return s ? copy(s) : undefined;
}

/** Throws when the file cannot be read; writes nothing. */
export function checkRefinements(): void {
  read();
}

// ---- changing --------------------------------------------------------------------------------------

export function createSession(owner: string, input: NewSession, opts: CreateOptions = {}): Session {
  const idea = checkIdea(input.idea);
  const title = input.title === undefined || input.title === null || (typeof input.title === "string" && !input.title.trim()) ? undefined : checkTitle(input.title);
  if (typeof input.repo !== "string" || !validGithubName(input.repo)) throw new RefinementError("bad-repo", "give a GitHub repository as owner/name");
  return insertSession(owner, input.repo, opts, (repo, at) => ({
    id: randomUUID(),
    owner,
    repo,
    title: title ?? titleFromIdea(idea),
    idea,
    state: "exploring",
    drafts: [],
    log: [{ at, by: owner, what: "created" }],
    created: at,
    updated: at,
  }));
}

/** Checks the owner and the repository and the session limit under the lock, then saves the session `make` builds. */
function insertSession(owner: string, given: string, opts: CreateOptions, make: (repo: string, at: string, kept: Session[]) => Session): Session {
  return withAuthLock(() => {
    if (!(opts.ownerOk ?? defaultOwnerOk)(owner)) throw new RefinementError("no-owner", "no such account");
    const repo = (opts.repoName ?? defaultRepoName)(owner, given);
    if (repo === undefined) throw new RefinementError("not-yours", "that is not one of your GitHub repositories");
    const now = clock(opts);
    const file = read();
    const kept = file.sessions.filter((s) => !expired(s, now));
    if (kept.filter((s) => s.owner === owner).length >= SESSION_LIMIT) {
      throw new RefinementError("limit", `at most ${SESSION_LIMIT} sessions; dropped sessions count until they are removed after 30 days`);
    }
    const session = make(repo, now.toISOString(), kept);
    save([...kept, session]);
    return copy(session);
  });
}

const openOfIssue = (s: Session, owner: string, repo: string, issue: number) =>
  s.owner === owner && s.source?.issue === issue && s.repo.toLowerCase() === repo.toLowerCase() && s.state !== "dropped" && s.state !== "published";

/** The open (not dropped, not published, not expired) session of `owner` that came from this issue. */
export function openSessionOfIssue(owner: string, repo: string, issue: number, opts: StoreOptions = {}): Session | undefined {
  const now = clock(opts);
  const s = read().sessions.find((x) => !expired(x, now) && openOfIssue(x, owner, repo, issue));
  return s ? copy(s) : undefined;
}

export interface NewIssueSession {
  repo: unknown;
  title: string;
  idea: string;
  source: IssueSource;
  story?: StoryFields;
}

/**
 * A session from an issue that was read: the idea is its title and text; a text in the story format gives one draft, every field typed.
 * `beforeSave` runs under the lock, right before the write; it may throw to refuse.
 */
export function createSessionFromIssue(owner: string, input: NewIssueSession, opts: CreateOptions & Pick<TalkOptions, "readyList"> & { beforeSave?: () => void } = {}): Session {
  const idea = checkIdea(input.idea);
  const title = input.title.trim();
  if (!title || title.length > SESSION_TITLE_MAX || CONTROL.test(title)) throw new RefinementError("bad-title", "the title of the issue cannot be used");
  if (typeof input.repo !== "string" || !validGithubName(input.repo)) throw new RefinementError("bad-repo", "give a GitHub repository as owner/name");
  return insertSession(owner, input.repo, opts, (repo, at, kept) => {
    const dup = kept.find((s) => openOfIssue(s, owner, repo, input.source.issue));
    if (dup) throw new RefinementError("duplicate", `issue #${input.source.issue} already has an open refinement session: "${dup.title}"`, dup.id);
    opts.beforeSave?.();
    const drafts = input.story ? [draftFromStory(input.story)] : [];
    const list = (opts.readyList ?? defaultReadyList)(owner, repo);
    const session: Session = {
      id: randomUUID(),
      owner,
      repo,
      title,
      idea,
      source: input.source,
      state: stateOf("exploring", false, drafts, list),
      drafts,
      ...(input.story?.epic !== undefined ? { epic: input.story.epic } : {}),
      log: [{ at, by: owner, what: "imported", detail: `#${input.source.issue}` }],
      created: at,
      updated: at,
    };
    // A wrong import never reaches the file.
    return SessionSchema.parse(session);
  });
}

export interface Actor {
  id: string;
  admin: boolean;
}

/** Sessions that are being published right now (in this server process). A person's change of such a session is refused. */
const publishing = new Set<string>();
/** Marks the session as being published; false when it is marked already. */
export function beginPublishing(id: string): boolean {
  if (publishing.has(id)) return false;
  publishing.add(id);
  return true;
}
export function endPublishing(id: string): void {
  publishing.delete(id);
}
export const isPublishing = (id: string): boolean => publishing.has(id);

/**
 * Finds the session for an actor, changes it under the lock and writes the file. Expired sessions are removed on the way.
 * `fn` returns the changed session, or undefined when nothing changes. Only the publisher (`publisher`) may change a session that is being published.
 */
function change(actor: Actor, id: string, opts: StoreOptions, mayAdmin: boolean, fn: (s: Session, at: string) => Session | undefined, publisher = false): Session {
  return withAuthLock(() => {
    const now = clock(opts);
    const file = read();
    const kept = file.sessions.filter((s) => !expired(s, now));
    const cur = kept.find((s) => s.id === id);
    if (!cur || (cur.owner !== actor.id && !actor.admin)) throw new RefinementError("not-found", "no such refinement session");
    if (cur.owner !== actor.id && !mayAdmin) throw new RefinementError("not-owner", "only the owner can change this session");
    if (!publisher && publishing.has(id)) throw new RefinementError("busy", "this session is being published; try again in a moment");
    const next = fn(cur, now.toISOString());
    if (!next && kept.length === file.sessions.length) return copy(cur);
    save(next ? kept.map((s) => (s === cur ? next : s)) : kept);
    return copy(next ?? cur);
  });
}

/** The log lines a run that is not over still needs for its end: kept free from every other change of the session. */
const reservedFor = (s: Session): number => (s.architect && s.architect.failed === undefined ? architectLogRoom(s.architect.kind) - 1 : 0);

/** How many more log lines the session can take before the slot kept for dropping (and for a run that is not over). */
export const logRoom = (s: Session): number => LOG_LIMIT - 1 - reservedFor(s) - s.log.length;

const room = (s: Session, last: number, keep = true) => {
  if (s.log.length + 1 > last - (keep ? reservedFor(s) : 0)) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
};

export function renameSession(actor: Actor, id: string, title: unknown, opts: StoreOptions = {}): Session {
  return change(actor, id, opts, false, (s, at) => {
    if (s.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be renamed; restore it first");
    const t = checkTitle(title);
    if (s.title === t) return undefined;
    room(s, LOG_LIMIT - 1);
    return { ...s, title: t, updated: at, log: [...s.log, { at, by: actor.id, what: "renamed", detail: t }] };
  });
}

export function dropSession(actor: Actor, id: string, opts: StoreOptions = {}): Session {
  return change(actor, id, opts, true, (s, at) => {
    if (s.state === "dropped") throw new RefinementError("bad-state", "that session is dropped already");
    room(s, LOG_LIMIT, false); // dropping must always work; it cancels the run
    return { ...s, state: "dropped", stateBefore: s.state, droppedAt: at, updated: at, log: [...s.log, { at, by: actor.id, what: "dropped" }] };
  });
}

export function restoreSession(actor: Actor, id: string, opts: StoreOptions = {}): Session {
  return change(actor, id, opts, false, (s, at) => {
    if (s.state !== "dropped" || s.stateBefore === undefined) throw new RefinementError("bad-state", "that session is not dropped");
    room(s, LOG_LIMIT - 1);
    // Another open session for the same issue may have been made while this one was dropped.
    const other = s.source ? read().sessions.find((x) => x.id !== s.id && !expired(x, new Date(at)) && openOfIssue(x, s.owner, s.repo, s.source!.issue)) : undefined;
    if (other) throw new RefinementError("duplicate", `issue #${s.source!.issue} has another open refinement session: "${other.title}"; drop it first`, other.id);
    const { stateBefore, droppedAt: _droppedAt, ...rest } = s;
    return { ...rest, state: stateBefore as SessionState, updated: at, log: [...s.log, { at, by: actor.id, what: "restored" }] };
  });
}

/** Removes the dropped sessions that are past their 30 days. Returns how many. A missing file is not created. */
export function purgeDropped(opts: StoreOptions = {}): number {
  try {
    lstatSync(refinementsPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
  }
  return withAuthLock(() => {
    const now = clock(opts);
    const file = read();
    const kept = file.sessions.filter((s) => !expired(s, now));
    if (kept.length === file.sessions.length) return 0;
    save(kept);
    return file.sessions.length - kept.length;
  });
}

/** Removes the sessions of an account. Only inside withAuthLock; writes nothing when there are none. */
export function removeRefinementsLocked(owner: string): number {
  if (!authLockHeld()) throw new Error("removeRefinementsLocked must run inside withAuthLock");
  const file = read();
  const mine = file.sessions.filter((s) => s.owner === owner);
  if (!mine.length) return 0;
  save(file.sessions.filter((s) => s.owner !== owner));
  return mine.length;
}

// ---- the architect's run ---------------------------------------------------------------------------

/** Under the lock: changes a session found by id (not expired), with no actor. Undefined when it is not there or `fn` changes nothing. */
function changeById(id: string, opts: StoreOptions, fn: (s: Session, at: string) => Session | undefined): Session | undefined {
  return withAuthLock(() => {
    const now = clock(opts);
    const file = read();
    const cur = file.sessions.find((s) => s.id === id && !expired(s, now));
    if (!cur) return undefined;
    const next = fn(cur, now.toISOString());
    if (!next) return undefined;
    save(file.sessions.filter((s) => !expired(s, now)).map((s) => (s === cur ? next : s)));
    return copy(next);
  });
}

/** The log with one more entry, when that leaves the slot kept for dropping (and `spare` more entries); else the log as it is. */
const logged = (s: Session, at: string, what: LogItem["what"], detail?: string, spare = 0): LogItem[] =>
  s.log.length + 1 + spare <= LOG_LIMIT - 1 ? [...s.log, { at, by: s.owner, what, ...(detail !== undefined ? { detail: detail.slice(0, TITLE_MAX) } : {}) }] : s.log;

/** The log lines a run of this kind can write in all: its start and its end. The room is kept when the run starts. */
export const architectLogRoom = (kind: ArchitectKind = "brief"): number => (kind === "round" ? 1 + ROUND_LOG_LINES + 2 : 2);

export const END_BAD_FORM = "The architect's answer did not have the agreed form";
export const END_NO_ROOM = "The talk or the log of this session has no room for the answer";
export const END_NO_QUESTION = "The question of the person could not be found";
export const END_NO_DRAFT = "The story draft for the suggestion could not be found";
export const END_NO_REVIEW_DRAFT = "The story draft for the review could not be found";
export const END_NO_READY_DRAFT = "The story draft for the readiness check could not be found";
export const END_ON_GITHUB = "The story draft is on GitHub already";
export const END_SPLIT_DURING = "The draft was split while the architect was reading";
export const END_READY_CHANGED = "The draft changed while the architect judged it; check readiness again";

export interface ArchitectAsk {
  kind?: ArchitectKind;
  /** For kind `question`: the checked question. */
  question?: string;
  /** For kind `suggest`: the draft and the field the suggestion is for. For kind `review`: the draft. */
  draft?: string;
  field?: SuggestField;
}

/** The owner starts a run of the architect: records it. Refused for a dropped session, and when the log has no room for the start and its end. */
export function setArchitectRun(actor: Actor, id: string, runId: string, ask: ArchitectAsk = {}, opts: StoreOptions = {}): Session {
  const kind = ask.kind ?? "brief";
  if (kind === "suggest" && (!ask.draft || !ask.field)) throw new Error("a suggestion run needs a draft and a field");
  if (kind === "review" && !ask.draft) throw new Error("a review run needs a draft");
  if (kind === "impact" && !ask.draft) throw new Error("an impact run needs a draft");
  if (kind === "ready" && !ask.draft) throw new Error("a readiness run needs a draft");
  if (kind === "split" && !ask.draft) throw new Error("a split run needs a draft");
  return change(actor, id, opts, false, (s, at) => {
    if (s.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be read; restore it first");
    if (s.log.length + architectLogRoom(kind) > LOG_LIMIT - 1) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
    const architect = {
      runId,
      at,
      ...(kind !== "brief" ? { kind } : {}),
      ...(kind === "question" && ask.question !== undefined ? { question: ask.question } : {}),
      ...(kind === "suggest" ? { draft: ask.draft, field: ask.field } : {}),
      ...(kind === "review" || kind === "impact" || kind === "ready" || kind === "split" ? { draft: ask.draft } : {}),
    };
    const entry: LogItem =
      kind === "question"
        ? { at, by: actor.id, what: "asked", detail: cut(ask.question ?? "", DETAIL_MAX) }
        : kind === "suggest"
          ? { at, by: actor.id, what: "suggestion-asked", detail: ask.field }
          : kind === "review"
            ? { at, by: actor.id, what: "review-asked" }
            : kind === "impact"
              ? { at, by: actor.id, what: "impact-asked" }
              : kind === "split"
                ? { at, by: actor.id, what: "split-asked" }
                : kind === "ready"
                  ? { at, by: actor.id, what: "ready-asked" }
                  : { at, by: actor.id, what: kind === "round" ? "round-started" : "architect-started", detail: runId };
    return { ...s, architect, updated: at, log: [...s.log, entry] };
  });
}

/** A paused run was resumed: it is not marked failed any more. The log entry is written only when it leaves room for the end. Never throws. */
export function noteArchitectResumed(id: string, runId: string, opts: StoreOptions = {}): void {
  try {
    changeById(id, opts, (s, at) => {
      if (s.architect?.runId !== runId) return undefined;
      const { failed: _failed, ...architect } = s.architect;
      return { ...s, architect, updated: at, log: logged(s, at, "architect-resumed", runId, architectLogRoom(architect.kind) - 1) };
    });
  } catch {
    // the session stays as it was; the next read settles it
  }
}

export type ArchitectEnd = { brief: { text: string; at: string; branch?: string } } | { round: RoundInput } | { answer: string } | { suggested: unknown; refs?: SuggestRefs } | { reviewed: unknown; refs?: ReviewRefs } | { impact: unknown; refs?: ImpactRefs } | { split: unknown; refs?: SplitRefs } | { judged: unknown; refs?: ReadyRefs } | { failed: string };

/**
 * The run of `runId` ended. A brief replaces the stored one; a round is added to the talk; an answer is stored with the own question;
 * each clears the run. A failure keeps the talk and the brief and marks the run. Nothing is written for another run id, an unknown
 * session or a mark that is there already.
 */
export function endArchitectRun(id: string, runId: string, end: ArchitectEnd, opts: TalkOptions = {}): Session | undefined {
  return changeById(id, opts, (s, at) => {
    if (s.architect?.runId !== runId) return undefined;
    const a = s.architect;
    const fail = (text: string): Session | undefined => {
      const failed = text.slice(0, REASON_MAX);
      if (a.failed === failed) return undefined;
      return { ...s, architect: { ...a, failed }, updated: at, log: a.failed === undefined ? logged(s, at, "architect-failed", failed) : s.log };
    };
    if ("failed" in end) return fail(end.failed);
    // A draft that is on GitHub is not changed by the end of a run.
    if (a.draft && s.drafts.find((d) => d.id === a.draft)?.published) return fail(END_ON_GITHUB);
    // The original of a split is read-only: a run that ends after the split does not store its result there.
    if (a.draft && !("split" in end) && s.drafts.find((d) => d.id === a.draft)?.splitInto) return fail(END_SPLIT_DURING);
    const { architect: _gone, ...rest } = s;
    if ("brief" in end) {
      const tooLong = end.brief.text.length > BRIEF_MAX;
      const brief: Brief = { text: end.brief.text.slice(0, BRIEF_MAX), at: end.brief.at, ...(end.brief.branch ? { branch: end.brief.branch } : {}), runId, ...(tooLong ? { cut: true } : {}) };
      return { ...rest, brief, updated: at, log: logged(s, at, "architect-brief", runId) };
    }
    if ("suggested" in end) {
      if (a.kind !== "suggest" || !a.draft || !a.field) return fail(END_NO_DRAFT);
      try {
        const c = addSuggested({ drafts: s.drafts, epic: s.epic }, s.talk, a.draft, a.field, end.suggested, end.refs ?? {});
        if (!c) return fail(END_NO_DRAFT);
        return { ...rest, drafts: c.drafts, updated: at, log: logged(s, at, "architect-suggested", a.field) };
      } catch (e) {
        if (!(e instanceof RefinementError)) throw e;
        return fail(END_BAD_FORM);
      }
    }
    if ("reviewed" in end) {
      if (a.kind !== "review" || !a.draft) return fail(END_NO_REVIEW_DRAFT);
      try {
        const c = setReview({ drafts: s.drafts, epic: s.epic }, a.draft, end.reviewed, end.refs ?? {}, at);
        if (!c) return fail(END_NO_REVIEW_DRAFT);
        return { ...rest, drafts: c.drafts, updated: at, log: logged(s, at, "architect-reviewed", c.line?.detail) };
      } catch (e) {
        if (!(e instanceof RefinementError)) throw e;
        return fail(END_BAD_FORM);
      }
    }
    if ("impact" in end) {
      if (a.kind !== "impact" || !a.draft) return fail(END_NO_IMPACT_DRAFT);
      try {
        const c = setImpact({ drafts: s.drafts, epic: s.epic }, a.draft, end.impact, end.refs, at);
        if (!c) return fail(END_NO_IMPACT_DRAFT);
        return { ...rest, drafts: c.drafts, updated: at, log: logged(s, at, "architect-impact", c.line?.detail) };
      } catch (e) {
        if (!(e instanceof RefinementError)) throw e;
        return fail(END_BAD_FORM);
      }
    }
    if ("split" in end) {
      if (a.kind !== "split" || !a.draft) return fail(END_NO_SPLIT_DRAFT);
      try {
        const c = setSplit({ drafts: s.drafts, epic: s.epic }, a.draft, end.split, end.refs, at);
        if (!c) return fail(END_NO_SPLIT_DRAFT);
        return { ...rest, drafts: c.drafts, updated: at, log: logged(s, at, "architect-split", c.line?.detail) };
      } catch (e) {
        if (!(e instanceof RefinementError)) throw e;
        return fail(END_BAD_FORM);
      }
    }
    if ("judged" in end) {
      if (a.kind !== "ready" || !a.draft) return fail(END_NO_READY_DRAFT);
      const list = (opts.readyList ?? defaultReadyList)(s.owner, s.repo);
      try {
        const c = setJudged({ drafts: s.drafts, epic: s.epic }, s.talk, a.draft, end.judged, end.refs, list ?? readyListOf(undefined));
        if (!c) return fail(END_NO_READY_DRAFT);
        if (c === "changed") return fail(END_READY_CHANGED);
        const state = stateOf(s.state, s.drafts.length > 0, c.drafts, list);
        return { ...rest, drafts: c.drafts, state, updated: at, log: logged(s, at, "architect-judged", c.line?.detail) };
      } catch (e) {
        if (!(e instanceof RefinementError)) throw e;
        return fail(END_BAD_FORM);
      }
    }
    const talk = s.talk ?? emptyTalk();
    try {
      let c: TalkChange | undefined;
      const lines: LogLine[] = [];
      if ("round" in end) {
        c = addRound(talk, runId, end.round, at);
        if (!c) return undefined;
        lines.push(...c.lines);
        const done = c.talk.rounds.at(-1)?.done;
        if (done) lines.push({ what: "round-done", detail: cut(done, DETAIL_MAX) });
        lines.push({ what: "architect-round", detail: runId });
      } else {
        if (a.question === undefined) return fail(END_NO_QUESTION);
        c = addAsked(talk, runId, { question: a.question, answer: end.answer }, at);
        if (!c) return undefined;
        // The question was logged when the run started.
        lines.push(...c.lines.filter((l) => l.what !== "asked"));
      }
      return withTalk(rest, { talk: c.talk, lines }, at, s.owner, false);
    } catch (e) {
      if (!(e instanceof RefinementError)) throw e;
      return fail(e.code === "limit" ? END_NO_ROOM : END_BAD_FORM);
    }
  });
}

// ---- the talk --------------------------------------------------------------------------------------

export interface TalkOptions extends StoreOptions {
  repoOk?: (owner: string, repo: string) => boolean;
  /** The Definition of Ready of the repository (owner, GitHub name); undefined when the repository is not there. */
  readyList?: (owner: string, repo: string) => readonly ReadyItem[] | undefined;
}

const defaultReadyList = (owner: string, repo: string): readonly ReadyItem[] | undefined => {
  const r = findOwnedRepo(owner, repo);
  return r ? readyListOf(r.definitionOfReady) : undefined;
};

/** The session with the changed talk and its log lines. Throws `limit` when the lines do not all fit before the slot kept for dropping. */
interface LogLine {
  what: LogItem["what"];
  detail?: string;
  list?: TalkLine["list"];
}

function withTalk(s: Session, c: { talk: Talk; lines: LogLine[] }, at: string, by: string, keep = true): Session {
  if (c.lines.length) room(s, LOG_LIMIT - c.lines.length, keep);
  // A change of the open questions clears the checks of every draft.
  const cleared = openMark(s.talk) !== openMark(c.talk) ? { drafts: clearAll(s.drafts), ...(s.state === "ready" ? { state: "drafting" as const } : {}) } : {};
  return { ...s, ...cleared, talk: c.talk, updated: at, log: [...s.log, ...c.lines.map((l) => ({ at, by, what: l.what, ...(l.detail !== undefined ? { detail: l.detail } : {}), ...(l.list ? { list: l.list } : {}) }))] };
}

/** The talk and the drafts change only in a session that is not dropped and whose repository is in My repositories. */
function mustBeOpen(s: Session, opts: TalkOptions): void {
  if (s.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be changed; restore it first");
  if (!(opts.repoOk ?? ownsRepo)(s.owner, s.repo)) throw new RefinementError("no-repo", "the repository is not in My repositories any more");
}

function changeTalk(actor: Actor, id: string, opts: TalkOptions, fn: (talk: Talk, at: string) => TalkChange | undefined): Session {
  return change(actor, id, opts, false, (s, at) => {
    mustBeOpen(s, opts);
    const c = fn(s.talk ?? emptyTalk(), at);
    return c ? withTalk(s, c, at, actor.id) : undefined;
  });
}

export const answerQuestion = (actor: Actor, id: string, questionId: string, input: unknown, opts: TalkOptions = {}): Session => changeTalk(actor, id, opts, (t, at) => answer(t, questionId, input, at));
export const acceptProposal = (actor: Actor, id: string, proposalId: string, opts: TalkOptions = {}): Session => changeTalk(actor, id, opts, (t, at) => accept(t, proposalId, at));
export const rejectProposal = (actor: Actor, id: string, proposalId: string, opts: TalkOptions = {}): Session => changeTalk(actor, id, opts, (t) => reject(t, proposalId));
export const changeEntry = (actor: Actor, id: string, entryId: string, text: unknown, opts: TalkOptions = {}): Session => changeTalk(actor, id, opts, (t) => changeText(t, entryId, text));
/** Removes an entry of the map; criteria tied to it lose the tie and waiting suggestions from it go, in the same write. */
export const removeEntry = (actor: Actor, id: string, entryId: string, opts: TalkOptions = {}): Session =>
  change(actor, id, opts, false, (s, at) => {
    mustBeOpen(s, opts);
    const next = withTalk(s, remove(s.talk ?? emptyTalk(), entryId), at, actor.id);
    const drafts = untie(next.drafts, entryId);
    const held = next.drafts.find((d) => d.published && JSON.stringify(drafts.find((x) => x.id === d.id)) !== JSON.stringify(d));
    if (held?.published) throw new RefinementError("bad-state", `a story draft that is on GitHub as issue #${held.published.issue} is tied to this entry; it cannot be removed here`);
    return { ...next, drafts };
  });

/**
 * For part 3c, no actor: stores a round of questions and its proposals. Undefined for an unknown session or a run id that is stored
 * already. Throws RefinementError (bad-round, limit) and writes nothing then; `limit` also when the log has no room for every line.
 */
export function recordRound(id: string, runId: string, round: RoundInput, opts: StoreOptions = {}): Session | undefined {
  return changeById(id, opts, (s, at) => {
    const c = addRound(s.talk ?? emptyTalk(), runId, round, at);
    return c ? withTalk(s, c, at, s.owner, false) : undefined;
  });
}

/** An own question and the architect's answer, stored with the session. Same rules as `recordRound`. */
export function recordAsked(id: string, runId: string, asked: { question: string; answer: string }, opts: StoreOptions = {}): Session | undefined {
  return changeById(id, opts, (s, at) => {
    const c = addAsked(s.talk ?? emptyTalk(), runId, asked, at);
    return c ? withTalk(s, c, at, s.owner, false) : undefined;
  });
}

// ---- the story drafts ------------------------------------------------------------------------------

/** What a change of the drafts must check first: the draft it is about, the Epic, a new draft. */
interface DraftGuard {
  draft?: string;
  epic?: true;
  add?: true;
}

const onGithub = (d: Draft): string => `a story draft that is on GitHub as issue #${d.published?.issue}`;

/**
 * The state of a session with these drafts: `published` when every draft is on GitHub; else as `sessionState`, which looks only at the
 * drafts that are not on GitHub. Without a list (the repository is not there) only the first rule applies.
 */
function stateOf(cur: SessionState, hadDrafts: boolean, drafts: Draft[], list: readonly ReadyItem[] | undefined): SessionState {
  // A split original is never published; its parts are.
  const publishable = drafts.filter((d) => !d.splitInto);
  if (publishable.length && publishable.every((d) => d.published)) return "published";
  if (!list) return cur;
  return sessionState(cur, hadDrafts, drafts.filter((d) => !d.published), list);
}

function changeDrafts(actor: Actor, id: string, opts: TalkOptions, fn: (st: DraftState, x: { talk: Talk | undefined; list: readonly ReadyItem[]; at: string }) => DraftChange | undefined, guard: DraftGuard = {}): Session {
  return change(actor, id, opts, false, (s, at) => {
    mustBeOpen(s, opts);
    if (guard.add && s.state === "published") throw new RefinementError("bad-state", "every story draft of this session is on GitHub; start a new session for more");
    const target = guard.draft === undefined ? undefined : s.drafts.find((d) => d.id === guard.draft);
    if (target?.published) throw new RefinementError("bad-state", `${onGithub(target)}; it cannot be changed here`);
    const lock = guard.epic ? s.drafts.find((d) => d.published) : undefined;
    if (lock) throw new RefinementError("bad-state", `${onGithub(lock)}; the Epic cannot be changed any more`);
    const list = (opts.readyList ?? defaultReadyList)(s.owner, s.repo) ?? readyListOf(undefined);
    const before = { drafts: s.drafts, epic: s.epic };
    const c = fn(before, { talk: s.talk, list, at });
    if (!c) return undefined;
    if (c.line) room(s, LOG_LIMIT - 1);
    const { epic: _epic, ...rest } = s;
    // A draft whose text changed has no check any more; the state follows the drafts (first draft, none left, all ready).
    const drafts = clearChanged(before, c);
    // A draft that is on GitHub stays as it is, also when the change reaches it through another draft.
    const held = s.drafts.find((d) => d.published && JSON.stringify(drafts.find((x) => x.id === d.id)) !== JSON.stringify(d));
    if (held) throw new RefinementError("bad-state", `${onGithub(held)} would change by this; it cannot be done here`);
    const state = stateOf(s.state, s.drafts.length > 0, drafts, list);
    const line = c.line ? [{ at, by: actor.id, what: c.line.what, ...(c.line.detail !== undefined ? { detail: cut(c.line.detail, TITLE_MAX) } : {}) }] : [];
    return { ...rest, ...(c.epic !== undefined ? { epic: c.epic } : {}), drafts, state, updated: at, log: [...s.log, ...line] };
  });
}

export const addDraft = (actor: Actor, id: string, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, newDraft, { add: true });
export const saveDraft = (actor: Actor, id: string, draftId: string, input: unknown, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st) => (refuseSplit(st, draftId), saveTyped(st, draftId, input)), { draft: draftId });
export const removeDraft = (actor: Actor, id: string, draftId: string, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st) => dropDraft(st, draftId), { draft: draftId });
export const confirmSplitOf = (actor: Actor, id: string, draftId: string, input: unknown, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st) => confirmSplit(st, draftId, input), { draft: draftId });
export const moveCriterionOf = (actor: Actor, id: string, draftId: string, criterionId: string, input: unknown, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st) => moveCriterion(st, draftId, criterionId, input), { draft: draftId });
export const acceptSuggestionOf = (actor: Actor, id: string, draftId: string, sid: string, input: unknown, opts: TalkOptions = {}): Session =>
  changeDrafts(actor, id, opts, (st) => (refuseSplit(st, draftId), acceptSuggestion(st, draftId, sid, input)), { draft: draftId });
export const rejectSuggestionOf = (actor: Actor, id: string, draftId: string, sid: string, input: unknown, opts: TalkOptions = {}): Session =>
  changeDrafts(actor, id, opts, (st) => (refuseSplit(st, draftId), rejectSuggestion(st, draftId, sid, input)), { draft: draftId });
/** The person moves the text of a field (or one criterion) that has a plan or how remark to the notes for the builder, as a wish. */
export const moveToNotesOf = (actor: Actor, id: string, draftId: string, input: unknown, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st) => (refuseSplit(st, draftId), moveToNotes(st, draftId, input)), { draft: draftId });
export const setReviewLabelOf = (actor: Actor, id: string, draftId: string, input: unknown, opts: TalkOptions = {}): Session =>
  changeDrafts(actor, id, opts, (st) => (refuseSplit(st, draftId), setReviewLabel(st, draftId, input)), { draft: draftId });
export const setEpic = (actor: Actor, id: string, input: unknown, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st) => changeEpic(st, input), { epic: true });

// ---- the Definition of Ready -----------------------------------------------------------------------

/** The person checks a draft against the Definition of Ready of the repository, by code: only `readiness` of the draft changes. */
export const checkReadyOf = (actor: Actor, id: string, draftId: string, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st, x) => (refuseSplit(st, draftId), checkReady(st, x.talk, draftId, x.list, x.at)), { draft: draftId });
/** The person accepts an item of the list anyway, with a reason. */
export const acceptAnywayOf = (actor: Actor, id: string, draftId: string, itemId: string, input: unknown, opts: TalkOptions = {}): Session =>
  changeDrafts(actor, id, opts, (st, x) => (refuseSplit(st, draftId), acceptAnyway(st, draftId, itemId, input, x.list, x.at)), { draft: draftId });
export const removeAcceptedOf = (actor: Actor, id: string, draftId: string, itemId: string, opts: TalkOptions = {}): Session => changeDrafts(actor, id, opts, (st, x) => (refuseSplit(st, draftId), removeAccepted(st, draftId, itemId, x.list)), { draft: draftId });

// ---- publishing ------------------------------------------------------------------------------------

/**
 * A story draft became a GitHub issue: remembers it, with the state and the log line, in one write. Runs while the session is marked as
 * being published. It does not ask whether the repository is still there: the issue exists. Undefined (nothing written) when the draft has
 * this issue already; `limit` (nothing written) when the log has no room for the line.
 */
export function recordPublished(actor: Actor, id: string, draftId: string, issue: { issue: number; url: string }, opts: TalkOptions = {}): Session {
  return change(
    actor,
    id,
    opts,
    false,
    (s, at) => {
      if (s.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be changed; restore it first");
      const d = s.drafts.find((x) => x.id === draftId);
      if (!d) throw new RefinementError("not-found", "no such story draft");
      // A split original is never published; its parts are.
      if (d.splitInto) throw new RefinementError("bad-state", "a split draft is not published; its parts are");
      if (d.published) {
        if (d.published.issue === issue.issue) return undefined;
        throw new RefinementError("bad-state", `${onGithub(d)} already; it is not recorded as #${issue.issue}`);
      }
      room(s, LOG_LIMIT - 1);
      const drafts = s.drafts.map((x) => (x === d ? { ...x, published: { issue: issue.issue, url: issue.url, at } } : x));
      const list = (opts.readyList ?? defaultReadyList)(s.owner, s.repo);
      const state = stateOf(s.state, s.drafts.length > 0, drafts, list);
      return { ...s, drafts, state, updated: at, log: [...s.log, { at, by: actor.id, what: "draft-published", detail: cut(`#${issue.issue} ${d.title?.text ?? ""}`.trim(), TITLE_MAX) }] };
    },
    true,
  );
}

/**
 * A read: the stored drafting/ready state is made right for the list as it is now (an admin may have changed the list). Writes
 * `state` only, no log line, and not `updated`. The lock is taken only when the state is wrong, and the state is worked out again
 * under it. Undefined when nothing changes.
 */
export function correctReadyState(id: string, opts: TalkOptions = {}): Session | undefined {
  const wrong = (s: Session): SessionState | undefined => {
    if (s.state !== "drafting" && s.state !== "ready") return undefined;
    const list = (opts.readyList ?? defaultReadyList)(s.owner, s.repo);
    if (!list) return undefined;
    const state = stateOf(s.state, s.drafts.length > 0, s.drafts, list);
    return state === s.state ? undefined : state;
  };
  const seen = getSession(id, opts);
  if (!seen || wrong(seen) === undefined) return undefined;
  return changeById(id, opts, (cur) => {
    const state = wrong(cur);
    return state === undefined ? undefined : { ...cur, state };
  });
}
