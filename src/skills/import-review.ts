import { createHash } from "node:crypto";
import { classifySkillCollisions, collisionCandidate, type CollisionCandidate, type CollisionMember, type SkillCollision } from "./collisions.js";
import { COLLISION_LIMITS } from "./collision-rules.js";
import { REVIEW_CATEGORY_TERMS, REVIEW_LIMITS, REVIEW_TRUST } from "./import-review-rules.js";
import { exclusionReasons, importExclusions } from "./import-exclusions.js";
import { buildSkillIdentity } from "./identity.js";
import { byteCmp, type ImportRecord } from "./import-plan.js";
import { evaluateLicence, type LicenceEvidence, type LicenceStatus } from "./licence.js";
import { normalizeImport, type NormalizedSkill } from "./normalize.js";
import type { RegisteredSkill } from "./registry.js";
import { scanSkill } from "./scan.js";
// A report holds whole values, so nothing is cut per field: `shownValue` here is credential hiding and escaping only.
import { shownFull as shownValue, type SkillLibrarySource } from "./sources.js";
import { filesOf } from "./staged-import.js";

// The review report of a staged import: licence, attribution, scan result and collisions with the registered skills.
// Pure: no file system, no process, no clock. The same input gives the same output.

type FileList = readonly { path: string; content: Uint8Array }[];

export interface ReviewedSkill {
  /** The full upstream root; the sort key. Printed through `shownValue`. */
  root: string;
  name: string;
  digest: string;
  /** Absent when the skill was not normalized. */
  id?: string;
  version?: string;
  fingerprint?: string;
  category: string;
  categoryFrom: "declared" | "name" | "default";
  trust: typeof REVIEW_TRUST;
  promoted: false;
  notNormalized?: string[];
  licence: {
    status: LicenceStatus;
    reasons: string[];
    licences: string[];
    attribution: { path: string; sha256: string; bytes: number }[];
    authorNotice: string[];
  };
  scan: { blocked: boolean; findings: number; high: number; reasons: string[] };
  /** `id@version (label)` of the existing skills whose id equals the upstream name. */
  sameName: string[];
}
export interface ReviewCategory {
  category: string;
  existing: string[];
  skills: ReviewedSkill[];
}
export interface ImportReview {
  schema: 1;
  source: string;
  repositoryKey: string;
  commit: string;
  digest: string;
  categories: ReviewCategory[];
  /** Only collisions with an imported member, in the order of the classifier. */
  collisions: SkillCollision[];
  compared: { imported: number; existing: number };
  problems: string[];
}
export interface ExistingSkill {
  skill: RegisteredSkill;
  /** SKILL.md, skill.yaml, REVIEW.md and the files of the four folders: what `skillDigest` covers. */
  files: FileList;
}

const REGISTERED_PREFIX = "scf:";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sortedUnique = (xs: readonly string[]) => [...new Set(xs)].sort(byteCmp);
const keyOf = (s: RegisteredSkill) => `${s.id}@${s.version} (${s.label})`;

/** A collision candidate for a registered (built-in or administrator) skill. Trusted and approved; never holds a path of the machine. */
export function registeredCandidate(s: RegisteredSkill, files: FileList): CollisionCandidate {
  const source = REGISTERED_PREFIX + s.source;
  const skill: NormalizedSkill = {
    package: s.pkg,
    extraFiles: [],
    identity: buildSkillIdentity({ id: s.id, source, repositoryKey: source, name: s.id, version: s.version, versionDeclared: true, digest: s.digest, files }),
    provenance: {
      schema: 1, source, repository: source, repositoryKey: source, commit: "",
      // One root per registered package, so a shadowed copy is a member of its own.
      root: `${s.label}/${s.key}`, name: s.id, layout: "foundry", versionDeclared: true,
      dependencies: s.pkg.dependencies.map((d) => ({ name: d.id, id: d.id })),
      technologies: [], requiredTools: [],
      entryPoints: { instructions: "SKILL.md", scripts: [], documents: [] },
      context: { instructions: 0, text: 0 }, upstream: {},
    },
  };
  return { skill, approved: true, trust: "first-party", licencesAllowed: [] };
}

/** The SCF category of an imported skill: the declared one, else a guess from the hyphen-bounded parts of its name. */
export function reviewCategory(
  name: string,
  declared: string | undefined,
  existing: readonly { id: string; category: string }[],
): { category: string; from: "declared" | "name" | "default" } {
  if (declared !== undefined && declared !== "general") return { category: declared, from: "declared" };
  const n = `-${name.toLowerCase()}-`;
  const known = existing.filter((e) => e.category !== "general").sort((a, b) => b.id.length - a.id.length || byteCmp(a.id, b.id));
  const hit = known.find((e) => n.includes(`-${e.id}-`));
  if (hit) return { category: hit.category, from: "name" };
  for (const row of REVIEW_CATEGORY_TERMS) if (row.terms.some((t) => n.includes(`-${t}-`))) return { category: row.category, from: "name" };
  return { category: "general", from: "default" };
}

export function reviewImport(input: {
  source: SkillLibrarySource;
  record: ImportRecord;
  files: ReadonlyMap<string, Uint8Array>;
  evidence: LicenceEvidence;
  existing: readonly ExistingSkill[];
  problems?: readonly string[];
}): ImportReview {
  const { source, record, files, evidence } = input;
  const existing = [...input.existing].sort((a, b) => byteCmp(a.skill.id, b.skill.id) || byteCmp(a.skill.version, b.skill.version) || byteCmp(a.skill.label, b.skill.label));
  const problems = [...(input.problems ?? [])];
  const known = existing.map((e) => ({ id: e.skill.id, category: e.skill.pkg.category }));

  const normalized = normalizeImport({ record: { ...record, rejected: [] }, files }).skills;
  const byRoot = new Map(normalized.map((s) => [s.provenance.root, s]));
  const entries = [...record.skills].sort((a, b) => byteCmp(a.root, b.root));

  const reviewed: ReviewedSkill[] = [];
  const imported: CollisionCandidate[] = [];
  for (const entry of entries) {
    // Normalized alone, so a skill that shares a name or id with another still gets an identity and is compared.
    const alone = normalizeImport({ record: { ...record, skills: [entry], rejected: [] }, files });
    const skill = alone.skills[0];
    const duplicate = skill !== undefined && !byRoot.has(entry.root);
    const verdict = evaluateLicence({
      root: entry.root,
      ...(skill?.package.license !== undefined ? { declared: skill.package.license } : {}),
      allow: source.licence.allow,
      evidence,
    });
    const scan = scanSkill({ root: entry.root, files: filesOf(entry.root, files) });
    const high = scan.findings.filter((f) => f.severity === "high").length;
    const excluded = skill ? exclusionReasons(importExclusions(skill)) : [];
    const reasons = [...(high > 0 ? [`${high} high finding${high === 1 ? "" : "s"}`] : []), ...excluded, ...(skill ? [] : ["not normalized"]), ...(duplicate ? ["another skill of this source has the same name or id"] : [])];
    const cat = reviewCategory(entry.name, skill?.package.category, known);
    const row: ReviewedSkill = {
      root: entry.root,
      name: entry.name,
      digest: entry.digest,
      ...(skill ? { id: skill.package.id, version: skill.package.version, fingerprint: skill.identity.fingerprint } : {}),
      category: cat.category,
      categoryFrom: cat.from,
      trust: REVIEW_TRUST,
      promoted: false,
      licence: {
        status: verdict.status,
        reasons: [...verdict.reasons],
        licences: [...verdict.licences],
        attribution: verdict.attribution.map((a) => ({ path: a.path, sha256: sha256(a.content), bytes: a.content.byteLength })),
        authorNotice: [...verdict.authorNotice],
      },
      scan: { blocked: reasons.length > 0, findings: scan.findings.length, high, reasons },
      sameName: sortedUnique(existing.filter((e) => e.skill.id === entry.name).map((e) => keyOf(e.skill))),
    };
    if (!skill) {
      row.notNormalized = alone.report.quarantined[0]?.reasons ?? ["could not be normalized"];
    } else {
      imported.push({ ...collisionCandidate(skill, source), trust: REVIEW_TRUST });
    }
    reviewed.push(row);
  }

  const all = [...imported, ...existing.map((e) => registeredCandidate(e.skill, e.files))];
  let collisions: SkillCollision[] = [];
  if (all.length > COLLISION_LIMITS.candidates) {
    problems.push(`more than ${COLLISION_LIMITS.candidates} skills to compare (${all.length}); collisions were not checked`);
  } else {
    collisions = classifySkillCollisions(all).report.collisions.filter((c) => c.members.some((m) => m.source === source.id));
  }

  const names = new Set(reviewed.map((r) => r.category));
  const categories: ReviewCategory[] = [...names].sort(byteCmp).map((category) => ({
    category,
    existing: sortedUnique(existing.filter((e) => e.skill.pkg.category === category).map((e) => e.skill.id)),
    skills: reviewed.filter((r) => r.category === category),
  }));
  return {
    schema: 1,
    source: source.id,
    repositoryKey: record.repositoryKey,
    commit: record.commit,
    digest: record.digest,
    categories,
    collisions,
    compared: { imported: imported.length, existing: existing.length },
    problems,
  };
}

const skillsOf = (r: ImportReview) => r.categories.flatMap((c) => c.skills);

/** True when a skill is blocked, a licence is not `allowed`, a collision blocks or a problem was found. */
export function reviewFailed(r: ImportReview): boolean {
  return r.problems.length > 0 || r.collisions.some((c) => c.blocking) || skillsOf(r).some((s) => s.scan.blocked || s.licence.status !== "allowed");
}

const tally = (r: ImportReview) => {
  const list = skillsOf(r);
  return {
    blocked: list.filter((s) => s.scan.blocked).length,
    licence: list.filter((s) => s.licence.status !== "allowed").length,
    collisions: r.collisions.length,
    blocking: r.collisions.filter((c) => c.blocking).length,
  };
};
const at = (r: ImportReview) => `${r.repositoryKey}@${r.commit.slice(0, 12)} ${r.digest}`;
const label = (s: ReviewedSkill) => s.id ?? shownValue(s.root);
const memberText = (m: CollisionMember) => `${m.id}@${m.version} (${m.source})`;
const sharedText = (c: SkillCollision) => (c.shared && c.shared.length ? c.shared.join(",") : "-");
const counts = (r: ImportReview) => {
  const t = tally(r);
  return `${t.blocked} blocked, ${t.licence} licence not allowed, ${t.collisions} collisions, ${t.blocking} blocking`;
};
const skillCount = (r: ImportReview) => `${skillsOf(r).length} skill${skillsOf(r).length === 1 ? "" : "s"}`;

/** The text report. Every member of every collision is printed. */
export function reviewLines(r: ImportReview): string[] {
  const out: string[] = [`REVIEW ${r.source} ${r.repositoryKey}@${r.commit.slice(0, 12)} ${r.digest} trust=${REVIEW_TRUST}`];
  for (const c of r.categories) {
    out.push(`CATEGORY ${c.category}: ${c.skills.length} imported; existing: ${c.existing.length ? c.existing.join(", ") : "none"}`);
    for (const s of c.skills) {
      const l = label(s);
      out.push(
        `SKILL ${s.id ?? "-"} ${shownValue(s.root)} name=${shownValue(s.name)} version=${s.version ?? "-"} ${s.digest} fingerprint=${s.fingerprint ?? "-"} category=${s.category} (${s.categoryFrom}) trust=${s.trust} not-promoted`,
      );
      if (s.notNormalized) out.push(`NOTNORMALIZED ${l}: ${s.notNormalized.map(shownValue).join("; ")}`);
      const lic = s.licence;
      out.push(`LICENCE ${l}: ${lic.status}${lic.licences.length ? " " + lic.licences.map(shownValue).join(",") : ""}${lic.reasons.length ? ` (${lic.reasons.map(shownValue).join("; ")})` : ""}`);
      for (const a of lic.attribution) out.push(`ATTRIBUTION ${l}: ${shownValue(a.path)} sha256:${a.sha256} ${a.bytes}`);
      for (const n of lic.authorNotice) out.push(`NOTICE ${l}: ${shownValue(n)}`);
      out.push(`SCAN ${l}: ${s.scan.blocked ? `blocked (${s.scan.reasons.map(shownValue).join("; ")})` : `ok, ${s.scan.findings} findings`}`);
      for (const n of s.sameName) out.push(`NAME ${l}: same name as existing ${n}`);
    }
  }
  for (const c of r.collisions) {
    out.push(`COLLISION ${c.id} ${c.class} ${c.reason} blocking=${c.blocking ? "yes" : "no"} members=${c.members.map(memberText).join(", ")} shared=${sharedText(c)}`);
  }
  for (const p of r.problems) out.push(`PROBLEM ${shownValue(p)}`);
  out.push(`REVIEWED ${skillCount(r)} from ${at(r)}: ${counts(r)}; nothing was promoted`);
  return out;
}

/** Free text in a code span. Credentials are hidden; a bot marker, a backtick and a pipe cannot act as such. */
const code = (s: string): string => "`" + shownValue(s).replace(/<!--/g, "<!- -").replace(/`/g, "'").replace(/\|/g, "\\|") + "`";
const cell = (s: string) => code(s);

/** Appends lines while they fit; the first that does not ends the output with a notice. Always ends with one newline. */
function bounded(lines: readonly string[], limit: number): string {
  const kept: string[] = [];
  let bytes = 0;
  const room = limit - 200;
  for (let i = 0; i < lines.length; i++) {
    const add = Buffer.byteLength(lines[i]! + "\n");
    if (bytes + add > room) {
      kept.push("", `_${lines.length - i} more lines were left out. Run \`scf skills review <source>\` for the full report._`);
      return kept.join("\n") + "\n";
    }
    kept.push(lines[i]!);
    bytes += add;
  }
  return kept.join("\n") + "\n";
}

const head = (source: string) => `## Skill import review: ${code(source)}`;

/** A failed review that found no staged import: the problems only, in the same bounded format. */
export function reviewProblemsMarkdown(source: string, problems: readonly string[], limits: { bytes?: number } = {}): string {
  return bounded([head(source), "", "### Problems", "", ...problems.map((p) => `- ${code(p.replace(/^PROBLEM /, ""))}`)], limits.bytes ?? REVIEW_LIMITS.markdownBytes);
}

/** The same facts as `reviewLines`, as a Markdown document for a pull-request body. The summary and the problems come first. */
export function reviewMarkdown(r: ImportReview, limits: { bytes?: number } = {}): string {
  const lines: string[] = [head(r.source), ""];
  lines.push(`Source ${code(r.source)}, repository ${code(r.repositoryKey)}, commit ${code(r.commit)}, import digest ${code(r.digest)}. Reviewed ${skillCount(r)}: ${counts(r)}; nothing was promoted.`);
  lines.push("", `Every skill is listed as ${code(REVIEW_TRUST)} and is not promoted.`);
  if (r.problems.length) lines.push("", "### Problems", "", ...r.problems.map((p) => `- ${code(p)}`));
  for (const c of r.categories) {
    lines.push("", `### ${code(c.category)}`, "", `Existing: ${c.existing.length ? c.existing.map(code).join(", ") : "none"}`, "");
    lines.push("| Skill | Path | Name | Version | Category | Licence | Scan | Same name | Digest | Fingerprint |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const s of c.skills) {
      const lic = `${s.licence.status}${s.licence.licences.length ? " " + s.licence.licences.join(",") : ""}`;
      lines.push(
        `| ${cell(s.id ?? "-")} | ${cell(s.root)} | ${cell(s.name)} | ${cell(s.version ?? "-")} | ${cell(`${s.category} (${s.categoryFrom})`)} | ${cell(lic)} | ${s.scan.blocked ? "blocked" : "ok"} | ${s.sameName.length ? s.sameName.map(cell).join(", ") : "-"} | ${cell(s.digest)} | ${cell(s.fingerprint ?? "-")} |`,
      );
    }
    for (const s of c.skills) {
      const l = code(label(s));
      const lic = s.licence;
      const notes: string[] = [];
      if (s.notNormalized) notes.push(`not normalized: ${s.notNormalized.map(code).join("; ")}`);
      if (lic.reasons.length) notes.push(`licence ${lic.status}: ${lic.reasons.map(code).join("; ")}`);
      if (s.scan.blocked) notes.push(`scan blocked: ${s.scan.reasons.map(code).join("; ")}`);
      else notes.push(`scan ok, ${s.scan.findings} findings`);
      for (const a of lic.attribution) notes.push(`attribution ${code(a.path)} sha256:${a.sha256} ${a.bytes} bytes`);
      for (const n of lic.authorNotice) notes.push(`notice ${code(n)}`);
      lines.push("", `${l} (${s.trust}, not promoted):`, ...notes.map((n) => `- ${n}`));
    }
  }
  if (r.collisions.length) {
    lines.push("", "### Collisions", "", "| Id | Class | Reason | Blocking | Members | Shared |", "| --- | --- | --- | --- | --- | --- |");
    for (const c of r.collisions) {
      const shown = c.members.slice(0, REVIEW_LIMITS.members).map((m) => cell(memberText(m)));
      if (c.members.length > REVIEW_LIMITS.members) shown.push(`and ${c.members.length - REVIEW_LIMITS.members} more`);
      lines.push(`| ${cell(c.id)} | ${c.class} | ${c.reason} | ${c.blocking ? "yes" : "no"} | ${shown.join(", ")} | ${cell(sharedText(c))} |`);
    }
  }
  return bounded(lines, limits.bytes ?? REVIEW_LIMITS.markdownBytes);
}
