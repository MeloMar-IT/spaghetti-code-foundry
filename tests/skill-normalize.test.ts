import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillImportError, prepareImport, type TreeEntry } from "../src/skills/import-plan.js";
import {
  quarantineReport, normalizeImport, normalizeSkill, sourceQualifiedId,
  type ExternalSkill, type NormalizeOrigin, type NormalizedSkill,
} from "../src/skills/normalize.js";
import { canonicalJson, plainProblem } from "../src/skills/normalize-values.js";
import { skillDigest } from "../src/skills/package.js";
import { SKILL_ID_RE, SKILL_VERSION_RE, ToolPolicySchema } from "../src/skills/schema.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";
import { checkSkillTools, skillNeeds, type Capabilities, type SkillToolNeed } from "../src/skills/tool-policy.js";

const COMMIT = "a".repeat(40);
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT };
const md = (name: string, extra = "", body = "Body.") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\n${body}\n`;
const ext = (files: Record<string, string>, root = "skills/x"): ExternalSkill => ({
  root,
  files: Object.entries(files).map(([path, text]) => ({ path, content: Buffer.from(text) })),
});
function good(files: Record<string, string>): NormalizedSkill {
  const r = normalizeSkill(ORIGIN, ext(files));
  if (!r.ok) throw new Error("expected a normalized skill: " + r.reasons.join("; "));
  return r.skill;
}
function reasons(files: Record<string, string>): string[] {
  const r = normalizeSkill(ORIGIN, ext(files));
  if (r.ok) throw new Error("expected a quarantined skill");
  return r.reasons;
}
const yamlOf = (name: string, extra: string, manifest: string) => ({ "SKILL.md": md(name, extra), "skill.yaml": manifest });

function readDir(dir: string, base = ""): { path: string; content: Uint8Array }[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const full = join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    return statSync(full).isDirectory() ? readDir(full, rel) : [{ path: rel, content: readFileSync(full) }];
  });
}
const fixture = (name: string): ExternalSkill => ({ root: name, files: readDir(join("tests/fixtures/skill-layouts", name)) });
const fixtureOk = (name: string): NormalizedSkill => {
  const r = normalizeSkill(ORIGIN, fixture(name));
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
};

// A prepared import over an in-memory tree.
function tree(files: Record<string, string>) {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, b]) => ({ path, kind: "file", size: b.byteLength, id: "id:" + path }));
  return {
    list: (p: string) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries: readonly TreeEntry[]) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
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
  ...over,
});
const prep = (files: Record<string, string>, over: Partial<SkillLibrarySource> = {}) => prepareImport(source(over), tree(files));

describe("plainProblem and canonicalJson", () => {
  it("accepts plain values", () => {
    expect(plainProblem({ a: [1, 1.5, true, null, "x"], b: { c: "d" } })).toBeUndefined();
  });
  it("refuses a cycle and a shared object", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(plainProblem(cyc)).toBe("holds the same value twice (a YAML alias)");
    const shared = { x: 1 };
    expect(plainProblem({ a: shared, b: shared })).toBe("holds the same value twice (a YAML alias)");
  });
  it("refuses numbers that cannot be kept", () => {
    expect(plainProblem(NaN)).toBe("holds a number that is not finite");
    expect(plainProblem([Infinity])).toBe("holds a number that is not finite");
    expect(plainProblem(2 ** 60)).toBe("holds an integer outside the safe range");
  });
  it("refuses other types", () => {
    const msg = "holds a value of a type that cannot be kept";
    expect(plainProblem(new Date())).toBe(msg);
    expect(plainProblem(new Uint8Array(2))).toBe(msg);
    expect(plainProblem(new Map())).toBe(msg);
    expect(plainProblem(10n)).toBe(msg);
  });
  it("limits depth and size", () => {
    const deep = (n: number): unknown => (n === 0 ? "x" : { k: deep(n - 1) });
    expect(plainProblem(deep(15))).toBeUndefined();
    expect(plainProblem(deep(17))).toBe("is nested deeper than 16 levels");
    expect(plainProblem(Array.from({ length: 1999 }, () => 1))).toBeUndefined();
    expect(plainProblem(Array.from({ length: 2001 }, () => 1))).toBe("holds more than 2000 values");
  });
  it("writes keys in byte order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("throws instead of writing null", () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
  });
});

describe("sourceQualifiedId", () => {
  const o = { source: "lib", repositoryKey: "github.com/example/skills" };
  it("gives a stable literal id", () => {
    expect(sourceQualifiedId(o, "notes")).toBe(sourceQualifiedId(o, "notes"));
    expect(sourceQualifiedId(o, "notes")).toMatch(/^lib-notes-[0-9a-f]{12}$/);
  });
  it("stays a valid id at the longest input", () => {
    const id = sourceQualifiedId({ source: "s".repeat(64), repositoryKey: "k" }, "n".repeat(64));
    expect(id).toMatch(SKILL_ID_RE);
    expect(id.length).toBeLessThanOrEqual(64);
  });
  it("tells ambiguous joins and repositories apart", () => {
    expect(sourceQualifiedId({ source: "a-b", repositoryKey: "k" }, "c")).not.toBe(sourceQualifiedId({ source: "a", repositoryKey: "k" }, "b-c"));
    expect(sourceQualifiedId(o, "notes")).not.toBe(sourceQualifiedId({ ...o, repositoryKey: "github.com/other/skills" }, "notes"));
  });
});

describe("layouts", () => {
  it("plain", () => {
    const s = fixtureOk("plain");
    expect(s.provenance.layout).toBe("plain");
    expect(s.provenance.name).toBe("notes");
    expect(s.package.id).toBe(sourceQualifiedId(ORIGIN, "notes"));
    expect(s.package).toMatchObject({
      version: `0.0.0-g${"a".repeat(12)}`, category: "general", capabilities: [], license: "MIT", risk: "low", connectors: [],
      tool_profile: { shell: false, network: false, filesystem: "read" }, roles: [], detectors: [], conflicts: [], dependencies: [],
    });
    expect(s.package.version).toMatch(SKILL_VERSION_RE);
    expect(s.provenance.versionDeclared).toBe(false);
    expect(s.extraFiles.map((f) => f.path)).toEqual(["LICENSE.txt", "reference.md"]);
    expect(s.provenance.entryPoints).toEqual({ instructions: "SKILL.md", scripts: [], documents: ["reference.md"] });
    expect(s.package.instructions).toBe("# Notes\n\nWrite the notes as a short list.");
  });
  it("metadata", () => {
    const s = fixtureOk("metadata");
    expect(s.provenance.layout).toBe("metadata");
    expect(s.package).toMatchObject({
      version: "1.2.0", capabilities: ["forms", "pdf"], risk: "medium", allowedTools: "Bash(git:*) Read",
      tool_profile: { shell: true, network: false, filesystem: "read" }, metadata: { author: "example-team", tags: "pdf, forms", version: "1.2" },
    });
    expect(s.provenance.versionDeclared).toBe(true);
    expect(s.provenance.requiredTools).toEqual(["Bash", "Read"]);
    expect(s.provenance.entryPoints.scripts).toEqual(["scripts/run.sh"]);
    expect(s.package.files.scripts.map((f) => f.path)).toEqual(["scripts/run.sh"]);
    expect(s.extraFiles).toEqual([]);
  });
  it("extended", () => {
    const s = fixtureOk("extended");
    expect(s.provenance.layout).toBe("extended");
    expect(s.package).toMatchObject({ version: "2.0.0", capabilities: ["reports", "weekly-status"], risk: "low" });
    expect(s.package.dependencies).toEqual([{ id: sourceQualifiedId(ORIGIN, "notes"), min_version: "1.0.0" }]);
    expect(s.provenance.dependencies).toEqual([{ name: "notes", id: sourceQualifiedId(ORIGIN, "notes") }]);
    expect(s.provenance.technologies).toEqual([{ name: "node", version: ">=18" }]);
    expect(s.provenance.requiredTools).toEqual(["Grep", "Read"]);
    expect(s.provenance.upstream).toEqual({ "frontmatter.homepage": '"https://example.com/report-writer"' });
  });
  it("foundry", () => {
    const s = fixtureOk("foundry");
    expect(s.provenance.layout).toBe("foundry");
    expect(s.package).toMatchObject({
      id: sourceQualifiedId(ORIGIN, "issue-triage"), version: "3.1.0", category: "project-management", capabilities: ["issues", "triage"],
      connectors: ["issue-tracker"], risk: "medium", roles: [], tool_profile: { shell: false, network: true, filesystem: "read" },
    });
    expect(s.provenance.upstream).toEqual({
      "manifest.connectors": '["issue-tracker"]',
      "manifest.id": '"something-else"',
      "manifest.risk": '"low"',
      "manifest.roles": '["coder"]',
      "manifest.tool_profile": '{"network":true}',
    });
    expect(s.extraFiles.map((f) => f.path)).toEqual(["skill.yaml"]);
  });
});

describe("determinism", () => {
  const files = { "SKILL.md": md("a", "version: 2\ntags: [x, y]\nextra: 1\n"), "scripts/b.sh": "echo b\n", "references/r.md": "r\n", "notes.md": "n\n" };
  it("gives the same result for the same bytes in any order", () => {
    const a = normalizeSkill(ORIGIN, ext(files));
    const b = normalizeSkill(ORIGIN, { root: "skills/x", files: [...ext(files).files].reverse() });
    expect(b).toEqual(a);
    if (!a.ok || !b.ok) throw new Error("expected normalized skills");
    expect(b.skill.identity).toEqual(a.skill.identity);
    expect(a.skill.identity).toMatchObject({ id: a.skill.package.id, digest: a.skill.package.digest, name: "a", version: "2.0.0", versionDeclared: true });
    expect(good({ "SKILL.md": md("a") }).identity.versionDeclared).toBe(false);
    expect(canonicalJson(JSON.parse(JSON.stringify(b)))).toBe(canonicalJson(JSON.parse(JSON.stringify(a))));
  });
  it("gives the same import result for any order of files and skills", () => {
    const all = { "skills/a/SKILL.md": md("a"), "skills/a/x.md": "x\n", "skills/b/SKILL.md": md("b"), "skills/b/scripts/s.sh": "echo\n" };
    const p = prep(all);
    const rev = { ...p, record: { ...p.record, skills: [...p.record.skills].reverse() }, files: new Map([...p.files].reverse()) };
    const x = normalizeImport(p);
    const y = normalizeImport(rev);
    expect(y).toEqual(x);
    expect(y.skills.map((s) => s.identity)).toEqual(x.skills.map((s) => s.identity));
    expect(x.report.normalized.map((n) => n.fingerprint)).toEqual(x.skills.map((s) => s.identity.fingerprint));
    expect(canonicalJson(y.report)).toBe(canonicalJson(x.report));
    expect(x.skills.map((s) => s.package.id)).toEqual([...x.skills.map((s) => s.package.id)].sort());
  });
  // The raw-byte digest, allowed tools, context and file bytes follow the text; everything else must not.
  const semantic = (s: NormalizedSkill) => {
    const { digest: _d, allowedTools: _t, ...pkg } = s.package;
    const { context: _c, ...prov } = s.provenance;
    return { pkg: { ...pkg, files: undefined }, prov };
  };
  it("gives equal normalized fields for equivalent encodings", () => {
    const a = good({ "SKILL.md": md("a", "tags: [pdf, forms]\ndependencies: [x@1.0, y]\nrequires: {node: '18', bun: '1'}\n") });
    const b = good({ "SKILL.md": md("a", "requires: {bun: '1', node: '18'}\ndependencies: [y, x@1.0]\ntags: pdf, forms\n") });
    expect(semantic(b)).toEqual(semantic(a));
    expect(b.package.digest).not.toBe(a.package.digest);
    // tags and dependencies are kept as written by the canonical JSON, so the fingerprint differs too.
    expect(b.identity.digest).not.toBe(a.identity.digest);
    expect(b.identity.fingerprint).not.toBe(a.identity.fingerprint);
    expect(b.package.digest).toBe(skillDigest([{ path: "SKILL.md", content: Buffer.from(md("a", "requires: {bun: '1', node: '18'}\ndependencies: [y, x@1.0]\ntags: pdf, forms\n")) }]));
  });
  it("uses no clock, locale or host data", () => {
    for (const f of ["normalize.ts", "normalize-values.ts", "normalize-rules.ts"]) {
      const text = readFileSync(join("src/skills", f), "utf8");
      for (const word of ["Date", "localeCompare", "process.", "node:os"]) expect(text.includes(word), `${f} has ${word}`).toBe(false);
    }
  });
});

describe("version", () => {
  const v = (x: string) => good({ "SKILL.md": md("a", `version: ${x}\n`) }).package.version;
  it("coerces", () => {
    expect(v('"v1.2"')).toBe("1.2.0");
    expect(v("2")).toBe("2.0.0");
    expect(v("1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });
  it("refuses what is not clear", () => {
    expect(reasons({ "SKILL.md": md("a", "version: 1.5\n") })).toEqual(["version: cannot be read as a version like 1.2.3"]);
    expect(reasons({ "SKILL.md": md("a", "version: latest\n") })).toHaveLength(1);
  });
});

describe("capabilities, category and dependencies", () => {
  it("slugs, deduplicates and sorts", () => {
    expect(good({ "SKILL.md": md("a", 'tags: "PDF Tools, pdf-tools, Forms"\n') }).package.capabilities).toEqual(["forms", "pdf-tools"]);
  });
  it("quarantines bad capabilities", () => {
    expect(reasons({ "SKILL.md": md("a", 'tags: "!!!"\n') })).toHaveLength(1);
    const many = Array.from({ length: 33 }, (_, i) => `t${i}`).join(", ");
    expect(reasons({ "SKILL.md": md("a", `tags: "${many}"\n`) })).toEqual(["capabilities: more than 32 entries"]);
  });
  it("qualifies dependencies", () => {
    const s = good({ "SKILL.md": md("a", "dependencies: ['other@1.0']\n") });
    expect(s.package.dependencies).toEqual([{ id: sourceQualifiedId(ORIGIN, "other"), min_version: "1.0.0" }]);
    expect(s.provenance.dependencies).toEqual([{ name: "other", id: sourceQualifiedId(ORIGIN, "other") }]);
  });
  it("quarantines a self-dependency, a bad name and a duplicate", () => {
    expect(reasons({ "SKILL.md": md("a", "dependencies: [a]\n") })).toEqual(["dependencies: a skill cannot depend on itself"]);
    expect(reasons({ "SKILL.md": md("a", "dependencies: ['Bad Name']\n") })).toEqual(["dependencies: a name is not a lower-case slug"]);
    expect(reasons({ "SKILL.md": md("a", "dependencies: [x, x@1]\n") })).toEqual(["dependencies: a name is listed twice"]);
  });
});

describe("tools, connectors and risk", () => {
  const tools = (t: string, extra: Record<string, string> = {}) => good({ "SKILL.md": md("a", `allowed-tools: ${t}\n`), ...extra });
  it("Bash and Read", () => {
    const s = tools("Bash(git log:*), Read");
    expect(s.provenance.requiredTools).toEqual(["Bash", "Read"]);
    expect(s.package.tool_profile.shell).toBe(true);
    expect(s.package.risk).toBe("medium");
  });
  it("network, write and scripts", () => {
    expect(tools("WebFetch").package.tool_profile.network).toBe(true);
    expect(tools("Edit").package.tool_profile.filesystem).toBe("write");
    expect(tools("Edit").package.risk).toBe("low");
    const s = good({ "SKILL.md": md("a"), "scripts/x.sh": "echo\n" });
    expect(s.package.tool_profile.shell).toBe(true);
    expect(s.package.risk).toBe("medium");
  });
  it("MCP tools become connectors", () => {
    const s = tools("mcp__github__create_issue");
    expect(s.package.connectors).toEqual(["github"]);
    expect(s.package.risk).toBe("medium");
    expect(reasons({ "SKILL.md": md("a", "allowed-tools: mcp__\n") })).toEqual(["tools: an MCP tool has no usable server name"]);
  });
  it("an unlisted tool gets every need", () => {
    const s = tools("Task");
    expect(s.package.tool_profile).toEqual({ shell: true, network: true, filesystem: "write" });
    expect(s.package.risk).toBe("medium");
  });
  it("no tools gives the default", () => {
    const s = good({ "SKILL.md": md("a") });
    expect(s.package.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(s.package.risk).toBe("low");
  });
  it("quarantines unbalanced parentheses", () => {
    expect(reasons({ "SKILL.md": md("a", "allowed-tools: Bash(git\n") })).toEqual(["allowed-tools: parentheses do not match"]);
  });
});

describe("the tool gate", () => {
  const caps: Capabilities = { shell: true, network: true, filesystem: "write", sources: { shell: "x", network: "x", filesystem: "x" } };
  const run = (s: NormalizedSkill) => {
    const need: SkillToolNeed = { key: s.package.id, id: s.package.id, selection: "requested", requiredBy: [], pkg: s.package };
    return { needs: skillNeeds(s.package), check: checkSkillTools([need], caps, ToolPolicySchema.parse({}), "flow") };
  };
  it("sees network from a tool", () => {
    const r = run(good({ "SKILL.md": md("a", "allowed-tools: WebFetch\n") }));
    expect(r.needs).toContain("network");
    expect(r.check.missing.map((m) => m.code)).toContain("tool-not-approved");
  });
  it("sees network from skill.yaml", () => {
    expect(run(good(yamlOf("a", "", "tool_profile: {network: true}\n"))).needs).toContain("network");
  });
  it("sees connectors", () => {
    const r = run(good(yamlOf("a", "", "connectors: [jira]\n")));
    expect(r.needs).toContain("connector:jira");
    expect(r.check.missing.map((m) => m.code)).toContain("connector-unavailable");
    expect(run(good({ "SKILL.md": md("a", "allowed-tools: mcp__github__x\n") })).needs).toContain("connector:github");
  });
  it("sees every need of an unlisted tool", () => {
    expect(run(good({ "SKILL.md": md("a", "allowed-tools: Task\n") })).needs).toEqual(["shell", "network", "write"]);
  });
  it("has no needs for a plain skill", () => {
    const r = run(good({ "SKILL.md": md("a") }));
    expect(r.needs).toEqual([]);
    expect(r.check.missing).toEqual([]);
  });
});

describe("skill.yaml", () => {
  it("does not trust id, roles, detectors and conflicts", () => {
    const s = good(yamlOf("a", "", "id: other\nroles: [coder]\ndetectors: []\nconflicts: [z]\n"));
    expect(s.package.id).toBe(sourceQualifiedId(ORIGIN, "a"));
    expect(s.package.roles).toEqual([]);
    expect(s.package.conflicts).toEqual([]);
    expect(Object.keys(s.provenance.upstream)).toEqual(["manifest.conflicts", "manifest.detectors", "manifest.id", "manifest.roles"]);
  });
  it("only raises the risk", () => {
    expect(good(yamlOf("a", "", "risk: low\ntool_profile: {network: true}\n")).package.risk).toBe("medium");
    expect(good(yamlOf("a", "", "risk: high\n")).package.risk).toBe("high");
    const s = good({ ...yamlOf("a", "", "tool_profile: {shell: false}\n"), "scripts/x.sh": "echo\n" });
    expect(s.package.tool_profile.shell).toBe(true);
  });
  it("quarantines what it cannot map", () => {
    expect(reasons(yamlOf("a", "", "tool_profile: {shell: maybe}\n"))).toEqual(["skill.yaml: tool_profile is not valid"]);
    expect(reasons(yamlOf("a", "", "connectors: ['Not A Slug']\n"))).toHaveLength(1);
    expect(reasons(yamlOf("a", "", "risk: extreme\n"))).toHaveLength(1);
    const many = Array.from({ length: 17 }, (_, i) => `c${i}`).join(", ");
    expect(reasons(yamlOf("a", "", `connectors: [${many}]\n`))).toEqual(["connectors: more than 16 connectors"]);
    expect(reasons(yamlOf("a", "", "key: [unclosed\n"))).toEqual(["skill.yaml: is not valid YAML"]);
    expect(reasons(yamlOf("a", "", "- a\n- b\n"))).toEqual(["skill.yaml: must be a map of keys and values"]);
  });
});

describe("untrusted YAML values", () => {
  const cases: [string, string][] = [
    ["a recursive alias", "extra: &a [1, *a]\n"],
    ["a shared alias", "one: &a {x: 1}\ntwo: *a\n"],
    ["infinity", "extra: .inf\n"],
    ["not a number", "extra: .nan\n"],
    ["deep nesting", "extra: " + "[".repeat(20) + "]".repeat(20) + "\n"],
  ];
  for (const [label, extra] of cases) {
    it(`quarantines ${label} and keeps the sibling`, () => {
      const p = prep({ "skills/ok/SKILL.md": md("ok"), "skills/bad/SKILL.md": md("bad", extra) });
      // A frontmatter that does not parse is already left out by prepareImport; the rest reaches the normalizer.
      const parsedBad = p.record.skills.some((s) => s.name === "bad");
      const out = normalizeImport(p);
      expect(out.skills.map((s) => s.provenance.name)).toEqual(["ok"]);
      expect(JSON.stringify(out.report)).not.toMatch(/null|line \d|\bat line\b/i);
      if (parsedBad) expect(out.report.quarantined.map((q) => q.root)).toEqual(["skills/bad"]);
      else expect(p.record.rejected.map((q) => q.root)).toEqual(["skills/bad"]);
    });
    it(`quarantines ${label} in skill.yaml`, () => {
      const r = normalizeSkill(ORIGIN, ext(yamlOf("a", "", extra)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons[0]).toMatch(/^skill\.yaml: /);
    });
  }
});

describe("unknown metadata", () => {
  it("keeps a nested value exactly", () => {
    const s = good({ "SKILL.md": md("a", "x-extra:\n  m: {b: 1, a: [1, 1.5, true, null]}\n  t: 'héllo ✓'\n") });
    expect(JSON.parse(s.provenance.upstream["frontmatter.x-extra"]!)).toEqual({ m: { b: 1, a: [1, 1.5, true, null] }, t: "héllo ✓" });
  });
  it("keeps a non-string metadata entry", () => {
    const s = good({ "SKILL.md": md("a", "metadata:\n  author: me\n  count: 3\n") });
    expect(s.provenance.upstream).toEqual({ "metadata.count": "3" });
    expect(s.package.metadata).toEqual({ author: "me" });
  });
  it("keeps unused fields of a dependency entry", () => {
    const s = good({ "SKILL.md": md("a", "dependencies:\n  - {name: other, version: '1.0', custom: preserve-me, id: x}\n") });
    expect(s.provenance.upstream).toEqual({ "dependencies.other.custom": '"preserve-me"', "dependencies.other.id": '"x"' });
    expect(s.package.dependencies).toEqual([{ id: sourceQualifiedId(ORIGIN, "other"), min_version: "1.0.0" }]);
  });
  it("keeps a metadata key named __proto__", () => {
    const s = good({ "SKILL.md": md("a", "metadata:\n  __proto__: preserve-me\n  author: me\n") });
    expect(Object.keys(s.package.metadata ?? {})).toEqual(["__proto__", "author"]);
    expect(JSON.stringify(s.package.metadata)).toContain('"__proto__":"preserve-me"');
  });
  it("quarantines instead of cutting", () => {
    expect(reasons({ "SKILL.md": md("a", `big: "${"x".repeat(17000)}"\n`) })).toEqual(["upstream metadata is larger than 16384 bytes"]);
  });
});

describe("files and quarantine", () => {
  it("keeps REVIEW.md out of the package", () => {
    const s = good({ "SKILL.md": md("a"), "REVIEW.md": "Review it.\n", "assets/logo.txt": "x" });
    expect(s.package.review).toBeUndefined();
    expect(s.extraFiles.map((f) => f.path)).toEqual(["REVIEW.md"]);
    expect(s.package.files.assets.map((f) => f.path)).toEqual(["assets/logo.txt"]);
    expect(s.provenance.entryPoints.documents).toEqual(["REVIEW.md"]);
  });
  it("digests every file and estimates the context", () => {
    const files = { "SKILL.md": md("a"), "notes.md": "n".repeat(40) };
    const s = good(files);
    expect(s.package.digest).toBe(skillDigest(Object.entries(files).map(([path, t]) => ({ path, content: Buffer.from(t) }))));
    expect(s.provenance.context.instructions).toBeGreaterThan(0);
    expect(s.provenance.context.text).toBeGreaterThan(s.provenance.context.instructions);
  });
  it("quarantines missing fields", () => {
    expect(reasons({ "SKILL.md": md("a", "", "") })).toEqual(["SKILL.md: no instructions after the frontmatter"]);
    expect(reasons({ "SKILL.md": "---\nname: 5\ndescription: [x]\n---\nBody\n" })).toHaveLength(2);
  });
  it("quarantines a digest that differs from the record", () => {
    const p = prep({ "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") });
    const bad = new Map(p.files);
    bad.set("skills/a/SKILL.md", Buffer.from(md("a", "", "Changed.")));
    const out = normalizeImport({ record: p.record, files: bad });
    expect(out.skills.map((s) => s.provenance.name)).toEqual(["b"]);
    expect(out.report.quarantined).toEqual([{ root: "skills/a", reasons: ["the files do not match the digest of the import record"] }]);
  });
  it("quarantines two skills with the same name and keeps a third", () => {
    const out = normalizeImport(prep({ "skills/one/SKILL.md": md("dup"), "skills/two/SKILL.md": md("dup"), "skills/three/SKILL.md": md("other") }));
    expect(out.skills.map((s) => s.provenance.name)).toEqual(["other"]);
    expect(out.report.quarantined.map((q) => q.root)).toEqual(["skills/one", "skills/two"]);
    expect(out.report.normalized.map((n) => n.root)).toEqual(["skills/three"]);
  });
  it("names the rule and never the token", () => {
    const p = prep({ "skills/ok/SKILL.md": md("ok"), "skills/leak/SKILL.md": md("leak"), "skills/leak/notes.md": `key ${TOKEN}\n` });
    const out = normalizeImport(p);
    expect(out.skills.map((s) => s.provenance.name)).toEqual(["ok"]);
    expect(JSON.stringify(out.report)).not.toContain(TOKEN);
    expect(out.report.quarantined[0]!.reasons[0]).toMatch(/credential/);
  });
  it("carries rejections of the record into the report", () => {
    const out = normalizeImport(prep({ "skills/ok/SKILL.md": md("ok"), "skills/nodesc/SKILL.md": "---\nname: nodesc\n---\nBody\n" }));
    expect(out.report.quarantined.map((q) => q.root)).toEqual(["skills/nodesc"]);
  });
  it("gives a report when nothing was staged", () => {
    let err: unknown;
    try {
      prep({ "skills/one/SKILL.md": "---\ndescription: x\n---\nBody\n", "skills/two/SKILL.md": "---\nname: two\n---\nBody\n" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkillImportError);
    const rejected = (err as SkillImportError).rejected;
    const report = quarantineReport(ORIGIN, rejected);
    expect(report.normalized).toEqual([]);
    expect(report.quarantined.map((q) => q.root)).toEqual(["skills/one", "skills/two"]);
    expect(quarantineReport(ORIGIN, [...rejected].reverse())).toEqual(report);
  });
});

describe("shadowing", () => {
  it("gives the same name a different id in another repository", () => {
    const a = normalizeImport(prep({ "skills/a/SKILL.md": md("same") }));
    const b = normalizeImport(prep({ "skills/a/SKILL.md": md("same") }, { repositoryKey: "github.com/other/skills" }));
    expect(a.skills[0]!.package.id).not.toBe(b.skills[0]!.package.id);
    expect(a.skills[0]!.identity.upstream).not.toBe(b.skills[0]!.identity.upstream);
    const c = normalizeImport(prep({ "skills/a/SKILL.md": md("same") }, { id: "other" }));
    expect(c.skills[0]!.package.id).not.toBe(a.skills[0]!.package.id);
  });
});
