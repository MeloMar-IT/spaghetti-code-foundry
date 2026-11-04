import { describe, expect, it } from "vitest";
import { isFoundryComment } from "../src/github.js";
import {
  effectImproveSignals, improveDecision, improveFailedMarker, improveFailures, improveSignals, improveStateOf, improveTarget, libraryNamesOf, mergeLibrary,
  parseEffectSummary, publishedLibrarySkills, quarantineImproveSignals, reviewImproveSignals, type LibSkill,
} from "../src/skills/improve.js";
import { effectLines } from "../src/skills/effect.js";
import { improveIssueText } from "../src/skills/gap-issues.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const skill = (id: string, version = "1.0.0", o: Partial<LibSkill> = {}): LibSkill => ({ key: `${id}@${version}`, id, version, digest: `sha256:${id}${version}`, active: true, ...o }) as LibSkill;
const lib = (names: string[] = ["demo"], extra: Partial<Parameters<typeof libraryNamesOf>[0]> = {}) =>
  libraryNamesOf({ names, digests: new Map(), qualify: (n) => `lib-${n}`, ledger: [], ...extra });
const effectOf = (verdict: string, w = [4, 12], wo = [4, 12]) => ({ state: "ok", file: "x", record: { verdict: { verdict, with: { passed: w[0], runs: w[1] }, without: { passed: wo[0], runs: wo[1] } } } }) as any;
const review = (id: string, loaded: string[], days = 1, o: { role?: "reviewer"; line?: string } = {}): any => ({
  runId: id, flow: "x", status: "succeeded", startedAt: new Date(NOW - days * DAY).toISOString(), vars: {},
  history: [
    { id: "code", ok: true, output: "", skills: { loaded, bytes: 1, estimatedTokens: 1, ...(o.role ? { role: o.role } : {}) } },
    { id: "review", ok: true, output: o.line ?? "- [high] input is not validated: a security problem" },
  ],
});

describe("effect signal", () => {
  const sig = (verdict: string, skills = [skill("lib-demo")], l = lib()) => effectImproveSignals({ skills, lib: l, effect: () => effectOf(verdict) });
  it("fires for no-measurable-effect and harms, with the counts", () => {
    expect(sig("no-measurable-effect")).toMatchObject([{ topic: "improve:demo", skill: "demo", installed: ["lib-demo@1.0.0"], kinds: ["effect"], evidence: { effect: { verdict: "no-measurable-effect", with: { passed: 4, runs: 12 } } } }]);
    expect(sig("harms")).toHaveLength(1);
  });
  it("is silent for helps, no record, an invalid record and a skill outside the library", () => {
    expect(sig("helps")).toEqual([]);
    for (const state of [{ state: "none" }, { state: "invalid", problem: "x" }]) expect(effectImproveSignals({ skills: [skill("lib-demo")], lib: lib(), effect: () => state as any })).toEqual([]);
    expect(sig("harms", [skill("other")])).toEqual([]);
  });
  it("checks every installed version, not only the newest", () => {
    const skills = [skill("lib-demo", "1.0.0"), skill("lib-demo", "2.0.0")];
    const out = effectImproveSignals({ skills, lib: lib(), effect: (_id, digest) => effectOf(digest.endsWith("1.0.0") ? "harms" : "helps") });
    expect(out.map((s) => s.installed)).toEqual([["lib-demo@1.0.0"]]);
  });
  it("finds a skill by digest too", () => {
    const l = libraryNamesOf({ names: [], digests: new Map([["sha256:abc", "demo"]]), qualify: (n) => n, ledger: [] });
    expect(sig("harms", [skill("renamed", "1.0.0", { digest: "sha256:abc" })], l)).toHaveLength(1);
  });
});

describe("review signal", () => {
  const run = (runs: any[], skills = [skill("lib-demo")]) => reviewImproveSignals({ now: NOW, runs, skills, lib: lib() });
  const three = (o: Parameters<typeof review>[3] = {}, days = 1) => ["a", "b", "c"].map((id) => review(id, ["lib-demo@1.0.0"], days, o));
  it("fires at 3 distinct runs in 14 days with one finding kind", () => {
    const [s] = run(three());
    expect(s).toMatchObject({ topic: "improve:demo", kinds: ["review"], installed: ["lib-demo@1.0.0"], evidence: { findingKinds: ["security"], runs: ["a", "b", "c"] } });
  });
  it("implicates only the exact version the coder loaded, not every installed version of the name", () => {
    const v2 = ["a", "b", "c"].map((id) => review(id, ["lib-demo@2.0.0"]));
    const [s] = run(v2, [skill("lib-demo", "1.0.0"), skill("lib-demo", "2.0.0")]);
    expect(s!.installed).toEqual(["lib-demo@2.0.0"]);
    // runs on two versions: each version is named once, and the target is the highest of them
    const both = ["a", "b", "c"].map((id, i) => review(id, [i === 0 ? "lib-demo@1.0.0" : "lib-demo@2.0.0"]));
    const [t] = run(both, [skill("lib-demo", "1.0.0"), skill("lib-demo", "2.0.0")]);
    expect(t!.installed).toEqual(["lib-demo@1.0.0", "lib-demo@2.0.0"]);
    expect(improveTarget(`- Installed: ${t!.installed.map((k) => `\`${k}\``).join(", ")}\n<!-- scf skill-improve=demo -->`)?.installed).toBe("lib-demo@2.0.0");
  });
  it("is silent at 2 runs, for old runs and for a reviewer-only block", () => {
    expect(run(three().slice(0, 2))).toEqual([]);
    expect(run(three({}, 20))).toEqual([]);
    expect(run([...three().slice(0, 2), review("c", ["lib-demo@1.0.0"], 20)])).toEqual([]);
    expect(run(three({ role: "reviewer" }))).toEqual([]);
  });
  it("counts a run once and ignores runs that did not load the skill", () => {
    expect(run([...three().slice(0, 2), review("a", ["lib-demo@1.0.0"])])).toEqual([]);
    expect(run([...three().slice(0, 2), review("c", ["other@1.0.0"])])).toEqual([]);
  });
  it("reports two kinds in one signal", () => {
    const both = (id: string) => review(id, ["lib-demo@1.0.0"], 1, { line: "- [high] security hole\n- [medium] a race condition" });
    const out = run([both("a"), both("b"), both("c")]);
    expect(out).toHaveLength(2);
    const merged = improveSignals({ now: NOW, runs: [both("a"), both("b"), both("c")], skills: [skill("lib-demo")], lib: lib(), effect: () => ({ state: "none" }) });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence.findingKinds).toEqual(["concurrency", "security"]);
  });
});

describe("quarantine signal", () => {
  const q = (state: string) => skill("lib-demo", "1.0.0", { lifecycle: { state } as any });
  it("fires for a quarantined entry, also next to a healthy newer version", () => {
    expect(quarantineImproveSignals({ skills: [q("quarantined")], lib: lib() })).toMatchObject([{ kinds: ["quarantine"], evidence: { state: "quarantined" } }]);
    expect(quarantineImproveSignals({ skills: [q("quarantined"), skill("lib-demo", "2.0.0")], lib: lib() }).map((s) => s.installed)).toEqual([["lib-demo@1.0.0"]]);
  });
  it("is silent for deprecated, active and skills outside the library", () => {
    expect(quarantineImproveSignals({ skills: [q("deprecated"), skill("lib-demo", "2.0.0")], lib: lib() })).toEqual([]);
    expect(quarantineImproveSignals({ skills: [{ ...q("quarantined"), id: "other", key: "other@1.0.0" }], lib: lib() })).toEqual([]);
  });
});

describe("library membership and merging", () => {
  it("knows a source-qualified id from a selection, and a ledger name alone", () => {
    expect(effectImproveSignals({ skills: [skill("lib-demo")], lib: lib(["demo"]), effect: () => effectOf("harms") })).toHaveLength(1);
    const ledgerOnly = libraryNamesOf({ names: [], digests: new Map(), qualify: (n) => n, ledger: ["demo"] });
    expect(ledgerOnly.byId.get("demo")).toBe("demo");
  });
  it("merges effect, review and quarantine of one name into one signal", () => {
    const skills = [skill("lib-demo", "1.0.0", { lifecycle: { state: "quarantined" } as any })];
    const runs = ["a", "b", "c"].map((id) => review(id, ["lib-demo@1.0.0"]));
    const [s, ...rest] = improveSignals({ now: NOW, runs, skills, lib: lib(), effect: () => effectOf("harms") });
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ topic: "improve:demo", kinds: ["effect", "review", "quarantine"], installed: ["lib-demo@1.0.0"] });
  });
  it("chain: publication → import → signal → issue with the library name and the installed key", () => {
    const published: any = { runId: "w1", flow: "skill-write", status: "succeeded", startedAt: new Date(NOW).toISOString(), vars: { github_repo: "Lib/Skills" }, history: [{ id: "pick", output: "SKILL_NAME: demo\nSKILL_CHANGE: new" }, { id: "publish", output: "PUBLISHED: abcdef1234567" }] };
    const names = publishedLibrarySkills([published], "lib/skills");
    expect(names).toEqual(["demo"]);
    const l = libraryNamesOf({ names: [], digests: new Map(), qualify: (n) => `src-${n}-1234`, ledger: names });
    const [s] = improveSignals({ now: NOW, runs: [], skills: [skill("src-demo-1234", "1.2.0")], lib: l, effect: () => effectOf("no-measurable-effect") });
    const t = improveIssueText(s!);
    expect(t.title).toBe("Improve skill demo");
    expect(t.body).toContain("`src-demo-1234@1.2.0`");
    expect(t.body.trimEnd().split("\n").at(-1)).toBe("<!-- scf skill-improve=demo -->");
    expect(improveTarget(t.body)).toEqual({ name: "demo", installed: "src-demo-1234@1.2.0" });
  });
  it("publishedLibrarySkills needs the skill-write flow, the repository and a PUBLISHED line", () => {
    const base: any = { runId: "w", flow: "skill-write", vars: { github_repo: "lib/skills" }, history: [{ id: "pick", output: "SKILL_NAME: demo" }, { id: "publish", output: "PUBLISHED: abcdef1234567" }] };
    expect(publishedLibrarySkills([{ ...base, vars: { github_repo: "other/repo" } }], "lib/skills")).toEqual([]);
    expect(publishedLibrarySkills([{ ...base, history: [base.history[0]] }], "lib/skills")).toEqual([]);
    expect(publishedLibrarySkills([{ ...base, flow: "chore" }], "lib/skills")).toEqual([]);
  });
  it("mergeLibrary keeps old names, adds new ones, caps the size and reports a change", () => {
    const old = { a: "2026-01-01T00:00:00.000Z" };
    expect(mergeLibrary(old, ["a"], NOW)).toEqual({ library: old, changed: false });
    const m = mergeLibrary(old, ["b", "Bad Name"], NOW);
    expect(Object.keys(m.library)).toEqual(["a", "b"]);
    expect(m.changed).toBe(true);
    const capped = mergeLibrary({ a: "2026-01-01T00:00:00.000Z", b: "2026-02-01T00:00:00.000Z" }, ["c"], NOW, 2);
    expect(Object.keys(capped.library).sort()).toEqual(["b", "c"]);
  });
});

describe("not better, do not publish", () => {
  const line = (verdict: string, w: [number, number], wo: [number, number] = [3, 12]) =>
    `EFFECT demo@1.0.0 ${verdict} (improved): with ${w[0]}/${w[1]}, without ${wo[0]}/${wo[1]}, difference +0.75, p 0.0010; tokens 1 vs 1; time 1 s vs 1 s`;
  const d = (n: string, o: string) => improveDecision(parseEffectSummary(n), parseEffectSummary(o));
  it("refuses a lower pass rate, a verdict that is not helps, different run counts and unreadable lines", () => {
    expect(d(line("helps", [10, 12]), line("helps", [11, 12]))).toEqual({ publish: false, why: "not-better-than-old" });
    expect(d(line("no-measurable-effect", [12, 12]), line("helps", [1, 12]))).toEqual({ publish: false, why: "new-does-not-help" });
    expect(d(line("helps", [12, 12]), line("helps", [8, 10]))).toEqual({ publish: false, why: "not-comparable" });
    expect(d("garbage", line("helps", [1, 12]))).toEqual({ publish: false, why: "unreadable" });
    expect(improveDecision(parseEffectSummary(line("helps", [1, 12])), undefined)).toEqual({ publish: false, why: "unreadable" });
  });
  it("publishes an equal or better score, and a helping version when the old one was offered nowhere", () => {
    expect(d(line("helps", [11, 12]), line("helps", [11, 12]))).toEqual({ publish: true });
    expect(d(line("helps", [12, 12]), line("helps", [11, 12]))).toEqual({ publish: true });
    expect(d(line("helps", [9, 12]), line("helps", [0, 0], [0, 0]))).toEqual({ publish: true });
  });
  it("reads the EFFECT line effectLines prints, also with the OLD prefix", () => {
    const record: any = {
      skill: { id: "demo", version: "1.0.0" }, suite: { repeat: 4 }, scenarios: [],
      runs: { with: [], without: [] }, verdict: { verdict: "helps", reason: "improved", with: { passed: 11, runs: 12 }, without: { passed: 3, runs: 12 }, difference: 0.5, p: 0.01 },
    };
    const text = effectLines(record).at(-1)!;
    expect(parseEffectSummary(text)).toEqual({ id: "demo", version: "1.0.0", verdict: "helps", with: { passed: 11, runs: 12 }, without: { passed: 3, runs: 12 } });
    expect(parseEffectSummary(`OLD ${text}`)?.with).toEqual({ passed: 11, runs: 12 });
  });
});

describe("improve issue and failures", () => {
  it("improveTarget reads the marker and the first installed key", () => {
    const body = "x\n- Installed: `a-1@1.0.0`, `a-1@2.0.0`\n<!-- scf skill-improve=demo -->";
    expect(improveTarget(body)).toEqual({ name: "demo", installed: "a-1@2.0.0" });
    expect(improveTarget("- Installed: `a-1@2.0.0`, `a-1@10.0.0`, `a-1@9.1.0`\n<!-- scf skill-improve=demo -->")).toEqual({ name: "demo", installed: "a-1@10.0.0" });
    expect(improveTarget("- Installed: `a-1@9.1.0`\n- Installed: `a-1@1.0.0`\n<!-- scf skill-improve=demo -->")).toEqual({ name: "demo", installed: "a-1@9.1.0" });
    expect(improveTarget("- Installed: `a@1`\n<!-- scf skill-improve=Bad Name -->")).toBeUndefined();
    expect(improveTarget("<!-- scf skill-improve=demo -->")).toBeUndefined();
    expect(improveTarget("- Installed: `a@1`\n<!-- scf skill-gap=demo -->")).toBeUndefined();
    expect(improveTarget("- Installed: `a;rm -rf@1`\n<!-- scf skill-improve=demo -->")).toBeUndefined();
  });
  const comment = (run: string, viewerDidAuthor?: boolean) => ({ body: `text\n${improveFailedMarker(run)}\n<!-- claude-factory run=${run} -->`, ...(viewerDidAuthor === undefined ? {} : { viewerDidAuthor }) });
  const json = (...c: object[]) => JSON.stringify({ comments: c });
  const failures = (j: string, run: string) => improveFailures(j, run, isFoundryComment);
  it("counts distinct run ids of verified comments, plus the current run", () => {
    expect(failures(json(comment("r1", true)), "r2")).toBe(2);
    expect(failures(json(comment("r1", true), comment("r1", true)), "r2")).toBe(2);
    expect(failures(json(comment("r2", true)), "r2")).toBe(1);
    expect(failures(json(), "r2")).toBe(1);
  });
  it("ignores comments without verified authorship and a forged marker", () => {
    expect(failures(json(comment("r1", false), comment("r3")), "r2")).toBe(1);
    expect(failures(json({ body: improveFailedMarker("r1"), viewerDidAuthor: true }), "r2")).toBe(1);
  });
  it("reads the state of a version from its lifecycle history; an unclear text is unknown", () => {
    const t = (line: string) => `#1 2026-01-01T00:00:00.000Z cli ${line}`;
    expect(improveStateOf("No lifecycle history for demo@1.0.0")).toBe("active");
    expect(improveStateOf(t("active → quarantined: unsafe"))).toBe("quarantined");
    expect(improveStateOf(`${t("active → quarantined: unsafe")}\n#2 2026-01-02T00:00:00.000Z cli allow-run r1: ok`)).toBe("quarantined");
    expect(improveStateOf(`${t("active → quarantined: x")}\n${t("quarantined → deprecated: y")}`)).toBe("deprecated");
    expect(improveStateOf(`${t("active → deprecated: x")}\nrelease owner revoked 2026-01-01: y`)).toBe("release-revoked");
    expect(improveStateOf("PROBLEM the skill lifecycle record is unreadable")).toBe("unknown");
    expect(improveStateOf("")).toBe("unknown");
    expect(improveStateOf(`${t("active → quarantined: x")}\nnot a line we know`)).toBe("unknown");
  });
  it("counts only the current run for broken JSON", () => {
    expect(failures("{nope", "r2")).toBe(1);
  });
});
