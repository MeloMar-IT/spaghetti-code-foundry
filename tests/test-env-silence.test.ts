import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error a tool without types
import { ignoreClosedPipe, watchParent } from "../tools/test-silence.mjs";
import { Watched } from "./helpers/stray-procs.js";
import { stubbornShell } from "./helpers/stray-tag.js";

// tools/test-env silence around tools/test-slot, as the test steps run it. The silence limit is 1 s here.
const TOOL = resolve("tools/test-env");
const SLOT = resolve("tools/test-slot");

let tmp: string;
let watched: Watched;
/** The wrappers and callers a test spawned; whatever of them still runs afterwards is killed. */
let spawned: ChildProcess[];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "test-silence-t-"));
  watched = new Watched();
  spawned = [];
  for (const name of ["first.pid", "stubborn.pid", "wrapper.pid"]) watched.file(join(tmp, name));
});
afterEach(() => {
  watched.kill(); // before the folder goes: it reads the pid files
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

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
/** Waits until `ready()` holds, with a deadline. */
const until = async (ready: () => boolean, what: string, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const pidIn = async (name: string) => {
  const file = join(tmp, name);
  await until(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"), name);
  return Number(readFileSync(file, "utf8"));
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
      `if [ ! -f first.pid ]; then ${stubbornShell(join(tmp, "first.pid"))} & wait; ` +
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
    const child = spawn(process.execPath, args(`echo x >> runs; ${stubbornShell(join(tmp, "stubborn.pid"))} & wait`), {
      cwd: tmp,
      env: envOf({ FACTORY_TEST_SILENCE_SEC: "600" }),
      stdio: "ignore",
    });
    spawned.push(child);
    const ended = new Promise((done) => child.on("exit", done));
    const pid = await pidIn("stubborn.pid");
    child.kill("SIGTERM");
    await ended;
    expect(alive(pid)).toBe(false);
    expect(runs()).toBe(1);
  }, 20_000);

  /** A caller (a shell) that starts the wrapper around `cmd`, notes its pid and waits. `to` is the wrapper's redirect. */
  function caller(cmd: string, to: string, stdio: "ignore" | "pipe") {
    const sh = spawn("sh", ["-c", `"$NODE" "$TOOL" silence "$SLOT" "$SLOTS" sh -c "$CMD" ${to} & echo $! > wrapper.pid; wait`], {
      cwd: tmp,
      env: envOf({ FACTORY_TEST_SILENCE_SEC: "600", NODE: process.execPath, TOOL, SLOT, SLOTS: join(tmp, "slots"), CMD: cmd }),
      stdio: ["ignore", stdio, stdio],
      detached: true,
    });
    spawned.push(sh);
    watched.group(sh.pid!);
    return sh;
  }
  /** SIGKILLs the caller once the command is up, then waits for the wrapper and the stubborn child to be gone. */
  async function killCaller(sh: ChildProcess) {
    const stubborn = await pidIn("stubborn.pid");
    const wrapper = await pidIn("wrapper.pid");
    const ended = new Promise((done) => sh.on("exit", done));
    sh.kill("SIGKILL");
    await ended;
    sh.stdout?.destroy();
    sh.stderr?.destroy();
    await until(() => !alive(stubborn) && !alive(wrapper), "the wrapper and its command to end");
    expect(runs()).toBe(1);
  }

  it("a wrapper whose caller is killed with SIGKILL ends its command and exits", async () => {
    const sh = caller(`echo x >> runs; ${stubbornShell(join(tmp, "stubborn.pid"))} & wait`, "> tests.log 2>&1", "ignore");
    await killCaller(sh);
    expect(readFileSync(join(tmp, "tests.log"), "utf8")).not.toContain("run once more");
  }, 30_000);

  it("does so too when its output was a pipe that is now closed", async () => {
    const ticks = 'end=$(( $(date +%s) + 120 )); while [ "$(date +%s)" -lt "$end" ]; do echo tick; echo tock >&2; sleep 0.1; done';
    // the ticks ignore SIGTERM too: they go on writing into the closed pipe until the SIGKILL
    const sh = caller(`echo x >> runs; (trap "" TERM; ${ticks}) & ${stubbornShell(join(tmp, "stubborn.pid"))} & wait`, "", "pipe");
    let out = "";
    sh.stdout!.on("data", (d) => (out += String(d)));
    sh.stderr!.resume();
    await until(() => out.includes("tick"), "output through the pipe");
    await killCaller(sh);
  }, 30_000);
});

describe("watchParent", () => {
  afterEach(() => vi.useRealTimers());

  it("calls gone once when the parent pid changes", () => {
    vi.useFakeTimers();
    let parent = process.ppid;
    const gone = vi.fn();
    watchParent(gone, 10, () => parent);
    vi.advanceTimersByTime(50);
    expect(gone).not.toHaveBeenCalled();
    parent = 1;
    vi.advanceTimersByTime(50);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("calls gone when the first parent is no more, also while the parent pid reads the same", () => {
    vi.useFakeTimers();
    const ended = spawnSync("true").pid!;
    const gone = vi.fn();
    watchParent(gone, 10, () => ended);
    vi.advanceTimersByTime(50);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("a process under pid 1 from the start has lost its parent: gone is called at once, with no timer", () => {
    vi.useFakeTimers();
    const gone = vi.fn();
    watchParent(gone, 10, () => 1);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls nothing after it is stopped", () => {
    vi.useFakeTimers();
    let parent = process.ppid;
    const gone = vi.fn();
    watchParent(gone, 10, () => parent)();
    parent = 1;
    vi.advanceTimersByTime(50);
    expect(gone).not.toHaveBeenCalled();
  });

  it("only a closed pipe is ignored on the outputs; any other error is thrown", () => {
    for (const code of ["EPIPE", "ERR_STREAM_DESTROYED"]) expect(() => ignoreClosedPipe(Object.assign(new Error("x"), { code }))).not.toThrow();
    expect(() => ignoreClosedPipe(Object.assign(new Error("disk full"), { code: "ENOSPC" }))).toThrow("disk full");
  });
});
