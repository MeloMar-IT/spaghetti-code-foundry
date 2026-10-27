import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tool = resolve("tools/test-slot");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, FACTORY_TEST_SLOT_POLL_MS: "50", ...extra });
const dir = () => mkdtempSync(join(tmpdir(), "slots-"));
/** Slot 1 is held by a live process (this one); with a cap of 1 a second test run has to wait. */
const held = () => {
  const d = dir();
  mkdirSync(join(d, "slot-1"));
  writeFileSync(join(d, "slot-1", "pid"), String(process.pid));
  return d;
};

describe("tools/test-slot", () => {
  it("runs the command at low priority and marks it as inside a slot; FACTORY_TEST_NICE=0 keeps the normal priority", () => {
    const d = dir();
    const probe = 'echo "nice=$(ps -o nice= -p $$ | tr -d " ") slot=$FACTORY_IN_TEST_SLOT"';
    const low = spawnSync(tool, [d, "sh", "-c", probe], { env: env({ FACTORY_VAR_TEST_SLOTS: "1" }), encoding: "utf8" });
    expect(low.stdout).toMatch(/nice=\d+ slot=1/);
    expect(Number(/nice=(\d+)/.exec(low.stdout)![1])).toBeGreaterThanOrEqual(10); // also when the test run itself already has a low priority (20)
    const normal = spawnSync(tool, [d, "sh", "-c", probe], { env: env({ FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_NICE: "0" }), encoding: "utf8" });
    // normal priority = the priority this test run itself has (it may already run at a low one)
    expect(normal.stdout).toMatch(new RegExp(`nice=${getPriority()} slot=1`));
  });

  it("runs without a slot when the slots folder cannot be made", () => {
    const blocker = join(dir(), "file");
    writeFileSync(blocker, "x");
    const r = spawnSync(tool, [join(blocker, "slots"), "sh", "-c", "echo ran"], { env: env({ FACTORY_VAR_TEST_SLOTS: "1" }), encoding: "utf8" });
    expect(r.stdout).toContain("running without a slot");
    expect(r.stdout).toContain("ran");
    expect(r.status).toBe(0);
  });

  it("passes the output and the exit code of the command through, and frees its slot", () => {
    const d = dir();
    const r = spawnSync(tool, [d, "sh", "-c", "echo hello; exit 3"], { env: env({ FACTORY_VAR_TEST_SLOTS: "1" }), encoding: "utf8" });
    expect(r.stdout).toContain("hello");
    expect(r.status).toBe(3);
    expect(readdirSync(d)).toEqual([]);
  });

  it("lets only as many commands run at once as there are slots", async () => {
    const d = dir();
    const log = join(d, "..", `order-${Date.now()}.txt`);
    const one = (name: string) => new Promise<number>((done) => {
      const c = spawn(tool, [d, "sh", "-c", `echo ${name}-start >> "${log}"; sleep 0.6; echo ${name}-end >> "${log}"`], { env: env({ FACTORY_VAR_TEST_SLOTS: "1" }) });
      c.on("exit", (code) => done(code ?? 1));
    });
    const [a, b] = await Promise.all([one("a"), new Promise<number>((r) => setTimeout(() => one("b").then(r), 150))]);
    expect([a, b]).toEqual([0, 0]);
    const lines = spawnSync("cat", [log], { encoding: "utf8" }).stdout.trim().split("\n");
    // Never two inside at the same time: each start is followed by its own end.
    expect(lines).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("takes over the slot of a holder that is gone, and runs anyway when the wait is over", () => {
    const d = dir();
    mkdirSync(join(d, "slot-1"));
    writeFileSync(join(d, "slot-1", "pid"), "999999"); // no such process
    const gone = spawnSync(tool, [d, "sh", "-c", "echo ran"], { env: env({ FACTORY_VAR_TEST_SLOTS: "1" }), encoding: "utf8" });
    expect(gone.stdout).toContain("ran");
    expect(gone.status).toBe(0);

    mkdirSync(join(d, "slot-1"));
    writeFileSync(join(d, "slot-1", "pid"), String(process.pid)); // held by a live process
    const waited = spawnSync(tool, [d, "sh", "-c", "echo ran"], { env: env({ FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_SLOT_WAIT_SEC: "0" }), encoding: "utf8" });
    expect(waited.stdout).toContain("running anyway");
    expect(waited.stdout).toContain("ran");
    expect(existsSync(join(d, "slot-1"))).toBe(true); // the other holder keeps its slot
  });

  it("with 0 slots there is no limit and no folder", () => {
    const d = join(dir(), "none");
    const r = spawnSync(tool, [d, "sh", "-c", "echo free"], { env: env({ FACTORY_VAR_TEST_SLOTS: "0" }), encoding: "utf8" });
    expect(r.stdout).toContain("free");
    expect(existsSync(d)).toBe(false);
  });

  it("ignores a cap file that was not written for 4 minutes: a governor that stopped cannot hold tests to one at a time", () => {
    const d = held();
    writeFileSync(join(d, "cap"), "1");
    const capped = spawnSync(tool, [d, "sh", "-c", "echo ran"], { env: env({ FACTORY_VAR_TEST_SLOTS: "2", FACTORY_TEST_SLOT_WAIT_SEC: "0" }), encoding: "utf8" });
    expect(capped.stdout).toContain("running anyway");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(d, "cap"), old, old);
    const free = spawnSync(tool, [d, "sh", "-c", "echo ran"], { env: env({ FACTORY_VAR_TEST_SLOTS: "2", FACTORY_TEST_SLOT_WAIT_SEC: "0" }), encoding: "utf8" });
    expect(free.stdout).toBe("ran\n");
    expect(readdirSync(d).sort()).toEqual(["cap", "slot-1"]); // it took slot 2 and gave it back
  });
});

describe.concurrent("tools/test-slot time limit", () => {
  const procTree = resolve("dist/steps/proc-tree.js");
  beforeAll(() => {
    if (!existsSync(procTree)) throw new Error("dist/steps/proc-tree.js is missing — run `npm run build` first");
  });

  const limitEnv = (extra: Record<string, string> = {}) => env({ FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_NICE: "0", ...extra });
  const run = (d: string, args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; ms: number }>((done) => {
      const t0 = Date.now();
      let stdout = "";
      const c = spawn(tool, [d, ...args], { env: limitEnv(extra) });
      c.stdout.on("data", (b) => (stdout += String(b)));
      c.on("exit", (code) => done({ code: code ?? -1, stdout, ms: Date.now() - t0 }));
    });
  const dead = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const pidOf = async (file: string) => {
    for (let i = 0; i < 400; i++) {
      try {
        const n = Number(readFileSync(file, "utf8").trim());
        if (n > 0) return n;
      } catch { /* not there yet */ }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no pid in ${file}`);
  };
  const kill = (pid: number | undefined) => {
    try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  };
  // A parent that starts $CHILD in its own process group, writes its pid and stays alive until $GO exists.
  const parent = 'const {spawn}=require("child_process"),fs=require("fs");spawn("/bin/sh",["-c",process.env.CHILD],{detached:true,stdio:"ignore"}).unref();fs.writeFileSync(process.env.PIDF,String(process.pid));const t=setInterval(()=>{if(process.env.GO&&fs.existsSync(process.env.GO)){clearInterval(t);process.exit(0)}},50)';
  const stopLine = /^test-slot: stopped after \d+ s — the time limit is 1 s$/m;
  const tmp = () => mkdtempSync(join(tmpdir(), "tl-"));

  it("stops a detached grandchild at the limit, prints the stop line, exits 124 and frees the slot", async () => {
    const d = dir();
    const w = tmp();
    let gc: number | undefined;
    let p: number | undefined;
    try {
      const r = await run(d, ["node", "-e", parent], { FACTORY_TEST_SLOT_LIMIT_SEC: "1", CHILD: `echo $$ > ${w}/gc; exec sleep 60`, PIDF: join(w, "p") });
      gc = await pidOf(join(w, "gc"));
      p = await pidOf(join(w, "p"));
      expect(r.code).toBe(124);
      expect(r.stdout.trim().split("\n").pop()).toMatch(stopLine);
      expect(dead(p)).toBe(true);
      expect(dead(gc)).toBe(true);
      expect(readdirSync(d)).toEqual([]);
    } finally {
      kill(gc);
      kill(p);
    }
  });

  it("stops a child that was orphaned right away", async () => {
    const d = dir();
    const w = tmp();
    let o: number | undefined;
    try {
      const r = await run(d, ["sh", "-c", `(sleep 60 & echo $! > ${w}/o); sleep 60`], { FACTORY_TEST_SLOT_LIMIT_SEC: "1", FACTORY_TEST_SLOT_TRACK_MS: "100" });
      o = await pidOf(join(w, "o"));
      expect(r.code).toBe(124);
      expect(dead(o)).toBe(true);
    } finally {
      kill(o);
    }
  });

  it("remembers a detached process across two calls with the track file; the limit of the second call stops it", async () => {
    const d = dir();
    const w = tmp();
    const track = join(w, "track");
    let gc: number | undefined;
    try {
      // call 1 has no limit; its command stays up until the tracker has noted the grandchild (the track file is written at exit)
      const first = run(d, ["node", "-e", parent], { FACTORY_TEST_SLOT_TRACK_FILE: track, FACTORY_TEST_SLOT_TRACK_MS: "100", CHILD: `echo $$ > ${w}/gc; exec sleep 60`, PIDF: join(w, "p"), GO: join(w, "go") });
      gc = await pidOf(join(w, "gc"));
      await pidOf(join(w, "p"));
      await new Promise((r) => setTimeout(r, 600)); // several polls of 100 ms
      writeFileSync(join(w, "go"), "");
      expect((await first).code).toBe(0);
      expect(readFileSync(track, "utf8")).toMatch(new RegExp(`^${gc} `, "m"));
      expect(dead(gc)).toBe(false);
      const second = await run(d, ["sleep", "30"], { FACTORY_TEST_SLOT_LIMIT_SEC: "1", FACTORY_TEST_SLOT_TRACK_FILE: track });
      expect(second.code).toBe(124);
      expect(dead(gc)).toBe(true);
      expect(readFileSync(track, "utf8")).not.toMatch(new RegExp(`^${gc} `, "m"));
    } finally {
      kill(gc);
    }
  });

  it("keeps stopping until a detached child that ignores TERM is confirmed and killed, when ps is slow and the group dies at once", { timeout: 30_000 }, async () => {
    const d = dir();
    const w = tmp();
    // a ps that answers after 0.5 s (under the 1.5 s and 2 s reads the tool makes)
    const slowPs = join(w, "ps");
    writeFileSync(slowPs, '#!/bin/sh\nsleep 0.5\nexec ps "$@"\n');
    chmodSync(slowPs, 0o755);
    let gc: number | undefined;
    let p: number | undefined;
    try {
      // the parent dies on TERM at once; the child keeps running in its own group and ignores TERM
      const r = await run(d, ["node", "-e", parent], { FACTORY_TEST_SLOT_LIMIT_SEC: "1", FACTORY_TEST_SLOT_PS: slowPs, CHILD: `trap "" TERM; echo $$ > ${w}/gc; exec sleep 60`, PIDF: join(w, "p") });
      gc = await pidOf(join(w, "gc"));
      p = await pidOf(join(w, "p"));
      expect(r.code).toBe(124);
      expect(dead(p)).toBe(true);
      expect(dead(gc)).toBe(true);
    } finally {
      kill(gc);
      kill(p);
    }
  });

  it("still stops the process group when ps does not work", async () => {
    const d = dir();
    const w = tmp();
    let bg: number | undefined;
    try {
      const r = await run(d, ["sh", "-c", `sleep 60 & echo $! > ${w}/bg; wait`], { FACTORY_TEST_SLOT_LIMIT_SEC: "1", FACTORY_TEST_SLOT_PS: "/nonexistent" });
      bg = await pidOf(join(w, "bg"));
      expect(r.code).toBe(124);
      expect(r.stdout).toMatch(stopLine);
      expect(dead(bg)).toBe(true);
    } finally {
      kill(bg);
    }
  });

  it("kills a command that traps TERM after 5 s", async () => {
    const d = dir();
    const w = tmp();
    let p: number | undefined;
    try {
      const r = await run(d, ["sh", "-c", `trap "" TERM; echo $$ > ${w}/p; while :; do sleep 0.1; done`], { FACTORY_TEST_SLOT_LIMIT_SEC: "1" });
      p = await pidOf(join(w, "p"));
      expect(r.code).toBe(124);
      expect(r.ms).toBeGreaterThan(5500);
      expect(r.ms).toBeLessThan(9500);
      expect(dead(p)).toBe(true);
    } finally {
      kill(p);
    }
  });

  it("does not count the slot wait against the limit", async () => {
    const d = dir();
    const w = tmp();
    mkdirSync(join(d, "slot-1"));
    writeFileSync(join(d, "slot-1", "pid"), String(process.pid));
    const started = join(w, "s");
    const done = run(d, ["sleep", "0.3"], { FACTORY_TEST_SLOT_LIMIT_SEC: "1", FACTORY_TEST_SLOT_STARTED_FILE: started });
    await new Promise((r) => setTimeout(r, 1500));
    const freedAt = Date.now();
    rmSync(join(d, "slot-1"), { recursive: true });
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("stopped after");
    expect(Number(readFileSync(started, "utf8"))).toBeGreaterThanOrEqual(Math.floor(freedAt / 1000));
  });

  it("writes the started file when there is no wait and no limit", async () => {
    const started = join(tmp(), "s");
    const before = Math.floor(Date.now() / 1000);
    const r = await run(dir(), ["echo", "ran"], { FACTORY_TEST_SLOT_STARTED_FILE: started });
    expect(r.code).toBe(0);
    const n = Number(readFileSync(started, "utf8"));
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  it("reads the cap again while it waits: when the cap goes, a waiting test run takes the second slot", async () => {
    const d = held();
    writeFileSync(join(d, "cap"), "1");
    let out = "";
    const c = spawn(tool, [d, "sh", "-c", "echo ran"], { env: env({ FACTORY_VAR_TEST_SLOTS: "2" }) });
    c.stdout.on("data", (b) => (out += String(b)));
    const done = new Promise<number>((r) => c.on("exit", (code) => r(code ?? 1)));
    for (let i = 0; i < 200 && !out.includes("waiting for a free slot"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(out).toContain("1 test run(s) are already working");
    rmSync(join(d, "cap"));
    expect(await done).toBe(0);
    expect(out).toContain("got a slot after");
    expect(out).toContain("ran");
    expect(existsSync(join(d, "slot-1"))).toBe(true); // the other holder keeps its slot
  });
});
