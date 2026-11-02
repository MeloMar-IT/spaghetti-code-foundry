import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// The pause of tools/test-slot: with a fresh <slots>/pause every command except the one of slot-1 is stopped (SIGSTOP on its group).
const tool = resolve("tools/test-slot");

describe("tools/test-slot pause", () => {
  const procTree = resolve("dist/steps/proc-tree.js");
  beforeAll(() => {
    if (!existsSync(procTree)) throw new Error("dist/steps/proc-tree.js is missing — run `npm run build` first");
  });

  const roots: string[] = [];
  const pids: number[] = [];
  const children: ChildProcess[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "tsp-"));
    roots.push(d);
    return d;
  };
  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    for (const p of pids.splice(0)) {
      try {
        process.kill(-p, "SIGCONT");
        process.kill(-p, "SIGKILL");
      } catch { /* gone */ }
    }
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const until = async (ready: () => boolean, what: string) => {
    for (let i = 0; i < 600 && !ready(); i++) await new Promise((r) => setTimeout(r, 25));
    if (!ready()) throw new Error(`timed out waiting for: ${what}`);
  };
  const stat = (pid: number) => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const stopped = (pid: number) => stat(pid).startsWith("T");
  const running = (pid: number) => {
    const s = stat(pid);
    return s !== "" && !s.startsWith("T");
  };
  const readPid = (file: string) => {
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      return n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  /** A command that writes its pid, then works (short sleeps, so a stop shows) until `<w>/<name>.go` exists. */
  function launch(slots: string, w: string, name: string, extra: Record<string, string> = {}, script?: string) {
    const body = script ?? `while [ ! -e "${w}/${name}.go" ]; do sleep 0.05; done`;
    const c = spawn(tool, [slots, "sh", "-c", `echo $$ > "${w}/${name}.pid"; ${body}`], {
      env: { ...process.env, FACTORY_TEST_SLOT_POLL_MS: "50", FACTORY_TEST_NICE: "0", FACTORY_VAR_TEST_SLOTS: "2", ...extra },
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(c);
    let out = "";
    c.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
    const exited = new Promise<number | null>((r) => c.on("exit", (code) => r(code)));
    return { c, exited, out: () => out, pidFile: join(w, `${name}.pid`), go: () => writeFileSync(join(w, `${name}.go`), "") };
  }
  const pauseFile = (slots: string) => join(slots, "pause");
  const freshPause = (slots: string) => writeFileSync(pauseFile(slots), `${new Date().toISOString()}\n`);

  /** Two runs: `a` holds slot-1, `b` holds slot-2. */
  async function two(extraB: Record<string, string> = {}) {
    const slots = tmp();
    const w = tmp();
    const a = launch(slots, w, "a");
    await until(() => readPid(a.pidFile) > 0, "a started");
    const b = launch(slots, w, "b", extraB);
    await until(() => readPid(b.pidFile) > 0, "b started");
    pids.push(readPid(a.pidFile), readPid(b.pidFile));
    return { slots, w, a, b, pa: readPid(a.pidFile), pb: readPid(b.pidFile) };
  }

  it("stops every command except the one of slot-1, and lets it go on when the file is removed", async () => {
    const waits = tmp();
    const { slots, a, b, pa, pb } = await two({ FACTORY_TEST_SLOT_WAIT_DIR: waits });
    const agent = spawn("sleep", ["30"]); // a process outside test-slot is never signalled
    children.push(agent);
    freshPause(slots);
    await until(() => stopped(pb), "b stopped");
    expect(running(pa)).toBe(true);
    expect(running(agent.pid!)).toBe(true);
    expect(readdirSync(waits).filter((f) => /^\d+-\d+-pause\.wait$/.test(f))).toHaveLength(1);
    await until(() => b.out().includes("test-slot: paused"), "the pause line"); // the pipe is read a moment after the stop
    rmSync(pauseFile(slots));
    await until(() => running(pb), "b going on");
    await until(() => readdirSync(waits).some((f) => f.endsWith("-pause.done")), "pause record closed");
    expect(readdirSync(waits).some((f) => f.endsWith("-pause.wait"))).toBe(false);
    a.go();
    b.go();
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    expect(b.out()).toMatch(/test-slot: going on after \d+ s paused/);
  });

  it("a paused run takes slot-1 when the first run ends, goes on, and frees slot-2", async () => {
    const { slots, a, b, pb } = await two();
    freshPause(slots);
    await until(() => stopped(pb), "b stopped");
    a.go();
    expect(await a.exited).toBe(0);
    await until(() => running(pb), "b going on with slot-1");
    expect(existsSync(join(slots, "slot-2"))).toBe(false);
    expect(readFileSync(join(slots, "slot-1", "pid"), "utf8")).toBe(String(b.c.pid));
    expect(existsSync(pauseFile(slots))).toBe(true); // the pause itself still holds
    b.go();
    expect(await b.exited).toBe(0);
  });

  it("a pause file older than 4 minutes pauses nothing, and a paused run goes on when its file gets old", async () => {
    const { slots, a, b, pb } = await two();
    const old = new Date(Date.now() - 5 * 60_000);
    writeFileSync(pauseFile(slots), "x\n");
    utimesSync(pauseFile(slots), old, old);
    // a second look at the file is an event: the file is made fresh, then old again
    freshPause(slots);
    await until(() => stopped(pb), "b stopped");
    utimesSync(pauseFile(slots), old, old);
    await until(() => running(pb), "b going on");
    a.go();
    b.go();
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
  });

  it("a stale pause file at the start pauses nothing", async () => {
    const slots = tmp();
    const w = tmp();
    const old = new Date(Date.now() - 5 * 60_000);
    writeFileSync(pauseFile(slots), "x\n");
    utimesSync(pauseFile(slots), old, old);
    const a = launch(slots, w, "a", {}, "true");
    const b = launch(slots, w, "b", {}, "true");
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    expect(a.out() + b.out()).not.toContain("paused");
  });

  it("with no limit on test runs (0) nothing is paused", async () => {
    const slots = tmp();
    const w = tmp();
    freshPause(slots);
    const a = launch(slots, w, "a", { FACTORY_VAR_TEST_SLOTS: "0" }, "true");
    expect(await a.exited).toBe(0);
    expect(a.out()).not.toContain("paused");
  });

  it("time paused counts against no limit: the run exits with its own code and the started file moves forward", async () => {
    const slots = tmp();
    const w = tmp();
    const startedFile = join(w, "started");
    const a = launch(slots, w, "a");
    await until(() => readPid(a.pidFile) > 0, "a started");
    // b works well under a second, with a limit of 2 s, and is paused for longer than that
    const b = launch(slots, w, "b", { FACTORY_TEST_SLOT_LIMIT_SEC: "2", FACTORY_TEST_SLOT_STARTED_FILE: startedFile }, "n=0; while [ $n -lt 4 ]; do sleep 0.1; n=$((n+1)); done");
    await until(() => readPid(b.pidFile) > 0, "b started");
    pids.push(readPid(a.pidFile), readPid(b.pidFile));
    const first = readPid(startedFile);
    freshPause(slots);
    await until(() => stopped(readPid(b.pidFile)), "b stopped");
    const from = Date.now();
    await until(() => Date.now() - from > 2500, "2.5 s paused");
    rmSync(pauseFile(slots));
    const code = await b.exited;
    expect({ code, out: b.out() }).toEqual({ code: 0, out: expect.stringContaining("going on after") });
    expect(readPid(startedFile) - first).toBeGreaterThanOrEqual(2);
    a.go();
    expect(await a.exited).toBe(0);
  });

  it("SIGTERM to a paused test-slot ends the whole group at once", async () => {
    const slots = tmp();
    const w = tmp();
    const a = launch(slots, w, "a");
    await until(() => readPid(a.pidFile) > 0, "a started");
    const b = launch(slots, w, "b", {}, "exec sleep 60");
    await until(() => readPid(b.pidFile) > 0, "b started");
    const pb = readPid(b.pidFile);
    pids.push(readPid(a.pidFile), pb);
    freshPause(slots);
    await until(() => stopped(pb), "b stopped");
    const began = Date.now();
    b.c.kill("SIGTERM");
    await b.exited;
    expect(Date.now() - began).toBeLessThan(2500);
    await until(() => gone(pb), "the command is gone");
    expect(() => process.kill(-pb, 0)).toThrow();
    a.go();
    await a.exited;
  });

  it("a command that stops itself is still ended at the time limit, before the SIGKILL", async () => {
    const slots = tmp();
    const w = tmp();
    const a = launch(slots, w, "a", { FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_SLOT_LIMIT_SEC: "1" }, "kill -STOP $$");
    const began = Date.now();
    expect(await a.exited).toBe(124);
    expect(Date.now() - began).toBeLessThan(4500);
    expect(a.out()).toMatch(/^test-slot: stopped after \d+ s — the time limit is 1 s$/m);
    expect(gone(readPid(a.pidFile))).toBe(true);
  });
});
