import { resolve } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { dataHome } from "../auth/store.js";
import { OVERRIDES_FILE, PINS_FILE } from "./choice-rules.js";
import { choiceDigest, type SkillChoice, type SkillOverride } from "./choices.js";
import { readChoiceFile } from "./project-pins.js";
import { parseSkillKey, removeSkillPin, skillLockPath } from "./lock.js";
import { discoverSkills, pinBuiltinSkills, pinSkill, unreleasedSources, type DiscoverOptions } from "./registry.js";
import { releaseProblemText } from "./release.js";
import { credentialProblem } from "./credential-scan.js";
import { stagedLicenceEvidence } from "./import-evidence.js";
import { SkillImportError } from "./import-plan.js";
import { readStagedImport } from "./import-stage.js";
import { evaluateLicence } from "./licence.js";
import { normalizeImport } from "./normalize.js";
import { promoteImport } from "./promotion.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "./schema.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, readScanExceptions, SCAN_EXCEPTIONS_FILE, type ScanException } from "./scan-exceptions.js";
import { readSources, shownValue, SOURCES_FILE, type SkillLibrarySource } from "./sources.js";

export const SKILLS_USAGE = `usage: scf skills [--repo <dir>]                              List skills, their trust and pin state, and problems
       scf skills pin <id@version> <sha256:digest> [--replace]   Approve the listed package (copy the digest from the list)
       scf skills pin --builtin                                  Pin the built-in skills that have no pin
       scf skills unpin <id@version>                             Remove a pin
       scf skills sources check [<file>]                         Check a skill source list (default: ${SOURCES_FILE})
       scf skills overrides check [<file>]                       Check the owner overrides (default: ${OVERRIDES_FILE})
       scf skills project-pins check [<file>]                    Check the project pins (default: ${PINS_FILE})
       scf skills import <source-id> [<file>]                    Fetch the approved commit of a source into quarantine
       scf skills scan <source-id> [<exceptions-file>]           Print the security report of a staged import; reads only
       scf skills promote check <source-id> [<exceptions-file>]  Print per staged skill whether licence and findings allow promotion; reads only
       scf skills discover [<export-file> [<file>]]              Propose sources from a saved Skills.sh export (never approves)`;

const ALLOWED: Record<string, string[]> = { list: ["repo"], pin: ["repo", "replace", "builtin"], unpin: ["repo"], sources: [], overrides: [], "project-pins": [], scan: [], promote: [] };

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
function sourcesCheck(file: string, out: (line: string) => void): number {
  const r = readSources(file);
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
    out(s.reason ? `${head} (${s.reason})` : head);
  }
  out(`OK ${r.manifest.sources.length} sources, ${enabled} enabled`);
  return 0;
}

/** Free text from a record is printed only when it holds no credential. */
const hidden = (s: string): string => (credentialProblem(s) ? "(hidden)" : s);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type StagedOk = Extract<ReturnType<typeof readStagedImport>, { state: "ok" }>;
type Loaded = { source: SkillLibrarySource; commit: string; exceptions: ScanException[]; staged: StagedOk };

/** The head of `scan` and `promote check`: source, exceptions and the staged import. A number is the exit code after a PROBLEM. */
function loadStaged(id: string, exceptionsFile: string | undefined, out: (line: string) => void, opts: { cwd: string; home?: string; today: string }, done: "scanned" | "checked"): number | Loaded {
  const problem = (text: string) => {
    out(`PROBLEM ${text}`);
    return 1;
  };
  const sources = readSources(resolve(opts.cwd, SOURCES_FILE));
  if (sources.state === "none") return problem("the skill source file does not exist");
  if (sources.state === "invalid") {
    for (const p of sources.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const source = sources.manifest.sources.find((s) => s.id === id);
  if (!source) return problem(`unknown source ${shownValue(id)}`);
  const commit = source.ref.approved;
  if (!commit) return problem(`source ${source.id} has no approved commit (ref.approved)`);

  const read = readScanExceptions(resolve(opts.cwd, exceptionsFile ?? SCAN_EXCEPTIONS_FILE), opts.today);
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  if (read.state === "none" && exceptionsFile !== undefined) return problem("the exception file does not exist");
  const exceptions = read.state === "ok" ? read.manifest.exceptions : [];

  const staged = readStagedImport(source.id, commit, { home: opts.home });
  if (staged.state === "none") return problem(`no staged import of ${source.id} at ${commit.slice(0, 12)}; run "scf skills import ${source.id}" first`);
  if (staged.state === "invalid") return problem(`the staged import does not match import.json: ${staged.problem}; nothing was ${done}`);
  if (staged.record.repositoryKey !== source.repositoryKey) return problem(`the staged import is from another repository; nothing was ${done}`);
  return { source, commit, exceptions, staged };
}

/** The files of one skill, with paths relative to its root. */
function filesOf(root: string, files: ReadonlyMap<string, Uint8Array>): { path: string; content: Uint8Array }[] {
  const mine: { path: string; content: Uint8Array }[] = [];
  for (const [path, content] of files) {
    if (root === "." || path === root || path.startsWith(root + "/")) mine.push({ path: root === "." ? path : path.slice(root.length + 1), content });
  }
  return mine;
}

/**
 * `scf skills scan`: offline and read-only. Reads the staged import of a source, proves it matches import.json, then
 * scans every skill and prints the report. Returns 1 when a skill is blocked or a PROBLEM was printed.
 */
function scanImport(id: string, exceptionsFile: string | undefined, out: (line: string) => void, opts: { cwd: string; home?: string; today: string }): number {
  const loaded = loadStaged(id, exceptionsFile, out, opts, "scanned");
  if (typeof loaded === "number") return loaded;
  const { source, commit, exceptions, staged } = loaded;
  const { record, files } = staged;

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
      if (n > 0) {
        blocked++;
        out(`BLOCKED ${pkg.package.id}: ${n} high ${n === 1 ? "finding" : "findings"}`);
      } else {
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
  for (const r of record.rejected) out(`REJECTED ${hidden(r.root)}: ${r.reasons.map(hidden).join("; ")}`);
  out(`SCANNED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest}: ${blocked} blocked`);
  return blocked > 0 ? 1 : 0;
}

/** Passed for an import without licence evidence: every skill is `missing`, so the value reaches no package and is never printed. */
const NO_EVIDENCE_TIME = "1970-01-01T00:00:00Z";

/**
 * `scf skills promote check`: offline and read-only. Prints per staged skill whether licence, provenance and findings
 * allow promotion. Every decision is keyed by the full upstream root; the shown path is used only for printing.
 * Returns 1 when a path is refused or a PROBLEM was printed.
 */
function promoteCheck(id: string, exceptionsFile: string | undefined, out: (line: string) => void, opts: { cwd: string; home?: string; today: string }): number {
  const loaded = loadStaged(id, exceptionsFile, out, opts, "checked");
  if (typeof loaded === "number") return loaded;
  const { source, commit, exceptions, staged } = loaded;
  const { record, files } = staged;
  if (source.status !== "enabled") {
    out(`PROBLEM the source ${source.id} is ${source.status}; only an enabled source can be promoted`);
    return 1;
  }
  const evidence = stagedLicenceEvidence(record, staged.licences);
  const retrievedAt = record.retrievedAt ?? NO_EVIDENCE_TIME;
  const { skills: normalized } = normalizeImport({ record: { ...record, rejected: [] }, files });
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
        result = promoteImport({ source, record, skills: [skill], evidence, retrievedAt });
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
  out(`CHECKED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest}: ${promotable} promotable, ${refused} refused`);
  return refused > 0 ? 1 : 0;
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
    return sourcesCheck(resolve(opts.cwd ?? process.cwd(), operands[1] ?? SOURCES_FILE), out);
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

  if (sub === "promote") {
    if (operands[0] !== "check" || operands.length < 2 || operands.length > 3) throw syntax('scf skills promote: expects "check", a source id and at most one exception file');
    if (!SKILL_ID_RE.test(operands[1]!)) throw syntax("scf skills promote check: the first operand must be a source id");
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    return promoteCheck(operands[1]!, operands[2], out, { cwd: opts.cwd ?? process.cwd(), home: opts.home, today });
  }

  const { skills, cwd: _cwd, now: _now, today: _today, ...discover } = opts;
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
    out(`${s.id.padEnd(24)} ${s.version}  [${s.label}] ${s.trust} ${s.pin} ${s.digest}${s.active ? "" : ` (shadowed by ${s.shadowedBy})`}`);
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
