import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyRedactor } from "../src/credentials/redact.js";
import { runProcess, type ProcessMeter } from "../src/steps/process.js";

// A switchable log stream: when `failingLog` is set, the log is a stream whose first write fails (only after output was received).
const mocked = vi.hoisted(() => ({ failingLog: undefined as (() => unknown) | undefined }));
vi.mock("node:fs", async (orig) => {
  const real = (await orig()) as typeof import("node:fs");
  return { ...real, createWriteStream: (...a: Parameters<typeof real.createWriteStream>) => (mocked.failingLog ? mocked.failingLog() : real.createWriteStream(...a)) };
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "process-log-"));
});
afterEach(() => {
  mocked.failingLog = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

const run = (script: string, logFile: string, extra: { meter?: ProcessMeter; timeoutMs?: number } = {}) =>
  runProcess(process.execPath, ["-e", script], { cwd: tmp, logFile, redactor: emptyRedactor, ...extra });

describe("the log file of a process", () => {
  it("holds the output of a process that ran", async () => {
    const log = join(tmp, "l.log");
    const r = await run('console.log("hello")', log);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("hello\n");
  });

  it("fails the step, and stops the process, when the log cannot be written", async () => {
    const started = Date.now();
    await expect(run("setTimeout(() => {}, 30000)", join(tmp, "missing-folder", "l.log"))).rejects.toThrow(/could not write the log file/);
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe("the meter of a process", () => {
  it("is filled by a normal run: the time and the bytes printed", async () => {
    const meter: ProcessMeter = {};
    await run('console.log("hello")', join(tmp, "l.log"), { meter });
    expect(typeof meter.ms).toBe("number");
    expect(meter.printedBytes).toBe(6);
  });

  it("counts a timed-out process", async () => {
    const meter: ProcessMeter = {};
    const r = await run("setTimeout(() => {}, 5000)", join(tmp, "l.log"), { meter, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(meter.ms).toBeGreaterThanOrEqual(100);
  });

  it("holds what was printed when the log cannot be written", async () => {
    mocked.failingLog = () =>
      new Writable({
        write(_chunk, _enc, cb) {
          cb(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
        },
      });
    const meter: ProcessMeter = {};
    await expect(run('process.stdout.write("x".repeat(1000)); setTimeout(() => {}, 30000)', join(tmp, "l.log"), { meter })).rejects.toThrow(/could not write the log file \(ENOSPC\)/);
    expect(meter.printedBytes).toBe(1000);
    expect(typeof meter.ms).toBe("number");
  });

  it("replaces stale values when the program is not there", async () => {
    const meter: ProcessMeter = { ms: 99999, printedBytes: 99999 };
    await expect(runProcess(join(tmp, "no-such-program"), [], { cwd: tmp, logFile: join(tmp, "l.log"), redactor: emptyRedactor, meter })).rejects.toThrow(/failed to start/);
    expect(meter.printedBytes).toBe(0);
    expect(meter.ms).toBeLessThan(99999);
  });
});
