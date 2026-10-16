import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify, type Node, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { reviewMarkdown, type ImportReview } from "./import-review.js";
import { notComparedMarkdown, SOURCE_CHANGE_LIMITS, sourceChangeMarkdown, type SourceChange } from "./source-change.js";
import type { RejectedSkill } from "./import-plan.js";
import { OWNER_RE, parseSources, shownFull, type SkillLibrarySource, type SourceReview } from "./sources.js";

// The text of a source update: the branch name, the review record, the byte-exact edit of skill-sources.yaml and the
// pull-request text. Pure: no file, no process, no clock (the caller gives `today`). The YAML is never re-rendered: only the
// ranges of the scalars that change, or one new piece of text, are spliced in, so comments and every other byte stay.

export const PULL_REQUEST_BYTES = 64_000;
const PATHS_BYTES = 24_000;
const REJECTED_BYTES = 12_000;

/** The branch of one update. */
export const updateBranchPrefix = (id: string): string => `skill-update/${id}-`;
export const updateBranch = (id: string, commit: string): string => `${updateBranchPrefix(id)}${commit.slice(0, 12)}`;
const SUPERSEDES_BYTES = 4_000;

type Problem = { problem: string; missing?: "reviewer" | "licence" };

/**
 * The review record an enabled community entry needs for the new commit (parseSources demands review.commit = ref.approved).
 * The tool never invents a reviewer: a person gives `reviewer` (and `licence` when it is not clear).
 */
export function communityReview(
  entry: Pick<SkillLibrarySource, "status" | "trust" | "licence" | "review">,
  o: { commit: string; reviewer?: string; licence?: string; today: string },
): { review?: SourceReview } | Problem {
  const needs = entry.status === "enabled" && entry.trust === "community";
  if (!needs) {
    if (o.reviewer !== undefined) return { problem: "--reviewer applies only to an enabled community source" };
    if (o.licence !== undefined) return { problem: "--licence applies only to an enabled community source" };
    return {};
  }
  if (o.reviewer === undefined) {
    return { problem: "an enabled community source needs a review; give --reviewer <@user> (the person who checked the maintainer and the licence)", missing: "reviewer" };
  }
  if (!OWNER_RE.test(o.reviewer)) return { problem: "--reviewer must be a GitHub user or team like @octocat or @acme/skills" };
  const allow = entry.licence.allow;
  let licence = o.licence;
  if (licence !== undefined) {
    if (!allow.includes(licence)) return { problem: `--licence ${shownFull(licence)} is not in licence.allow` };
  } else if (entry.review && allow.includes(entry.review.licence)) licence = entry.review.licence;
  else if (allow.length === 1) licence = allow[0];
  if (licence === undefined) return { problem: "give --licence <id>: the licence that was reviewed; licence.allow lists more than one", missing: "licence" };
  return { review: { by: o.reviewer, on: o.today, commit: o.commit, licence } };
}

/** The text of a scalar: the old quote style when it is kept, plain only when it reads back as the same text. */
export function scalarText(value: string, type?: string): string {
  if (type === "QUOTE_SINGLE" && !value.includes("'") && /^[\x20-\x7e]*$/.test(value)) return `'${value}'`;
  if (type === "QUOTE_DOUBLE") return JSON.stringify(value);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && parseYaml(value) === value) return value;
  return JSON.stringify(value);
}

interface Splice {
  start: number;
  end: number;
  text: string;
}
const apply = (text: string, splices: readonly Splice[]): string => {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
};
const pairOf = (map: YAMLMap, key: string): Pair | undefined => map.items.find((p) => isScalar(p.key) && p.key.value === key);
const rangeOf = (n: unknown): [number, number, number] | undefined => (n as Node | null | undefined)?.range ?? undefined;
const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const i = text.indexOf("\n", at);
  return i < 0 ? text.length : i;
};
/** Where the last value of a node ends: a trailing comment after a block node is not part of it. */
function contentEnd(node: unknown): number | undefined {
  if ((isMap(node) || isSeq(node)) && !node.flow && node.items.length > 0) {
    const last = node.items.at(-1);
    const child = isMap(node) ? (last as Pair).value : last;
    const inner = child === null || child === undefined ? undefined : contentEnd(child);
    if (inner !== undefined) return inner;
  }
  return rangeOf(node)?.[1];
}
// The splice helpers are shared with the release deployment edit (release-deployment.ts).
export { apply as applySplices, pairOf, rangeOf, lineStart, lineEnd, contentEnd };
export type { Splice };
const CANNOT ="skill-sources.yaml has a form this command cannot edit byte for byte";

function parse(text: string) {
  const doc = parseDocument(text);
  return doc.errors.length > 0 ? undefined : doc;
}

/** Sets ref.approved of entry `id` (adding the key when it is missing) and, for a community entry, its review. */
export function changeApproved(text: string, id: string, commit: string, review?: SourceReview): { text: string } | Problem {
  const doc = parse(text);
  if (!doc || !isMap(doc.contents)) return { problem: CANNOT };
  const seq = doc.contents.get("sources", true);
  if (!isSeq(seq)) return { problem: CANNOT };
  const entry = (seq as YAMLSeq).items.find((i) => isMap(i) && i.get("id") === id);
  if (!isMap(entry)) return { problem: CANNOT };
  const ref = entry.get("ref", true);
  if (!isMap(ref)) return { problem: CANNOT };
  const splices: Splice[] = [];

  const approved = pairOf(ref, "approved");
  if (approved) {
    const node = approved.value as Scalar | null;
    const r = rangeOf(node);
    if (!isScalar(node) || !r) return { problem: CANNOT };
    splices.push({ start: r[0], end: r[1], text: scalarText(commit, node.type) });
  } else {
    const last = ref.items.at(-1);
    const mapRange = rangeOf(ref);
    if (!last) {
      if (!ref.flow || !mapRange) return { problem: CANNOT };
      splices.push({ start: mapRange[0] + 1, end: mapRange[0] + 1, text: `approved: ${scalarText(commit)}` });
    } else {
      const end = rangeOf(last.value)?.[1] ?? rangeOf(last.key)?.[1];
      const keyAt = rangeOf(last.key)?.[0];
      if (end === undefined || keyAt === undefined) return { problem: CANNOT };
      if (ref.flow) splices.push({ start: end, end, text: `, approved: ${scalarText(commit)}` });
      else {
        const at = lineEnd(text, end);
        splices.push({ start: at, end: at, text: `\n${" ".repeat(keyAt - lineStart(text, keyAt))}approved: ${scalarText(commit)}` });
      }
    }
  }

  if (review) {
    const rv = entry.get("review", true);
    if (!isMap(rv)) return { problem: CANNOT };
    for (const key of ["by", "on", "commit", "licence"] as const) {
      const node = pairOf(rv, key)?.value as Scalar | null | undefined;
      const r = rangeOf(node);
      if (!isScalar(node) || !r) return { problem: CANNOT };
      splices.push({ start: r[0], end: r[1], text: scalarText(review[key], node.type) });
    }
  }
  return { text: apply(text, splices) };
}

/** The entry as plain data, in the order the file documents. */
function plainEntry(e: SkillLibrarySource): Record<string, unknown> {
  return {
    id: e.id,
    repository: e.repository,
    status: e.status,
    ref: { ...(e.ref.track !== undefined ? { track: e.ref.track } : {}), ...(e.ref.approved !== undefined ? { approved: e.ref.approved } : {}) },
    paths: [...e.paths],
    adapter: e.adapter,
    trust: e.trust,
    licence: { allow: [...e.licence.allow] },
    update: { cadence: e.update.cadence, ...(e.update.reviewer ? { reviewer: e.update.reviewer } : {}) },
    owner: e.owner,
    ...(e.review ? { review: { by: e.review.by, on: e.review.on, commit: e.review.commit, licence: e.review.licence } } : {}),
  };
}

/** Adds one entry at the end of `sources`. Without a file text, makes a new file. Every other byte stays. */
export function addConnectorEntry(text: string | undefined, entry: SkillLibrarySource): { text: string } | Problem {
  const plain = plainEntry(entry);
  if (text === undefined) return { text: stringify({ schema: 1, sources: [plain] }, { lineWidth: 0 }) };
  const doc = parse(text);
  if (!doc || !isMap(doc.contents)) return { problem: CANNOT };
  const seq = doc.contents.get("sources", true);
  if (!isSeq(seq)) return { problem: CANNOT };
  const range = rangeOf(seq);
  if (!range) return { problem: CANNOT };
  const last = seq.items.at(-1);
  if (seq.flow) {
    if (!last) return { text: apply(text, [{ start: range[0] + 1, end: range[0] + 1, text: JSON.stringify(plain) }]) };
    const end = rangeOf(last)?.[1];
    if (end === undefined) return { problem: CANNOT };
    return { text: apply(text, [{ start: end, end, text: `, ${JSON.stringify(plain)}` }]) };
  }
  const first = seq.items[0];
  const firstAt = rangeOf(first)?.[0];
  const end = contentEnd(last);
  if (firstAt === undefined || end === undefined) return { problem: CANNOT };
  const before = text.slice(lineStart(text, firstAt), firstAt);
  if (!/^ *- *$/.test(before)) return { problem: CANNOT };
  const dash = before.indexOf("-");
  const lines = stringify([plain], { lineWidth: 0 }).replace(/\n$/, "").split("\n").map((l) => " ".repeat(dash) + l);
  const at = lineEnd(text, end);
  return { text: apply(text, [{ start: at, end: at, text: "\n" + lines.join("\n") }]) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Proves the edit: the new text is valid YAML, passes `parseSources` (connector rules included), the entry holds the new
 * commit (and review), and every other entry is deep-equal to what it was.
 */
export function checkEdit(before: string | undefined, after: string, id: string, commit: string, today: string, review?: SourceReview): { ok: true; entry: SkillLibrarySource } | Problem {
  let raw: unknown;
  try {
    raw = parseYaml(after, { maxAliasCount: 0 });
  } catch {
    return { problem: "the edited skill-sources.yaml is not valid YAML" };
  }
  const parsed = parseSources(raw, today);
  if (!parsed.manifest) return { problem: `the edited skill-sources.yaml is not valid: ${parsed.problems[0]?.where ?? "file"}: ${parsed.problems[0]?.message ?? "unknown"}` };
  const entry = parsed.manifest.sources.find((s) => s.id === id);
  if (!entry || entry.ref.approved !== commit) return { problem: "the edited skill-sources.yaml does not hold the new commit" };
  if (review && !same(entry.review, review)) return { problem: "the edited skill-sources.yaml does not hold the new review" };
  let old: unknown[] = [];
  if (before !== undefined) {
    try {
      const b = parseYaml(before, { maxAliasCount: 0 }) as { sources?: unknown } | null;
      old = Array.isArray(b?.sources) ? b.sources : [];
    } catch {
      return { problem: "the skill-sources.yaml of the default branch is not valid YAML" };
    }
  }
  const now = (raw as { sources: unknown[] }).sources;
  const idOf = (e: unknown) => (e as { id?: unknown } | null)?.id;
  const keptOld = old.filter((e) => idOf(e) !== id);
  const keptNow = now.filter((e) => idOf(e) !== id);
  if (keptOld.length !== keptNow.length || keptOld.some((e, i) => !same(e, keptNow[i]))) return { problem: "the edit would change another entry of skill-sources.yaml" };
  if (now.length - keptNow.length !== 1) return { problem: "the edited skill-sources.yaml holds the source twice" };
  return { ok: true, entry };
}

/** `owner/name` for github.com, else `host/owner/name`, from the address of a remote; undefined for anything else (a local path). */
export function repoFromUrl(url: string): string | undefined {
  const NAME = /^[A-Za-z0-9._-]+$/;
  const m =
    /^https:\/\/(?:[^@/\s]+@)?([^/:@\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^ssh:\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/\s:]+@)?([^/:@\s]+):([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (!m) return undefined;
  const [, host, owner, name] = m as unknown as [string, string, string, string];
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !NAME.test(owner) || !NAME.test(name)) return undefined;
  return host.toLowerCase() === "github.com" ? `${owner}/${name}` : `${host.toLowerCase()}/${owner}/${name}`;
}

const code = (s: string): string => "`" + shownFull(s).replace(/<!--/g, "<!- -").replace(/`/g, "'") + "`";

/** Lines of a list while they fit in `budget` bytes; the rest is one "… and N more" line. Each shown item is whole. */
export function boundedList(items: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (let i = 0; i < items.length; i++) {
    const add = Buffer.byteLength(items[i]! + "\n");
    if (bytes + add > budget) {
      out.push(`- … and ${items.length - i} more`);
      break;
    }
    out.push(items[i]!);
    bytes += add;
  }
  return out;
}

/** The gates of the new import that the review report does not hold. A `SourceChange` carries them too. */
export interface ImportGates {
  /** An allowed licence still needs a matching `licence.reviewed`. */
  licenceUnreviewed: boolean;
  /** Skills without a passing evaluation record for their digest. */
  evaluationOpen: number;
}

export type AttentionPart ="security" | "licence" | "evaluation" | "review";

/**
 * The parts of the verdict that fail. `security`: a blocked scan or a blocking collision. `licence`: a licence that is not
 * allowed, or evidence that `licence.reviewed` does not cover. `evaluation`: an added or changed skill without a passing record
 * for its new digest. `review`: problems of the report. `reviewFailed` holds exactly when security, licence or review is named.
 */
export function attentionParts(report: ImportReview, gates?: ImportGates): AttentionPart[] {
  const skills = report.categories.flatMap((c) => c.skills);
  const parts: AttentionPart[] = [];
  if (skills.some((s) => s.scan.blocked) || report.collisions.some((c) => c.blocking)) parts.push("security");
  if (skills.some((s) => s.licence.status !== "allowed") || gates?.licenceUnreviewed) parts.push("licence");
  if (gates !== undefined && gates.evaluationOpen > 0) parts.push("evaluation");
  if (report.problems.length > 0) parts.push("review");
  return parts;
}

/** The first words of the note an unattended run adds to the pull request; a refresh looks for it. */
export const REVIEW_PENDING_NOTE = "This pull request was opened by an unattended run (`scf skills update --due`).";

export interface UpdatePullRequestInput {
  source: Pick<SkillLibrarySource, "id" | "repositoryKey" | "paths" | "trust" | "status">;
  oldCommit?: string;
  commit: string;
  track?: string;
  review?: SourceReview;
  rejected: readonly RejectedSkill[];
  report: ImportReview;
  /** What changed since `oldCommit`, or that it could not be compared. Ignored for a first import. */
  change?: SourceChange | "not-compared";
  /** The gates of the new import, used when the change is not known (the old commit could not be compared). */
  gates?: ImportGates;
  /** Open pull requests of older revisions of this source. They are only listed. */
  supersedes?: readonly { url: string; branch: string }[];
  /** An unattended run named the reviewer; the review has not happened yet. Adds a note after the merge line. */
  reviewPending?: boolean;
}

/** The title and the Markdown body of the pull request: values and the review report only, never upstream skill text. */
export function updatePullRequest(o: UpdatePullRequestInput): { title: string; body: string } {
  const { source, oldCommit, commit } = o;
  const c12 = commit.slice(0, 12);
  const parts = attentionParts(o.report, oldCommit ? (typeof o.change === "object" ? o.change : o.gates) : undefined);
  const title = oldCommit ? `Skill source ${source.id}: update to ${c12}` : `Skill source ${source.id}: first import at ${c12}`;
  const head: string[] = [
    `## Skill source ${oldCommit ? "update" : "first import"}: ${code(source.id)}`,
    "",
    `- Repository: ${code(source.repositoryKey)}`,
    `- Tracked ref: ${o.track !== undefined ? code(o.track) : "`HEAD`"}`,
    `- Old commit: ${oldCommit ? code(oldCommit) : "none (first import)"}`,
    `- New commit: ${code(commit)}`,
    `- Verdict: ${parts.length > 0 ? `needs attention: ${parts.join(", ")} (see below)` : "no blocking finding"}. Nothing is promoted until the gates pass.`,
    "",
    "Selected paths:",
    "",
    ...boundedList(source.paths.map((p) => `- ${code(p)}`), PATHS_BYTES),
    "",
    `This pull request changes only \`skill-sources.yaml\`. Nothing is promoted or released, and nothing counts as approved until it is merged.`,
  ];
  if (o.review) {
    head.push(
      "",
      `Merging records that ${code(o.review.by)} reviewed the maintainer and licence ${code(o.review.licence)} of ${code(commit.slice(0, 12))} on ${o.review.on}. Do not merge unless that is true.`,
    );
    if (o.reviewPending) {
      head.push("", `${REVIEW_PENDING_NOTE} ${code(o.review.by)} (from \`update.reviewer\`) is named as the reviewer and has not reviewed it yet. Do not merge before that review is done.`);
    }
  }
  if (o.supersedes !== undefined && o.supersedes.length > 0) {
    head.push("", "Supersedes (these stay open and are not changed):", "", ...boundedList(o.supersedes.map((p) => `- ${p.url} (${code(p.branch)})`), SUPERSEDES_BYTES));
  }
  if (o.rejected.length > 0) {
    head.push("", "Rejected skill roots (not staged):", "", ...boundedList(o.rejected.map((r) => `- ${code(r.root)}: ${r.reasons.map(code).join("; ")}`), REJECTED_BYTES));
  }
  const header = head.join("\n") + "\n\n";
  const headerBytes = Buffer.byteLength(header);
  let changes = "";
  if (oldCommit && o.change !== undefined) {
    changes =
      o.change === "not-compared"
        ? notComparedMarkdown(oldCommit)
        : sourceChangeMarkdown(o.change, { bytes: Math.max(1000, Math.min(SOURCE_CHANGE_LIMITS.bytes, PULL_REQUEST_BYTES - headerBytes - 1000)) });
    changes += "\n";
  }
  const report = reviewMarkdown(o.report, { bytes: Math.max(1000, PULL_REQUEST_BYTES - headerBytes - Buffer.byteLength(changes)) });
  return { title, body: header + changes + report };
}
