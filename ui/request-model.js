import { forbiddenIn, mapTerms } from "./simple-words.js";

// "Your request" as plain data: what the plan took from the request (asked) and what it chose itself (assumed). No DOM here.

export const REQUEST = {
  title: "Your request",
  asked: "You asked",
  assumed: "Assumed",
  change: "Change this",
  what: "What is right instead?",
  send: "Send correction",
  cancel: "Cancel",
  sending: "Sending…",
  sent: "Thank you. The plan is made again with your correction.",
  needsWords: "Write what is right instead first.",
  changed: "The plan changed meanwhile. Look at it again.",
  failed: "That did not work. Try again.",
  lookupFailed: "It could not be checked whether you can change this.",
  again: "Check again",
  stale: "The plan changed while you wrote. Your words are kept; look at the plan and change this again.",
  notWaiting: "Assumptions can be changed here only while the plan waits for a decision.",
  notYours: "Only someone who may decide this plan can change an assumption here.",
};

const MAX_POINTS = 100;
const MAX_TEXT = 500;

/** The well-formed points of `run.planPoints`: { kind, text, raw }, `text` and `raw` the trimmed text. */
export function planPoints(run) {
  const list = run?.planPoints;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object" || (p.kind !== "asked" && p.kind !== "assumed") || typeof p.text !== "string") continue;
    const raw = p.text.trim();
    if (!raw) continue;
    out.push({ kind: p.kind, text: raw, raw });
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

/**
 * The points for the Simple view. A point is never dropped, cut or rewritten by markup stripping: the words of a point are shown as
 * written (identifiers, colour values, links), with only the Foundry word swaps applied, and only when no forbidden term is left
 * and no link is in the text. Otherwise the text is shown as it was written, so the person reads all of it before correcting it.
 */
export function plainPoints(points) {
  return points.map((p) => {
    const mapped = mapTerms(p.raw);
    const plain = forbiddenIn(mapped).length === 0 && !/https?:\/\//i.test(p.raw) ? mapped : p.raw;
    return { ...p, text: plain };
  });
}

export const hasAssumed = (points) => points.some((p) => p.kind === "assumed");

const clean = (t) => String(t ?? "").replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim();

/** The text of a correction, or "" when no words were written. One line; no comment markers, so the server does not refuse it. */
export function correctionText(assumed, words) {
  const w = clean(words);
  if (!w) return "";
  return `Assumed: ${clean(assumed).slice(0, MAX_TEXT)} — Correction: ${w}`;
}

/** The item of `GET /api/your-turn/mine` through which the plan of run `runId` can be rejected with words; else null. */
export function turnItemFor(items, runId) {
  if (!Array.isArray(items)) return null;
  return items.find((i) => i && typeof i.key === "string" && i.key && i.runId === runId && i.kind === "approve_plan"
    && Array.isArray(i.acts) && i.acts.includes("reject")) ?? null;
}
