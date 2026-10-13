import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigSchema } from "../src/config.js";
import { canonicalFromRegistered } from "../src/skills/canonical-facts.js";
import { collisionCandidate } from "../src/skills/collisions.js";
import { evaluateImport } from "../src/skills/import-evaluation.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport } from "../src/skills/normalize.js";
import { attributionProblem, promoteImport } from "../src/skills/promotion.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import { scanSkill } from "../src/skills/scan.js";
import { applyExceptions, promotionBlockers } from "../src/skills/scan-exceptions.js";
import { parseSources, readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const SHIPPED = "skill-sources.yaml";
const COMMIT = "a".repeat(40);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
const md = (name: string, extra = "", body = "Body.") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\n${body}\n`;

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

function tree(files: Record<string, string>): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}
function shipped(): SkillLibrarySource {
  const r = readSources(SHIPPED);
  if (r.state !== "ok") throw new Error("the shipped source file is not valid");
  return r.manifest.sources[0]!;
}
const rawEntry = () => (parse(readFileSync(SHIPPED, "utf8")) as { sources: Record<string, unknown>[] }).sources[0]!;
const parsedWith = (over: Record<string, unknown>, drop: string[] = []) => {
  const entry = { ...rawEntry(), ...over };
  for (const k of drop) delete entry[k];
  return parseSources({ schema: 1, sources: [entry] });
};

describe("the shipped openhands-extensions source", () => {
  it("is valid, disabled and pinned to nothing", () => {
    const s = shipped();
    expect(s).toMatchObject({
      id: "openhands-extensions",
      status: "disabled",
      paths: ["skills"],
      adapter: "agent-skills",
      trust: "community",
      licence: { allow: ["MIT"] },
    });
    expect(s.ref.approved).toBeUndefined();
    expect(s.reason).toBeTruthy();
  });

  it("cannot be enabled without a full commit id", () => {
    const enable = { status: "enabled" };
    expect(parsedWith(enable, ["reason"]).manifest).toBeUndefined();
    expect(parsedWith({ ...enable, ref: { approved: "main" } }, ["reason"]).manifest).toBeUndefined();
    expect(parsedWith({ ...enable, ref: { approved: "abcdef123456" } }, ["reason"]).manifest).toBeUndefined();
    expect(parsedWith({ ...enable, ref: { approved: COMMIT } }, ["reason"]).manifest?.sources[0]?.status).toBe("enabled");
  });

  it("is refused by prepareImport while disabled", () => {
    expect(() => prepareImport(shipped(), tree({ "skills/a/SKILL.md": md("a") }))).toThrow(/not enabled|not-usable|cannot be imported/);
  });
});

describe("import, scan, evaluation and promotion of an OpenHands-style fixture", () => {
  const FILES: Record<string, string> = {
    LICENSE: MIT,
    "skills/code-review/SKILL.md": md("code-review", "triggers: [review, pr]\n"),
    "skills/docs-writer/SKILL.md": md("docs-writer", "tags: [documentation]\n"),
    "skills/docs-writer/references/style.md": "Write short sentences.",
    "skills/node-service/SKILL.md": md("node-service", "tags: [node-service]\n"),
    "skills/github-pr/SKILL.md": md("github-pr", "allowed-tools: mcp__github__create_pr\n"),
    "skills/api-check/SKILL.md": md("api-check"),
    "skills/api-check/scripts/check.sh": "#!/bin/sh\ncurl https://api.example.io/health\n",
    "skills/with-mcp/SKILL.md": md("with-mcp"),
    "skills/with-mcp/.mcp.json": '{"mcpServers":{}}',
    "skills/danger/SKILL.md": md("danger"),
    "skills/danger/scripts/a.sh": "rm -rf /",
    "plugins/demo/.plugin/plugin.json": "{}",
    "plugins/demo/skills/x/SKILL.md": md("x"),
  };

  it("completes the chain and keeps excluded skills out", () => {
    const src: SkillLibrarySource = { ...shipped(), status: "enabled", ref: { approved: COMMIT } };
    delete src.reason;
    const t = tree(FILES);
    const prep = prepareImport(src, t);
    expect(prep.record.skills.some((s) => s.root.startsWith("plugins/"))).toBe(false);
    expect([...prep.files.keys()].some((p) => p.startsWith("plugins/"))).toBe(false);

    const { skills } = normalizeImport(prep);
    const byName = new Map(skills.map((s) => [s.provenance.name, s]));
    const review = byName.get("code-review")!;
    expect(review.provenance.upstream["frontmatter.triggers"]).toBeDefined();
    expect(review.package.capabilities ?? []).toEqual([]);

    const blocked = new Set<string>();
    for (const s of skills) {
      const files = [...prep.files].filter(([p]) => p.startsWith(s.provenance.root + "/")).map(([p, content]) => ({ path: p.slice(s.provenance.root.length + 1), content }));
      const decided = applyExceptions(s.package.id, scanSkill({ root: s.provenance.root, files }), [], "2026-10-13");
      if (promotionBlockers(decided).length > 0) blocked.add(s.provenance.name);
    }
    expect([...blocked]).toEqual(["danger"]);

    const home = realpathSync(mkdtempSync(join(tmpdir(), "skilloh-")));
    made.push(home);
    const builtin = discoverSkills(ConfigSchema.parse({}).skills, { env: {}, userHome: home }).skills.filter((s) => s.active);
    const existing = builtin.map((s) => canonicalFromRegistered(s));
    const safe = skills.filter((s) => !blocked.has(s.provenance.name));
    const evaluation = evaluateImport({
      imported: safe.map((s) => ({ candidate: collisionCandidate(s, src), licence: "allowed" as const, safety: true })),
      existing,
    });
    const outcome = (name: string) => evaluation.skills.find((e) => e.name === name)!;
    expect(outcome("node-service").outcome).toBe("duplicate");
    expect(outcome("node-service").overlaps.some((o) => o.winner === "nodejs")).toBe(true);
    expect(outcome("code-review")).toMatchObject({ outcome: "new", areas: ["code-review"] });
    expect(outcome("docs-writer")).toMatchObject({ outcome: "new", areas: ["documentation"] });
    expect(evaluation.skills.some((e) => e.outcome === "blocked")).toBe(false);

    const evidence = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, safe.map((s) => s.provenance.root), t);
    const result = promoteImport({ source: src, record: prep.record, skills: safe, evidence, retrievedAt: "2026-10-13T10:00:00Z" });
    expect(result.promoted.map((p) => p.skill.provenance.name).sort()).toEqual(["code-review", "docs-writer", "node-service"]);
    for (const p of result.promoted) {
      expect(p.provenance.licences).toEqual(["MIT"]);
      expect(p.attribution.map((a) => a.path)).toContain("LICENSE");
      expect(attributionProblem(p.provenance, p.attribution)).toBeUndefined();
    }
    const refused = result.manifest.refused.map((r) => [r.root, r.status]);
    for (const r of ["skills/github-pr", "skills/api-check"]) expect(refused).toContainEqual([r, "excluded"]);
    if (byName.has("with-mcp")) expect(refused).toContainEqual(["skills/with-mcp", "excluded"]);

    const catalogue = new Set([...builtin.map((s) => s.id), ...result.promoted.map((p) => p.provenance.id)]);
    for (const p of result.promoted) expect(catalogue.has(p.provenance.id)).toBe(true);
    expect(catalogue.has("nodejs")).toBe(true);
  });
});
