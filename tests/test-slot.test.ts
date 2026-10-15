import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tool = resolve("tools/test-slot");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, FACTORY_TEST_SLOT_POLL_MS: "50", ...extra });
const dir = () => mkdtempSync(join(tmpdir(), "slots-"));

describe("tools/test-slot", () => {
  it("runs the command at low priority and marks it as inside a slot; FACTORY_TEST_NICE=0 keeps the normal priority", () => {
    const d = dir();
    const probe = 'echo "nice=$(ps -o nice= -p $$ | tr -d " ") slot=$FACTORY_IN_TEST_SLOT"';
    const low = spawnSync(tool, [d, "sh", "-c", probe], { env: env({ FACTORY_VAR_TEST_SLOTS: "1" }), encoding: "utf8" });
    expect(low.stdout).toMatch(/nice=(1\d|20) slot=1/); // at least 10, also when the test run itself already has a low priority
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

  /** Slot 1 is held by a live process (this one); with a cap of 1 a second test run has to wait. */
  const held = () => {
    const d = dir();
    mkdirSync(join(d, "slot-1"));
    writeFileSync(join(d, "slot-1", "pid"), String(process.pid));
    return d;
  };

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
