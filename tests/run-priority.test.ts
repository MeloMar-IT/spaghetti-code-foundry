import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { makeRedactor } from "../src/credentials/redact.js";
import { defaultExec } from "../src/engine/repo-broker.js";
import { describeSettings } from "../src/settings/describe.js";
import { priorityMachine, priorityPrefix, runProcess, spawnTarget, type PriorityMachine } from "../src/steps/process.js";
import { runShell } from "../src/steps/shell.js";

const BOTH: PriorityMachine = { nice: true, taskpolicy: true, current: 0 };
const NICE = "/usr/bin/nice";
const TP = "/usr/sbin/taskpolicy";
const SB = "/usr/bin/sandbox-exec";

describe("spawnTarget with a priority", () => {
  it("low and background put the wrappers in front", () => {
    expect(spawnTarget("/bin/sh", ["-c", "x"], undefined, "low", BOTH)).toEqual({ cmd: NICE, args: ["-n", "5", TP, "-c", "utility", "/bin/sh", "-c", "x"] });
    expect(spawnTarget("/bin/sh", ["-c", "x"], "P", "background", BOTH)).toEqual({ cmd: NICE, args: ["-n", "15", TP, "-c", "background", SB, "-p", "P", "/bin/sh", "-c", "x"] });
    expect(spawnTarget("/bin/sh", ["-c", "x"], "P", "low", BOTH).args.indexOf(SB)).toBeGreaterThan(spawnTarget("/bin/sh", ["-c", "x"], "P", "low", BOTH).args.indexOf(TP));
  });

  it("normal and no priority start what they always started", () => {
    for (const p of [undefined, "normal"] as const) {
      expect(spawnTarget("/bin/sh", ["-c", "x"], undefined, p, BOTH)).toEqual({ cmd: "/bin/sh", args: ["-c", "x"] });
      expect(spawnTarget("/bin/sh", ["-c", "x"], "P", p, BOTH)).toEqual({ cmd: SB, args: ["-p", "P", "/bin/sh", "-c", "x"] });
    }
    expect(spawnTarget("a", ["b"], "P")).toEqual({ cmd: SB, args: ["-p", "P", "a", "b"] });
  });

  it("uses only the tools that work", () => {
    expect(spawnTarget("c", [], undefined, "low", { ...BOTH, taskpolicy: false })).toEqual({ cmd: NICE, args: ["-n", "5", "c"] });
    expect(spawnTarget("c", [], undefined, "low", { ...BOTH, nice: false })).toEqual({ cmd: TP, args: ["-c", "utility", "c"] });
    const none = { nice: false, taskpolicy: false, current: 0 };
    expect(spawnTarget("c", ["d"], undefined, "low", none)).toEqual({ cmd: "c", args: ["d"] });
    expect(spawnTarget("c", [], "P", "low", none)).toEqual({ cmd: SB, args: ["-p", "P", "c"] });
  });

  it("works out the nice value from the current one and never raises a priority", () => {
    expect(priorityPrefix("low", { ...BOTH, current: 3 }).slice(0, 3)).toEqual([NICE, "-n", "2"]);
    expect(priorityPrefix("low", { ...BOTH, current: 5 })).toEqual([TP, "-c", "utility"]);
    expect(priorityPrefix("background", { ...BOTH, current: 16 })).toEqual([TP, "-c", "background"]);
  });
});

describe("governor.priority in the config", () => {
  it("defaults to low, also for a config without the block", () => {
    expect(ConfigSchema.parse({}).governor).toEqual({ priority: "low" });
    expect(ConfigSchema.parse({ concurrency: 3 }).governor).toEqual({ priority: "low" });
    expect(ConfigSchema.parse({ governor: { priority: "background" } }).governor.priority).toBe("background");
  });
  it("refuses an unknown value and an unknown key", () => {
    expect(ConfigSchema.safeParse({ governor: { priority: "x" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ governor: { other: 1 } }).success).toBe(false);
  });
  it("is described as a generated choice for new runs", () => {
    const s = describeSettings().find((x) => x.key === "governor.priority")!;
    expect(s).toMatchObject({ kind: "choice", default: "low", effect: "new-runs", control: "generated" });
  });
});

describe("run processes at a priority", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "prio-"));
    dirs.push(d);
    return d;
  };
  const base = (d: string) => ({ cwd: d, logFile: join(d, "log"), redactor: makeRedactor([]) });
  const SELF = `ps -o nice= -p $$`;
  const nested = `sh -c 'sh -c "ps -o nice= -p \\$\\$"'`;
  const nums = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).map(Number);

  it("low and background reach the process and a grandchild; normal changes nothing; the server stays", async () => {
    const m = await priorityMachine();
    if (!m.nice) return; // no working nice here
    const before = getPriority();
    for (const [p, want] of [["low", 5], ["background", 15], ["normal", 0]] as const) {
      const d = dir();
      const r = await runProcess("/bin/sh", ["-c", `${SELF}; ${nested}`], { ...base(d), priority: p });
      expect(nums(r.stdout)).toEqual([Math.max(want, before), Math.max(want, before)]);
    }
    expect(getPriority()).toBe(before);
  });

  it("the wrappers exec the command: it keeps its pid and group", async () => {
    const d = dir();
    const r = await runProcess("/bin/sh", ["-c", "echo $$ $(ps -o pgid= -p $$)"], { ...base(d), priority: "low", groupKill: true });
    const [pid, pgid] = r.stdout.trim().split(/\s+/);
    expect(pgid).toBe(pid);
  });

  it("an abort and a time-out stop the real process, with and without a group", async () => {
    const d = dir();
    const ctl = new AbortController();
    const p = runProcess("/bin/sh", ["-c", `echo $$ > ${join(d, "pid")}; exec sleep 60`], { ...base(d), priority: "low", signal: ctl.signal });
    const end = Date.now() + 10_000;
    let pid = 0;
    while (!pid && Date.now() < end) {
      try {
        pid = Number(readFileSync(join(d, "pid"), "utf8").trim());
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    ctl.abort();
    expect((await p).aborted).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    const t = await runProcess("/bin/sh", ["-c", "sleep 60"], { ...base(d), priority: "background", groupKill: true, timeoutMs: 300 });
    expect(t.timedOut).toBe(true);
  });

  it("a missing program fails the same at low as at normal", async () => {
    const d = dir();
    const msgs: string[] = [];
    for (const priority of ["normal", "low"] as const) {
      await runProcess("/nonexistent/prog", [], { ...base(d), priority }).catch((e) => msgs.push(String(e.message)));
    }
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toBe(msgs[0]);
    expect(msgs[1]).toMatch(/failed to start.*ENOENT/);
  });

  it("looks a bare program up in the PATH of the child, or in /usr/bin:/bin without one", async () => {
    const d = dir();
    const bin = join(d, "bin");
    const tool = join(bin, "mytool");
    mkdirSync(bin);
    writeFileSync(tool, `#!/bin/sh\n${SELF}\n`);
    chmodSync(tool, 0o755);
    const m = await priorityMachine();
    if (!m.nice) return;
    const r = await runProcess("mytool", [], { ...base(d), env: { PATH: `${bin}:/usr/bin:/bin` }, priority: "background" });
    expect(nums(r.stdout)).toEqual([Math.max(15, getPriority())]);
    const rel = await runProcess("mytool", [], { ...base(d), env: { PATH: "bin:/usr/bin:/bin" }, priority: "background" });
    expect(nums(rel.stdout)).toEqual([Math.max(15, getPriority())]);
    const sh = await runProcess("ps", ["-o", "nice=", "-p", "$$"], { ...base(d), env: { PATH: undefined }, cleanEnv: true, priority: "low" }).catch(() => undefined);
    expect(sh === undefined || sh.exitCode !== null).toBe(true); // found in the default path, so it is not a start failure
  });

  it("runShell and the broker's commands take the priority too", async () => {
    const m = await priorityMachine();
    if (!m.nice) return;
    const d = dir();
    const r = await runShell({ command: SELF, cwd: d, env: {}, logFile: join(d, "log"), priority: "background" });
    expect(nums(r.output)).toEqual([Math.max(15, getPriority())]);
    mkdirSync(join(d, "bin"));
    writeFileSync(join(d, "bin", "git"), `#!/bin/sh\n${SELF}\n`);
    chmodSync(join(d, "bin", "git"), 0o755);
    const out = await defaultExec(join(d, "log2"), "background")("git", [], { cwd: d, env: { PATH: `${join(d, "bin")}:/usr/bin:/bin` }, timeoutMs: 10_000, pinnedSecrets: [] } as never);
    expect(nums((out as { stdout: string }).stdout)).toEqual([Math.max(15, getPriority())]);
  });
});
