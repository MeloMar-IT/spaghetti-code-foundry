import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence, type LicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport, type NormalizedSkill } from "../src/skills/normalize.js";
import { attributionProblem, promoteImport } from "../src/skills/promotion.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
const BUSL = "Business Source License 1.1\nLicensor: Example\n";
const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;
const NOW = "2026-10-12T10:00:00Z";

function tree(files: Record<string, string>): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
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

function setup(files: Record<string, string>, over: Partial<SkillLibrarySource> = {}) {
  const src = source(over);
  const t = tree(files);
  const prep = prepareImport(src, t);
  const { skills } = normalizeImport(prep);
  const evidence = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, skills.map((s) => s.provenance.root), t);
  return { src, prep, skills, evidence };
}
const run = (s: ReturnType<typeof setup>, over: { skills?: readonly NormalizedSkill[]; evidence?: LicenceEvidence; source?: SkillLibrarySource; retrievedAt?: string } = {}) =>
  promoteImport({ source: over.source ?? s.src, record: s.prep.record, skills: over.skills ?? s.skills, evidence: over.evidence ?? s.evidence, retrievedAt: over.retrievedAt ?? NOW });

const MIXED = {
  "skills/free/SKILL.md": md("free"),
  "skills/free/LICENSE": MIT,
  "skills/free/NOTICE": "Copyright (c) 2024 Ann\n",
  "skills/pro/SKILL.md": md("pro"),
  "skills/pro/LICENSE": BUSL,
  "skills/none/SKILL.md": md("none"),
};

describe("promoteImport", () => {
  it("promotes the licensed sibling and refuses the source-available and the unlicensed one", () => {
    const r = run(setup(MIXED));
    expect(r.promoted.map((p) => p.provenance.path)).toEqual(["skills/free"]);
    expect(r.manifest.refused.map((x) => [x.root, x.status])).toEqual([["skills/none", "missing"], ["skills/pro", "rejected"]]);
  });

  it("lets a folder under a repository-wide licence opt out with its own licence file", () => {
    const r = run(setup({ LICENSE: MIT, "skills/ok/SKILL.md": md("ok"), "skills/pro/SKILL.md": md("pro"), "skills/pro/LICENSE": BUSL }));
    expect(r.promoted.map((p) => p.provenance.path)).toEqual(["skills/ok"]);
    expect(r.promoted[0]!.provenance.licenceFiles[0]!.path).toBe("LICENSE");
    expect(r.manifest.refused.map((x) => [x.root, x.status])).toEqual([["skills/pro", "rejected"]]);
  });

  it("records licence and provenance for every package", () => {
    const s = setup({ ...MIXED, "skills/two/SKILL.md": md("two"), "skills/two/LICENSE": MIT });
    const r = run(s);
    expect(r.manifest.packages).toHaveLength(2);
    for (const p of r.manifest.packages) {
      expect(p).toMatchObject({ repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT, retrievedAt: NOW, licences: ["MIT"] });
      expect(p.path).toMatch(/^skills\//);
      expect(p.licenceFiles).toHaveLength(1);
      expect(p.licenceFiles[0]!.sha256).toBe(createHash("sha256").update(Buffer.from(MIT)).digest("hex"));
      expect(p.licenceFiles[0]!.bytes).toBe(Buffer.byteLength(MIT));
      expect(p.attribution.length).toBeGreaterThan(0);
    }
    expect(r.manifest.packages.map((p) => p.id)).toEqual([...r.manifest.packages.map((p) => p.id)].sort());
    const free = r.manifest.packages.find((p) => p.path === "skills/free")!;
    expect(free.authorNotice).toEqual(["Copyright (c) 2024 Ann"]);
    expect(free.attribution.map((a) => a.path)).toEqual(["skills/free/LICENSE", "skills/free/NOTICE"]);
  });

  it("keeps attribution files byte for byte and detects a missing or changed one", () => {
    const r = run(setup({ ...MIXED, LICENSE: MIT }));
    const p = r.promoted.find((x) => x.provenance.path === "skills/free")!;
    const byPath = Object.fromEntries(p.attribution.map((a) => [a.path, Buffer.from(a.content).toString()]));
    expect(byPath["skills/free/LICENSE"]).toBe(MIT);
    expect(byPath["skills/free/NOTICE"]).toBe("Copyright (c) 2024 Ann\n");
    expect(attributionProblem(p.provenance, p.attribution)).toBeUndefined();
    expect(attributionProblem(p.provenance, p.attribution.slice(1))).toBe("skills/free/LICENSE is missing");
    const changed = p.attribution.map((a) => (a.path.endsWith("NOTICE") ? { path: a.path, content: Buffer.from("Copyright (c) 2024 Bob\n") } : a));
    expect(attributionProblem(p.provenance, changed)).toBe("skills/free/NOTICE changed");
  });

  it("refuses a skill whose required notice cannot be kept", () => {
    const s = setup({ LICENSE: MIT, "skills/NOTICE": "n\n", "skills/a/SKILL.md": md("a") });
    const bad: LicenceEvidence = { ...s.evidence, files: s.evidence.files.map((f) => (f.path === "skills/NOTICE" ? { path: f.path, dir: f.dir, kind: f.kind, problem: "a symbolic link" } : f)) };
    expect(run(s).promoted).toHaveLength(1);
    expect(run(s, { evidence: bad })).toMatchObject({ promoted: [], manifest: { packages: [], refused: [{ status: "ambiguous" }] } });
  });

  it("gives the same text for shuffled input, and the text parses back", () => {
    const s = setup({ ...MIXED, LICENSE: MIT, "skills/two/SKILL.md": md("two") });
    const a = run(s);
    const b = run(s, { skills: [...s.skills].reverse(), evidence: { ...s.evidence, files: [...s.evidence.files].reverse() } });
    expect(b.manifestText).toBe(a.manifestText);
    expect(JSON.parse(a.manifestText)).toEqual(a.manifest);
    expect(a.manifestText.endsWith("}\n")).toBe(true);
  });

  it("promotes nothing when every skill is refused", () => {
    const r = run(setup({ "skills/none/SKILL.md": md("none") }));
    expect(r.promoted).toEqual([]);
    expect(r.manifest.packages).toEqual([]);
    expect(r.manifest.refused).toHaveLength(1);
  });

  it("refuses a licence that the source does not allow", () => {
    const s = setup(MIXED, { licence: { allow: ["Apache-2.0"] } });
    expect(run(s).manifest.refused.map((x) => x.status)).toEqual(["rejected", "missing", "rejected"]);
  });

  describe("binding to the approved import", () => {
    const s = setup(MIXED);
    const throws = (f: () => unknown) => expect(f).toThrowError(expect.objectContaining({ code: "not-usable" }));
    it("throws for another source, commit or a disabled source", () => {
      throws(() => run(s, { source: source({ id: "other" }) }));
      throws(() => run(s, { source: source({ ref: { approved: "b".repeat(40) } }) }));
      throws(() => run(s, { source: source({ status: "disabled" }) }));
    });
    it("throws for a bad retrievedAt", () => {
      throws(() => run(s, { retrievedAt: "2026-02-30T00:00:00Z" }));
      throws(() => run(s, { retrievedAt: "yesterday" }));
    });
    it("throws for evidence of another revision or repository", () => {
      throws(() => run(s, { evidence: { ...s.evidence, commit: "b".repeat(40) } }));
      throws(() => run(s, { evidence: { ...s.evidence, repositoryKey: "github.com/other/skills" } }));
    });
    it("throws for a skill that is no longer under an approved path", () => {
      throws(() => run(s, { source: source({ paths: ["elsewhere"] }) }));
    });
    it("throws for a substituted skill, a digest mismatch or a repeated skill", () => {
      const free = s.skills.find((k) => k.provenance.root === "skills/free")!;
      throws(() => run(s, { skills: [{ ...free, provenance: { ...free.provenance, name: "other" } }] }));
      throws(() => run(s, { skills: [{ ...free, provenance: { ...free.provenance, root: "skills/ghost" } }] }));
      throws(() => run(s, { skills: [{ ...free, package: { ...free.package, digest: "sha256:" + "0".repeat(64) } }] }));
      throws(() => run(s, { skills: [free, free] }));
      throws(() => run(s, { skills: [{ ...free, provenance: { ...free.provenance, commit: "b".repeat(40) } }] }));
    });
  });
});

describe("promoteImport: excluded skills", () => {
  const FILES = {
    "skills/ok/SKILL.md": md("ok"),
    "skills/ok/LICENSE": MIT,
    "skills/conn/SKILL.md": md("conn", "allowed-tools: mcp__github__create_pr\n"),
    "skills/conn/LICENSE": MIT,
    "skills/web/SKILL.md": md("web"),
    "skills/web/LICENSE": MIT,
    "skills/web/scripts/a.sh": "curl https://api.example.io/x\n",
    "skills/push/SKILL.md": md("push", "allowed-tools: Bash\n").replace("Body.", "Run git push origin main."),
    "skills/push/LICENSE": MIT,
  };
  it("refuses a licensed skill that needs a connector or calls a web address, and promotes its sibling", () => {
    const r = run(setup(FILES));
    expect(r.promoted.map((p) => p.skill.provenance.name)).toEqual(["ok"]);
    expect(r.manifest.refused.map((x) => [x.root, x.status])).toEqual([["skills/conn", "excluded"], ["skills/push", "excluded"], ["skills/web", "excluded"]]);
    expect(r.manifest.refused[0]!.reasons.join(" ")).toContain("github");
  });
});
