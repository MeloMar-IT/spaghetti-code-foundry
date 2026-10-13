import { describe, expect, it } from "vitest";
import { exclusionReasons, importExclusions } from "../src/skills/import-exclusions.js";
import { NETWORK_USE_RULES } from "../src/skills/import-review-rules.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { normalizeImport } from "../src/skills/normalize.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const md = (extra = "", body = "Body.") => `---\nname: x\ndescription: A skill called x.\n${extra}---\n\n${body}\n`;
const MARKER = "marker-line-xyz";

function tree(files: Record<string, string | Buffer>): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return { list: (p) => all.filter((e) => e.path === p || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => content.get(e.path)!) };
}
const source: SkillLibrarySource = {
  id: "lib",
  repository: "https://github.com/example/skills",
  repositoryKey: "github.com/example/skills",
  status: "enabled",
  ref: { approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
};
/** The exclusions of the one skill `x` made from these files (paths below `skills/x/`). */
function exclusions(files: Record<string, string | Buffer>) {
  const mapped = Object.fromEntries(Object.entries(files).map(([p, v]) => [`skills/x/${p}`, v]));
  const { skills, report } = normalizeImport(prepareImport(source, tree(mapped)));
  if (skills.length !== 1) throw new Error("not normalized: " + JSON.stringify(report.quarantined));
  return importExclusions(skills[0]!);
}
const codes = (files: Record<string, string | Buffer>) => exclusions(files).map((x) => x.code);

describe("importExclusions", () => {
  it("lets a plain skill and a local script through", () => {
    expect(exclusions({ "SKILL.md": md() })).toEqual([]);
    expect(exclusions({ "SKILL.md": md(), "scripts/a.sh": "#!/bin/sh\nls -la\ngit status\n" })).toEqual([]);
  });

  it("refuses connectors, network and unlisted tools", () => {
    const c = exclusions({ "SKILL.md": md("allowed-tools: mcp__github__create_pr\n") });
    expect(c.map((x) => x.code)).toContain("connector");
    expect(c.find((x) => x.code === "connector")!.text).toContain("github");
    expect(codes({ "SKILL.md": md(), "skill.yaml": "connectors: [jira]\n" })).toContain("connector");
    expect(codes({ "SKILL.md": md("allowed-tools: WebFetch\n") })).toContain("network");
    expect(codes({ "SKILL.md": md("allowed-tools: SomethingUnlisted\n") })).toContain("network");
    expect(codes({ "SKILL.md": md(), "skill.yaml": "tool_profile: { network: true }\n" })).toContain("network");
  });

  it("finds network use in scripts and instructions", () => {
    expect(codes({ "SKILL.md": md(), "scripts/a.sh": "curl https://api.github.com/x\n" })).toContain("network-use");
    expect(codes({ "SKILL.md": md("allowed-tools: Bash\n", "Run `curl -s https://example.com/x`.") })).toContain("network-use");
    expect(codes({ "SKILL.md": md("", "Run `gh pr create`.") })).toContain("network-use");
    expect(codes({ "SKILL.md": md(), "scripts/a.py": "import requests\nrequests.get('x')\n" })).toContain("network-use");
    expect(codes({ "SKILL.md": md(), "scripts/a.sh": "git push origin main\n" })).toContain("network-use");
    expect(codes({ "SKILL.md": md("allowed-tools: Bash\n", "Run git push origin main.") })).toContain("network-use");
    expect(codes({ "SKILL.md": md("allowed-tools: Bash\n"), "references/x.md": "Run git push origin main." })).toContain("network-use");
  });

  it("does not refuse links, prose or local addresses", () => {
    expect(exclusions({ "SKILL.md": md("", "Then git push the branch."), "references/x.md": "See https://docs.example.org/page for more." })).toEqual([]);
    expect(exclusions({ "SKILL.md": md(), "scripts/a.sh": "echo http://localhost:3000\n" })).toEqual([]);
  });

  it("skips a file that is not text, and never shows the matched line", () => {
    expect(exclusions({ "SKILL.md": md(), "assets/b.bin": Buffer.from([0xff, 0xfe, 0x00, 0x01]) })).toEqual([]);
    const found = exclusions({ "SKILL.md": md(), "scripts/a.sh": `curl https://api.x.io/y?q=${MARKER}\n` });
    const text = JSON.stringify(found);
    expect(text).toContain("scripts/a.sh");
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("api.x.io");
  });

  it("finds MCP and plugin files and keys", () => {
    expect(codes({ "SKILL.md": md(), ".mcp.json": "{}" })).toContain("mcp-config");
    expect(codes({ "SKILL.md": md(), "references/.MCP.JSON": "{}" })).toContain("mcp-config");
    expect(codes({ "SKILL.md": md(), "plugin.json": "{}" })).toContain("plugin-file");
    expect(codes({ "SKILL.md": md(), "assets/.plugin/x.json": "{}" })).toContain("plugin-file");
    expect(codes({ "SKILL.md": md("mcp_tools: [a]\n") })).toContain("integration-key");
    expect(codes({ "SKILL.md": md("metadata:\n  mcp_tools: a\n") })).toContain("integration-key");
    expect(codes({ "SKILL.md": md(), "skill.yaml": "mcp_tools: [a]\n" })).toContain("integration-key");
    expect(exclusions({ "SKILL.md": md("triggers: [a, b]\n") })).toEqual([]);
  });

  it("orders causes by code without duplicates, and bounds the reasons", () => {
    const found = exclusions({ "SKILL.md": md("allowed-tools: mcp__a__b\n"), ".mcp.json": "{}", "scripts/a.sh": "curl x\nwget y\n" });
    const order = found.map((x) => x.code);
    expect(order).toEqual([...order].sort((a, b) => ["connector", "network", "network-use", "plugin-file", "mcp-config", "integration-key"].indexOf(a) - ["connector", "network", "network-use", "plugin-file", "mcp-config", "integration-key"].indexOf(b)));
    expect(new Set(found.map((x) => x.code + x.text)).size).toBe(found.length);
    const many = Array.from({ length: 100 }, (_, i) => ({ code: "network-use" as const, text: `reason ${i}` }));
    expect(exclusionReasons(many).length).toBeLessThan(100);
  });

  it("prints a path with a control character escaped", () => {
    const [x] = exclusionReasons([{ code: "mcp-config", text: "ships MCP configuration (a\u0007b)" }]);
    expect(x).toContain("ships MCP configuration");
  });

  it("every network-use pattern finishes fast on a long line", () => {
    for (const rule of NETWORK_USE_RULES) {
      for (const filler of ["a", " ", "http://", "git ", "requests.", "gh "]) {
        const line = filler.repeat(Math.ceil(100000 / filler.length));
        const t = performance.now();
        rule.re.test(line);
        expect(performance.now() - t).toBeLessThan(500);
      }
    }
  });
});
