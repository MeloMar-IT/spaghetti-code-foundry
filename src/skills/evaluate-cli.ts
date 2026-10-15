import { basename, resolve } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { OVERRIDES_FILE } from "./choice-rules.js";
import { planSkillChoices, type SkillOverride } from "./choices.js";
import { importExclusions } from "./import-exclusions.js";
import { evaluateLicence, type LicenceStatus } from "./licence.js";
import { normalizeImport } from "./normalize.js";
import { readChoiceFile } from "./project-pins.js";
import { discoverSkills, type DiscoverOptions } from "./registry.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, type ScanException } from "./scan-exceptions.js";
import { readSkillSelections, SELECTIONS_FILE, type SkillSelection } from "./selections.js";
import { evaluateSourceSkills, type SourceSkillVerdict } from "./source-evaluation.js";
import { shownValue } from "./sources.js";
import { filesOf, hidden, loadExceptions, plural, stagedImport } from "./staged-cli.js";

// `scf skills selections evaluate`: offline and read-only. Reports, per skill of a staged import, whether it is eligible or held
// back, and how the skills overlap. "Eligible" is a reported verdict; nothing is approved, promoted or written.

export interface SelectionsEvaluateOptions {
  cwd: string;
  today: string;
  now: Date;
  skills?: Config["skills"];
  discover: DiscoverOptions;
}

/** Added in memory to a skill with an import exclusion, so the tools gate holds it back. Never printed or written. */
const EXCLUDED_CONNECTOR = "service-import-excluded";

/** Registry problems that leave the list of registered skills incomplete. */
const INCOMPLETE = new Set(["root-missing", "root-unreadable", "root-refused", "invalid-package", "too-many"]);

export function selectionsEvaluate(id: string, selectionsFile: string | undefined, out: (line: string) => void, opts: SelectionsEvaluateOptions): number {
  const { cwd, today, now, discover } = opts;
  let exceptions: ScanException[] = [];
  let selections: SkillSelection[] = [];
  let overrides: SkillOverride[] = [];
  const stop = (text: string): false => {
    out(`PROBLEM ${text}`);
    return false;
  };
  const staged = stagedImport(
    id,
    out,
    { cwd, home: discover.home, today },
    () => {
      const read = loadExceptions(undefined, out, { cwd, today });
      if (!read) return false;
      exceptions = read;
      const file = resolve(cwd, selectionsFile ?? SELECTIONS_FILE);
      const sel = readSkillSelections(file, today);
      if (sel.state === "none") return stop("the skill selection file does not exist");
      if (sel.state === "invalid") {
        for (const p of sel.problems) out(`PROBLEM ${shownValue(basename(file))} ${p.where}: ${p.message}`);
        return false;
      }
      selections = sel.manifest.selections;
      const ov = readChoiceFile(resolve(cwd, OVERRIDES_FILE), "overrides");
      if (ov.state === "invalid") {
        for (const p of ov.problems) out(`PROBLEM ${OVERRIDES_FILE} ${p.where}: ${p.message}`);
        return false;
      }
      if (ov.state === "ok") overrides = ov.items;
      return true;
    },
    "evaluated",
  );
  if (!staged) return 1;
  const { source, commit, record, files } = staged;
  if (!staged.licence) {
    out(`PROBLEM the staged import of ${source.id} has no licence evidence; run "scf skills import ${source.id}" again`);
    return 1;
  }
  const evidence = staged.licence;

  const skills = opts.skills ?? loadConfig().skills;
  const reg = discoverSkills(skills, discover);
  const incomplete = reg.problems.filter((p) => INCOMPLETE.has(p.kind));
  if (incomplete.length) {
    for (const p of incomplete) out(`PROBLEM the skill registry is incomplete: ${shownValue(p.label)} (${p.kind})`);
    return 1;
  }

  const { skills: normalized } = normalizeImport({ record: { ...record, rejected: [] }, files });
  const licences: Record<string, LicenceStatus> = {};
  const blocked: string[] = [];
  for (const s of normalized) {
    licences[s.provenance.root] = evaluateLicence({ root: s.provenance.root, declared: s.package.license, allow: source.licence.allow, evidence }).status;
    const decided = applyExceptions(s.package.id, scanSkill({ root: s.provenance.root, files: filesOf(s.provenance.root, files) }), exceptions, today);
    if (promotionBlockers(decided).length > 0) blocked.push(s.package.id);
  }

  // Only owner overrides for every repository apply: project pins come from git, and this command starts no process.
  const plan = planSkillChoices({ overrides, now, exclusive: [...new Set(overrides.map((o) => o.capability))] });
  for (const p of plan.problems) {
    if (p.code === "expired") out(`NOTE owner override for ${shownValue(p.capability ?? "")} names ${shownValue(p.target ?? "")} and has expired; it is not used`);
  }

  // An import exclusion (MCP or plugin configuration, network use, integration keys) means the skill needs tools that are not
  // available. It is given an unavailable connector before the evaluation, so the tools gate holds it back before the overlap
  // selection and it cannot make an overlapping provider skill lose with `provider-without-policy`.
  const excluded = new Set(normalized.filter((s) => importExclusions(s).length > 0).map((s) => s.provenance.root));
  const candidates = normalized.map((s) =>
    excluded.has(s.provenance.root) ? { ...s, package: { ...s.package, connectors: [...new Set([...(s.package.connectors ?? []), EXCLUDED_CONNECTOR])].sort() } } : s,
  );

  let evaluation;
  try {
    evaluation = evaluateSourceSkills({
      source, skills: candidates, selections, licences, blocked, registered: reg.skills, tools: skills.tools,
      policy: { exclusive: [], highRisk: skills.unresolved.high_risk, overrides: plan.overrides },
    });
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) {
      out(`PROBLEM the evaluation cannot run: ${e instanceof RangeError ? "too many skill candidates" : "the selections do not fit the import"}`);
      return 1;
    }
    throw e;
  }

  // A skill that was not selected never reached the tools gate; it still reports the exclusion.
  const verdicts = evaluation.skills.map((v): SourceSkillVerdict => {
    if (!excluded.has(v.root) || v.reasons.includes("needs-unavailable-tools")) return v;
    return { ...v, eligible: false, reasons: [...v.reasons, "needs-unavailable-tools"].sort() as SourceSkillVerdict["reasons"] };
  });

  const lines: { key: string; text: string }[] = [];
  let eligible = 0;
  for (const v of verdicts) {
    const sel = selections.find((s) => s.source === source.id && s.skill === v.name);
    if (v.eligible && sel) {
      eligible++;
      const product = sel.product ? `${sel.product.name}@${sel.product.version}` : "-";
      const sdk = sel.sdk ? `${sel.sdk.name}@${sel.sdk.version}` : "-";
      lines.push({ key: v.id, text: `ELIGIBLE ${shownValue(v.id)} ${v.scope ?? sel.scope} ${shownValue(product)} sdk ${shownValue(sdk)}` });
    } else {
      lines.push({ key: v.id, text: `HELD ${shownValue(v.id)}: ${[...v.reasons].sort().join(", ")}` });
    }
  }
  const named = new Set(verdicts.map((v) => v.root));
  for (const entry of record.skills) {
    if (!named.has(entry.root)) lines.push({ key: entry.root, text: `HELD ${shownValue(entry.root)}: not-normalized` });
  }
  for (const l of lines) out(l.text);
  for (const c of evaluation.collisions) {
    out(`OVERLAP ${shownValue(c.id)} ${c.class} ${c.reason} ${c.skills.map(hidden).join(",")}${c.shared.length ? ` ${c.shared.map(hidden).join(",")}` : ""}`);
  }
  out(`EVALUATED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)}: ${eligible} eligible`);
  return 0;
}
