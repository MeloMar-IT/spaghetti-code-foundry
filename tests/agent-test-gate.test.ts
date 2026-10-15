import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testGateEnv } from "../src/agents/run.js";
import { TOOLS_DIR } from "../src/engine/guards.js";
// @ts-expect-error a plain ES module of the tools folder, without types
import { isTestCommand } from "../tools/agent-bin/_gate.mjs";

const BIN = resolve("tools/agent-bin");

/** A folder with fake commands that write their name, args, nice value and slot marker to `log`. */
function fakes(names: string[]) {
  const d = mkdtempSync(join(tmpdir(), "gate-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  const log = join(d, "log");
  for (const n of names) {
    const f = join(bin, n);
    writeFileSync(f, `#!/bin/sh\necho "${n} $* nice=$(ps -o nice= -p $$ | tr -d ' ') slot=\${FACTORY_IN_TEST_SLOT:-}" >> "${log}"\nexit 7\n`);
    chmodSync(f, 0o755);
  }
  return { d, bin, log, slots: join(d, "slots") };
}
const run = (f: ReturnType<typeof fakes>, cmd: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync(join(BIN, cmd), args, {
    env: { ...process.env, PATH: [BIN, f.bin, process.env.PATH].join(delimiter), FACTORY_TEST_SLOTS_DIR: f.slots, FACTORY_TEST_SLOT_POLL_MS: "50", FACTORY_IN_TEST_SLOT: "", ...extra },
    encoding: "utf8",
  });

describe("isTestCommand", () => {
  it.each([
    ["npm", ["test"]], ["npm", ["run", "test"]], ["npm", ["run", "test:unit"]], ["npm", ["exec", "vitest"]], ["npm", ["t"]],
    ["npx", ["vitest", "run", "tests/a.test.ts"]], ["npx", ["--yes", "jest"]], ["npx", ["playwright", "test"]],
    ["pnpm", ["test"]], ["yarn", ["test:e2e"]], ["pytest", ["-q"]], ["python3", ["-m", "pytest", "tests"]], ["python", ["-m", "unittest"]],
    ["gradle", ["test"]], ["gradle", [":app:check"]], ["mvn", ["-q", "verify"]], ["go", ["test", "./..."]], ["cargo", ["test"]],
  ])("%s %j is a test run", (name, args) => expect(isTestCommand(name, args)).toBe(true));

  it.each([
    ["npm", ["ci"]], ["npm", ["run", "build"]], ["npm", ["install", "vitest"]], ["npx", ["tsc", "--noEmit"]], ["npx", ["prettier", "--check", "."]],
    ["python3", ["-c", "print(1)"]], ["python3", ["script.py"]], ["gradle", ["assemble"]], ["go", ["build"]], ["go", ["vet"]], ["cargo", ["build"]],
    ["yarn", ["install"]], ["git", ["status"]],
  ])("%s %j is not", (name, args) => expect(isTestCommand(name, args)).toBe(false));
});

describe("tools/agent-bin", () => {
  it("runs a test command through a test slot, at low priority, and passes its output and exit code through", () => {
    const f = fakes(["npx"]);
    const r = run(f, "npx", ["vitest", "run"]);
    expect(r.status).toBe(7);
    const line = readFileSync(f.log, "utf8").trim();
    expect(line).toMatch(/^npx vitest run nice=(?:1\d?|20) slot=1$/);
    expect(Number(/nice=(\d+)/.exec(line)![1])).toBeGreaterThanOrEqual(10);
    // the slot is free again
    expect(readdirSync(f.slots)).toEqual([]);
  });

  it("runs any other command unchanged: same priority, no slot", () => {
    const f = fakes(["npm"]);
    const r = run(f, "npm", ["run", "build"]);
    expect(r.status).toBe(7);
    expect(readFileSync(f.log, "utf8").trim()).toMatch(/^npm run build nice=\d+ slot=$/);
    expect(() => readdirSync(f.slots)).toThrow();
  });

  it("does not ask for a second slot inside a slot, so `npm test` calling `npx vitest` cannot wait for itself", () => {
    const f = fakes(["npx"]);
    const r = run(f, "npx", ["vitest"], { FACTORY_IN_TEST_SLOT: "1", FACTORY_VAR_TEST_SLOTS: "1" });
    expect(r.status).toBe(7);
    expect(readFileSync(f.log, "utf8")).toContain("npx vitest");
    expect(() => readdirSync(f.slots)).toThrow();
  });

  it("waits for a slot that another test run holds, up to its wait, then runs anyway", () => {
    const f = fakes(["pytest"]);
    mkdirSync(join(f.slots, "slot-1"), { recursive: true });
    writeFileSync(join(f.slots, "slot-1", "pid"), String(process.pid)); // a live holder
    const t = Date.now();
    const r = run(f, "pytest", ["-q"], { FACTORY_VAR_TEST_SLOTS: "1", FACTORY_AGENT_TEST_WAIT_SEC: "1" });
    expect(r.status).toBe(7);
    expect(r.stdout).toContain("waiting for a free slot");
    expect(r.stdout).toContain("running anyway");
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });

  it("without a slots folder setting nothing is gated", () => {
    const f = fakes(["npx"]);
    const r = run(f, "npx", ["vitest"], { FACTORY_TEST_SLOTS_DIR: "" });
    expect(r.status).toBe(7);
    expect(readFileSync(f.log, "utf8").trim()).toMatch(/slot=$/);
  });

  it("says so when the command does not exist", () => {
    const f = fakes([]);
    // only node (which the wrappers need) and an empty folder besides the gate
    const nodeOnly = join(f.d, "node-only");
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, join(nodeOnly, "node"));
    const r = spawnSync(join(BIN, "cargo"), ["test"], { env: { ...process.env, PATH: [BIN, f.bin, nodeOnly].join(delimiter) }, encoding: "utf8" });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("cargo: command not found");
  });
});

describe("testGateEnv", () => {
  it("puts the gate first on the PATH once, and names the slots folder next to runs/", () => {
    const gate = join(TOOLS_DIR, "agent-bin");
    const env = testGateEnv(["/usr/bin", gate, "/bin"].join(delimiter), "/data/runs/20261014-1");
    expect(env.PATH).toBe([gate, "/usr/bin", "/bin"].join(delimiter));
    expect(env.FACTORY_TEST_SLOTS_DIR).toBe(join("/data", "test-slots"));
    expect(testGateEnv(undefined, "/d/runs/x").PATH).toBe(gate);
  });
});
