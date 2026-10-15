import { describe, expect, it } from "vitest";
import type { EvaluationPolicy } from "../src/skills/evaluation.js";
import type { ImportReview, ReviewedSkill } from "../src/skills/import-review.js";
import type { OverlapEntry, OverlapReport } from "../src/skills/overlap.js";
import { catalogueProblems } from "../src/skills/overlap-staged.js";
import {
  compareImports, evaluationKey, evaluationLookups, notComparedMarkdown, recordVerdict, SOURCE_CHANGE_LIMITS, sourceChangeLine, sourceChangeMarkdown,
  type ComparedImport, type RecordVerdict,
} from "../src/skills/source-change.js";

const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";
const SENTINEL = "SENTINEL-UPSTREAM-BODY-TEXT";
const dg = (c: string) => "sha256:" + c.repeat(64);
const SUITE = dg("b");

const skill = (root: string, o: Partial<ReviewedSkill> = {}): ReviewedSkill => ({
  root,
  name: root.split("/").pop()!,
  digest: dg("1"),
  id: root.split("/").pop()!,
  version: "1.0.0",
  fingerprint: "fp",
  capabilities: [],
  category: "general",
  categoryFrom: "default",
  trust: "community",
  promoted: false,
  licence: { status: "allowed", reasons: [], licences: ["MIT"], attribution: [], authorNotice: [] },
  scan: { blocked: false, findings: 0, high: 0, reasons: [] },
  sameName: [],
  ...o,
} as ReviewedSkill);
const review = (commit: string, skills: ReviewedSkill[], digest = dg("a")): ImportReview => ({
  schema: 1, source: "lib", repositoryKey: "github.com/example/skills", commit, digest,
  categories: [{ category: "general", existing: [], skills }], collisions: [], compared: { imported: skills.length, existing: 0 }, problems: [],
});
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)] as const));
const side = (skills: ReviewedSkill[], f: Record<string, string> = {}, extra: Partial<ComparedImport> = {}, commit = OLD): ComparedImport => ({ review: review(commit, skills), files: files(f), ...extra });
const NONE = { problem: "x" } as const;
const noEval = new Map<string, RecordVerdict>();

describe("compareImports: skill roots", () => {
  it("classifies added, removed, changed and unchanged roots and orders them", () => {
    const old = side([skill("skills/same"), skill("skills/gone"), skill("skills/mod", { digest: dg("2") })]);
    const next = side([skill("skills/same"), skill("skills/new"), skill("skills/mod", { digest: dg("3") })], {}, {}, NEW);
    const c = compareImports(old, next, noEval, NONE);
    expect(c.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(c.skills.map((s) => [s.root, s.kind])).toEqual([["skills/mod", "changed"], ["skills/new", "added"], ["skills/gone", "removed"], ["skills/same", "unchanged"]]);
    expect([c.oldCommit, c.newCommit]).toEqual([OLD, NEW]);
  });

  it("lists added, removed and changed files by SHA-256 and bounds the lists", () => {
    const f1 = { "skills/a/SKILL.md": "one", "skills/a/keep.txt": "k", "skills/a/gone.txt": "g", "skills/b/x": "x" };
    const f2: Record<string, string> = { "skills/a/SKILL.md": "two", "skills/a/keep.txt": "k", "skills/a/new.txt": "n", "skills/b/x": "y" };
    const c = compareImports(side([skill("skills/a")], f1), side([skill("skills/a", { digest: dg("2") })], f2, {}, NEW), noEval, NONE);
    expect(c.skills[0]!.files).toEqual({ added: ["new.txt"], removed: ["gone.txt"], changed: ["SKILL.md"] });

    const many: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      many[`skills/a/f${String(i).padStart(2, "0")}`] = "1";
      after[`skills/a/f${String(i).padStart(2, "0")}`] = "2";
    }
    const big = compareImports(side([skill("skills/a")], many), side([skill("skills/a", { digest: dg("2") })], after, {}, NEW), noEval, NONE);
    const md = sourceChangeMarkdown(big);
    expect(md).toContain("Files changed (25)");
    expect(md).toContain("`f19`, … and 5 more");
    expect(md).not.toContain("`f20`");
  });
});

describe("compareImports: metadata, licence and scan", () => {
  const o = skill("skills/a", { digest: dg("2"), capabilities: ["alpha", "beta"] });
  const n = skill("skills/a", {
    digest: dg("3"), name: "renamed", version: "2.0.0", category: "testing", capabilities: ["beta", "gamma"],
    licence: { status: "review", reasons: [], licences: ["MIT", "Apache-2.0"], attribution: [], authorNotice: [] },
    scan: { blocked: true, findings: 3, high: 2, reasons: ["2 high findings"] },
  });
  const c = compareImports(side([o]), side([n], {}, {}, NEW), noEval, NONE);
  const s = c.skills[0]!;

  it("records old → new values", () => {
    expect(s.metadata).toEqual({
      name: { old: "a", next: "renamed" }, version: { old: "1.0.0", next: "2.0.0" }, category: { old: "general", next: "testing" },
      capabilities: { added: ["gamma"], removed: ["alpha"] },
    });
    expect(s.licence).toEqual({ status: { old: "allowed", next: "review" }, licences: { old: ["MIT"], next: ["MIT", "Apache-2.0"] } });
    expect(s.scan).toEqual({ blocked: { old: false, next: true }, high: { old: 0, next: 2 }, findings: { old: 0, next: 3 } });
  });
  it("prints every category", () => {
    const md = sourceChangeMarkdown(c);
    for (const t of [
      "- Name: `a` → `renamed`", "- Version: `1.0.0` → `2.0.0`", "- Category: `general` → `testing`", "- Capabilities: added `gamma`; removed `alpha`",
      "status `allowed` → `review`", "- Scan: blocked no → yes; high findings 0 → 2; findings 0 → 3",
    ]) expect(md).toContain(t);
  });
  it("shows a licence or scan change of a skill whose digest did not change", () => {
    const same = compareImports(side([skill("skills/a")]), side([skill("skills/a", { licence: { status: "missing", reasons: [], licences: [], attribution: [], authorNotice: [] } })], {}, {}, NEW), noEval, NONE);
    expect(same.skills[0]).toMatchObject({ kind: "unchanged", licence: { status: { old: "allowed", next: "missing" } } });
    expect(sourceChangeMarkdown(same)).toContain("status `allowed` → `missing`");
  });
  it("compares the licence evidence digest", () => {
    const differ = compareImports(side([], {}, { licenceDigest: dg("d") }), side([], {}, { licenceDigest: dg("e") }, NEW), noEval, NONE);
    expect(differ.licenceDigest).toEqual({ old: dg("d"), next: dg("e") });
    expect(sourceChangeMarkdown(differ)).toContain(`Licence evidence digest: \`${dg("d")}\` → \`${dg("e")}\``);
    const equal = compareImports(side([], {}, { licenceDigest: dg("d") }), side([], {}, { licenceDigest: dg("d") }, NEW), noEval, NONE);
    expect(equal.licenceDigest).toBeUndefined();
    expect(sourceChangeMarkdown(equal)).toContain("Licence evidence digest: unchanged.");
  });
  it("carries a licence review that is missing or stale", () => {
    expect(compareImports(side([]), side([], {}, { licenceUnreviewed: true }, NEW), noEval, NONE).licenceUnreviewed).toBe(true);
    expect(compareImports(side([]), side([], {}, {}, NEW), noEval, NONE).licenceUnreviewed).toBe(false);
  });
});

describe("evaluation", () => {
  const old = side([skill("skills/a", { digest: dg("2") }), skill("skills/same")]);
  const next = side([skill("skills/a", { digest: dg("3") }), skill("skills/same"), skill("skills/n", { digest: dg("4") })], {}, {}, NEW);
  const passed: RecordVerdict = { state: "passed" };

  it("looks up only added and changed skills, old digest of changed ones included", () => {
    expect(evaluationLookups(old.review, next.review)).toEqual([
      { id: "a", digest: dg("3") }, { id: "a", digest: dg("2") }, { id: "n", digest: dg("4") },
    ]);
  });
  it("never lets a changed digest inherit the old verdict", () => {
    const c = compareImports(old, next, new Map([[evaluationKey("a", dg("2")), passed]]), NONE);
    const a = c.skills.find((s) => s.root === "skills/a")!;
    expect(a.evaluation).toEqual({ old: passed, next: { state: "none" } });
    expect(c.evaluationOpen).toBe(2);
    expect(sourceChangeMarkdown(c)).toContain("- Evaluation: old digest: passed; new digest: needs a new record");
    expect(sourceChangeMarkdown(c)).toContain("2 added or changed skills need a new evaluation record.");
  });
  it("counts a passing record for the new digest as closed", () => {
    const c = compareImports(old, next, new Map([[evaluationKey("a", dg("3")), passed], [evaluationKey("n", dg("4")), passed]]), NONE);
    expect(c.evaluationOpen).toBe(0);
    expect(sourceChangeLine(c, OLD)).toBe(`CHANGES since ${OLD.slice(0, 12)}: 1 changed, 1 added, 0 removed, 1 unchanged`);
  });
  it("reports a failed, an unreadable and an unjudged record, and a skill that was not normalized", () => {
    const v = new Map<string, RecordVerdict>([
      [evaluationKey("a", dg("3")), { state: "failed", reasons: ["below-threshold:selection"] }],
      [evaluationKey("n", dg("4")), { state: "invalid" }],
    ]);
    const md = sourceChangeMarkdown(compareImports(old, next, v, NONE));
    expect(md).toContain("failed (`below-threshold:selection`) — needs a new record");
    expect(md).toContain("record cannot be read — needs a new record");
    const unjudged = compareImports(old, next, new Map([[evaluationKey("n", dg("4")), { state: "unjudged" }]]), NONE);
    expect(sourceChangeMarkdown(unjudged)).toContain("record found, not judged (no evaluation suite) — needs a new record");
    expect(unjudged.evaluationOpen).toBe(2);
    const bare = { ...skill("skills/n", { digest: dg("4") }), id: undefined } as ReviewedSkill;
    const nn = compareImports(old, side([bare], {}, {}, NEW), noEval, NONE);
    expect(nn.skills.find((s) => s.root === "skills/n")!.evaluation).toEqual({ next: { state: "not-normalized" } });
    expect(sourceChangeMarkdown(nn)).toContain("new digest: not normalized");
  });
});

describe("recordVerdict and evaluationLookups", () => {
  const ID = "alpha";
  const DIGEST = dg("a");
  const rec = (dims: Record<string, number[]> = {}, o: Record<string, unknown> = {}) => ({
    schema: 1,
    candidate: { id: ID, version: "1.0.0", digest: DIGEST, fingerprint: "fp-alpha", source: "github", repositoryKey: "github.com/acme/skills", commit: "1".repeat(40) },
    suite: { digest: SUITE, scenarios: [{ id: "s-one", inputs: { prompt: "fix a bug" } }] },
    runtime: { foundry: "0.1.0", agent: "claude", model: "m-1" },
    evaluatedAt: "2026-10-13T10:00:00Z",
    dimensions: { selection: [1], conflicts: [1], context: [1], tools: [1], ...dims },
    findings: [],
    evidence: [{ name: "log", digest: DIGEST }],
    ...o,
  });
  const policy: EvaluationPolicy = { suite: SUITE };
  const ok = (raw: unknown, p: EvaluationPolicy | undefined = policy, id = ID, digest = DIGEST) => recordVerdict({ state: "ok", raw }, id, digest, p);

  it("passes through none and invalid", () => {
    expect(recordVerdict({ state: "none" }, ID, DIGEST, policy)).toEqual({ state: "none" });
    expect(recordVerdict({ state: "invalid" }, ID, DIGEST, policy)).toEqual({ state: "invalid" });
    expect(ok({ junk: true })).toEqual({ state: "invalid" });
    expect(ok("text")).toEqual({ state: "invalid" });
  });
  it("passes a good record and fails a low score with a fixed code", () => {
    expect(ok(rec())).toEqual({ state: "passed" });
    expect(ok(rec({ selection: [0.1] }))).toEqual({ state: "failed", reasons: ["below-threshold:selection"] });
  });
  it("does not judge without the policy of a suite", () => {
    expect(recordVerdict({ state: "ok", raw: rec() }, ID, DIGEST)).toEqual({ state: "unjudged" });
  });
  it("uses the mandatory instructions of the suite policy", () => {
    const weak = rec({ instructions: [0.1, 0.1, 0.1] });
    expect(ok(weak)).toEqual({ state: "passed" });
    const strict: EvaluationPolicy = { suite: SUITE, mandatory: ["instructions"] };
    expect(ok(weak, strict)).toEqual({ state: "failed", reasons: ["below-threshold:instructions"] });
    expect(ok(rec(), strict)).toEqual({ state: "failed", reasons: ["dimension-missing:instructions"] });
  });
  it("fails a record made with another suite", () => {
    expect(ok(rec(), { suite: dg("c") })).toEqual({ state: "failed", reasons: ["suite-mismatch"] });
  });
  it("calls a record of another digest or id invalid or failed", () => {
    expect(ok(rec(), policy, ID, dg("c"))).toEqual({ state: "failed", reasons: ["digest-mismatch"] });
    expect(ok(rec(), policy, "beta")).toEqual({ state: "invalid" });
  });
});

// ---- canonical skills ----

const entry = (e: Partial<OverlapEntry> & { kind: OverlapEntry["kind"]; capability: string }): OverlapEntry => ({ rejected: [], ...e }) as OverlapEntry;
const rep = (entries: OverlapEntry[]): OverlapReport => ({ schema: 1, source: "lib", problems: [], entries, shared: 0, new: 0, conflicts: entries.filter((e) => e.kind === "conflict").length, vendorOnly: 0, versions: [], ok: true });
const canon = (cap: string): OverlapEntry => entry({ kind: "canonical", capability: cap, winner: { id: "built-in", version: "1.0.0", origin: "builtin" }, level: "only-candidate" });
const conflict = (cap: string): OverlapEntry =>
  entry({ kind: "conflict", capability: cap, conflict: "tied", skills: [{ id: "a", version: "1.0.0", origin: "staged" }, { id: "adm", version: "2.0.0", origin: "admin", provider: "acme" }] });

describe("affected canonical skills", () => {
  const old = side([skill("skills/a", { digest: dg("2"), capabilities: ["x"] }), skill("skills/q", { capabilities: ["q"] })]);
  const next = side([skill("skills/a", { digest: dg("3"), capabilities: ["x", "y"] }), skill("skills/q", { capabilities: ["q"] })], {}, {}, NEW);

  it("shows only capabilities of added or changed skills, plus new conflicts", () => {
    const report = rep([canon("q"), canon("x"), conflict("y"), conflict("z"), canon("zz")]);
    const c = compareImports(old, next, noEval, { next: report, old: rep([conflict("z")]) });
    if (!("entries" in c.canonical)) throw new Error("no entries");
    expect(c.canonical.entries.map((e) => [e.entry.capability, e.newConflict])).toEqual([["x", undefined], ["y", true]]);
  });
  it("marks a conflict that was already there, and stays silent when the old report is unknown", () => {
    const c = compareImports(old, next, noEval, { next: rep([conflict("y"), conflict("w")]), old: rep([conflict("y")]) });
    expect("entries" in c.canonical && c.canonical.entries.map((e) => [e.entry.capability, e.newConflict])).toEqual([["y", false], ["w", true]].sort());
    const unknown = compareImports(old, next, noEval, { next: rep([conflict("y")]) });
    expect("entries" in unknown.canonical && unknown.canonical.entries[0]!.newConflict).toBeUndefined();
    expect(sourceChangeMarkdown(unknown)).not.toContain("(new conflict)");
  });
  it("keeps new conflicts first and says how many entries were left out", () => {
    const caps = Array.from({ length: 250 }, (_, i) => `cap-${String(i).padStart(3, "0")}`);
    const many = side([skill("skills/a", { digest: dg("3"), capabilities: caps })], {}, {}, NEW);
    const entries = caps.map((c) => (c === "cap-249" ? conflict(c) : canon(c)));
    const c = compareImports(old, many, noEval, { next: rep(entries), old: rep([]) });
    if (!("entries" in c.canonical)) throw new Error("no entries");
    expect(c.canonical.entries).toHaveLength(SOURCE_CHANGE_LIMITS.canonical);
    expect(c.canonical.omitted).toBe(50);
    expect(c.canonical.entries.some((e) => e.entry.capability === "cap-249" && e.newConflict === true)).toBe(true);
    expect(c.canonical.entries.at(-1)!.entry.capability).toBe("cap-249");
    expect(sourceChangeMarkdown(c)).toContain("… and 50 more affected capabilities were left out (new conflicts are listed first).");
    expect(sourceChangeMarkdown(compareImports(old, next, noEval, { next: rep([canon("x")]) }))).not.toContain("left out (new");
  });
  it("uses the capabilities the catalogue sees, not the raw ones", () => {
    const mapped = side([skill("skills/a", { digest: dg("3"), capabilities: ["streams"] })], {}, { capabilities: new Map([["skills/a", ["kafka-streams"]]]) }, NEW);
    const none = side([skill("skills/a", { digest: dg("3"), capabilities: [] })], {}, { capabilities: new Map([["skills/a", ["from-selection"]]]) }, NEW);
    const report = rep([canon("streams"), canon("kafka-streams"), canon("from-selection")]);
    const caps = (n: ComparedImport) => {
      const c = compareImports(old, n, noEval, { next: report }).canonical;
      return "entries" in c ? c.entries.map((e) => e.entry.capability) : [];
    };
    expect(caps(mapped)).toEqual(["kafka-streams"]);
    expect(caps(none)).toEqual(["from-selection"]);
  });
  it("prints the result table, new conflicts and a problem", () => {
    const md = sourceChangeMarkdown(compareImports(old, next, noEval, { next: rep([canon("x"), conflict("y")]), old: rep([]) }));
    expect(md).toContain("| `x` | canonical (only-candidate) | `built-in@1.0.0` (builtin) |");
    expect(md).toContain("| `y` | CONFLICT tied (new conflict) | `a@1.0.0` (staged), `adm@2.0.0` (admin, provider `acme`) |");
    expect(sourceChangeMarkdown(compareImports(old, next, noEval, { problem: "the catalogue skills could not be read in full" }))).toContain("could not be compared: `the catalogue skills could not be read in full`");
    expect(sourceChangeMarkdown(compareImports(old, next, noEval, { next: rep([]) }))).toContain("No capability of an added or changed skill is affected.");
  });
});

describe("sourceChangeMarkdown", () => {
  it("says so when nothing changed", () => {
    const c = compareImports(side([skill("skills/a")]), side([skill("skills/a")], {}, {}, NEW), noEval, { next: rep([]) });
    const md = sourceChangeMarkdown(c);
    expect(md).toContain(`### Changes since \`${OLD.slice(0, 12)}\``);
    expect(md).toContain("Unchanged (1): `skills/a`");
    expect(md).not.toContain("#### Skills");
    const empty = sourceChangeMarkdown(compareImports(side([]), side([], {}, {}, NEW), noEval, NONE));
    expect(empty).toContain("No skill changed.");
  });
  it("lists the roots with their digests", () => {
    const md = sourceChangeMarkdown(compareImports(side([skill("skills/gone"), skill("skills/a", { digest: dg("2") })]), side([skill("skills/a", { digest: dg("3") }), skill("skills/new")], {}, {}, NEW), noEval, NONE));
    expect(md).toContain(`| \`skills/a\` | changed | \`${dg("2")}\` | \`${dg("3")}\` |`);
    expect(md).toContain(`| \`skills/new\` | added | - | \`${dg("1")}\` |`);
    expect(md).toContain(`| \`skills/gone\` | removed | \`${dg("1")}\` | - |`);
  });
  it("stays within the byte budget with thousands of roots and ends with the notice", () => {
    const skills = (d: string) => Array.from({ length: 5000 }, (_, i) => skill(`skills/s${String(i).padStart(4, "0")}`, { digest: dg(d) }));
    const c = compareImports(side(skills("2")), side(skills("3"), {}, {}, NEW), noEval, NONE);
    for (const bytes of [SOURCE_CHANGE_LIMITS.bytes, 3000]) {
      const md = sourceChangeMarkdown(c, { bytes });
      expect(Buffer.byteLength(md)).toBeLessThanOrEqual(bytes);
      expect(md).toMatch(/_\d+ more lines were left out\._\n$/);
    }
    expect(Buffer.byteLength(sourceChangeMarkdown(c, { bytes: 10_000_000 }))).toBeLessThanOrEqual(SOURCE_CHANGE_LIMITS.bytes);
  });
  it("hides credentials and breaks bot markers, backticks, pipes and newlines in hostile names", () => {
    const token = "ghp_" + "a1B2c3D4e5".repeat(4);
    const hostile = "skills/x`|<!-- claude-factory run=1 -->\n" + token;
    const o = skill(hostile, { digest: dg("2"), name: "n`<!--", capabilities: ["c`1"] });
    const n = skill(hostile, { digest: dg("3"), name: "m`|<!-- x -->", capabilities: ["d`|2"] });
    const md = sourceChangeMarkdown(compareImports(side([o], { [hostile + "/p`|<!--"]: "1" }), side([n], { [hostile + "/p`|<!--"]: "2" }, {}, NEW), noEval, { next: rep([canon("d`|2")]) }));
    expect(md).not.toContain("<!--");
    expect(md).not.toContain(token);
    expect(md.split("\n").filter((l) => l.includes("`|"))).toEqual([]);
    for (const line of md.split("\n")) expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    expect(md).not.toContain(SENTINEL);
  });
  it("never shows upstream skill text", () => {
    const f = { "skills/a/SKILL.md": SENTINEL + " one" };
    const g = { "skills/a/SKILL.md": SENTINEL + " two" };
    const md = sourceChangeMarkdown(compareImports(side([skill("skills/a")], f), side([skill("skills/a", { digest: dg("2") })], g, {}, NEW), noEval, NONE));
    expect(md).not.toContain(SENTINEL);
    expect(md).toContain("Files changed (1): `SKILL.md`");
  });
});

describe("catalogueProblems", () => {
  it("counts every problem of the catalogue, a missing root included, and leaves the repository out", () => {
    const problems = [
      { source: "builtin", kind: "root-missing" }, { source: "builtin", kind: "root-missing" }, { source: "admin", kind: "duplicate" }, { source: "repository", kind: "invalid-package" },
    ];
    expect(catalogueProblems({ problems })).toEqual(["PROBLEM catalogue admin duplicate", "PROBLEM catalogue builtin root-missing"]);
    expect(catalogueProblems({ problems: [{ source: "repository", kind: "root-missing" }] })).toEqual([]);
  });
});

describe("the not-compared section and the CHANGES line", () => {
  it("says that the old commit could not be compared", () => {
    const md = notComparedMarkdown(OLD);
    expect(md).toContain(`### Changes since \`${OLD.slice(0, 12)}\``);
    expect(md).toContain("could not be staged or read, so it could not be compared");
    expect(sourceChangeLine("not-compared", OLD)).toBe(`CHANGES the old commit ${OLD.slice(0, 12)} could not be compared`);
  });
  it("counts what needs a new record", () => {
    const c = compareImports(side([]), side([skill("skills/n")], {}, {}, NEW), noEval, NONE);
    expect(sourceChangeLine(c, OLD)).toBe(`CHANGES since ${OLD.slice(0, 12)}: 0 changed, 1 added, 0 removed, 0 unchanged; 1 needs a new evaluation record`);
  });
});
