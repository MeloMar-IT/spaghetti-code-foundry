import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { dataHome } from "../auth/store.js";
import { MAX_PACK_BYTES, readPolicyFile, repositoryFact } from "../engine/policy-hooks.js";
import { PolicyIdentitySchema } from "../evidence/identity.js";
import { COMPONENT_KINDS, GOVERNANCE_FAILURES, GOVERNANCE_OUTCOMES, GOVERNANCE_STATUSES, MAX_GOVERNED_COMPONENTS, type ComponentKind } from "./components.js";
import type { ComponentProblem } from "./home.js";
import { folderState, PROMOTIONS_FOLDER } from "./versions.js";

/**
 * `<home>/promotions/governance.yaml` (#664): the owner, risk, lifecycle, approved version, last review and evaluation
 * suite of each promotable component, kept by hand. Records live outside the component files, so they never change a hash
 * or a version. Only read here, never written. Reasons are fixed text: they never hold a machine path or file content.
 */

export const GOVERNANCE_FILE = "governance.yaml";
export const MAX_GOVERNANCE_BYTES = MAX_PACK_BYTES;
export const REVIEW_DAYS = 365;
export const GOVERNANCE_RISKS = ["low", "medium", "high"] as const;
export const GOVERNANCE_LIFECYCLES = ["draft", "active", "deprecated", "retired"] as const;

const WHAT = `${PROMOTIONS_FOLDER}/${GOVERNANCE_FILE}`;
const DAY_MS = 86_400_000;

/** A whole number is read as text: YAML reads `3` as a number, and flow and counted versions are whole numbers. */
const VersionSchema = z.union([PolicyIdentitySchema.shape.version, z.number().int().min(0).transform(String)]);

export const GovernanceRecordSchema = z
  .object({
    owner: z.string().regex(/^[\w@.+/-]{1,100}$/),
    risk: z.enum(GOVERNANCE_RISKS),
    lifecycle: z.enum(GOVERNANCE_LIFECYCLES),
    approved_version: VersionSchema,
    last_review: z.iso.date(),
    eval_suite: z.string().regex(/^[\w.-]{1,100}$/),
  })
  .partial()
  .strict();

export const GovernanceBookSchema = z
  .object({
    version: z.literal(1),
    components: z.record(z.string().regex(new RegExp(`^(${COMPONENT_KINDS.join("|")})/[\\w.-]{1,200}$`)), GovernanceRecordSchema),
  })
  .strict();

export type GovernanceRecord = z.infer<typeof GovernanceRecordSchema>;
export type GovernanceBook = z.infer<typeof GovernanceBookSchema>;
export type GovernanceRisk = (typeof GOVERNANCE_RISKS)[number];
export type GovernanceLifecycle = (typeof GOVERNANCE_LIFECYCLES)[number];
export type GovernanceProfile = GovernanceRecord & { risk: GovernanceRisk; lifecycle: GovernanceLifecycle };
export type GovernanceStatus = (typeof GOVERNANCE_STATUSES)[number];
export type GovernanceBookRead = { ok: true; book: GovernanceBook } | { ok: false; reason: string };

export const emptyGovernanceBook = (): GovernanceBook => ({ version: 1, components: {} });

/** Reads the book. A missing folder or file is an empty book; a link, a large or a bad file is a reason. Never writes, never throws. */
export function readGovernanceBook(home = dataHome()): GovernanceBookRead {
  const dir = join(home, PROMOTIONS_FOLDER);
  const state = folderState(dir);
  if (state === undefined) return { ok: true, book: emptyGovernanceBook() };
  if (!state) return { ok: false, reason: `${PROMOTIONS_FOLDER} is a link or not a folder` };
  const read = readPolicyFile(join(dir, GOVERNANCE_FILE), MAX_GOVERNANCE_BYTES);
  if ("problem" in read) {
    if (read.problem === "missing") return { ok: true, book: emptyGovernanceBook() };
    if (read.problem === "not-file") return { ok: false, reason: `${WHAT} is a link or not a plain file` };
    if (read.problem === "too-large") return { ok: false, reason: `${WHAT} is larger than 1 MiB` };
    return { ok: false, reason: `${WHAT} could not be read` };
  }
  try {
    // "error", not "silent": warnings print snippets of the file, but errors must still throw.
    const res = GovernanceBookSchema.safeParse(parseYaml(read.text, { logLevel: "error" }));
    if (res.success) return { ok: true, book: res.data };
  } catch {
    // falls through to the fixed reason
  }
  return { ok: false, reason: `${WHAT} is not valid; no record was used, fix it` };
}

export function governanceRecord(book: GovernanceBook, kind: ComponentKind, id: string): GovernanceRecord | undefined {
  const key = `${kind}/${id}`;
  return Object.hasOwn(book.components, key) ? book.components[key] : undefined;
}

/** The record with the defaults filled in: risk `low`, lifecycle `active`, nothing else. */
export const governanceProfile = (record: GovernanceRecord | undefined): GovernanceProfile => ({ ...record, risk: record?.risk ?? "low", lifecycle: record?.lifecycle ?? "active" });

/** `retired`, then `unapproved` (no approved version, or not the version of the component), then `review-due`, then `ok`. */
export function governanceStatus(component: { version?: string | undefined }, record: GovernanceRecord | undefined, now: Date): GovernanceStatus {
  const p = governanceProfile(record);
  if (p.lifecycle === "retired") return "retired";
  if (p.approved_version === undefined || p.approved_version !== component.version) return "unapproved";
  if (p.last_review === undefined || now.getTime() - Date.parse(p.last_review) > REVIEW_DAYS * DAY_MS) return "review-due";
  return "ok";
}

/** `owner=<owner|-> risk=<risk> lifecycle=<lifecycle> status=<status>`, the end of a `COMPONENT` line. */
export function governanceFields(record: GovernanceRecord | undefined, status: GovernanceStatus): string {
  const p = governanceProfile(record);
  return `owner=${p.owner ?? "-"} risk=${p.risk} lifecycle=${p.lifecycle} status=${status}`;
}

/**
 * Records of the listed kinds that name no component. A component that failed to load is known. A kind whose folder could
 * not be listed is skipped (its problem id is `(folder)`); a bad file name, `(file)`, says nothing against the other ids.
 */
export function governanceOrphans(
  book: GovernanceBook,
  found: readonly { kind: ComponentKind; id: string }[],
  problems: readonly ComponentProblem[],
  kinds: readonly ComponentKind[],
): ComponentProblem[] {
  const known = new Set([...found, ...problems].map((c) => `${c.kind}/${c.id}`));
  const blind = new Set(problems.filter((p) => p.id.startsWith("(") && p.id !== "(file)").map((p) => p.kind));
  const out: ComponentProblem[] = [];
  for (const key of Object.keys(book.components)) {
    const at = key.indexOf("/");
    const kind = key.slice(0, at) as ComponentKind;
    if (!kinds.includes(kind) || blind.has(kind) || known.has(key)) continue;
    out.push({ kind, id: key.slice(at + 1), reason: "governance record names no component" });
  }
  return out;
}

/** A component of a run, to be checked: `id` is the raw id (the record lookup), `show` the sanitized id (all output). */
export interface GovernedComponent {
  kind: ComponentKind;
  id: string;
  show: string;
  version?: string;
}

export interface GovernanceCheck {
  kind: ComponentKind;
  /** The sanitized id. */
  id: string;
  version?: string;
  status: GovernanceStatus;
  refused: boolean;
}

export interface GovernanceDecision {
  outcome: GovernanceOutcome;
  failure?: GovernanceFailure;
  components: GovernanceCheck[];
  /** Log lines: one per refused component, or one line for an allowed run. Fixed text. */
  lines: string[];
  /** Why the run ends; set exactly when `outcome` is `refused`. */
  reason?: string;
}

export type GovernanceOutcome = (typeof GOVERNANCE_OUTCOMES)[number];
export type GovernanceFailure = (typeof GOVERNANCE_FAILURES)[number];

/** A production run is any run with a connected repository: it can push to it or open a pull request on it (#665). The workspace plays no part. */
export const isProductionRun = (vars: Record<string, string> | undefined): boolean => repositoryFact(vars) !== undefined;

/** A retired component is always refused; an unapproved one only when it is high risk. `review-due` and `ok` never refuse. */
export const governanceRefuses = (status: GovernanceStatus, risk: GovernanceRisk): boolean => status === "retired" || (status === "unapproved" && risk === "high");

function refusalText(c: GovernedComponent, status: GovernanceStatus): string {
  const what = `${c.kind} ${c.show}`;
  if (status === "retired") return `${what} is retired; stop using it, or change its lifecycle in ${WHAT}`;
  if (c.version === undefined) return `${what} is high risk and has no recorded version; run scf components record ${c.kind}, then set approved_version in ${WHAT}`;
  return `${what} v${c.version} is high risk and not approved; review it and set approved_version in ${WHAT}`;
}

/** The rules, pure: the components of the run and the governance book as it was read. Never throws. */
export function decideGovernance(components: readonly GovernedComponent[], read: GovernanceBookRead, now: Date): GovernanceDecision {
  if (!read.ok) {
    const text = `the governance file cannot be used (${read.reason}); fix it, then start the run again`;
    return { outcome: "refused", failure: "book-unreadable", components: [], lines: [`! governance: ${text}`], reason: `refused: ${text}` };
  }
  const checks = components.map((c) => {
    const record = governanceRecord(read.book, c.kind, c.id);
    const status = governanceStatus({ version: c.version }, record, now);
    const refused = governanceRefuses(status, governanceProfile(record).risk);
    const check: GovernanceCheck = { kind: c.kind, id: c.show, ...(c.version !== undefined ? { version: c.version } : {}), status, refused };
    return { check, text: refused ? refusalText(c, status) : "" };
  });
  const refusedList = checks.filter((c) => c.check.refused);
  const listed = [...refusedList, ...checks.filter((c) => !c.check.refused)].slice(0, MAX_GOVERNED_COMPONENTS).map((c) => c.check);
  if (refusedList.length === 0) return { outcome: "allowed", components: listed, lines: [`· governance: allowed (${checks.length} components)`] };
  const more = refusedList.length > 1 ? ` (and ${refusedList.length - 1} more, see the log)` : "";
  return {
    outcome: "refused",
    components: listed,
    lines: refusedList.map((c) => `! governance: ${c.text}`),
    reason: `refused: ${refusedList[0]!.text}${more}`,
  };
}

/** The decision when the check itself could not be made: a production run is refused (fails closed). */
export function governanceCheckFailed(): GovernanceDecision {
  const text = `the governance check could not run; check ${WHAT} with scf components, then start the run again`;
  return { outcome: "refused", failure: "check-failed", components: [], lines: [`! governance: ${text}`], reason: `refused: ${text}` };
}
