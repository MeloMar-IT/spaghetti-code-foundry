#!/usr/bin/env node
// Splits a question comment into the questions the Foundry can decide itself (a technical question that has a
// recommendation) and the ones it must ask. Library only: pure functions, no I/O, no environment.
// Pass only the question text, not the whole comment: a recommendation runs to the next question or the end.
// When the input is odd in any way, nothing is decided and every question is asked.
// DECIDED_HEADING mirrors the one in src/next-step.ts and ui/run-tabs.js (tests keep them equal).

export const DECIDED_HEADING = "**Decided by the Foundry**";
export const LIMITS = Object.freeze({ decided: 20, title: 300, text: 4000, decision: 1000 });

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
