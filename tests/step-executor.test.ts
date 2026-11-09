import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRedactor } from "../src/credentials/redact.js";
import { localExecutor, runProcess } from "../src/steps/process.js";

// Every step process starts through the executor seam (#785): the plugin point for a remote executor later.

describe("the step executor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is local, and runProcess starts the child through it", async () => {
    expect(localExecutor.where).toBe("local");
    const spy = vi.spyOn(localExecutor, "start");
    const dir = mkdtempSync(join(tmpdir(), "step-executor-"));
    try {
      const r = await runProcess("/bin/echo", ["x"], { cwd: dir, env: {}, logFile: join(dir, "step.log"), redactor: makeRedactor(["not-a-secret-value"]) });
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ cmd: "/bin/echo", args: ["x"] });
  });

  it("is the only place that starts a process: no other file of the steps, the agents or the engine uses spawn", () => {
    const hits: string[] = [];
    for (const dir of ["src/steps", "src/agents", "src/engine"]) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        if (dir === "src/steps" && f === "process.ts") continue;
        if (/\bspawn\b/.test(readFileSync(join(dir, f), "utf8"))) hits.push(`${dir}/${f}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
