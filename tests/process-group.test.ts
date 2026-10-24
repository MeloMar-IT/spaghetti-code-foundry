import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
