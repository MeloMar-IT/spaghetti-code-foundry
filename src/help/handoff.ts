import { z } from "zod";
import { subjectPage } from "./actions.js";
import type { HelpRole, Reply } from "./contract.js";

/**
 * The hand-offs of Ask SCF: taking one answer to a page that already does that work (run details, Problems, Your
 * turn) or to a new Refinement session filled with the answer or one of its drafts. Pure data and pure functions.
 * The offers are built from a stored reply plus facts the server checked again for the account; text from a model is
 * never an address. The server builds every `page`, with ids encoded.
 */

export const HANDOFF_WHERE = ["run", "problems", "your-turn", "refinement", "issue-draft"] as const;
export type HandoffWhere = (typeof HANDOFF_WHERE)[number];
/** Equals IDEA_MAX of src/refinement/store.ts (a test keeps them equal). */
export const HANDOFF_TEXT_MAX = 10_000;
/** Equals TITLE_MAX of src/refinement/store.ts, which `checkTitle` enforces for idea sessions. */
export const HANDOFF_TITLE_MAX = 120;
export const HANDOFF_KEEP = 50;
export const COPIED = ["title", "text", "repository", "link"] as const;
const QUESTION_CUT = 2000;
const FALLBACK_TITLE = "Ask SCF answer";

export interface HandoffFill {
  title: string;
  text: string;
  repo?: string;
  fromHelp: string;
}
export interface HandoffOffer {
  key: string;
  where: HandoffWhere;
  title: string;
  page: string;
  fill?: HandoffFill;
}
export interface HandoffInput {
  role: HelpRole;
  /** The id of the conversation: goes to `fill.fromHelp`, never into the text. */
  conversation: string;
  /** The text of the question this reply answers. */
  question: string;
  reply: Reply;
  /** Re-checked by the server now. */
  found: { run?: string; problem?: string };
  /** Lines "- <title> · <route>", already re-checked for the account. */
  evidence: readonly string[];
  /** "owner/name", only when the caller owns it now. */
  repo?: string;
}

const PAGE = /^#\/[^?#\s]*$/;

export const FillSchema = z
  .object({
    title: z.string().min(1).max(HANDOFF_TITLE_MAX),
    text: z.string().min(1).max(HANDOFF_TEXT_MAX),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200).optional(),
    fromHelp: z.uuid(),
  })
  .strict();

/** What is kept of a hand-off in the conversation: where it went and what kinds of thing were copied, never the copy. */
export const HandoffRecordSchema = z
  .object({
    message: z.uuid(),
    where: z.enum(HANDOFF_WHERE),
    page: z.string().max(300).regex(PAGE),
    copied: z.array(z.enum(COPIED)).max(COPIED.length),
    at: z.iso.datetime(),
  })
  .strict();
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

/** The body of a confirm: which reply, which offer, and the page and copy that were shown. */
export const HandoffCallSchema = z
  .object({ message: z.uuid(), offer: z.string().regex(/^[a-z0-9-]{1,40}$/), page: z.string().max(300).regex(PAGE), fill: FillSchema.optional() })
  .strict();

export const HANDOFF_WORDS = {
  changed: "This answer cannot be taken there as it was shown any more. Look at it again.",
  badBody: "a hand-off is chosen with {message, offer, page, fill}",
  unknownMessage: "no such answer in this conversation",
} as const;

/** The route inside an evidence ref ("run x · #/runs/x", "diagnosis · run x · #/runs/x", "#/runs"), or undefined. */
export function routeOfRef(ref: string): string | undefined {
  const i = ref.lastIndexOf(" · ");
  const route = i >= 0 ? ref.slice(i + 3) : ref;
  return /^#\/[A-Za-z0-9%._~/-]+$/.test(route) ? route : undefined;
}

/** The title of a session made from a question: its first line, cleaned and cut. */
export function titleOf(question: string): string {
  const first = question.split("\n").find((l) => l.trim()) ?? "";
  // eslint-disable-next-line no-control-regex
  return first.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, HANDOFF_TITLE_MAX).trim() || FALLBACK_TITLE;
}

/** The idea text of a session made from a reply. Sources are dropped from the end until it fits. */
export function ideaText(question: string, reply: Reply, evidence: readonly string[]): string {
  const q = question.length > QUESTION_CUT ? `${question.slice(0, QUESTION_CUT)} …` : question;
  const answer = [...(reply.limit ? [] : [reply.summary]), ...reply.recommendations.map((r) => `- ${r}`)];
  const head = ["Question:", q, "", "Answer from Ask SCF:", ...answer].join("\n");
  const build = (n: number) => (n > 0 ? `${head}\n\nSources:\n${evidence.slice(0, n).join("\n")}` : head);
  let n = evidence.length;
  while (n > 0 && build(n).length > HANDOFF_TEXT_MAX) n--;
  return build(n).slice(0, HANDOFF_TEXT_MAX);
}

/** The offers for one finished reply, in a fixed order. */
export function handoffOffers(input: HandoffInput): HandoffOffer[] {
  const { role, reply, found } = input;
  const admin = role === "admin";
  const out: HandoffOffer[] = [];
  const code = reply.limit?.code;
  if (found.run !== undefined) out.push({ key: "run", where: "run", title: "Run details", page: subjectPage("run", found.run) });
  if (admin && found.problem !== undefined) out.push({ key: "problems", where: "problems", title: "Problems", page: subjectPage("problem", found.problem) });
  else if (admin && code === "monitor-finding") out.push({ key: "problems", where: "problems", title: "Problems", page: "#/problems" });
  if (admin && (reply.type === "status" || code === "next-step")) out.push({ key: "your-turn", where: "your-turn", title: "Your turn on Home", page: "#/home" });
  const base = { fromHelp: input.conversation, ...(input.repo ? { repo: input.repo } : {}) };
  out.push({
    key: "refinement",
    where: "refinement",
    title: "Refinement: a new session from this answer",
    page: "#/refinement",
    fill: { title: titleOf(input.question), text: ideaText(input.question, reply, input.evidence), ...base },
  });
  reply.drafts.forEach((d, i) =>
    out.push({
      key: `issue-draft-${i}`,
      where: "issue-draft",
      title: `Refinement: a new session from draft ${i + 1}`,
      page: "#/refinement",
      fill: { title: d.title.slice(0, HANDOFF_TITLE_MAX), text: d.text, ...base },
    }),
  );
  return out;
}

/** What an offer copies, by kind. Navigation copies nothing. */
export function copiedOf(offer: HandoffOffer): (typeof COPIED)[number][] {
  const f = offer.fill;
  return f ? ["title", "text", ...(f.repo ? (["repository"] as const) : []), "link"] : [];
}

/** Whether two fills are the same, field by field in a fixed order. */
export function sameFill(a?: HandoffFill, b?: HandoffFill): boolean {
  if (!a || !b) return !a && !b;
  return a.title === b.title && a.text === b.text && a.repo === b.repo && a.fromHelp === b.fromHelp;
}
