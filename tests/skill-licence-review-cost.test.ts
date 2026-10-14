import { describe, expect, it, vi } from "vitest";

vi.mock("../src/skills/licence.js", async (orig) => {
  const real = await orig<typeof import("../src/skills/licence.js")>();
  return { ...real, evaluateLicence: vi.fn(real.evaluateLicence) };
});

import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence, evaluateLicence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { reviewImport } from "../src/skills/licence-review.js";
import { promoteImport } from "../src/skills/promotion.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
const N = 30;

describe("the cost of a licence review", () => {
  it("classifies once per skill, and promoting one skill at a time adds one call per skill", () => {
    const files: Record<string, string> = { LICENSE: MIT };
    for (let i = 0; i < N; i++) files[`skills/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: A skill called s${i}.\n---\n\nBody.\n`;
    const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
    const all: TreeEntry[] = [...content].map(([path, b]) => ({ path, kind: "file", size: b.byteLength, id: "id:" + path }));
    const tree: SourceTree = { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/") || e.path === p), read: (es) => es.map((e) => content.get(e.path)!) };
    const src: SkillLibrarySource = {
      id: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", status: "enabled", ref: { approved: COMMIT },
      paths: ["skills"], adapter: "agent-skills", trust: "community", licence: { allow: ["MIT"], reviewed: "sha256:" + "0".repeat(64) }, update: { cadence: "manual" }, owner: "@example",
    };
    const prep = prepareImport(src, tree);
    const evidence = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, prep.record.skills.map((s) => s.root), tree);
    const calls = vi.mocked(evaluateLicence);
    calls.mockClear();
    const review = reviewImport({ allow: ["MIT"], prep, evidence });
    expect(calls).toHaveBeenCalledTimes(N);
    for (const s of review.normalized.skills) promoteImport({ source: src, record: prep.record, skills: [s], evidence: review.evidence, retrievedAt: "2026-10-13T10:00:00Z", review });
    expect(calls).toHaveBeenCalledTimes(2 * N);
  });
});
