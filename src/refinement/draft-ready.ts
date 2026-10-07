import { createHash } from "node:crypto";
import {
  LONG_TEXT_MAX,
  READY_RESULTS,
  REASON_MAX,
  SUGGEST_FIELDS,
  bad,
  checkText,
  isObject,
  keysAre,
  oneLine,
  strictSentenceCount,
  type Accepted,
  type Draft,
  type DraftChange,
  type DraftState,
  type Readiness,
  type SuggestField,
} from "./draft.js";
import { draftRemarks, type RemarkField } from "./draft-check.js";
import { RefinementError } from "./errors.js";
import type { ReadyItem } from "./ready-list.js";
import { cut, type Talk } from "./talk.js";

type Result = Readiness["items"][number]["result"];

// ---- the questions of the map ----------------------------------------------------------------------

/** How many questions of the talk wait for an answer. */
export const waitingCount = (talk: Talk | undefined): number => (talk?.rounds ?? []).reduce((n, r) => n + r.questions.filter((q) => !q.answer).length, 0);

/** What the check `no-open-questions` reads: the open entries of the map and the number of waiting questions. A change of it clears every check. */
export const openMark = (talk: Talk | undefined): string => JSON.stringify([(talk?.map.open ?? []).map((e) => [e.id, e.text]), waitingCount(talk)]);

// ---- the code checks -------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const FIELD_WORDS: Record<RemarkField, string> = {
  title: "The title",
  who: 'The "As …" part',
  what: 'The "I want …" part',
  why: 'The "so that …" part',
  criteria: "An acceptance criterion",
  outOfScope: "Out of scope",
};
const JUDGE = "The architect has to judge";

/** The text of an item as one sentence: a stop, question mark or exclamation mark before a space would start another one. */
const inOneSentence = (t: string): string => t.replace(/[.!?]+(?=\s)/g, "").replace(/\s+/g, " ");

function judge(item: ReadyItem, d: Draft, st: DraftState, talk: Talk | undefined): { result: Result; reason: string } {
  const met = (reason: string) => ({ result: "met" as const, reason });
  const notMet = (reason: string) => ({ result: "not-met" as const, reason });
  const unsure = (what: string) => ({ result: "unsure" as const, reason: `${JUDGE} ${what}.` });
  switch (item.rule) {
    case "no-open-questions": {
      const open = talk?.map.open.length ?? 0;
      const waiting = waitingCount(talk);
      if (!open && !waiting) return met("The map has no open question and no question waits for an answer.");
      return notMet(`The map has ${plural(open, "open question", "open questions")} and ${plural(waiting, "question", "questions")} ${waiting === 1 ? "waits" : "wait"} for an answer.`);
    }
    case "out-of-scope":
      return d.outOfScope ? met("Out of scope has text.") : notMet("Out of scope is empty.");
    case "checkable":
      return d.criteria.length ? unsure("whether each acceptance criterion can be checked") : notMet("The acceptance criteria are empty, so there is nothing to check.");
    case "value": {
      if (!d.who && !d.why) return notMet('The "As …" and "so that …" parts are empty.');
      if (!d.who) return notMet('The "As …" part is empty.');
      if (!d.why) return notMet('The "so that …" part is empty.');
      return unsure('whether "As …" and "so that …" make the value clear');
    }
    case "standalone": {
      const ids = new Set(st.drafts.map((x) => x.id));
      if (d.dependsOn.some((x) => x.draft === d.id)) return notMet("Depends on names the draft itself.");
      if (d.dependsOn.some((x) => x.draft !== undefined && !ids.has(x.draft))) return notMet("Depends on names a draft that is gone.");
      return unsure("whether Depends on names everything this story needs");
    }
    case "no-plan": {
      const r = draftRemarks(d).find((x) => x.kind === "plan");
      if (r) return notMet(`${FIELD_WORDS[r.field]} reads like an implementation plan ("${r.word.split(/(?<=[.!?])\s/)[0]}").`);
      return unsure("whether the draft contains an implementation plan");
    }
    case "small":
      return unsure("whether the whole draft is small enough to build in one go");
    default:
      return unsure(`the item "${inOneSentence(item.text)}" against the whole draft, because code cannot check it`);
  }
}

/** The result of the readiness check for this draft: one entry per item of the list, by code. Nothing but `readiness` changes. */
export function checkReady(st: DraftState, talk: Talk | undefined, draftId: string, list: readonly ReadyItem[], at: string): DraftChange {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  const items = list.map((item) => ({ id: item.id, text: item.text, ...judge(item, d, st, talk), by: "code" as const })).map((i) => ({ ...i, reason: cut(i.reason, REASON_MAX) }));
  const count = (r: Result) => items.filter((i) => i.result === r).length;
  const next: Draft = { ...d, readiness: { at, items } };
  return { ...st, drafts: st.drafts.map((x) => (x === d ? next : x)), line: { what: "ready-checked", detail: `${count("met")} met, ${count("not-met")} not met, ${count("unsure")} unsure` } };
}

// ---- results and marks against the list as it is now -----------------------------------------------

/** The result of the last check for this item, only when the item has the same id and the same text as then. */
const resultOf = (d: Draft, item: ReadyItem) => d.readiness?.items.find((r) => r.id === item.id && r.text === item.text);
/** The mark "accepted anyway" for this item as it is now; never for the implementation plan item. */
const markOf = (d: Draft, item: ReadyItem): Accepted | undefined => (item.rule === "no-plan" ? undefined : d.acceptedAnyway?.find((a) => a.id === item.id && a.text === item.text));

/**
 * A draft is ready when it has a check and every item of the list as it is now has a result of that check that is `met`, or a valid
 * "accepted anyway" mark. An item that is new or reworded since the check has no result, so only a new check makes the draft ready.
 * Publishing must call this again with the current list and must not trust the stored state of the session.
 */
export const isReady = (d: Draft, list: readonly ReadyItem[]): boolean => !d.splitInto && d.readiness !== undefined && list.every((item) => (resultOf(d, item) ? resultOf(d, item)!.result === "met" || markOf(d, item) !== undefined : false));

/** Why a draft is not ready for this list, as a short sentence; undefined exactly when `isReady(d, list)` is true. */
export function notReadyReason(d: Draft, list: readonly ReadyItem[]): string | undefined {
  if (isReady(d, list)) return undefined;
  if (d.splitInto) return "it is split; its parts are published instead";
  if (!d.readiness) return "it has no readiness check yet";
  if (list.some((item) => !resultOf(d, item))) return "the Definition of Ready changed since the check; check readiness again";
  const n = list.filter((item) => resultOf(d, item)!.result !== "met" && markOf(d, item) === undefined).length;
  return `${n === 1 ? "1 item" : `${n} items`} of the Definition of Ready ${n === 1 ? "is" : "are"} not met`;
}

/** The check for the view: only the items of the list as it is now; `stale` when an item has no result (new or reworded since). */
export function readinessView(d: Draft, list: readonly ReadyItem[]): { at: string; items: Readiness["items"]; stale?: true } | undefined {
  if (!d.readiness) return undefined;
  // `about` stays in the file: the view shows the result, field and criterion, not the text again.
  const items = list.flatMap((item) => {
    const r = resultOf(d, item);
    if (!r) return [];
    const { about: _about, ...shown } = r;
    return [shown];
  });
  return { at: d.readiness.at, items, ...(items.length < list.length ? { stale: true as const } : {}) };
}

/** The marks that count now (item still in the list with the same text), for the view. `notNeeded`: the last check says the item is met. */
export const acceptedView = (d: Draft, list: readonly ReadyItem[]): { id: string; text: string; reason: string; notNeeded?: true }[] =>
  list.flatMap((item) => {
    const m = markOf(d, item);
    if (!m) return [];
    return [{ id: m.id, text: m.text, reason: m.reason, ...(resultOf(d, item)?.result === "met" ? { notNeeded: true as const } : {}) }];
  });

/** The lines of the section "Accepted anyway" of the published story: the marks that count and are needed. */
export const acceptedLines = (d: Draft, list: readonly ReadyItem[]): { text: string; reason: string }[] => acceptedView(d, list).filter((a) => !a.notNeeded).map(({ text, reason }) => ({ text, reason }));

// ---- accepted anyway -------------------------------------------------------------------------------

function checkReason(input: unknown): string {
  const bad = (m: string) => new RefinementError("bad-text", m);
  if (!isObject(input) || typeof input.reason !== "string") throw bad("give a reason");
  let t: string;
  try {
    t = checkText(input.reason, "reason", REASON_MAX, true);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : "the reason is not allowed");
  }
  if (!t) throw bad("give a reason");
  return t;
}

/** The person accepts an item anyway, with a reason. Marks of items that are gone or reworded are dropped. Undefined when nothing changes. */
export function acceptAnyway(st: DraftState, draftId: string, itemId: string, input: unknown, list: readonly ReadyItem[], at: string): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  const item = list.find((x) => x.id === itemId);
  if (!item) throw new RefinementError("not-found", "no such item in the Definition of Ready");
  if (item.rule === "no-plan") throw new RefinementError("bad-state", "an implementation plan cannot be accepted anyway; move the text to the notes or reword it");
  const reason = checkReason(input);
  const old = d.acceptedAnyway ?? [];
  const kept = old.filter((a) => list.some((x) => x.id === a.id && x.text === a.text));
  const prev = kept.find((a) => a.id === item.id && a.text === item.text && a.reason === reason);
  const mark = prev ?? { id: item.id, text: item.text, reason, at };
  const at0 = kept.findIndex((a) => a.id === item.id);
  const acceptedAnyway = at0 < 0 ? [...kept, mark] : kept.map((a, i) => (i === at0 ? mark : a));
  if (JSON.stringify(acceptedAnyway) === JSON.stringify(old)) return undefined;
  const next: Draft = { ...d, acceptedAnyway };
  return { ...st, drafts: st.drafts.map((x) => (x === d ? next : x)), line: { what: "ready-accepted", detail: item.text } };
}

/** The mark of an item is removed. Undefined when there is none. */
export function removeAccepted(st: DraftState, draftId: string, itemId: string, list: readonly ReadyItem[]): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  if (!list.some((x) => x.id === itemId)) throw new RefinementError("not-found", "no such item in the Definition of Ready");
  const mark = d.acceptedAnyway?.find((a) => a.id === itemId);
  if (!mark) return undefined;
  const { acceptedAnyway: _gone, ...rest } = d;
  const left = d.acceptedAnyway!.filter((a) => a !== mark);
  const next: Draft = left.length ? { ...rest, acceptedAnyway: left } : rest;
  return { ...st, drafts: st.drafts.map((x) => (x === d ? next : x)), line: { what: "ready-unaccepted", detail: mark.text } };
}

// ---- what clears a check ---------------------------------------------------------------------------

/** What the preview and the code checks read from a draft. A change of it clears the check. The marks and the architect's notes are not part of it. */
const contentKey = (d: Draft): string =>
  JSON.stringify([d.title?.text, d.who?.text, d.what?.text, d.why?.text, d.criteria.map((c) => c.text), d.outOfScope?.text, d.dependsOn.map((x) => [x.issue, x.draft]), d.notes?.text]);

const dropReadiness = (d: Draft): Draft => {
  if (!d.readiness) return d;
  const { readiness: _gone, ...rest } = d;
  return rest;
};

/** The drafts without any check results. */
export const clearAll = (drafts: Draft[]): Draft[] => drafts.map(dropReadiness);

/** The drafts after a change: the check of a draft whose text changed (or is new) is gone; an Epic change clears every draft. */
export function clearChanged(before: DraftState, after: DraftState): Draft[] {
  if (before.epic !== after.epic) return clearAll(after.drafts);
  const old = new Map(before.drafts.map((d) => [d.id, d]));
  return after.drafts.map((d) => {
    const o = old.get(d.id);
    return o && contentKey(o) === contentKey(d) ? d : dropReadiness(d);
  });
}

/**
 * The state of a session with these drafts: the first draft starts the drafting, no draft left is exploring again, and a session with
 * at least one draft is `ready` when every draft is ready for the list, else `drafting`. A split draft is left out of that: its parts
 * count instead. Other states stay.
 */
export function sessionState<T extends string>(cur: T, hadDrafts: boolean, drafts: Draft[], list: readonly ReadyItem[]): T | "exploring" | "drafting" | "ready" {
  let state: string = cur;
  if (state === "exploring" && !hadDrafts && drafts.length) state = "drafting";
  else if ((state === "drafting" || state === "ready") && hadDrafts && !drafts.length) state = "exploring";
  const live = drafts.filter((d) => !d.splitInto);
  if (state === "drafting" || state === "ready") state = live.length && live.every((d) => isReady(d, list)) ? "ready" : "drafting";
  return state as T;
}

// ---- the architect judges what code could not decide -----------------------------------------------

/**
 * What a readiness run was about, read back from the head of its task: the mark of the draft and the map as the architect saw them,
 * the items it was asked to judge (id and text) and the ids behind the criteria numbers C1, C2, … that were in the text.
 */
export interface ReadyRefs {
  mark: string;
  items: [string, string][];
  criteria: Record<string, string>;
}

/**
 * A mark of everything the architect reads for a readiness check: the fields of the draft (a criterion with its id), what it depends
 * on, the notes, and the rules, examples and open questions of the map. A change of any of it changes the mark.
 */
export function readyMark(d: Draft, talk: Talk | undefined, drafts: readonly Draft[]): string {
  const title = (id?: string) => (id === undefined ? undefined : (drafts.find((x) => x.id === id)?.title?.text ?? null));
  const map = talk?.map;
  const key = JSON.stringify([
    d.id,
    d.title?.text,
    d.who?.text,
    d.what?.text,
    d.why?.text,
    d.criteria.map((c) => [c.id, c.text]),
    d.outOfScope?.text,
    d.dependsOn.map((x) => [x.issue, x.draft, title(x.draft)]),
    d.notes?.text,
    [map?.rules ?? [], map?.examples ?? [], map?.open ?? []].map((l) => l.map((e) => [e.id, e.text])),
  ]);
  return createHash("sha256").update(key).digest("hex");
}

/** The items the code check left `unsure`: they are the ones the architect judges. */
export const unsureByCode = (d: Draft): { id: string; text: string }[] =>
  (d.readiness?.items ?? []).filter((i) => i.by === "code" && i.result === "unsure").map((i) => ({ id: i.id, text: i.text }));

const FIELD_SET: readonly string[] = SUGGEST_FIELDS;
const RESULT_SET: readonly string[] = READY_RESULTS;

/**
 * The end of a readiness run: the checked answer `{ items }` becomes the results of the items code left `unsure`, as results of the
 * architect. Nothing else changes: no field, no "accepted anyway" mark, no result of code. Throws bad-draft for a wrong form (also a
 * result for an item whose stored result is not an `unsure` of code, or a criterion that is not in the task). Undefined when the draft
 * is gone; "changed" when the draft or the map is not the one the architect saw (or the check is gone). An item that is gone from the
 * list or reworded there, or was checked again with other text, is skipped: it gets no result.
 */
export function setJudged(st: DraftState, talk: Talk | undefined, draftId: string, output: unknown, refs: ReadyRefs | undefined, list: readonly ReadyItem[]): DraftChange | undefined | "changed" {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) return undefined;
  if (!refs) throw bad("the readiness run has no head lines");
  if (!d.readiness || readyMark(d, talk, st.drafts) !== refs.mark) return "changed";
  if (!isObject(output) || !keysAre(output, "items") || !Array.isArray(output.items)) throw bad("the results have the wrong form");
  const asked = refs.items;
  if (output.items.length !== asked.length) throw bad("there is not one result for every asked item");
  const given = new Map<string, { result: Result; reason: string; field: SuggestField; criterion?: string }>();
  for (const x of output.items as unknown[]) {
    if (!isObject(x) || typeof x.id !== "string" || !asked.some(([id]) => id === x.id) || given.has(x.id)) throw bad("a result names an item that was not asked, or names it twice");
    if (typeof x.result !== "string" || !RESULT_SET.includes(x.result)) throw bad("a result has no result of met, not-met or unsure");
    if (typeof x.field !== "string" || !FIELD_SET.includes(x.field)) throw bad("a result names a field of the draft");
    if (!keysAre(x, "id", "result", "reason", "field", ...(x.item !== undefined ? ["item"] : []))) throw bad("a result has an id, a result, a reason and a field");
    let criterion: string | undefined;
    if (x.item !== undefined) {
      const known = typeof x.item === "string" ? refs.criteria[x.item] : undefined;
      if (x.field !== "criteria" || known === undefined || !d.criteria.some((c) => c.id === known)) throw bad("a result names a criterion that is not in the draft");
      criterion = known;
    }
    const reason = checkText(x.reason, "reason", REASON_MAX, true);
    if (!reason) throw bad("a result needs a reason");
    if (strictSentenceCount(reason) > 1) throw bad("a reason is one sentence");
    given.set(x.id, { result: x.result as Result, reason, field: x.field as SuggestField, ...(criterion !== undefined ? { criterion } : {}) });
  }
  const done = new Map<string, Readiness["items"][number]>();
  for (const [id, text] of asked) {
    const stored = d.readiness.items.find((i) => i.id === id);
    if (!stored || stored.text !== text) continue;
    if (stored.by !== "code" || stored.result !== "unsure") throw bad("a result is for an item that code did not leave unsure");
    if (!list.some((i) => i.id === id && i.text === text)) continue;
    const g = given.get(id)!;
    // The text the result points at, as the architect saw it; "(empty)" when there is none.
    let about: string | undefined;
    if (g.criterion !== undefined) about = d.criteria.find((c) => c.id === g.criterion)?.text;
    else if (g.field === "criteria") about = d.criteria.map((c) => c.text).join("\n");
    else if (g.field === "dependsOn") about = d.dependsOn.map((x) => (x.issue !== undefined ? `#${x.issue}` : `draft ${oneLine(st.drafts.find((o) => o.id === x.draft)?.title?.text ?? "(no title)")}`)).join("\n");
    else about = d[g.field]?.text;
    done.set(id, { ...stored, result: g.result, reason: g.reason, by: "architect", field: g.field, ...(g.criterion !== undefined ? { item: g.criterion } : {}), about: cut(about || "(empty)", LONG_TEXT_MAX) });
  }
  const count = (r: Result) => [...done.values()].filter((i) => i.result === r).length;
  const next: Draft = { ...d, readiness: { ...d.readiness, items: d.readiness.items.map((i) => done.get(i.id) ?? i) } };
  return { ...st, drafts: st.drafts.map((x) => (x === d ? next : x)), line: { what: "architect-judged", detail: `${count("met")} met, ${count("not-met")} not met, ${count("unsure")} unsure` } };
}
