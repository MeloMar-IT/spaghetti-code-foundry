import { afterEach, describe, expect, it, vi } from "vitest";
import { anyPidAlive, descendants, formatRows, parsePs, ProcessTracker, processTable, processTableAsync, signalRows, type ProcRow } from "../src/steps/proc-tree.js";

const S = "Tue Oct 27 04:26:28 2026";
const S2 = "Tue Oct 27 05:00:00 2026";
const row = (pid: number, ppid: number, start = S): ProcRow => ({ pid, ppid, start });

afterEach(() => vi.restoreAllMocks());

describe("parsePs", () => {
  it("reads macOS and Linux lines", () => {
    expect(parsePs("  501     1 Tue Oct 27 04:26:28 2026\n12 3 Tue Oct  7 04:26:28 2026\n")).toEqual([row(501, 1), row(12, 3, "Tue Oct 7 04:26:28 2026")]);
  });
  it("skips lines that do not fit", () => {
    const text = ["", "abc def", "  PID  PPID STARTED", "42 1", "0 1 Tue Oct 27 04:26:28 2026", "5 1 Tue Oct 99 nonsense 2026", "7 1 Tue Oct 27 04:26:28 2026"].join("\n");
    expect(parsePs(text)).toEqual([row(7, 1)]);
  });
  it("round trips with formatRows", () => {
    const rows = [row(1, 0), row(20, 1, "Wed Jan 7 01:02:03 2026"), row(300, 20)];
    expect(parsePs(formatRows(rows))).toEqual(rows);
  });
});

describe("descendants", () => {
  it("returns only the subtree, without the root", () => {
    const rows = [row(10, 1), row(11, 10), row(12, 10), row(13, 11), row(20, 1), row(21, 20)];
    expect(descendants(rows, 10).map((r) => r.pid).sort()).toEqual([11, 12, 13]);
  });
  it("ends on a cycle and on an unknown root", () => {
    const rows = [row(2, 3), row(3, 2)];
    expect(descendants(rows, 2).map((r) => r.pid)).toEqual([3]);
    expect(descendants(rows, 99)).toEqual([]);
  });
});

describe("signalRows", () => {
  it("never signals pid ≤ 1, this process, a changed start or a missing pid", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const table = [row(0, 0), row(1, 0), row(process.pid, 1), row(300, 1, S2)];
    const n = signalRows([row(0, 0), row(1, 0), row(process.pid, 1), row(300, 1), row(400, 1)], "SIGTERM", table);
    expect(n).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
  it("signals a row with an unchanged start", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalRows([row(300, 1)], "SIGTERM", [row(300, 1)])).toBe(1);
    expect(kill.mock.calls).toEqual([[300, "SIGTERM"]]);
  });
  it("ignores a process that is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(signalRows([row(300, 1)], "SIGKILL", [row(300, 1)])).toBe(0);
  });
  it("signals nothing when no table can be read", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.stubEnv("FACTORY_TEST_SLOT_PS", "/usr/bin/false");
    expect(signalRows([row(300, 1)], "SIGTERM")).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("anyPidAlive", () => {
  it("skips this process and an empty list", () => {
    expect(anyPidAlive([row(process.pid, 1)])).toBe(false);
    expect(anyPidAlive([])).toBe(false);
  });
});

describe("ProcessTracker", () => {
  const make = (tables: Array<ProcRow[] | undefined>, remembered?: ProcRow[]) => {
    let i = 0;
    const next = () => tables[Math.min(i++, tables.length - 1)];
    return new ProcessTracker(100, { remembered, table: next, tableAsync: async () => next() });
  };

  it("keeps an orphan it saw earlier, with its current parent", async () => {
    const t = make([[row(100, 1), row(200, 100), row(300, 200)], [row(100, 1), row(300, 1)]]);
    await t.poll();
    expect(t.remembered().map((r) => r.pid).sort()).toEqual([200, 300]);
    const stop = t.toStop();
    expect(stop).toEqual([row(300, 1)]);
  });

  it("skips the same pid with another start time", async () => {
    const t = make([[row(100, 1), row(300, 100)], [row(100, 1), row(300, 1, S2)]]);
    await t.poll();
    expect(t.toStop()).toEqual([]);
  });

  it("drops rows that are gone", async () => {
    const t = make([[row(100, 1), row(300, 100)], [row(100, 1)]]);
    await t.poll();
    await t.poll();
    expect(t.remembered()).toEqual([]);
  });

  it("includes remembered rows and their children, only with an unchanged start", () => {
    const table = [row(100, 1), row(500, 1), row(600, 500)];
    expect(
      make([table], [row(500, 1)])
        .toStop()
        .map((r) => r.pid)
        .sort(),
    ).toEqual([500, 600]);
    expect(make([table], [row(500, 1, S2)]).toStop()).toEqual([]);
  });

  it("returns the rows remembered so far when the table cannot be read, and recovers on the next read", async () => {
    const t = make([[row(100, 1), row(200, 100)], undefined, [row(100, 1), row(200, 100)]]);
    await t.poll();
    expect(t.toStop().map((r) => r.pid)).toEqual([200]); // stop-time read fails
    expect(t.toStop().map((r) => r.pid)).toEqual([200]); // read works again
  });

  it("returns nothing without a table and nothing remembered", () => {
    expect(make([undefined]).toStop()).toEqual([]);
  });

  it("does not adopt the children of a new process that got the root's pid", async () => {
    const t = make([
      [row(100, 1), row(200, 100)],
      [row(100, 1, S2), row(700, 100, S2)], // pid 100 now is another process
    ]);
    await t.poll();
    expect(t.toStop().map((r) => r.pid)).toEqual([]);
  });

  it("does not adopt children once the root is gone", async () => {
    const t = make([[row(100, 1), row(200, 100)], [row(200, 1)], [row(200, 1), row(100, 1), row(800, 100)]]);
    await t.poll();
    await t.poll();
    expect(t.toStop().map((r) => r.pid)).toEqual([200]);
  });

  it("polls on a timer until stopped, and ignores a poll that ends after stop()", async () => {
    let release!: (v: ProcRow[]) => void;
    let called!: () => void;
    const was = new Promise<void>((r) => (called = r));
    const t = new ProcessTracker(100, {
      everyMs: 5,
      tableAsync: () => {
        called();
        return new Promise<ProcRow[]>((r) => (release = r));
      },
    });
    t.start();
    t.start();
    await was;
    t.stop();
    release([row(100, 1), row(300, 100)]);
    await new Promise((r) => setImmediate(r));
    expect(t.remembered()).toEqual([]);
  });
});

describe("the real ps", () => {
  it("lists this process", () => {
    const rows = processTable();
    expect(rows?.find((r) => r.pid === process.pid)?.ppid).toBe(process.ppid);
  });
  it("gives undefined when ps fails", async () => {
    vi.stubEnv("FACTORY_TEST_SLOT_PS", "/usr/bin/false");
    try {
      expect(processTable()).toBeUndefined();
      expect(await processTableAsync()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
