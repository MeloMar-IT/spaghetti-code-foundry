import { createHash } from "node:crypto";
import { z } from "zod";
import type { HelpRole } from "./contract.js";
import type { Source } from "./turn.js";

/**
 * The offers of Ask SCF: buttons in a reply that the server itself offers and checks again at the click. Pure data and
 * pure functions. This module imports only types from the contract (the contract imports values from here), so there
 * is no import cycle. An offer points at a source the server offered; the server knows the subject (kind and id) of
 * that source and builds every address from it. Text from a model never becomes an address.
 */

/** The kinds of thing a source can be about (SNAPSHOT_KINDS in src/server/help-context.ts; a test keeps them equal). */
export const SUBJECT_KINDS = ["run", "issue", "repository", "queue", "refinement", "problem", "next", "health"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface Subject {
  kind: SubjectKind;
  id: string;
}

export const SubjectSchema = z.object({ kind: z.enum(SUBJECT_KINDS), id: z.string().min(1).max(200) }).strict();

/** Where the page of a subject is: built by the server, always `#/…`, the id encoded. */
export function subjectPage(kind: SubjectKind, id: string): string {
  const enc = encodeURIComponent(id);
  switch (kind) {
    case "run":
      return `#/runs/${enc}`;
    case "repository":
      return `#/repos/${enc}`;
    case "refinement":
      return `#/refinement/${enc}`;
    case "problem":
      return `#/problems/${enc}`;
    case "queue":
      return "#/runs";
    case "issue":
      return "#/board";
    case "next":
      return "#/home";
    case "health":
      return "#/operations";
  }
}

export const OFFER_TYPES = ["open-run", "open-repository", "open-turn-item", "refresh-evidence", "test-repository"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/** What an offer does: open a page, or run a read-only check whose result is stored in the conversation. */
export const EFFECT_KINDS = ["navigation", "check"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const OFFER_MAX = 3;

export interface OfferCallDef {
  method: "GET" | "POST";
  path: string;
}

/** The GET call each snapshot adapter of help-context.ts follows for a kind: what `refresh-evidence` is checked against. */
export const READ_CALLS: Record<SubjectKind, OfferCallDef> = {
  run: { method: "GET", path: "runs/:id" },
  issue: { method: "GET", path: "board" },
  repository: { method: "GET", path: "repos" },
  queue: { method: "GET", path: "queue" },
  refinement: { method: "GET", path: "refinement/:id" },
  problem: { method: "GET", path: "monitor/findings/:id" },
  next: { method: "GET", path: "next" },
  health: { method: "GET", path: "health" },
};

export interface OfferDef {
  type: OfferType;
  /** The server's own words, shown on the card. */
  title: string;
  roles: readonly HelpRole[];
  subjects: readonly SubjectKind[];
  effect: EffectKind;
  /** The API call whose permission rule is checked at the click; ":id" is the id of the subject. `"read"`: `READ_CALLS[kind]`. */
  call: OfferCallDef | "read";
  /** The address the click gives back (navigation only). */
  to?: (s: Subject) => string;
}

export const OFFERS: readonly OfferDef[] = [
  { type: "open-run", title: "Open this run", roles: ["admin", "user"], subjects: ["run"], effect: "navigation", call: { method: "GET", path: "runs/:id" }, to: (s) => subjectPage("run", s.id) },
  { type: "open-repository", title: "Open this repository", roles: ["admin", "user"], subjects: ["repository"], effect: "navigation", call: { method: "GET", path: "repos" }, to: (s) => subjectPage("repository", s.id) },
  { type: "open-turn-item", title: "Open it under Your turn on Home", roles: ["admin"], subjects: ["run", "issue"], effect: "navigation", call: { method: "GET", path: "your-turn" }, to: () => "#/home" },
  { type: "refresh-evidence", title: "Read it again", roles: ["admin", "user"], subjects: [...SUBJECT_KINDS], effect: "check", call: "read" },
  { type: "test-repository", title: "Test the connection", roles: ["admin", "user"], subjects: ["repository"], effect: "check", call: { method: "POST", path: "repos/:id/test" } },
];

export function offerDef(role: HelpRole, type: unknown): OfferDef | undefined {
  return OFFERS.find((o) => o.type === type && o.roles.includes(role));
}

/** The call an offer is checked against, for one subject. */
export function callOf(def: OfferDef, s: Subject): OfferCallDef {
  return def.call === "read" ? READ_CALLS[s.kind] : def.call;
}

/** The path segments of the call an offer is checked against, for one subject. */
export function offerCall(def: OfferDef, s: Subject): string[] {
  return callOf(def, s).path.split("/").map((p) => (p === ":id" ? s.id : p));
}

/** A stored offer: the server's title, the source it is about, and the subject the server knows for that source. */
export const OfferSchema = z
  .object({
    type: z.enum(OFFER_TYPES),
    title: z.string().min(1).max(80),
    evidence: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    subject: SubjectSchema,
  })
  .strict();
export type Offer = z.infer<typeof OfferSchema>;

/** The body of a click: which reply, and which of its offers (by index). */
export const OfferCallSchema = z.object({ message: z.uuid(), offer: z.number().int().min(0).max(OFFER_MAX - 1) }).strict();

export const OFFER_WORDS = {
  stale: "This is not there any more, or you can no longer see it.",
  denied: "You are not allowed to open this now.",
  badBody: "an offer is chosen with {message, offer}",
} as const;

// ---- checks: read-only offers whose result is stored in the conversation ---------------------------

export const CHECK_TYPES = ["refresh-evidence", "test-repository"] as const;
export const CHECK_OUTCOMES = ["read", "passed", "failed"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];
/** The longest line (and value) of a check, the longest title, and the most lines. */
export const CHECK_VALUE_MAX = 300;
export const CHECK_TITLE_MAX = 500;
export const CHECK_LINES = 30;
/** How many of the newest checks of a conversation a later turn gets as sources, and how long a check counts as fresh. */
export const CHECK_SOURCES = 2;
export const CHECK_FRESH_MS = 15 * 60_000;

/** The stored result of a check. `scope` is the role of the asker when it ran: an admin's view can hold more than a user's. */
export const CheckSchema = z
  .object({
    type: z.enum(CHECK_TYPES),
    offer: z.number().int().min(0).max(OFFER_MAX - 1),
    subject: SubjectSchema,
    scope: z.enum(["admin", "user"]),
    title: z.string().min(1).max(CHECK_TITLE_MAX),
    outcome: z.enum(CHECK_OUTCOMES),
    lines: z.array(z.string().min(1).max(CHECK_VALUE_MAX)).max(CHECK_LINES),
    observedAt: z.iso.datetime(),
    uncertain: z.literal(true).optional(),
  })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

/** The server's own words for checks. */
export const checkText = {
  "bad-state": "A check can run only in an open conversation whose last answer is finished.",
  busy: "Ask SCF is still answering in this conversation. Wait for the answer, then run the check.",
  limit: "This conversation is full. Start a new conversation to run a check.",
  running: "A check is already running in this conversation. Wait for it to finish.",
  changed: "This conversation changed while the check ran. Run the check again.",
  notStored: "The connection test ran, and its result is saved on the repository page. It is not saved in this conversation, because the conversation changed while the test ran.",
  outcome: { read: "Read again", passed: "Connection works", failed: "Connection failed" },
} as const;

/** Cuts a text to at most `max` characters, the marker ` …` included. */
export function cutText(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 2)} …` : t;
}

/** What `checkOf` needs of a snapshot (help-context.ts), without importing the server. */
export interface CheckInput {
  type: (typeof CHECK_TYPES)[number];
  offer: number;
  scope: "admin" | "user";
  kind: SubjectKind;
  id: string;
  label: string;
  observedAt: string;
  fields: Record<string, string | number | boolean>;
  unavailable: string[];
  stale: string[];
}

/** A snapshot as a bounded, checked check: field lines first, then the lines about what failed, is missing or is old. */
export function checkOf(input: CheckInput, outcome: CheckOutcome, failed: readonly string[] = []): Check {
  const special = [
    ...failed.map((f) => cutText(`Failed: ${f}`, CHECK_VALUE_MAX)),
    ...(input.unavailable.length ? [cutText(`Not available now: ${input.unavailable.join(", ")}`, CHECK_VALUE_MAX)] : []),
    ...(input.stale.length ? [cutText(`May be out of date: ${input.stale.join(", ")}`, CHECK_VALUE_MAX)] : []),
  ].slice(0, CHECK_LINES);
  const fields = Object.entries(input.fields)
    .map(([k, v]) => cutText(`${k}: ${String(v)}`, CHECK_VALUE_MAX))
    .slice(0, CHECK_LINES - special.length);
  const title = cutText(`${input.label.charAt(0).toUpperCase()}${input.label.slice(1)}`, CHECK_TITLE_MAX) || "Check";
  return CheckSchema.parse({
    type: input.type,
    offer: input.offer,
    subject: { kind: input.kind, id: input.id },
    scope: input.scope,
    title,
    outcome,
    lines: [...fields, ...special].filter((l) => l.trim()),
    observedAt: input.observedAt,
    ...(input.stale.length ? { uncertain: true } : {}),
  });
}

/** The id of the source a stored check makes: derived from the id of its message, so it is stable and never stored. */
export const checkSourceId = (messageId: string): string => `check-${createHash("sha256").update(messageId).digest("hex").slice(0, 16)}`;

/**
 * The newest checks of a conversation as `state` sources for a later turn. A check of the administrator's view is
 * dropped once the account is a user, and so is one about something the account cannot see now. A check older than
 * CHECK_FRESH_MS is uncertain.
 */
export function checkSources(history: readonly { id: string; role: string; check?: Check }[], role: HelpRole, visible: (s: Subject) => boolean, now: Date = new Date()): Source[] {
  const out: Source[] = [];
  const newest = history.filter((m) => m.role === "check" && m.check).slice(-CHECK_SOURCES).reverse();
  for (const m of newest) {
    const c = m.check!;
    if ((c.scope === "admin" && role !== "admin") || !visible(c.subject)) continue;
    const old = now.getTime() - Date.parse(c.observedAt) > CHECK_FRESH_MS;
    const excerpt = [
      `Checked by the server at ${c.observedAt} when the person asked (${c.type}). Outcome: ${checkText.outcome[c.outcome]}.`,
      ...(old ? ["This check is older than 15 minutes and may be out of date."] : []),
      ...c.lines,
    ].join("\n");
    out.push({
      id: checkSourceId(m.id),
      kind: "state",
      title: `Check: ${c.title}`.slice(0, 120),
      ref: `check ${c.type} · ${subjectPage(c.subject.kind, c.subject.id)}`,
      observedAt: c.observedAt,
      subject: c.subject,
      excerpt: cutText(excerpt, 800),
      ...(old || c.uncertain ? { uncertain: true } : {}),
    });
  }
  return out;
}
