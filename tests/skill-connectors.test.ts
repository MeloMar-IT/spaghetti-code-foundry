import { describe, expect, it } from "vitest";
import { parseRepoUrl } from "../src/auth/repo-url.js";
import { SOURCE_CONNECTORS, connectorFor, connectorProblems, connectorSource } from "../src/skills/connectors.js";
import { prepareImport, type TreeEntry } from "../src/skills/import-plan.js";
import { SKILL_ID_RE } from "../src/skills/schema.js";
import { SOURCE_LICENCES, SOURCE_TRUST_TIERS, parseSources, sourcePathProblem, trackRefProblem } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const KEY = "github.com/github/awesome-copilot";
const ok = { repositoryKey: KEY, paths: ["skills"], adapter: "agent-skills", trust: "community", licence: { allow: ["MIT"] } };
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;

describe("SOURCE_CONNECTORS", () => {
  it("holds the awesome-copilot definition and no commit", () => {
    expect(SOURCE_CONNECTORS).toEqual([
      {
        id: "awesome-copilot",
        repository: "https://github.com/github/awesome-copilot",
        repositoryKey: KEY,
        roots: ["skills"],
        adapter: "agent-skills",
        trust: "community",
        licences: ["MIT"],
        track: "main",
      },
    ]);
    for (const c of SOURCE_CONNECTORS) for (const k of ["commit", "approved", "ref"]) expect(c).not.toHaveProperty(k);
  });

  it.each(SOURCE_CONNECTORS.map((c) => [c.id, c] as const))("%s is consistent", (_id, c) => {
    const p = parseRepoUrl(c.repository);
    expect(p.key).toBe(c.repositoryKey);
    expect(p.url).toBe(c.repository);
    expect(c.id).toMatch(SKILL_ID_RE);
    expect(SOURCE_CONNECTORS.filter((o) => o.id === c.id)).toHaveLength(1);
    expect(SOURCE_CONNECTORS.filter((o) => o.repositoryKey === c.repositoryKey)).toHaveLength(1);
    for (const r of c.roots) expect(sourcePathProblem(r)).toBeUndefined();
    expect(trackRefProblem(c.track)).toBeUndefined();
    for (const l of c.licences) expect(SOURCE_LICENCES as readonly string[]).toContain(l);
    expect(SOURCE_TRUST_TIERS as readonly string[]).toContain(c.trust);
  });
});

describe("connectorFor", () => {
  it("finds a connector by repository key", () => {
    expect(connectorFor(KEY)?.id).toBe("awesome-copilot");
    expect(connectorFor("github.com/example/skills")).toBeUndefined();
  });
});

describe("connectorProblems", () => {
  it("has nothing to say about another repository", () => {
    expect(connectorProblems({ ...ok, repositoryKey: "github.com/example/skills", paths: ["."], trust: "verified" })).toEqual([]);
  });

  it.each([[["skills"]], [["skills/demo"]], [["skills/a", "skills/b"]]])("accepts paths %j", (paths) => {
    expect(connectorProblems({ ...ok, paths })).toEqual([]);
  });

  it.each([".", "agents", "hooks", "workflows", "plugins", "instructions", "Skills", "skillsx", "skills-extra/a"])("refuses path %s", (p) => {
    const r = connectorProblems({ ...ok, paths: [p] });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain(`"${p}"`);
    expect(r[0]).toContain("awesome-copilot");
  });

  it("refuses another trust, adapter and licence", () => {
    expect(connectorProblems({ ...ok, trust: "verified" })).toHaveLength(1);
    expect(connectorProblems({ ...ok, trust: "first-party" })).toHaveLength(1);
    expect(connectorProblems({ ...ok, adapter: "custom" })).toHaveLength(1);
    const l = connectorProblems({ ...ok, licence: { allow: ["MIT", "Apache-2.0"] } });
    expect(l).toHaveLength(1);
    expect(l[0]).toContain("Apache-2.0");
  });

  it("reports every fault and skips fields that are not set", () => {
    expect(connectorProblems({ ...ok, paths: ["a", "b"], trust: "verified", adapter: "x", licence: { allow: ["ISC"] } })).toHaveLength(5);
    const { adapter: _a, trust: _t, ...rest } = ok;
    expect(connectorProblems(rest)).toEqual([]);
  });

  it("cuts a long path", () => {
    const r = connectorProblems({ ...ok, paths: ["x".repeat(200)] });
    expect(r[0]!.length).toBeLessThan(250);
  });
});

describe("connectorSource", () => {
  const c = SOURCE_CONNECTORS[0]!;

  it("builds an entry that follows the connector", () => {
    const s = connectorSource(c, { commit: COMMIT, owner: "@octocat" });
    expect(s).toMatchObject({
      id: "awesome-copilot",
      repository: c.repository,
      repositoryKey: KEY,
      status: "enabled",
      ref: { track: "main", approved: COMMIT },
      paths: ["skills"],
      adapter: "agent-skills",
      trust: "community",
      licence: { allow: ["MIT"] },
      update: { cadence: "manual" },
      owner: "@octocat",
    });
    s.paths.push("x");
    s.licence.allow.push("ISC");
    expect(c.roots).toEqual(["skills"]);
    expect(c.licences).toEqual(["MIT"]);
    expect(connectorProblems(connectorSource(c, { commit: COMMIT, owner: "@octocat" }))).toEqual([]);
  });

  it("is accepted by parseSources", () => {
    const { repositoryKey: _k, ...entry } = connectorSource(c, { commit: COMMIT, owner: "@octocat", paths: ["skills/demo"] });
    expect(parseSources({ schema: 1, sources: [entry] }).problems).toEqual([]);
  });

  it("stages only skill folders", () => {
    const files: Record<string, string> = {
      "agents/x.agent.md": "agent",
      "hooks/h/hooks.json": "{}",
      "workflows/w.md": "w",
      "instructions/i.instructions.md": "i",
      "skills/demo/SKILL.md": md("demo"),
    };
    const entries: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
    const listed: string[] = [];
    const p = prepareImport(connectorSource(c, { commit: COMMIT, owner: "@octocat" }), {
      list: (path) => {
        listed.push(path);
        return entries.filter((e) => path === "." || e.path === path || e.path.startsWith(path + "/"));
      },
      read: (es) => es.map((e) => Buffer.from(files[e.path]!)),
    });
    expect(p.record.skills.map((s) => s.root)).toEqual(["skills/demo"]);
    expect([...p.files.keys()]).toEqual(["skills/demo/SKILL.md"]);
    expect(listed).toEqual(["skills"]);
  });
});
