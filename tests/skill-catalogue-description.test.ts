import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillSelectionView } from "../src/server/skill-selection-view.js";
import { buildSkillCatalogue, shownDescription } from "../src/skills/catalogue.js";
import {
  catalogueDescriptionOf, catalogueDescriptionProblem, descriptionEvidence, descriptionOverrideProblems, type DescriptionOverrideLike,
} from "../src/skills/catalogue-description.js";
import type { NormalizedSkill } from "../src/skills/normalize.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { runSkillCatalogue } from "../src/skills/run-catalogue.js";
import { parseSkillSelections } from "../src/skills/selections.js";
import type { SkillLibrarySource, SourcesManifest } from "../src/skills/sources.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DIGEST = "sha256:" + "a".repeat(64);
// Built from pieces: tools/secret-scan reads this file too.
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);

describe("catalogueDescriptionProblem", () => {
  it("accepts 1 to 160 characters", () => {
    expect(catalogueDescriptionProblem("x")).toBeUndefined();
    expect(catalogueDescriptionProblem("d".repeat(160))).toBeUndefined();
  });
  it.each([
    ["161 characters", "d".repeat(161)],
    ["empty", ""],
    ["blank", "   "],
    ["a leading space", " x"],
    ["a trailing space", "x "],
    ["a control character", "a\u0007b"],
    ["an invisible character", "a​b"],
    ["a lone surrogate", "a\ud801b"],
    ["a credential", `use ${TOKEN}`],
  ])("refuses %s", (_n, text) => {
    expect(catalogueDescriptionProblem(text)).toBeTypeOf("string");
  });
});

const entry = (o: Record<string, unknown> = {}) => ({
  source: "lib", skill: "notes", digest: DIGEST, scope: "portable", category: "docs", capabilities: ["notes"], owner: "@octocat", reviewed: "2026-10-13", ...o,
});
const parse = (e: unknown) => parseSkillSelections({ schema: 1, selections: [e] }, "2026-10-13");
const where = (e: unknown) => parse(e).problems.map((p) => `${p.where}: ${p.message}`).join("\n");

describe("catalogue_description in skill-selections.yaml", () => {
  it("is kept on the entry, and an entry without it is unchanged", () => {
    const r = parse(entry({ catalogue_description: "Short text." }));
    expect(r.problems).toEqual([]);
    expect(r.manifest!.selections[0]!.catalogueDescription).toBe("Short text.");
    const plain = parse(entry()).manifest!.selections[0]!;
    expect("catalogueDescription" in plain).toBe(false);
  });
  it("refuses a value that cannot be shown, at the field", () => {
    for (const bad of [null, 5, "", "   ", "d".repeat(161), " x", "a\u0007b", TOKEN]) {
      const w = where(entry({ catalogue_description: bad }));
      expect(w, String(bad)).toContain("selections[0] (lib/notes) catalogue_description:");
    }
  });
});

const skillOf = (name: string, digest = DIGEST, source = "lib"): NormalizedSkill =>
  ({ package: { id: `${source}-${name}`, digest }, provenance: { name, source } }) as unknown as NormalizedSkill;

describe("catalogueDescriptionOf", () => {
  const sels: DescriptionOverrideLike[] = [{ source: "lib", skill: "notes", digest: DIGEST, catalogueDescription: "Short." }];
  it("matches the same source, name and digest only", () => {
    expect(catalogueDescriptionOf(skillOf("notes"), "lib", sels)).toBe("Short.");
    expect(catalogueDescriptionOf(skillOf("notes"), "other", sels)).toBeUndefined();
    expect(catalogueDescriptionOf(skillOf("other"), "lib", sels)).toBeUndefined();
    expect(catalogueDescriptionOf(skillOf("notes", "sha256:" + "b".repeat(64)), "lib", sels)).toBeUndefined();
    expect(catalogueDescriptionOf(skillOf("notes"), "lib", [{ ...sels[0]!, catalogueDescription: undefined }])).toBeUndefined();
  });
  it("gives a stable evidence digest of the text", () => {
    expect(descriptionEvidence("a")).toEqual(descriptionEvidence("a"));
    expect(descriptionEvidence("a").digest).not.toBe(descriptionEvidence("b").digest);
    expect(descriptionEvidence("a").name).toBe("catalogue-description");
  });
});

describe("descriptionOverrideProblems", () => {
  const COMMIT = "c".repeat(40);
  const src = (o: Partial<SkillLibrarySource> = {}): SkillLibrarySource =>
    ({ id: "lib", status: "enabled", ref: { approved: COMMIT }, ...o }) as unknown as SkillLibrarySource;
  const manifest = (...s: SkillLibrarySource[]): SourcesManifest => ({ schema: 1, sources: s });
  const sel = (o: Partial<DescriptionOverrideLike> = {}): DescriptionOverrideLike => ({ source: "lib", skill: "notes", digest: DIGEST, catalogueDescription: "Short.", ...o });
  const staged = (...s: NormalizedSkill[]) => vi.fn((_id: string, _commit: string) => s as readonly NormalizedSkill[] | undefined);

  it("passes an override of a staged skill of an enabled, approved source", () => {
    const st = staged(skillOf("notes"));
    expect(descriptionOverrideProblems([sel()], { sources: manifest(src()), staged: st })).toEqual([]);
    expect(st).toHaveBeenCalledWith("lib", COMMIT);
  });
  it.each([
    ["an unknown source", sel({ source: "nope" }), manifest(src()), "not in skill-sources.yaml"],
    ["a disabled source", sel(), manifest(src({ status: "disabled" })), "is disabled"],
    ["no approved commit", sel(), manifest(src({ ref: {} })), "no approved commit"],
    ["another digest", sel({ digest: "sha256:" + "b".repeat(64) }), manifest(src()), "no staged skill notes with this digest"],
    ["another skill", sel({ skill: "other" }), manifest(src()), "no staged skill other"],
  ])("gives one problem for %s", (_n, s, sources, text) => {
    const p = descriptionOverrideProblems([s], { sources, staged: staged(skillOf("notes")) });
    expect(p).toHaveLength(1);
    expect(p[0]!.where).toBe(`selections[0] (${s.source}/${s.skill}) catalogue_description`);
    expect(p[0]!.message).toContain(text);
  });
  it("gives a problem when no staged import can be used", () => {
    const p = descriptionOverrideProblems([sel()], { sources: manifest(src()), staged: () => undefined });
    expect(p[0]!.message).toContain("no staged skill");
  });
  it("says when the sources file cannot be read", () => {
    const p = descriptionOverrideProblems([sel()], { sources: { problem: "does not exist" }, staged: staged() });
    expect(p[0]!.message).toContain("cannot be checked");
  });
  it("checks nothing for entries without an override", () => {
    const st = staged();
    expect(descriptionOverrideProblems([sel({ catalogueDescription: undefined })], { sources: { problem: "x" }, staged: st })).toEqual([]);
    expect(st).not.toHaveBeenCalled();
  });
});

const digest = `sha256:${"a".repeat(64)}`;
function sk(id: string, description: string, o: Partial<RegisteredSkill> = {}): RegisteredSkill {
  return {
    key: `${id}@1.0.0`, id, version: "1.0.0", source: "admin", label: "x", dir: "", active: true, trust: "approved", pin: "pinned", digest,
    pkg: { id, version: "1.0.0", description, instructions: "Body.", roles: [], dependencies: [], conflicts: [], capabilities: ["notes"] },
    ...o,
  } as unknown as RegisteredSkill;
}
const LONG = "Long upstream description. ".repeat(14).trim();
const over = (text: string, release?: string) => ({ catalogueDescription: { text, from: "skill-selections" as const, ...(release ? { release } : {}) } });
const shown = (r: RegisteredSkill[], opts: Parameters<typeof buildSkillCatalogue>[1] = {}) => buildSkillCatalogue({ skills: r }, opts);

describe("the catalogue and the description override", () => {
  it("shows the override instead of the package's description", () => {
    const c = shown([sk("a", LONG, over("Short for a."))]);
    expect(c.entries[0]!.description).toBe("Short for a.");
    expect(shownDescription(sk("a", LONG, over("Short for a.", "acme@1.0.0")))).toEqual({ text: "Short for a.", from: "skill-selections", release: "acme@1.0.0" });
  });
  it("shows a skill without an override as before: the package's text, cut at 160", () => {
    const c = shown([sk("a", LONG)]);
    expect(c.entries[0]!.description).toHaveLength(160);
    expect(c.entries[0]!.description.endsWith("…")).toBe(true);
    expect(shownDescription(sk("a", LONG))).toEqual({ text: LONG, from: "package" });
  });
  it("has the same five fields with and without an override", () => {
    const a = shown([sk("a", LONG)]).entries[0]!;
    const b = shown([sk("a", LONG, over("Short."))]).entries[0]!;
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect({ ...a, description: "" }).toEqual({ ...b, description: "" });
  });
  it("lets the short text keep skills inside the token limit that the long text drops", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const withOver = ids.map((id) => sk(id, LONG, over("Short.")));
    const plain = ids.map((id) => sk(id, LONG));
    const maxTokens = shown(withOver, { limits: { maxTokens: 20000 } }).estimatedTokens;
    expect(maxTokens).toBeGreaterThanOrEqual(100);
    const a = shown(withOver, { limits: { maxTokens } });
    const b = shown(plain, { limits: { maxTokens } });
    expect(a.entries).toHaveLength(6);
    expect(a.truncated.tokens).toBe(false);
    expect(b.truncated.tokens).toBe(true);
    expect(b.entries.length < 6 || b.entries.some((e) => e.description.length < 160)).toBe(true);
  });
});

describe("runSkillCatalogue and the description override", () => {
  const empty = mkdtempSync(join(tmpdir(), "run-desc-"));
  afterAll(() => rmSync(empty, { recursive: true, force: true }));
  const run = (skills: RegisteredSkill[]) =>
    runSkillCatalogue({ workdir: "/work/x", config: ConfigSchema.parse({}), task: "" }, {
      discover: () => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] }),
      profile: () => buildRepoProfile(empty),
    });
  it("shows the text, records it with its release and says so in the log", () => {
    const r = run([sk("a", LONG, over("Short for a.", "acme@1.0.0")), sk("b", LONG)]);
    expect(r.text).toContain("Short for a.");
    expect(r.record!.descriptions).toEqual([{ skill: "a@1.0.0", text: "Short for a.", from: "skill-selections", release: "acme@1.0.0" }]);
    expect(r.record!.descriptionsOmitted).toBeUndefined();
    expect(r.log).toContain("1 catalogue description from skill-selections");
  });
  it("records the text the agent saw when the token limit shortens a pinned entry", () => {
    const ids = ["a", "b", "c"];
    const full = "Override text that is long on purpose. ".repeat(4).trim();
    // Long capability lists make a full entry cost more than a shortened one, so the limit (which must hold the minimal form of every pin) can force shortening.
    const caps = Array.from({ length: 6 }, (_, i) => `capability-${i}-${"x".repeat(45)}`);
    const skills = ids.map((id) => {
      const s = sk(id, LONG, over(full, "acme@1.0.0"));
      return { ...s, pkg: { ...s.pkg, capabilities: caps, instructions: `Body of ${id}.` } } as RegisteredSkill;
    });
    const runWith = (maxTokens: number) =>
      runSkillCatalogue({ workdir: "/work/x", config: ConfigSchema.parse({ skills: { catalogue: { include: ids, max_tokens: maxTokens } } }), task: "" }, {
        discover: () => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] }),
        profile: () => buildRepoProfile(empty),
      });
    const big = runWith(20000);
    expect(big.record!.descriptions!.every((d) => d.text === full)).toBe(true);
    expect(big.record!.estimatedTokens).toBeGreaterThan(400);
    const small = runWith(400);
    const seen = new Map(small.text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { id: string; description: string }).map((e) => [`${e.id}@1.0.0`, e.description]));
    expect(small.record!.descriptions!.some((d) => d.text.length < full.length)).toBe(true);
    for (const d of small.record!.descriptions!) expect(d.text).toBe(seen.get(d.skill));
  });

  it("records nothing for skills without an override", () => {
    const r = run([sk("b", LONG)]);
    expect(r.record!.descriptions).toBeUndefined();
    expect(r.log).not.toContain("catalogue description");
  });
  it("keeps at most 20 and counts the rest", () => {
    const skills = Array.from({ length: 25 }, (_, i) => sk(`s${String(i).padStart(2, "0")}`, LONG, over("Short.", "acme@1.0.0")));
    const r = run(skills);
    expect((r.record!.descriptions ?? []).length + (r.record!.descriptionsOmitted ?? 0)).toBe(r.record!.entries);
    expect(r.record!.descriptions!.length).toBeLessThanOrEqual(20);
  });
});

describe("skillSelectionView and descriptions", () => {
  const d = (o: any = {}) => ({ skill: "a@1.0.0", text: "Short.", from: "skill-selections", release: "acme@1.0.0", ...o });
  const view = (cat: any) => skillSelectionView({ history: [{ id: "plan", skillCatalogue: cat }] } as any, { admin: false });
  it("passes the text and its origin through", () => {
    const v = view({ descriptions: [d()] })!;
    expect(v.descriptions).toEqual([d()]);
    expect(v.counts.descriptions).toBe(1);
  });
  it("drops bad entries", () => {
    const v = view({ descriptions: [d(), d({ skill: "nope" }), d({ release: 5 }), d({ from: "package" }), d({ text: "x".repeat(161) }), d({ text: "a\u0007b" }), d({ text: 4 }), null] })!;
    expect(v.descriptions).toEqual([d()]);
  });
  it("is undefined when every entry is bad", () => {
    expect(view({ descriptions: [d({ text: "" })] })).toBeUndefined();
  });
  it("caps the list and counts the omitted ones", () => {
    const list = Array.from({ length: 25 }, (_, i) => d({ skill: `s${i}@1.0.0` }));
    const v = view({ descriptions: list, descriptionsOmitted: 3 })!;
    expect(v.descriptions).toHaveLength(20);
    expect(v.counts.descriptions).toBe(28);
  });
});
