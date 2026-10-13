import { z } from "zod";
import type { HelpRole } from "./contract.js";

/**
 * The page context of a question: a small envelope the browser sends with it, saying where the person is and what
 * is selected there. It names things; it never carries them. The server checks its shape here (`checkEnvelope`),
 * and looks every named thing up again for the asking account before a model hears of it (`resolveContext`): what
 * the browser says about a thing is never taken as true. No imports from the store or the server.
 */

export const CONTEXT_KINDS = ["run", "issue", "repository", "queue", "refinement", "problem"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** The most the stored envelope may measure, as the length of its JSON text. */
export const CONTEXT_MAX = 4000;
/** The most selected things, visible filters, and characters of selected text that are kept. */
export const ENTITY_LIMIT = 5;
export const FILTER_LIMIT = 8;
export const SELECTION_MAX = 2000;
export const ID_MAX = 200;
export const FILTER_VALUE_MAX = 100;
/** More than this is not cut but refused: it is not what a page sends. */
export const ENVELOPE_HARD = { entities: 50, filters: 50, selection: 100_000 } as const;
/** A cut selection shorter than this is left out. */
const SELECTION_MIN = 20;

/** The parts of the envelope, in the order they are kept when there is not room for all. */
export const CONTEXT_PRIORITY = ["page", "entities", "filters", "selection"] as const;
export type ContextPart = (typeof CONTEXT_PRIORITY)[number];

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
/** A tag of HTML or XML, a comment or a doctype. */
const MARKUP = /<\s*(?:\/\s*)?[A-Za-z!?][^<>]{0,2000}>/;
/** A place in a file system: absolute, relative with dots, a home folder, a drive, or a `file:` address. */
const FILE_PATH = /^(?:[/\\~]|\.{1,2}(?:[/\\]|$)|[A-Za-z]:[/\\]|file:)|(?:^|[/\\])\.\.(?:[/\\]|$)|\\/i;
/** Names a filter may not have: who owns a thing, what an account may do, and anything secret. */
const FORBIDDEN_NAME = /owner|role|permission|admin|access|token|password|passwd|secret|credential|cookie|auth|session|key/i;

const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL.test(s) && !MARKUP.test(s) && !FILE_PATH.test(s) && s.trim() === s);

const EntitySchema = z.object({ kind: z.enum(CONTEXT_KINDS), id: plain(ID_MAX) }).strict();
export type EntityRef = z.infer<typeof EntitySchema>;

/**
 * The envelope as it is stored with a question. `kind` and `id` are the one selected thing of the first version
 * and stay valid; `entities` holds more of them. Strict: a field that is not listed (an owner, a role, a permission,
 * a copy of a record, markup) makes the whole envelope invalid.
 */
export const ContextSchema = z
  .object({
    /** The address of the page in the interface, "#/…", without a query. */
    page: z.string().min(2).max(200).regex(/^#\/[A-Za-z0-9._~%:/-]*$/),
    kind: z.enum(CONTEXT_KINDS).optional(),
    /** As the first version stored it; `checkEnvelope` holds a new one to the rules of `plain`. */
    id: z.string().min(1).max(ID_MAX).refine((s) => !CONTROL.test(s)).optional(),
    entities: z.array(EntitySchema).min(1).max(ENTITY_LIMIT).optional(),
    /** The filters the page shows, by name. */
    filters: z.record(z.string().regex(/^[a-z][A-Za-z0-9_-]{0,29}$/).refine((k) => !FORBIDDEN_NAME.test(k)), plain(FILTER_VALUE_MAX)).refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= FILTER_LIMIT).optional(),
    /** Text the person marked on the page. Plain text, never markup. */
    selection: z.string().min(1).max(SELECTION_MAX + 2).refine((s) => !CONTROL_IN_TEXT.test(s) && !MARKUP.test(s)).optional(),
    /** The parts that were cut to fit, in the order of `CONTEXT_PRIORITY`. Written by the server only. */
    truncated: z.array(z.enum(CONTEXT_PRIORITY)).min(1).max(CONTEXT_PRIORITY.length).optional(),
  })
  .strict()
  .refine((c) => (c.kind === undefined) === (c.id === undefined), { message: "a selection has a kind and an id", path: ["id"] });
export type PageContext = z.infer<typeof ContextSchema>;

export const BAD_CONTEXT =
  'the page context must be a page of the Foundry ("#/…") and, at most, the kind and id of the things selected on it, the filters the page shows and the text you marked; it cannot hold an owner, a permission, a secret, markup or a file path';

export class ContextError extends Error {
  constructor(message = BAD_CONTEXT) {
    super(message);
    this.name = "ContextError";
  }
}

/** The size of an envelope as it is measured against `CONTEXT_MAX`. */
export const contextSize = (c: PageContext): number => JSON.stringify(c).length;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Checks what a browser sent and returns the envelope that is kept, or undefined when none was sent. Throws
 * `ContextError` for anything that is not an envelope. What is too much is cut, not refused, by these rules:
 *
 * 1. The page is always kept.
 * 2. The selected things, in the order sent, without doubles: at most `ENTITY_LIMIT`.
 * 3. The filters, in the order sent: at most `FILTER_LIMIT`.
 * 4. The marked text: at most `SELECTION_MAX` characters, and less when the envelope would pass `CONTEXT_MAX`.
 *
 * A later part never pushes out an earlier one. `truncated` names the parts that lost something. `truncated` from
 * the browser is refused: only the server writes it.
 */
export function checkEnvelope(input: unknown): PageContext | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isObject(input) || "truncated" in input) throw new ContextError();
  const { entities, filters, selection, ...head } = input;
  const cut = new Set<ContextPart>();
  const fits = (c: PageContext) => contextSize(c) <= CONTEXT_MAX - 60; // room for `truncated`
  const parse = (v: unknown): PageContext => {
    const r = ContextSchema.safeParse(v);
    if (!r.success) throw new ContextError();
    return r.data;
  };
  let out = parse(head);
  if (/(?:^|\/)\.\.(?:\/|$)/.test(out.page) || (out.id !== undefined && !plain(ID_MAX).safeParse(out.id).success)) throw new ContextError();

  if (entities !== undefined) {
    if (!Array.isArray(entities) || entities.length === 0 || entities.length > ENVELOPE_HARD.entities) throw new ContextError();
    const kept: EntityRef[] = [];
    for (const raw of entities) {
      const e = EntitySchema.safeParse(raw);
      if (!e.success) throw new ContextError();
      if ((out.kind === e.data.kind && out.id === e.data.id) || kept.some((k) => k.kind === e.data.kind && k.id === e.data.id)) continue;
      if (kept.length >= ENTITY_LIMIT || !fits({ ...out, entities: [...kept, e.data] })) cut.add("entities");
      else kept.push(e.data);
    }
    if (kept.length) out = { ...out, entities: kept };
  }

  if (filters !== undefined) {
    if (!isObject(filters) || Object.keys(filters).length === 0 || Object.keys(filters).length > ENVELOPE_HARD.filters) throw new ContextError();
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(filters)) {
      // every filter is checked, also the ones that are then cut
      parse({ page: out.page, filters: { [k]: v } });
      if (Object.keys(kept).length >= FILTER_LIMIT || !fits({ ...out, filters: { ...kept, [k]: v as string } })) cut.add("filters");
      else kept[k] = v as string;
    }
    if (Object.keys(kept).length) out = { ...out, filters: kept };
  }

  if (selection !== undefined) {
    if (typeof selection !== "string" || selection.length > ENVELOPE_HARD.selection) throw new ContextError();
    const text = selection.replace(/\r\n?/g, "\n").trim();
    if (CONTROL_IN_TEXT.test(text) || MARKUP.test(text)) throw new ContextError();
    if (text) {
      // a JSON text is longer than its string: measure what would be stored
      const room = (n: number) => fits({ ...out, selection: `${text.slice(0, n)} …` });
      let n = Math.min(text.length, SELECTION_MAX);
      while (n >= SELECTION_MIN && !room(n)) n = Math.floor(n * 0.9);
      if (n < text.length) cut.add("selection");
      if (n === text.length) out = { ...out, selection: text };
      else if (n >= SELECTION_MIN) out = { ...out, selection: `${text.slice(0, n)} …` };
    }
  }

  const truncated = CONTEXT_PRIORITY.filter((p) => cut.has(p));
  return parse(truncated.length ? { ...out, truncated } : out);
}

// ---- which page it is --------------------------------------------------------------------------------

export interface HelpPage {
  id: string;
  /** The address, with `:name` for the one variable part. */
  path: string;
  title: string;
  roles: HelpRole[];
  /** What the variable part of the address names, when the server can look it up. */
  entity?: ContextKind;
}

const A: HelpRole[] = ["admin"];
const AU: HelpRole[] = ["admin", "user"];
const admin = (id: string, title: string): HelpPage => ({ id, path: `#/${id}`, title, roles: A });

/**
 * Every page of the interface, for both roles: the same ids, addresses and roles as `ui/ia.js` (a test compares
 * them). A page tells the server which one it is with its address alone.
 */
export const HELP_PAGES: readonly HelpPage[] = [
  { id: "home", path: "#/home", title: "Home", roles: AU },
  { id: "board", path: "#/board", title: "Board", roles: A },
  { id: "board-repo", path: "#/board/:id", title: "Board of one repository", roles: A },
  { id: "refinement", path: "#/refinement", title: "Refinement", roles: AU },
  { id: "refinement-backlog", path: "#/refinement/backlog", title: "Backlog readiness", roles: AU },
  { id: "refinement-session", path: "#/refinement/:id", title: "Refinement session", roles: AU, entity: "refinement" },
  { id: "start", path: "#/start", title: "Start work", roles: AU },
  { id: "runs", path: "#/runs", title: "Runs", roles: AU },
  { id: "run", path: "#/runs/:id", title: "Run", roles: AU, entity: "run" },
  { id: "repos", path: "#/repos", title: "My repositories", roles: AU },
  { id: "repo", path: "#/repos/:id", title: "Repository", roles: AU, entity: "repository" },
  { id: "flows", path: "#/flows", title: "Flows", roles: A },
  { id: "flow", path: "#/flows/:name", title: "Flow", roles: A },
  { id: "new-flow", path: "#/new", title: "New flow", roles: A },
  { id: "library", path: "#/library", title: "Library", roles: A },
  admin("operations", "Overview"),
  admin("problems", "Problems"),
  admin("watchers", "Watchers"),
  { id: "problem", path: "#/problems/:id", title: "Problem", roles: A, entity: "problem" },
  { id: "watcher", path: "#/watchers/:id", title: "Watcher", roles: A },
  admin("models", "Models"),
  { id: "model", path: "#/models/:name", title: "Model", roles: A },
  admin("dashboard", "Dashboard"),
  admin("users", "Users"),
  { id: "user", path: "#/users/:id", title: "User", roles: A },
  admin("all-repos", "All repositories"),
  admin("credentials", "Credentials"),
  admin("audit", "Audit"),
  admin("settings", "Settings"),
  admin("maintenance", "Maintenance"),
];

/** Old addresses that still open a page. */
export const HELP_ALIASES: readonly { from: string; to: string; roles: HelpRole[] }[] = [{ from: "#/your-turn", to: "#/home", roles: A }];

export interface FoundPage {
  page: HelpPage;
  /** The variable part of the address, decoded. */
  arg?: string;
}

/**
 * The page an address is for a role, or undefined: an address that no page has (an old or a made-up one), and a
 * page the role does not have. Both are the same answer.
 */
export function pageOf(route: string, role: HelpRole): FoundPage | undefined {
  const alias = HELP_ALIASES.find((a) => a.from === route && a.roles.includes(role));
  const parts = (alias?.to ?? route).split("/");
  if (parts[0] !== "#" || parts.length < 2 || parts.length > 3 || parts.some((p, i) => i > 0 && p === "")) return undefined;
  for (const page of HELP_PAGES) {
    if (!page.roles.includes(role)) continue;
    const pat = page.path.split("/");
    if (pat.length !== parts.length || pat[1] !== parts[1]) continue;
    if (pat.length === 2) return { page };
    if (pat[2] === parts[2]) return { page };
    if (!pat[2]!.startsWith(":")) continue;
    let arg: string;
    try {
      arg = decodeURIComponent(parts[2]!);
    } catch {
      return undefined;
    }
    return { page, arg };
  }
  return undefined;
}

// ---- looking things up again -------------------------------------------------------------------------

export interface Asker {
  id: string;
  role: HelpRole;
}

/** A thing the server found for the asking account. `label` is the server's own short name for it. */
export interface FoundEntity extends EntityRef {
  label?: string;
}

/**
 * Looks one named thing up for an account, by the rules the API itself uses. Undefined for a thing that does not
 * exist and for one the account may not see: the two are never told apart.
 */
export type EntityResolver = (asker: Asker, ref: EntityRef) => { label?: string } | undefined;

/** What the server itself established about an envelope. This, not the envelope, is what a model is told. */
export interface ResolvedContext {
  /** The page, when the address is one the role has; else null. */
  page: { id: string; title: string; route: string } | null;
  /** The things that were found for this account, in the order of the envelope. */
  entities: FoundEntity[];
  /** How many named things were not found for this account. Not which, and not why. */
  notFound: number;
  filters: Record<string, string>;
  selection?: string;
  truncated: ContextPart[];
}

const safeLabel = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, ID_MAX) : undefined);

/**
 * What an envelope is worth for one account, now. Every thing it names (the one of the address, the selected ones)
 * is looked up again with `resolve`; one that is not found is left out and only counted. Without a resolver nothing
 * is found. A resolver that throws finds nothing. An address the role has no page for gives no page; its filters
 * are then left out too, since nobody knows what they filter.
 */
export function resolveContext(asker: Asker, context: PageContext | undefined, resolve?: EntityResolver): ResolvedContext | undefined {
  if (!context) return undefined;
  const found = pageOf(context.page, asker.role);
  const asked: EntityRef[] = [];
  const add = (e: EntityRef) => {
    if (!asked.some((x) => x.kind === e.kind && x.id === e.id)) asked.push(e);
  };
  if (found?.page.entity && found.arg !== undefined && EntitySchema.safeParse({ kind: found.page.entity, id: found.arg }).success) add({ kind: found.page.entity, id: found.arg });
  if (context.kind !== undefined && context.id !== undefined) add({ kind: context.kind, id: context.id });
  for (const e of context.entities ?? []) add(e);
  const entities: FoundEntity[] = [];
  let notFound = 0;
  for (const ref of asked.slice(0, ENTITY_LIMIT + 2)) {
    let hit: { label?: string } | undefined;
    try {
      hit = resolve?.(asker, ref);
    } catch {
      hit = undefined;
    }
    if (!hit) notFound++;
    else entities.push({ kind: ref.kind, id: ref.id, ...(safeLabel(hit.label) ? { label: safeLabel(hit.label) } : {}) });
  }
  return {
    // a page with a thing in its address that was not found is told as its list page would be: by its type only
    page: found ? { id: found.page.id, title: found.page.title, route: found.arg === undefined || entities.some((e) => e.kind === found.page.entity && e.id === found.arg) ? context.page : found.page.path } : null,
    entities,
    notFound,
    filters: found ? { ...(context.filters ?? {}) } : {},
    ...(context.selection !== undefined ? { selection: context.selection } : {}),
    truncated: [...(context.truncated ?? [])],
  };
}
