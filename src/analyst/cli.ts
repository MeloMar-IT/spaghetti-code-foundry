import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listRunIds, loadRun, type RunSummary } from "../engine/state.js";
import { FACTORY_HOME } from "../flow/load.js";
import { macHost, type ServiceHost } from "../service.js";
import { advise, type Advice } from "./advise.js";
import { collect } from "./collect.js";
import { askClaude, isStale, loadReference, modelOf, refresh, saveReference, type Ask } from "./reference.js";
import { loadOverrides, overridesPath, saveOverrides } from "./overrides.js";
import { report } from "./report.js";
import { loadTuning, reconcile, resetTuning, saveTuning, tune, tuningSection } from "./tune.js";

export const ANALYST_LABEL = "com.spaghetti-code-foundry.analyst";
export const EVERY_HOURS = 6;

export const ANALYST_USAGE = `usage: scf analyst run [--no-web]   Write a new report now (--no-web: do not look up published figures)
       scf analyst report            Print the last report
       scf analyst install           Run it every ${EVERY_HOURS} hours as its own macOS login agent
       scf analyst uninstall         Remove that agent
       scf analyst status            Say whether the agent is installed and when the last report was written
       scf analyst auto on|off       Let the analyst change models and efforts by itself, or only advise
       scf analyst reset             Put back everything the analyst changed`;

const dataDir = () => process.env.FACTORY_HOME ?? FACTORY_HOME;
export const analystDir = () => join(dataDir(), "analyst");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function analystPlist(o: { cliPath: string; logFile: string; home?: string }): string {
  const home = o.home ? `\n    <key>SCF_HOME</key><string>${esc(o.home)}</string>\n    <key>FACTORY_HOME</key><string>${esc(o.home)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ANALYST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[process.execPath, o.cliPath, "analyst", "run"].map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
    <key>HOME</key><string>${esc(homedir())}</string>${home}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${EVERY_HOURS * 3600}</integer>
  <key>StandardOutPath</key><string>${esc(o.logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logFile)}</string>
</dict>
</plist>
`;
}

const plistPath = (host: ServiceHost) => join(host.agentsDir, `${ANALYST_LABEL}.plist`);

function requireMac(host: ServiceHost) {
  if (host.platform !== "darwin") throw new Error("scf analyst install supports macOS (launchd) only; elsewhere run `scf analyst run` from cron every 6 hours");
}

function bootout(host: ServiceHost) {
  try {
    host.launchctl(["bootout", `${host.domain}/${ANALYST_LABEL}`]);
  } catch {
    // not loaded
  }
}

export function installAnalyst(cliPath: string, host: ServiceHost = macHost()): string {
  requireMac(host);
  mkdirSync(host.agentsDir, { recursive: true });
  mkdirSync(analystDir(), { recursive: true });
  const path = plistPath(host);
  bootout(host);
  host.writeFile(path, analystPlist({ cliPath, logFile: join(analystDir(), "analyst.log"), home: process.env.SCF_HOME ?? process.env.FACTORY_HOME }));
  host.launchctl(["bootstrap", host.domain, path]);
  return `installed ${path}\n  runs every ${EVERY_HOURS} hours, the first time now\n  report: ${join(analystDir(), "report.md")}`;
}

export function uninstallAnalyst(host: ServiceHost = macHost()): string {
  requireMac(host);
  bootout(host);
  const path = plistPath(host);
  if (!existsSync(path)) return "the analyst was not installed";
  host.removeFile(path);
  return "analyst removed";
}

export interface RunResult { advice: Advice[]; text: string; note: string; events: string[] }

/** One check: read the runs, refresh the published figures when they are a week old, write the report. */
export async function runAnalyst(o: { runs: RunSummary[]; now: Date; dir: string; ask?: Ask }): Promise<RunResult> {
  const collected = collect(o.runs, o.now);
  const refPath = join(o.dir, "reference.json");
  let ref = loadReference(refPath);
  let note = "";
  if (o.ask && isStale(ref, o.now)) {
    const models = [...new Set(collected.steps.map((s) => modelOf(s.agent)))];
    if (models.length) {
      const r = await refresh(ref, models, o.ask, o.now);
      note = r.note;
      if (r.ref !== ref) saveReference(refPath, (ref = r.ref));
    }
  }
  const advice = advise(collected, ref);
  // self-tuning: judge the running trials and, when it is switched on, start new ones
  const tuningFile = join(o.dir, "tuning.json");
  const overridesFile = join(o.dir, "overrides.json");
  const stored = loadOverrides(overridesFile);
  const tuning = loadTuning(tuningFile);
  // the tuning record owns the overrides: one that no trial owns is dropped, one a running trial misses is set again
  const tuned = tune({ tuning, overrides: reconcile(stored, tuning), advice, runs: o.runs, now: o.now, ref });
  // the record first: an override that no trial owns would never be judged or put back. Should the
  // check stop between the two, the next one sets the missing override again from the record.
  if (tuned.events.length) saveTuning(tuningFile, tuned.tuning);
  if (JSON.stringify(tuned.overrides) !== JSON.stringify(stored)) saveOverrides(tuned.overrides, overridesFile);
  const text = report(collected, advice, ref, note, tuningSection(tuned.tuning, tuned.overrides, tuned.events, tuned.notes));
  mkdirSync(o.dir, { recursive: true });
  writeFileSync(join(o.dir, "report.md"), text);
  writeFileSync(join(o.dir, "latest.json"), JSON.stringify({ at: o.now.toISOString(), from: collected.from, runs: collected.runs, advice }, null, 2));
  return { advice, text, note, events: tuned.events };
}

function loadRuns(): RunSummary[] {
  const runsDir = join(dataDir(), "runs");
  return listRunIds(runsDir).flatMap((id) => {
    try {
      const r = loadRun(runsDir, id);
      return r ? [r] : [];
    } catch {
      return []; // a run file being written
    }
  });
}

/**
 * `scf analyst …`. Reads run files and writes only in <data folder>/analyst; it changes no flow file and
 * no setting. With self-tuning on, what it writes there (`overrides.json`) changes the model or effort
 * agent steps run on: the engine reads that file at the start of every agent step.
 */
export async function analystCommand(positionals: string[], o: { cliPath: string; noWeb?: boolean }, out: (line: string) => void): Promise<number> {
  const [sub = "status", ...rest] = positionals;
  const tuningFile = join(analystDir(), "tuning.json");
  if (sub === "auto" && rest.length === 1 && (rest[0] === "on" || rest[0] === "off")) {
    saveTuning(tuningFile, { ...loadTuning(tuningFile), auto: rest[0] === "on" });
    out(rest[0] === "on" ? "self-tuning is on: the analyst changes models and efforts by itself, one trial per flow at a time" : "self-tuning is off: the analyst only advises; what it set stays until `scf analyst reset`");
    return 0;
  }
  if (rest.length) throw new Error(ANALYST_USAGE);
  const reportFile = join(analystDir(), "report.md");
  switch (sub) {
    case "run": {
      const r = await runAnalyst({ runs: loadRuns(), now: new Date(), dir: analystDir(), ask: o.noWeb ? undefined : askClaude() });
      const count = (v: string) => r.advice.filter((a) => a.verdict === v).length;
      out(`${new Date().toISOString()} report written: ${reportFile}`);
      out(`  try lower: ${count("lower")} · try higher: ${count("raise")} · time limit: ${count("time")} · look at: ${count("watch")} · keep: ${count("keep")}${r.note ? `\n  ${r.note}` : ""}`);
      for (const e of r.events) out(`  ${e}`);
      return 0;
    }
    case "report":
      if (!existsSync(reportFile)) throw new Error("no report yet; run `scf analyst run`");
      out(readFileSync(reportFile, "utf8"));
      return 0;
    case "install":
      out(installAnalyst(o.cliPath));
      return 0;
    case "uninstall":
      out(uninstallAnalyst());
      return 0;
    case "reset":
      saveOverrides({}, overridesPath(dataDir()));
      saveTuning(tuningFile, resetTuning(loadTuning(tuningFile), new Date()));
      out("everything the analyst changed is put back");
      return 0;
    case "status": {
      const host = macHost();
      out(existsSync(plistPath(host)) ? `the analyst is installed: every ${EVERY_HOURS} hours` : "the analyst is not installed (scf analyst install)");
      const latest = join(analystDir(), "latest.json");
      const t = loadTuning(tuningFile);
      out(`self-tuning: ${t.auto ? "on" : "off"} · running trials: ${t.trials.filter((x) => x.status === "running").length} · steps set: ${Object.values(loadOverrides(overridesPath(dataDir()))).reduce((n, s) => n + Object.keys(s).length, 0)}`);
      out(existsSync(latest) ? `last report: ${(JSON.parse(readFileSync(latest, "utf8")) as { at: string }).at}` : "no report yet");
      return 0;
    }
    default:
      throw new Error(ANALYST_USAGE);
  }
}
