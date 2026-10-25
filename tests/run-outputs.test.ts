import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { readRunOutputs, writeRunOutputs, OUTPUTS_FILE } from "../src/engine/run-outputs.js";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { userRun } from "../src/server/user-view.js";

describe("run outputs", () => {
  let dir: string;
  let log: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-outputs-"));
    log = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (v: unknown) => writeFileSync(join(dir, OUTPUTS_FILE), typeof v === "string" ? v : JSON.stringify(v));
  const read = () => readRunOutputs(dir, (l) => void log.push(l));

  it("reads a valid file", () => {
    put({ release_url: "https://github.com/acme/app/releases/tag/v1", release_tag: "v1" });
    expect(read()).toEqual({ release_url: "https://github.com/acme/app/releases/tag/v1", release_tag: "v1" });
    expect(log).toEqual([]);
  });

  it("has nothing when there is no file", () => {
    expect(read()).toBeUndefined();
    expect(log).toEqual([]);
  });

  it("ignores a file that is not valid, with one log line", () => {
    const bad: unknown[] = [
      "{not json",
      [],
      { Bad: "x" },
      { "1a": "x" },
      { a: 1 },
      { a: "x".repeat(2001) },
      { a: "line\nbreak" },
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])),
    ];
    for (const b of bad) {
      log = [];
      put(b as string);
      expect(read(), JSON.stringify(b).slice(0, 40)).toBeUndefined();
      expect(log).toHaveLength(1);
      expect(log[0]).toContain("outputs.json ignored");
    }
  });

  it("accepts 20 keys", () => {
    put(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v"])));
    expect(Object.keys(read()!)).toHaveLength(20);
  });

  it("does not read a symlink", () => {
    writeFileSync(join(dir, "real.json"), JSON.stringify({ a: "b" }));
    symlinkSync(join(dir, "real.json"), join(dir, OUTPUTS_FILE));
    expect(read()).toBeUndefined();
  });

  it("writes by merging and refuses a bad key or value", () => {
    writeRunOutputs(dir, { a: "1" });
    writeRunOutputs(dir, { b: "2" });
    writeRunOutputs(dir, { a: "3" });
    expect(JSON.parse(readFileSync(join(dir, OUTPUTS_FILE), "utf8"))).toEqual({ a: "3", b: "2" });
    expect(() => writeRunOutputs(dir, { "Bad Key": "x" })).toThrow(/outputs:/);
    expect(() => writeRunOutputs(dir, { a: "x\ny" })).toThrow(/control characters/);
    expect(JSON.parse(readFileSync(join(dir, OUTPUTS_FILE), "utf8"))).toEqual({ a: "3", b: "2" });
  });

  it("shows the outputs in the view of a user", () => {
    const s = { runId: "r1", flow: "release-build", task: "", status: "succeeded", startedAt: "2026-10-18T00:00:00Z", vars: {}, history: [], state: { next: null }, outputs: { release_url: "https://github.com/a/b/releases/tag/x", release_files: "a (1 B)" } };
    expect(userRun(s as never).outputs).toEqual(s.outputs);
    expect(userRun({ ...s, outputs: undefined } as never).outputs).toBeUndefined();
  });

  it("puts what a step wrote into the summary of the run", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const round = { id: "0123456789abcdef", issue: 7, at: "2026-10-25T10:00:00.000Z", source: "planner", outcome: "went_on", questions: [{ n: 1, title: "Which db?", text: "t", decision: "pg" }] };
    writeFileSync(join(dir, "d.json"), JSON.stringify({ version: 1, rounds: [round] }));
    const flow = parseFlow(
      [
        "name: outputs",
        "workspace: empty",
        "steps:",
        "  - id: a",
        "    type: shell",
        `    run: 'printf "{\\"release_url\\": \\"https://github.com/acme/app/releases/tag/v1\\"}" > "{{run.dir}}/outputs.json" && cp "${join(dir, "d.json")}" "{{run.dir}}/decided.json"'`,
        "  - {id: b, type: shell, run: 'true'}",
        "",
      ].join("\n"),
    );
    const s = await runFlow(flow, {
      task: "", repo, runsDir: join(dir, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), config: ConfigSchema.parse({ protected_branches: [] }),
    });
    expect(s.status, s.reason).toBe("succeeded");
    expect(s.outputs).toEqual({ release_url: "https://github.com/acme/app/releases/tag/v1" });
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).outputs).toEqual(s.outputs);
    expect(s.decidedQuestions).toEqual([round]);
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).decidedQuestions).toEqual([round]);
  });
});
