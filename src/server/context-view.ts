import { join } from "node:path";
import type { RunSummary } from "../engine/state.js";
import { hashContextBundle, hashContextSources, isStale, readContextBundle } from "../context/bundle.js";
import type { ContextBudget, ContextClassification, ContextOmission, ContextOmissionReason, ContextSelectionReason, ContextSource, ContextSourceKind } from "../context/schema.js";
import { contextSourceId, repositoryFilePath } from "../context/uri.js";
import { CONTEXT_BUNDLE_FILE, type ContextErrorCode } from "../context/version.js";
import { readPlainBytes } from "../evidence/stream.js";
import { hidePaths } from "./user-view.js";

/**
 * The context bundle of a run as `GET /api/runs/:id/context` answers it.
 *
 * It lists the sources the run was given and the ones left out, each with a label, a status and (for the ones left
 * out) a next action. It never holds source text, nor the path of a stored text. A user gets less than an
 * administrator: no address and no id for any entry, and for a confidential or restricted source only its kind,
 * classification, selection and freshness. Every user entry is built from a list of fields, never "all but".
 * Wording is here, in closed lists, so the export explains itself and the page only formats.
 */

/** The largest `context.json` that is read. A valid bundle (at most 1000 + 1000 entries) is far below this. */
export const CONTEXT_VIEW_MAX_BYTES = 32 * 1024 * 1024;

export type ContextViewState = "available" | "absent" | "unreadable";
export type ContextViewProblem = ContextErrorCode | "not-a-file" | "other-run" | "too-large";

export type ContextNextActionCode =
  | "add-source" | "reread" | "reread-or-raise-age" | "name-one"
  | "ask-raise-limits" | "raise-limits" | "ask-classification" | "change-classification"
  | "read-origin" | "use-text-file" | "rerun-for-fresh";

export const CONTEXT_STATUS_LABELS: Record<ContextOmissionReason, string> = {
  missing: "Not found",
  stale: "Too old",
  ambiguous: "More than one fits",
  "over-budget": "Over the context limits",
  classification: "Too private for this run",
  generated: "Made by a program",
  unsupported: "Not a text file",
};

const STALE_TEXT = "The copy was too old to use. Start the run again so it is read again.";

export const CONTEXT_NEXT_ACTIONS: Record<ContextNextActionCode, string> = {
  "add-source": "It does not exist at this commit. Add it to the repository, or fix the name in the issue, then start the run again.",
  reread: STALE_TEXT,
  "reread-or-raise-age": `${STALE_TEXT.replace(/\.$/, "")}, or raise task_max_age_seconds in the context: section of config.yaml.`,
  "name-one": "More than one source fits. Name the one you mean (its full path) in the issue, then start the run again.",
  "ask-raise-limits": "It did not fit within the context limits. Name fewer files in the issue, or ask an administrator to raise the context limits.",
  "raise-limits": "It did not fit within the context limits. Raise max_sources, max_source_bytes or max_total_bytes in the context: section of config.yaml, or name fewer files in the issue; then start the run again.",
  "ask-classification": "It is more private than this run may be given. Ask an administrator if the run needs it.",
  "change-classification": "It is more private than context.max_classification allows. Raise max_classification in config.yaml if runs may read it; then start the run again.",
  "read-origin": "The repository marks it as made by a program. Name the file it is made from in the issue instead.",
  "use-text-file": "It is not a regular text file (a link, a submodule or a binary file). Name a text file in the issue instead.",
  "rerun-for-fresh": "The run used this copy, but it is now older than its limit. Start a new run to read it again.",
};

/** The next action for a source that was left out, by reason and role. */
export function contextNextAction(reason: ContextOmissionReason, admin: boolean): ContextNextActionCode {
  switch (reason) {
    case "missing": return "add-source";
    case "stale": return admin ? "reread-or-raise-age" : "reread";
    case "ambiguous": return "name-one";
    case "over-budget": return admin ? "raise-limits" : "ask-raise-limits";
    case "classification": return admin ? "change-classification" : "ask-classification";
    case "generated": return "read-origin";
    case "unsupported": return "use-text-file";
  }
}

const KIND_NOUNS: Record<ContextSourceKind, string> = {
  "repository-file": "repository file",
  issue: "issue",
  "issue-comment": "comment on an issue",
  "refinement-notes": "refinement notes",
};

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * A plain label from the address (never from source text). `hidden`: a classification gives "Restricted repository
 * file"; "address" gives the kind alone, "Repository file".
 */
export function contextSourceLabel(kind: ContextSourceKind, uri: string, hidden?: ContextClassification | "address"): string {
  if (hidden === "address") return cap(KIND_NOUNS[kind]);
  if (hidden) return `${cap(hidden)} ${KIND_NOUNS[kind]}`;
  if (kind === "repository-file") return `Repository file ${repositoryFilePath(uri) ?? ""}`.trim();
  if (kind === "issue") return `Issue #${uri.slice("issue:".length)}`;
  if (kind === "issue-comment") {
    const [issue, , comment] = uri.slice("issue:".length).split("/");
    return `Comment ${comment} on issue #${issue}`;
  }
  return "Refinement notes";
}

type Selection = { reason: ContextSelectionReason; rule?: string };

export interface ContextSourceView {
  kind: ContextSourceKind;
  label: string;
  classification: ContextClassification;
  selection: Selection;
  retrievedAt: string;
  freshness: "fresh" | "stale";
  /** Only for a source that is stale at the time of the request. */
  nextCode?: "rerun-for-fresh";
  next?: string;
  revision?: { commit: string } | { version: string };
  sha256?: string;
  bytes?: number;
  owners?: string[];
  /** An administrator only. */
  id?: string;
  uri?: string;
}

export interface ContextOmissionView {
  kind: ContextSourceKind;
  label: string;
  selection: Selection;
  status: ContextOmissionReason;
  statusLabel: string;
  nextCode: ContextNextActionCode;
  next: string;
  /** An administrator only. */
  id?: string;
  uri?: string;
}

export interface RunContextView {
  runId: string;
  state: ContextViewState;
  problem?: { code: ContextViewProblem; reason: string; /** An administrator only. */ detail?: string };
  sha256?: string;
  sourcesSha256?: string;
  createdAt?: string;
  repository?: { repository?: string; commit: string };
  budget?: ContextBudget;
  sources: ContextSourceView[];
  omitted: ContextOmissionView[];
}

const selectionOf = (s: Selection): Selection => ({ reason: s.reason, ...(s.rule !== undefined ? { rule: s.rule } : {}) });

function sourceView(src: ContextSource, admin: boolean, now: string): ContextSourceView {
  const stale = isStale(src, now);
  const hide = !admin && (src.classification === "confidential" || src.classification === "restricted");
  const head = {
    kind: src.kind,
    label: contextSourceLabel(src.kind, src.uri, hide ? src.classification : undefined),
    classification: src.classification,
    selection: selectionOf(src.selection),
    retrievedAt: src.retrievedAt,
    freshness: stale ? ("stale" as const) : ("fresh" as const),
    ...(stale ? { nextCode: "rerun-for-fresh" as const, next: CONTEXT_NEXT_ACTIONS["rerun-for-fresh"] } : {}),
  };
  // a user's confidential or restricted source: a fixed short list, no hash, size, revision or owner
  if (hide) return head;
  return {
    ...head,
    revision: "commit" in src.revision ? { commit: src.revision.commit } : { version: src.revision.version },
    sha256: src.content.sha256,
    bytes: src.content.bytes,
    owners: [...src.owners],
    ...(admin ? { id: src.id, uri: src.uri } : {}),
  };
}

function omissionView(o: ContextOmission, admin: boolean): ContextOmissionView {
  const code = contextNextAction(o.reason, admin);
  return {
    kind: o.kind,
    label: contextSourceLabel(o.kind, o.uri, !admin && o.reason === "classification" ? "address" : undefined),
    selection: selectionOf(o.selection),
    status: o.reason,
    statusLabel: CONTEXT_STATUS_LABELS[o.reason],
    nextCode: code,
    next: CONTEXT_NEXT_ACTIONS[code],
    ...(admin ? { id: contextSourceId(o.uri), uri: o.uri } : {}),
  };
}

const PROBLEM_REASONS: Partial<Record<ContextViewProblem, string>> = {
  "unsupported-version": "This run's context bundle was written by a newer version of the Foundry. Update to read it.",
  "other-run": "The context bundle in this run's folder belongs to another run.",
  "too-large": "This run's context bundle is too large to show.",
};
const PROBLEM_DEFAULT = "This run's context bundle cannot be read.";

/** Never throws: no bundle answers `absent`, one that cannot be read answers `unreadable`. */
export function runContextView(s: Pick<RunSummary, "runId" | "runDir" | "workdir" | "repo">, admin: boolean, now: string): RunContextView {
  const empty = (state: ContextViewState, problem?: RunContextView["problem"]): RunContextView => ({ runId: s.runId, state, ...(problem ? { problem } : {}), sources: [], omitted: [] });
  const unreadable = (code: ContextViewProblem, detail?: string): RunContextView =>
    empty("unreadable", { code, reason: PROBLEM_REASONS[code] ?? PROBLEM_DEFAULT, ...(admin && detail ? { detail } : {}) });
  try {
    if (!s.runDir) return empty("absent");
    let bytes: Buffer | undefined;
    try {
      bytes = readPlainBytes(join(s.runDir, CONTEXT_BUNDLE_FILE), CONTEXT_VIEW_MAX_BYTES);
    } catch (e) {
      // the messages of Node's errors name the file, so only the fixed sentence or the error code is kept
      if (e instanceof Error && e.message === "too large") return unreadable("too-large");
      const code = (e as NodeJS.ErrnoException).code;
      return unreadable("not-a-file", typeof code === "string" && /^E[A-Z]+$/.test(code) ? `the file cannot be opened (${code})` : "it is not a plain file");
    }
    const read = readContextBundle(bytes?.toString("utf8"));
    if (read.state === "absent") return empty("absent");
    if (read.state === "unreadable") return unreadable(read.code, read.reason);
    const b = read.bundle;
    if (b.runId !== s.runId) return unreadable("other-run");
    const view: RunContextView = {
      runId: s.runId,
      state: "available",
      sha256: hashContextBundle(b),
      sourcesSha256: hashContextSources(b),
      createdAt: b.createdAt,
      repository: { ...(b.repository.repository !== undefined ? { repository: b.repository.repository } : {}), commit: b.repository.commit },
      budget: { maxSources: b.budget.maxSources, maxSourceBytes: b.budget.maxSourceBytes, maxTotalBytes: b.budget.maxTotalBytes },
      sources: b.sources.map((x) => sourceView(x, admin, now)),
      omitted: b.omitted.map((o) => omissionView(o, admin)),
    };
    return admin ? view : hidePaths(view, s);
  } catch {
    return empty("unreadable", { code: "invalid", reason: PROBLEM_DEFAULT });
  }
}
