import { z } from "zod";
import { PolicyIdentitySchema, RunIdSchema, TimeSchema, isSafeRelativePath, sha256Hex, type PolicyIdentity } from "../evidence/identity.js";
import { classificationAtMost, parseContextBundle } from "./bundle.js";
import { hasGeneratedHeader, parseGeneratedAttributes, parseOwnership, type OwnershipRules } from "./patterns.js";
import type { RepositoryEntry, RepositorySnapshot } from "./repository.js";
import {
  CONTEXT_CLASSIFICATIONS, CONTEXT_CONSUMERS, CONTEXT_MAX_AGE_SECONDS_LIMIT, CONTEXT_MAX_ENTRIES, ContextBudgetSchema, ContextVersionSchema,
  type ContextBudget, type ContextBundle, type ContextClassification, type ContextConsumer, type ContextOmission, type ContextOmissionReason,
  type ContextSelectionReason, type ContextSource, type ContextSourceKind,
} from "./schema.js";
import { contextSourceId, issueCommentUri, issueUri, refinementUri, repositoryFileUri } from "./uri.js";
import { CONTEXT_BUNDLE_VERSION, CONTEXT_SOURCES_DIR } from "./version.js";

/**
 * The context selector: from one repository at one commit and the inputs of a task to a context bundle and the text
 * of its sources. It is a function: no model, no network, no clock (the caller gives `now`), and it reads the
 * repository only through the snapshot it is given. The same repository state and task give the same sources and
 * hashes.
 *
 * The rules are fixed and run in the order of `CONTEXT_RULES`. That order is also the order of importance: when the
 * budget is short, what a later rule found is left out first. Every source says which rule picked it, and every
 * expected source that is not in the bundle is in `omitted` with one reason.
 */

/** The rules, in the order they run. The id is what `selection.rule` holds. */
export const CONTEXT_RULES = [
  /** The text of the issue the task is about. */
  { id: "task-issue", kind: "issue", reason: "task" },
  /** The accepted notes of the refinement the task came from. */
  { id: "refinement-notes", kind: "refinement-notes", reason: "refinement" },
  /** `AGENTS.md` and `CLAUDE.md` in the root. Expected: when there is neither, both are recorded as missing. */
  { id: "root-instructions", kind: "repository-file", reason: "instructions" },
  /** `AGENTS.md` and `CLAUDE.md` in every folder above a path the task names, below the root. */
  { id: "nested-instructions", kind: "repository-file", reason: "instructions" },
  /** The ownership file: the first of `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`. Expected. */
  { id: "ownership-file", kind: "repository-file", reason: "ownership" },
  /** The comments on the issue, oldest first. */
  { id: "task-comments", kind: "issue-comment", reason: "task" },
  /** Files the task names: the paths the caller gives, and paths of the commit that the task text spells out. */
  { id: "named-in-task", kind: "repository-file", reason: "discovery" },
  /** Interface descriptions, by file name (`API_SCHEMA_NAMES`, `API_SCHEMA_SUFFIXES`), nearest to the root first. */
  { id: "api-schema-files", kind: "repository-file", reason: "api-schema" },
  /** `README.md` in the root. Expected. */
  { id: "root-readme", kind: "repository-file", reason: "discovery" },
] as const satisfies readonly { id: string; kind: ContextSourceKind; reason: ContextSelectionReason }[];
export type ContextRuleId = (typeof CONTEXT_RULES)[number]["id"];

export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Where an ownership file can be, in the order the host looks: the first one that exists is the one that counts. */
export const OWNERSHIP_FILE_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
export const README_FILE = "README.md";
/** A file with one of these names describes an interface. */
export const API_SCHEMA_NAMES = [
  "openapi.json", "openapi.yaml", "openapi.yml", "swagger.json", "swagger.yaml", "swagger.yml",
  "asyncapi.json", "asyncapi.yaml", "asyncapi.yml", "schema.graphql", "schema.graphqls",
] as const;
/** And so does a file whose name ends like this (the globs `*.proto`, `*.graphql`, …). */
export const API_SCHEMA_SUFFIXES = [".proto", ".graphql", ".graphqls", ".avsc", ".openapi.json", ".openapi.yaml", ".openapi.yml"] as const;
/** Folders the API schema rule does not look into (copies of other projects and build output), and any folder whose name starts with a dot. */
export const API_SCHEMA_SKIPPED_FOLDERS = ["node_modules", "vendor", "third_party", "dist", "build", "target", "out"] as const;
/** A `.gitattributes` file larger than this is not read; what it says about generated files is then not known. */
export const ATTRIBUTES_MAX_BYTES = 262_144;
/** The most text of the task (issue, comments, notes together) that is searched for paths. */
export const TASK_TEXT_SCAN_MAX = 1_048_576;

const taskText = z.string().max(16_777_216);
const fetched = {
  /** The text, already fetched by the caller. The selector never calls the host. */
  text: taskText,
  /** The time of the last change, as the host reports it. */
  version: ContextVersionSchema,
  /** When the caller fetched it. Default: `now`. */
  retrievedAt: TimeSchema.optional(),
  /** Default: the `classification` of the selection. */
  classification: z.enum(CONTEXT_CLASSIFICATIONS).optional(),
};
const whole = z.number().int().min(1).max(9_999_999_999_999_999);

const TaskSchema = z
  .object({
    issue: z.object({ number: whole, ...fetched, comments: z.array(z.object({ id: whole, ...fetched, foundry: z.literal(true).optional() }).strict()).max(10_000).default([]) }).strict().optional(),
    refinement: z.object({ sessionId: z.string().max(64), ...fetched }).strict().optional(),
    /** Files and folders the task is about, relative to the repository root. A path that is not safe is ignored and counted. */
    paths: z.array(z.string().max(8192)).max(1000).default([]),
  })
  .strict();
export type ContextTask = z.input<typeof TaskSchema>;

const InputSchema = z
  .object({
    runId: RunIdSchema,
    /** The one clock of the selection: `createdAt` of the bundle and `retrievedAt` of every repository file. */
    now: TimeSchema,
    /** "owner/name" on the host, when known. */
    repository: z.string().optional(),
    task: TaskSchema,
    budget: ContextBudgetSchema,
    /** The policy profile that applies: id and version only. It goes into `policies`, never into a source. */
    policies: z.array(PolicyIdentitySchema).max(CONTEXT_MAX_ENTRIES).default([]),
    /** The rules to run. Default: all. Whatever order is given, they run in the order of `CONTEXT_RULES`. */
    rules: z.array(z.enum(CONTEXT_RULES.map((r) => r.id) as [ContextRuleId, ...ContextRuleId[]])).optional(),
    /** How private the repository and the task are. Default: internal. */
    classification: z.enum(CONTEXT_CLASSIFICATIONS).default("internal"),
    /** The most private a source may be; one above it is left out with the reason `classification`. Default: no limit. */
    maxClassification: z.enum(CONTEXT_CLASSIFICATIONS).default("restricted"),
    /** The roles that may be given the sources. Default: all. */
    consumers: z.array(z.enum(CONTEXT_CONSUMERS)).min(1).default([...CONTEXT_CONSUMERS]),
    /** How long a fetched issue, comment or note stays fresh. Default: it does not go stale. A repository file at a commit never does. */
    taskMaxAgeSeconds: z.number().int().min(1).max(CONTEXT_MAX_AGE_SECONDS_LIMIT).nullable().default(null),
  })
  .strict();
/** The settings of a selector that can be kept in a file. Only `scf components` uses it so far (#153). */
export const ContextSelectorSettingsSchema = InputSchema.pick({ rules: true, budget: true, classification: true, maxClassification: true, consumers: true, taskMaxAgeSeconds: true }).strict();
export type ContextSelectorSettings = z.output<typeof ContextSelectorSettingsSchema>;
export type SelectContextInput = z.input<typeof InputSchema> & { snapshot: RepositorySnapshot };

/** The input of the selector is not valid. The message names fields, never values. */
export class ContextSelectError extends Error {
  constructor(message: string) {
    super(`context selection: ${message}`);
    this.name = "ContextSelectError";
  }
}

/**
 * Something the selector saw and could not record in the bundle, because the bundle has no free text:
 * - `owner-not-a-handle`: owners of the ownership file that are not host handles (e-mail addresses) were left out;
 * - `unsafe-task-path`: paths the caller gave that are not safe relative paths were ignored;
 * - `unlisted-entries`: paths of the commit that cannot be named safely were never looked at;
 * - `attributes-not-read`: a `.gitattributes` file was too large or not text, so its marks are not known;
 * - `omissions-truncated`: more sources were left out than a bundle can list; the last ones are not listed.
 * Only a code, a number and sometimes an address: never text of the repository.
 */
export interface ContextDiagnostic {
  code: "owner-not-a-handle" | "unsafe-task-path" | "unlisted-entries" | "attributes-not-read" | "omissions-truncated";
  count: number;
  uri?: string;
}

export interface ContextSelection {
  /** A valid bundle, its lists in the order `context.json` has them. */
  bundle: ContextBundle;
  /** The text of every source, by its `content.path` (relative to the run folder). Exactly one per source. */
  texts: Map<string, Uint8Array>;
  diagnostics: ContextDiagnostic[];
}

interface Candidate {
  rule: ContextRuleId;
  kind: ContextSourceKind;
  uri: string;
  /** Set for a repository file. */
  path?: string;
  /** Set for a task input. */
  input?: { text: string; version: string; retrievedAt: string; classification: ContextClassification };
  /** Set for a comment the Foundry wrote. */
  foundry?: true;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const depth = (path: string): number => path.split("/").length;

/** The text of a file when it is UTF-8 text without a NUL character; undefined for anything else (a binary file). */
function asText(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return decoder.decode(data);
  } catch {
    return undefined;
  }
}

/** The paths a text spells out: words with a `/` or a `.` in them, without quotes, brackets and a `:line` at the end. */
function wordsThatMayBePaths(text: string): string[] {
  const out: string[] = [];
  for (const word of text.slice(0, TASK_TEXT_SCAN_MAX).split(/[\s`'"()[\]<>{},;|*=]+/)) {
    const w = word.replace(/^\.\//, "").replace(/(?::\d+){1,2}$/, "").replace(/[.:!?]+$/, "");
    if (w.length > 1 && w.length <= 1024 && (w.includes("/") || w.includes("."))) out.push(w);
  }
  return out;
}

/** True for a safe relative path that has an address (`repo:…`). */
function addressable(path: string): boolean {
  try {
    return isSafeRelativePath(path) && repositoryFileUri(path) !== "";
  } catch {
    return false;
  }
}

function isApiSchema(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] as string;
  if (parts.slice(0, -1).some((p) => p.startsWith(".") || (API_SCHEMA_SKIPPED_FOLDERS as readonly string[]).includes(p))) return false;
  return (API_SCHEMA_NAMES as readonly string[]).includes(name) || API_SCHEMA_SUFFIXES.some((s) => name.length > s.length && name.endsWith(s));
}

/**
 * Selects the context of a run. Throws ContextSelectError for input that is not valid, ContextSchemaError when the
 * result would not be a valid bundle (for example the same policy twice), and whatever the snapshot throws.
 */
export function selectContext(input: SelectContextInput): ContextSelection {
  const { snapshot, ...rest } = input;
  const parsed = InputSchema.safeParse(rest);
  if (!parsed.success) throw new ContextSelectError(`not valid: ${[...new Set(parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)"))].join(", ")}`);
  const opt = parsed.data;
  const { budget, task, now } = opt;
  if (budget.maxSourceBytes > budget.maxTotalBytes) throw new ContextSelectError("not valid: budget.maxSourceBytes");
  const enabled = new Set<ContextRuleId>(opt.rules ?? CONTEXT_RULES.map((r) => r.id));
  const nowMs = Date.parse(now);
  const diagnostics: ContextDiagnostic[] = [];
  const note = (code: ContextDiagnostic["code"], count: number, uri?: string) => {
    if (count > 0) diagnostics.push(uri === undefined ? { code, count } : { code, count, uri });
  };

  // What the commit holds. Paths are checked again here (the selector trusts no snapshot): one that is not a safe
  // relative path, or has no address, is never looked at.
  const entries = new Map<string, RepositoryEntry>();
  const folders = new Set<string>();
  let unlisted = snapshot.unlisted;
  for (const e of snapshot.entries) {
    if (entries.has(e.path)) throw new ContextSelectError("the snapshot lists a path twice");
    if (!addressable(e.path)) {
      unlisted++;
      continue;
    }
    entries.set(e.path, e);
    for (let f = folderOf(e.path); f !== "" && !folders.has(f); f = folderOf(f)) folders.add(f);
  }
  note("unlisted-entries", unlisted);

  // ── The task inputs ──────────────────────────────────────────────────────────────────────────────────────────────
  const fetchedInput = (f: { text: string; version: string; retrievedAt?: string; classification?: ContextClassification }, at: string) => {
    const retrievedAt = f.retrievedAt ?? now;
    if (Date.parse(retrievedAt) > nowMs) throw new ContextSelectError(`not valid: ${at}.retrievedAt is after now`);
    return { text: f.text, version: f.version, retrievedAt, classification: f.classification ?? opt.classification };
  };
  const issue: Candidate[] = [];
  const comments: Candidate[] = [];
  const notes: Candidate[] = [];
  const texts: string[] = [];
  if (task.issue) {
    issue.push({ rule: "task-issue", kind: "issue", uri: issueUri(task.issue.number), input: fetchedInput(task.issue, "task.issue") });
    texts.push(task.issue.text);
    const ids = new Set<number>();
    for (const c of [...task.issue.comments].sort((a, b) => a.id - b.id)) {
      if (ids.has(c.id)) throw new ContextSelectError("not valid: task.issue.comments has the same id twice");
      ids.add(c.id);
      comments.push({ rule: "task-comments", kind: "issue-comment", uri: issueCommentUri(task.issue.number, c.id), input: fetchedInput(c, "task.issue.comments"), ...(c.foundry === true ? { foundry: true as const } : {}) });
      texts.push(c.text);
    }
  }
  if (task.refinement) {
    let uri: string;
    try {
      uri = refinementUri(task.refinement.sessionId);
    } catch {
      throw new ContextSelectError("not valid: task.refinement.sessionId");
    }
    notes.push({ rule: "refinement-notes", kind: "refinement-notes", uri, input: fetchedInput(task.refinement, "task.refinement") });
    texts.push(task.refinement.text);
  }

  // ── The repository rules ─────────────────────────────────────────────────────────────────────────────────────────
  const file = (rule: ContextRuleId, path: string): Candidate => ({ rule, kind: "repository-file", uri: repositoryFileUri(path), path });

  // Paths the task names: those the caller gives (a file, a folder, or a file that is not there), and those in the text.
  const given = [...new Set(task.paths)].sort(byText);
  const safeGiven = given.filter(addressable);
  note("unsafe-task-path", given.length - safeGiven.length);
  const spelled = [...new Set(texts.flatMap(wordsThatMayBePaths))].filter((w) => entries.has(w));
  const named = [...new Set([...safeGiven.filter((p) => !folders.has(p)), ...spelled])].sort(byText).map((p) => file("named-in-task", p));

  const rootInstructions = INSTRUCTION_FILE_NAMES.filter((n) => entries.has(n) || !INSTRUCTION_FILE_NAMES.some((m) => entries.has(m))).map((n) => file("root-instructions", n));

  // Every folder above a named path, below the root; a named folder counts itself.
  const scopes = new Set<string>();
  for (const p of [...safeGiven, ...spelled]) for (let f = folders.has(p) ? p : folderOf(p); f !== ""; f = folderOf(f)) scopes.add(f);
  const nested = [...scopes].flatMap((f) => INSTRUCTION_FILE_NAMES.map((n) => `${f}/${n}`)).filter((p) => entries.has(p)).sort(byText).map((p) => file("nested-instructions", p));

  const ownershipPath = OWNERSHIP_FILE_PATHS.find((p) => entries.has(p)) ?? OWNERSHIP_FILE_PATHS[0];
  const ownership = [file("ownership-file", ownershipPath)];

  const api = [...entries.values()]
    .filter((e) => isApiSchema(e.path))
    .map((e) => e.path)
    .sort((a, b) => depth(a) - depth(b) || byText(a, b))
    .map((p) => file("api-schema-files", p));

  const groups: Record<ContextRuleId, Candidate[]> = {
    "task-issue": issue,
    "refinement-notes": notes,
    "root-instructions": rootInstructions,
    "nested-instructions": nested,
    "ownership-file": ownership,
    "task-comments": comments,
    "named-in-task": named,
    "api-schema-files": api,
    "root-readme": [file("root-readme", README_FILE)],
  };

  // ── "Generated" marks of .gitattributes: the nearest file that speaks about a path decides ──────────────────────
  const attributes = new Map<string, (path: string) => boolean | undefined>();
  const attributesOf = (folder: string) => {
    let rules = attributes.get(folder);
    if (rules) return rules;
    const path = folder === "" ? ".gitattributes" : `${folder}/.gitattributes`;
    const entry = entries.get(path);
    rules = () => undefined;
    if (entry?.kind === "file") {
      const text = entry.bytes <= ATTRIBUTES_MAX_BYTES ? asText(snapshot.read(path)) : undefined;
      if (text === undefined) note("attributes-not-read", 1, repositoryFileUri(path));
      else rules = parseGeneratedAttributes(text);
    }
    attributes.set(folder, rules);
    return rules;
  };
  const markedGenerated = (path: string): boolean => {
    for (let folder = folderOf(path); ; folder = folderOf(folder)) {
      const said = attributesOf(folder)(folder === "" ? path : path.slice(folder.length + 1));
      if (said !== undefined) return said;
      if (folder === "") return false;
    }
  };

  // ── One candidate after the other, in the order of the rules ─────────────────────────────────────────────────────
  const sources: ContextSource[] = [];
  const omitted: ContextOmission[] = [];
  const stored = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let total = 0;
  let owners: OwnershipRules | undefined;
  const fits = (bytes: number): boolean => bytes <= budget.maxSourceBytes && sources.length < budget.maxSources && total + bytes <= budget.maxTotalBytes;

  /** The bytes to store, or the reason the candidate is left out. Checks that need no reading come first. */
  const load = (c: Candidate): Uint8Array | ContextOmissionReason => {
    if (c.input) {
      if (!classificationAtMost(c.input.classification, opt.maxClassification)) return "classification";
      if (opt.taskMaxAgeSeconds !== null && nowMs > Date.parse(c.input.retrievedAt) + opt.taskMaxAgeSeconds * 1000) return "stale";
      if (Buffer.byteLength(c.input.text) > budget.maxSourceBytes) return "over-budget";
      const data = Buffer.from(c.input.text, "utf8");
      return fits(data.byteLength) ? data : "over-budget";
    }
    const path = c.path as string;
    const entry = entries.get(path);
    if (!entry) return "missing";
    if (entry.kind !== "file") return "unsupported";
    if (!classificationAtMost(opt.classification, opt.maxClassification)) return "classification";
    if (markedGenerated(path)) return "generated";
    if (!fits(entry.bytes)) return "over-budget";
    const data = snapshot.read(path);
    if (data.byteLength !== entry.bytes) throw new ContextSelectError("the snapshot gave a file with another size than it listed");
    const text = asText(data);
    if (text === undefined) return "unsupported";
    if (hasGeneratedHeader(text)) return "generated";
    if (c.rule === "ownership-file") owners = parseOwnership(text);
    return data;
  };

  for (const rule of CONTEXT_RULES) {
    if (!enabled.has(rule.id)) continue;
    for (const c of groups[rule.id]) {
      if (seen.has(c.uri)) continue; // an earlier rule already decided about this address
      seen.add(c.uri);
      const selection = { reason: rule.reason, rule: rule.id };
      const got = load(c);
      if (typeof got === "string") {
        omitted.push({ kind: c.kind, uri: c.uri, selection, reason: got } as ContextOmission);
        continue;
      }
      const id = contextSourceId(c.uri);
      const content = { path: `${CONTEXT_SOURCES_DIR}/${id}`, sha256: sha256Hex(got), bytes: got.byteLength };
      total += got.byteLength;
      stored.set(content.path, got);
      sources.push({
        id,
        kind: c.kind,
        uri: c.uri,
        revision: c.input ? { version: c.input.version } : { commit: snapshot.commit },
        content,
        owners: [],
        classification: c.input?.classification ?? opt.classification,
        retrievedAt: c.input?.retrievedAt ?? now,
        freshness: { maxAgeSeconds: c.input ? opt.taskMaxAgeSeconds : null },
        selection,
        consumers: CONTEXT_CONSUMERS.filter((r) => (opt.consumers as ContextConsumer[]).includes(r)),
        ...(c.foundry === true ? { foundry: true } : {}),
      } as ContextSource);
    }
  }

  // Owners come from the ownership file, and only when that file is in the bundle.
  const rules = owners as OwnershipRules | undefined;
  if (rules) {
    note("owner-not-a-handle", rules.dropped, repositoryFileUri(ownershipPath));
    const pathOf = new Map(Object.values(groups).flat().filter((c) => c.path !== undefined).map((c) => [c.uri, c.path as string]));
    for (const s of sources) if (s.kind === "repository-file") s.owners = rules.ownersOf(pathOf.get(s.uri) as string);
  }

  // A bundle lists at most CONTEXT_MAX_ENTRIES omissions: the ones of the last rules go first.
  note("omissions-truncated", Math.max(0, omitted.length - CONTEXT_MAX_ENTRIES));
  const listed = omitted.slice(0, CONTEXT_MAX_ENTRIES);

  const bundle = parseContextBundle({
    version: CONTEXT_BUNDLE_VERSION,
    runId: opt.runId,
    createdAt: now,
    repository: opt.repository === undefined ? { commit: snapshot.commit } : { repository: opt.repository, commit: snapshot.commit },
    budget: budget satisfies ContextBudget,
    policies: [...opt.policies].sort((a: PolicyIdentity, b: PolicyIdentity) => byText(a.id, b.id)),
    sources: sources.sort((a, b) => byText(a.uri, b.uri)),
    omitted: listed.sort((a, b) => byText(a.uri, b.uri)),
  });
  return { bundle, texts: stored, diagnostics };
}
