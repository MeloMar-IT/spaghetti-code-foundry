import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { getUser } from "../auth/users.js";
import { STARTER_ID_RE } from "../config.js";

// Where each account is in the "Get started" guide, and the answers so far. One file, keyed by account id.
// The file is in the data folder itself (not in onboarding/): writeJsonFile only writes next to auth.lock.

export const GUIDE_STEPS = ["welcome", "computer", "agents", "step-3", "step-4", "step-5", "step-6", "step-7"] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];

export const MAX_ANSWER_KEYS = 20;
export const MAX_ANSWERS_BYTES = 16_384;
export const MAX_ANSWER_DEPTH = 8;

export const progressPath = () => join(dataHome(), "onboarding-progress.json");

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type Answers = Record<string, JsonValue>;

export interface GuideProgress {
  step: string;
  answers: Answers;
  at: string;
}

/** `bad`: 400. `too-large`: 413. `gone`: the account no longer exists (404). Messages name a field, never a value. */
export class ProgressError extends Error {
  constructor(
    public code: "bad" | "too-large" | "gone" | "stale",
    message: string,
  ) {
    super(message);
    this.name = "ProgressError";
  }
}

const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;
const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));

/** True when `x` is JSON data nested at most `max` levels deep. Stops at the limit, so a deep value never exhausts the stack. */
function jsonWithin(x: unknown, max: number): boolean {
  if (x === null || typeof x === "string" || typeof x === "boolean") return true;
  if (typeof x === "number") return Number.isFinite(x);
  if (max <= 0) return false;
  if (Array.isArray(x)) return x.every((v) => jsonWithin(v, max - 1));
  if (isPlain(x)) return Object.values(x).every((v) => jsonWithin(v, max - 1));
  return false;
}

/** What is wrong with a set of answers, or null. Checks in an order that never serializes a deep or non-JSON value. */
export function answersProblem(answers: unknown): { code: "bad" | "too-large"; message: string } | null {
  if (!isPlain(answers)) return { code: "bad", message: "answers must be an object" };
  const keys = Object.keys(answers);
  if (keys.length > MAX_ANSWER_KEYS) return { code: "bad", message: `answers may have at most ${MAX_ANSWER_KEYS} keys` };
  if (keys.some((k) => !(KEY_RE.test(k) || k === "repoId"))) return { code: "bad", message: "an answers key must be 1 to 40 characters: a lowercase letter, then lowercase letters, digits or hyphens (or repoId)" };
  // a value sits one level below the object, so the object itself is level 1
  if (!jsonWithin(answers, MAX_ANSWER_DEPTH)) return { code: "bad", message: `answers must be JSON nested at most ${MAX_ANSWER_DEPTH} levels deep` };
  if (Buffer.byteLength(JSON.stringify(answers)) > MAX_ANSWERS_BYTES) return { code: "too-large", message: `answers may be at most ${MAX_ANSWERS_BYTES} bytes` };
  return null;
}

/** The longest texts of the guide's answers. The UI has the same numbers (`GUIDE_LIMITS`). */
export const GUIDE_TEXT_LIMITS = { who: 200, what: 2000, style: 200, name: 100 } as const;
/**
 * Answers only the server sets: the made project (`repoId`), the token of a project being made (`making`) and the id of the
 * repository record being written (`creating`), so a restart can undo it. A PUT cannot change them.
 */
export const SERVER_KEYS = ["repoId", "making", "creating", "session"] as const;

// Bumped on every Start again (clearProgress, deleteUser). A guide request takes the number when it arrives; one that runs after
// a reset sees a different number and makes nothing. In memory: a restart drops the queued requests with it.
const generations = new Map<string, number>();
/** The current guide generation of an account (see generations). */
export const guideGeneration = (userId: string): number => generations.get(userId) ?? 0;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What is wrong with the guide's own answers (only the keys that are present), or null. Names the field, never the value. */
export function guideAnswersProblem(answers: Answers): string | null {
  const text = (v: unknown, field: string, max: number, multiline = false): string | null => {
    if (typeof v !== "string") return `${field} must be text`;
    if (v.length > max) return `${field} may be at most ${max} characters`;
    const rest = multiline ? v.replace(/[\n\r\t]/g, "") : v;
    if (CONTROL.test(rest)) return `${field} has a control character`;
    return null;
  };
  if ("starter" in answers && !(typeof answers.starter === "string" && STARTER_ID_RE.test(answers.starter))) return "starter is not a starter id";
  if ("about" in answers) {
    const about = answers.about;
    if (!isPlain(about)) return "about must be an object";
    for (const k of Object.keys(about)) if (k !== "who" && k !== "what") return "about may have only who and what";
    if ("who" in about) {
      const p = text(about.who, "who", GUIDE_TEXT_LIMITS.who);
      if (p) return p;
    }
    if ("what" in about) {
      const p = text(about.what, "what", GUIDE_TEXT_LIMITS.what, true);
      if (p) return p;
    }
  }
  if ("name" in answers) {
    const p = text(answers.name, "name", GUIDE_TEXT_LIMITS.name);
    if (p) return p;
  }
  if ("style" in answers) {
    const p = text(answers.style, "style", GUIDE_TEXT_LIMITS.style);
    if (p) return p;
  }
  if ("where" in answers && answers.where !== "local" && answers.where !== "github") return "where must be local or github";
  for (const k of SERVER_KEYS) if (k in answers && !(typeof answers[k] === "string" && UUID_RE.test(answers[k]))) return `${k} must be an id`;
  if ("build" in answers && typeof answers.build !== "boolean") return "build must be true or false";
  if ("plan" in answers && answers.plan !== "built") return "plan must be built";
  return null;
}

/** Checks a PUT body: only `step` (one of GUIDE_STEPS) and an optional `answers` object (default `{}`). Throws ProgressError. */
export function parseProgressRequest(body: unknown): { step: GuideStep; answers: Answers } {
  if (!isPlain(body)) throw new ProgressError("bad", "the body must be an object");
  for (const k of Object.keys(body)) if (k !== "step" && k !== "answers") throw new ProgressError("bad", `unknown field: ${k.slice(0, 40)}`);
  const step = body.step;
  if (typeof step !== "string" || !(GUIDE_STEPS as readonly string[]).includes(step)) throw new ProgressError("bad", `step must be one of: ${GUIDE_STEPS.join(", ")}`);
  const answers = body.answers === undefined ? {} : body.answers;
  const problem = answersProblem(answers);
  if (problem) throw new ProgressError(problem.code, problem.message);
  const own = guideAnswersProblem(answers as Answers);
  if (own) throw new ProgressError("bad", own);
  return { step: step as GuideStep, answers: answers as Answers };
}

// The stored form: the step only has to look like an id (a later part may rename one), and the answers keep the same limits as a request.
const Entry = z
  .object({
    step: z.string().regex(/^[a-z0-9-]{1,40}$/),
    answers: z.record(z.string(), z.unknown()).superRefine((a, ctx) => {
      if (answersProblem(a)) ctx.addIssue({ code: "custom", message: "answers out of bounds" });
    }),
    at: z.iso.datetime(),
  })
  .strict();
const FileSchema = z.object({ version: z.literal(1), users: z.record(z.uuid(), Entry) }).strict();
type ProgressFile = z.infer<typeof FileSchema>;

const EMPTY: ProgressFile = { version: 1, users: {} };
const read = (): ProgressFile => readJsonFile(progressPath(), FileSchema, EMPTY);
const save = (file: ProgressFile) => writeJsonFile(progressPath(), file);

/** The saved place of an account, or null. Throws StoreError when the file cannot be used. */
export function readProgress(userId: string): GuideProgress | null {
  const e = read().users[userId];
  return e ? ({ step: e.step, answers: e.answers as Answers, at: e.at }) : null;
}

/** Saves the place of an account (replaces its entry). The account must exist when the lock is held: a late save never brings back a deleted account's entry. */
export function saveProgress(userId: string, p: { step: GuideStep; answers: Answers }, now = new Date()): GuideProgress {
  const checked = parseProgressRequest(p); // a caller's types are not trusted
  return withAuthLock(() => {
    if (!getUser(userId)) throw new ProgressError("gone", "no such account");
    const file = read();
    // the server's own answers stay as stored: a late or forged PUT can neither add nor remove them
    const answers: Answers = { ...checked.answers };
    for (const k of SERVER_KEYS) delete answers[k];
    const stored = file.users[userId]?.answers ?? {};
    for (const k of SERVER_KEYS) if (k in stored) answers[k] = stored[k] as JsonValue;
    const problem = answersProblem(answers);
    if (problem) throw new ProgressError(problem.code, problem.message);
    const entry = { step: checked.step as string, answers, at: now.toISOString() };
    save({ ...file, users: { ...file.users, [userId]: entry } });
    return entry;
  });
}

/** Clears the place of an account. Returns true when there was one; writes nothing otherwise. */
export function clearProgress(userId: string): boolean {
  return withAuthLock(() => removeProgressLocked(userId));
}

/** Removes the entry of an account (only inside withAuthLock). Returns true when there was one; writes nothing otherwise. */
export function removeProgressLocked(userId: string): boolean {
  if (!authLockHeld()) throw new Error("removeProgressLocked must run inside withAuthLock");
  generations.set(userId, guideGeneration(userId) + 1);
  const file = read();
  if (!(userId in file.users)) return false;
  const users = { ...file.users };
  delete users[userId];
  save({ ...file, users });
  return true;
}

/**
 * Starts making a guide project for an account. Under the lock: when the entry holds a `repoId` whose repository still exists
 * (`exists`), that id is returned and nothing is written; otherwise a new `making` token is stored (and a dead `repoId` dropped)
 * after the merged answers pass the same limits as a PUT. Nothing is made before this succeeded.
 */
export function beginGuideProject(userId: string, exists: (repoId: string) => boolean, now = new Date()): { existing: string } | { token: string } {
  return withAuthLock(() => {
    if (!getUser(userId)) throw new ProgressError("gone", "no such account");
    const file = read();
    const entry = file.users[userId];
    const old = entry?.answers.repoId;
    if (typeof old === "string" && exists(old)) return { existing: old };
    const answers: Answers = { ...((entry?.answers ?? {}) as Answers) };
    delete answers.repoId;
    delete answers.session; // a new project gets a new plan
    delete answers.creating; // the caller has undone an interrupted record first; with no repository left there is nothing to undo
    const token = randomUUID();
    answers.making = token;
    const problem = answersProblem(answers);
    if (problem) throw new ProgressError(problem.code, problem.message);
    save({ ...file, users: { ...file.users, [userId]: { step: entry?.step ?? "step-5", answers, at: now.toISOString() } } });
    return { token };
  });
}

/**
 * Records, inside the lock that writes the repository record (addRepo's beforeSave), the id of the record being written. Only with
 * the current token: otherwise `stale` and nothing is written. After a restart a `creating` id whose record exists is undone
 * before the next make (see recordGuideProject, which clears it once the project is complete).
 */
export function recordCreatingLocked(userId: string, token: string, repoId: string, now = new Date()): void {
  if (!authLockHeld()) throw new Error("recordCreatingLocked must run inside withAuthLock");
  const file = read();
  const entry = file.users[userId];
  if (!entry || entry.answers.making !== token) throw new ProgressError("stale", "the guide was started again");
  const answers: Answers = { ...(entry.answers as Answers), creating: repoId };
  const problem = answersProblem(answers);
  if (problem) throw new ProgressError(problem.code, problem.message);
  save({ ...file, users: { ...file.users, [userId]: { step: entry.step, answers, at: now.toISOString() } } });
}

/**
 * Records the made project: sets `repoId` and removes `making`, only when `making` still equals `token`. After Start again (or
 * another begin) it throws `stale` and writes nothing. Called once the project is complete, so `repoId` never names a half-made one.
 */
export function recordGuideProject(userId: string, token: string, repoId: string, now = new Date()): void {
  withAuthLock(() => {
    const file = read();
    const entry = file.users[userId];
    if (!entry || entry.answers.making !== token) throw new ProgressError("stale", "the guide was started again");
    const answers: Answers = { ...(entry.answers as Answers), repoId };
    delete answers.making;
    delete answers.creating;
    const problem = answersProblem(answers);
    if (problem) throw new ProgressError(problem.code, problem.message);
    save({ ...file, users: { ...file.users, [userId]: { step: entry.step, answers, at: now.toISOString() } } });
  });
}

/**
 * Records the id of the guide's refinement session as the answer `session`, under the lock. Only while the entry still names
 * `repoId` as its project: otherwise `stale` (the guide was started again) and nothing is written. `gone`: no such account.
 */
export function recordGuideSession(userId: string, repoId: string, sessionId: string, now = new Date()): void {
  withAuthLock(() => {
    if (!getUser(userId)) throw new ProgressError("gone", "no such account");
    const file = read();
    const entry = file.users[userId];
    if (!entry || entry.answers.repoId !== repoId) throw new ProgressError("stale", "the guide was started again");
    const answers: Answers = { ...(entry.answers as Answers), session: sessionId };
    const problem = answersProblem(answers);
    if (problem) throw new ProgressError(problem.code, problem.message);
    save({ ...file, users: { ...file.users, [userId]: { step: entry.step, answers, at: now.toISOString() } } });
  });
}

const oneLine = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/**
 * The idea text and title of the guide's session, built from the saved answers. It is data for the architect, never part of a command.
 * The title is the project name (or "My project"), at most 120 characters.
 */
export function guideIdea(answers: Answers, starterTitle?: string): { title: string; idea: string } {
  const name = oneLine(answers.name);
  const about = isPlain(answers.about) ? answers.about : {};
  const who = oneLine(about.who);
  const what = typeof about.what === "string" ? about.what.replace(/\r\n/g, "\n").trim() : "";
  const style = oneLine(answers.style);
  const kind = oneLine(starterTitle) || "project";
  const lines = [`Make the first version of "${name || "My project"}", a new ${kind} made from a starter.`];
  if (who) lines.push(`Who it is for: ${who}`);
  lines.push("What it should do:", what);
  if (style) lines.push(`Colours or style: ${style}`);
  return { title: (name || "My project").slice(0, 120), idea: lines.join("\n") };
}
