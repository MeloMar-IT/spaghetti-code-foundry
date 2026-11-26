import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHeartbeat, type Heartbeat } from "../src/heartbeat.js";
import { runWatchdog, type WatchdogOptions, type WatchdogState } from "../src/ops/watchdog.js";
import { createRestartGate, GUARD_FILE, INTENT_FILE, type Guard } from "../src/restart-gate.js";
import type { ServiceHost } from "../src/service.js";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const AGENT = 4242; // the supervisor: what launchd runs
const SERVER = 4343; // its child
const KICK = ["kickstart", "-k", "gui/501/com.spaghetti-code-foundry.server"];
const iso = (t: number) => new Date(t).toISOString();

describe("watchdog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), "scf-watchdog-"));
    dirs.push(dataDir);
    const dir = join(dataDir, "watchdog");
    mkdirSync(dir);
    const t = {
      clock: NOW,
      kicks: [] as string[][],
      onKick: () => {},
      onPrint: () => {},
      loaded: true,
      parent: AGENT as number | undefined,
      platform: "darwin" as NodeJS.Platform,
    };
    const host: ServiceHost = {
      get platform() {
        return t.platform;
      },
      agentsDir: join(dataDir, "agents"),
      domain: "gui/501",
      launchctl(args) {
        if (args[0] === "print") {
          if (!t.loaded) throw new Error("Could not find service");
          t.onPrint();
          return `gui/501/x = {\n\tstate = running\n\tpid = ${AGENT}\n}\n`;
        }
        t.kicks.push(args);
        t.onKick();
        return "";
      },
      writeFile: () => {
        throw new Error("no file of launchd is written here");
      },
      removeFile: () => {},
    };
    /** A server whose queue stands still for two hours with work ready; its heartbeat is fresh. */
    const beat = (o: Partial<Heartbeat> = {}) =>
      writeHeartbeat(dataDir, {
        version: 1, at: iso(t.clock), pid: SERVER, supervisorPid: AGENT, startedAt: iso(NOW - 48 * HOUR),
        pumpAt: iso(t.clock - 2 * HOUR), readySince: iso(t.clock - 2 * HOUR), watchAt: iso(t.clock - MIN), watchers: 1, watchEverySec: 300,
        ready: 1, pending: 1, active: 0, draining: false, ...o,
      });
    const guard = (o: Partial<Guard> = {}) =>
      writeFileSync(join(dataDir, GUARD_FILE), JSON.stringify({ version: 1, pid: SERVER, count: 0, items: [], updating: false, ...o }));
    const held = (...items: [string, string][]) => guard({ count: items.length, items: items.map(([runId, step]) => ({ runId, step })) });
    /** The history of a job that has run every five minutes. */
    const seed = (o: Partial<WatchdogState> = {}) =>
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, checkedAt: iso(t.clock - 5 * MIN), wokeAt: iso(NOW - 40 * HOUR), restarts: [], asked: [], ...o }));
    const options: WatchdogOptions = {
      dir, dataDir, host, settings: { pump_minutes: 30, watcher_minutes: 30 },
      now: () => new Date(t.clock), parentOf: (pid) => (pid === SERVER ? t.parent : undefined),
    };
    const run = (o: Partial<WatchdogOptions> = {}) => runWatchdog({ ...options, ...o });
    const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as WatchdogState;
    /** Time goes on with a check every five minutes (only the last one counts here). */
    const later = (ms: number) => {
      t.clock += ms;
      writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state(), checkedAt: iso(t.clock - 5 * MIN) }));
    };
    const events = () => (existsSync(join(dir, "events.log")) ? readFileSync(join(dir, "events.log"), "utf8") : "");
    const intent = () => existsSync(join(dataDir, INTENT_FILE));
    guard();
    seed();
    beat();
    return { dataDir, dir, t, beat, guard, held, seed, run, state, later, events, intent };
  }

  it("restarts a stopped queue once through the login agent, then asks once, and may restart again after a day", () => {
    const s = setup();
    const first = s.run();
    expect(first.action).toBe("restart");
    expect(s.t.kicks).toEqual([KICK]);
    expect(first.notices).toEqual([]);
    expect(s.events()).toContain(`${iso(NOW)} auto: restarted the server: the queue has not moved for 120 minutes`);
    expect(s.state().restarts).toEqual([iso(NOW)]);
    expect(s.intent()).toBe(true); // the old server may still be shutting down

    s.later(30 * MIN);
    s.beat();
    expect(s.run()).toMatchObject({ action: "none", notices: [] });

    s.later(90 * MIN);
    s.beat();
    const second = s.run();
    expect(second.action).toBe("ask");
    expect(second.notices).toEqual([expect.stringContaining("again within 24 hours")]);
    s.later(5 * MIN);
    s.beat();
    expect(s.run().notices).toEqual([]);
    expect(s.events().match(/ ask: /g)).toHaveLength(1);
    expect(readFileSync(join(s.dir, "report.md"), "utf8")).toContain("ask: ");
    expect(s.t.kicks).toHaveLength(1);

    s.later(23 * HOUR);
    s.beat();
    expect(s.run().action).toBe("restart");
    expect(s.t.kicks).toEqual([KICK, KICK]);
  });

  it("restarts only the process that launchd runs", () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void][] = [
      ["a server of a terminal or an old child", (s) => (s.t.parent = 1)],
      ["another supervisor", (s) => s.beat({ supervisorPid: 999 })],
      ["a parent that cannot be told", (s) => (s.t.parent = undefined)],
      ["an agent that is not loaded", (s) => (s.t.loaded = false)],
      ["Linux", (s) => (s.t.platform = "linux")],
      ["an unsupervised server with another pid", (s) => s.beat({ supervisorPid: undefined })],
    ];
    for (const [what, change] of cases) {
      const s = setup();
      change(s);
      expect(s.run(), what).toMatchObject({ action: "none", notices: [] });
      expect(s.t.kicks, what).toEqual([]);
    }
    const direct = setup();
    direct.beat({ pid: AGENT, supervisorPid: undefined });
    direct.guard({ pid: AGENT });
    expect(direct.run().action).toBe("restart");
  });

  it("never cuts a push, also one that started after the last heartbeat", () => {
    const s = setup();
    s.beat({ at: iso(NOW - 45 * MIN) });
    s.held(["run-7", "push_develop"]);
    const r = s.run();
    expect(r.action).toBe("ask");
    expect(r.notices).toEqual([expect.stringContaining("run run-7 is in step push_develop")]);
    expect(s.t.kicks).toEqual([]);
    expect(s.intent()).toBe(false);
    s.later(5 * MIN);
    expect(s.run().notices).toEqual([]);
  });

  it("looks at the guard again after it announced the restart, and withdraws", () => {
    const s = setup();
    let reads = 0;
    // the clock is read for the check, then for the announcement: the step starts right between the two looks
    const now = () => {
      if (++reads === 2) s.held(["run-8", "merge_main"]);
      return new Date(s.t.clock);
    };
    const r = s.run({ now });
    expect(r.action).toBe("ask");
    expect(r.notices[0]).toContain("merge_main");
    expect(s.t.kicks).toEqual([]);
    expect(s.intent()).toBe(false);
    expect(s.state().restarts).toEqual([]);
  });

  it("makes a server wait that enters a protected step during an announced restart", () => {
    const s = setup();
    let waited = 0;
    const gate = createRestartGate({
      dir: s.dataDir, pid: SERVER, uncuttable: () => [{ runId: "run-9", step: "publish" }], updating: () => false,
      now: () => s.t.clock,
      pause: (ms) => {
        waited += ms;
        s.t.clock += ms;
      },
    });
    s.t.onKick = () => void gate.publish();
    s.run();
    expect(waited).toBe(60_000); // until the announcement expired: launchd ends the server long before
  });

  it("does not restart with a guard it cannot trust, or while the self-update runs", () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
      ["missing", (s) => rmSync(join(s.dataDir, GUARD_FILE)), "cannot be trusted"],
      ["broken", (s) => writeFileSync(join(s.dataDir, GUARD_FILE), "{"), "cannot be trusted"],
      ["of another process", (s) => s.guard({ pid: 1 }), "cannot be trusted"],
      ["updating", (s) => s.guard({ updating: true }), "the self-update"],
      ["only a count", (s) => s.guard({ count: 2 }), "2 more run(s)"],
    ];
    for (const [what, change, said] of cases) {
      const s = setup();
      change(s);
      const r = s.run();
      expect(r.action, what).toBe("ask");
      expect(r.notices[0], what).toContain(said);
      expect(s.t.kicks, what).toEqual([]);
    }
  });

  it("needs ready work, for the queue, a silent server and the watchers alike", () => {
    const blocked = setup();
    blocked.beat({ ready: 0, readySince: undefined, at: iso(NOW - 3 * HOUR), watchAt: iso(NOW - 3 * HOUR), pending: 4 });
    expect(blocked.run()).toMatchObject({ action: "none", notices: [] });
    expect(blocked.t.kicks).toEqual([]);

    const watchers = setup();
    watchers.beat({ pumpAt: iso(NOW - MIN), watchAt: iso(NOW - 2 * HOUR) });
    expect(watchers.run().line).toContain("no watcher has finished a check for 120 minutes");
    expect(watchers.t.kicks).toHaveLength(1);

    const slow = setup();
    slow.beat({ pumpAt: iso(NOW - MIN), watchAt: iso(NOW - 2 * HOUR), watchEverySec: 3600 });
    expect(slow.run().line).toContain("the queue and watchers are fine");

    const none = setup();
    none.beat({ pumpAt: iso(NOW - MIN), watchAt: undefined, watchers: 0 });
    expect(none.run().action).toBe("none");

    const silent = setup();
    silent.beat({ at: iso(NOW - 31 * MIN), pumpAt: iso(NOW - 31 * MIN), readySince: iso(NOW - 31 * MIN) });
    expect(silent.run().line).toContain("no heartbeat for 31 minutes");
    expect(silent.t.kicks).toHaveLength(1);

    const fresh = setup();
    fresh.beat({ readySince: iso(NOW - 10 * MIN) });
    expect(fresh.run().action).toBe("none");
  });

  it("counts a stall again from the start after sleep, and only waits at its first check", () => {
    for (const history of ["slept", "first", "future"]) {
      const s = setup();
      if (history === "first") rmSync(join(s.dir, "state.json"));
      else s.seed({ checkedAt: iso(history === "slept" ? NOW - 8 * HOUR : NOW + HOUR) });
      const old = { at: iso(NOW - 8 * HOUR), pumpAt: iso(NOW - 8 * HOUR), readySince: iso(NOW - 8 * HOUR), watchAt: iso(NOW - 8 * HOUR) };
      s.beat(old);
      expect(s.run().action, history).toBe("none");
      for (let i = 0; i < 6; i++) {
        s.t.clock += 5 * MIN;
        expect(s.run().action, history).toBe("none");
      }
      expect(s.t.kicks, history).toEqual([]);
      s.t.clock += 5 * MIN;
      expect(s.run().action, history).toBe("restart");
    }
  });

  it("lets only one of two overlapping checks restart", () => {
    const s = setup();
    let inner: ReturnType<typeof s.run> | undefined;
    s.t.onKick = () => (inner = s.run());
    s.run();
    expect(inner?.line).toContain("another check holds the lock");
    expect(s.t.kicks).toHaveLength(1);
  });

  it("does not restart when the attempt cannot be saved", () => {
    const s = setup();
    mkdirSync(join(s.dir, "state.json.tmp"));
    writeFileSync(join(s.dir, "state.json.tmp", "x"), "");
    const r = s.run();
    expect(r.action).toBe("none");
    expect(r.line).toContain("could not be saved");
    expect(s.t.kicks).toEqual([]);
    expect(s.intent()).toBe(false);
  });

  it("does not restart when the restart cannot be announced, or too long after the announcement", () => {
    const s = setup();
    mkdirSync(join(s.dataDir, `${INTENT_FILE}.tmp`));
    writeFileSync(join(s.dataDir, `${INTENT_FILE}.tmp`, "x"), "");
    expect(s.run().line).toContain("could not be announced");
    expect(s.t.kicks).toEqual([]);

    const late = setup();
    let reads = 0;
    const r = late.run({ now: () => new Date(NOW + (++reads >= 3 ? 11_000 : 0)) });
    expect(r.line).toContain("took too long");
    expect(late.t.kicks).toEqual([]);
    expect(late.state().restarts).toEqual([]);
    expect(late.intent()).toBe(false);
  });

  it("keeps a failed restart on record and asks at the next stall", () => {
    const s = setup();
    s.t.onKick = () => {
      throw new Error("launchctl said no");
    };
    expect(s.run().line).toContain("the restart of the server failed (launchctl said no)");
    expect(s.intent()).toBe(false);
    expect(s.state().restarts).toEqual([iso(NOW)]);
    s.later(2 * HOUR);
    s.beat();
    expect(s.run().action).toBe("ask");
    expect(s.t.kicks).toHaveLength(1);
  });

  it("says one notice for each restart window, also with a healthy check between", () => {
    const s = setup();
    s.seed({ restarts: [iso(NOW - 2 * HOUR)] });
    expect(s.run().notices).toHaveLength(1);
    s.later(5 * MIN);
    s.beat({ ready: 0 });
    expect(s.run().action).toBe("none");
    s.later(5 * MIN);
    s.beat();
    expect(s.run()).toMatchObject({ action: "ask", notices: [] });
  });

  it("announces each protected step once", () => {
    const s = setup();
    const said: number[] = [];
    for (const step of ["push", "publish", "push", "publish"]) {
      s.held(["r1", step]);
      s.beat();
      said.push(s.run().notices.length);
      s.later(5 * MIN);
    }
    expect(said).toEqual([1, 1, 0, 0]);
    // forgotten a day after it was last seen
    s.later(25 * HOUR);
    s.beat();
    expect(s.run().notices).toHaveLength(1);
  });

  it("acts as if it had just restarted when its history cannot be read, and keeps a copy", () => {
    const s = setup();
    writeFileSync(join(s.dir, "state.json"), "{broken");
    expect(s.run().action).toBe("none");
    expect(readFileSync(join(s.dir, "state.json.broken"), "utf8")).toBe("{broken");
    expect(s.state().restarts).toEqual([iso(NOW)]);
    expect(s.t.kicks).toEqual([]);
  });

  it("uses the limits of the settings", () => {
    const s = setup();
    expect(s.run({ settings: { pump_minutes: 180, watcher_minutes: 180 } }).action).toBe("none");
    s.later(5 * MIN);
    s.beat();
    expect(s.run({ settings: { pump_minutes: 60, watcher_minutes: 60 } }).action).toBe("restart");
  });

  it("does nothing without a usable heartbeat or while a restart waits", () => {
    for (const text of [undefined, "{broken", JSON.stringify({ version: 2 })]) {
      const s = setup();
      if (text === undefined) rmSync(join(s.dataDir, "heartbeat.json"));
      else writeFileSync(join(s.dataDir, "heartbeat.json"), text);
      expect(s.run(), String(text)).toMatchObject({ action: "none", notices: [] });
      expect(s.t.kicks).toEqual([]);
    }
    const draining = setup();
    draining.beat({ draining: true });
    expect(draining.run().action).toBe("none");
    expect(draining.t.kicks).toEqual([]);
  });

  it("never throws, also when its folder cannot be made", () => {
    const s = setup();
    writeFileSync(join(s.dataDir, "file"), "");
    expect(s.run({ dir: join(s.dataDir, "file", "watchdog") }).line).toContain("the check did not run");
    expect(s.t.kicks).toEqual([]);
  });
});
