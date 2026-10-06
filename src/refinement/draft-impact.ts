import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuildLimits } from "./build-limits.js";
import type { Draft, DraftChange, DraftState } from "./draft.js";
import { RefinementError } from "./errors.js";
import { HAS_CONTROL, chars } from "./talk.js";

// This file may import from draft.ts only types: draft.ts imports ImpactSchema from here as a value.

export const IMPACT_MAX = { areas: 15, dependsOn: 10, dependents: 10, risks: 12, overlaps: 20, sensitive: 5 } as const;
export const IMPACT_PATH_MAX = 150;
export const IMPACT_TEXT_MAX = 300;
export const IMPACT_AREA_FILES_MAX = 8;
export const IMPACT_OVERLAP_AREAS_MAX = 5;
export const IMPACT_SIZE_NUMBER_MAX = 100_000;
export const END_NO_IMPACT_DRAFT = "The story draft for the architect's view could not be found";

const BASES = ["found", "estimate"] as const;
const RISK_KINDS = ["data", "security", "compatibility", "users"] as const;
const SIZES = ["small", "medium", "large"] as const;
const TOPICS = ["sign-in", "permissions", "secrets", "credentials", "user-data"] as const;
const LINE_BREAK = new RegExp(`[\\n${String.fromCharCode(0x2028, 0x2029)}]`);

// The rules of tools/refine-round-check, so a forged or damaged answer cannot store what the tool would refuse.
const TIME = /(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozens?|half an?|a couple of|a few|several))[\s-]*(?:(?:man|person|working|work|business|calendar|elapsed|full|whole)[\s-]*)?(?:hours?|hrs?|days?|weeks?)\b/i;
const sentences = (t: string): number => t.split(/(?<=[.!?]["'”’)\]]*)\s+/).filter(Boolean).length;
const sizeWord = (files: number, lines: number): (typeof SIZES)[number] => (files > 15 || lines > 800 ? "large" : files <= 5 && lines <= 200 ? "small" : "medium");
const insideRepo = (p: string): boolean => !/^[/\\]|^[A-Za-z]:|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(p);

const path = z
  .string()
  .min(1)
  .refine((p) => chars(p) <= IMPACT_PATH_MAX && !LINE_BREAK.test(p) && !HAS_CONTROL.test(p) && insideRepo(p));
const prose = (sentenceMax: number) =>
  z
    .string()
    .min(1)
    .refine((t) => chars(t) <= IMPACT_TEXT_MAX && !LINE_BREAK.test(t) && !HAS_CONTROL.test(t) && !TIME.test(t) && sentences(t) <= sentenceMax);
const basis = z.enum(BASES);
const count = z.number().int().min(0).max(IMPACT_SIZE_NUMBER_MAX);
const issue = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** The lists as the architect gives them and as they are stored; only the form of a link to a draft differs. */
function shape<L extends z.ZodType<string>>(draftLink: L) {
  const link = z
    .object({ issue: issue.optional(), draft: draftLink.optional(), basis, why: prose(2) })
    .strict()
    .refine((x) => (x.issue === undefined) !== (x.draft === undefined));
  return {
    areas: z
      .array(
        z
          .object({ area: path, files: z.array(path).max(IMPACT_AREA_FILES_MAX), basis, why: prose(2) })
          .strict()
          .refine((a) => a.basis !== "found" || a.files.length > 0),
      )
      .max(IMPACT_MAX.areas),
    dependsOn: z.array(link).max(IMPACT_MAX.dependsOn),
    dependents: z.array(link).max(IMPACT_MAX.dependents),
    risks: z.array(z.object({ kind: z.enum(RISK_KINDS), basis, text: prose(1) }).strict()).max(IMPACT_MAX.risks),
    size: z
      .object({ size: z.enum(SIZES), files: count, lines: count, why: prose(2) })
      .strict()
      .refine((s) => s.size === sizeWord(s.files, s.lines)),
    overlaps: z
      .array(z.object({ issue, areas: z.array(path).min(1).max(IMPACT_OVERLAP_AREAS_MAX), basis: z.literal("estimate"), why: prose(2) }).strict())
      .max(IMPACT_MAX.overlaps),
    sensitive: z.array(z.object({ topic: z.enum(TOPICS), basis, why: prose(2) }).strict()).max(IMPACT_MAX.sensitive),
  };
}

/** The relation between the lists: an overlap names areas of the answer. */
const related = (x: { areas: { area: string }[]; overlaps: { areas: string[] }[] }): boolean => x.overlaps.every((o) => o.areas.every((a) => x.areas.some((r) => r.area === a)));

/** The stored view: when it was asked, the mark of the draft at that time, and the checked answer. */
export const ImpactSchema = z
  .object({ at: z.iso.datetime(), mark: z.string().regex(/^[0-9a-f]{64}$/), ...shape(z.uuid()) })
  .strict()
  .refine(related);
export type Impact = z.infer<typeof ImpactSchema>;

const AnswerSchema = z
  .object(shape(z.string().regex(/^D\d{1,6}$/)))
  .strict()
  .refine(related);

/** Read back from the head of the task: the ids behind D1, D2, … and the mark of the draft when it was asked. */
export interface ImpactRefs {
  drafts: Record<string, string>;
  mark: string;
}

type Marked = Pick<Draft, "title" | "who" | "what" | "why" | "criteria" | "outOfScope" | "dependsOn">;

/** A fingerprint of what the view is about: the texts, the criteria (id and text, in order), out of scope and depends-on. Not the notes. */
export function draftMark(d: Marked): string {
  const targets = d.dependsOn.map((x) => (x.issue !== undefined ? `#${x.issue}` : (x.draft ?? ""))).sort();
  const parts = [d.title?.text ?? "", d.who?.text ?? "", d.what?.text ?? "", d.why?.text ?? "", d.criteria.map((c) => [c.id, c.text]), d.outOfScope?.text ?? "", targets];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const bad = (m: string) => new RefinementError("bad-draft", m);

/**
 * The end of an impact run: the checked answer becomes the view of the draft and replaces the old one. No field changes. `D` numbers
 * become draft ids; a link to an unknown number, to the draft itself or to a target already named is left out. Throws bad-draft for a
 * wrong form; undefined when the draft is gone or the refs of the task are missing.
 */
export function setImpact(st: DraftState, draftId: string, output: unknown, refs: ImpactRefs | undefined, at: string): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d || !refs) return undefined;
  const parsed = AnswerSchema.safeParse(output);
  if (!parsed.success) throw bad("the architect's view has the wrong form");
  const a = parsed.data;
  const links = (items: typeof a.dependsOn): Impact["dependsOn"] => {
    const seen = new Set<string>();
    const out: Impact["dependsOn"] = [];
    for (const x of items) {
      const id = x.draft === undefined ? undefined : refs.drafts[x.draft];
      if (x.draft !== undefined && (id === undefined || id === d.id || !st.drafts.some((o) => o.id === id))) continue;
      const key = x.issue !== undefined ? `i${x.issue}` : `d${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...(x.issue !== undefined ? { issue: x.issue } : { draft: id! }), basis: x.basis, why: x.why });
    }
    return out;
  };
  const impact: Impact = { at, mark: refs.mark, areas: a.areas, dependsOn: links(a.dependsOn), dependents: links(a.dependents), risks: a.risks, size: a.size, overlaps: a.overlaps, sensitive: a.sensitive };
  if (!ImpactSchema.safeParse(impact).success) throw bad("the architect's view has the wrong form");
  const next: Draft = { ...d, impact };
  return { ...st, drafts: st.drafts.map((y) => (y === d ? next : y)), line: { what: "architect-impact", detail: impact.size.size } };
}

export const FIT_TEXT = { fits: "likely fits in one story", "too-big": "likely too big — consider splitting", unknown: "the build limits are not known" } as const;

export type Fit =
  | { verdict: "fits"; text: string; maxFiles: number; maxCodeLines: number }
  | { verdict: "too-big"; text: string; maxFiles: number; maxCodeLines: number; over: ("files" | "lines")[] }
  | { verdict: "unknown"; text: string };
export interface PlanReview {
  topics: Impact["sensitive"][number]["topic"][];
  label?: string;
  text: string;
}

/** The estimated size against the build limits; no verdict unless both limits are known. */
export function fitOf(size: { files: number; lines: number }, limits: BuildLimits): Fit {
  const { maxFiles, maxCodeLines } = limits;
  if (typeof maxFiles !== "number" || typeof maxCodeLines !== "number") return { verdict: "unknown", text: FIT_TEXT.unknown };
  const over: ("files" | "lines")[] = [];
  if (size.files > maxFiles) over.push("files");
  if (size.lines > maxCodeLines) over.push("lines");
  const limitsText = `The build limits are ${maxFiles} files and ${maxCodeLines} lines of code.`;
  return over.length === 0
    ? { verdict: "fits", text: `${FIT_TEXT.fits}. ${limitsText}`, maxFiles, maxCodeLines }
    : { verdict: "too-big", text: `${FIT_TEXT["too-big"]}. ${limitsText}`, maxFiles, maxCodeLines, over };
}

/** A plan review by a person is recommended when the view has a sensitive topic. */
export function planReviewOf(sensitive: Impact["sensitive"], limits: BuildLimits): PlanReview | undefined {
  if (sensitive.length === 0) return undefined;
  const topics = [...new Set(sensitive.map((x) => x.topic))];
  const first = `A plan review by a person is recommended: this draft touches ${topics.join(", ")}.`;
  const label = limits.reviewLabel;
  return label ? { topics, label, text: `${first} The review label is "${label}".` } : { topics, text: `${first} There is no review label.` };
}

/** The person's choice to add the review label when the story is published. Only the person sets it; undefined when nothing changes. */
export function setReviewLabel(st: DraftState, draftId: string, input: unknown): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  const keys = typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input) : [];
  const add = keys.length === 1 && keys[0] === "add" ? (input as { add: unknown }).add : undefined;
  if (typeof add !== "boolean") throw bad("send add: true or false");
  if (add === (d.addReviewLabel === true)) return undefined;
  let next: Draft;
  if (add) next = { ...d, addReviewLabel: true };
  else {
    const { addReviewLabel: _gone, ...rest } = d;
    next = rest;
  }
  return { ...st, drafts: st.drafts.map((y) => (y === d ? next : y)) };
}

export type ImpactView = Omit<Impact, "mark" | "size"> & { size: Impact["size"] & { basis: "estimate" }; fit: Fit; planReview?: PlanReview; outOfDate?: true };

/** The stored view for the caller: no mark; `outOfDate` when the draft changed since it was asked; no links to drafts that are gone. */
export function impactView(d: Draft, drafts: Draft[], limits: BuildLimits = {}): ImpactView | undefined {
  if (!d.impact) return undefined;
  const { mark, size, dependsOn, dependents, ...rest } = d.impact;
  const planReview = planReviewOf(rest.sensitive, limits);
  const here = (l: { draft?: string }) => l.draft === undefined || drafts.some((o) => o.id === l.draft);
  return {
    ...rest,
    dependsOn: dependsOn.filter(here),
    dependents: dependents.filter(here),
    size: { ...size, basis: "estimate" },
    fit: fitOf(size, limits),
    ...(planReview ? { planReview } : {}),
    ...(draftMark(d) !== mark ? { outOfDate: true as const } : {}),
  };
}
