import { resolve } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { dataHome } from "../auth/store.js";
import { OVERRIDES_FILE, PINS_FILE } from "./choice-rules.js";
import { choiceDigest, type SkillChoice, type SkillOverride } from "./choices.js";
import { readChoiceFile } from "./project-pins.js";
import { parseSkillKey, removeSkillPin, skillLockPath } from "./lock.js";
import { discoverSkills, pinBuiltinSkills, pinSkill, unreleasedSources, type DiscoverOptions } from "./registry.js";
import { releaseProblemText } from "./release.js";
import { applyConnector, connectorFor } from "./connector.js";
import { exclusionReasons, importExclusions } from "./import-exclusions.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { flowDir, parseFlow } from "../flow/load.js";
import { SkillImportError } from "./import-plan.js";
import { hidden, plural, filesOf, stagedImport } from "./staged-import.js";
import { reviewCommand } from "./review-cli.js";
import { evaluateLicence } from "./licence.js";
import { normalizeImport } from "./normalize.js";
import { licenceReviewProblem, reviewImport } from "./licence-review.js";
import { licenceReviewRequired, promoteImport } from "./promotion.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "./schema.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, readScanExceptions, SCAN_EXCEPTIONS_FILE, type ScanException } from "./scan-exceptions.js";
import { SOURCE_CONNECTORS } from "./connectors.js";
import { overlapLines, overlapReport } from "./overlap.js";
import { readSkillSelections, SELECTIONS_FILE, selectionConnectors } from "./selections.js";
import { readSources, shownValue, SOURCES_FILE } from "./sources.js";
import { flowSkillSteps } from "./tool-policy.js";
import { assessWorkflows, connectorProfile, type WorkflowFlow } from "./workflow.js";

export const SKILLS_USAGE = `usage: scf skills [--repo <dir>]                              List skills, their trust and pin state, and problems
       scf skills pin <id@version> <sha256:digest> [--replace]   Approve the listed package (copy the digest from the list)
       scf skills pin --builtin                                  Pin the built-in skills that have no pin
       scf skills unpin <id@version>                             Remove a pin
       scf skills sources check [<file>]                         Check a skill source list (default: ${SOURCES_FILE})
       scf skills connectors                                     List the reviewed source connectors; reads nothing
       scf skills selections check [<file>]                      Check the skill selections (default: ${SELECTIONS_FILE})
       scf skills overrides check [<file>]                       Check the owner overrides (default: ${OVERRIDES_FILE})
       scf skills project-pins check [<file>]                    Check the project pins (default: ${PINS_FILE})
       scf skills import <source-id> [<file>]                    Fetch the approved commit of a source into quarantine
       scf skills scan <source-id> [<exceptions-file>]           Print the security report of a staged import, plus the connector report of a known source
       scf skills assess <source-id>                             Print the workflow report of a staged import; reads only
       scf skills evaluate <source-id> [<technology>@<version> ...]   Report compatibility, tools, access, licence and overlap of a source; writes nothing
       scf skills promote check <source-id> [<exceptions-file>]  Print per staged skill whether licence and findings allow promotion; reads only
       scf skills overlap <source-id>                            Compare a staged import with the registered skills: canonical skill or conflict per shared capability; reads only
       scf skills review <source-id> [--markdown]                Print the licence, attribution and collision report of a staged import; reads only
       scf skills discover [<export-file> [<file>]]              Propose sources from a saved Skills.sh export (never approves)`;

const ALLOWED: Record<string, string[]> = { list: ["repo"], pin: ["repo", "replace", "builtin"], unpin: ["repo"], sources: [], selections: [], connectors: [], overrides: [], "project-pins": [], scan: [], assess: [], promote: [], overlap: [], review: ["markdown"] };

export interface SkillsCommandOptions extends DiscoverOptions {
  skills?: Config["skills"];
  /** Where a relative source file is looked for (default: the current folder). */
  cwd?: string;
  /** The time entries are checked against (default: now). For tests. */
  now?: Date;
  /** The date used by `scan` for exceptions, as YYYY-MM-DD (tests). Default: today in UTC. */
  today?: string;
}

/** `scf skills overrides check` and `scf skills project-pins check`: offline; prints checked fields and the entry digest only. */
function choicesCheck(file: string, kind: "overrides" | "project-pins", out: (line: string) => void, now: Date): number {
  const r = kind === "overrides" ? readChoiceFile(file, "overrides") : readChoiceFile(file, "project-pins");
  if (r.state === "none") {
    out(`PROBLEM the ${kind === "overrides" ? "owner overrides" : "project pins"} file does not exist`);
    return 1;
  }
  if (r.state === "invalid") {
    for (const p of r.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  let expired = 0;
  for (const e of r.items as (SkillChoice | SkillOverride)[]) {
    const scope = "scope" in e ? (e.scope === "all" ? "all" : e.scope.repositories.join(",")) : "repository";
    const end = e.expires !== undefined ? `expires ${e.expires}` : `review ${e.review_by}`;
    const isExpired = e.expires !== undefined && Date.parse(e.expires) <= now.getTime();
    const due = e.review_by !== undefined && Date.parse(e.review_by) <= now.getTime();
    if (isExpired) expired++;
    out(`${e.capability} ${e.target} ${e.by} ${scope} ${e.from} → ${end} ${choiceDigest(e)}${isExpired ? " EXPIRED" : due ? " REVIEW DUE" : ""}`);
  }
  out(`OK ${r.items.length} entries`);
  return expired ? 1 : 0;
}

/** `scf skills sources check`: offline, prints checked fields only. */
function sourcesCheck(file: string, out: (line: string) => void, today?: string): number {
  const r = readSources(file, undefined, today);
  if (r.state === "none") {
    out("PROBLEM the skill source file does not exist");
    return 1;
  }
  if (r.state === "invalid") {
    for (const p of r.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  let enabled = 0;
  for (const s of r.manifest.sources) {
    if (s.status === "enabled") enabled++;
    const head = `${s.id.padEnd(24)} ${s.status} ${s.trust} ${s.adapter} ${s.repositoryKey}@${(s.ref.approved ?? "-").slice(0, 12)} ${s.owner}`;
    const reviewed = s.review ? ` reviewed by ${s.review.by} on ${s.review.on}` : "";
    const profile = s.profile ? ` provider ${s.profile.provider} (${s.profile.portable.length} portable)` : "";
    out(`${head}${reviewed}${profile}${s.reason ? ` (${s.reason})` : ""}`);
  }
  out(`OK ${r.manifest.sources.length} sources, ${enabled} enabled`);
  return 0;
}

/** `scf skills selections check`: offline, prints checked fields only. */
function selectionsCheck(file: string, out: (line: string) => void, today: string): number {
  const r = readSkillSelections(file, today);
  if (r.state === "none") {
    out("PROBLEM the skill selection file does not exist");
    return 1;
  }
  if (r.state === "invalid") {
    for (const p of r.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  for (const s of r.manifest.selections) {
    const product = s.product ? `${s.product.name}@${s.product.version}` : "-";
    const sdk = s.sdk ? `${s.sdk.name}@${s.sdk.version}(${s.sdk.language})` : "-";
    const connectors = selectionConnectors(s).join(",") || "-";
    out(`${(s.source + "/" + s.skill).padEnd(40)} ${s.scope} ${s.provider ?? "-"} ${product} ${sdk} ${connectors} ${s.owner} ${s.reviewed} ${s.digest.slice(0, 19)}`);
  }
  out(`OK ${r.manifest.selections.length} selections`);
  return 0;
}

/** The exception file for `scan` and `promote check`; prints a PROBLEM and returns undefined when it cannot be used. */
function loadExceptions(file: string | undefined, out: (line: string) => void, opts: { cwd: string; today: string }): ScanException[] | undefined {
  const read = readScanExceptions(resolve(opts.cwd, file ?? SCAN_EXCEPTIONS_FILE), opts.today);
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return undefined;
  }
  if (read.state === "none" && file !== undefined) {
    out("PROBLEM the exception file does not exist");
    return undefined;
  }
  return read.state === "ok" ? read.manifest.exceptions : [];
}

/**
 * `scf skills scan`: offline and read-only. Reads the staged import of a source, proves it matches import.json, then
 * scans every skill and prints the report. Returns 1 when a skill is blocked or a PROBLEM was printed.
 */
function scanImport(id: string, exceptionsFile: string | undefined, out: (line: string) => void, opts: { cwd: string; home?: string; today: string }): number {
  let exceptions: ScanException[] = [];
  const staged = stagedImport(id, out, opts, () => {
    const read = loadExceptions(exceptionsFile, out, opts);
    if (read) exceptions = read;
    return read !== undefined;
  });
  if (!staged) return 1;
  const { source, commit, record, files } = staged;

  // The recorded `rejected` text is left out, so the report holds only what normalization decided itself.
  const { skills: normalized, report: norm } = normalizeImport({ record: { ...record, rejected: [] }, files });
  let blocked = 0;
  for (const entry of record.skills) {
    const mine = filesOf(entry.root, files);
    const scan = scanSkill({ root: entry.root, files: mine });
    const pkg = normalized.find((s) => s.provenance.root === entry.root);
    if (pkg) {
      const decided = applyExceptions(pkg.package.id, scan, exceptions, opts.today);
      for (const d of decided.findings) out(`FINDING ${d.finding.id} ${d.finding.severity} ${d.disposition} ${pkg.package.id} ${d.finding.path}: ${d.finding.evidence}`);
      const n = promotionBlockers(decided).length;
      const excluded = importExclusions(pkg);
      if (n > 0 || excluded.length > 0) blocked++;
      if (n > 0) out(`BLOCKED ${pkg.package.id}: ${n} high ${n === 1 ? "finding" : "findings"}`);
      if (excluded.length > 0) out(`EXCLUDED ${pkg.package.id}: ${exclusionReasons(excluded).join("; ")}`);
      if (n === 0 && excluded.length === 0) {
        out(`OK ${pkg.package.id}: ${plural(scan.findings.length, "finding")}, none blocks`);
      }
    } else {
      const label = shownValue(entry.root);
      for (const f of scan.findings) out(`FINDING ${f.id} ${f.severity} open ${label} ${f.path}: ${f.evidence}`);
      const reasons = norm.quarantined.filter((q) => q.root === label).flatMap((q) => q.reasons.map(hidden));
      blocked++;
      out(`BLOCKED ${label}: not normalized (${reasons.join("; ")})`);
    }
  }
  const connector = connectorFor(source);
  if (connector) {
    const c = applyConnector(connector, normalized);
    const list = (xs: readonly string[], none = "none") => (xs.length ? xs.join(",") : none);
    for (const m of c.mapped) {
      const r = m.record;
      out(
        `CONNECTOR ${connector.id} ${r.id}: specific=${list(r.specific)} general=${list(r.general)} orm=${r.orm ?? "any"} engines=${list(r.engines, "any")} runtime=${r.runtime ?? "any"} needs=${list(r.requirements)} risk=${m.skill.package.risk} evaluations=${list(r.evaluations)} reviewed=${r.reviewed ? "yes" : "no"}`,
      );
    }
    for (const u of c.unmapped) {
      out(`CONNECTOR ${connector.id} unmapped ${u.root}: not offered, ${u.reason === "companion-missing" ? "a skill it points to is missing" : `the profile does not name ${u.name}`}`);
    }
    for (const a of c.absent) out(`CONNECTOR ${connector.id} absent ${a}`);
  }
  for (const r of record.rejected) out(`REJECTED ${hidden(r.root)}: ${r.reasons.map(hidden).join("; ")}`);
  out(`SCANNED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest}: ${blocked} blocked`);
  return blocked > 0 ? 1 : 0;
}

const toolsText = (t: { shell: boolean; network: boolean; filesystem: "none" | "read" | "write" }) => {
  const list = [t.shell ? "shell" : "", t.network ? "network" : "", t.filesystem === "write" ? "write" : ""].filter(Boolean);
  return list.length ? list.join(",") : "none";
};

/** The built-in flows as the workflow gate sees them. A flow that cannot be read is reported and left out. */
function builtinWorkflowFlows(out: (line: string) => void): { flows: WorkflowFlow[]; problems: number } {
  const dir = flowDir("builtin", "");
  const flows: WorkflowFlow[] = [];
  let problems = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const name = file.slice(0, -".yaml".length);
    try {
      const flow = parseFlow(readFileSync(join(dir, file), "utf8"), file);
      flows.push({ name, skills: flow.skills?.mode ?? "planned", steps: flowSkillSteps(flow) });
    } catch {
      problems++;
      out(`PROBLEM flow ${shownValue(name)} cannot be read`);
    }
  }
  return { flows, problems };
}

/**
 * `scf skills assess`: offline and read-only. Reads the staged import of a source, assesses every skill against the connector
 * profile of its repository and prints the report. Exclusions are the expected result and exit 0; only a PROBLEM exits 1.
 */
function assessImport(id: string, out: (line: string) => void, opts: { cwd: string; home?: string }): number {
  const staged = stagedImport(id, out, opts);
  if (!staged) return 1;
  const { source, commit, record, files } = staged;
  const profile = connectorProfile(source.repositoryKey);
  if (!profile) {
    out(`PROBLEM no workflow profile for ${shownValue(source.repositoryKey)}`);
    return 1;
  }
  const { skills: normalized, report: norm } = normalizeImport({ record: { ...record, rejected: [] }, files });
  const { flows, problems } = builtinWorkflowFlows(out);
  const report = assessWorkflows({
    profile, skills: normalized, flows,
    skillMd: (s) => files.get(s.provenance.root === "." ? "SKILL.md" : `${s.provenance.root}/SKILL.md`),
  });

  let candidates = 0;
  let excluded = 0;
  for (const a of report.skills) {
    for (const f of a.findings) out(`CONFLICT ${f.code} ${f.effect} ${a.id} ${f.path}${f.line !== undefined ? `:${f.line}` : ""}: ${f.evidence}`);
    if (a.omitted > 0) out(`CONFLICT omitted report ${a.id}: and ${a.omitted} more`);
    if (a.status === "candidate" && a.declaration) {
      const d = a.declaration;
      candidates++;
      out(`CANDIDATE ${a.id} (${shownValue(a.name)}): tools ${toolsText(d.tools)}; roles ${d.roles.join(",")}; flows ${d.flows.join(",")}; context ${d.context.instructions}/${d.context.max}`);
    } else {
      excluded++;
      out(`EXCLUDED ${a.id} (${shownValue(a.name)}): ${a.blockers.join(", ")}`);
    }
  }
  for (const entry of record.skills) {
    if (normalized.some((s) => s.provenance.root === entry.root)) continue;
    const label = shownValue(entry.root);
    const reasons = norm.quarantined.filter((q) => q.root === label).flatMap((q) => q.reasons.map(hidden));
    excluded++;
    out(`EXCLUDED ${label}: not normalized (${reasons.join("; ")})`);
  }
  out(`ASSESSED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest} with profile ${profile.id}: ${plural(candidates, "candidate")}, ${excluded} excluded`);
  return problems > 0 ? 1 : 0;
}

/** Passed for an import without licence evidence: every skill is `missing`, so the value reaches no package and is never printed. */
const NO_EVIDENCE_TIME = "1970-01-01T00:00:00Z";

/**
 * `scf skills promote check`: offline and read-only. Prints per staged skill whether licence, provenance and findings
 * allow promotion. Every decision is keyed by the full upstream root; the shown path is used only for printing.
 * Returns 1 when a path is refused or a PROBLEM was printed.
 */
function promoteCheck(id: string, exceptionsFile: string | undefined, out: (line: string) => void, opts: { cwd: string; home?: string; today: string }): number {
  let exceptions: ScanException[] = [];
  const staged = stagedImport(
    id,
    out,
    opts,
    () => {
      const read = loadExceptions(exceptionsFile, out, opts);
      if (read) exceptions = read;
      return read !== undefined;
    },
    "checked",
  );
  if (!staged) return 1;
  const { source, commit, record, files } = staged;
  if (source.status !== "enabled") {
    out(`PROBLEM the source ${source.id} is ${source.status}; only an enabled source can be promoted`);
    return 1;
  }
  // An import staged without licence files has no evidence: every path is `missing`.
  const review = reviewImport({
    allow: source.licence.allow,
    prep: { record: { ...record, rejected: [] }, files },
    evidence: staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] },
  });
  const evidence = review.evidence;
  const retrievedAt = record.retrievedAt ?? NO_EVIDENCE_TIME;
  const normalized = review.normalized.skills;
  const byRoot = new Map(normalized.map((s) => [s.provenance.root, s]));

  let promotable = 0;
  let refused = 0;
  const lines: string[] = [];
  for (const entry of record.skills) {
    const path = shownValue(entry.root);
    const skill = byRoot.get(entry.root);
    let status: string;
    let licenceReasons: string[] = [];
    let normReasons: string[] = [];
    let n = 0;
    let ok: { id: string; licences: string[] } | undefined;
    if (skill) {
      let result;
      try {
        result = promoteImport({ source, record, skills: [skill], evidence, retrievedAt, review });
      } catch (e) {
        if (!(e instanceof SkillImportError)) throw e;
        // path-specific (for example the approved paths were narrowed): refuse this path, check the others
        lines.push(`REFUSED ${path}: not-promotable (${hidden(e.message)})`);
        refused++;
        continue;
      }
      const p = result.promoted[0];
      if (p) {
        status = "allowed";
        ok = { id: skill.package.id, licences: p.provenance.licences };
      } else {
        const r = result.manifest.refused[0]!;
        status = r.status;
        licenceReasons = r.reasons;
      }
      n = promotionBlockers(applyExceptions(skill.package.id, scanSkill({ root: entry.root, files: filesOf(entry.root, files) }), exceptions, opts.today)).length;
    } else {
      const verdict = evaluateLicence({ root: entry.root, allow: source.licence.allow, evidence });
      status = verdict.status;
      licenceReasons = verdict.reasons;
      // Normalized alone, so the reasons belong to this full root and not to a shortened display string.
      const alone = normalizeImport({ record: { ...record, skills: [entry], rejected: [] }, files });
      normReasons = alone.report.quarantined[0]?.reasons ?? ["another skill of this source has the same name or id"];
    }
    const text = (xs: string[]) => xs.map(hidden).join("; ");
    if (status !== "allowed") {
      const more: string[] = [];
      if (!skill) more.push(`not normalized: ${text(normReasons)}`);
      if (n > 0) more.push(`${plural(n, "high finding")}`);
      lines.push(`REFUSED ${path}: ${status} (${[text(licenceReasons), ...more].filter((x) => x !== "").join("; ")})`);
      refused++;
    } else if (!skill) {
      lines.push(`REFUSED ${path}: not-normalized (${text(normReasons)})`);
      refused++;
    } else if (n > 0) {
      lines.push(`REFUSED ${path}: blocked (${plural(n, "high finding")})`);
      refused++;
    } else {
      lines.push(`PROMOTABLE ${ok!.id} ${path} ${ok!.licences.join(",")}`);
      promotable++;
    }
  }
  for (const l of lines) out(l);
  for (const s of normalized) if (s.provenance.assumes) out(`ASSUMES ${hidden(s.package.id)}: ${s.provenance.assumes.join(", ")}`);
  const c = review.classification;
  const problem = licenceReviewProblem(source.licence.reviewed, c);
  const state = !licenceReviewRequired(source)
    ? "licence.reviewed is not set"
    : problem === undefined
      ? "matches licence.reviewed"
      : problem === "missing"
        ? "not reviewed; check the lines above, then set licence.reviewed to this digest"
        : "changed since the review; check the lines above, then set licence.reviewed to this digest";
  out(`LICENCES ${c.digest} ${plural(c.files.length, "licence and notice file")}: ${state}`);
  out(`CHECKED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest}: ${promotable} promotable, ${refused} refused`);
  return refused > 0 ? 1 : 0;
}

/**
 * `scf skills overlap`: offline and read-only. Compares the staged import of a source with the registered skills (built-in and
 * administrator) and prints per capability the canonical skill, a conflict, or `NEW`. Only slugs, versions and fixed codes are
 * printed. Returns 1 for a conflict or a PROBLEM.
 */
function overlapImport(id: string, out: (line: string) => void, opts: { cwd: string; home?: string; today: string; skills: Config["skills"]; discover: DiscoverOptions }): number {
  let exceptions: ScanException[] = [];
  const staged = stagedImport(
    id,
    out,
    { ...opts, fixed: true },
    () => {
      const read = loadExceptions(undefined, out, opts);
      if (read) exceptions = read;
      return read !== undefined;
    },
    "compared",
  );
  if (!staged) return 1;
  const { source, commit, record, files } = staged;
  const review = reviewImport({
    allow: source.licence.allow,
    prep: { record: { ...record, rejected: [] }, files },
    evidence: staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] },
  });
  // The same gate as promotion: an allowed licence still needs the matching licence.reviewed.
  const unreviewed = licenceReviewRequired(source) && licenceReviewProblem(source.licence.reviewed, review.classification) !== undefined;
  const verdicts = new Map(review.classification.paths.map((p) => [p.root, p.status] as const));
  const normalized = review.normalized.skills;
  const entries = normalized.map((skill) => {
    const root = skill.provenance.root;
    const status = verdicts.get(root) ?? "missing";
    const blockers = promotionBlockers(applyExceptions(skill.package.id, scanSkill({ root, files: filesOf(root, files) }), exceptions, opts.today));
    return { skill, licence: status === "allowed" && unreviewed ? ("review" as const) : status, safe: blockers.length === 0 };
  });

  const reg = discoverSkills(opts.skills, opts.discover);
  // A catalogue that could not be read in full would show skills as new that are not.
  const catalogue = [...new Set(reg.problems.filter((p) => p.source !== "repository").map((p) => `PROBLEM catalogue ${p.source} ${p.kind}`))].sort();

  let report;
  try {
    report = overlapReport({ source, skills: entries }, reg.skills, { highRisk: opts.skills.unresolved.high_risk, mandatory: opts.skills.selection.include, tools: opts.skills.tools });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    out("PROBLEM too many skills or capabilities to compare");
    return 1;
  }
  for (const line of catalogue) out(line);
  for (const line of overlapLines(report)) out(line);
  const notNormalized = record.skills.length - normalized.length;
  if (notNormalized > 0) out(`PROBLEM ${plural(notNormalized, "staged skill")} could not be normalized; see "scf skills scan ${source.id}"`);
  out(`OVERLAP ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest}: ${report.shared} shared, ${report.new} new, ${report.vendorOnly} vendor-only, ${report.conflicts} conflicts`);
  return report.ok && notNormalized === 0 && catalogue.length === 0 ? 0 : 1;
}

const syntax = (why: string) => new Error(`${why}\n${SKILLS_USAGE}`);

/** `scf skills …`. `values` holds the options that were given; the syntax is checked before any read or write. */
export async function skillsCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillsCommandOptions = {},
): Promise<number> {
  const first = args.positionals[0];
  const sub = first === undefined ? "list" : first;
  const operands = first === undefined ? [] : args.positionals.slice(1);
  if (!Object.hasOwn(ALLOWED, sub)) throw syntax(`scf skills: unknown sub-command ${sub}`);
  const allowed = ALLOWED[sub]!;
  for (const [k, v] of Object.entries(args.values)) {
    if (v !== undefined && !allowed.includes(k)) throw syntax(`scf skills${sub === "list" ? "" : " " + sub}: unexpected option --${k}`);
  }
  const builtin = args.values.builtin === true;
  const replace = args.values.replace === true;
  if (sub === "list" && args.positionals.length) throw syntax("scf skills: unexpected operand");
  if (sub === "pin") {
    if (builtin) {
      if (replace) throw syntax("scf skills pin: --builtin cannot be used with --replace");
      if (operands.length) throw syntax("scf skills pin --builtin: takes no operands");
    } else {
      if (operands.length !== 2) throw syntax("scf skills pin: expects a skill (id@version) and a digest");
      if (!parseSkillKey(operands[0]!)) throw syntax(`scf skills pin: ${operands[0]} is not a skill key (id@version)`);
      if (!SKILL_DIGEST_RE.test(operands[1]!)) throw syntax("scf skills pin: the digest must be sha256: and 64 hex digits");
    }
  }
  if (sub === "unpin") {
    if (operands.length !== 1) throw syntax("scf skills unpin: expects one skill (id@version)");
    if (!parseSkillKey(operands[0]!)) throw syntax(`scf skills unpin: ${operands[0]} is not a skill key (id@version)`);
  }
  if (sub === "sources") {
    if (operands[0] !== "check" || operands.length > 2) throw syntax('scf skills sources: expects "check" and at most one file');
    return sourcesCheck(resolve(opts.cwd ?? process.cwd(), operands[1] ?? SOURCES_FILE), out, opts.today);
  }

  if (sub === "connectors") {
    if (operands.length) throw syntax("scf skills connectors: takes no operands");
    for (const c of SOURCE_CONNECTORS) out(`${c.id.padEnd(24)} ${c.repositoryKey} ${c.roots.join(",")} ${c.adapter} ${c.trust} ${c.licences.join(",")} track ${c.track}`);
    out(`OK ${plural(SOURCE_CONNECTORS.length, "connector")}`);
    return 0;
  }

  if (sub === "selections") {
    if (operands[0] !== "check" || operands.length > 2) throw syntax('scf skills selections: expects "check" and at most one file');
    return selectionsCheck(resolve(opts.cwd ?? process.cwd(), operands[1] ?? SELECTIONS_FILE), out, opts.today ?? new Date().toISOString().slice(0, 10));
  }

  if (sub === "overrides" || sub === "project-pins") {
    if (operands[0] !== "check" || operands.length > 2) throw syntax(`scf skills ${sub}: expects "check" and at most one file`);
    const dflt = sub === "overrides" ? OVERRIDES_FILE : PINS_FILE;
    return choicesCheck(resolve(opts.cwd ?? process.cwd(), operands[1] ?? dflt), sub, out, opts.now ?? new Date());
  }

  if (sub === "scan") {
    if (operands.length < 1 || operands.length > 2) throw syntax("scf skills scan: expects a source id and at most one exception file");
    if (!SKILL_ID_RE.test(operands[0]!)) throw syntax("scf skills scan: the first operand must be a source id");
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    return scanImport(operands[0]!, operands[1], out, { cwd: opts.cwd ?? process.cwd(), home: opts.home, today });
  }

  if (sub === "assess") {
    if (operands.length !== 1) throw syntax("scf skills assess: expects one source id");
    if (!SKILL_ID_RE.test(operands[0]!)) throw syntax("scf skills assess: the operand must be a source id");
    return assessImport(operands[0]!, out, { cwd: opts.cwd ?? process.cwd(), home: opts.home });
  }

  if (sub === "promote") {
    if (operands[0] !== "check" || operands.length < 2 || operands.length > 3) throw syntax('scf skills promote: expects "check", a source id and at most one exception file');
    if (!SKILL_ID_RE.test(operands[1]!)) throw syntax("scf skills promote check: the first operand must be a source id");
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    return promoteCheck(operands[1]!, operands[2], out, { cwd: opts.cwd ?? process.cwd(), home: opts.home, today });
  }

  if (sub === "review") {
    if (operands.length !== 1) throw syntax("scf skills review: expects one source id");
    if (!SKILL_ID_RE.test(operands[0]!)) throw syntax("scf skills review: the operand must be a source id");
    const { skills, cwd, now: _n, today: _t, ...rest } = opts;
    return reviewCommand(operands[0]!, out, { cwd: cwd ?? process.cwd(), home: opts.home, markdown: args.values.markdown === true, skills, discover: rest });
  }

  const { skills, cwd: _cwd, now: _now, today: _today, ...discover } = opts;
  if (sub === "overlap") {
    if (operands.length !== 1) throw syntax("scf skills overlap: expects one source id");
    if (!SKILL_ID_RE.test(operands[0]!)) throw syntax("scf skills overlap: the operand must be a source id");
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    return overlapImport(operands[0]!, out, { cwd: opts.cwd ?? process.cwd(), home: opts.home, today, skills: skills ?? loadConfig().skills, discover });
  }
  if (sub === "unpin") {
    const key = operands[0]!;
    if (removeSkillPin(key)) {
      out(`Unpinned ${key}`);
      return 0;
    }
    out(`${key} is not pinned`);
    return 1;
  }

  const reg = discoverSkills(skills ?? loadConfig().skills, discover);
  if (sub === "pin") {
    if (builtin) {
      const r = pinBuiltinSkills(reg);
      if (r.pinned.length) out(`Pinned ${r.pinned.join(", ")}`);
      for (const key of r.mismatched) {
        out(`PROBLEM ${key} does not match its pin and was not changed. Run "scf skills" to see both digests, check the package, then run "scf skills pin ${key} <digest> --replace".`);
      }
      if (!r.pinned.length && !r.mismatched.length) out("Nothing to pin");
      return r.mismatched.length ? 1 : 0;
    }
    const key = operands[0]!;
    const r = pinSkill(reg, key, operands[1]!, { replace });
    out(r === "pinned" ? `Pinned ${key}` : r === "unchanged" ? `Already pinned ${key}` : `Replaced the pin of ${key}`);
    return 0;
  }

  for (const s of reg.skills) {
    out(`${s.id.padEnd(24)} ${s.version}  [${s.label}] ${s.trust} ${s.pin} ${s.digest}${s.pkg.provider ? ` provider ${s.pkg.provider.name}` : ""}${s.active ? "" : ` (shadowed by ${s.shadowedBy})`}`);
  }
  for (const r of reg.sources) {
    const rel = r.release;
    if (rel && rel.state !== "none" && rel.state !== "invalid") out(`RELEASE ${r.label} ${rel.catalogue}@${rel.version} ${rel.digest} ${rel.state}`);
  }
  for (const r of unreleasedSources(reg)) {
    out(`NOTE ${r.label} is loaded without an approved release (${releaseProblemText(r.release)}): skills.releases.allow_unreleased is on (development only).`);
  }
  for (const n of reg.notes) out(`NOTE ${n.text}`);
  const lockPath = skillLockPath(discover.home ?? dataHome());
  for (const p of reg.problems) {
    const root = p.kind === "lock" ? lockPath : (reg.sources.find((r) => r.label === p.label)?.root ?? p.root);
    out(`PROBLEM ${p.label} ${root}${p.package && p.kind !== "integrity" ? "/" + p.package : ""}: ${p.reason}`);
  }
  return reg.problems.length ? 1 : 0;
}
