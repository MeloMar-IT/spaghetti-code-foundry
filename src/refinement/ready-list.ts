import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RepoError } from "../auth/repo-url.js";
import { chars } from "./talk.js";

/** The rule keys of the default items. Later parts use them to pick the check. */
export const READY_RULES = ["value", "standalone", "checkable", "small", "no-open-questions", "out-of-scope", "no-plan"] as const;
export type ReadyRule = (typeof READY_RULES)[number];

export interface ReadyItem {
  id: string;
  text: string;
  rule?: ReadyRule;
}

export const READY_MIN = 1;
export const READY_MAX = 20;
export const READY_TEXT_MAX = 200;

/** The list of a repository with nothing stored. Each default item has `id === rule`. */
export const DEFAULT_READY: readonly ReadyItem[] = [
  { id: "value", text: "the value is clear (who and why)", rule: "value" },
  { id: "standalone", text: "it stands on its own or its dependencies are named", rule: "standalone" },
  { id: "checkable", text: "every acceptance criterion can be checked", rule: "checkable" },
  { id: "small", text: "it is small enough to build in one go", rule: "small" },
  { id: "no-open-questions", text: "there are no open questions", rule: "no-open-questions" },
  { id: "out-of-scope", text: "it says what is out of scope", rule: "out-of-scope" },
  { id: "no-plan", text: "it contains no implementation plan", rule: "no-plan" },
];

const isRule = (id: string): id is ReadyRule => (READY_RULES as readonly string[]).includes(id);
const copyOf = (items: readonly ReadyItem[]): ReadyItem[] => items.map((i) => ({ ...i }));

/** The line separator and the paragraph separator (U+2028, U+2029) are line breaks too. */
const LS_PS = String.fromCharCode(0x2028, 0x2029);
const NOT_ONE_LINE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${LS_PS}]`);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const ID_RE = /^[a-z0-9-]{1,40}$/;

const same = (text: string) => text.toLowerCase();

export const ReadyListSchema = z
  .array(
    z
      .object({
        id: z.string().regex(ID_RE),
        text: z.string().refine((t) => t === t.trim() && chars(t) >= 1 && chars(t) <= READY_TEXT_MAX && !NOT_ONE_LINE.test(t)),
        rule: z.enum(READY_RULES).optional(),
      })
      .strict(),
  )
  .min(READY_MIN)
  .max(READY_MAX)
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    const texts = new Set<string>();
    items.forEach((it, i) => {
      if (ids.has(it.id)) ctx.addIssue({ code: "custom", message: "duplicate id", path: [i, "id"] });
      ids.add(it.id);
      if (texts.has(same(it.text))) ctx.addIssue({ code: "custom", message: "duplicate text", path: [i, "text"] });
      texts.add(same(it.text));
      if (isRule(it.id) ? it.rule !== it.id : it.rule !== undefined) ctx.addIssue({ code: "custom", message: "invalid rule", path: [i, "rule"] });
    });
  });

const bad = (message: string) => new RepoError("bad-ready", message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The stored list, or a copy of the default. */
export const readyListOf = (stored: readonly ReadyItem[] | undefined): ReadyItem[] => copyOf(stored ?? DEFAULT_READY);

/** What the API shows: the list and whether it is the default. */
export const readyView = (stored: readonly ReadyItem[] | undefined) => ({ items: readyListOf(stored), isDefault: stored === undefined });

/**
 * Checks the body of a change and returns the list to store, or `undefined` for the default (nothing is stored).
 * `current` is the list of the repository now: an `id` it has, or the id of a default item, is known.
 * Throws RepoError "bad-ready" with one plain sentence.
 */
export function checkReadyList(input: unknown, current: readonly ReadyItem[]): ReadyItem[] | undefined {
  if (!isObject(input) || Object.keys(input).some((k) => k !== "items")) throw bad('the body must be an object with "items"');
  const items = input.items;
  if (items === null) return undefined;
  if (!Array.isArray(items)) throw bad('"items" must be a list, or null for the default');
  if (items.length < READY_MIN) throw bad(`the list needs at least ${READY_MIN} item`);
  if (items.length > READY_MAX) throw bad(`the list may have at most ${READY_MAX} items`);
  const known = new Set<string>([...current.map((i) => i.id), ...READY_RULES]);
  const seen = new Set<string>();
  const entries: { id?: string; text: string }[] = [];
  for (const raw of items as unknown[]) {
    if (!isObject(raw)) throw bad("every item must be an object with a text");
    // a sent `rule` is ignored, so the answer of the GET can be sent back
    if (Object.keys(raw).some((k) => k !== "id" && k !== "text" && k !== "rule")) throw bad("an item may only have an id and a text");
    if (typeof raw.text !== "string") throw bad("the text of an item must be text");
    if (NOT_ONE_LINE.test(raw.text)) throw bad("an item must be one line without control characters");
    const text = raw.text.trim();
    if (!text) throw bad("an item may not be empty");
    if (chars(text) > READY_TEXT_MAX) throw bad(`an item may be at most ${READY_TEXT_MAX} characters`);
    let id: string | undefined;
    // only a missing id makes a new item
    if (raw.id !== undefined) {
      if (typeof raw.id !== "string") throw bad("the id of an item must be text");
      if (!known.has(raw.id)) throw bad(`unknown item id "${raw.id.slice(0, 40).replace(CONTROL, "?")}"`);
      if (seen.has(raw.id)) throw bad(`the item id "${raw.id}" is given twice`);
      seen.add(raw.id);
      id = raw.id;
    }
    entries.push({ id, text });
  }
  if (new Set(entries.map((e) => same(e.text))).size !== entries.length) throw bad("two items have the same text");
  const taken = new Set<string>([...current.map((i) => i.id), ...seen]);
  const list: ReadyItem[] = entries.map(({ id, text }) => {
    if (id !== undefined) return isRule(id) ? { id, text, rule: id } : { id, text };
    let fresh = "";
    do fresh = `c-${randomUUID().slice(0, 8)}`;
    while (taken.has(fresh));
    taken.add(fresh);
    return { id: fresh, text };
  });
  return isDeepStrictEqual(list, DEFAULT_READY) ? undefined : list;
}
