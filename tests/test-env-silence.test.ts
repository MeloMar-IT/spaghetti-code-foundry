import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// tools/test-env silence around tools/test-slot, as the test steps run it. The silence limit is 1 s here.
const TOOL = resolve("tools/test-env");
const SLOT = resolve("tools/test-slot");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "test-silence-t-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const envOf = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  TMPDIR: tmpdir(),
  FACTORY_VAR_TEST_SLOTS: "0",
  FACTORY_TEST_NICE: "0",
  FACTORY_TEST_SILENCE_SEC: "1",
  FACTORY_TEST_SILENCE_GRACE_MS: "300",
  FACTORY_TEST_SLOT_TRACK_MS: "100",
  ...extra,
});
const args = (cmd: string) => [TOOL, "silence", SLOT, join(tmp, "slots"), "sh", "-c", cmd];

/** Like the flows: stdout and stderr go to one file. */
function toFile(cmd: string, extra: Record<string, string> = {}) {
  const log = join(tmp, "tests.log");
  const fd = openSync(log, "w");
  try {
    const r = spawnSync(process.execPath, args(cmd), { cwd: tmp, env: envOf(extra), stdio: ["ignore", fd, fd], timeout: 30_000 });
    return { status: r.status, out: readFileSync(log, "utf8") };
  } finally {
    closeSync(fd);
  }
}
const runs = () => readFileSync(join(tmp, "runs"), "utf8").trim().split("\n").length;
const lastLine = (out: string) => out.trimEnd().split("\n").at(-1);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("test-env silence", () => {
  it("stops a silent command and runs it once more", () => {
    const r = toFile('echo x >> runs; echo start; if [ ! -f again ]; then touch again; sleep 60; fi; echo done');
    expect(r.status).toBe(0);
    expect(r.out).toContain("run once more");
    expect(lastLine(r.out)).toBe("done");
    expect(runs()).toBe(2);
  });

  it("fails after a second hang, with a last line that says so", () => {
    const r = toFile("echo x >> runs; sleep 60");
    expect(r.status).toBe(125);
    expect(lastLine(r.out)).toBe("test-silence: stopped — no output for 20 min, twice");
    expect(runs()).toBe(2);
  });

  it("ends every process of the first run, also one that ignores SIGTERM, before the second starts", () => {
    // the second run notes whether the first one's stubborn child is still there
    const r = toFile(
      'if [ ! -f first.pid ]; then sh -c \'trap "" TERM; echo $$ > first.pid; while :; do sleep 0.1; done\' & wait; ' +
        'else if kill -0 "$(cat first.pid)" 2>/dev/null; then echo STILL-ALIVE; else echo GONE; fi; fi',
    );
    expect(r.out).toContain("GONE");
    expect(r.out).not.toContain("STILL-ALIVE");
    expect(r.status).toBe(0);
    expect(alive(Number(readFileSync(join(tmp, "first.pid"), "utf8")))).toBe(false);
  });

  it("does not retry again when the second run fails after a hang", () => {
    const r = toFile("echo x >> runs; if [ ! -f again ]; then touch again; sleep 60; fi; exit 3");
    expect(r.status).toBe(3);
    expect(r.out).toContain("test-silence: no output");
    expect(runs()).toBe(2);
  });

  it("does not stop a command with steady output, and passes the exit code through", () => {
    const r = toFile("echo x >> runs; for i in 1 2 3 4 5 6; do echo $i; sleep 0.3; done; exit 3");
    expect(r.status).toBe(3);
    expect(r.out).not.toContain("test-silence");
    expect(runs()).toBe(1);
  });

  it("works when the output is a pipe", () => {
    const r = spawnSync(process.execPath, args("echo out; echo err >&2"), { cwd: tmp, env: envOf({}), encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("does not count a wait for a test slot as silence", () => {
    mkdirSync(join(tmp, "waits"));
    const r = toFile('touch waits/1-1.wait; sleep 2; mv waits/1-1.wait waits/1-1.done; echo done', { FACTORY_TEST_SLOT_WAIT_DIR: join(tmp, "waits") });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("test-silence");
  });

  it("is off with 0 minutes, and hides the engine's stop file from the tests", () => {
    const r = toFile('sleep 1.5; echo "stop=[$FACTORY_ENV_STOP_FILE] pgid=[$FACTORY_TEST_SLOT_PGID_FILE]"', { FACTORY_VAR_TEST_SILENCE_MINUTES: "0", FACTORY_ENV_STOP_FILE: join(tmp, "x") });
    expect(r.status).toBe(0);
    expect(r.out).toContain("stop=[] pgid=[]");
    expect(r.out).not.toContain("test-silence");
  });

  it("uses 20 minutes for a value out of range, and says so", () => {
    expect(toFile("true", { FACTORY_VAR_TEST_SILENCE_MINUTES: "9999" }).out).toContain("using 20");
  });

  it("a cancel ends every process and starts no second run", async () => {
    const child = spawn(process.execPath, args('echo x >> runs; sh -c \'trap "" TERM; echo $$ > stubborn.pid; while :; do sleep 0.1; done\' & wait'), {
      cwd: tmp,
      env: envOf({ FACTORY_TEST_SILENCE_SEC: "600" }),
      stdio: "ignore",
    });
    const ended = new Promise((done) => child.on("exit", done));
    const pidFile = join(tmp, "stubborn.pid");
    await new Promise<void>((done) => {
      const ready = () => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n");
      const w = watch(tmp, () => ready() && (w.close(), done()));
      if (ready()) (w.close(), done());
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    await ended;
    expect(alive(pid)).toBe(false);
    expect(runs()).toBe(1);
  }, 20_000);
});
