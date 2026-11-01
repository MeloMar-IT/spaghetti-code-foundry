import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRedactor } from "../src/credentials/redact.js";
import { killLiveGroups, runProcess } from "../src/steps/process.js";

const dead = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Waits until the file has at least `lines` lines (a counter written by a test helper). */
const untilPath = async (f: string, lines: number) => {
  const end = Date.now() + 10_000;
  for (;;) {
    try {
      if (readFileSync(f, "utf8").split("\n").filter(Boolean).length >= lines) return;
    } catch {
      // not there yet
    }
    if (Date.now() > end) throw new Error(`${f} did not reach ${lines} lines`);
    await sleep(20);
  }
};
const untilFile = async (f: string) => {
  const end = Date.now() + 10_000;
  for (;;) {
    try {
      const n = Number(readFileSync(f, "utf8").trim());
      if (n) return n;
    } catch {
      // not there yet
    }
    if (Date.now() > end) throw new Error("child pid file did not appear");
    await sleep(20);
  }
};

describe("runProcess with groupKill", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "pgroup-"));
    dirs.push(d);
    return d;
  };
  const stubborn = (d: string, tail: string) => `trap "" TERM; echo $$ > ${join(d, "child.pid")}; sleep 60 >/dev/null 2>&1 & ${tail}`;

  it("an abort stops the whole group, and the child is dead when the promise settles", async () => {
    const d = dir();
    const ctl = new AbortController();
    const p = runProcess("/bin/sh", ["-c", stubborn(d, "sleep 60")], { cwd: d, logFile: join(d, "log"), groupKill: true, signal: ctl.signal, redactor: makeRedactor([]) });
    const pid = await untilFile(join(d, "child.pid"));
    ctl.abort();
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(dead(pid)).toBe(true);
  }, 20_000);

  it("a timeout stops the whole group too", async () => {
    const d = dir();
    const p = runProcess("/bin/sh", ["-c", stubborn(d, "sleep 60")], { cwd: d, logFile: join(d, "log"), groupKill: true, timeoutMs: 400, redactor: makeRedactor([]) });
    const res = await p;
    expect(res.timedOut).toBe(true);
    expect(dead(await untilFile(join(d, "child.pid")))).toBe(true);
  }, 20_000);

  it("a normal exit leaves a background child running", async () => {
    const d = dir();
    const res = await runProcess("/bin/sh", ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > ${join(d, "bg.pid")}`], { cwd: d, logFile: join(d, "log"), groupKill: true, redactor: makeRedactor([]) });
    expect(res.exitCode).toBe(0);
    const pid = await untilFile(join(d, "bg.pid"));
    expect(dead(pid)).toBe(false);
    process.kill(pid, "SIGKILL");
  });

  // A parent that starts a child in a session of its own (so it leaves the group). The child writes its pid to READY once it is set up.
  const PARENT = `const {spawn}=require("child_process"),fs=require("fs");
const c=spawn("/bin/sh",["-c",process.env.CHILD],{detached:true,stdio:"ignore"});c.unref();
if(process.env.GO){const t=setInterval(()=>{if(fs.existsSync(process.env.GO)){clearInterval(t);process.exit(0)}},20)}else setInterval(()=>{},1000);`;
  const detached = (d: string, trap: boolean, extraEnv: Record<string, string> = {}) => ({
    cwd: d,
    logFile: join(d, "log"),
    groupKill: true,
    trackEveryMs: 50,
    redactor: makeRedactor([]),
    env: { CHILD: `${trap ? 'trap "" TERM; ' : ""}echo $$ > "$READY"; exec sleep 60`, READY: join(d, "ready.pid"), ...extraEnv },
  });
  const spare: number[] = [];
  afterEach(() => {
    for (const p of spare.splice(0)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // gone
      }
    }
  });

  it("a timeout stops a detached child whose parent still runs", async () => {
    const d = dir();
    const p = runProcess(process.execPath, ["-e", PARENT], { ...detached(d, false), timeoutMs: 1500 });
    const pid = await untilFile(join(d, "ready.pid"));
    spare.push(pid);
    const res = await p;
    expect(res.timedOut).toBe(true);
    expect(dead(pid)).toBe(true);
  }, 20_000);

  it("an abort stops a detached child too", async () => {
    const d = dir();
    const ctl = new AbortController();
    const p = runProcess(process.execPath, ["-e", PARENT], { ...detached(d, false), signal: ctl.signal });
    const pid = await untilFile(join(d, "ready.pid"));
    spare.push(pid);
    ctl.abort();
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(dead(pid)).toBe(true);
  }, 20_000);

  it("a normal exit leaves a detached child running", async () => {
    const d = dir();
    const go = join(d, "go");
    const p = runProcess(process.execPath, ["-e", PARENT], detached(d, false, { GO: go }));
    const pid = await untilFile(join(d, "ready.pid"));
    spare.push(pid);
    await sleep(200); // a few polls of the tracker
    writeFileSync(go, "1");
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(dead(pid)).toBe(false);
  }, 20_000);

  it("a detached child that ignores SIGTERM is killed within 6 s of the abort", async () => {
    const d = dir();
    const ctl = new AbortController();
    const p = runProcess(process.execPath, ["-e", PARENT], { ...detached(d, true), signal: ctl.signal });
    const pid = await untilFile(join(d, "ready.pid")); // written after the trap is set
    spare.push(pid);
    const t0 = Date.now();
    ctl.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(dead(pid)).toBe(true);
  }, 20_000);

  it("a child that ignores SIGTERM is still SIGKILLed after a failed process-table read at the stop", async () => {
    const d = dir();
    const fake = join(d, "fake-ps");
    const down = join(d, "down");
    const failed = join(d, "failed");
    const ok = join(d, "ok");
    // a ps that fails while the `down` file exists, and counts its good reads
    writeFileSync(fake, `#!/bin/sh\nif [ -e "${down}" ]; then echo x >> "${failed}"; exit 1; fi\necho x >> "${ok}"\nexec ps "$@"\n`, { mode: 0o755 });
    const prev = process.env.FACTORY_TEST_SLOT_PS;
    process.env.FACTORY_TEST_SLOT_PS = fake;
    try {
      const ctl = new AbortController();
      const p = runProcess(process.execPath, ["-e", PARENT], { ...detached(d, true), signal: ctl.signal });
      const pid = await untilFile(join(d, "ready.pid"));
      spare.push(pid);
      await untilPath(ok, 2); // the tracker has read the table with the child in it
      writeFileSync(down, "");
      const t0 = Date.now();
      ctl.abort();
      await untilPath(failed, 1); // the stop-time read failed
      rmSync(down); // ps works again; the SIGKILL at 5 s must still reach the child
      await p;
      expect(Date.now() - t0).toBeLessThan(6500);
      expect(dead(pid)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_TEST_SLOT_PS;
      else process.env.FACTORY_TEST_SLOT_PS = prev;
    }
  }, 20_000);

  it("killLiveGroups kills the group of a running step", async () => {
    const d = dir();
    const p = runProcess("/bin/sh", ["-c", `echo $$ > ${join(d, "child.pid")}; sleep 60`], { cwd: d, logFile: join(d, "log"), groupKill: true, redactor: makeRedactor([]) });
    const pid = await untilFile(join(d, "child.pid"));
    expect(killLiveGroups()).toBe(1);
    const res = await p;
    expect(res.exitCode).toBeNull();
    expect(dead(pid)).toBe(true);
  });
});

describe("runProcess marks its step", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "pmark-"));
    dirs.push(d);
    mkdirSync(join(d, "logs"));
    return d;
  };

  it("leaves an empty file named by the pid in step-pids while the step runs, and removes it after", async () => {
    const d = dir();
    const res = await runProcess("/bin/sh", ["-c", `echo $$ > ${join(d, "me")}; ls ${join(d, "step-pids")}`], { cwd: d, logFile: join(d, "logs", "001-a.log"), redactor: makeRedactor([]) });
    expect(res.stdout.trim()).toBe(readFileSync(join(d, "me"), "utf8").trim());
    expect(readdirSync(join(d, "step-pids"))).toEqual([]);
  });

  it("marks nothing for a log file outside a logs folder", async () => {
    const d = dir();
    await runProcess("/bin/sh", ["-c", "true"], { cwd: d, logFile: join(d, "log"), redactor: makeRedactor([]) });
    expect(existsSync(join(d, "step-pids"))).toBe(false);
  });

  it("does not fail the step when the mark cannot be made", async () => {
    const d = dir();
    writeFileSync(join(d, "step-pids"), "not a folder");
    const res = await runProcess("/bin/sh", ["-c", "echo hello"], { cwd: d, logFile: join(d, "logs", "001-a.log"), redactor: makeRedactor([]) });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(d, "logs", "001-a.log"), "utf8")).toContain("hello");
  });

  it("leaves no mark when the command cannot start", async () => {
    const d = dir();
    await expect(runProcess("/no/such/program", [], { cwd: d, logFile: join(d, "logs", "001-a.log"), redactor: makeRedactor([]) })).rejects.toThrow();
    expect(existsSync(join(d, "step-pids")) ? readdirSync(join(d, "step-pids")) : []).toEqual([]);
  });
});
