import { createHash } from "node:crypto";
import { evaluationGate, type EvaluationPolicy } from "./evaluation.js";
import type { ImportReview, ReviewedSkill } from "./import-review.js";
import { byteCmp } from "./import-plan.js";
import type { OverlapEntry, OverlapReport, OverlapSkill } from "./overlap.js";
import { shownFull } from "./sources.js";
import { filesOf } from "./scan-staged.js";

// What changed between the approved commit of a source and a new one: skill roots, files, metadata, licences, scan results,
// evaluation records and the canonical skills they touch. Pure: no file system, no process, no clock. Every free value goes
// through `shownFull` and a code span; the text of an upstream skill is never read. A skill whose digest changed never takes
// over the evaluation verdict of its old digest.

export const SOURCE_CHANGE_LIMITS = { bytes: 20_000, files: 20, capabilities: 50, canonical: 200, unchanged: 200 } as const;

export interface ComparedImport {
  review: ImportReview;
  files: ReadonlyMap<string, Uint8Array>;
  /** The digest of the licence evidence of the import. */
  licenceDigest?: string;
  /** An allowed licence still needs a matching `licence.reviewed` (the promotion gate). */
  licenceUnreviewed?: boolean;
  /** Per root: the capabilities as the catalogue sees them (profile and reviewed selections applied). Else `ReviewedSkill.capabilities`. */
  capabilities?: ReadonlyMap<string, readonly string[]>;
}

/** `unjudged`: a record exists, but no evaluation suite was available to judge it, so it cannot clear anything. */
export type RecordVerdict = { state: "none" } | { state: "invalid" } | { state: "unjudged" } | { state: "passed" } | { state: "failed"; reasons: string[] };
export const evaluationKey = (id: string, digest: string): string => `${id} ${digest}`;

/**
 * The verdict of a stored record, judged with the policy of the applicable suite. Without a policy a record is only reported
 * as present: a default policy would pass what a mandatory dimension fails. The reasons are fixed codes.
 */
export function recordVerdict(read: { state: "none" } | { state: "invalid" } | { state: "ok"; raw: unknown }, id: string, digest: string, policy?: EvaluationPolicy): RecordVerdict {
  if (read.state !== "ok") return { state: read.state };
  if (policy === undefined) return { state: "unjudged" };
  try {
    const safety = { schema: 1 as const, skill: id, digest, report: "", findings: [] };
    const verdict = evaluationGate({ mode: "new", policy, candidate: { record: read.raw, digest, safety, licence: "allowed" } }).verdicts[0];
    if (verdict === undefined || verdict.reasons.some((r) => r.code === "record-invalid" || r.code === "record-credential")) return { state: "invalid" };
    if (verdict.candidate.id !== undefined && verdict.candidate.id !== id) return { state: "invalid" };
    if (verdict.outcome === "passed") return { state: "passed" };
    return { state: "failed", reasons: [...new Set(verdict.reasons.map((r) => (r.dimension ? `${r.code}:${r.dimension}` : r.code)))].sort(byteCmp) };
  } catch {
    return { state: "invalid" };
  }
}

const reviewed = (r: ImportReview): ReviewedSkill[] => r.categories.flatMap((c) => c.skills);
const byRoot = (r: ImportReview) => new Map(reviewed(r).map((s) => [s.root, s] as const));

/** The (id, digest) pairs `compareImports` reads: the new digest of added and changed skills, the old digest of changed ones. */
export function evaluationLookups(old: ImportReview, next: ImportReview): { id: string; digest: string }[] {
  const was = byRoot(old);
  const seen = new Map<string, { id: string; digest: string }>();
  const add = (s: ReviewedSkill | undefined) => {
    if (s?.id !== undefined) seen.set(evaluationKey(s.id, s.digest), { id: s.id, digest: s.digest });
  };
  for (const s of reviewed(next)) {
    const o = was.get(s.root);
    if (o !== undefined && o.digest === s.digest) continue;
    add(s);
    add(o);
  }
  return [...seen.values()];
}

export type CanonicalInput = { next: OverlapReport; old?: OverlapReport } | { problem: string };
export type SkillChangeKind = "added" | "removed" | "changed" | "unchanged";
export interface Delta<T> { old: T; next: T }
export interface SkillChange {
  root: string;
  kind: SkillChangeKind;
  oldDigest?: string;
  newDigest?: string;
  /** Changed skills only; relative paths, byte-sorted. */
  files?: { added: string[]; removed: string[]; changed: string[] };
  metadata: { name?: Delta<string>; version?: Delta<string>; category?: Delta<string>; capabilities?: { added: string[]; removed: string[] } };
  licence: { status?: Delta<string>; licences?: Delta<string[]> };
  scan: { blocked?: Delta<boolean>; high?: Delta<number>; findings?: Delta<number> };
  /** Added and changed skills only. */
  evaluation?: { old?: RecordVerdict; next: RecordVerdict | { state: "not-normalized" } };
}
/** `newConflict` is undefined when the old report is not known. */
export interface CanonicalChange { entry: OverlapEntry; newConflict?: boolean }
export interface SourceChange {
  oldCommit: string;
  newCommit: string;
  oldDigest: string;
  newDigest: string;
  counts: Record<SkillChangeKind, number>;
  /** Changed, added, removed, unchanged; then by root. */
  skills: SkillChange[];
  /** Only when it differs. */
  licenceDigest?: Delta<string | undefined>;
  /** The new import: an allowed licence still needs a matching `licence.reviewed`. */
  licenceUnreviewed: boolean;
  /** `omitted`: affected entries beyond the limit that are not listed. New conflicts are kept first. */
  canonical: { entries: CanonicalChange[]; omitted: number } | { problem: string };
  /** Added and changed skills whose new digest has no passing record. */
  evaluationOpen: number;
}

const ORDER: Record<SkillChangeKind, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const delta = <T>(old: T, next: T): Delta<T> | undefined => (old === next ? undefined : { old, next });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function diffFiles(root: string, a: ReadonlyMap<string, Uint8Array>, b: ReadonlyMap<string, Uint8Array>) {
  const was = new Map(filesOf(root, a).map((f) => [f.path, sha(f.content)] as const));
  const now = new Map(filesOf(root, b).map((f) => [f.path, sha(f.content)] as const));
  return {
    added: [...now.keys()].filter((p) => !was.has(p)).sort(byteCmp),
    removed: [...was.keys()].filter((p) => !now.has(p)).sort(byteCmp),
    changed: [...now].filter(([p, h]) => was.has(p) && was.get(p) !== h).map(([p]) => p).sort(byteCmp),
  };
}

const verdictOf = (m: ReadonlyMap<string, RecordVerdict>, s: ReviewedSkill): RecordVerdict => (s.id === undefined ? { state: "none" } : (m.get(evaluationKey(s.id, s.digest)) ?? { state: "none" }));

export function compareImports(old: ComparedImport, next: ComparedImport, evaluations: ReadonlyMap<string, RecordVerdict>, canonical: CanonicalInput): SourceChange {
  const was = byRoot(old.review);
  const now = byRoot(next.review);
  const skills: SkillChange[] = [];
  for (const root of new Set([...was.keys(), ...now.keys()])) {
    const o = was.get(root);
    const n = now.get(root);
    const kind: SkillChangeKind = o === undefined ? "added" : n === undefined ? "removed" : o.digest === n.digest ? "unchanged" : "changed";
    const row: SkillChange = { root, kind, ...(o ? { oldDigest: o.digest } : {}), ...(n ? { newDigest: n.digest } : {}), metadata: {}, licence: {}, scan: {} };
    if (o && n) {
      if (kind === "changed") row.files = diffFiles(root, old.files, next.files);
      const name = delta(o.name, n.name);
      const version = delta(o.version ?? "-", n.version ?? "-");
      const category = delta(o.category, n.category);
      if (name) row.metadata.name = name;
      if (version) row.metadata.version = version;
      if (category) row.metadata.category = category;
      const oc = o.capabilities ?? [];
      const nc = n.capabilities ?? [];
      if (!same(oc, nc)) row.metadata.capabilities = { added: nc.filter((c) => !oc.includes(c)), removed: oc.filter((c) => !nc.includes(c)) };
      const status = delta<string>(o.licence.status, n.licence.status);
      const ids = same(o.licence.licences, n.licence.licences) ? undefined : { old: o.licence.licences, next: n.licence.licences };
      if (status) row.licence.status = status;
      if (ids) row.licence.licences = ids;
      const blocked = delta(o.scan.blocked, n.scan.blocked);
      const high = delta(o.scan.high, n.scan.high);
      const findings = delta(o.scan.findings, n.scan.findings);
      if (blocked) row.scan.blocked = blocked;
      if (high) row.scan.high = high;
      if (findings) row.scan.findings = findings;
    }
    if (n && (kind === "added" || kind === "changed")) {
      row.evaluation = { next: n.id === undefined ? { state: "not-normalized" } : verdictOf(evaluations, n) };
      if (kind === "changed" && o?.id !== undefined) row.evaluation.old = verdictOf(evaluations, o);
    }
    skills.push(row);
  }
  skills.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || byteCmp(a.root, b.root));
  const counts: Record<SkillChangeKind, number> = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const s of skills) counts[s.kind]++;
  const evaluationOpen = skills.filter((s) => s.evaluation !== undefined && s.evaluation.next.state !== "passed").length;

  return {
    oldCommit: old.review.commit,
    newCommit: next.review.commit,
    oldDigest: old.review.digest,
    newDigest: next.review.digest,
    counts,
    skills,
    ...(old.licenceDigest !== next.licenceDigest && (old.licenceDigest !== undefined || next.licenceDigest !== undefined) ? { licenceDigest: { old: old.licenceDigest, next: next.licenceDigest } } : {}),
    licenceUnreviewed: next.licenceUnreviewed === true,
    canonical: canonicalChanges(canonical, skills, now, next),
    evaluationOpen,
  };
}

function canonicalChanges(input: CanonicalInput, skills: readonly SkillChange[], now: ReadonlyMap<string, ReviewedSkill>, next: ComparedImport): SourceChange["canonical"] {
  if ("problem" in input) return { problem: input.problem };
  // The capabilities the catalogue sees (profile and selections applied), not the raw ones of the package.
  const affected = new Set<string>();
  for (const s of skills) {
    if (s.kind !== "added" && s.kind !== "changed") continue;
    for (const c of next.capabilities?.get(s.root) ?? now.get(s.root)?.capabilities ?? []) affected.add(c);
  }
  const before = input.old === undefined ? undefined : new Map(input.old.entries.map((e) => [e.capability, e] as const));
  const entries: CanonicalChange[] = [];
  for (const e of input.next.entries) {
    const newConflict = e.kind === "conflict" ? (before === undefined ? undefined : before.get(e.capability)?.kind !== "conflict") : undefined;
    if (!affected.has(e.capability) && newConflict !== true) continue;
    entries.push({ entry: e, ...(newConflict !== undefined ? { newConflict } : {}) });
  }
  const rank = (c: CanonicalChange) => (c.newConflict === true ? 0 : c.entry.kind === "conflict" ? 1 : 2);
  const kept = [...entries].sort((a, b) => rank(a) - rank(b) || byteCmp(a.entry.capability, b.entry.capability)).slice(0, SOURCE_CHANGE_LIMITS.canonical);
  kept.sort((a, b) => byteCmp(a.entry.capability, b.entry.capability));
  return { entries: kept, omitted: entries.length - kept.length };
}

// ---- Markdown ----

/** A free value in a code span. Credentials are hidden; a bot marker, a backtick and a pipe cannot act as such. */
const code = (s: string): string => "`" + shownFull(s).replace(/<!--/g, "<!- -").replace(/`/g, "'").replace(/\|/g, "\\|") + "`";
const short = (c: string) => c.slice(0, 12);

/** Appends lines while they fit; the first that does not ends the output with a notice. Always ends with one newline. */
function bounded(lines: readonly string[], limit: number): string {
  const kept: string[] = [];
  let bytes = 0;
  const room = limit - 200;
  for (let i = 0; i < lines.length; i++) {
    const add = Buffer.byteLength(lines[i]! + "\n");
    if (bytes + add > room) {
      kept.push("", `_${lines.length - i} more lines were left out._`);
      return kept.join("\n") + "\n";
    }
    kept.push(lines[i]!);
    bytes += add;
  }
  return kept.join("\n") + "\n";
}

const heading = (oldCommit: string) => `### Changes since ${code(short(oldCommit))}`;

/** The section when the old commit could not be staged or read. */
export function notComparedMarkdown(oldCommit: string): string {
  return `${heading(oldCommit)}\n\nThe old commit ${code(oldCommit)} could not be staged or read, so it could not be compared.\n`;
}

/** The line the command prints before REVIEWED. */
export function sourceChangeLine(c: SourceChange | "not-compared", oldCommit: string): string {
  if (c === "not-compared") return `CHANGES the old commit ${short(oldCommit)} could not be compared`;
  const k = c.counts;
  const open = c.evaluationOpen > 0 ? `; ${c.evaluationOpen} need${c.evaluationOpen === 1 ? "s" : ""} a new evaluation record` : "";
  return `CHANGES since ${short(c.oldCommit)}: ${k.changed} changed, ${k.added} added, ${k.removed} removed, ${k.unchanged} unchanged${open}`;
}

function list(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).map(code);
  if (items.length > max) shown.push(`… and ${items.length - max} more`);
  return shown.join(", ");
}
const yesNo = (b: boolean) => (b ? "yes" : "no");
const arrow = <T>(d: Delta<T>, f: (v: T) => string) => `${f(d.old)} → ${f(d.next)}`;

function evaluationText(e: NonNullable<SkillChange["evaluation"]>): string {
  const old = (v: RecordVerdict): string => {
    switch (v.state) {
      case "passed": return "passed";
      case "failed": return `failed (${v.reasons.map(code).join(", ")})`;
      case "none": return "no record";
      case "unjudged": return "record found, not judged (no evaluation suite)";
      case "invalid": return "record cannot be read";
    }
  };
  const n = e.next;
  let now: string;
  switch (n.state) {
    case "not-normalized": now = "not normalized"; break;
    case "passed": now = "passed"; break;
    case "failed": now = `failed (${n.reasons.map(code).join(", ")}) — needs a new record`; break;
    case "none": now = "needs a new record"; break;
    case "unjudged": now = "record found, not judged (no evaluation suite) — needs a new record"; break;
    case "invalid": now = "record cannot be read — needs a new record"; break;
  }
  return e.old === undefined ? `new digest: ${now}` : `old digest: ${old(e.old)}; new digest: ${now}`;
}

function skillText(e: OverlapSkill): string {
  return `${code(`${e.id}@${e.version}`)} (${e.origin}${e.provider ? `, provider ${code(e.provider)}` : ""})`;
}
function canonicalRow(c: CanonicalChange): string {
  const e = c.entry;
  const cap = code(e.capability);
  switch (e.kind) {
    case "canonical": return `| ${cap} | canonical (${e.level}) | ${skillText(e.winner)} |`;
    case "conflict": return `| ${cap} | CONFLICT ${e.conflict}${c.newConflict ? " (new conflict)" : ""} | ${e.skills.map(skillText).join(", ")} |`;
    case "none": return `| ${cap} | no skill can be used | - |`;
    case "new": return `| ${cap} | new | ${skillText(e.skill)} |`;
  }
}

function details(s: SkillChange): string[] {
  const out: string[] = [];
  const f = s.files;
  if (f) {
    const parts = [
      ["added", f.added],
      ["removed", f.removed],
      ["changed", f.changed],
    ] as const;
    for (const [what, paths] of parts) if (paths.length) out.push(`- Files ${what} (${paths.length}): ${list(paths, SOURCE_CHANGE_LIMITS.files)}`);
  }
  const m = s.metadata;
  if (m.name) out.push(`- Name: ${arrow(m.name, code)}`);
  if (m.version) out.push(`- Version: ${arrow(m.version, code)}`);
  if (m.category) out.push(`- Category: ${arrow(m.category, code)}`);
  if (m.capabilities) {
    const { added, removed } = m.capabilities;
    out.push(`- Capabilities:${added.length ? ` added ${list(added, SOURCE_CHANGE_LIMITS.capabilities)}` : ""}${added.length && removed.length ? ";" : ""}${removed.length ? ` removed ${list(removed, SOURCE_CHANGE_LIMITS.capabilities)}` : ""}`);
  }
  const l = s.licence;
  if (l.status || l.licences) {
    const bits: string[] = [];
    if (l.status) bits.push(`status ${arrow(l.status, code)}`);
    if (l.licences) bits.push(`licences ${arrow(l.licences, (v) => (v.length ? list(v, SOURCE_CHANGE_LIMITS.capabilities) : "none"))}`);
    out.push(`- Licence: ${bits.join("; ")}`);
  }
  const c = s.scan;
  if (c.blocked || c.high || c.findings) {
    const bits: string[] = [];
    if (c.blocked) bits.push(`blocked ${arrow(c.blocked, yesNo)}`);
    if (c.high) bits.push(`high findings ${arrow(c.high, String)}`);
    if (c.findings) bits.push(`findings ${arrow(c.findings, String)}`);
    out.push(`- Scan: ${bits.join("; ")}`);
  }
  if (s.evaluation) out.push(`- Evaluation: ${evaluationText(s.evaluation)}`);
  return out;
}

/** The "Changes since" section of the pull request: values and fixed words only, never more than `limits.bytes`. */
export function sourceChangeMarkdown(c: SourceChange, limits: { bytes?: number } = {}): string {
  const k = c.counts;
  const lines: string[] = [heading(c.oldCommit), ""];
  lines.push(
    `Old commit ${code(c.oldCommit)} (import digest ${code(c.oldDigest)}), new commit ${code(c.newCommit)} (import digest ${code(c.newDigest)}). ` +
      `${k.changed} changed, ${k.added} added, ${k.removed} removed, ${k.unchanged} unchanged.` +
      (c.evaluationOpen > 0 ? ` ${c.evaluationOpen} added or changed skill${c.evaluationOpen === 1 ? " needs" : "s need"} a new evaluation record.` : ""),
  );
  if (c.licenceDigest) lines.push("", `Licence evidence digest: ${arrow(c.licenceDigest, (v) => (v === undefined ? "none" : code(v)))}.`);
  else lines.push("", "Licence evidence digest: unchanged.");
  if (c.licenceUnreviewed) lines.push("", "The licence evidence is not covered by `licence.reviewed` (missing or changed): the licence needs a review.");

  lines.push("", "#### Affected canonical skills", "");
  if ("problem" in c.canonical) lines.push(`The canonical skills could not be compared: ${code(c.canonical.problem)}`);
  else if (c.canonical.entries.length === 0) lines.push("No capability of an added or changed skill is affected.");
  else {
    lines.push("| Capability | Result | Skills |", "| --- | --- | --- |", ...c.canonical.entries.map(canonicalRow));
    if (c.canonical.omitted > 0) lines.push("", `… and ${c.canonical.omitted} more affected capabilities were left out (new conflicts are listed first).`);
  }

  const moved = c.skills.filter((s) => s.kind !== "unchanged");
  const shown = c.skills.filter((s) => s.kind !== "unchanged" || details(s).length > 0);
  if (moved.length === 0 && shown.length === 0) {
    lines.push("", "No skill changed.");
  } else {
    if (moved.length > 0) {
      lines.push("", "#### Skills", "", "| Skill root | Change | Old digest | New digest |", "| --- | --- | --- | --- |");
      for (const s of moved) lines.push(`| ${code(s.root)} | ${s.kind} | ${s.oldDigest ? code(s.oldDigest) : "-"} | ${s.newDigest ? code(s.newDigest) : "-"} |`);
    }
    if (shown.length > 0) {
      lines.push("", "#### Details");
      for (const s of shown) lines.push("", `${code(s.root)} (${s.kind}):`, ...details(s));
    }
  }
  const unchanged = c.skills.filter((s) => s.kind === "unchanged").map((s) => s.root);
  if (unchanged.length > 0) lines.push("", `Unchanged (${unchanged.length}): ${list(unchanged, SOURCE_CHANGE_LIMITS.unchanged)}`);
  return bounded(lines, Math.min(limits.bytes ?? SOURCE_CHANGE_LIMITS.bytes, SOURCE_CHANGE_LIMITS.bytes));
}
