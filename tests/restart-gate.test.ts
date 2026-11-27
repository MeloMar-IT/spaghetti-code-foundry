import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { announceRestart, createRestartGate, GUARD_FILE, INTENT_FILE, INTENT_TTL_MS, readGuard, withdrawRestart, type RestartGateOptions } from "../src/restart-gate.js";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const PUSH = [{ runId: "r1", step: "push_develop" }];

describe("restart guard", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const setup = (over: Partial<RestartGateOptions> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "scf-gate-"));
    dirs.push(dir);
    const t = { clock: NOW, pauses: 0, logs: [] as string[], onPause: () => {} };
    const gate = createRestartGate({
      dir, pid: 4343, uncuttable: () => [], updating: () => false, now: () => t.clock,
      pause: (ms) => {
        t.pauses++;
        t.clock += ms;
        t.onPause();
      },
      log: (m) => t.logs.push(m),
      ...over,
    });
    return { dir, gate, t };
  };

  it("writes the guard with and without protected work", () => {
    const open = setup();
    expect(open.gate.publish()).toBeUndefined();
    expect(readGuard(open.dir)).toEqual({ version: 1, pid: 4343, count: 0, items: [], updating: false });
    const held = setup({ uncuttable: () => PUSH, updating: () => true });
    expect(held.gate.publish()).toBeUndefined();
    expect(readGuard(held.dir)).toEqual({ version: 1, pid: 4343, count: 1, items: PUSH, updating: true });
    expect(held.t.pauses).toBe(0);
  });

  it("waits before protected work until the announcement is withdrawn, also when the guard did not change", () => {
    const { dir, gate, t } = setup({ uncuttable: () => PUSH });
    gate.publish();
    announceRestart(dir, 4343, new Date(NOW));
    t.onPause = () => {
      if (t.pauses === 3) withdrawRestart(dir);
    };
    expect(gate.publish()).toBeUndefined();
    expect(t.pauses).toBe(3);
    // the guard was there before the wait started: the watchdog can see the work
    expect(readGuard(dir)?.count).toBe(1);
  });

  it("goes on when the announcement expires, and when the clock stands still", () => {
    const a = setup({ updating: () => true });
    announceRestart(a.dir, 4343, new Date(NOW));
    a.gate.publish();
    expect(a.t.clock - NOW).toBe(INTENT_TTL_MS);
    let pauses = 0;
    const b = setup({ uncuttable: () => PUSH, pause: () => void pauses++ });
    announceRestart(b.dir, 4343, new Date(NOW));
    b.gate.publish();
    expect(pauses).toBeGreaterThan(0);
    expect(pauses).toBeLessThan(1000);
  });

  it("does not wait without protected work, or for another, old or broken announcement", () => {
    const idle = setup();
    announceRestart(idle.dir, 4343, new Date(NOW));
    idle.gate.publish();
    expect(idle.t.pauses).toBe(0);
    const { dir, gate, t } = setup({ uncuttable: () => PUSH });
    announceRestart(dir, 1111, new Date(NOW));
    gate.publish();
    announceRestart(dir, 4343, new Date(NOW - INTENT_TTL_MS));
    gate.publish();
    writeFileSync(join(dir, INTENT_FILE), "{broken");
    gate.publish();
    expect(t.pauses).toBe(0);
  });

  it("shows unsafe names as unknown, counts every run and lists 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ runId: i === 0 ? "bad id $(x)" : `r${i}`, step: i === 1 ? "s".repeat(201) : "group/push" }));
    const { dir, gate } = setup({ uncuttable: () => many });
    gate.publish();
    const g = readGuard(dir)!;
    expect(g.count).toBe(25);
    expect(g.items).toHaveLength(20);
    expect(g.items[0]).toEqual({ runId: "unknown", step: "group/push" });
    expect(g.items[1]).toEqual({ runId: "r1", step: "unknown" });
  });

  it("removes the guard when the state cannot be read or written, and still waits for an announcement", () => {
    let fail = false;
    const { dir, gate, t } = setup({
      uncuttable: () => {
        if (fail) throw new Error("no queue");
        return [];
      },
    });
    gate.publish();
    fail = true;
    announceRestart(dir, 4343, new Date(NOW));
    expect(gate.publish()).toBeUndefined();
    gate.publish();
    expect(existsSync(join(dir, GUARD_FILE))).toBe(false);
    expect(t.pauses).toBeGreaterThan(0);
    expect(t.logs).toHaveLength(1);

    const write = setup();
    write.gate.publish();
    mkdirSync(join(write.dir, `${GUARD_FILE}.tmp`));
    writeFileSync(join(write.dir, `${GUARD_FILE}.tmp`, "x"), "");
    expect(write.gate.publish()).toBeUndefined();
    expect(existsSync(join(write.dir, GUARD_FILE))).toBe(false);
  });

  it("gives a reason when the guard can be neither written nor removed", () => {
    const { dir, gate } = setup();
    // a folder in its place: it cannot be replaced by a rename, nor removed as a file
    mkdirSync(join(dir, GUARD_FILE));
    writeFileSync(join(dir, GUARD_FILE, "x"), "");
    expect(gate.publish()).toContain("restart guard");
  });

  it("trusts no missing, broken or newer guard", () => {
    const { dir } = setup();
    expect(readGuard(dir)).toBeUndefined();
    for (const text of ["{broken", "null", JSON.stringify({ version: 2, pid: 1, count: 0, items: [], updating: false }), JSON.stringify({ version: 1, pid: 1 })]) {
      writeFileSync(join(dir, GUARD_FILE), text);
      expect(readGuard(dir), text).toBeUndefined();
    }
    announceRestart(dir, 7, new Date(NOW));
    expect(JSON.parse(readFileSync(join(dir, INTENT_FILE), "utf8"))).toEqual({ target: 7, at: new Date(NOW).toISOString() });
    expect(() => announceRestart(join(dir, "no", "such"), 7, new Date(NOW))).toThrow();
  });
});
