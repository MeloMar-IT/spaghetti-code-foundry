import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatStrays, listWithRetry, Owned, parsePsRows, STUBBORN_SECONDS, strayRows, stubbornArgs, stubbornScript, stubbornShell, Watched, type PsRow } from "./helpers/stray-procs.js";

const START = "Thu Nov 26 15:29:11 2026";
const row = (pid: number, ppid: number, command = "x", o: Partial<PsRow> = {}): PsRow => ({ pid, ppid, pgid: 1000, stat: "S", start: START, command, ...o });
const TAG = "scf-stray-0123456789ab";

describe("parsePsRows", () => {
  it("reads every column, with spaces in the command, and skips other lines", () => {
    const text = [`  12     1    12 Ss   Thu Nov 26 15:29:11 2026     sh -c sleep 1 ${TAG}`, "13 12 12 Z    Thu Nov  5 05:00:00 2026", "PID PPID", "", "14 x 12 S Thu Nov 26 15:29:11 2026 y"].join("\n");
    expect(parsePsRows(text)).toEqual([
      { pid: 12, ppid: 1, pgid: 12, stat: "Ss", start: START, command: `sh -c sleep 1 ${TAG}` },
      { pid: 13, ppid: 12, pgid: 12, stat: "Z", start: "Thu Nov 5 05:00:00 2026", command: "" },
    ]);
  });
});

describe("Owned", () => {
  // 100 is the main vitest process, 200 a worker; 99 is the shell that started the suite
  const suite = [row(99, 1, "sh"), row(100, 99, "vitest"), row(200, 100, "worker")];
  const pids = (o: Owned, rows: PsRow[]) => rows.filter((r) => o.has(r)).map((r) => r.pid);

  it("keeps an unmarked descendant after its parents are gone, and leaves an unrelated wrapper of the same checkout alone", () => {
    const o = new Owned(100);
    const other = row(900, 1, "node /abs/tools/test-env silence sleep 5", { pgid: 900 });
    const child = row(300, 200, "sh -c 'sleep 60 & sleep 1'");
    const grand = row(301, 300, "sleep 60");
    o.fold([...suite, child, grand, other]);
    const orphan = { ...grand, ppid: 1 };
    const now = [...suite, orphan, other];
    o.fold(now);
    expect(pids(o, now)).toEqual([301]);
    expect(strayRows(now, { tag: TAG, owned: o, self: 100 }).map((r) => r.pid)).toEqual([301]);
  });

  it("does not report the workers and tools of vitest itself", () => {
    const o = new Owned(100);
    const tool = row(201, 100, "esbuild", { pgid: 201 });
    o.fold([...suite, tool]);
    expect(pids(o, [...suite, tool])).toEqual([]);
  });

  it("owns what is left of a group after its leader has ended, also what it never saw below a parent", () => {
    const o = new Owned(100);
    const leader = row(400, 200, "node test-slot-command", { pgid: 400 });
    o.fold([...suite, leader]);
    const left = row(402, 1, "sleep 60", { pgid: 400 });
    o.fold([...suite, left]);
    expect(pids(o, [...suite, left])).toEqual([402]);
  });

  it("forgets an empty group and an ended process, so a stranger with the same number is not taken", () => {
    const o = new Owned(100);
    o.fold([...suite, row(400, 200, "a", { pgid: 400 })]);
    o.fold(suite);
    const reused = row(400, 1, "stranger", { pgid: 400, start: "Thu Nov 26 16:00:00 2026" });
    o.fold([...suite, reused]);
    expect(pids(o, [...suite, reused])).toEqual([]);
  });
});

describe("listWithRetry", () => {
  it("returns the first table that reads", async () => {
    const answers: (PsRow[] | undefined)[] = [undefined, [row(5, 1)]];
    expect(await listWithRetry(() => answers.shift(), 3, 0)).toEqual([row(5, 1)]);
  });

  it("fails when every try fails, and says so", async () => {
    let calls = 0;
    await expect(
      listWithRetry(() => {
        calls++;
        return undefined;
      }, 3, 0),
    ).rejects.toThrow("ps failed 3 times");
    expect(calls).toBe(3);
  });
});

describe("strayRows", () => {
  const none = { has: () => false };

  it("keeps a row with this run's tag, and no row with another tag or only a checkout path", () => {
    const rows = [row(5, 1, `sh -c loop ${TAG}`), row(6, 1, "sh -c loop scf-stray-ffffffffffff"), row(7, 1, "node /abs/tools/test-env silence x")];
    expect(strayRows(rows, { tag: TAG, owned: none, self: 100 }).map((r) => r.pid)).toEqual([5]);
  });

  it("drops zombies, itself and its ancestors", () => {
    const rows = [row(99, 1, TAG), row(100, 99, TAG), row(5, 1, TAG, { stat: "Z" }), row(6, 1, TAG, { stat: "Z+" })];
    expect(strayRows(rows, { tag: TAG, owned: { has: () => true }, self: 100 })).toEqual([]);
  });

  it("lists each stray with its pid and a shortened command", () => {
    const text = formatStrays([row(5, 1, "x".repeat(500))]);
    expect(text).toBe(`  pid 5 (parent 1): ${"x".repeat(200)}`);
  });
});

describe("the stubborn fixture", () => {
  it("has no single quote and ends by the clock after at most 2 minutes", () => {
    const s = stubbornScript("/tmp/a b/x.pid");
    expect(s).not.toContain("'");
    expect(STUBBORN_SECONDS).toBeLessThanOrEqual(120);
    expect(s).toContain(`end=$(( $(date +%s) + ${STUBBORN_SECONDS} )); while [ "$(date +%s)" -lt "$end" ]; do sleep 0.1; done`);
    expect(s).toContain('echo $$ > "/tmp/a b/x.pid"');
    expect(s.startsWith('trap "" TERM;')).toBe(true);
  });

  it("carries the tag last, and refuses a path with a shell character", () => {
    expect(stubbornArgs("/tmp/x.pid", TAG)).toEqual(["-c", stubbornScript("/tmp/x.pid"), TAG]);
    expect(stubbornShell("/tmp/x.pid", TAG)).toBe(`sh -c '${stubbornScript("/tmp/x.pid")}' ${TAG}`);
    expect(() => stubbornScript('/tmp/$(x).pid')).toThrow("shell character");
  });
});

describe.skipIf(process.platform === "win32")("Watched", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 400 && !ready(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(ready()).toBe(true);
  };

  it("does not throw for a pid file that is not there, or a process that is gone", () => {
    const w = new Watched();
    w.file(join("/nonexistent", "x.pid"));
    w.pid(999_999);
    w.group(999_999);
    expect(() => w.kill()).not.toThrow();
  });

  it("kills the rest of a group after its leader has ended", async () => {
    // the leader prints the pid of a child it leaves behind in its group, and ends when its input closes
    const leader = spawn("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!; read x"], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    const w = new Watched();
    w.group(leader.pid!);
    const child = await new Promise<number>((done) => leader.stdout!.once("data", (d) => done(Number(String(d).trim()))));
    const ended = new Promise((done) => leader.on("exit", done));
    leader.stdin!.end();
    await ended;
    expect(alive(child)).toBe(true);
    w.kill();
    await until(() => !alive(child));
  });
});
