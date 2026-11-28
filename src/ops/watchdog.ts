// The watchdog (#961): a helper outside the server. When the queue or the watchers stand still while work is ready, it
// restarts the server's login agent, at most once in 24 hours; after that, and while something must not be cut, it asks.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHeartbeat, type Heartbeat } from "../heartbeat.js";
import { recordRepair, wedgedServerRestart } from "../monitor/repair-log.js";
import { announceRestart, readGuard, withdrawRestart, writeAtomic, type Guard } from "../restart-gate.js";
import { SERVICE_LABEL, type ServiceHost } from "../service.js";
import { pidAlive, withStoryLockSync } from "../stories/story-lock.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const RESTART_GAP_MS = HOUR;
const WINDOW_MS = 24 * HOUR;
/** One interval of the job plus a minute: a longer gap means the machine slept or the job did not run. */
const WAKE_GAP_MS = 6 * MIN;
/** The kickstart must follow its announcement at once: the server waits only as long as the announcement lives. */
const ANNOUNCE_BOUND_MS = 10_000;

export interface WatchdogSettings {
  pump_minutes: number;
  watcher_minutes: number;
}

export interface WatchdogState {
  version: 1;
  checkedAt?: string;
  /** Ages are counted from no earlier than this. */
  wokeAt?: string;
  restarts: string[];
  /** What was asked about, with when it was last seen. */
  asked: { key: string; at: string }[];
}

export interface Decision {
  action: "none" | "restart" | "ask";
  why: string;
  /** For "ask": what is asked about; a notice goes out when one of these is new. */
  keys: string[];
}

const time = (t: string | undefined): number => (t ? Date.parse(t) || 0 : 0);
const minutes = (ms: number) => Math.floor(ms / MIN);

/** Why the server counts as stalled, or undefined. A restart always needs work that is ready. */
export function stalledReason(hb: Heartbeat, now: Date, wokeAt: string | undefined, settings: WatchdogSettings): string | undefined {
  if (hb.ready <= 0) return undefined;
  const floor = Math.max(time(wokeAt), time(hb.startedAt));
  const age = (...since: number[]) => now.getTime() - Math.max(floor, ...since);
  const pumpLimit = settings.pump_minutes * MIN;
  const silent = age(time(hb.at));
  if (silent > pumpLimit) return `the server has written no heartbeat for ${minutes(silent)} minutes while work was ready`;
  const stood = age(time(hb.readySince ?? hb.at), time(hb.pumpAt ?? hb.startedAt));
  if (stood > pumpLimit) return `the queue has not moved for ${minutes(stood)} minutes while work is ready`;
  const watched = age(time(hb.watchAt ?? hb.startedAt));
  const watchLimit = Math.max(settings.watcher_minutes * MIN, 3 * (hb.watchEverySec ?? 0) * 1000);
  if (hb.watchers > 0 && watched > watchLimit) return `no watcher has finished a check for ${minutes(watched)} minutes while work is ready`;
  return undefined;
}

/** What keeps the server from being restarted: each with its notice key and its words. */
function blockers(hb: Heartbeat, guard: Guard | undefined): { key: string; text: string }[] {
  if (!guard || guard.pid !== hb.pid) return [{ key: "guard", text: "the restart guard cannot be trusted, so a push, merge or release could be cut" }];
  const out = guard.items.map((r) => ({ key: `uncut|${r.runId}:${r.step}`, text: `run ${r.runId} is in step ${r.step}` }));
  const more = guard.count - guard.items.length;
  if (more > 0) out.push({ key: out.at(-1)?.key ?? "uncut|unknown:unknown", text: `${more} more run(s) are in a step that must not be cut` });
  if (guard.updating) out.push({ key: "update", text: "the self-update runs" });
  return out;
}

export function decideWatchdog(o: { hb: Heartbeat | undefined; state: WatchdogState; guard: Guard | undefined; isServerAgent: boolean; now: Date; settings: WatchdogSettings }): Decision {
  const none = (why: string): Decision => ({ action: "none", why, keys: [] });
  const { hb, now } = o;
  if (!hb) return none("there is no usable heartbeat: nothing to do");
  if (hb.draining) return none("the server waits to restart or starts nothing new: nothing to do");
  const stalled = stalledReason(hb, now, o.state.wokeAt, o.settings);
  if (!stalled) return none("no restart needed: the queue and watchers are fine");
  if (!o.isServerAgent) return none(`${stalled}, but the process of the heartbeat is not the server's login agent: nothing to do`);
  const held = blockers(hb, o.guard);
  if (held.length) {
    return { action: "ask", why: `${stalled}, but the server is not restarted: ${held.map((b) => b.text).join("; ")}`, keys: [...new Set(held.map((b) => b.key))] };
  }
  const last = Math.max(0, ...o.state.restarts.map(time));
  const since = now.getTime() - last;
  if (last && since < RESTART_GAP_MS) return none(`${stalled}; the server was restarted less than an hour ago: waiting`);
  if (last && since < WINDOW_MS) {
    return { action: "ask", why: `${stalled}, again within 24 hours of a restart: please look at the server`, keys: [`again|${new Date(last).toISOString()}`] };
  }
  return { action: "restart", why: stalled, keys: [] };
}

/** The pid launchd has for the server's login agent; undefined off macOS or when it is not loaded or not running. */
export function agentPid(host: ServiceHost): number | undefined {
  if (host.platform !== "darwin") return undefined;
  try {
    const m = /^\s*pid = (\d+)/m.exec(host.launchctl(["print", `${host.domain}/${SERVICE_LABEL}`]));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** The live parent of a process; undefined when it cannot be told. */
export function parentOf(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const n = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is the heartbeat from the server that launchd runs? Under launchd the agent is the supervisor and the server is its child,
 * so both must fit now: this also rejects a server of a terminal and a heartbeat left by an earlier child.
 */
export function isServerAgent(hb: Heartbeat, agent: number | undefined, parent: (pid: number) => number | undefined): boolean {
  if (agent === undefined) return false;
  if (hb.supervisorPid === undefined) return agent === hb.pid;
  try {
    return agent === hb.supervisorPid && parent(hb.pid) === hb.supervisorPid;
  } catch {
    return false;
  }
}

const emptyState = (): WatchdogState => ({ version: 1, restarts: [], asked: [] });

/** The saved history. One that cannot be read is kept aside, and counts as a restart made just now. */
function loadWatchdogState(dir: string, now: Date): WatchdogState {
  const file = join(dir, "state.json");
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchdogState>;
    if (s.version !== 1 || !Array.isArray(s.restarts) || !s.restarts.every((t) => time(t) > 0) || !Array.isArray(s.asked)) throw new Error("not a watchdog state");
    return { ...s, version: 1, restarts: s.restarts, asked: s.asked.filter((a) => typeof a?.key === "string") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    try {
      // a copy: should the new state not be saved, the next check must not find an empty history
      copyFileSync(file, `${file}.broken`);
    } catch {
      // it counts as a restart anyway
    }
    return { ...emptyState(), restarts: [now.toISOString()] };
  }
}

const saveState = (dir: string, state: WatchdogState) => writeAtomic(join(dir, "state.json"), JSON.stringify(state, null, 2));

export interface WatchdogOptions {
  /** The watchdog's own folder. */
  dir: string;
  /** The server's data folder: the heartbeat and the guard. */
  dataDir: string;
  host: ServiceHost;
  settings: WatchdogSettings;
  now?: () => Date;
  parentOf?: (pid: number) => number | undefined;
}

export interface WatchdogResult {
  action: Decision["action"];
  line: string;
  /** The texts to show the owner now. */
  notices: string[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

/** One check. Only one runs at a time, from reading the history to the restart. Never throws. */
export function runWatchdog(o: WatchdogOptions): WatchdogResult {
  const clock = o.now ?? (() => new Date());
  let locked = false;
  try {
    mkdirSync(o.dir, { recursive: true });
    return withStoryLockSync(o.dir, { waitMs: 0, pollMs: 50, alive: pidAlive }, (held) => {
      locked = true;
      return check(o, clock, held);
    });
  } catch (e) {
    const why = locked
      ? `the check failed (${message(e)})`
      : message(e).startsWith("the stories are locked")
        ? `the check did not run: another check holds the lock (if none runs, delete ${join(o.dir, ".lock")})`
        : `the check did not run (${message(e)})`;
    return { action: "none", line: `${clock().toISOString()} ${why}`, notices: [] };
  }
}

function check(o: WatchdogOptions, clock: () => Date, held: () => boolean): WatchdogResult {
  const now = clock();
  const iso = now.toISOString();
  const state = loadWatchdogState(o.dir, now);
  const sinceCheck = now.getTime() - time(state.checkedAt);
  // after sleep (or a first check) everything looks old: a stall has to last a full limit again
  if (!state.checkedAt || !(sinceCheck >= 0 && sinceCheck <= WAKE_GAP_MS)) state.wokeAt = iso;
  state.checkedAt = iso;
  // forgotten only a day after they were last seen, never because a check was healthy
  state.asked = state.asked.filter((a) => now.getTime() - time(a.at) < WINDOW_MS);
  state.restarts = state.restarts.slice(-20);

  const read = readHeartbeat(o.dataDir);
  const hb = read === "newer" ? undefined : read;
  const stalled = !!hb && !hb.draining && !!stalledReason(hb, now, state.wokeAt, o.settings);
  // launchd and ps are asked only when it matters
  const ours = stalled && isServerAgent(hb!, agentPid(o.host), o.parentOf ?? parentOf);
  const decide = () => decideWatchdog({ hb, state, guard: readGuard(o.dataDir), isServerAgent: ours, now, settings: o.settings });

  let decision = decide();
  let restarted: string | undefined;
  const events: string[] = [];
  if (decision.action === "restart") {
    const stall = decision.why;
    const notRestarted = (why: string) => {
      decision = { action: "none", why: `${stall}, but ${why}: not restarted`, keys: [] };
    };
    let announcedAt = 0;
    try {
      // announce first, then look at the guard again: work that starts from now on waits, work that started is seen
      announcedAt = clock().getTime();
      announceRestart(o.dataDir, hb!.pid, new Date(announcedAt));
      decision = decide();
    } catch (e) {
      notRestarted(`the restart could not be announced (${message(e)})`);
    }
    if (decision.action === "restart") {
      state.restarts.push(iso);
      try {
        saveState(o.dir, state);
        if (!held() || clock().getTime() - announcedAt > ANNOUNCE_BOUND_MS) {
          state.restarts.pop();
          notRestarted("the check took too long or lost its lock");
        }
      } catch (e) {
        state.restarts.pop();
        notRestarted(`the attempt could not be saved (${message(e)})`);
      }
    }
    if (decision.action === "restart") {
      try {
        o.host.launchctl(["kickstart", "-k", `${o.host.domain}/${SERVICE_LABEL}`]);
        // the announcement stays until it expires: the old server may still be shutting down
        restarted = `restarted the server: ${stall}`;
      } catch (e) {
        withdrawRestart(o.dataDir);
        restarted = `the restart of the server failed (${message(e)}): ${stall}`;
      }
      events.push(`auto: ${restarted}`);
      const result = restarted.startsWith("restarted") ? "done" : "failed";
      recordRepair(wedgedServerRestart({ at: iso }, result), { now, file: join(o.dataDir, "monitor-repairs.jsonl") });
    } else withdrawRestart(o.dataDir);
  }

  const notices: string[] = [];
  if (decision.action === "ask") {
    const { keys, why } = decision;
    if (keys.some((k) => !state.asked.some((a) => a.key === k))) {
      notices.push(why);
      events.push(`ask: ${why}`);
    }
    state.asked = [...state.asked.filter((a) => !keys.includes(a.key)), ...keys.map((key) => ({ key, at: iso }))];
  }

  let line = `${iso} ${restarted ?? decision.why}`;
  try {
    saveState(o.dir, state);
  } catch (e) {
    line += ` (the watchdog's state could not be saved: ${message(e)})`;
  }
  record(o.dir, iso, decision.action, line, events);
  return { action: decision.action, line, notices };
}

/** The events, the report and the last result. Best effort: the check is done by now. */
function record(dir: string, at: string, action: Decision["action"], line: string, events: string[]): void {
  const log = join(dir, "events.log");
  try {
    for (const e of events) appendFileSync(log, `${at} ${e}\n`);
  } catch {
    // the printed line still says it
  }
  try {
    let last: string[] = [];
    try {
      last = readFileSync(log, "utf8").trim().split("\n").slice(-20);
    } catch {
      // no events yet
    }
    writeFileSync(join(dir, "report.md"), `# Watchdog\n\nLast check: ${line}\n\n## Last events\n\n${last.length ? last.map((l) => `- ${l}`).join("\n") : "none"}\n`);
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ at, action, line }, null, 2));
  } catch {
    // best effort
  }
}
