import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadUpdateState, saveUpdateState } from "../src/self-update-state.js";
import { fixture, removeFixtures, sha7, STEPS, updater } from "./helpers/self-update.js";

vi.setConfig({ testTimeout: 60_000 });
afterEach(removeFixtures);

const MIN = 60_000;
const FAILING = 'echo " FAIL  tests/a.test.ts > adds numbers"\nexit 1\n';
const start = Date.parse("2026-01-01T00:00:00Z");
const building = (logs: string[]) => logs.filter((l) => l.includes("building and testing"));

describe("self-update: the tests are tried again", () => {
  it("fails once, waits, and passes on the second try", async () => {
    const f = fixture();
    let clock = start;
    // the marker lives outside the worktree: the tests pass once it exists
    const marker = join(f.root, "pass");
    const v2 = f.publish({ "test.sh": `[ -e "${marker}" ] && exit 0\n${FAILING}` });
    const t = updater(f, { now: () => clock });
    await t.u.tick(true);
    expect(f.state().retry).toEqual({ commit: v2, tries: 1, at: new Date(start).toISOString() });
    expect(f.state().failed).toBeUndefined();
    expect(f.state().tested).toBeUndefined();
    expect(t.drained).toBe(0);
    expect(t.u.busy()).toBe(false);
    expect(t.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): its tests failed (try 1 of 3). They run again in about 20 minutes.`);

    clock += 19 * MIN;
    await t.u.tick(true);
    expect(building(t.logs)).toHaveLength(1);
    expect(t.u.view().update?.text).toContain("They run again in about 1 minute.");

    clock += MIN;
    writeFileSync(marker, "");
    await t.u.tick(true);
    expect(t.logs).toContain(`self-update: building and testing ${sha7(v2)} (try 2 of 3)`);
    expect(f.state().tested?.commit).toBe(v2);
    expect(f.state().retry).toBeUndefined();
    expect(t.drained).toBe(1);
  });

  it("keeps the wait over a restart", async () => {
    const f = fixture();
    let clock = start;
    const v2 = f.publish({ "test.sh": FAILING });
    await updater(f, { now: () => clock }).u.tick(true);
    clock += 5 * MIN;
    const b = updater(f, { now: () => clock });
    await b.u.tick(true);
    expect(building(b.logs)).toHaveLength(0);
    expect(b.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): its tests failed (try 1 of 3). They run again in about 15 minutes.`);
    clock += 15 * MIN;
    await b.u.tick(true);
    expect(b.logs).toContain(`self-update: building and testing ${sha7(v2)} (try 2 of 3)`);
  });

  it("counts a time that cannot be read as due now", async () => {
    const f = fixture();
    const v2 = f.publish({ "test.sh": "exit 0\n", "app.txt": "v2\n" });
    saveUpdateState({ retry: { commit: v2, tries: 1, at: "soon" } }, f.file);
    expect(loadUpdateState(f.file).broken).toBe(false);
    const t = updater(f);
    await t.u.tick(true);
    expect(t.logs).toContain(`self-update: building and testing ${sha7(v2)} (try 2 of 3)`);
    expect(f.state().tested?.commit).toBe(v2);
  });

  it("waits longer, not shorter, when the clock went back", async () => {
    const f = fixture();
    let clock = start;
    const v2 = f.publish({ "test.sh": "exit 0\n", "app.txt": "v2\n" });
    const retry = { commit: v2, tries: 1, at: new Date(clock + 5 * MIN).toISOString() };
    saveUpdateState({ retry }, f.file);
    const t = updater(f, { now: () => clock });
    await t.u.tick(true);
    expect(building(t.logs)).toHaveLength(0);
    expect(f.state().retry).toEqual(retry);
    expect(t.u.view().update?.text).toContain("(try 1 of 3). They run again in about 25 minutes.");
    clock += 25 * MIN;
    await t.u.tick(true);
    expect(t.logs).toContain(`self-update: building and testing ${sha7(v2)} (try 2 of 3)`);
    expect(f.state().tested?.commit).toBe(v2);
  });

  it("fails after the third try and names the tests", async () => {
    const f = fixture();
    let clock = start;
    const v2 = f.publish({ "test.sh": FAILING });
    const t = updater(f, { now: () => clock });
    for (let i = 0; i < 3; i++) {
      await t.u.tick(true);
      clock += 20 * MIN;
    }
    expect(f.state().failed).toMatchObject({ commit: v2, stage: "test", tries: 3, tests: ["tests/a.test.ts > adds numbers"] });
    expect(f.state().failed?.lines).toBeDefined();
    expect(f.state().retry).toBeUndefined();
    expect(t.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): its tests failed 3 times (tests/a.test.ts > adds numbers). The Foundry waits for a newer commit on main.`);
    await t.u.tick(true);
    expect(building(t.logs)).toHaveLength(3);
  });

  it("leaves the bracket out when no names were found", async () => {
    const f = fixture();
    f.publish({ "test.sh": "echo nope\nexit 1\n" });
    const t = updater(f, { retryWaitMs: 0 });
    for (let i = 0; i < 3; i++) await t.u.tick(true);
    expect(f.state().failed?.tests).toBeUndefined();
    expect(t.u.view().update?.text).toContain("its tests failed 3 times. The Foundry waits");
  });

  it("stages a newer commit at once after three failures", async () => {
    const f = fixture();
    f.publish({ "test.sh": FAILING });
    const t = updater(f, { retryWaitMs: 0 });
    for (let i = 0; i < 3; i++) await t.u.tick(true);
    const good = f.publish({ "test.sh": "exit 0\n", "app.txt": "v3\n" });
    await t.u.tick(true);
    expect(t.logs.at(-4)).not.toContain("(try");
    expect(t.logs).toContain(`self-update: building and testing ${sha7(good)}`);
    expect(f.state().tested?.commit).toBe(good);
    expect(f.state().failed).toBeUndefined();
  });

  it("stages a newer commit at once during the wait", async () => {
    const f = fixture();
    const clock = start;
    f.publish({ "test.sh": FAILING });
    const t = updater(f, { now: () => clock });
    await t.u.tick(true);
    expect(f.state().retry?.tries).toBe(1);
    const good = f.publish({ "test.sh": "exit 0\n", "app.txt": "v3\n" });
    await t.u.tick(true);
    expect(t.logs).toContain(`self-update: building and testing ${sha7(good)}`);
    expect(f.state().tested?.commit).toBe(good);
    expect(f.state().retry).toBeUndefined();
  });

  it("fails a build at once, also for a commit that has a retry", async () => {
    const f = fixture();
    const clock = start;
    const bad = f.publish({ "build.sh": 'echo "build broke"\nexit 1\n' });
    saveUpdateState({ retry: { commit: bad, tries: 1, at: new Date(clock - 21 * MIN).toISOString() } }, f.file);
    const t = updater(f, { now: () => clock });
    await t.u.tick(true);
    expect(f.state().failed).toMatchObject({ commit: bad, stage: "build" });
    expect(f.state().failed?.tries).toBeUndefined();
    expect(f.state().retry).toBeUndefined();
    await t.u.tick(true);
    expect(building(t.logs)).toHaveLength(1);
  });

  it("reads an old record without tries", async () => {
    const f = fixture();
    const v2 = f.publish({ "app.txt": "v2\n" });
    saveUpdateState({ failed: { commit: v2, stage: "test", at: "x" } }, f.file);
    const t = updater(f);
    await t.u.tick(true);
    expect(t.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): its tests failed. The Foundry waits for a newer commit on main.`);
    expect(building(t.logs)).toHaveLength(0);
  });

  it("keeps hidden values out of the names, the record, the log and the text", async () => {
    const HIDDEN = ["hun", "ter"].join("") + "2-value";
    const PREFIX = "tests/a.test.ts > ";
    const LONG = PREFIX + "x".repeat(290 - PREFIX.length) + HIDDEN;
    const TOO_LONG = PREFIX + "y".repeat(300);
    const f = fixture();
    f.publish({ "test.sh": `printf '%s\\n' ' FAIL  ${LONG}' ' FAIL  ${TOO_LONG}' ' FAIL  ${PREFIX}short'\nexit 1\n` });
    const t = updater(f, { retryWaitMs: 0, redact: (s) => s.replaceAll(HIDDEN, "<hidden>") });
    for (let i = 0; i < 3; i++) await t.u.tick(true);
    const shown = LONG.replace(HIDDEN, "<hidden>");
    const failed = f.state().failed;
    expect(failed?.tests).toEqual([shown, `${PREFIX}short`]);
    expect(failed?.tests?.[0]).toHaveLength(298);
    const all = [readFileSync(f.file, "utf8"), t.logs.join("\n"), t.u.view().update?.text ?? ""].join("\n");
    expect(all).not.toContain(HIDDEN);
    expect(all).not.toContain("scf-tests-start-");
    expect(all).not.toContain(HIDDEN.slice(0, 6));
    expect(failed?.tests?.join("\n")).not.toContain("yyy"); // the over-long name is dropped from the names

    const g = fixture();
    g.publish({ "test.sh": FAILING });
    const u = updater(g, {
      retryWaitMs: 0,
      redact: () => {
        throw new Error("no");
      },
    });
    for (let i = 0; i < 3; i++) await u.u.tick(true);
    expect(g.state().failed?.tests).toBeUndefined();
    expect(g.state().failed?.lines).toEqual(["the output is not shown"]);
    expect(existsSync(g.stage)).toBe(false);
  });
});

describe("self-update: the tests run in a test slot", () => {
  it("holds a slot during the run and frees it afterwards", async () => {
    const f = fixture();
    const slots = join(f.root, "data", "test-slots");
    const v2 = f.publish({ "test.sh": `ls "${slots}" > "${join(f.root, "seen")}"\nexit 0\n` });
    const t = updater(f);
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2);
    expect(readFileSync(join(f.root, "seen"), "utf8")).toContain("slot-1");
    expect(existsSync(join(slots, "slot-1"))).toBe(false);
  });

  it("runs the tests anyway when both slots are held and no wait is left", async () => {
    const f = fixture();
    const slots = join(f.root, "data", "test-slots");
    for (const n of ["slot-1", "slot-2"]) {
      mkdirSync(join(slots, n), { recursive: true });
      writeFileSync(join(slots, n, "pid"), String(process.pid));
    }
    const v2 = f.publish({ "test.sh": "# v2\nexit 0\n" });
    const t = updater(f, { slot: { waitSec: 0, pollMs: 50 } });
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2);
  });

  it("counts a test run that times out as a failed try", async () => {
    const f = fixture();
    f.publish({ "test.sh": "sleep 30\n" });
    const t = updater(f, { steps: STEPS.map((s) => (s.name === "test" ? { ...s, timeoutMs: 400 } : s)) });
    const t0 = Date.now();
    await t.u.tick(true);
    expect(existsSync(join(f.root, "data", "test-slots", "slot-1"))).toBe(false); // the killed run freed its slot
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(f.state().retry?.tries).toBe(1);
    expect(f.state().tested).toBeUndefined();
    expect(existsSync(f.stage)).toBe(false);
  });
});
