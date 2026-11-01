import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "../auth/store.js";
import { sha256Hex } from "../evidence/identity.js";
import { compareInputs, EvalInputsSchema, expectedResultKeys, type EvalInputs, type SuiteInputs, suiteInputs } from "../eval-inputs.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import { evalsDir, loadSuite, loadSuiteFlow, SAFETY_DIR, type EvalReport, type Suite } from "../evals.js";
import { isCounted, lookupVersions, type ComponentKind, type ComponentRef } from "./components.js";
import { readHomeComponents, type FoundComponent } from "./home.js";
import { REPORT_ID_RE, writeRecord, type PromotionEntry, type ReportRef } from "./records.js";
import { REQUIRED_SUITES, SUITE_REMEDIATION } from "./required-suites.js";
import { readVersionBook } from "./versions.js";

/**
 * `scf promote <kind> <id>`: is the component promotable? Read-only. For each required suite the newest report decides;
 * it must be valid, complete, passed and still current for the suite, its fixtures, its flows and this component.
 * Lines never hold a machine path or file content.
 */

export const MAX_REPORT_BYTES = 16 << 20;

export { REPORT_ID_RE };

export type PromoteCode = "report-unknown" | "not-found" | "problem" | "unrecorded" | "versions-invalid" | "suite-missing" | "report-invalid" | "suite-failed" | "report-stale";

/** The timestamp `runEval` puts in a report's file name: `startedAt` with `:` and `.` written as `-`. */
const STAMP_TEXT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
const STAMP = new RegExp(`^${STAMP_TEXT}$`);
/** A file that ends in a timestamp belongs to the suite named before it, so `timeout-extra-<stamp>.json` is not a `timeout` report. */
const ENDS_IN_STAMP = new RegExp(`-${STAMP_TEXT}\\.json$`);

export interface NewestReport {
  file: string;
  /** SHA-256 of the file's text, set when the file was read. */
  sha256?: string;
  report?: EvalReport;
  inputs?: EvalInputs;
  /** Why the file cannot be used (fixed text). */
  problem?: string;
}

/**
 * The newest report of a suite, chosen by the timestamp in the file name. A file with the suite's prefix but no timestamp
 * counts as the newest, so it blocks instead of being skipped. Only the winner is read.
 */
export function newestReport(suite: string, dir = evalsDir()): NewestReport | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const prefix = `${suite}-`;
  const own = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .filter((n) => STAMP.test(n.slice(prefix.length, -".json".length)) || !ENDS_IN_STAMP.test(n))
    .map((n) => ({ n, stamp: n.slice(prefix.length, -".json".length) }));
  if (!own.length) return undefined;
  const bad = own.filter((c) => !STAMP.test(c.stamp)).sort((a, b) => (a.n < b.n ? -1 : 1));
  if (bad.length) return { file: bad[bad.length - 1]!.n, problem: "the file name has no timestamp" };
  const valid = own.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
  const file = valid[valid.length - 1]!.n;
  const read = readPolicyFile(join(dir, file), MAX_REPORT_BYTES);
  if ("problem" in read) return { file, problem: read.problem === "too-large" ? "the file is too large" : "the file could not be read" };
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { file, problem: "the file is not valid JSON" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { file, problem: "the file is not a report" };
  const report = json as EvalReport;
  const sha256 = sha256Hex(read.text);
  if (report.inputs === undefined) return { file, sha256, report };
  const inputs = EvalInputsSchema.safeParse(report.inputs);
  if (!inputs.success) return { file, report, problem: "inputs are not valid" };
  return { file, sha256, report, inputs: inputs.data };
}

/** What the suite, its fixtures and its flows are now: all cases, all flows, the suite's models. */
export function currentSuiteInputs(suitePath: string, suite: Suite = loadSuite(suitePath)): SuiteInputs {
  const dir = dirname(suitePath);
  const flows = suite.flows.map((entry) => ({ entry, flow: loadSuiteFlow(entry, dir) }));
  return suiteInputs(suite, dir, flows, suite.cases.map((c) => c.name), suite.models);
}

/** A complete result set: exactly one result for every expected combination, none twice, none extra, `passed` a boolean. */
function resultsProblem(report: EvalReport, suite: Suite, inputs: SuiteInputs): string | undefined {
  if (!Array.isArray(report.results)) return "results";
  const expected = new Set(expectedResultKeys(suite, inputs));
  const seen = new Set<string>();
  for (const r of report.results as unknown[]) {
    if (typeof r !== "object" || r === null) return "results";
    const x = r as Record<string, unknown>;
    if (typeof x.variant !== "string" || typeof x.case !== "string" || typeof x.attempt !== "number" || typeof x.passed !== "boolean") return "results";
    const key = `${x.variant}|${x.case}|${x.attempt}`;
    if (!expected.has(key) || seen.has(key)) return "results";
    seen.add(key);
  }
  return seen.size === expected.size ? undefined : "results";
}

export interface SuiteBlock {
  code: PromoteCode;
  detail?: string;
}

/** What the newest report says about a suite, apart from any one component: a block, or the passed report's file and inputs. */
export type SuiteVerdict = { block: SuiteBlock; file?: undefined; inputs?: undefined; sha256?: undefined } | { block?: undefined; file: string; inputs: EvalInputs; sha256: string };

/**
 * Is the newest report of a suite valid, complete, passed and current for the suite, its fixtures and its flows? With no
 * report the suite file is not loaded.
 */
export function suiteVerdict(name: string, o: { live: boolean; evalsDir?: string; safetyDir?: string }): SuiteVerdict {
  const blocked = (code: PromoteCode, detail?: string): SuiteVerdict => ({ block: { code, ...(detail ? { detail } : {}) } });
  const suitePath = join(o.safetyDir ?? SAFETY_DIR, name, "suite.yaml");
  if (!existsSync(suitePath)) return blocked("suite-missing", "suite file");
  const newest = newestReport(name, o.evalsDir);
  if (!newest || (!newest.problem && !newest.inputs)) return blocked("suite-missing");
  if (newest.problem || !newest.inputs || !newest.report) return blocked("report-invalid", newest.problem);
  const { report, inputs } = newest;
  let suite: Suite;
  let current: SuiteInputs;
  try {
    suite = loadSuite(suitePath);
    current = currentSuiteInputs(suitePath, suite);
  } catch {
    return blocked("report-invalid", "suite");
  }
  if (report.suite !== name) return blocked("report-invalid", "suite name");
  if (inputs.live && !o.live) return blocked("report-invalid", "live");
  const diff = compareInputs(inputs, current);
  if (diff) return blocked(diff.code, diff.detail);
  const bad = resultsProblem(report, suite, inputs);
  if (bad) return blocked("report-invalid", bad);
  if (!report.results.every((r) => r.passed === true)) return blocked("suite-failed");
  return { file: newest.file, inputs, sha256: newest.sha256 ?? "" };
}

/** The block of a component for a suite verdict: the verdict's own, or `report-stale` when the report lacks this kind, id and hash. */
export function componentBlock(c: { kind: ComponentKind; id: string; sha256: string }, v: SuiteVerdict): SuiteBlock | undefined {
  if (v.block) return v.block;
  const recorded = v.inputs.components.find((x) => x.kind === c.kind && x.id === c.id);
  return !recorded || recorded.sha256 !== c.sha256 ? { code: "report-stale", detail: `${c.kind} ${c.id}` } : undefined;
}

export interface BlockingItem {
  code: PromoteCode;
  suite?: string;
  remediation: string;
}

export interface PromotionDecision {
  ok: boolean;
  /** Set when the component was found. */
  ref?: ComponentRef;
  blocking: BlockingItem[];
  /** The passing report of every required suite, when none blocks. */
  reports: ReportRef[];
  /** The PASSED, BLOCKED and PROMOTABLE lines `scf promote` prints. */
  lines: string[];
}

export interface DecisionOptions {
  live: boolean;
  home?: string;
  evalsDir?: string;
  safetyDir?: string;
  builtinFlowsDir?: string;
  /** A component the caller already read; then the home folder is not searched for it. */
  component?: FoundComponent;
  /** The verdicts of this request, one per suite; filled in as they are read. */
  verdicts?: Map<string, SuiteVerdict>;
  /** An extra hint added to a `report-stale` or `suite-missing` block; other blocks keep their own remediation. */
  scopeHint?: string;
}

/** The blocks that a flow outside the home folder explains: its report is stale, or there is none. */
const HINTED: readonly PromoteCode[] = ["report-stale", "suite-missing"];

/**
 * The live rule for one component: is it found, recorded (counted kinds) and covered by a current, passed report of every
 * required suite? Read-only. The lines are the ones `scf promote` prints.
 */
export function promotionDecision(kind: ComponentKind, id: string, o: DecisionOptions): PromotionDecision {
  const home = o.home ?? dataHome();
  const lines: string[] = [];
  const blocking: BlockingItem[] = [];
  const reports: ReportRef[] = [];
  const blocked = (what: string, fix: string, item: BlockingItem) => {
    lines.push(`BLOCKED ${kind} ${id}: ${what} — ${fix}`);
    blocking.push(item);
  };
  const fixComponent = `scf components ${kind}`;

  let component = o.component;
  if (!component) {
    const { found, problems } = readHomeComponents(home, { kinds: [kind], ...(o.builtinFlowsDir ? { builtinFlowsDir: o.builtinFlowsDir } : {}) });
    // A problem with this id comes first: the home definition has priority at run time, also when a valid built-in has the same id.
    if (problems.some((p) => p.kind === kind && p.id === id)) {
      blocked("(problem)", fixComponent, { code: "problem", remediation: fixComponent });
      return { ok: false, blocking, reports, lines };
    }
    component = found.find((f) => f.kind === kind && f.id === id);
  }
  if (!component) {
    blocked("(not-found)", fixComponent, { code: "not-found", remediation: fixComponent });
    return { ok: false, blocking, reports, lines };
  }

  let version = component.version;
  if (isCounted(component.kind)) {
    const book = readVersionBook(home);
    if (!book.ok) {
      blocked("(versions-invalid)", "fix or restore promotions/versions.json", { code: "versions-invalid", remediation: "fix or restore promotions/versions.json" });
    } else {
      const v = lookupVersions(book.book, [{ kind: component.kind, id, sha256: component.sha256 }])[0];
      if (v === undefined) blocked("(unrecorded)", `scf components record ${kind}`, { code: "unrecorded", remediation: `scf components record ${kind}` });
      else version = String(v);
    }
  }

  const safetyDir = o.safetyDir ?? SAFETY_DIR;
  const verdicts = o.verdicts ?? new Map<string, SuiteVerdict>();
  for (const name of REQUIRED_SUITES[kind]) {
    let verdict = verdicts.get(name);
    if (!verdict) {
      verdict = suiteVerdict(name, { live: o.live, evalsDir: o.evalsDir, safetyDir });
      verdicts.set(name, verdict);
    }
    const stop = componentBlock({ kind, id, sha256: component.sha256 }, verdict);
    if (stop) {
      const hint = o.scopeHint && HINTED.includes(stop.code) ? `. ${o.scopeHint}` : "";
      blocked(`${name} (${stop.code}${stop.detail ? `: ${stop.detail}` : ""})`, SUITE_REMEDIATION, { code: stop.code, suite: name, remediation: SUITE_REMEDIATION + hint });
    } else {
      lines.push(`PASSED ${name} ${verdict.file}`);
      reports.push({ suite: name, id: verdict.file!.replace(/\.json$/, ""), sha256: verdict.sha256! });
    }
  }

  const ok = blocking.length === 0;
  const ref: ComponentRef = { kind, id, version: version ?? "-", sha256: component.sha256 };
  if (ok) lines.push(`PROMOTABLE ${kind} ${id} v${version ?? "-"} sha256:${component.sha256}`);
  return { ok, ref, blocking, reports: ok ? reports : [], lines };
}

export function promoteCheck(kind: ComponentKind, id: string, o: DecisionOptions): { lines: string[]; ok: boolean } {
  const d = promotionDecision(kind, id, o);
  return { lines: d.lines, ok: d.ok };
}

export type PromoteResult = { ok: true; decision: PromotionDecision; entry: PromotionEntry } | { ok: false; decision: PromotionDecision; reason?: string };

/**
 * Promotes a component: writes its record when no suite blocks and `reportId` is the current passing report of one required
 * suite. The CLI and the web interface both come here. Nothing is written when refused.
 */
export function promoteWithReport(kind: ComponentKind, id: string, reportId: string, o: DecisionOptions & { by: string; waitMs?: number }): PromoteResult {
  const decision = promotionDecision(kind, id, o);
  if (!decision.ok || !decision.ref) return { ok: false, decision };
  if (!decision.reports.some((r) => r.id === reportId)) {
    const fix = `scf promote ${kind} ${id}`;
    decision.ok = false;
    decision.blocking.push({ code: "report-unknown", remediation: fix });
    decision.lines.push(`BLOCKED ${kind} ${id}: (report-unknown) — ${fix}`);
    return { ok: false, decision };
  }
  const entry: PromotionEntry = { ...decision.ref, reportId, reports: decision.reports, promotedAt: new Date().toISOString(), by: o.by };
  const w = writeRecord(entry, o.waitMs === undefined ? {} : { waitMs: o.waitMs });
  return w.ok ? { ok: true, decision, entry } : { ok: false, decision, reason: w.reason };
}
