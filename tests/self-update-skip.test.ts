import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStep } from "../src/self-update-state.js";
import { testedKey } from "../src/self-update-tests.js";
import { fixture, git, removeFixtures, STEPS, updater, type Fx } from "./helpers/self-update.js";

vi.setConfig({ testTimeout: 60_000 });
afterEach(removeFixtures);

const NPM_STEPS: UpdateStep[] = STEPS.map((s) => (s.name === "test" ? { name: "test", cmd: "npm", args: ["test"] } : s));
const FULL = "npm ci && npm test";
const SKIPPED = "is not tested again";

// the tests touch a marker outside the worktree, so a test run can be seen
const publish = (f: Fx, extra: Record<string, string> = {}) =>
  f.publish({ "package.json": '{"scripts":{"test":"sh test.sh"}}', "test.sh": `touch "${join(f.root, "ran")}"\n`, "app.txt": "v2\n", ...extra });
const ran = (f: Fx) => existsSync(join(f.root, "ran"));
const record = (f: Fx, commit: string, cmd: string, content = "run r1, 2026-01-01T00:00Z, tree TREE\n") => {
  const tree = git(f.seed, "rev-parse", `${commit}^{tree}`);
  mkdirSync(join(f.root, "data", "tested"), { recursive: true });
  const p = join(f.root, "data", "tested", testedKey(tree, cmd));
  writeFileSync(p, content.replace("TREE", tree));
  return p;
};

describe("self-update: tests the release check already passed", () => {
  it("skips the tests on a matching record, but installs and builds", async () => {
    const f = fixture();
    const v2 = publish(f);
    record(f, v2, FULL);
    const t = updater(f, { steps: NPM_STEPS });
    await t.u.tick(true);
    expect(t.logs.filter((l) => l.includes(SKIPPED))).toEqual([`self-update: ${v2.slice(0, 7)} is not tested again: the release check passed these tests on this code (run r1, 2026-01-01T00:00Z)`]);
    expect(ran(f)).toBe(false);
    expect(f.state().tested?.commit).toBe(v2);
    expect(t.drained).toBe(1);
  });

  const cases: Record<string, (f: Fx, v2: string) => Partial<Parameters<typeof updater>[1]> | void> = {
    "a story record": (f, v2) => void record(f, v2, FULL, "run r1, 2026-01-01T00:00Z\n"),
    "another tree": (f, v2) => void record(f, v2, FULL, `run r1, 2026-01-01T00:00Z, tree ${"a".repeat(40)}\n`),
    "a record of another command": (f, v2) => void record(f, v2, "npm test"),
    "a pin of true": (f, v2) => void record(f, v2, "true"),
    "a pin equal to the detected command": (f, v2) => void record(f, v2, FULL),
    "a pin equal to the bare step": (f, v2) => void record(f, v2, "npm test"),
    "no detected command": (f, v2) => { record(f, v2, FULL); return { testCmd: () => undefined }; },
    "a detection that throws": (f, v2) => { record(f, v2, FULL); return { testCmd: () => { throw new Error("x"); } }; },
    "a detection that rejects": (f, v2) => { record(f, v2, FULL); return { testCmd: () => Promise.reject(new Error("x")) }; },
    "a folder at the path": (f, v2) => {
      const tree = git(f.seed, "rev-parse", `${v2}^{tree}`);
      mkdirSync(join(f.root, "data", "tested", testedKey(tree, FULL)), { recursive: true });
    },
    "no file": () => undefined,
    "other content": (f, v2) => void record(f, v2, FULL, "garbage $(secret)\n"),
  };
  for (const [name, setup] of Object.entries(cases)) {
    it(`runs the tests with ${name}`, async () => {
      const f = fixture();
      const extra: Record<string, string> = {};
      if (name === "a pin of true") extra[".claude-factory/config.yaml"] = 'vars:\n  test_cmd: "true"\n';
      if (name === "a pin equal to the detected command") extra[".claude-factory/config.yaml"] = `vars:\n  test_cmd: ${FULL}\n`;
      if (name === "a pin equal to the bare step") extra[".claude-factory/config.yaml"] = "vars:\n  test_cmd: npm test\n";
      const v2 = publish(f, extra);
      const over = setup(f, v2) ?? {};
      const t = updater(f, { steps: NPM_STEPS, ...over });
      await t.u.tick(true);
      expect(ran(f)).toBe(true);
      expect(t.logs.some((l) => l.includes(SKIPPED))).toBe(false);
      expect(t.logs.some((l) => l.includes("secret"))).toBe(false);
      expect(f.state().tested?.commit).toBe(v2);
    });
  }

  it("a skip does not hide a broken build", async () => {
    const f = fixture();
    const v2 = publish(f, { "build.sh": "echo build broke\nexit 1\n" });
    record(f, v2, FULL);
    const t = updater(f, { steps: NPM_STEPS });
    await t.u.tick(true);
    expect(f.state().failed?.stage).toBe("build");
    expect(f.state().tested).toBeUndefined();
    expect(ran(f)).toBe(false);
  });

  for (const [name, value, withRecord] of [["with a record", FULL, true], ["without a record", undefined, false]] as const) {
    it(`a stop while the check is prepared ends the update (${name})`, async () => {
      const f = fixture();
      const v2 = publish(f);
      if (withRecord) record(f, v2, FULL);
      let stop = () => {};
      const t = updater(f, { steps: NPM_STEPS, testCmd: () => { stop(); return value; } });
      stop = () => t.u.stop();
      await t.u.tick(true);
      expect(ran(f)).toBe(false);
      expect(f.state().tested).toBeUndefined();
      expect(f.state().failed).toBeUndefined();
      expect(t.drained).toBe(0);
      expect(t.logs.some((l) => l.includes(SKIPPED))).toBe(false);
      expect(existsSync(f.stage)).toBe(false);
    });
  }
});
