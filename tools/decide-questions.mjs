#!/usr/bin/env node
// Splits a question comment into the questions the Foundry can decide itself (a technical question that has a
// recommendation) and the ones it must ask. The library functions read no environment. The question functions are pure; the
// record functions (decideRound, commitPending, abandonPending) read and write `decided.json` in a run folder.
// `post-plan <run-dir>` (postPlan, main, at the end) is the only part that reads the environment or calls gh.
// Pass only the question text, not the whole comment: a recommendation runs to the next question or the end.
// When the input is odd in any way, nothing is decided and every question is asked.
// DECIDED_HEADING mirrors the one in src/next-step.ts and ui/run-tabs.js (tests keep them equal).

import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

export const DECIDED_HEADING = "**Decided by the Foundry**";
// LIMITS is mirrored in src/engine/questions.ts (a test keeps them equal).
export const LIMITS = Object.freeze({ decided: 20, title: 300, text: 4000, decision: 1000, rounds: 500, bytes: 1048576 });
export const RECORD_FILE = "decided.json";
export const PENDING_FILE = "decided-pending.json";

const HEAD = /^\*\*Q(\d+)\.(.*)$/;
const KIND_MARK = /\*\*\s*kind\s*(?::\s*\*\*|\*\*\s*:?)/gi;
const REC_MARK = /\*\*\s*recommendation\s*(?::\s*\*\*|\*\*\s*:?)/gi;
const KINDS = ["technical", "product", "policy", "owner_action"];

/** The input with LF line ends and without `QUESTIONS: ` lines. */
function normalise(body) {
  return String(body ?? "").replace(/\r\n?/g, "\n").split("\n").filter((l) => !l.startsWith("QUESTIONS: ")).join("\n");
}

/** The numbers of the questions, counted the way countQuestions in src/next-step.ts counts them. */
function countOpen(body) {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.trim() === DECIDED_HEADING);
  const open = i < 0 ? body : lines.slice(0, i).join("\n");
  return new Set([...open.matchAll(/\*\*Q(\d+)\./g)].map((m) => m[1])).size;
}

/**
 * @typedef {"technical"|"product"|"policy"|"owner_action"} Kind
 * @typedef {{ n: number, title: string, text: string, kind: Kind, recommendation?: string, dup: boolean }} Question
 * @param {string} body
 * @returns {{ input: string, preamble: string, questions: Question[], rest: string, ambiguous?: string }}
 */
export function readQuestions(body) {
  const input = normalise(body);
  const all = input.split("\n");
  const cut = all.findIndex((l) => l.trim() === DECIDED_HEADING);
  const lines = cut < 0 ? all : all.slice(0, cut);
  const rest = cut < 0 ? "" : all.slice(cut + 1).join("\n");
  let ambiguous;
  const flag = (why) => { ambiguous ??= why; };

  const blocks = [];
  const pre = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    const t = line.trimStart();
    const m = HEAD.exec(t);
    if (m) {
      const dup = seen.has(m[1].replace(/^0+(?=\d)/, ""));
      seen.add(m[1].replace(/^0+(?=\d)/, ""));
      if (dup) flag(`line ${i + 1} repeats a question number`);
      blocks.push({ n: Number(m[1]), head: m[2], lines: [line], dup });
      return;
    }
    if (t.startsWith("**Q")) flag(`line ${i + 1} starts with **Q but is not a question heading`);
    else if (/\*\*Q\d+\./.test(line)) flag(`line ${i + 1} holds a question heading in the middle of the line`);
    (blocks.length ? blocks.at(-1).lines : pre).push(line);
  });

  const questions = blocks.map((b) => {
    const text = b.lines.join("\n").trim();
    const afterHead = b.lines.slice(1).join("\n");
    const kinds = [...afterHead.matchAll(KIND_MARK)];
    const recs = [...afterHead.matchAll(REC_MARK)];
    if (kinds.length > 1) flag(`question ${b.n} has more than one Kind`);
    if (recs.length > 1) flag(`question ${b.n} has more than one Recommendation`);
    if (kinds[0] && recs[0] && kinds[0].index > recs[0].index) flag(`question ${b.n} has a Kind after its Recommendation`);
    let kind = "product";
    if (kinds[0]) {
      const value = afterHead.slice(kinds[0].index + kinds[0][0].length).split("\n")[0]
        .toLowerCase().replace(/[`*]/g, "").trim().replace(/\.$/, "").replace(/[\s_-]+/g, "_");
      if (KINDS.includes(value)) kind = value;
    }
    let recommendation;
    if (recs[0]) {
      const r = afterHead.slice(recs[0].index + recs[0][0].length).trim();
      // `none` alone, or with Markdown marks and an explanation after it, means the owner must choose.
      const head = r.split("\n")[0].replace(/[`*]/g, "").trim();
      if (r && !/^none(?=$|[\s.:;,(—–-])/i.test(head)) recommendation = r;
    }
    const title = b.head.replace(/\*\*/g, "").trim();
    return { n: b.n, title, text, kind, ...(recommendation ? { recommendation } : {}), dup: b.dup };
  });

  return { input, preamble: pre.join("\n").trim(), questions, rest: rest.trim(), ...(ambiguous ? { ambiguous } : {}) };
}

/**
 * @param {string} body
 * @returns {{ body: string, decided: { n: number, title: string, text: string, decision: string }[], left: number }}
 */
export function decideQuestions(body) {
  const r = readQuestions(body);
  const unchanged = () => ({ body: r.input, decided: [], left: countOpen(r.input) });
  if (r.ambiguous) return unchanged();

  const decided = [];
  const asked = [];
  for (const q of r.questions) {
    const ok = q.kind === "technical" && q.recommendation && !q.dup && decided.length < LIMITS.decided
      && q.title.length <= LIMITS.title && q.text.length <= LIMITS.text && q.recommendation.length <= LIMITS.decision;
    if (ok) decided.push({ n: q.n, title: q.title, text: q.text, decision: q.recommendation });
    else asked.push(q);
  }
  if (!decided.length) return unchanged();

  const quote = (t) => t.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
  const out = [
    r.preamble,
    ...asked.map((q) => q.text),
    DECIDED_HEADING,
    r.rest,
    ...decided.map((d) => `${quote(d.text)}\n\n**Decision:** ${d.decision}`),
  ].filter(Boolean).join("\n\n");
  return { body: out, decided, left: countOpen(out) };
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const ID_RE = /^[0-9a-f]{16}$/;
const SOURCES = ["planner", "epic"];
const OUTCOMES = ["went_on", "asked", "gave_up"];

/** A title as the loop guard compares it: case, accents and punctuation do not matter. */
export function normaliseTitle(t) {
  return String(t ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The ID of a round: a hash of the issue, source, outcome and the questions as given. */
export function roundId(issue, source, outcome, questions) {
  const body = JSON.stringify([issue, source, outcome, questions.map((q) => [q.n, q.title, q.text, q.decision])]);
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function questionsProblem(qs, where) {
  if (!Array.isArray(qs)) return `${where}: questions is not a list`;
  if (qs.length > LIMITS.decided) return `${where}: more than ${LIMITS.decided} questions`;
  for (const [i, q] of qs.entries()) {
    const w = `${where}, question ${i + 1}`;
    if (!q || typeof q !== "object") return `${w}: it is not an object`;
    if (!Number.isSafeInteger(q.n) || q.n < 0) return `${w}: n is not a whole number`;
    if (typeof q.title !== "string" || q.title.length > LIMITS.title) return `${w}: the title is not a string of up to ${LIMITS.title} characters`;
    if (CONTROL.test(q.title)) return `${w}: the title has control characters`;
    if (typeof q.text !== "string" || q.text.length > LIMITS.text) return `${w}: the text is not a string of up to ${LIMITS.text} characters`;
    if (typeof q.decision !== "string" || q.decision.length > LIMITS.decision) return `${w}: the decision is not a string of up to ${LIMITS.decision} characters`;
  }
  return undefined;
}

/** The first problem of a round, as the input of decideRound (`stored` false) or as it sits in the record (`stored` true). */
function roundProblem(r, where, stored) {
  if (!r || typeof r !== "object") return `${where}: it is not an object`;
  if (!Number.isSafeInteger(r.issue) || r.issue <= 0) return `${where}: issue is not a whole number above 0`;
  if (!SOURCES.includes(r.source)) return `${where}: unknown source`;
  if (!OUTCOMES.includes(r.outcome)) return `${where}: unknown outcome`;
  if (r.input !== undefined && (typeof r.input !== "string" || !/^[0-9a-f]{64}$/.test(r.input))) return `${where}: input is not a SHA-256 digest`;
  const bad = questionsProblem(r.questions, where);
  if (bad) return bad;
  if (r.outcome === "went_on" && !r.questions.length) return `${where}: a round that went on has no questions`;
  if (stored) {
    if (r.outcome === "gave_up" && r.questions.length) return `${where}: a round that gave up must not hold questions`;
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) return `${where}: id is not 16 hex characters`;
    if (typeof r.at !== "string" || r.at.length > 40 || Number.isNaN(new Date(r.at).getTime())) return `${where}: at is not a time`;
  }
  return undefined;
}

function recordProblem(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "it is not an object";
  if (rec.version !== 1) return "version is not 1";
  if (!Array.isArray(rec.rounds)) return "rounds is not a list";
  if (rec.rounds.length > LIMITS.rounds) return `more than ${LIMITS.rounds} rounds`;
  for (const [i, r] of rec.rounds.entries()) {
    const bad = roundProblem(r, `round ${i + 1}`, true);
    if (bad) return bad;
  }
  return undefined;
}

/** The text of a plain file, null when missing; throws for a link, a non-file or a file over the byte limit. */
function readSmall(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`${path} cannot be read (${e?.code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a plain file`);
    if (st.size > LIMITS.bytes) throw new Error(`${path} is longer than ${LIMITS.bytes} bytes`);
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Writes a file through a temporary name that is random and created exclusively, so no link at a guessed name is followed. */
function writeAtomic(file, text) {
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const encode = (rec) => JSON.stringify(rec, null, 2);

/** The record of a run folder; `{ version: 1, rounds: [] }` when there is no file. Throws when the file is not valid. */
export function readRecord(runDir) {
  let text;
  try {
    text = readSmall(join(runDir, RECORD_FILE));
  } catch (e) {
    throw new Error(`${RECORD_FILE} is not valid: ${e.message}`);
  }
  if (text === null) return { version: 1, rounds: [] };
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    throw new Error(`${RECORD_FILE} is not valid: it is not JSON`);
  }
  const bad = recordProblem(rec);
  if (bad) throw new Error(`${RECORD_FILE} is not valid: ${bad}`);
  return rec;
}

/** The pending file, or undefined when there is none or it is not valid. */
function readPending(runDir) {
  try {
    const text = readSmall(join(runDir, PENDING_FILE));
    if (!text) return undefined;
    const p = JSON.parse(text);
    if (p?.version !== 1 || typeof p.id !== "string" || !p.round || p.round.id !== p.id) return undefined;
    return roundProblem(p.round, "pending", true) ? undefined : p;
  } catch {
    return undefined;
  }
}

function checkRoom(rec, round) {
  if (rec.rounds.length >= LIMITS.rounds) throw new Error(`decided: the record already holds ${LIMITS.rounds} rounds`);
  if (Buffer.byteLength(encode({ version: 1, rounds: [...rec.rounds, round] })) > LIMITS.bytes) throw new Error(`decided: the record would be longer than ${LIMITS.bytes} bytes`);
}

/**
 * Step one of the two-step commit: writes only the pending file (atomically) and returns the round ID. Post the comment,
 * then call commitPending(runDir, id). `round` = { issue, source, outcome, questions }. A round over a limit throws and
 * writes nothing. A `gave_up` round is stored without its questions (they are asked, not decided); its ID still covers them.
 * A retry of the same round keeps the same ID and `at`, also after the round was committed.
 */
export function decideRound(runDir, round, now = new Date()) {
  const bad = roundProblem(round, "round", false);
  if (bad) throw new Error(`decided: ${bad}`);
  const { issue, source, outcome, questions } = round;
  const id = roundId(issue, source, outcome, questions);
  const rec = readRecord(runDir);
  const done = rec.rounds.find((r) => r.id === id);
  const pending = readPending(runDir);
  const at = done?.at ?? (pending?.id === id ? pending.round.at : now.toISOString());
  const kept = outcome === "gave_up" ? [] : questions.map((q) => ({ n: q.n, title: q.title, text: q.text, decision: q.decision }));
  const stored = { id, issue, at, source, outcome, questions: kept, ...(round.input !== undefined ? { input: round.input } : {}) };
  if (!done) checkRoom(rec, stored);
  writeAtomic(join(runDir, PENDING_FILE), JSON.stringify({ version: 1, id, issue, round: stored }));
  return id;
}

/**
 * Step two: appends the pending round to the record, once. Returns true when it appended; false (and appends nothing) when
 * there is no pending file, its ID is not `id`, or the record already holds `id`. Throws on a write failure, a corrupt
 * record or a full record.
 */
export function commitPending(runDir, id) {
  const pending = readPending(runDir);
  if (!pending || pending.id !== id) return false;
  const rec = readRecord(runDir);
  const file = join(runDir, PENDING_FILE);
  if (rec.rounds.some((r) => r.id === id)) {
    rmSync(file, { force: true });
    return false;
  }
  checkRoom(rec, pending.round);
  writeAtomic(join(runDir, RECORD_FILE), encode({ version: 1, rounds: [...rec.rounds, pending.round] }));
  rmSync(file, { force: true });
  return true;
}

/** Removes a pending file that does not belong to the current body. Returns true when there was one. */
export function abandonPending(runDir) {
  const file = join(runDir, PENDING_FILE);
  try {
    lstatSync(file);
  } catch {
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

/**
 * The loop guard. `decided` is the result of decideQuestions. Returns "gave_up" when a decided title was decided in an
 * earlier round of this issue, or when a planner round that decides everything follows two planner rounds that went on
 * (an `asked` or `gave_up` round, from any source, starts the streak again). Otherwise "went_on" or "asked".
 */
export function checkRound(record, issue, source, decided) {
  const prior = (record?.rounds ?? []).filter((r) => r.issue === issue);
  const seen = new Set(prior.flatMap((r) => r.questions.map((q) => normaliseTitle(q.title))).filter(Boolean));
  const list = decided?.decided ?? [];
  if (list.some((d) => { const t = normaliseTitle(d.title); return t && seen.has(t); })) return "gave_up";
  const all = list.length > 0 && decided.left === 0;
  if (source === "planner" && all) {
    let streak = 0;
    for (const r of prior.reverse()) {
      if (r.outcome !== "went_on") break;
      if (r.source === "planner") streak++;
    }
    if (streak >= 2) return "gave_up";
  }
  return all ? "went_on" : "asked";
}

const WANT_OTHER = "Want a different answer? Reply `/overrule Q<n> <your answer>` on this issue.";
const GAVE_UP = "post-plan: the Foundry gave up deciding these questions itself (it decided the same question before, or went on twice in a row). The questions are in the plan step and on the issue; answer them on the issue.";
const CODES = { went_on: 3, asked: 0, gave_up: 4 };
const GH_TIMEOUT_MS = 60_000;

function defaultGh(env) {
  const timeout = Number(env.FACTORY_GH_TIMEOUT_MS) > 0 ? Number(env.FACTORY_GH_TIMEOUT_MS) : GH_TIMEOUT_MS;
  return (args, input) => execFileSync(env.FACTORY_GH_BIN || "gh", args, { env, encoding: "utf8", input, timeout, maxBuffer: 64 * 1024 * 1024, stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
}

/** The comment text. `outcome` undefined is the plain NEEDS_INFO comment, byte for byte what send_back posts. */
function planComment(env, outcome, shown, marker) {
  const all = outcome === "went_on";
  const first = all ? process.env.FACTORY_FIRST_DECIDED : process.env.FACTORY_FIRST_PLANNER_QUESTIONS;
  const head = all ? "decided these technical questions itself and plans the issue again:" : "needs more information before it can plan this issue:";
  const tail = all ? WANT_OTHER : (env.FACTORY_NEXT_PLANNER_QUESTIONS ?? "");
  const comment = [...(first ? [first, ""] : ["", ""]), `🤖 **Spaghetti Code Foundry** ${head}`, "", shown, "", `_${tail}_`, "", marker].join("\n") + "\n";
  return comment;
}

const lastLine = (body) => body.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
/** A fingerprint of the whole input (asked questions included): a retry must match all of it. */
const inputOf = (text) => createHash("sha256").update(text.replace(/\r\n?/g, "\n").trim()).digest("hex");

/**
 * Decides the technical questions of a planner text, posts one comment on the issue and records the round.
 * Returns { code, out }: 3 all decided, 0 questions remain or nothing decided, 4 gave up, 1 error, 2 bad arguments.
 */
export function postPlan(runDir, text, env = process.env, gh = defaultGh(env)) {
  const issue = env.FACTORY_VAR_ISSUE ?? "";
  const repo = env.FACTORY_VAR_GITHUB_REPO ?? "";
  const run = env.FACTORY_RUN_ID ?? "";
  let problem;
  if (!/^[1-9]\d*$/.test(issue)) problem = "FACTORY_VAR_ISSUE is not an issue number";
  else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) problem = "FACTORY_VAR_GITHUB_REPO is not owner/repo";
  else if (!/^[\w-]+$/.test(run)) problem = "FACTORY_RUN_ID is not a run ID";
  else {
    try {
      if (!statSync(runDir).isDirectory()) problem = "the run folder is not a folder";
    } catch {
      problem = "the run folder does not exist";
    }
  }
  if (problem) return { code: 2, out: `post-plan: ${problem}\n` };

  try {
    const n = Number(issue);
    const body = text.replace(/\n+$/, "");
    const post = (comment) => gh(["issue", "comment", issue, "--repo", repo, "--body-file", "-"], comment);
    const d = decideQuestions(text);
    if (env.FACTORY_DECIDE_TECHNICAL !== "1" || !d.decided.length) {
      abandonPending(runDir);
      post(planComment(env, undefined, body, `<!-- claude-factory run=${run} -->`));
      return { code: 0, out: text };
    }
    const rec = readRecord(runDir);
    const pend = readPending(runDir);
    let view;
    try {
      view = JSON.parse(gh(["issue", "view", issue, "--repo", repo, "--json", "comments,labels"]));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    if (!Array.isArray(view?.comments)) throw new Error("the comments of the issue could not be read");
    const markerFor = (id) => `<!-- claude-factory run=${run} decided=${id} -->`;
    const result = (o) => (o === "gave_up" ? { code: 4, out: GAVE_UP + "\n\n" + body + "\n" } : { code: CODES[o], out: d.body + "\n" });

    // A retry: the latest committed round of this issue, or the pending round, holds this exact input and a comment of
    // ours carries its marker. Only the marker is compared, so edited comments and changed formatting do not post again.
    // A fresh planner round (FACTORY_NEW_ROUND=1, set by send_back when the plan ran after the last send_back) is never a
    // retry, even when the planner repeats the same questions: it goes through checkRound's title check.
    const input = inputOf(text);
    const kept = env.FACTORY_NEW_ROUND === "1" ? [] : [rec.rounds.filter((r) => r.issue === n).at(-1), pend?.round?.issue === n ? pend.round : undefined];
    for (const r of kept) {
      if (r?.input !== input || r.id !== roundId(n, "planner", r.outcome, d.decided)) continue;
      const found = view.comments.some((x) => x?.viewerDidAuthor === true && typeof x.body === "string" && lastLine(x.body) === markerFor(r.id));
      if (found) {
        commitPending(runDir, r.id);
        return result(r.outcome);
      }
    }

    const outcome = checkRound(rec, n, "planner", d);
    const id = decideRound(runDir, { issue: n, source: "planner", outcome, questions: d.decided, input });
    const comment = planComment(env, outcome, outcome === "gave_up" ? body : d.body, markerFor(id));
    post(comment);
    commitPending(runDir, id);
    if (!readRecord(runDir).rounds.some((r) => r.id === id)) throw new Error("the round was not recorded");
    return result(outcome);
  } catch (e) {
    return { code: 1, out: `post-plan: ${e?.message ?? e}\n` };
  }
}

function writeAll(fd, s) {
  const buf = Buffer.from(s);
  let at = 0;
  while (at < buf.length) {
    try {
      at += writeSync(fd, buf, at);
    } catch (e) {
      if (e?.code !== "EAGAIN") throw e;
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const r = args.length === 2 && args[0] === "post-plan"
    ? postPlan(args[1], readFileSync(0, "utf8"))
    : { code: 2, out: "usage: decide-questions.mjs post-plan <run-dir>\n" };
  writeAll(r.code === 0 || r.code === 3 || r.code === 4 ? 1 : 2, r.out);
  process.exit(r.code);
}

let isMain = false;
try {
  isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}
if (isMain) main();
