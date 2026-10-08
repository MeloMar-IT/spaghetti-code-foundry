import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tool = resolve("tools/test-slot");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, FACTORY_TEST_SLOT_POLL_MS: "50", ...extra });
const dir = () => mkdtempSync(join(tmpdir(), "slots-"));

describe("tools/test-slot", () => {
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
});
