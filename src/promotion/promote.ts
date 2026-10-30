import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "../auth/store.js";
import { compareInputs, EvalInputsSchema, expectedResultKeys, type EvalInputs, type SuiteInputs, suiteInputs } from "../eval-inputs.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import { evalsDir, loadSuite, loadSuiteFlow, SAFETY_DIR, type EvalReport, type Suite } from "../evals.js";
import { isCounted, lookupVersions, type ComponentKind } from "./components.js";
import { readHomeComponents } from "./home.js";
import { REQUIRED_SUITES, SUITE_REMEDIATION } from "./required-suites.js";
import { readVersionBook } from "./versions.js";

/**
 * `scf promote <kind> <id>`: is the component promotable? Read-only. For each required suite the newest report decides;
 * it must be valid, complete, passed and still current for the suite, its fixtures, its flows and this component.
 * Lines never hold a machine path or file content.
 */

export const MAX_REPORT_BYTES = 16 << 20;

export type PromoteCode = "not-found" | "problem" | "unrecorded" | "versions-invalid" | "suite-missing" | "report-invalid" | "suite-failed" | "report-stale";

/** The timestamp `runEval` puts in a report's file name: `startedAt` with `:` and `.` written as `-`. */
const STAMP_TEXT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
const STAMP = new RegExp(`^${STAMP_TEXT}$`);
/** A file that ends in a timestamp belongs to the suite named before it, so `timeout-extra-<stamp>.json` is not a `timeout` report. */
const ENDS_IN_STAMP = new RegExp(`-${STAMP_TEXT}\\.json$`);

export interface NewestReport {
  file: string;
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
  if (report.inputs === undefined) return { file, report };
  const inputs = EvalInputsSchema.safeParse(report.inputs);
  if (!inputs.success) return { file, report, problem: "inputs are not valid" };
  return { file, report, inputs: inputs.data };
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

export function promoteCheck(
  kind: ComponentKind,
  id: string,
  o: { live: boolean; home?: string; evalsDir?: string; safetyDir?: string; builtinFlowsDir?: string },
): { lines: string[]; ok: boolean } {
  const home = o.home ?? dataHome();
  const lines: string[] = [];
  const blocked = (what: string, fix: string) => void lines.push(`BLOCKED ${kind} ${id}: ${what} — ${fix}`);
  const fixComponent = `scf components ${kind}`;

  const { found, problems } = readHomeComponents(home, { kinds: [kind], ...(o.builtinFlowsDir ? { builtinFlowsDir: o.builtinFlowsDir } : {}) });
  // A problem with this id comes first: the home definition has priority at run time, also when a valid built-in has the same id.
  if (problems.some((p) => p.kind === kind && p.id === id)) {
    blocked("(problem)", fixComponent);
    return { lines, ok: false };
  }
  const component = found.find((f) => f.kind === kind && f.id === id);
  if (!component) {
    blocked("(not-found)", fixComponent);
    return { lines, ok: false };
  }

  let ok = true;
  let version = component.version;
  if (isCounted(component.kind)) {
    const book = readVersionBook(home);
    if (!book.ok) {
      blocked("(versions-invalid)", "fix or restore promotions/versions.json");
      ok = false;
    } else {
      const v = lookupVersions(book.book, [{ kind: component.kind, id, sha256: component.sha256 }])[0];
      if (v === undefined) {
        blocked("(unrecorded)", `scf components record ${kind}`);
        ok = false;
      } else version = String(v);
    }
  }

  const safetyDir = o.safetyDir ?? SAFETY_DIR;
  for (const name of REQUIRED_SUITES[kind]) {
    const block = (code: PromoteCode, detail?: string) => {
      blocked(`${name} (${code}${detail ? `: ${detail}` : ""})`, SUITE_REMEDIATION);
      ok = false;
    };
    const suitePath = join(safetyDir, name, "suite.yaml");
    if (!existsSync(suitePath)) {
      block("suite-missing", "suite file");
      continue;
    }
    let suite: Suite;
    let current: SuiteInputs;
    try {
      suite = loadSuite(suitePath);
      current = currentSuiteInputs(suitePath, suite);
    } catch {
      block("report-invalid", "suite");
      continue;
    }
    const newest = newestReport(name, o.evalsDir);
    if (!newest || (!newest.problem && !newest.inputs)) {
      block("suite-missing");
      continue;
    }
    if (newest.problem || !newest.inputs || !newest.report) {
      block("report-invalid", newest.problem);
      continue;
    }
    const { report, inputs } = newest;
    if (report.suite !== name) {
      block("report-invalid", "suite name");
      continue;
    }
    if (inputs.live && !o.live) {
      block("report-invalid", "live");
      continue;
    }
    const diff = compareInputs(inputs, current);
    if (diff) {
      block(diff.code, diff.detail);
      continue;
    }
    const bad = resultsProblem(report, suite, inputs);
    if (bad) {
      block("report-invalid", bad);
      continue;
    }
    if (!report.results.every((r) => r.passed === true)) {
      block("suite-failed");
      continue;
    }
    const recorded = inputs.components.find((c) => c.kind === kind && c.id === id);
    if (!recorded || recorded.sha256 !== component.sha256) {
      block("report-stale", `${kind} ${id}`);
      continue;
    }
    lines.push(`PASSED ${name} ${newest.file}`);
  }

  if (ok) lines.push(`PROMOTABLE ${kind} ${id} v${version ?? "-"} sha256:${component.sha256}`);
  return { lines, ok };
}
