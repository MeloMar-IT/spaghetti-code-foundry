import { describe, expect, it } from "vitest";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { canonicalLicenceEvidence, evidenceFromRecord, prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { collectLicenceEvidence, type LicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { classifyLicences, isImportLicenceReview, licenceReviewProblem, reviewImport, type LicenceRoot } from "../src/skills/licence-review.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
const OTHER = LICENCE_TEMPLATES.find((t) => t.id !== "MIT")!.text;
const BUSL = "Business Source License 1.1\nLicensor: Example\n";
const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;
const ALLOW = ["MIT"];

function tree(files: Record<string, string>, over: Partial<Record<string, TreeEntry>> = {}): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => over[path] ?? { path, kind: "file", size: bytes.byteLength, id: "id:" + path });
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}
const ev = (files: Record<string, string>, roots: string[], commit = COMMIT, over: Partial<Record<string, TreeEntry>> = {}): LicenceEvidence =>
  collectLicenceEvidence({ repositoryKey: "github.com/example/skills", commit }, roots, tree(files, over));
const ROOTS: LicenceRoot[] = [{ root: "skills/a" }, { root: "skills/b" }];
const BASE: Record<string, string> = { "skills/a/LICENSE.txt": MIT, "skills/b/LICENSE.txt": MIT };
const classify = (files: Record<string, string>, roots: LicenceRoot[] = ROOTS, commit = COMMIT) =>
  classifyLicences({ allow: ALLOW, evidence: ev(files, roots.map((r) => r.root), commit), roots });
const digest = (files: Record<string, string>, roots: LicenceRoot[] = ROOTS) => classify(files, roots).digest;
const withFile = (e: LicenceEvidence, path: string, f: Partial<LicenceEvidence["files"][number]>): LicenceEvidence => ({
  ...e,
  files: e.files.map((x) => (x.path === path ? { path: x.path, dir: x.dir, kind: x.kind, ...f } : x)),
});

describe("classifyLicences", () => {
  it("rows have status, licences and governedBy, sorted by root; files lists every applicable file", () => {
    const c = classify({ ...BASE, "skills/c/LICENSE": BUSL, NOTICE: "Copyright (c) 2024 Ann\n", "docs/LICENSE": MIT }, [{ root: "skills/c" }, { root: "skills/b" }, { root: "skills/a" }]);
    expect(c.paths.map((p) => [p.root, p.status, p.licences, p.governedBy])).toEqual([
      ["skills/a", "allowed", ["MIT"], "skills/a"],
      ["skills/b", "allowed", ["MIT"], "skills/b"],
      ["skills/c", "rejected", ["BUSL-1.1"], "skills/c"],
    ]);
    expect(c.files.map((f) => f.path)).toEqual(["NOTICE", "skills/a/LICENSE.txt", "skills/b/LICENSE.txt", "skills/c/LICENSE"]);
    expect(c.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("gives the same digest for any order of roots and evidence files", () => {
    const e = ev({ ...BASE, LICENSE: MIT }, ["skills/a", "skills/b"]);
    const one = classifyLicences({ allow: ALLOW, evidence: e, roots: ROOTS });
    const two = classifyLicences({ allow: ALLOW, evidence: { ...e, files: [...e.files].reverse() }, roots: [...ROOTS].reverse() });
    expect(two.digest).toBe(one.digest);
  });

  describe("a root LICENSE with every skill keeping its own licence file", () => {
    const base = classify(BASE);
    it.each([
      ["added", { ...BASE, LICENSE: MIT }],
      ["added with another text", { ...BASE, LICENSE: OTHER }],
    ])("changes the digest when it is %s, and no skill changes", (_n, files) => {
      const c = classify(files);
      expect(c.digest).not.toBe(base.digest);
      expect(c.paths).toEqual(base.paths);
    });
    it("changes the digest when it is changed", () => {
      const a = classify({ ...BASE, LICENSE: MIT });
      const b = classify({ ...BASE, LICENSE: MIT + "\n" });
      expect(a.digest).not.toBe(b.digest);
      expect(a.paths).toEqual(b.paths);
    });
    it("changes the digest when it is removed", () => {
      const withRoot = classify({ ...BASE, LICENSE: MIT });
      expect(base.digest).not.toBe(withRoot.digest);
      expect(base.paths).toEqual(withRoot.paths);
    });
  });

  it("changes the digest for any other change of the evidence or the roots", () => {
    const base = digest(BASE);
    expect(digest({ ...BASE, "skills/a/LICENSE.txt": MIT + "\n" })).not.toBe(base);
    expect(digest({ ...BASE, NOTICE: "Copyright (c) 2024 Ann\n" })).not.toBe(base);
    expect(digest(BASE, [{ root: "skills/a" }])).not.toBe(base);
    expect(digest(BASE, [...ROOTS, { root: "skills/c" }])).not.toBe(base);
    const flipped = classifyLicences({ allow: ALLOW, evidence: ev(BASE, ["skills/a", "skills/b"]), roots: [{ root: "skills/a", declared: "Proprietary" }, { root: "skills/b" }] });
    expect(flipped.digest).not.toBe(base);
    expect(flipped.paths[0]!.status).not.toBe("allowed");
  });

  it("changes the digest when a file becomes unreadable or its problem text changes", () => {
    const base = digest(BASE);
    const e = ev(BASE, ["skills/a", "skills/b"]);
    const d = (text: string) => classifyLicences({ allow: ALLOW, evidence: withFile(e, "skills/a/LICENSE.txt", { problem: text }), roots: ROOTS }).digest;
    expect(d("a symbolic link")).not.toBe(base);
    expect(d("a submodule")).not.toBe(d("a symbolic link"));
  });

  it("does not change when only the commit changes or an unrelated folder holds a licence file", () => {
    const base = classify(BASE);
    expect(classify(BASE, ROOTS, "b".repeat(40)).digest).toBe(base.digest);
    const e = ev(BASE, ["skills/a", "skills/b"]);
    const extra = classifyLicences({ allow: ALLOW, evidence: { ...e, files: [...e.files, ...ev({ "other/LICENSE": MIT }, ["other"]).files] }, roots: ROOTS });
    expect(extra.digest).toBe(base.digest);
    expect(extra.files).toEqual(base.files);
  });
});

describe("licenceReviewProblem", () => {
  it("returns missing, changed and undefined", () => {
    const c = classify(BASE);
    expect(licenceReviewProblem(undefined, c)).toBe("missing");
    expect(licenceReviewProblem("sha256:" + "0".repeat(64), c)).toBe("changed");
    expect(licenceReviewProblem(c.digest, c)).toBeUndefined();
  });
});

describe("reviewImport", () => {
  const src: SkillLibrarySource = {
    id: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", status: "enabled", ref: { approved: COMMIT },
    paths: ["skills"], adapter: "agent-skills", trust: "community", licence: { allow: ALLOW }, update: { cadence: "manual" }, owner: "@example",
  };
  const files = { "skills/a/SKILL.md": md("a", "license: MIT\n"), "skills/a/LICENSE": MIT, "skills/b/SKILL.md": md("b") };
  const prep = (f: Record<string, string> = files) => prepareImport(src, tree(f));

  it("builds a frozen review that is told from a copy", () => {
    const review = reviewImport({ allow: ALLOW, prep: prep(), evidence: ev(files, ["skills/a", "skills/b"]) });
    expect(Object.isFrozen(review)).toBe(true);
    expect(isImportLicenceReview(review)).toBe(true);
    expect(isImportLicenceReview({ ...review })).toBe(false);
    expect(review.classification.paths.map((x) => [x.root, x.status, x.declared])).toEqual([["skills/a", "allowed", "MIT"], ["skills/b", "missing", undefined]]);
  });

  it("gives an entry without declared for a root that was not normalized", () => {
    // Same name as skills/b: staged, but quarantined by the normalization.
    const f = { ...files, "skills/b2/SKILL.md": md("b") };
    const p = prep(f);
    const review = reviewImport({ allow: ALLOW, prep: p, evidence: ev(f, ["skills/a", "skills/b", "skills/b2"]) });
    const quarantined = review.normalized.report.quarantined.map((q) => q.root);
    expect(quarantined.length).toBeGreaterThan(0);
    for (const root of quarantined) {
      const row = review.classification.paths.find((x) => x.root === root);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("declared");
    }
  });

  describe("live evidence and staged evidence give the same digest", () => {
    const plainPrep = () => prep({ "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") });
    const staged = (e: LicenceEvidence) => {
      const pl = prepareLicenceEvidence(e);
      return evidenceFromRecord(pl.record, pl.files);
    };
    const cases: [string, Record<string, string>, Partial<Record<string, TreeEntry>>][] = [
      ["a plain tree", BASE, {}],
      ["LICENSE next to license at the root", { ...BASE, LICENSE: MIT, license: MIT }, {}],
      ["a licence file that is a symbolic link", BASE, { "skills/a/LICENSE.txt": { path: "skills/a/LICENSE.txt", kind: "symlink", size: 1, id: "x" } }],
    ];
    it.each(cases)("%s", (_n, f, over) => {
      const live = ev(f, ["skills/a", "skills/b"], COMMIT, over);
      const viaStaged = reviewImport({ allow: ALLOW, prep: plainPrep(), evidence: staged(live) }).classification.digest;
      const viaLive = reviewImport({ allow: ALLOW, prep: plainPrep(), evidence: live }).classification.digest;
      expect(viaLive).toBe(viaStaged);
    });
    it("a problem text with an unsafe character", () => {
      const live = withFile(ev(BASE, ["skills/a", "skills/b"]), "skills/a/LICENSE.txt", { problem: "bad‮text" });
      const viaStaged = reviewImport({ allow: ALLOW, prep: plainPrep(), evidence: staged(live) }).classification.digest;
      expect(reviewImport({ allow: ALLOW, prep: plainPrep(), evidence: live }).classification.digest).toBe(viaStaged);
    });
  });
});

describe("canonicalLicenceEvidence", () => {
  it("is the same when applied twice", () => {
    const e = ev({ ...BASE, LICENSE: MIT, license: MIT }, ["skills/a", "skills/b"], COMMIT, { "skills/b/LICENSE.txt": { path: "skills/b/LICENSE.txt", kind: "symlink", size: 1, id: "x" } });
    const once = canonicalLicenceEvidence(e);
    expect(canonicalLicenceEvidence(once)).toEqual(once);
    expect(once.files.some((f) => f.problem?.includes("collides"))).toBe(true);
  });
});
