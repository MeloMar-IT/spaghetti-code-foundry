// The check at the end of the suite (tests/global-setup.ts), in a small suite of its own that is run for real.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { Watched } from "./helpers/stray-procs.js";

function runSuite(mode: "timeout" | "leak", onTestFinished: TestContext["onTestFinished"]) {
  const dir = mkdtempSync(join(tmpdir(), "stray-check-"));
  const watched = new Watched();
  onTestFinished(() => {
    watched.kill(); // before the folder goes: it reads the pid files
    rmSync(dir, { recursive: true, force: true });
  });
  for (const name of ["stubborn.pid", "orphan.pid"]) watched.file(join(dir, name));
  const env: NodeJS.ProcessEnv = { ...process.env, STRAY_CASE: mode, STRAY_DIR: dir };
  for (const k of Object.keys(env)) if (k.startsWith("VITEST")) delete env[k];
  const child = spawn(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "tests/fixtures/stray-check/vitest.config.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  watched.pid(child.pid!);
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (out += String(d)));
  const pid = (name: string) => Number(readFileSync(join(dir, name), "utf8"));
  return new Promise<{ code: number | null; out: string; pid: typeof pid }>((done) => child.on("close", (code) => done({ code, out, pid })));
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("the check for processes left by the tests", () => {
  it("passes after a test that timed out: its cleanup has killed the stubborn child", async ({ onTestFinished }) => {
    const r = await runSuite("timeout", onTestFinished);
    expect(r.out).toContain("Test timed out");
    expect(r.out).not.toContain("still running");
    expect(r.code).not.toBe(0);
    expect(alive(r.pid("stubborn.pid"))).toBe(false);
  }, 45_000);

  it("fails a run whose tests pass but leave processes, lists them and kills them", async ({ onTestFinished }) => {
    const r = await runSuite("leak", onTestFinished);
    expect(r.out).toContain("1 passed");
    expect(r.out).toContain("processes started by the tests were still running");
    for (const name of ["stubborn.pid", "orphan.pid"]) {
      expect(r.out).toContain(`pid ${r.pid(name)} `);
      expect(alive(r.pid(name))).toBe(false);
    }
    expect(r.out).toContain("sleep 61");
    expect(r.code).not.toBe(0);
  }, 45_000);
});
