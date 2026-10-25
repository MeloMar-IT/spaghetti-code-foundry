import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../credentials/redact.js";

/** A run may hold this file: the question rounds the Foundry decided (written by tools/decide-questions.mjs). */
export const DECIDED_FILE = "decided.json";
/** Mirrors LIMITS in tools/decide-questions.mjs (a test keeps them equal). */
export const LIMITS = Object.freeze({ decided: 20, title: 300, text: 4000, decision: 1000, rounds: 500, bytes: 1048576 });

export interface DecidedQuestion { n: number; title: string; text: string; decision: string }
export interface DecidedRound {
  id: string;
  issue: number;
  at: string;
  source: "planner" | "epic";
  outcome: "went_on" | "asked" | "gave_up";
  questions: DecidedQuestion[];
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ID_RE = /^[0-9a-f]{16}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The first problem of the record, or undefined. Messages name a position, never a value. */
function problem(value: unknown): string | undefined {
  if (!isObj(value)) return "it is not an object";
  if (value.version !== 1) return "version is not 1";
  if (!Array.isArray(value.rounds)) return "rounds is not a list";
  if (value.rounds.length > LIMITS.rounds) return `more than ${LIMITS.rounds} rounds`;
  for (const [i, r] of value.rounds.entries()) {
    const where = `round ${i + 1}`;
    if (!isObj(r)) return `${where}: it is not an object`;
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) return `${where}: id is not 16 hex characters`;
    if (typeof r.issue !== "number" || !Number.isSafeInteger(r.issue) || r.issue <= 0) return `${where}: issue is not a whole number above 0`;
    if (typeof r.at !== "string" || r.at.length > 40 || Number.isNaN(new Date(r.at).getTime())) return `${where}: at is not a time`;
    if (r.source !== "planner" && r.source !== "epic") return `${where}: unknown source`;
    if (r.outcome !== "went_on" && r.outcome !== "asked" && r.outcome !== "gave_up") return `${where}: unknown outcome`;
    if (!Array.isArray(r.questions)) return `${where}: questions is not a list`;
    if (r.questions.length > LIMITS.decided) return `${where}: more than ${LIMITS.decided} questions`;
    if (r.outcome === "went_on" && !r.questions.length) return `${where}: a round that went on has no questions`;
    if (r.outcome === "gave_up" && r.questions.length) return `${where}: a round that gave up has questions`;
    for (const [j, q] of r.questions.entries()) {
      const w = `${where}, question ${j + 1}`;
      if (!isObj(q)) return `${w}: it is not an object`;
      if (typeof q.n !== "number" || !Number.isSafeInteger(q.n) || q.n < 0) return `${w}: n is not a whole number`;
      if (typeof q.title !== "string" || q.title.length > LIMITS.title) return `${w}: the title is not a string of up to ${LIMITS.title} characters`;
      if (CONTROL_RE.test(q.title)) return `${w}: the title has control characters`;
      if (typeof q.text !== "string" || q.text.length > LIMITS.text) return `${w}: the text is not a string of up to ${LIMITS.text} characters`;
      if (typeof q.decision !== "string" || q.decision.length > LIMITS.decision) return `${w}: the decision is not a string of up to ${LIMITS.decision} characters`;
    }
  }
  return undefined;
}

/** The file's text: undefined when missing, "" never for a link or non-file (undefined), null when over the byte limit. */
function readBounded(path: string): string | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size > LIMITS.bytes) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The rounds the Foundry decided (redacted), or undefined when there is no file or it is not valid (one log line says why). */
export function readDecidedQuestions(runDir: string, log?: (line: string) => void): DecidedRound[] | undefined {
  const text = readBounded(join(runDir, DECIDED_FILE));
  if (text === undefined) return undefined;
  if (text === null) {
    log?.(`  decided.json ignored: it is longer than ${LIMITS.bytes / 1024} KB`);
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    log?.("  decided.json ignored: it is not valid JSON");
    return undefined;
  }
  const bad = problem(value);
  if (bad) {
    log?.(`  decided.json ignored: ${bad}`);
    return undefined;
  }
  return (value as { rounds: DecidedRound[] }).rounds.map((r) => ({
    id: r.id,
    issue: r.issue,
    at: r.at,
    source: r.source,
    outcome: r.outcome,
    questions: r.questions.map((q) => ({ n: q.n, title: redactText(q.title), text: redactText(q.text), decision: redactText(q.decision) })),
  }));
}
