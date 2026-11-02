import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, type ProcessMeter } from "../src/steps/process.js";
import { runShell } from "../src/steps/shell.js";

/** A step folder with an empty folder for its wait files. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pw-"));
  const waits = join(dir, "waits");
  mkdirSync(waits);
  return { dir, waits, log: join(dir, "step.log") };
}

/** Keeps a wait file fresh the way test-slot does, until stopped. */
function heartbeat(file: string): () => void {
  const touch = () => {
    const now = Date.now() / 1000;
    utimesSync(file, now, now);
  };
  writeFileSync(file, "");
  touch();
  const t = setInterval(touch, 50);
  return () => clearInterval(t);
}

describe("runProcess with recorded slot waits", () => {
  it("outlives its limit while a wait is recorded, and reports and logs the wait", async () => {
    const s = setup();
    const stop = heartbeat(join(s.waits, `${Date.now()}-1.wait`));
    const meter: ProcessMeter = {};
    try {
      const r = await runShell({ command: "sleep 0.6", cwd: s.dir, env: {}, logFile: s.log, timeoutMs: 200, slotWaits: { dir: s.waits, maxExtraMs: 60_000 }, meter });
      expect(r.ok).toBe(true);
      expect(r.slotWaitMs).toBeGreaterThan(300);
      expect(meter.slotWaitMs).toBeGreaterThan(300);
    } finally {
      stop();
    }
    expect(readFileSync(s.log, "utf8")).toMatch(/waited \d+ s for a test slot/);
  });

  it("is stopped at the bound when the wait never ends, and says so", async () => {
    const s = setup();
    const stop = heartbeat(join(s.waits, `${Date.now()}-1.wait`));
    const began = Date.now();
    try {
      const r = await runShell({ command: "sleep 60", cwd: s.dir, env: {}, logFile: s.log, timeoutMs: 200, slotWaits: { dir: s.waits, maxExtraMs: 1500 } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^timed out \(waited \d+ s for a test slot, more than the 2 s that can be left out\)$/);
      expect(Date.now() - began).toBeLessThan(8000);
    } finally {
      stop();
    }
  });

  it("times out as before when nothing was recorded: the error stays exactly `timed out`", async () => {
    const s = setup();
    const r = await runShell({ command: "sleep 60", cwd: s.dir, env: {}, logFile: s.log, timeoutMs: 200, slotWaits: { dir: s.waits, maxExtraMs: 60_000 } });
    expect(r.error).toBe("timed out");
    expect(r.slotWaitMs).toBeUndefined();
    expect(readFileSync(s.log, "utf8")).not.toContain("for a test slot");
  });

  it("outlives its limit while a pause is recorded, and logs the pause but no wait for a slot", async () => {
    const s = setup();
    const stop = heartbeat(join(s.waits, `${Date.now()}-1-pause.wait`));
    const meter: ProcessMeter = {};
    try {
      const r = await runShell({ command: "sleep 0.6", cwd: s.dir, env: {}, logFile: s.log, timeoutMs: 200, slotWaits: { dir: s.waits, maxExtraMs: 60_000 }, meter });
      expect(r.ok).toBe(true);
      expect(meter.slotWaitMs).toBeGreaterThan(300);
    } finally {
      stop();
    }
    const log = readFileSync(s.log, "utf8");
    expect(log).toMatch(/paused \d+ s while the machine was overloaded/);
    expect(log).not.toContain("for a test slot");
  });

  it("a time-out after a pause says so in the error", async () => {
    const s = setup();
    const stop = heartbeat(join(s.waits, `${Date.now()}-1-pause.wait`));
    try {
      const r = await runShell({ command: "sleep 60", cwd: s.dir, env: {}, logFile: s.log, timeoutMs: 200, slotWaits: { dir: s.waits, maxExtraMs: 1500 } });
      expect(r.error).toMatch(/^timed out \(paused \d+ s while the machine was overloaded, more than the 2 s that can be left out\)$/);
    } finally {
      stop();
    }
  });

  it("ends a group that stopped itself at the time limit, before the SIGKILL", async () => {
    const s = setup();
    const began = Date.now();
    const res = await runProcess("/bin/sh", ["-c", "kill -STOP $$"], { cwd: s.dir, logFile: s.log, groupKill: true, timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - began).toBeLessThan(4000);
  });

  it("ends a stopped group on abort, before the SIGKILL", async () => {
    const s = setup();
    const stop = new AbortController();
    const began = Date.now();
    const running = runProcess("/bin/sh", ["-c", "kill -STOP $$"], { cwd: s.dir, logFile: s.log, groupKill: true, signal: stop.signal });
    setTimeout(() => stop.abort(), 300).unref();
    const res = await running;
    expect(res.aborted).toBe(true);
    expect(Date.now() - began).toBeLessThan(4000);
  });

  it("a missing folder never throws", async () => {
    const s = setup();
    const res = await runProcess("sleep", ["60"], { cwd: s.dir, logFile: s.log, groupKill: true, timeoutMs: 200, slotWaits: { dir: join(s.dir, "missing"), maxExtraMs: 1000 } });
    expect(res.timedOut).toBe(true);
    expect(res.slotWait).toBeUndefined();
  });
});
