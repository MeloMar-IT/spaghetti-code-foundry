import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { listRunIds, loadRun, pidAlive, type RunSummary } from "../engine/state.js";
import { sendDesktop } from "../notify.js";
import { blockageReport, blockers, dependencyWaits, fileWaits } from "./blockage.js";
import { capsPath, loadCaps, runLimit, setCap } from "./caps.js";
import { digestFacts, digestLine, digestReport } from "./digest.js";
import { collectHits, flakyReport, groupOf, stories, suspects, type Story } from "./flaky.js";
import { clearGovernor, loadState, runGovernor, sample } from "./governor.js";
import { EMPTY_LIMITS, FAMILIES, forecast, limitsReport, type Family, type LimitsState } from "./limits.js";
import { dataDir, installJob, jobDir, jobInstalled, uninstallJob, type Job } from "./schedule.js";

export const JOBS: Record<string, Job> = {
  governor: { name: "governor", everySec: 60 },
  flaky: { name: "flaky", everySec: 6 * 3600 },
  limits: { name: "limits", everySec: 3600 },
  blockage: { name: "blockage", everySec: 3600 },
  digest: { name: "digest", daily: { hour: 7, minute: 30 } },
};

export const OPS_USAGE = `usage: scf governor|flaky|limits|blockage|digest run        Do one check now
       scf governor|flaky|limits|blockage|digest report     Print the last result
       scf governor|flaky|limits|blockage|digest install    Run it by itself (macOS login agent); uninstall removes it
       scf governor|flaky|limits|blockage|digest status
       scf governor reset                    Take away the limits the governor set
       scf flaky auto on|off                 Make bug stories for unreliable tests by itself, or only report
       scf limits set claude|codex <percent used> <next reset, e.g. 2026-10-19T23:00>
       scf limits auto on|off                Lower the runs at once when a limit would be reached before its reset`;

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const save = (dir: string, name: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

function loadRuns(): RunSummary[] {
  const runsDir = join(dataDir(), "runs");
  return listRunIds(runsDir).flatMap((id) => {
    try {
      const r = loadRun(runsDir, id);
      return r ? [r] : [];
    } catch {
      return [];
    }
  });
}

const configured = () => loadConfig().concurrency;
type Out = (line: string) => void;

function governor(out: Out) {
  const dir = jobDir("governor");
  const d = runGovernor({ dir, slotsDir: join(dataDir(), "test-slots"), capsFile: capsPath(dataDir()), configured: configured(), now: new Date(), sample: sample() });
  if (d.change) out(`${new Date().toISOString()} ${d.change}`);
}

interface FlakyState { auto: boolean; label: string; filed: Record<string, string> }

/** Files a bug story with the GitHub sign-in of this machine; returns its address. */
export type FileStory = (repo: string, story: Story, label: string) => string;
const ghFile: FileStory = (repo, story, label) =>
  execFileSync("gh", ["issue", "create", "--repo", repo, "--title", story.title, "--body", story.body, "--label", "bug", "--label", label], { encoding: "utf8" }).trim();

export function runFlaky(o: { runsDir: string; dir: string; now: Date; file?: FileStory }): { text: string; filed: string[] } {
  const days = 7;
  const { hits, logs } = collectHits(o.runsDir, o.now, days);
  const list = suspects(hits);
  const state = { auto: false, label: "Factory_go", filed: {}, ...readJson<Partial<FlakyState>>(join(o.dir, "state.json"), {}) } as FlakyState;
  const filed: string[] = [];
  if (state.auto && o.file) {
    for (const s of stories(list, state.filed)) {
      // the repository of the stories the tests failed in; a run without an issue names none
      const repo = hits.find((h) => groupOf({ test: h.test } as never) === s.key && h.issue.includes("#") && !h.issue.startsWith("#"))?.issue.split("#")[0];
      if (!repo) continue;
      try {
        state.filed[s.key] = o.file(repo, s, state.label);
        filed.push(`${s.title}: ${state.filed[s.key]}`);
      } catch (e) {
        filed.push(`${s.title}: could not be filed (${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 120) : "error"})`);
      }
    }
    save(o.dir, "state.json", JSON.stringify(state, null, 2));
  }
  const text = flakyReport(list, logs, days, state.filed);
  save(o.dir, "report.md", text);
  save(o.dir, "latest.json", JSON.stringify({ at: o.now.toISOString(), suspects: list }, null, 2));
  return { text, filed };
}

export function runLimits(o: { runs: RunSummary[]; dir: string; capsFile: string; configured: number; now: Date }): string {
  const state = { ...EMPTY_LIMITS, ...readJson<Partial<LimitsState>>(join(o.dir, "state.json"), {}) };
  const fs = FAMILIES.map((f) => forecast(o.runs, f, state.calibrations?.[f], o.now, o.configured));
  const lowest = Math.min(...fs.map((f) => f.runs ?? Infinity));
  // the cap holds for two hours: two missed checks and the Foundry is free again
  setCap("limits", state.auto && Number.isFinite(lowest) ? { runs: lowest, until: new Date(o.now.getTime() + 2 * 3_600_000).toISOString(), why: "a weekly usage limit would be reached before its reset" } : undefined, o.capsFile);
  const text = limitsReport(fs, state.auto);
  save(o.dir, "report.md", text);
  save(o.dir, "latest.json", JSON.stringify({ at: o.now.toISOString(), forecasts: fs }, null, 2));
  return text;
}

export function runBlockage(o: { runs: RunSummary[]; dir: string; serviceLog: string; limit: number; now: Date; alive?: (pid: unknown) => boolean }): string {
  const waits = [...fileWaits(o.runs), ...dependencyWaits(o.serviceLog, o.now)];
  const list = blockers(waits, o.runs, o.now);
  const working = o.runs.filter((r) => r.status === "running" && (o.alive ?? pidAlive)(r.pid)).length;
  const text = blockageReport(list, waits, working, o.limit, o.now);
  save(o.dir, "report.md", text);
  save(o.dir, "latest.json", JSON.stringify({ at: o.now.toISOString(), working, limit: o.limit, blockers: list }, null, 2));
  return text;
}

/** The last 256 kB of the service log: enough for the waits of the last minutes. */
function logTail(): string {
  const path = join(dataDir(), "service.log");
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.slice(-256_000);
}

export function runDigest(o: { runs: RunSummary[]; home: string; now: Date }): { text: string; line: string } {
  const facts = digestFacts(o.runs, o.now);
  const since = new Date(o.now.getTime() - 86_400_000).toISOString();
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  const tuning = readJson<{ trials?: { flow: string; step: string; status: string; startedAt: string; endedAt?: string; why?: string; to: { model?: string; effort?: string } }[] }>(join(o.home, "analyst", "tuning.json"), {});
  const trials = (tuning.trials ?? []).filter((t) => (t.endedAt ?? t.startedAt) >= since).map((t) => `${t.flow} / ${t.step} on ${[t.to.model, t.to.effort && `effort ${t.to.effort}`].filter(Boolean).join(", ")}: ${t.status === "running" ? "on trial" : `${t.status === "kept" ? "kept" : "put back"} — ${t.why ?? ""}`}`);
  const flaky = readJson<{ suspects?: { test: string; failedIn: string[] }[] }>(join(o.home, "flaky", "latest.json"), {}).suspects ?? [];
  const block = readJson<{ blockers?: { story: string; holdsUp: string[]; state: string }[] }>(join(o.home, "blockage", "latest.json"), {}).blockers ?? [];
  const limits = readJson<{ forecasts?: { family: string; percentNow?: number; emptyAt?: string }[] }>(join(o.home, "limits", "latest.json"), {}).forecasts ?? [];
  const load = lines(join(o.home, "governor", "changes.log")).filter((l) => l.slice(0, 24) >= since);
  const extra = [
    { title: "Holds work up", lines: block.slice(0, 3).map((b) => `${b.story} holds up ${b.holdsUp.length} (${b.state})`) },
    { title: "Usage limits", lines: limits.filter((f) => f.percentNow !== undefined).map((f) => `${f.family}: about ${f.percentNow}% of the week used${f.emptyAt ? `; at this pace reached ${f.emptyAt.slice(0, 16).replace("T", " ")} UTC, before the reset` : ""}`) },
    { title: "Models", lines: trials },
    { title: "Machine load", lines: load.length ? [`the governor changed the limits ${load.length} time${load.length === 1 ? "" : "s"}; last: ${load.at(-1)!.slice(25)}`] : [] },
    { title: "Unreliable tests", lines: flaky.slice(0, 3).map((s) => `${s.test} — failed in ${s.failedIn.length} stories`) },
  ];
  const text = digestReport({ ...facts, extra }, o.now);
  const dir = join(o.home, "digest");
  save(dir, `${o.now.toISOString().slice(0, 10)}.md`, text);
  save(dir, "report.md", text);
  return { text, line: digestLine(facts) };
}

function limitsSet(rest: string[], out: Out) {
  const [family, percent, reset] = rest;
  const p = Number(percent);
  const at = Date.parse(reset ?? "");
  if (!FAMILIES.includes(family as Family) || !(p > 0 && p <= 100) || Number.isNaN(at) || at <= Date.now()) throw new Error(OPS_USAGE);
  const file = join(jobDir("limits"), "state.json");
  const state = { ...EMPTY_LIMITS, ...readJson<Partial<LimitsState>>(file, {}) };
  state.calibrations = { ...state.calibrations, [family as Family]: { percent: p, at: new Date().toISOString(), resetAt: new Date(at).toISOString() } };
  save(jobDir("limits"), "state.json", JSON.stringify(state, null, 2));
  out(`${family}: ${p}% used now; the week resets ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`);
}

/** `scf governor|flaky|limits|blockage|digest …`. Each reads the data folder and writes only in its own folder (and, for the two that limit runs, governor/caps.json). */
export async function opsCommand(name: string, positionals: string[], cliPath: string, out: Out): Promise<number> {
  const job = JOBS[name];
  if (!job) throw new Error(OPS_USAGE);
  const [sub = "status", ...rest] = positionals;
  const dir = jobDir(name);
  const auto = (file: string, on: string, off: string) => {
    if (rest.length !== 1 || (rest[0] !== "on" && rest[0] !== "off")) throw new Error(OPS_USAGE);
    save(dir, file, JSON.stringify({ ...readJson<object>(join(dir, file), {}), auto: rest[0] === "on" }, null, 2));
    out(rest[0] === "on" ? on : off);
    return 0;
  };
  if (name === "flaky" && sub === "auto") return auto("state.json", "bug stories for unreliable tests are on (at most 2 per check)", "bug stories are off: the detector only reports");
  if (name === "limits" && sub === "auto") return auto("state.json", "slowing down is on", "slowing down is off: forecast only");
  if (name === "limits" && sub === "set") return limitsSet(rest, out), 0;
  if (rest.length) throw new Error(OPS_USAGE);
  switch (sub) {
    case "run": {
      const now = new Date();
      if (name === "governor") governor(out);
      else if (name === "flaky") {
        const r = runFlaky({ runsDir: join(dataDir(), "runs"), dir, now, file: ghFile });
        out(`${now.toISOString()} report written: ${join(dir, "report.md")}`);
        for (const f of r.filed) out(`  filed: ${f}`);
      } else if (name === "limits") runLimits({ runs: loadRuns(), dir, capsFile: capsPath(dataDir()), configured: configured(), now }), out(`${now.toISOString()} report written: ${join(dir, "report.md")}`);
      else if (name === "blockage") runBlockage({ runs: loadRuns(), dir, serviceLog: logTail(), limit: runLimit(configured(), now, capsPath(dataDir())), now }), out(`${now.toISOString()} report written: ${join(dir, "report.md")}`);
      else {
        const r = runDigest({ runs: loadRuns(), home: dataDir(), now });
        await sendDesktop({ title: "Foundry digest", message: r.line });
        out(`${now.toISOString()} ${r.line} — ${join(dir, "report.md")}`);
      }
      return 0;
    }
    case "report": {
      if (name === "governor") {
        const s = loadState(dir);
        out(s.runs || s.tests ? `limits now: ${s.runs ? `${s.runs} runs at once (configured: ${configured()})` : "runs as configured"}${s.tests ? ", 1 test run at once" : ""}` : "no limits set: the machine is calm enough");
        const log = join(dir, "changes.log");
        if (existsSync(log)) out(readFileSync(log, "utf8").trim().split("\n").slice(-20).join("\n"));
        return 0;
      }
      const file = join(dir, "report.md");
      if (!existsSync(file)) throw new Error(`no report yet; run \`scf ${name} run\``);
      out(readFileSync(file, "utf8"));
      return 0;
    }
    case "install":
      out(installJob(job, cliPath));
      return 0;
    case "uninstall":
      if (name === "governor") clearGovernor(dir, join(dataDir(), "test-slots"), capsPath(dataDir()));
      if (name === "limits") setCap("limits", undefined, capsPath(dataDir()));
      out(uninstallJob(name));
      return 0;
    case "reset":
      if (name !== "governor") throw new Error(OPS_USAGE);
      clearGovernor(dir, join(dataDir(), "test-slots"), capsPath(dataDir()));
      out("the governor's limits are taken away");
      return 0;
    case "status": {
      out(jobInstalled(name) ? `${name} is installed` : `${name} is not installed (scf ${name} install)`);
      if (name === "governor" || name === "limits") {
        const caps = Object.entries(loadCaps(capsPath(dataDir()))).filter(([, c]) => Date.parse(c.until) > Date.now());
        out(caps.length ? caps.map(([who, c]) => `cap by ${who}: ${c.runs} runs at once (${c.why})`).join("\n") : "no cap on runs at once");
      }
      return 0;
    }
    default:
      throw new Error(OPS_USAGE);
  }
}
