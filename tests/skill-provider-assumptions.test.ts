import { describe, expect, it } from "vitest";
import { normalizeSkill } from "../src/skills/normalize.js";
import { providerAssumptions } from "../src/skills/provider-assumptions.js";

const a = (instructions: string, requiredTools: string[] = [], compatibility?: string) =>
  providerAssumptions({ requiredTools, instructions, ...(compatibility === undefined ? {} : { compatibility }) });

describe("providerAssumptions", () => {
  it("finds each code alone", () => {
    expect(a("Plain text.", ["Bash"])).toEqual(["claude-tools"]);
    expect(a("Use mcp__github__search.")).toEqual(["mcp-servers"]);
    expect(a("Works in Claude Code.")).toEqual(["claude-surface"]);
    expect(a("Call api.anthropic.com.")).toEqual(["anthropic-api"]);
  });

  it("returns all four in a fixed order", () => {
    expect(a("Use WebFetch with mcp__x__y on claude.ai and ANTHROPIC_API_KEY.")).toEqual(["claude-tools", "mcp-servers", "claude-surface", "anthropic-api"]);
  });

  it("returns none for a plain skill", () => {
    expect(a("Summarise the text.")).toEqual([]);
  });

  it("counts an MCP tool as mcp-servers and not as claude-tools", () => {
    expect(a("Plain.", ["mcp__github__search"])).toEqual(["mcp-servers"]);
  });

  it("reads compatibility", () => {
    expect(a("Plain.", [], "Designed for Claude Desktop")).toEqual(["claude-surface"]);
  });

  it.each(["Use WebFetch to load a page.", "Keep a list with TodoWrite.", "Use the `Read` tool.", "Run the Bash tool."])("sees a tool in %s", (t) => {
    expect(a(t)).toEqual(["claude-tools"]);
  });

  it.each(["Read the file.", "Write a summary.", "Run a bash script.", "Use webfetch.", "Claude is an assistant."])("ignores %s", (t) => {
    expect(a(t)).toEqual([]);
  });

  it("finishes fast on a 64 KiB text", () => {
    const start = performance.now();
    a("`".repeat(65536));
    a("Read ".repeat(13000));
    a("mcp__" + "a".repeat(65000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("provenance.assumes", () => {
  const norm = (extra: string, body: string) =>
    normalizeSkill(
      { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) },
      { root: "skills/x", files: [{ path: "SKILL.md", content: Buffer.from(`---\nname: x\ndescription: A skill.\n${extra}---\n\n${body}\n`) }] },
    );
  it("is set from the instructions and grants no tool", () => {
    const r = norm("", "Use WebFetch to load a page.");
    if (!r.ok) throw new Error(r.reasons.join());
    expect(r.skill.provenance.assumes).toEqual(["claude-tools"]);
    expect(r.skill.provenance.requiredTools).toEqual([]);
    expect(r.skill.package.allowedTools).toBeUndefined();
    expect(r.skill.package.tool_profile?.network).toBeFalsy();
  });
  it("is absent when nothing was found", () => {
    const r = norm("", "Body.");
    if (!r.ok) throw new Error(r.reasons.join());
    expect(r.skill.provenance).not.toHaveProperty("assumes");
  });
});
