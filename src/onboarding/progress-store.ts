import { join } from "node:path";
import { z } from "zod";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { getUser } from "../auth/users.js";

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
    public code: "bad" | "too-large" | "gone",
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
  if (keys.some((k) => !KEY_RE.test(k))) return { code: "bad", message: "an answers key must be 1 to 40 characters: a lowercase letter, then lowercase letters, digits or hyphens" };
  // a value sits one level below the object, so the object itself is level 1
  if (!jsonWithin(answers, MAX_ANSWER_DEPTH)) return { code: "bad", message: `answers must be JSON nested at most ${MAX_ANSWER_DEPTH} levels deep` };
  if (Buffer.byteLength(JSON.stringify(answers)) > MAX_ANSWERS_BYTES) return { code: "too-large", message: `answers may be at most ${MAX_ANSWERS_BYTES} bytes` };
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
    const entry = { step: checked.step as string, answers: checked.answers, at: now.toISOString() };
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
  const file = read();
  if (!(userId in file.users)) return false;
  const users = { ...file.users };
  delete users[userId];
  save({ ...file, users });
  return true;
}
