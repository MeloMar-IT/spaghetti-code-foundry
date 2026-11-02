import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUSY_APPS_CAP, BUSY_CAP, BUSY_HOLD_MS, busyAppsRunning, busyCaps, busyHolds, checkBusyApps, governorBusyApps, loadBusy, setBusy, syncBusyCap } from "../src/ops/busy.js";
import { loadCaps, runLimit, setCap } from "../src/ops/caps.js";
import { clearGovernor, HOLD_MS } from "../src/ops/governor.js";
import { busyView, parseHours } from "../src/server/api-busy.js";
import { HttpError } from "../src/server/http.js";
import { busyPriority } from "../src/steps/process.js";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

let home: string;
let path: string;
let capsFile: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "busy-"));
  mkdirSync(join(home, "governor"));
  path = join(home, "governor", "busy.json");
  capsFile = join(home, "governor", "caps.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the switch set by hand", () => {
  it("on without an end: a file, a cap and a lower limit", () => {
    setBusy({ since: NOW.toISOString() }, 2, NOW, path, capsFile);
    expect(existsSync(path)).toBe(true);
    expect(loadCaps(capsFile)[BUSY_CAP]).toMatchObject({ runs: 2, until: at(4).toISOString() });
    expect(runLimit(5, NOW, capsFile)).toBe(2);
    expect(runLimit(1, NOW, capsFile)).toBe(1);
    setBusy({ since: NOW.toISOString() }, 0, NOW, path, capsFile);
    expect(runLimit(5, NOW, capsFile)).toBe(0);
  });

  it("is renewed by the server; a server that is gone leaves no cap behind", () => {
    setBusy({ since: NOW.toISOString() }, 2, NOW, path, capsFile);
    expect(syncBusyCap(2, at(3), path, capsFile)).toBeDefined();
    expect(loadCaps(capsFile)[BUSY_CAP]!.until).toBe(at(7).toISOString());
    // no sync for ten minutes: the cap has ended, the switch still stands
    expect(runLimit(5, at(20), capsFile)).toBe(5);
    expect(loadBusy(at(20), path)).toBeDefined();
    syncBusyCap(2, at(20), path, capsFile);
    expect(runLimit(5, at(20), capsFile)).toBe(2);
    // a changed busy_runs shows up at the next sync
    syncBusyCap(3, at(21), path, capsFile);
    expect(loadCaps(capsFile)[BUSY_CAP]!.runs).toBe(3);
  });

  it("is put back after a restart that lost the cap", () => {
    setBusy({ since: NOW.toISOString() }, 2, NOW, path, capsFile);
    rmSync(join(home, "governor", "caps"), { recursive: true, force: true });
    expect(runLimit(5, NOW, capsFile)).toBe(5);
    syncBusyCap(2, at(1), path, capsFile);
    expect(runLimit(5, at(1), capsFile)).toBe(2);
  });

  it("with an end time: the cap never outlasts it, and the switch goes at the end", () => {
    setBusy({ since: NOW.toISOString(), until: at(60).toISOString() }, 2, NOW, path, capsFile);
    syncBusyCap(2, at(58), path, capsFile);
    expect(loadCaps(capsFile)[BUSY_CAP]!.until).toBe(at(60).toISOString());
    expect(loadBusy(at(61), path)).toBeUndefined();
    expect(syncBusyCap(2, at(61), path, capsFile)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(loadCaps(capsFile)[BUSY_CAP]).toBeUndefined();
  });

  it("off removes the file and the cap, and off again is a no-op", () => {
    setBusy({ since: NOW.toISOString() }, 2, NOW, path, capsFile);
    setBusy(undefined, 2, NOW, path, capsFile);
    expect(existsSync(path)).toBe(false);
    expect(loadCaps(capsFile)[BUSY_CAP]).toBeUndefined();
    expect(() => setBusy(undefined, 2, NOW, path, capsFile)).not.toThrow();
  });

  it("a broken file counts as off", () => {
    for (const text of ["{nope", "null", "[]", "{}", JSON.stringify({ since: "x" }), JSON.stringify({ since: NOW.toISOString(), until: "later" })]) {
      writeFileSync(path, text);
      expect(loadBusy(NOW, path), text).toBeUndefined();
      expect(() => syncBusyCap(2, NOW, path, capsFile), text).not.toThrow();
      expect(runLimit(5, NOW, capsFile)).toBe(5);
    }
  });
});

describe("programs", () => {
  it("busyAppsRunning matches names the way ps shows them", () => {
    expect(busyAppsRunning(["zoom.us", "node"], ["Zoom.us", "Xcode"])).toEqual(["Zoom.us"]);
    expect(busyAppsRunning(["Zoom"], ["Zoo"])).toEqual([]);
    expect(busyAppsRunning(["Zoom"], ["Zoom", "zoom"])).toEqual(["Zoom"]);
    expect(busyAppsRunning(["Microsoft Teams"], ["Microsoft Teams (work)"])).toEqual(["Microsoft Teams (work)"]); // cut at 15 characters
    expect(busyAppsRunning(["Microsoft Tea"], ["Microsoft Teams"])).toEqual([]); // short names must match whole
    expect(busyAppsRunning(["Zoom"], [])).toEqual([]);
  });

  it("checkBusyApps turns the cap on and off and never touches the switch by hand", () => {
    setBusy({ since: NOW.toISOString() }, 2, NOW, path, capsFile);
    const hand = loadCaps(capsFile)[BUSY_CAP];
    expect(checkBusyApps(["Zoom"], 2, NOW, capsFile)).toBe("on");
    expect(loadCaps(capsFile)[BUSY_APPS_CAP]).toMatchObject({ runs: 2, why: "Zoom running", until: at(4).toISOString() });
    expect(checkBusyApps(["Zoom"], 2, at(1), capsFile)).toBeUndefined();
    expect(checkBusyApps([], 2, at(2), capsFile)).toBe("off");
    expect(loadCaps(capsFile)[BUSY_APPS_CAP]).toBeUndefined();
    expect(checkBusyApps([], 2, at(3), capsFile)).toBeUndefined();
    expect(loadCaps(capsFile)[BUSY_CAP]).toEqual(hand);
  });

  it("governorBusyApps: a list that matches sets the cap; a failed lookup leaves it alone", () => {
    const names = new Map([[1, "zoom.us"]]);
    expect(governorBusyApps({ names }, ["zoom.us"], 2, NOW, capsFile)).toBe("busy mode on: zoom.us running");
    expect(busyHolds(NOW, capsFile)).toBe(true);
    // ps could not give the names: not a reason to end busy mode
    expect(governorBusyApps({ names: new Map(), namesRead: false }, ["zoom.us"], 2, at(1), capsFile)).toBeUndefined();
    expect(governorBusyApps(undefined, ["zoom.us"], 2, at(1), capsFile)).toBeUndefined();
    expect(busyHolds(at(1), capsFile)).toBe(true);
    // names were read and the program is gone
    expect(governorBusyApps({ names: new Map([[2, "node"]]), namesRead: true }, ["zoom.us"], 2, at(2), capsFile)).toBe("busy mode off");
    expect(busyHolds(at(2), capsFile)).toBe(false);
    // an empty list removes a cap left from an earlier list, even without a table
    checkBusyApps(["x"], 2, at(3), capsFile);
    expect(governorBusyApps(undefined, [], 2, at(3), capsFile)).toBe("busy mode off");
  });

  it("clearGovernor takes away busy-apps and keeps busy", () => {
    setBusy({ since: NOW.toISOString() }, 2, NOW, path, capsFile);
    checkBusyApps(["Zoom"], 2, NOW, capsFile);
    setCap("load", { runs: 1, until: at(4).toISOString(), why: "machine load" }, capsFile);
    clearGovernor(join(home, "governor"), join(home, "slots"), capsFile);
    expect(Object.keys(loadCaps(capsFile))).toEqual([BUSY_CAP]);
  });

  it("holds the same time as the governor", () => {
    expect(BUSY_HOLD_MS).toBe(HOLD_MS);
  });
});

describe("busyHolds", () => {
  it("is true for each cap alone and false after its end", () => {
    expect(busyHolds(NOW, capsFile)).toBe(false);
    setCap(BUSY_CAP, { runs: 1, until: at(4).toISOString(), why: "x" }, capsFile);
    expect(busyHolds(at(1), capsFile)).toBe(true);
    expect(busyHolds(at(5), capsFile)).toBe(false);
    setCap(BUSY_CAP, undefined, capsFile);
    setCap(BUSY_APPS_CAP, { runs: 1, until: at(4).toISOString(), why: "x" }, capsFile);
    expect(busyCaps(at(1), capsFile).apps).toBeDefined();
    expect(busyHolds(at(1), capsFile)).toBe(true);
    expect(busyHolds(at(5), capsFile)).toBe(false);
  });

  it("is false, and does not throw, when the caps cannot be read", () => {
    writeFileSync(join(home, "governor", "caps"), "a file where the folder should be");
    expect(busyHolds(NOW, capsFile)).toBe(false);
    expect(busyHolds(NOW, join(home, "nope", "caps.json"))).toBe(false);
  });
});

describe("busyPriority", () => {
  it("makes every priority background while busy, and leaves a process without one alone", () => {
    for (const p of ["low", "normal", "background"] as const) {
      expect(busyPriority(p, true)).toBe("background");
      expect(busyPriority(p, false)).toBe(p);
    }
    expect(busyPriority(undefined, true)).toBeUndefined();
    expect(busyPriority(undefined, false)).toBeUndefined();
  });
});

describe("the API", () => {
  it("parseHours: none means until switched off; else above 0 and at most 24", () => {
    expect(parseHours({})).toBeUndefined();
    expect(parseHours({ hours: null })).toBeUndefined();
    expect(parseHours({ hours: 0.5 })).toBe(0.5);
    expect(parseHours({ hours: 24 })).toBe(24);
    for (const hours of [0, -1, 25, Number.NaN, "2", true]) {
      let err: unknown;
      try {
        parseHours({ hours });
      } catch (e) {
        err = e;
      }
      expect(err, String(hours)).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });

  it("busyView shows the hand switch and the program", () => {
    // the default paths point at the temporary data folder of the test run (tests/setup.ts)
    const now = new Date();
    try {
      expect(busyView(now)).toEqual({ on: false, hand: null, apps: null });
      setBusy({ since: now.toISOString() }, 2, now);
      expect(busyView(now)).toMatchObject({ on: true, hand: { since: now.toISOString() }, apps: null });
      checkBusyApps(["Zoom"], 2, now);
      expect(busyView(now).apps).toMatchObject({ why: "Zoom running" });
      setBusy(undefined, 2, now);
      expect(busyView(now)).toMatchObject({ on: true, hand: null });
    } finally {
      setBusy(undefined, 2, now);
      checkBusyApps([], 2, now);
    }
    expect(busyView(now).on).toBe(false);
  });
});
