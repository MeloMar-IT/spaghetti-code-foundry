import type { Config } from "../config.js";
import { CONTEXT_CONSUMERS } from "../context/schema.js";
import { CONTEXT_RULES, ContextSelectorSettingsSchema } from "../context/select.js";
import { sha256Hex } from "../evidence/identity.js";
import { isPublished } from "../flow/publish.js";
import type { Flow } from "../flow/schema.js";
import { canonicalJson } from "../policy/evaluate.js";

/**
 * The parts of the Foundry that a promotion can name, each with a version and a stable SHA-256 (#639). Pure: no file
 * access (see home.ts for the folders and versions.ts for the counted versions). Every hash is the SHA-256 of
 * canonicalJson, so key order and YAML comments never count.
 */

export const COMPONENT_KINDS = ["flow", "policy-pack", "tool-profile", "model-routes", "context-selector"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** `version` is text: a policy version is "1.4.0", a flow or counted version is a whole number such as "3". */
export interface ComponentRef {
  kind: ComponentKind;
  id: string;
  version: string;
  sha256: string;
}

/** Kinds whose version is the place of the hash among the different hashes recorded so far. */
export type CountedKind = "model-routes" | "tool-profile" | "context-selector";
export const COUNTED_KINDS: readonly CountedKind[] = ["tool-profile", "model-routes", "context-selector"];
export const isCounted = (k: ComponentKind): k is CountedKind => (COUNTED_KINDS as readonly string[]).includes(k);

export const MODEL_ROUTES_ID = "default";
/** The id of the context selector a run uses: runs name none, so its settings are `config.context` (#665). */
export const CONTEXT_SELECTOR_ID = "default";
/** The most components one governance decision lists (and one evidence event holds). */
export const MAX_GOVERNED_COMPONENTS = 200;
/** The words of a governance decision (#665). They live here because the evidence schema reads them at load time. */
export const GOVERNANCE_STATUSES = ["ok", "unapproved", "retired", "review-due"] as const;
export const GOVERNANCE_OUTCOMES = ["allowed", "refused"] as const;
export const GOVERNANCE_FAILURES = ["book-unreadable", "check-failed"] as const;
/** The id of a tool profile or a context selector, which is also its file name. */
export const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * The hash of a flow: its parsed form without `publish.version`, so a new published number alone is no new definition
 * (the same rule as sameDefinition). Steps keep their order. A sub-flow step names another flow, so a change in that
 * flow does not change this hash.
 */
export function flowSha256(flow: Flow): string {
  const rest = flow.publish ? { ...flow, publish: { ...flow.publish, version: undefined } } : flow;
  return sha256Hex(canonicalJson(rest));
}

export const flowVersion = (flow: Flow): string => (isPublished(flow) ? String(flow.publish!.version) : "0");

/** The hash of the model routes: the rules, the fallback and fallback_on of the parsed config (defaults applied). */
export function modelRoutesSha256(router: Config["router"]): string {
  return sha256Hex(canonicalJson({ rules: router.rules, fallback: router.fallback, fallback_on: router.fallback_on }));
}

const inOrder = <T extends string>(order: readonly T[], list: readonly T[] | undefined): T[] | undefined => (list ? order.filter((x) => list.includes(x)) : undefined);

/** The hash of context selector settings. Throws a ZodError for settings that are not valid. */
export function contextSelectorSha256(settings: unknown): string {
  const s = ContextSelectorSettingsSchema.parse(settings);
  return sha256Hex(canonicalJson({ ...s, rules: inOrder(CONTEXT_RULES.map((r) => r.id), s.rules), consumers: inOrder(CONTEXT_CONSUMERS, s.consumers) }));
}

/** The hashes recorded so far, by `${kind}/${id}`, in the order they were first seen. */
export interface VersionBook {
  version: 1;
  components: Record<string, string[]>;
}
export interface SeenHash {
  kind: CountedKind;
  id: string;
  sha256: string;
}

export const versionKey = (kind: CountedKind, id: string): string => `${kind}/${id}`;
export const emptyVersionBook = (): VersionBook => ({ version: 1, components: {} });

/** The counted version of each hash, or undefined for a hash the book does not hold. */
export function lookupVersions(book: VersionBook, seen: readonly SeenHash[]): (number | undefined)[] {
  return seen.map((s) => {
    const key = versionKey(s.kind, s.id);
    const at = Object.hasOwn(book.components, key) ? book.components[key]!.indexOf(s.sha256) : -1;
    return at < 0 ? undefined : at + 1;
  });
}

/** Adds the hashes the book does not hold yet. A hash seen before keeps its number. The given book is not changed. */
export function countVersions(book: VersionBook, seen: readonly SeenHash[]): { book: VersionBook; versions: number[]; changed: boolean; added: number } {
  const components: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(book.components)) components[k] = [...v];
  let added = 0;
  const versions = seen.map((s) => {
    const key = versionKey(s.kind, s.id);
    const list = Object.hasOwn(components, key) ? components[key]! : (components[key] = []);
    let at = list.indexOf(s.sha256);
    if (at < 0) {
      list.push(s.sha256);
      added++;
      at = list.length - 1;
    }
    return at + 1;
  });
  return { book: { version: 1, components }, versions, changed: added > 0, added };
}

export type LineMark = "builtin" | "unrecorded";

/** `COMPONENT <kind> <id> v<version> sha256:<hash>`; a counted version that is not recorded prints `v-`. */
export function componentLine(c: { kind: ComponentKind; id: string; version?: string; sha256: string }, mark?: LineMark): string {
  return `COMPONENT ${c.kind} ${c.id} v${c.version ?? "-"} sha256:${c.sha256}${mark ? ` ${mark}` : ""}`;
}
