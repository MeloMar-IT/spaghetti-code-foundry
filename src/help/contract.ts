import { z } from "zod";
import { OFFER_MAX, OfferSchema, offerDef, type Subject } from "./actions.js";
import { PLAN_MAX, PlanStepSchema, STEP_KINDS, STEP_RULES, checkPlan, claimsResult, type Impact } from "./plan.js";

/**
 * The contract of Ask SCF, the help assistant inside the product: what it answers, what a reply may hold, what
 * evidence a claim needs, how it says that it is not sure, and what it never does. Pure data and pure functions:
 * no model, no storage, no routes. Every later part of Ask SCF goes through `checkReply`, so a model's text can
 * never widen what a reply holds.
 */

export type HelpRole = "admin" | "user";
const A: HelpRole[] = ["admin"];
const AU: HelpRole[] = ["admin", "user"];

// ---- what can be asked -----------------------------------------------------------------------------

export const QUESTION_TYPES = ["product-help", "status", "troubleshooting", "guided-resolution"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const EVIDENCE_KINDS = ["doc", "state"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What each kind of question is, and the kind of evidence its answer must rest on. */
export const QUESTION_RULES: Record<QuestionType, { what: string; evidence: EvidenceKind }> = {
  "product-help": { what: "How the Foundry works: a page, a word, a setting, a flow.", evidence: "doc" },
  status: { what: "What your work is doing now, and why it waits.", evidence: "state" },
  troubleshooting: { what: "Why something failed or does not move.", evidence: "state" },
  "guided-resolution": { what: "Which steps solve a problem, in order, and where to do them.", evidence: "state" },
};

// ---- what a reply may hold -------------------------------------------------------------------------

export const PART_KINDS = ["answer", "recommendation", "navigation", "plan", "draft", "action"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/**
 * The six parts of a reply. Only an action changes something, and only an action needs a confirmation; the other five
 * are text and links, and nothing happens until the person does it.
 */
export const PART_RULES: Record<PartKind, { what: string; changesState: boolean; needsConfirmation: boolean }> = {
  answer: { what: "What is true, as far as Ask SCF can see. Nothing happens.", changesState: false, needsConfirmation: false },
  recommendation: { what: "What you could do. You decide and you do it; nothing happens by itself.", changesState: false, needsConfirmation: false },
  navigation: { what: "A link to a page of the Foundry that you may open. Opening it is your click.", changesState: false, needsConfirmation: false },
  plan: { what: "Ordered steps to solve a problem. Nothing happens until you do a step yourself.", changesState: false, needsConfirmation: false },
  draft: { what: "A text for you to copy or change. It is not sent, saved or posted anywhere.", changesState: false, needsConfirmation: false },
  action: { what: "A change to the Foundry or to GitHub. Never done without your explicit approval.", changesState: true, needsConfirmation: true },
};

/** Ask SCF reads and explains unless every rule for an action below is met. */
export const READ_ONLY_BY_DEFAULT = true;

/** What must all hold before an action may run. A proposal that misses one is dropped by the server. */
export const ACTION_RULES = [
  "The action is on the server's own list. Text from a model never names a command, a route or a tool.",
  "You see the exact effect before anything happens.",
  "You confirm it yourself, for this one action.",
  "The server checks again that you may do it, as for the same click on its own page.",
  "The server reads the result back and tells you what changed.",
] as const;

export interface ActionDef {
  id: string;
  title: string;
  roles: HelpRole[];
  /** How much the action can change: a step that uses it is at least this impact. */
  impact: Impact;
  /** Whether the action can be taken back. */
  undoable: boolean;
  /** What it does, in the server's words: the only impact text a kept action shows. */
  effect: string;
}

/**
 * The actions Ask SCF may propose: only the asker's own runs, an admin gets no exception (`liveEvidence` enforces
 * this). Nothing is carried out here; the effect texts say what would happen, never what happened.
 */
export const ACTIONS: readonly ActionDef[] = [
  { id: "resume-run", title: "Resume the run", roles: AU, impact: "reversible", undoable: true, effect: "The run goes on from the step where it stopped. It can be stopped again later." },
  { id: "cancel-run", title: "Cancel the run", roles: AU, impact: "high", undoable: false, effect: "The run stops and is marked as cancelled. Ask SCF cannot undo this." },
];

export const ABOUT_KINDS = ["run"] as const;
export const AboutSchema = z.object({ kind: z.enum(ABOUT_KINDS), id: z.string().regex(/^[\w-]{1,128}$/) }).strict();
export type About = z.infer<typeof AboutSchema>;

/** A checked copy of what a source is about, or undefined. */
export function aboutOf(v: unknown): About | undefined {
  const p = AboutSchema.safeParse(v);
  return p.success ? { kind: p.data.kind, id: p.data.id } : undefined;
}

const ACTION_CLAIM = /\b(?:was|were|is|has\s+been|have\s+been|got)\s+(?:resumed|restarted|started|queued|cancelled|canceled|stopped|removed)\b/i;
const ACTION_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * True when a text says an action already happened. Give it the model's whole, raw text: nothing is cut and no
 * `[removed …]` marker is taken out first, so a claim cannot hide past the length limit or inside a fake marker.
 * Stricter than claimsResult: no exemption for questions.
 */
export function claimsAction(text: string): boolean {
  const t = text.replace(/\r\n/g, "\n").replace(ACTION_CONTROL, " ");
  return claimsResult(t) || ACTION_CLAIM.test(t);
}

export const ACTION_DROPPED = {
  unbound: "action: not bound to a source the server offered",
  uncertain: "action: its source is uncertain",
  claimed: "action: claimed a result that was not checked",
} as const;

export const actionAllowed = (role: HelpRole, id: string): boolean => ACTIONS.some((a) => a.id === id && a.roles.includes(role));

export interface NavPage {
  to: string;
  title: string;
  roles: HelpRole[];
}

/**
 * The pages a reply may link to: fixed pages of the interface, each with the roles that have it (as in `ui/ia.js`).
 * No address with an id: a link to one run or one repository needs the permission-checked context of a later part.
 */
export const NAV_PAGES: readonly NavPage[] = [
  { to: "#/home", title: "Home", roles: AU },
  { to: "#/runs", title: "Runs", roles: AU },
  { to: "#/start", title: "Start work", roles: AU },
  { to: "#/repos", title: "My repositories", roles: AU },
  { to: "#/refinement", title: "Refinement", roles: AU },
  { to: "#/refinement/backlog", title: "Backlog readiness", roles: AU },
  { to: "#/board", title: "Board", roles: A },
  { to: "#/problems", title: "Problems", roles: A },
  { to: "#/operations", title: "Overview", roles: A },
  { to: "#/watchers", title: "Watchers", roles: A },
  { to: "#/models", title: "Models", roles: A },
  { to: "#/settings", title: "Settings", roles: A },
  { to: "#/users", title: "Users", roles: A },
];

export const navPage = (role: HelpRole, to: string): NavPage | undefined => NAV_PAGES.find((p) => p.to === to && p.roles.includes(role));

// ---- evidence and uncertainty ----------------------------------------------------------------------

export const TEXT_MAX = { summary: 500, explanation: 6000, item: 500, label: 80, draft: 4000, ref: 300 } as const;
export const LIST_MAX = { evidence: 10, recommendations: 5, links: 5, drafts: 3, actions: 3 } as const;

/**
 * One piece of evidence. The server makes these from what the asker may see and hands them to the model with their
 * ids; a reply can only point back at them. Current state always carries the time it was observed.
 */
export const EvidenceSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    kind: z.enum(EVIDENCE_KINDS),
    title: z.string().min(1).max(TEXT_MAX.item),
    /** Where it is from: a chapter of the installed guide, or a page of the Foundry. */
    ref: z.string().min(1).max(TEXT_MAX.ref),
    observedAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine((e) => e.kind !== "state" || e.observedAt !== undefined, { message: "current state needs the time it was observed", path: ["observedAt"] });
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CERTAINTY = ["confirmed", "likely", "unverified"] as const;
export type Certainty = (typeof CERTAINTY)[number];

/** The fixed words for how sure a reply is. The model chooses a level; it never writes these sentences. */
export const CERTAINTY_WORDS: Record<Certainty, string> = {
  confirmed: "This rests on the sources listed below.",
  likely: "This is likely, but the sources below do not fully confirm it.",
  unverified: "Ask SCF could not check this against the documentation or the current state. Treat it as a guess.",
};

/**
 * How sure a reply may say it is. Without evidence of the kind its question needs it is "unverified", whatever the
 * model claimed; with it, the model's own level stands (it may be less sure, never more).
 */
export function certaintyOf(type: QuestionType, claimed: Certainty, evidence: readonly Evidence[]): Certainty {
  const fits = evidence.some((e) => e.kind === QUESTION_RULES[type].evidence);
  return fits ? claimed : "unverified";
}

// ---- what is not answered --------------------------------------------------------------------------

export const LIMIT_CODES = ["changes-state", "other-account", "admin-only", "secret", "not-scf", "no-evidence", "refinement", "next-step", "monitor-finding"] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];

export interface Limitation {
  code: LimitCode;
  /** What Ask SCF does not do, in one or two plain sentences. */
  limitation: string;
  /** The safest useful thing the person can do instead. */
  nextStep: string;
  /** A page that helps, when the role has one. */
  to?: string;
}

const ASK_ADMIN = "Ask an administrator of this Foundry.";
const LIMITS: Record<LimitCode, (role: HelpRole) => Omit<Limitation, "code">> = {
  "changes-state": () => ({
    limitation: "Ask SCF reads and explains. It does not start, stop, change, delete or send anything.",
    nextStep: "Do it yourself on the page where it belongs. Ask where that page is, or what the button does, and Ask SCF will tell you.",
  }),
  "other-account": () => ({
    limitation: "Ask SCF sees only what your own account can see. It does not look at the work, the repositories or the conversations of another account.",
    nextStep: "Ask the owner of that work.",
  }),
  "admin-only": (role) =>
    role === "admin"
      ? { limitation: "Ask SCF does not read or change the settings, the accounts or the costs for you.", nextStep: "Open Settings.", to: "#/settings" }
      : { limitation: "That belongs to the administrators: models, costs, accounts and the settings of the server. Ask SCF does not show it to you.", nextStep: ASK_ADMIN },
  secret: () => ({
    limitation: "Ask SCF never shows a password, a token or a key, and it never needs one from you.",
    nextStep: "Do not type a secret into a question. Sign-ins of repositories are managed under My repositories.",
    to: "#/repos",
  }),
  "not-scf": () => ({
    limitation: "Ask SCF answers questions about Spaghetti Code Foundry only: how it works, what your work is doing, and how to solve a problem with it.",
    nextStep: "Ask about a page, a run, a repository or a message that you see here.",
  }),
  "no-evidence": () => ({
    limitation: "Ask SCF cannot see enough to answer this, so it does not guess.",
    nextStep: "Open the run, the repository or the session you mean; its own page shows its state.",
    to: "#/runs",
  }),
  refinement: () => ({
    limitation: "Writing and improving stories is the work of Refinement, with the architect. Ask SCF does not do it a second time.",
    nextStep: "Open Refinement and start a session, or go on with one.",
    to: "#/refinement",
  }),
  "next-step": (role) => ({
    limitation: "What happens next with a run or an issue, and who has to act, is stated by the Foundry itself. Ask SCF does not give a second answer that could differ.",
    nextStep: role === "admin" ? "Open Home: Your turn and every run say what happens next." : "Open the run under My runs: its page says what happens next.",
    to: role === "admin" ? "#/home" : "#/runs",
  }),
  "monitor-finding": (role) =>
    role === "admin"
      ? { limitation: "What the monitor found is handled on the Problems page. Ask SCF does not judge, mute or change a finding.", nextStep: "Open Problems.", to: "#/problems" }
      : { limitation: "What the monitor of the Foundry found is for the administrators. Ask SCF does not show it to you.", nextStep: ASK_ADMIN },
};

/** The fixed limitation and the safest next step for a request Ask SCF does not serve, in the words for the role. */
export function limitationFor(code: LimitCode, role: HelpRole): Limitation {
  const l = LIMITS[code](role);
  // a page the role does not have is never offered
  return { code, limitation: l.limitation, nextStep: l.nextStep, ...(l.to !== undefined && navPage(role, l.to) ? { to: l.to } : {}) };
}

/** Work that has its own place in the Foundry. Ask SCF sends people there instead of doing it again. */
export const HANDOFFS: Record<"refinement" | "next-step" | "monitor-finding", string> = {
  refinement: "Backlog refinement: Refinement, with the architect.",
  "next-step": "The authoritative next step of a run or an issue: the Foundry's own \"what happens next\".",
  "monitor-finding": "Findings of the monitor: the Problems page.",
};

// ---- what a normal user never sees -----------------------------------------------------------------

/** Names of fields that only an administrator gets: models and providers, money, tokens and server detail. */
export const ADMIN_ONLY_KEYS: readonly string[] = ["model", "provider", "target", "agent", "costUsd", "cost", "inputTokens", "outputTokens", "tokens", "usage", "detail"];

/** A copy of `value` for the role: for a user every admin-only field is left out, at any depth. */
export function forRole<T>(role: HelpRole, value: T): T {
  if (role === "admin") return value;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !ADMIN_ONLY_KEYS.includes(k))
        .map(([k, x]) => [k, strip(x)]),
    );
  };
  return strip(value) as T;
}

/** The text with every given name (a model, a provider) replaced by plain words. Longest names first. */
export function hideNames(text: string, names: readonly (string | undefined)[], by = "the AI model"): string {
  let out = text;
  for (const n of [...new Set(names.filter((x): x is string => typeof x === "string" && x.trim().length >= 3))].sort((a, b) => b.length - a.length)) {
    out = out.split(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join(by);
  }
  return out;
}

// ---- a checked reply -------------------------------------------------------------------------------

const line = (max: number) => z.string().min(1).max(max);
const LinkSchema = z.object({ label: line(TEXT_MAX.label), to: line(TEXT_MAX.ref) }).strict();
const DraftSchema = z.object({ title: line(TEXT_MAX.label), text: line(TEXT_MAX.draft) }).strict();
const ActionSchema = z
  .object({ id: line(TEXT_MAX.label), title: line(TEXT_MAX.label), impact: line(TEXT_MAX.item), source: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), about: AboutSchema })
  .strict();
const LimitSchema = z.object({ code: z.enum(LIMIT_CODES), limitation: line(TEXT_MAX.item), nextStep: line(TEXT_MAX.item), to: line(TEXT_MAX.ref).optional() }).strict();

/** A reply after the server's checks: this is what is stored and shown. */
export const ReplySchema = z
  .object({
    type: z.enum(QUESTION_TYPES),
    summary: line(TEXT_MAX.summary),
    explanation: z.string().max(TEXT_MAX.explanation),
    certainty: z.enum(CERTAINTY),
    evidence: z.array(EvidenceSchema).max(LIST_MAX.evidence),
    recommendations: z.array(line(TEXT_MAX.item)).max(LIST_MAX.recommendations),
    links: z.array(LinkSchema).max(LIST_MAX.links),
    drafts: z.array(DraftSchema).max(LIST_MAX.drafts),
    actions: z.array(ActionSchema).max(LIST_MAX.actions),
    plan: z.array(PlanStepSchema).max(PLAN_MAX).optional(),
    offers: z.array(OfferSchema).max(OFFER_MAX).optional(),
    limit: LimitSchema.optional(),
  })
  .strict();
export type Reply = z.infer<typeof ReplySchema>;

/** What a model may send. Evidence is named by id only, and a limit by its code only. */
const RawSchema = z.object({
  type: z.enum(QUESTION_TYPES).catch("product-help"),
  summary: z.string().catch(""),
  explanation: z.string().catch(""),
  certainty: z.enum(CERTAINTY).catch("unverified"),
  evidence: z.array(z.unknown()).catch([]),
  recommendations: z.array(z.unknown()).catch([]),
  links: z.array(z.unknown()).catch([]),
  drafts: z.array(z.unknown()).catch([]),
  actions: z.array(z.unknown()).catch([]),
  plan: z.array(z.unknown()).catch([]),
  offers: z.array(z.unknown()).catch([]),
  limit: z.unknown().optional(),
});

export interface CheckInput {
  role: HelpRole;
  /** The evidence the server gave to the model for this question. A reply can cite nothing else. */
  offered?: readonly Evidence[];
  /** Makes a text safe to keep (secrets out); applied to every text of the reply. */
  clean?: (text: string) => string;
  /** Ids of offered sources the server marked as old or in disagreement: a reply that cites one is "likely" at most. */
  uncertain?: readonly string[];
  /** What each offered source is about (from `Prepared.targets`). Only an action bound to one of these is kept; without it none is. */
  targets?: Readonly<Record<string, About>>;
  /** The subject of each offered state source, by evidence id (`Prepared.subjects`). An offer can point only at one of these. */
  subjects?: Readonly<Record<string, Subject>>;
}

export interface Checked {
  reply: Reply;
  /** What the server left out, as fixed words: for the log and for tests, never shown as the model's text. */
  dropped: string[];
}

// C0 and C1 control characters other than tab and newline never reach a stored reply.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Checks what a model answered against the contract and returns the reply the server keeps, or undefined when it is
 * not a reply at all. Nothing in it is trusted: evidence must be one the server offered, a link must be a page the
 * role has, an action must be on the server's list and bound to a cited, current state source the server tied to a run, a limit is replaced by the server's own words, and the
 * certainty follows the evidence.
 */
export function checkReply(raw: unknown, input: CheckInput): Checked | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const parsed = RawSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const dropped: string[] = [];
  const clean = (v: unknown, max: number): string => (typeof v === "string" ? (input.clean ?? ((t) => t))(v.replace(/\r\n/g, "\n").replace(CONTROL, "")).trim().slice(0, max).trim() : "");
  const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

  const limitCode = LIMIT_CODES.find((c) => c === r.limit);
  if (r.limit !== undefined && r.limit !== null && limitCode === undefined) dropped.push("limit: unknown code");
  if (limitCode !== undefined) {
    // A request that is not served: only the server's own words, a page the role has, and nothing else.
    const limit = limitationFor(limitCode, input.role);
    const page = limit.to !== undefined ? navPage(input.role, limit.to) : undefined;
    return {
      reply: { type: r.type, summary: limit.limitation, explanation: "", certainty: "confirmed", evidence: [], recommendations: [limit.nextStep], links: page ? [{ label: page.title, to: page.to }] : [], drafts: [], actions: [], limit },
      dropped,
    };
  }

  const summary = clean(r.summary, TEXT_MAX.summary);
  if (!summary) return undefined;

  const offered = input.offered ?? [];
  const evidence: Evidence[] = [];
  for (const id of r.evidence) {
    const found = typeof id === "string" ? offered.find((e) => e.id === id) : undefined;
    if (!found) dropped.push("evidence: not offered by the server");
    else if (!evidence.includes(found) && evidence.length < LIST_MAX.evidence) evidence.push(found);
  }

  const recommendations = r.recommendations.map((x) => clean(x, TEXT_MAX.item)).filter(Boolean).slice(0, LIST_MAX.recommendations);

  const links: Reply["links"] = [];
  for (const l of r.links) {
    const page = navPage(input.role, typeof obj(l)?.to === "string" ? (obj(l)!.to as string) : "");
    if (!page) dropped.push("link: not a page of this role");
    // the label is the page's own title: a model cannot dress a link up as something else
    else if (!links.some((x) => x.to === page.to) && links.length < LIST_MAX.links) links.push({ label: page.title, to: page.to });
  }

  const drafts: Reply["drafts"] = [];
  for (const d of r.drafts) {
    const text = clean(obj(d)?.text, TEXT_MAX.draft);
    if (!text) dropped.push("draft: empty");
    else if (drafts.length < LIST_MAX.drafts) drafts.push({ title: clean(obj(d)?.title, TEXT_MAX.label) || "Draft", text });
  }

  const actions: Reply["actions"] = [];
  const targets = input.targets ?? {};
  const doubt = input.uncertain ?? [];
  for (const a of r.actions) {
    const o = obj(a);
    const def = ACTIONS.find((x) => x.id === o?.id && x.roles.includes(input.role));
    if (!def) {
      dropped.push("action: not on the server's list");
      continue;
    }
    const source = typeof o?.source === "string" ? o.source : "";
    const cited = evidence.find((e) => e.id === source);
    const about = Object.hasOwn(targets, source) ? aboutOf(targets[source]) : undefined;
    // the whole raw text: never the cleaned and cut one, which could hide a claim
    const said = typeof o?.impact === "string" ? o.impact : "";
    if (!cited || cited.kind !== "state") dropped.push(ACTION_DROPPED.unbound);
    else if (doubt.includes(source)) dropped.push(ACTION_DROPPED.uncertain);
    else if (!about || about.kind !== "run") dropped.push(ACTION_DROPPED.unbound);
    else if (claimsAction(said)) dropped.push(ACTION_DROPPED.claimed);
    else if (!actions.some((x) => x.id === def.id && x.about.id === about.id) && actions.length < LIST_MAX.actions) actions.push({ id: def.id, title: def.title, impact: def.effect, source, about });
  }

  // an offer is only a type and the id of an offered state source; the title and the subject are the server's own
  const offers: NonNullable<Reply["offers"]> = [];
  for (const o of r.offers) {
    const type = obj(o)?.type;
    const id = typeof obj(o)?.evidence === "string" ? (obj(o)!.evidence as string) : "";
    const def = offerDef(input.role, type);
    const source = offered.find((e) => e.id === id && e.kind === "state");
    const subject = source && Object.hasOwn(input.subjects ?? {}, id) ? input.subjects![id] : undefined;
    if (!def) dropped.push("offer: not on the server's list");
    else if (!source || !subject) dropped.push("offer: no state source of the server");
    else if (!def.subjects.includes(subject.kind)) dropped.push("offer: does not fit its source");
    else if (!offers.some((x) => x.type === def.type && x.evidence === id) && offers.length < OFFER_MAX) offers.push({ type: def.type, title: def.title, evidence: id, subject: { kind: subject.kind, id: subject.id } });
  }

  let certainty = certaintyOf(r.type, r.certainty, evidence);
  if (certainty === "confirmed" && evidence.some((e) => (input.uncertain ?? []).includes(e.id))) certainty = "likely";
  const checkedPlan = checkPlan(r.plan, {
    cited: evidence,
    uncertain: input.uncertain ?? [],
    certainty,
    action: (id) => {
      // a step may name only an action the server kept as a bound proposal: with help.actions off none is
      if (!actions.some((x) => x.id === id)) return undefined;
      const def = ACTIONS.find((x) => x.id === id && x.roles.includes(input.role));
      return def ? { id: def.id, impact: def.impact } : undefined;
    },
    page: (to) => navPage(input.role, to),
    clean,
  });
  dropped.push(...checkedPlan.dropped);

  const reply: Reply = {
    type: r.type,
    summary,
    explanation: clean(r.explanation, TEXT_MAX.explanation),
    certainty,
    evidence,
    recommendations,
    links,
    drafts,
    actions,
    ...(checkedPlan.plan.length ? { plan: checkedPlan.plan } : {}),
    ...(offers.length ? { offers } : {}),
  };
  return { reply, dropped };
}

/** The reply as plain text, built by the server from the checked parts. The certainty is always said. */
export function displayText(reply: Reply): string {
  const out: string[] = [reply.summary];
  if (reply.explanation) out.push("", reply.explanation);
  if (reply.recommendations.length) out.push("", reply.limit ? "What you can do:" : "What you could do:", ...reply.recommendations.map((x) => `- ${x}`));
  if (reply.plan?.length) {
    out.push("", "Plan (nothing is done until you do it):");
    reply.plan.forEach((s, i) => {
      out.push(`${i + 1}. [${STEP_RULES[s.kind].label}] ${s.title}`);
      if (s.wouldBe) out.push(`   ${s.wouldBe === "high-impact" ? "Would be a high-impact change, do not do it yet" : "Would be a change, do not do it yet"}: ${s.proposal ?? ""}`);
      if (s.instructions) out.push(`   ${s.instructions}`);
      if (s.expected) out.push(`   What you should see: ${s.expected}`);
      if (s.failure) out.push(`   If it fails: ${s.failure}`);
      if (s.fallback) out.push(`   Then: ${s.fallback}`);
    });
  }
  if (reply.drafts.length) for (const d of reply.drafts) out.push("", `Draft (not sent): ${d.title}`, d.text);
  if (reply.actions.length) out.push("", "Needs your approval before anything happens:", ...reply.actions.map((a) => `- ${a.title}: ${a.impact}`));
  if (reply.offers?.length) out.push("", "You can open:", ...reply.offers.map((o) => `- ${o.title}`));
  if (reply.links.length) out.push("", "Pages:", ...reply.links.map((l) => `- ${l.label} (${l.to})`));
  if (!reply.limit) {
    if (reply.evidence.length) out.push("", "Sources:", ...reply.evidence.map((e) => `- ${e.title} (${e.ref}${e.observedAt ? `, seen ${e.observedAt}` : ""})`));
    out.push("", CERTAINTY_WORDS[reply.certainty]);
  }
  return out.join("\n");
}

/** The contract as a person of the role may read it: what can be asked, what a reply holds, and what is not done. */
export function contractFor(role: HelpRole) {
  return {
    readOnly: READ_ONLY_BY_DEFAULT,
    questions: QUESTION_TYPES.map((id) => ({ id, what: QUESTION_RULES[id].what })),
    parts: PART_KINDS.map((id) => ({ id, ...PART_RULES[id] })),
    steps: STEP_KINDS.map((id) => ({ id, ...STEP_RULES[id] })),
    actionRules: [...ACTION_RULES],
    actions: ACTIONS.filter((a) => a.roles.includes(role)).map((a) => ({ id: a.id, title: a.title })),
    certainty: CERTAINTY.map((id) => ({ id, words: CERTAINTY_WORDS[id] })),
    limits: LIMIT_CODES.map((code) => limitationFor(code, role)),
    pages: NAV_PAGES.filter((p) => p.roles.includes(role)).map((p) => ({ to: p.to, title: p.title })),
  };
}
