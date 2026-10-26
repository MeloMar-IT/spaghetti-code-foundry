import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { listRunIds, loadRun, pidAlive, type RunSummary } from "../engine/state.js";
import { sendDesktop } from "../notify.js";
import type { ServiceHost } from "../service.js";
import { blockageReport, blockers, dependencyWaits, fileWaits, watcherRepos } from "./blockage.js";
import { capsPath, loadCaps, runLimit, setCap } from "./caps.js";
import { digestFacts, digestLine, digestReport, localDay } from "./digest.js";
import { collectHits, flakyReport, stories, suspects, type Story } from "./flaky.js";
import { changesToday, clearGovernor, loadState, MANY_CHANGES, runGovernor, sample } from "./governor.js";
import { EMPTY_LIMITS, FAMILIES, MAX_RESET_AHEAD_MS, forecast, limitsReport, parseReset, type Family, type LimitsState } from "./limits.js";
import { dataDir, installJob, jobDir, jobState, uninstallJob, type Job } from "./schedule.js";

export const JOBS: Record<string, Job> = {
  governor: { name: "governor", everySec: 60 },
  flaky: { name: "flaky", everySec: 6 * 3600 },
  limits: { name: "limits", everySec: 3600 },
  blockage: { name: "blockage", everySec: 3600 },
  digest: { name: "digest", daily: { hour: 7, minute: 30 } },
  housekeeping: { name: "housekeeping", everySec: 3 * 3600 },
};

export const OPS_USAGE = `usage: scf governor|flaky|limits|blockage|digest|housekeeping run   Do one check now
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

interface FlakyState { auto: boolean; label: string; filed: Record<string, string>; tried?: Record<string, string> }

/** Files a bug story with the GitHub sign-in of this machine; returns its address. */
export type FileStory = (repo: string, story: Story, label: string) => string;
const ghFile: FileStory = (repo, story, label) =>
  execFileSync("gh", ["issue", "create", "--repo", repo, "--title", story.title, "--body", story.body, "--label", "bug", "--label", label], { encoding: "utf8", timeout: 60_000 }).trim();

/** Stories filed per check, and how often filing may be tried for that: a GitHub that does not answer must not hold the check for long. */
const MAX_FILED = 2;
const MAX_TRIES = 4;

export function runFlaky(o: { runsDir: string; dir: string; now: Date; file?: FileStory }): { text: string; filed: string[] } {
  const days = 7;
  const { hits, logs, passed } = collectHits(o.runsDir, o.now, days);
  const list = suspects(hits, passed);
  const state = { auto: false, label: "Factory_go", filed: {}, ...readJson<Partial<FlakyState>>(join(o.dir, "state.json"), {}) } as FlakyState;
  const filed: string[] = [];
  if (state.auto && o.file) {
    const tried = (state.tried ??= {});
    // `stories` gives only what can be filed, so nothing else uses up the places. What could not be filed before comes
    // last (the longest ago first): one story GitHub keeps refusing does not stand in front of the others for ever.
    const todo = stories(list, state.filed).map((s, i) => ({ s, i })).sort((a, b) => (tried[a.s.key] ?? "").localeCompare(tried[b.s.key] ?? "") || a.i - b.i);
    let done = 0;
    for (const { s } of todo.slice(0, MAX_TRIES)) {
      if (done >= MAX_FILED) break;
      try {
        state.filed[s.key] = o.file(s.repo, s, state.label);
        delete tried[s.key];
        done++;
        filed.push(`${s.title} (${s.repo}): ${state.filed[s.key]}`);
      } catch (e) {
        tried[s.key] = o.now.toISOString();
        filed.push(`${s.title} (${s.repo}): could not be filed (${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 120) : "error"})`);
      }
      // saved at once: a check that is stopped after this must not file the same story again
      save(o.dir, "state.json", JSON.stringify(state, null, 2));
    }
  }
  const text = flakyReport(list, logs, days, state.filed);
  save(o.dir, "report.md", text);
  save(o.dir, "latest.json", JSON.stringify({ at: o.now.toISOString(), suspects: list }, null, 2));
  return { text, filed };
}

export function runLimits(o: { runs: RunSummary[]; dir: string; capsFile: string; configured: number; now: Date }): string {
  const state = { ...EMPTY_LIMITS, ...readJson<Partial<LimitsState>>(join(o.dir, "state.json"), {}) };
  // the pace of the last day was made under the limit that holds now (a cap included), so the forecast scales from that
  const effective = runLimit(o.configured, o.now, o.capsFile);
  const fs = FAMILIES.map((f) => forecast(o.runs, f, state.calibrations?.[f], o.now, o.configured, effective));
  const lowest = Math.min(...fs.map((f) => f.runs ?? Infinity));
  let runs: number | undefined = Number.isFinite(lowest) ? lowest : undefined;
  // A cap of this helper that still holds goes up by one per check at most, also when no slowing seems needed any
  // more: the forecast under a cap is rough, and a cap that jumps back makes the pace swing.
  const held = loadCaps(o.capsFile).limits;
  if (held && Date.parse(held.until) > o.now.getTime()) {
    runs = Math.min(runs ?? Infinity, held.runs + 1);
    if (runs >= o.configured) runs = undefined;
  }
  // the cap holds for two hours: two missed checks and the Foundry is free again
  setCap("limits", state.auto && runs !== undefined ? { runs, until: new Date(o.now.getTime() + 2 * 3_600_000).toISOString(), why: "a weekly usage limit would be reached before its reset" } : undefined, o.capsFile);
  const text = limitsReport(fs, state.auto);
  save(o.dir, "report.md", text);
  save(o.dir, "latest.json", JSON.stringify({ at: o.now.toISOString(), forecasts: fs }, null, 2));
  return text;
}

/** `repos`: watcher id → repository, for watchers that started no run yet (the runs name the others). */
export function runBlockage(o: { runs: RunSummary[]; dir: string; serviceLog: string; limit: number; now: Date; alive?: (pid: unknown) => boolean; repos?: Record<string, string> }): string {
  const alive = o.alive ?? pidAlive;
  const waits = [...fileWaits(o.runs), ...dependencyWaits(o.serviceLog, o.now, { ...o.repos, ...watcherRepos(o.runs) })];
  const list = blockers(waits, o.runs, o.now, alive);
  const working = o.runs.filter((r) => r.status === "running" && alive(r.pid)).length;
  const text = blockageReport(list, waits, working, o.limit, o.now);
  save(o.dir, "report.md", text);
  save(o.dir, "latest.json", JSON.stringify({ at: o.now.toISOString(), working, limit: o.limit, blockers: list }, null, 2));
  return text;
}

/** Watcher id → repository, from config.yaml and from repo-watchers.json (where it keeps the name). Best effort. */
function knownWatcherRepos(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const w of loadConfig().watchers) if (w.github_repo) out[w.id] = w.github_repo;
  } catch {
    // no usable config: the runs name the repositories
  }
  for (const w of readJson<{ watchers?: { id?: unknown; repoName?: unknown }[] }>(join(dataDir(), "repo-watchers.json"), {}).watchers ?? [])
    if (typeof w?.id === "string" && typeof w.repoName === "string") out[w.id] = w.repoName;
  return out;
}

/** The end of the service log (512 kB: the waits of the last hours), without reading the whole file. */
export function logTail(path = join(dataDir(), "service.log"), bytes = 512_000): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, bytes));
    const got = readSync(fd, buf, 0, buf.length, size - buf.length);
    const text = buf.subarray(0, got).toString("utf8");
    // the first line is cut somewhere: leave it out
    return size > buf.length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** A result of another helper counts for a day and a bit; older than that it says nothing about now. */
const RESULT_MAX_AGE_MS = 26 * 3_600_000;

export function runDigest(o: { runs: RunSummary[]; home: string; now: Date; alive?: (pid: unknown) => boolean }): { text: string; line: string } {
  const facts = digestFacts(o.runs, o.now, 24, o.alive);
  const since = new Date(o.now.getTime() - 86_400_000).toISOString();
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  /** The last result of a helper, or nothing when it is old (the helper is not installed any more, or stopped). */
  const latest = <T extends object>(name: string): Partial<T> => {
    const r = readJson<Partial<T> & { at?: string }>(join(o.home, name, "latest.json"), {});
    const age = o.now.getTime() - Date.parse(r.at ?? "");
    return age <= RESULT_MAX_AGE_MS ? r : {};
  };
  // one record that cannot be read must not cost the whole digest: that section is left out
  const part = (title: string, make: () => string[]) => {
    try {
      return { title, lines: make().filter((l) => typeof l === "string") };
    } catch {
      return { title, lines: [] };
    }
  };
  const extra = [
    part("Housekeeping", () => {
      const h = latest<{ memory?: { fseventsdGb: number; serverGb: number }; warnings?: string[]; cleaned?: { workspaces: number; freedMb: number } }>("housekeeping");
      return [...(h.warnings ?? []), ...(h.cleaned ? [`the nightly clean-up removed ${h.cleaned.workspaces} old workspaces (${h.cleaned.freedMb} MB)`] : [])];
    }),
    part("Holds work up", () => (latest<{ blockers: { story: string; holdsUp: string[]; state: string }[] }>("blockage").blockers ?? []).slice(0, 3).map((b) => (b.holdsUp.length ? `${b.story} holds up ${b.holdsUp.length} (${b.state})` : `${b.story} (${b.state})`))),
    part("Usage limits", () => (latest<{ forecasts: { family: string; percentNow?: number; emptyAt?: string }[] }>("limits").forecasts ?? []).filter((f) => f.percentNow !== undefined).map((f) => `${f.family}: about ${f.percentNow}% of the week used${f.emptyAt ? `; at this pace reached ${f.emptyAt.slice(0, 16).replace("T", " ")} UTC, before the reset` : ""}`)),
    part("Models", () => {
      const tuning = readJson<{ trials?: { flow: string; step: string; status: string; startedAt: string; endedAt?: string; why?: string; to: { model?: string; effort?: string } }[] }>(join(o.home, "analyst", "tuning.json"), {});
      return (tuning.trials ?? []).filter((t) => (t.endedAt ?? t.startedAt) >= since).map((t) => `${t.flow} / ${t.step} on ${[t.to.model, t.to.effort && `effort ${t.to.effort}`].filter(Boolean).join(", ")}: ${t.status === "running" ? "on trial" : `${t.status === "kept" ? "kept" : "put back"} — ${t.why ?? ""}`}`);
    }),
    part("Machine load", () => {
      const load = lines(join(o.home, "governor", "changes.log")).filter((l) => l.slice(0, 24) >= since);
      return load.length > MANY_CHANGES ? [`the governor changed the limits ${load.length} times in the last day (more than ${MANY_CHANGES}); last: ${load.at(-1)!.slice(25)}`] : [];
    }),
    part("Unreliable tests", () => (latest<{ suspects: { test: string; failedIn: string[]; retriedIn?: string[] }[] }>("flaky").suspects ?? []).slice(0, 3).map((s) => `${s.test} — failed in ${s.failedIn.length} stories${s.retriedIn?.length ? `, passed only on a retry in ${s.retriedIn.length}` : ""}`)),
  ];
  const text = digestReport({ ...facts, extra }, o.now);
  const dir = join(o.home, "digest");
  save(dir, `${localDay(o.now)}.md`, text);
  save(dir, "report.md", text);
  return { text, line: digestLine(facts) };
}

export function limitsSet(rest: string[], out: Out, now = new Date()) {
  const [family, percent, reset] = rest;
  const p = Number(percent);
  const at = parseReset(reset ?? "");
  if (!FAMILIES.includes(family as Family) || !(p > 0 && p <= 100) || Number.isNaN(at) || at <= now.getTime()) throw new Error(OPS_USAGE);
  if (at - now.getTime() > MAX_RESET_AHEAD_MS) throw new Error("the next reset is at most 7 days ahead: a week's limit resets every week. Check the date.");
  const file = join(jobDir("limits"), "state.json");
  const state = { ...EMPTY_LIMITS, ...readJson<Partial<LimitsState>>(file, {}) };
  state.calibrations = { ...state.calibrations, [family as Family]: { percent: p, at: now.toISOString(), resetAt: new Date(at).toISOString() } };
  save(jobDir("limits"), "state.json", JSON.stringify(state, null, 2));
  out(`${family}: ${p}% used now; the week resets ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`);
}

/**
 * `scf governor|flaky|limits|blockage|digest …`. Each reads the data folder and writes in its own folder. Outside it:
 * the two that limit runs write their cap in governor/caps/, and the governor writes test-slots/cap.
 */
export async function opsCommand(name: string, positionals: string[], cliPath: string, out: Out, host?: ServiceHost): Promise<number> {
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
      else if (name === "housekeeping") {
        const { runHousekeeping, readPs } = await import("./housekeeping.js");
        const r = runHousekeeping({ dir, runsDir: join(dataDir(), "runs"), now, ps: readPs() });
        for (const text of r.notify) await sendDesktop({ title: "Foundry housekeeping", message: text });
        out(`${now.toISOString()} fseventsd ${r.result.memory.fseventsdGb} GB, server ${r.result.memory.serverGb} GB${r.result.cleaned ? `; cleaned ${r.result.cleaned.workspaces} workspaces, ${r.result.cleaned.freedMb} MB` : ""}${r.result.warnings.length ? ` — ${r.result.warnings.length} warning(s)` : ""}`);
      } else if (name === "flaky") {
        const r = runFlaky({ runsDir: join(dataDir(), "runs"), dir, now, file: ghFile });
        out(`${now.toISOString()} report written: ${join(dir, "report.md")}`);
        for (const f of r.filed) out(`  filed: ${f}`);
      } else if (name === "limits") runLimits({ runs: loadRuns(), dir, capsFile: capsPath(dataDir()), configured: configured(), now }), out(`${now.toISOString()} report written: ${join(dir, "report.md")}`);
      else if (name === "blockage") runBlockage({ runs: loadRuns(), dir, serviceLog: logTail(), repos: knownWatcherRepos(), limit: runLimit(configured(), now, capsPath(dataDir())), now }), out(`${now.toISOString()} report written: ${join(dir, "report.md")}`);
      else {
        const r = runDigest({ runs: loadRuns(), home: dataDir(), now });
        await sendDesktop({ title: "Foundry digest", message: r.line });
        out(`${now.toISOString()} ${r.line} — ${join(dir, "report.md")}`);
      }
      return 0;
    }
    case "report": {
      if (name === "governor") {
        // a state the governor did not renew has ended (loadState leaves it out): never show a limit that is over
        const s = loadState(dir, new Date());
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
      out(installJob(job, cliPath, host));
      return 0;
    case "uninstall":
      // stop the helper first: a check that still runs could write its cap again after it was cleared
      out(uninstallJob(name, host));
      if (name === "governor") clearGovernor(dir, join(dataDir(), "test-slots"), capsPath(dataDir()));
      if (name === "limits") setCap("limits", undefined, capsPath(dataDir()));
      return 0;
    case "reset":
      if (name !== "governor") throw new Error(OPS_USAGE);
      clearGovernor(dir, join(dataDir(), "test-slots"), capsPath(dataDir()));
      out("the governor's limits are taken away");
      return 0;
    case "status": {
      const state = jobState(name, host);
      out(state === "loaded" ? `${name} is installed` : state === "not loaded" ? `${name} is installed but not loaded: nothing runs (scf ${name} install)` : `${name} is not installed (scf ${name} install)`);
      if (name === "governor" || name === "limits") {
        const caps = Object.entries(loadCaps(capsPath(dataDir()))).filter(([, c]) => Date.parse(c.until) > Date.now());
        out(caps.length ? caps.map(([who, c]) => `cap by ${who}: ${c.runs} runs at once (${c.why})`).join("\n") : "no cap on runs at once");
      }
      if (name === "governor") {
        const n = changesToday(dir, new Date());
        out(`the governor changed the limits ${n} time${n === 1 ? "" : "s"} today`);
      }
      return 0;
    }
    default:
      throw new Error(OPS_USAGE);
  }
}
