import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";

// The registry reads skill-lifecycle.jsonl: a map of the non-active keys, a field on each approved entry, and a problem when it cannot be read.

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-reg-")));
  tmps.push(base);
  const home = join(base, "home");
  const repo = join(base, "repo");
  mkdirSync(join(home, "skills"), { recursive: true });
  for (const [root, id] of [[join(home, "skills"), "a"], [join(home, "skills"), "b"], [join(repo, ".claude-factory", "skills"), "r"]] as const) {
    const d = join(root, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
  }
  const discover = () =>
    discoverSkills(ConfigSchema.parse({ skills: { repository: true, releases: { allow_unreleased: true } } }).skills, {
      home, repo, builtinRoot: join(base, "none"), userHome: join(base, "user"), env: {},
    });
  const record = (...lines: object[]) =>
    writeFileSync(join(home, "skill-lifecycle.jsonl"), lines.map((l) => JSON.stringify({ at: "2026-01-01T00:00:00.000Z", by: "cli", reason: "because", ...l })).join("\n") + "\n");
  return { home, discover, record };
}

describe("the lifecycle in the registry", () => {
  it("has no states and no problem without a record", () => {
    const r = setup().discover();
    expect(r.lifecycle?.size).toBe(0);
    expect(r.problems.filter((p) => p.kind === "lifecycle")).toEqual([]);
    expect(r.byKey.get("a@1.0.0")?.lifecycle).toBeUndefined();
  });

  it("holds the non-active keys, and sets the field on approved entries but not on repository ones", () => {
    const t = setup();
    t.record(
      { type: "transition", seq: 1, key: "a@1.0.0", from: "active", to: "retired", replacement: "b@1.0.0" },
      { type: "transition", seq: 2, key: "b@1.0.0", from: "active", to: "deprecated" },
      { type: "transition", seq: 3, key: "b@1.0.0", from: "deprecated", to: "active" },
      { type: "transition", seq: 4, key: "r@1.0.0", from: "active", to: "revoked" },
    );
    const r = t.discover();
    expect([...r.lifecycle!.keys()].sort()).toEqual(["a@1.0.0", "r@1.0.0"]);
    expect(r.byKey.get("a@1.0.0")?.lifecycle).toMatchObject({ state: "retired", replacement: "b@1.0.0" });
    expect(r.byKey.get("b@1.0.0")?.lifecycle).toBeUndefined();
    expect(r.byKey.get("r@1.0.0")?.trust).toBe("unapproved");
    expect(r.byKey.get("r@1.0.0")?.lifecycle).toBeUndefined();
  });

  it("adds a lifecycle problem that names the line and nothing of the file", () => {
    const t = setup();
    writeFileSync(join(t.home, "skill-lifecycle.jsonl"), '{"type":"transition","secret":"hunter2"}\n');
    const p = t.discover().problems.find((x) => x.kind === "lifecycle");
    expect(p).toMatchObject({ source: "admin", label: "skill lifecycle" });
    expect(p!.reason).toBe("the skill lifecycle record has a line that is not valid (line 1); approved and built-in skills cannot be selected");
    expect(p!.reason).not.toContain("hunter2");
  });
});
