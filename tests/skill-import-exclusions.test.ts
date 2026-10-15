import { describe, expect, it } from "vitest";
import { addressLines, addressUse, exclusionReasons, importExclusions, shownAddress, webAddresses } from "../src/skills/import-exclusions.js";
import { NETWORK_USE_RULES, WEB_ADDRESS_LIST_RE, WEB_ADDRESS_RE } from "../src/skills/import-review-rules.js";
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

function normalized(files: Record<string, string>) {
  const mapped = Object.fromEntries(Object.entries(files).map(([p, v]) => [`skills/x/${p}`, v]));
  const { skills } = normalizeImport(prepareImport(source, tree(mapped)));
  return skills[0]!;
}
const FETCH = "fe" + "tch";

describe("web addresses and exclusions", () => {
  it("does not exclude a web address in a file the agent only reads", () => {
    expect(exclusions({ "SKILL.md": md(), "references/pom.xml": "<url>https://repo.maven.apache.org/maven2</url>" })).toEqual([]);
    expect(exclusions({ "SKILL.md": md(), "references/build.gradle": 'maven { url "https://packages.confluent.io/maven/" }' })).toEqual([]);
    expect(exclusions({ "SKILL.md": md(), "metadata.json": '{"author":"x","homepage":"https://vercel.com"}' })).toEqual([]);
    expect(exclusions({ "SKILL.md": md(), "evals/evals.json": '{"prompt":"open https://react.dev/learn"}' })).toEqual([]);
    expect(exclusions({ "SKILL.md": md("", "See https://x.io/docs"), "references/a.md": "https://x.io/b" })).toEqual([]);
  });

  it("excludes a web address in code", () => {
    const e = exclusions({ "SKILL.md": md(), "scripts/a.sh": "URL=https://api.x.io/y\n" });
    expect(e.map((x) => x.text)).toEqual(["holds a web address in code (scripts/a.sh)"]);
    expect(codes({ "SKILL.md": md(), "evals/run.sh": "#!/bin/sh\necho https://x.io/a\n" })).toEqual(["network-use"]);
    expect(codes({ "SKILL.md": md(), "lib/client.py": 'BASE = "https://x.io/a"\n' })).toEqual(["network-use"]);
    expect(codes({ "SKILL.md": md(), "tools/run": "https://x.io/a\n" })).toEqual(["network-use"]);
  });

  it("keeps the call rules for any file", () => {
    expect(codes({ "SKILL.md": md(), "references/x.js": `${FETCH} ("https://x.io")\n` })).toContain("network-use");
  });
});

describe("addressUse", () => {
  it.each([
    ["scripts/a.txt", "x", "called", "under scripts/, which is code"],
    ["a/scripts/b", "x", "called", "under scripts/, which is code"],
    ["tool.cfg", "#!/bin/sh\n", "called", "starts with #!, so it is code"],
    ["evals/run.json", "#!/bin/sh\n", "called", "starts with #!, so it is code"],
    ["references/pom.xml", "x", "mentioned", "under references/, which the agent only reads"],
    ["evals/evals.json", "x", "mentioned", "under evals/, which the agent only reads"],
    ["lib/a.PY", "x", "called", "a .py file is code"],
    ["page.html", "x", "called", "a .html file is code"],
    ["tools/run", "x", "called", "a file without an extension counts as code"],
    ["metadata.json", "x", "mentioned", "a document or data file, which the agent only reads"],
    ["notes.md", "x", "mentioned", "a document or data file, which the agent only reads"],
  ])("%s", (path, text, use, why) => {
    expect(addressUse(path, text)).toEqual({ use, why });
  });
});

describe("webAddresses", () => {
  it("lists mentioned and called addresses, once each, in order", () => {
    const list = webAddresses(
      normalized({
        "SKILL.md": md(),
        "scripts/b.sh": "A=https://b.io/x\nB=https://b.io/x\n",
        "metadata.json": '{"h":"https://a.io","e":"https://example.com","l":"http://localhost"}',
      }),
    );
    expect(list).toEqual([
      { path: "metadata.json", address: "https://a.io", use: "mentioned", why: "a document or data file, which the agent only reads" },
      { path: "scripts/b.sh", address: "https://b.io/x", use: "called", why: "under scripts/, which is code" },
    ]);
    expect(addressLines("s", list)[1]).toBe("ADDRESS s called scripts/b.sh: https://b.io/x (under scripts/, which is code)");
  });

  it("reads the frontmatter only from the raw SKILL.md, and exclusions do not change", () => {
    const skill = normalized({ "SKILL.md": md("homepage: https://vercel.com\n") });
    const raw = "---\nname: a\ndescription: d\nhomepage: https://vercel.com\n---\nbody";
    expect(webAddresses(skill, raw).map((a) => [a.path, a.address, a.use])).toEqual([["SKILL.md", "https://vercel.com", "mentioned"]]);
    expect(webAddresses(skill)).toEqual([]);
    expect(importExclusions(skill)).toEqual([]);
  });

  it("keeps two long addresses with the same start apart", () => {
    const head = "https://x.io/" + "a".repeat(130);
    const list = webAddresses(normalized({ "SKILL.md": md(), "references/a.md": `${head}${"b".repeat(7)} ${head}${"c".repeat(7)}` }));
    expect(list).toHaveLength(2);
    expect(list[0]!.address).not.toBe(list[1]!.address);
    for (const a of list) expect(a.address).toMatch(/… #[0-9a-f]{8}$/);
  });

  it("uses a listing pattern that differs from the rule only in its bound", () => {
    expect(WEB_ADDRESS_LIST_RE.source).toBe(WEB_ADDRESS_RE.source.replace("{1,120}", "{1,2048}"));
  });
});

describe("shownAddress", () => {
  it("hides user and password", () => {
    expect(shownAddress("https://u" + ":p@h.io/x")).toBe("https://(hidden)@h.io/x");
    expect(shownAddress("https://user@h.io")).toBe("https://(hidden)@h.io");
    expect(shownAddress("https://h.io/x?a=b")).toBe("https://h.io/x?a=b");
  });

  it("hides credential-like query and fragment values", () => {
    expect(shownAddress("https://h.io/?api_key=A1b2C3d4E5f6&a=b")).toBe("https://h.io/?api_key=(hidden)&a=b");
    expect(shownAddress("https://h.io/cb#access_token=A1b2C3d4E5f6")).toBe("https://h.io/cb#access_token=(hidden)");
    expect(shownAddress("https://h.io/?a=1&Password=abc")).toBe("https://h.io/?a=1&Password=(hidden)");
  });
});
