import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_HOME_REFUSED } from "../src/agents/codex-home.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";

// The private Codex folder cannot be made.
vi.mock("../src/engine/os-sandbox.js", async (orig) => ({
  ...(await orig<typeof import("../src/engine/os-sandbox.js")>()),
  ownDir: () => {
    throw new Error("disk full");
  },
}));

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const savedHome = process.env.CODEX_HOME;
const savedKey = process.env.CODEX_API_KEY;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cx-refuse-"));
  mkdirSync(join(tmp, "repo"));
  mkdirSync(join(tmp, "personal"));
  process.env.CODEX_HOME = join(tmp, "personal");
  delete process.env.CODEX_API_KEY;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  if (savedKey === undefined) delete process.env.CODEX_API_KEY;
  else process.env.CODEX_API_KEY = savedKey;
  rmSync(tmp, { recursive: true, force: true });
});

describe("a private Codex folder that cannot be made", () => {
  it("refuses the step with one final failure: no Codex, no fallback, no personal folder", async () => {
    const marker = join(tmp, "codex-started");
    const codexBin = join(tmp, "codex-never");
    const config = ConfigSchema.parse({ protected_branches: [], router: { fallback: ["claude"], fallback_on: ["rate_limit"] } });
    const flow = parseFlow(`
name: t
workspace: inplace
steps:
  - {id: x, type: claude, model: "codex:ollama:m", prompt: "SHOWCODEXHOME"}
`);
    const s = await runFlow(flow, { task: "t", repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin, codexBin, config });
    expect(s.status).toBe("failed");
    expect(s.reason ?? "").toContain(CODEX_HOME_REFUSED);
    const tries = s.history.filter((h) => h.id === "x");
    expect(tries).toHaveLength(1);
    expect(tries[0]!.output).toContain(CODEX_HOME_REFUSED);
    expect(existsSync(marker)).toBe(false); // the program does not even exist: it was never started
    const log = readFileSync(liveLogFile(s.runDir), "utf8");
    expect(log).not.toContain("agent codex");
    expect(log).not.toMatch(/fall(ing)? ?back/i);
    expect(log).not.toContain("Codex:");
  });
});
