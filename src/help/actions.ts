import { z } from "zod";
import type { HelpRole } from "./contract.js";

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

export const OFFER_TYPES = ["open-run", "open-repository", "open-turn-item"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/** What an offer does. Part 2 adds a read-only check next to navigation. */
export const EFFECT_KINDS = ["navigation"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const OFFER_MAX = 3;

export interface OfferDef {
  type: OfferType;
  /** The server's own words, shown on the card. */
  title: string;
  roles: readonly HelpRole[];
  subjects: readonly SubjectKind[];
  effect: EffectKind;
  /** The API call whose permission rule is checked at the click; ":id" is the id of the subject. */
  call: { method: "GET"; path: string };
  /** The address the click gives back. */
  to: (s: Subject) => string;
}

export const OFFERS: readonly OfferDef[] = [
  { type: "open-run", title: "Open this run", roles: ["admin", "user"], subjects: ["run"], effect: "navigation", call: { method: "GET", path: "runs/:id" }, to: (s) => subjectPage("run", s.id) },
  { type: "open-repository", title: "Open this repository", roles: ["admin", "user"], subjects: ["repository"], effect: "navigation", call: { method: "GET", path: "repos" }, to: (s) => subjectPage("repository", s.id) },
  { type: "open-turn-item", title: "Open it under Your turn on Home", roles: ["admin"], subjects: ["run", "issue"], effect: "navigation", call: { method: "GET", path: "your-turn" }, to: () => "#/home" },
];

export function offerDef(role: HelpRole, type: unknown): OfferDef | undefined {
  return OFFERS.find((o) => o.type === type && o.roles.includes(role));
}

/** The path segments of the call an offer is checked against, for one subject. */
export function offerCall(def: OfferDef, s: Subject): string[] {
  return def.call.path.split("/").map((p) => (p === ":id" ? s.id : p));
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
