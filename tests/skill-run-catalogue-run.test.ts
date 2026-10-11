import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { addSkillPins } from "../src/skills/lock.js";
import { loadSkillPackage } from "../src/skills/package.js";

// `skills: catalog` steps in a run: the catalogue reaches both agents the same way, once, and never stops the step.

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
let tmp: string;
let repo: string;
let low: string;
let config = ConfigSchema.parse({});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "catalogue-run-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  low = join(tmp, "skills");
  config = ConfigSchema.parse({ skills: { roots: [low] } });
  const d = join(low, "demo");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), "---\nname: demo\ndescription: A test skill.\n---\n\nDo it.\n");
  writeFileSync(join(d, "skill.yaml"), "id: demo\nversion: 1.0.0\n");
  addSkillPins([{ key: "demo@1.0.0", digest: loadSkillPackage(d).digest }]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const OPEN = "<foundry-skill-catalogue>";
const planner = (agent: string, extra = "", head = "") => `
name: t
workspace: inplace
${head}steps:
  - id: plan
    type: claude
${agent}    skills: catalog
    permission_mode: dontAsk
    allowed_tools: [Read, Glob, Grep]
    prompt: "SHOWPROMPT${extra}"
`;
const run = (yaml: string, over: Record<string, unknown> = {}) =>
  runFlow(parseFlow(yaml), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, codexBin, config, ...over });
const block = (out: string) => out.slice(out.indexOf(OPEN), out.indexOf("</foundry-skill-catalogue>") + "</foundry-skill-catalogue>".length);
const logOf = (s: { runDir: string }) => readFileSync(liveLogFile(s.runDir), "utf8");
const lineCount = (s: { runDir: string }) => logOf(s).split("skill catalogue:").length - 1;

describe("a skills: catalog step", () => {
  it("gives Claude and Codex the same one block before the task, and no skill block", async () => {
    const got = [];
    for (const agent of ["", "    agent: codex\n"]) {
      const s = await run(planner(agent));
      expect(s.status).toBe("succeeded");
      const rec = s.history[0]!;
      const out = rec.output;
      expect(out.split(OPEN)).toHaveLength(2);
      expect(out.indexOf(OPEN)).toBeLessThan(out.lastIndexOf("SHOWPROMPT"));
      expect(out).not.toContain("<foundry-skills count=");
      expect(out).toContain('"id":"demo"');
      expect(rec.skills).toBeUndefined();
      expect(rec.skillCatalogue).toMatchObject({ entries: 1, omitted: 0 });
      expect(lineCount(s)).toBe(1);
      got.push({ text: block(out), record: rec.skillCatalogue });
    }
    expect(got[0]).toEqual(got[1]);
  });

  it.each(["{mode: off}", "{mode: explicit, ids: [demo]}"])("still gets the block in a flow with skills: %s", async (mode) => {
    const s = await run(planner("", "", `skills: ${mode}\n`));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.output).toContain('"id":"demo"');
    expect(s.history[0]!.skillCatalogue?.entries).toBe(1);
  });

  it("logs one line also when the step is tried again", async () => {
    const marker = join(tmp, "seen");
    const s = await run(planner("    agent: codex\n", `\\nCODEX_CAPACITY_ONCE ${marker}`));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.retried).toEqual({ blips: 1, models: 0 });
    expect(lineCount(s)).toBe(1);
    expect(s.history[0]!.output).toContain('"id":"demo"');
  });

  it("runs without a block when the catalogue cannot be built, and says why", async () => {
    (config.skills as { roots: unknown }).roots = null; // a registry that cannot be read
    const s = await run(planner(""));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.output).not.toContain(OPEN);
    expect(s.history[0]!.skillCatalogue).toBeUndefined();
    expect(logOf(s)).toContain("skill catalogue: none (the catalogue could not be built)");
    expect(lineCount(s)).toBe(1);
  });

  it("does not resume a session that may hold a skill block", async () => {
    const yaml = `
name: t
workspace: inplace
steps:
  - id: impl
    type: claude
    prompt: "SAY done"
  - id: plan
    type: claude
    resume: impl
    skills: catalog
    permission_mode: dontAsk
    allowed_tools: [Read]
    prompt: "SHOWPROMPT"
`;
    const s = await run(yaml);
    expect(s.status).toBe("succeeded");
    expect(logOf(s)).toContain("not resuming impl: this step has skills: catalog");
    expect(s.history[1]!.output).not.toContain("--resume");
  });
});
