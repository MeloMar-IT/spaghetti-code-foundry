import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectorFor } from "../src/skills/connectors.js";
import {
  applyFrontendRule, emptyImportLines, frontendBlocked, frontendEvidence, frontendProfileFor, frontendSelection, partitionRecord, repoScanGaps,
} from "../src/skills/frontend-connector.js";
import { FRONTEND_GROUPS, VERCEL_PROFILE, type FrontendProfile } from "../src/skills/frontend-rules.js";
import { importDigest, prepareImport, type ImportRecord, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { normalizeImport } from "../src/skills/normalize.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { BUILTIN_SKILLS } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE } from "../src/skills/schema.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const SRC = join(import.meta.dirname, "../src/skills");
const modulesOf = (text: string) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]!);
const codeLines = (text: string) => text.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l));

const COMMIT = "a".repeat(40);
const KEY = VERCEL_PROFILE.repositoryKey;
const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;
const source: SkillLibrarySource = {
  id: "vercel-agent-skills", repository: "https://github.com/vercel-labs/agent-skills", repositoryKey: KEY, status: "enabled",
  ref: { approved: COMMIT }, paths: ["skills"], adapter: "agent-skills", trust: "verified", licence: { allow: ["MIT"] },
  update: { cadence: "manual" }, owner: "@example",
};
function tree(files: Record<string, string>): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}
const R1 = "skills/composition-patterns";
const R2 = "skills/react-best-practices";
const prep = (files: Record<string, string>) => prepareImport(source, tree(files));
const skillAt = (root: string, extra = "") => normalizeImport(prep({ [`${root}/SKILL.md`]: md("composition", extra) })).skills[0]!;

describe("the frontend modules", () => {
  it("frontend-rules.ts has no imports", () => {
    expect(modulesOf(readFileSync(join(SRC, "frontend-rules.ts"), "utf8"))).toEqual([]);
  });
  it("frontend-connector.ts imports no process, VM, file or network module and uses no dynamic code", () => {
    const text = readFileSync(join(SRC, "frontend-connector.ts"), "utf8");
    expect(modulesOf(text).filter((m) => /^(?:node:)?(?:child_process|vm|worker_threads|fs|fs\/promises|http|https|http2|net|tls|dns|dgram|process)$/.test(m))).toEqual([]);
    for (const re of [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/, /\bprocess\./]) {
      expect(codeLines(text).filter((l) => re.test(l)), String(re)).toEqual([]);
    }
  });
});

describe("VERCEL_PROFILE", () => {
  const connector = connectorFor(KEY)!;
  it("has well-formed rules under the roots of the connector", () => {
    for (const [root, rule] of Object.entries(VERCEL_PROFILE.skills)) {
      expect(FRONTEND_GROUPS).toContain(rule.group);
      expect(new Set(rule.capabilities).size).toBe(rule.capabilities.length);
      for (const c of rule.capabilities) expect(c).toMatch(SKILL_ID_RE);
      for (const t of rule.technologies) expect(t.name).toMatch(SKILL_ID_RE);
      expect(rule.evaluations.length).toBeGreaterThan(0);
      for (const d of rule.reviewed) expect(d).toMatch(SKILL_DIGEST_RE);
      expect(connector.roots.some((r) => root.startsWith(r + "/"))).toBe(true);
    }
  });
  it("holds web-design-guidelines and leaves out the deploy skill", () => {
    expect(VERCEL_PROFILE.skills["skills/web-design-guidelines"]!.hold).toBeTruthy();
    expect(VERCEL_PROFILE.skills["skills/vercel-deploy-claimable"]).toBeUndefined();
  });
  it("is found by the repository key of the connector", () => {
    expect(frontendProfileFor(KEY)).toBe(VERCEL_PROFILE);
    expect(frontendProfileFor("github.com/example/other")).toBeUndefined();
  });
  it("does not share a capability of the frontend group with the built-in typescript or nodejs skills", () => {
    const builtin = new Set(["typescript", "nodejs"].flatMap((n) => loadSkillPackage(join(BUILTIN_SKILLS, n)).capabilities ?? []));
    for (const rule of Object.values(VERCEL_PROFILE.skills)) {
      if (rule.group === "frontend") for (const c of rule.capabilities) expect(builtin.has(c)).toBe(false);
    }
  });
});

describe("partitionRecord", () => {
  const files = { [`${R1}/SKILL.md`]: md("a"), "skills/vercel-deploy-claimable/SKILL.md": md("b"), "skills/broken/readme.md": "x" };
  it("selects by exact root and keeps rejections of profile roots", () => {
    expect(frontendSelection(VERCEL_PROFILE, R1, "staged")).toBe("selected");
    expect(frontendSelection(VERCEL_PROFILE, "skills/other", "staged")).toBe("not-selected");
    expect(frontendSelection(VERCEL_PROFILE, "skills", "staged")).toBe("not-selected");
    expect(frontendSelection(VERCEL_PROFILE, "skills", "rejected")).toBe("selected");
    expect(frontendSelection(VERCEL_PROFILE, `${R1}/x`, "rejected")).toBe("selected");
    expect(frontendSelection(VERCEL_PROFILE, "skills/other", "rejected")).toBe("not-selected");
  });
  it("splits the record, recomputes the digest and reports missing roots", () => {
    const record = prep(files).record;
    const before = JSON.stringify(record);
    const r = partitionRecord(VERCEL_PROFILE, record);
    expect(JSON.stringify(record)).toBe(before);
    expect(r.record.skills.map((s) => s.root)).toEqual([R1]);
    expect(r.record.digest).toBe(importDigest(r.record.skills));
    expect(r.notSelected).toContain("skills/vercel-deploy-claimable");
    expect(r.missing).toEqual(["skills/react-best-practices", "skills/react-native-skills", "skills/web-design-guidelines"]);
  });
  it("does not report a root under another path or a rejected selected root as missing", () => {
    const record: ImportRecord = { ...prep(files).record, paths: ["other"] };
    expect(partitionRecord(VERCEL_PROFILE, record).missing).toEqual([]);
    const rejected: ImportRecord = { ...prep(files).record, rejected: [{ root: R2, reasons: ["x"] }] };
    const r = partitionRecord(VERCEL_PROFILE, rejected);
    expect(r.missing).not.toContain(R2);
    expect(r.record.rejected).toHaveLength(1);
  });
  it("does not depend on the order of the input", () => {
    const record = prep({ [`${R1}/SKILL.md`]: md("a"), [`${R2}/SKILL.md`]: md("c") }).record;
    const reversed: ImportRecord = { ...record, skills: [...record.skills].reverse() };
    expect(partitionRecord(VERCEL_PROFILE, reversed)).toEqual(partitionRecord(VERCEL_PROFILE, record));
  });
});

describe("applyFrontendRule", () => {
  it("replaces category, capabilities and technologies and keeps identity", () => {
    const skill = skillAt(R1, "capabilities: [typescript-strictness]\ntechnologies: [typescript]\n");
    const before = JSON.stringify(skill);
    const { skill: out } = applyFrontendRule(VERCEL_PROFILE, skill, []);
    expect(JSON.stringify(skill)).toBe(before);
    expect(out.package.category).toBe("frontend");
    expect(out.package.capabilities).toEqual(["react-composition"]);
    expect(out.provenance.technologies).toEqual([{ name: "react", version: ">=18" }]);
    expect(out.package.digest).toBe(skill.package.digest);
    expect(out.package.id).toBe(skill.package.id);
    expect(out.identity.fingerprint).toBe(skill.identity.fingerprint);
  });
  it("is reviewed only for a digest in the rule of that root", () => {
    const skill = skillAt(R1);
    const d = skill.package.digest;
    const rule = VERCEL_PROFILE.skills[R1]!;
    const withDigest = (digest: string, root: string): FrontendProfile => ({ ...VERCEL_PROFILE, skills: { ...VERCEL_PROFILE.skills, [root]: { ...VERCEL_PROFILE.skills[root]!, reviewed: [digest] } } });
    expect(applyFrontendRule(VERCEL_PROFILE, skill, []).record.reviewed).toBe(false);
    expect(applyFrontendRule(withDigest(d, R1), skill, []).record.reviewed).toBe(true);
    expect(applyFrontendRule(withDigest(d, R2), skill, []).record.reviewed).toBe(false);
    expect(rule.reviewed).toEqual([]);
    const changed = skillAt(R1, "# a changed byte\n");
    expect(applyFrontendRule(withDigest(d, R1), changed, []).record.reviewed).toBe(false);
  });
  it("tells the evaluation state apart from the review", () => {
    const skill = skillAt(R1);
    const id = skill.package.id;
    const d = skill.package.digest;
    const state = (results: Parameters<typeof applyFrontendRule>[2], p = VERCEL_PROFILE) => applyFrontendRule(p, skill, results).record.evaluation;
    expect(state([])).toBe("missing");
    expect(state([{ skill: id, digest: "sha256:" + "0".repeat(64), evaluation: "skill-gate", result: "passed" }])).toBe("missing");
    expect(state([{ skill: id, digest: d, evaluation: "skill-gate", result: "failed" }])).toBe("failed");
    expect(state([{ skill: id, digest: d, evaluation: "skill-gate", result: "passed" }])).toBe("passed");
    const none: FrontendProfile = { ...VERCEL_PROFILE, skills: { ...VERCEL_PROFILE.skills, [R1]: { ...VERCEL_PROFILE.skills[R1]!, evaluations: [] } } };
    expect(state([{ skill: id, digest: d, evaluation: "skill-gate", result: "passed" }], none)).toBe("missing");
  });
  it("throws for another repository or an unknown root", () => {
    expect(() => applyFrontendRule({ ...VERCEL_PROFILE, repositoryKey: "github.com/example/other" }, skillAt(R1), [])).toThrow(TypeError);
    expect(() => applyFrontendRule(VERCEL_PROFILE, skillAt("skills/unknown"), [])).toThrow(TypeError);
  });
});

describe("frontendBlocked", () => {
  const ok = { reviewed: true, evaluation: "passed" as const, tokens: 1, maxTokens: 5 };
  it("returns each code alone, all in order, or none", () => {
    expect(frontendBlocked(ok)).toEqual([]);
    expect(frontendBlocked({ ...ok, reviewed: false })).toEqual(["unreviewed"]);
    expect(frontendBlocked({ ...ok, evaluation: "missing" })).toEqual(["evaluation"]);
    expect(frontendBlocked({ ...ok, evaluation: "failed" })).toEqual(["evaluation"]);
    expect(frontendBlocked({ ...ok, hold: "x" })).toEqual(["hold"]);
    expect(frontendBlocked({ ...ok, tokens: 6 })).toEqual(["too-large"]);
    expect(frontendBlocked({ reviewed: false, evaluation: "missing", hold: "x", tokens: 6, maxTokens: 5 })).toEqual(["unreviewed", "evaluation", "hold", "too-large"]);
  });
});

describe("repoScanGaps and frontendEvidence", () => {
  const clean = { truncated: { files: false, bytes: false, findings: false }, skipped: { other: 0 } as Record<string, number> };
  const gaps = (t: Partial<typeof clean.truncated>, other = 0, extra: Record<string, number> = {}) =>
    repoScanGaps({ truncated: { ...clean.truncated, ...t }, skipped: { other, ...extra } as never });
  it("names each gap in order", () => {
    expect(gaps({})).toEqual([]);
    expect(gaps({ files: true })).toEqual(["too many files or folders"]);
    expect(gaps({ bytes: true })).toEqual(["too many bytes"]);
    expect(gaps({ findings: true })).toEqual(["too many findings"]);
    expect(gaps({}, 1)).toEqual(["unreadable entries"]);
    expect(gaps({ files: true, bytes: true, findings: true }, 2)).toEqual(["too many files or folders", "too many bytes", "too many findings", "unreadable entries"]);
    expect(gaps({}, 0, { symlink: 3, large: 2 })).toEqual([]);
  });
  const dep = (name: string, value: string | undefined, path = "package.json") => ({
    kind: "dependency" as const, name, ...(value !== undefined ? { value } : {}), path, detector: "package-json", reason: "x",
  });
  const ev = (findings: ReturnType<typeof dep>[], over: object = {}) => frontendEvidence(VERCEL_PROFILE, { ...clean, skipped: clean.skipped as never, findings, ...over });
  it.each([
    ["18.2.0", "18.2.0"], ["^18.2.0", "18"], ["~18.2.0", "18.2"], ["<18", "unknown"], [">=18", "unknown"],
    ["^0.72.1", "unknown"], ["latest", "unknown"], ["workspace:*", "unknown"], [undefined, "unknown"],
  ])("reads %s as %s", (value, version) => {
    expect(ev([dep("react", value)])).toEqual([{ name: "react", version }]);
  });
  it("gives unknown for different versions and the version for equal ones", () => {
    expect(ev([dep("react", "18.2.0"), dep("react", "17.0.2", "a/package.json")])).toEqual([{ name: "react", version: "unknown" }]);
    expect(ev([dep("react", "18.2.0"), dep("react", "18.2.0", "a/package.json")])).toEqual([{ name: "react", version: "18.2.0" }]);
  });
  it("ignores other files, kinds and names", () => {
    const other = { ...dep("react", "17.0.2"), kind: "framework" } as never;
    expect(ev([dep("react", "17.0.2", "pyproject.toml"), other, dep("lodash", "4.17.21")])).toEqual([]);
  });
  it("throws when the scan has a gap", () => {
    expect(() => ev([dep("react", "18.2.0")], { truncated: { ...clean.truncated, findings: true } })).toThrow(TypeError);
    expect(() => ev([dep("react", "18.2.0")], { skipped: { other: 1 } })).toThrow(/incomplete/);
  });
  it("is not fooled by a scan limit that hides a conflicting manifest", () => {
    const d = mkdtempSync(join(tmpdir(), "frontend-scan-"));
    try {
      mkdirSync(join(d, "packages/a"), { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { react: "18.2.0" } }));
      writeFileSync(join(d, "packages/a/package.json"), JSON.stringify({ dependencies: { react: "17.0.2" } }));
      const cut = buildRepoProfile(d, { limits: { findings: { dependency: 1 } } });
      expect(cut.findings.filter((f) => f.kind === "dependency" && f.name === "react").map((f) => f.value)).toEqual(["18.2.0"]);
      expect(repoScanGaps(cut)).toEqual(["too many findings"]);
      expect(() => frontendEvidence(VERCEL_PROFILE, cut)).toThrow(TypeError);
      expect(frontendEvidence(VERCEL_PROFILE, buildRepoProfile(d))).toEqual([{ name: "react", version: "unknown" }]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("a scan through buildRepoProfile", () => {
  const withFolder = (files: Record<string, string>, fn: (d: string) => void) => {
    const d = mkdtempSync(join(tmpdir(), "frontend-scan-"));
    try {
      for (const [p, t] of Object.entries(files)) {
        mkdirSync(join(d, p, ".."), { recursive: true });
        writeFileSync(join(d, p), t);
      }
      fn(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  it("is incomplete when an oversized workspace manifest could hide a conflicting version", () => {
    const big = JSON.stringify({ dependencies: { react: "17.0.2" }, padding: "x".repeat(300000) });
    withFolder({ "package.json": JSON.stringify({ dependencies: { react: "18.2.0" } }), "packages/a/package.json": big }, (d) => {
      const scan = buildRepoProfile(d);
      expect(repoScanGaps(scan)).toEqual(["unreadable entries"]);
      expect(() => frontendEvidence(VERCEL_PROFILE, scan)).toThrow(/incomplete/);
    });
  });
  it("gives unknown when one manifest declares different versions of a dependency", () => {
    withFolder({ "package.json": JSON.stringify({ dependencies: { react: "18.2.0" }, peerDependencies: { react: "17.0.2" } }) }, (d) => {
      expect(frontendEvidence(VERCEL_PROFILE, buildRepoProfile(d))).toEqual([{ name: "react", version: "unknown" }]);
    });
    withFolder({ "package.json": JSON.stringify({ dependencies: { react: "18.2.0" }, devDependencies: { react: "18.2.0" } }) }, (d) => {
      expect(frontendEvidence(VERCEL_PROFILE, buildRepoProfile(d))).toEqual([{ name: "react", version: "18.2.0" }]);
    });
  });
});

describe("emptyImportLines", () => {
  const src = { paths: ["skills"], repositoryKey: KEY };
  const roots = Object.keys(VERCEL_PROFILE.skills);
  it("reports only rejected selected folders as refused and the others as missing", () => {
    const lines = emptyImportLines(VERCEL_PROFILE, src, COMMIT, [{ root: R1, reasons: ["symlink"] }]);
    expect(lines[0]).toBe(`REFUSED ${R1}: symlink`);
    expect(lines.filter((l) => l.startsWith("MISSING "))).toHaveLength(roots.length - 1);
    expect(lines.at(-1)).toBe(`EVALUATED 0 skills from ${KEY}@${COMMIT.slice(0, 12)}: 1 refused, 0 conflicts`);
  });
  it("reports every root as missing for an empty skills folder", () => {
    const lines = emptyImportLines(VERCEL_PROFILE, src, COMMIT, [{ root: "skills", reasons: ["no SKILL.md below this path"] }]);
    expect(lines[0]).toMatch(/^REFUSED skills: /);
    expect(lines.filter((l) => l.startsWith("MISSING "))).toHaveLength(roots.length);
  });
  it("reports an unselected rejected folder as not selected", () => {
    const lines = emptyImportLines(VERCEL_PROFILE, src, COMMIT, [{ root: "skills/vercel-deploy-claimable", reasons: ["x"] }]);
    expect(lines[0]).toMatch(/^NOT-SELECTED skills\/vercel-deploy-claimable/);
    expect(lines.at(-1)).toContain("0 refused");
  });
});
