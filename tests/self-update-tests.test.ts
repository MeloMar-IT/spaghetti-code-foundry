import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStep, type UpdateStep } from "../src/self-update-state.js";
import { failingTests, markFinder, slotStep } from "../src/self-update-tests.js";

describe("failingTests", () => {
  it("reads FAIL lines with the file and the whole name", () => {
    expect(failingTests(" FAIL  tests/a.test.ts > suite > adds numbers\n FAIL  tests/b.test.ts > works\n")).toEqual(["tests/a.test.ts > suite > adds numbers", "tests/b.test.ts > works"]);
  });

  it("strips colours and de-duplicates", () => {
    const line = "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/a.test.ts > adds";
    expect(failingTests(`${line}\n${line}\n`)).toEqual(["tests/a.test.ts > adds"]);
    expect(failingTests(" FAIL  tests/a.test.ts > adds\n FAIL  tests/a.test.ts > adds\n")).toEqual(["tests/a.test.ts > adds"]);
  });

  it("reads × lines without the time and the retry note", () => {
    expect(failingTests("   × alone 12ms\n   × again (retry x2)\n   × plain\n")).toEqual(["alone", "again", "plain"]);
  });

  it("does not add a × name that a FAIL name already has", () => {
    const out = " FAIL  tests/a.test.ts > suite > adds\n   × adds 3ms\n   × alone 2ms\n";
    expect(failingTests(out)).toEqual(["tests/a.test.ts > suite > adds", "alone"]);
  });

  it("returns at most 20 names", () => {
    const out = Array.from({ length: 25 }, (_, i) => ` FAIL  tests/a.test.ts > case ${i}`).join("\n");
    expect(failingTests(out)).toHaveLength(20);
  });

  it("returns [] when there is nothing", () => {
    expect(failingTests("")).toEqual([]);
    expect(failingTests("all good\n ✓ fine 1ms\n")).toEqual([]);
  });

  it("never cuts a name", () => {
    const name = `tests/a.test.ts > ${"x".repeat(400)}`;
    expect(failingTests(` FAIL  ${name}\n`)).toEqual([name]);
  });

  it("ignores FAIL in the middle of a line and passing lines", () => {
    expect(failingTests("the word FAIL  tests/a.test.ts > x\n ✓ tests/a.test.ts > y 1ms\n")).toEqual([]);
  });
});

describe("markFinder", () => {
  it("removes the mark from a burst with other output", () => {
    const m = markFinder("MARK");
    expect(m.push("MARK\n" + "x".repeat(30_000))).toBe("x".repeat(30_000));
    expect(m.found()).toBe(true);
    expect(m.rest()).toBe("");
  });

  it("finds a mark that comes in pieces", () => {
    const m = markFinder("MARK");
    expect(m.push("a\nMA")).toBe("a\n");
    expect(m.push("R")).toBe("");
    expect(m.push("K\nb")).toBe("b");
    expect(m.found()).toBe(true);
  });

  it("does not take another line for the mark", () => {
    const m = markFinder("MARK");
    expect(m.push("MAX\n")).toBe("MAX\n");
    expect(m.found()).toBe(false);
    expect(m.push("xMARK\n")).toBe("xMARK\n");
    expect(m.found()).toBe(false);
  });

  it("holds back a possible start of the mark until rest()", () => {
    const m = markFinder("MARK");
    expect(m.push("out\nMA")).toBe("out\n");
    expect(m.found()).toBe(false);
    expect(m.rest()).toBe("MA");
    expect(m.rest()).toBe("");
  });

  it("passes everything after the mark, also a second mark", () => {
    const m = markFinder("MARK");
    expect(m.push("MARK\n")).toBe("");
    expect(m.push("MARK\n")).toBe("MARK\n");
    expect(m.push("MA")).toBe("MA");
  });
});

describe("slotStep", () => {
  const step: UpdateStep = { name: "test", cmd: "npm", args: ["test", "a b; rm"], timeoutMs: 5 };

  it("runs the command through the slot tool, with arguments as arguments", () => {
    const s = slotStep(step, { tool: "/t/test-slot", slotsDir: "/d/test-slots" });
    expect(s.cmd).toBe("node");
    expect(s.startMark).toMatch(/^scf-tests-start-[0-9a-f]{16}$/);
    expect(s.args).toEqual(["/t/test-slot", "/d/test-slots", "sh", "-c", `echo ${s.startMark}; exec "$@"`, "sh", "npm", "test", "a b; rm"]);
    expect(s.env).toEqual({ FACTORY_VAR_TEST_SLOTS: "2", FACTORY_TEST_SLOT_WAIT_SEC: "900", FACTORY_TEST_SLOT_POLL_MS: "2000" });
    expect(s.waitMs).toBe(900_000);
    expect(s.timeoutMs).toBe(5);
    expect(s.name).toBe("test");
  });

  it("takes the slot settings", () => {
    const s = slotStep(step, { tool: "t", slotsDir: "d", slots: 1, waitSec: 0, pollMs: 50 });
    expect(s.env).toEqual({ FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_SLOT_WAIT_SEC: "0", FACTORY_TEST_SLOT_POLL_MS: "50" });
    expect(s.waitMs).toBe(0);
  });

  it("makes a new mark each time", () => {
    const o = { tool: "t", slotsDir: "d" };
    expect(slotStep(step, o).startMark).not.toBe(slotStep(step, o).startMark);
  });
});

describe("runStep with a start mark", () => {
  afterEach(() => vi.unstubAllEnvs());
  const run = async (script: string, o: Partial<UpdateStep> = {}) => {
    const t0 = Date.now();
    const r = await runStep({ name: "test", cmd: "sh", args: ["-c", script], startMark: "MARK", ...o }, tmpdir());
    return { ...r, ms: Date.now() - t0 };
  };

  it("ends a hanging test run after its own limit", async () => {
    const r = await run("echo MARK; sleep 30", { timeoutMs: 300, waitMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(5000);
    expect(r.output).toBe("");
  });

  it("keeps the output after the mark of a burst", async () => {
    const r = await run("echo MARK; head -c 30000 /dev/zero | tr '\\0' x");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("x".repeat(20_000));
  });

  it("finds a mark in pieces with stderr in between", async () => {
    const r = await run("printf MA; sleep 0.1; echo err >&2; sleep 0.1; printf 'RK\\nout\\n'");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("err\nout\n");
  });

  it("starts the limit late when the start is late", async () => {
    const r = await run("sleep 0.6; echo MARK; echo done", { timeoutMs: 300, waitMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("done\n");
  });

  it("stops after wait + own limit when the mark never comes", async () => {
    const r = await run("printf MA; sleep 30", { timeoutMs: 200, waitMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(450);
    expect(r.ms).toBeLessThan(5000);
    expect(r.output).toBe("MA");
  });

  it("keeps one timer and the output without a mark", async () => {
    const a = await run("echo MARK; sleep 30", { timeoutMs: 200, startMark: undefined });
    expect(a.ok).toBe(false);
    expect(a.output).toBe("MARK\n");
    const b = await run("echo hi; echo e >&2", { startMark: undefined });
    expect(b.ok).toBe(true);
    expect(b.output).toContain("hi");
    expect(b.output).toContain("e");
  });

  it("adds only the given variables to the environment", async () => {
    vi.stubEnv("GH_TOKEN", "t");
    const env = { FACTORY_VAR_TEST_SLOTS: "2", FACTORY_TEST_SLOT_WAIT_SEC: "0", FACTORY_TEST_SLOT_POLL_MS: "50" };
    const r = await run("env", { env, startMark: undefined });
    for (const [k, v] of Object.entries(env)) expect(r.output).toContain(`${k}=${v}`);
    expect(r.output).toContain("CI=1");
    expect(r.output).not.toMatch(/^FACTORY_HOME=/m);
    expect(r.output).not.toMatch(/^GH_TOKEN=/m);
    expect(r.output.split("\n").filter((l) => l.startsWith("FACTORY_"))).toHaveLength(3);
  });
});
