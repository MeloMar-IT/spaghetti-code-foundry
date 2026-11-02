import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";

const tool = resolve("tools/test-slot");
let tmp: string;
let repo: string;
let runsDir: string;
const saved: Record<string, string | undefined> = {};
const SET = { FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_SLOT_POLL_MS: "50", FACTORY_TEST_NICE: "0" };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "slot-wait-flow-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  for (const [k, v] of Object.entries(SET)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const config = () => ConfigSchema.parse({ protected_branches: [] });
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 800 && !ready(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(ready()).toBe(true);
};

/** The wait files of the one run in runsDir (all steps). */
function waitFiles(): { dir: string; name: string }[] {
  const out: { dir: string; name: string }[] = [];
  try {
    for (const run of readdirSync(runsDir)) {
      const root = join(runsDir, run, "slot-waits");
      if (!existsSync(root)) continue;
      for (const step of readdirSync(root)) for (const name of readdirSync(join(root, step))) out.push({ dir: join(root, step), name });
    }
  } catch {
    // not there yet
  }
  return out;
}

describe("the time limit and the wait for a test slot", () => {
  it("a shell step that waits for a slot past its limit still passes, and records the wait", { timeout: 30_000 }, async () => {
    const slots = join(tmp, "slots");
    mkdirSync(join(slots, "slot-1"), { recursive: true });
    writeFileSync(join(slots, "slot-1", "pid"), String(process.pid)); // held by this process
    const flow = parseFlow(`name: t\nworkspace: empty\nsteps:\n  - { id: tests, type: shell, run: "${tool} ${slots} sh -c 'echo ran'", timeout_sec: 1 }\n`);
    const done = runFlow(flow, { task: "t", repo, runsDir, config: config() });
    // the limit (1 s) has passed while the step is still waiting
    await until(() => waitFiles().some((f) => f.name.endsWith(".wait") && Date.now() - Number(f.name.split("-")[0]) > 1500));
    rmSync(join(slots, "slot-1"), { recursive: true });
    const s = await done;
    const rec = s.history[0]!;
    expect(rec).toMatchObject({ id: "tests", ok: true });
    expect(rec.slotWaitMs).toBeGreaterThan(1000);
    expect(rec.output).toContain("ran");
    expect(readFileSync(rec.logFile, "utf8")).toMatch(/waited \d+ s for a test slot/);
  });

  it("a shell step that is stopped on its limit after a wait says so in its error", { timeout: 30_000 }, async () => {
    const slots = join(tmp, "slots");
    mkdirSync(join(slots, "slot-1"), { recursive: true });
    writeFileSync(join(slots, "slot-1", "pid"), String(process.pid));
    const flow = parseFlow(`name: t\nworkspace: empty\nsteps:\n  - { id: tests, type: shell, run: "${tool} ${slots} sh -c 'echo ran'; sleep 30", timeout_sec: 1 }\n`);
    const done = runFlow(flow, { task: "t", repo, runsDir, config: config() });
    await until(() => waitFiles().some((f) => f.name.endsWith(".wait") && Date.now() - Number(f.name.split("-")[0]) > 1500));
    rmSync(join(slots, "slot-1"), { recursive: true });
    const s = await done;
    expect(s.history[0]).toMatchObject({ ok: false });
    expect(s.history[0]!.error).toMatch(/^timed out \(waited \d+ s for a test slot, which did not count\)$/);
  });

  it("an agent step gets the folder for its wait records", { timeout: 30_000 }, async () => {
    const bin = join(tmp, "claude-env");
    writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "dir=" + process.env.FACTORY_TEST_SLOT_WAIT_DIR, session_id: "s", total_cost_usd: 0 })));\n`);
    chmodSync(bin, 0o755);
    const flow = parseFlow(`name: t\nworkspace: empty\nsteps:\n  - { id: agent, type: claude, prompt: hi }\n`);
    const s = await runFlow(flow, { task: "t", repo, runsDir, claudeBin: bin, config: config() });
    expect([s.status, s.reason]).toEqual(["succeeded", undefined]);
    const dir = /dir=(.+)$/.exec(s.history[0]!.output)?.[1];
    expect(dir).toBeTruthy();
    expect(dir).toContain(join(s.runDir, "slot-waits"));
    expect(existsSync(dir!)).toBe(true);
    expect(s.history[0]!.slotWaitMs).toBeUndefined();
  });
});
