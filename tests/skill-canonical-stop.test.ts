import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";

const BLOCKED = 'skills not resolved: Two or more skills provide "cap" and only age or name separates them: a@1.0.0, b@1.0.0. Pin one of them for this capability, then run again.';
vi.mock("../src/skills/run-catalogue.js", async (orig) => ({
  ...(await orig<typeof import("../src/skills/run-catalogue.js")>()),
  runSkillCatalogue: () => ({ text: "", log: "skill catalogue: none (skill selection stopped)", blocked: BLOCKED }),
}));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "canonical-stop-"));
  mkdirSync(join(tmp, "repo"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("a blocked skill catalogue", () => {
  it("fails the step before any agent starts", async () => {
    const yaml = `
name: t
workspace: inplace
steps:
  - id: plan
    type: claude
    skills: catalog
    permission_mode: dontAsk
    allowed_tools: [Read]
    prompt: "SHOWPROMPT"
`;
    // A claude binary that does not exist: the step can only fail through the stop, not through the agent.
    const s = await runFlow(parseFlow(yaml), {
      task: "t", repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin: join(tmp, "no-such-claude"), codexBin: resolve("tests/fixtures/fake-codex.mjs"),
      config: ConfigSchema.parse({}),
    });
    expect(s.status).toBe("failed");
    expect(s.history[0]!.output).toBe(BLOCKED);
    expect(readFileSync(liveLogFile(s.runDir), "utf8")).toContain(`    ! ${BLOCKED}`);
  });
});
