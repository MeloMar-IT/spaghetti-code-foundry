import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { CATALOGUE_DEFAULTS } from "../src/skills/catalogue-rules.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import { evaluationGate, parseEvaluationRecord } from "../src/skills/evaluation.js";
import { EVALUATION_LIMITS, EVALUATION_OFFLINE } from "../src/skills/evaluation-rules.js";
import {
  scoreContext, scoreConflicts, scoreEvaluation, scoreSelection, scoreTools, type ComparedSkill, type EvaluationScoreInput,
} from "../src/skills/evaluation-score.js";
import { parseEvaluationSuite, readEvaluationSuite, type EvaluationSuite } from "../src/skills/evaluation-suite.js";
import { buildSkillIdentity } from "../src/skills/identity.js";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import { BUILTIN_SKILLS, clearSkillRegistryCache, discoverSkills, type RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { applyExceptions } from "../src/skills/scan-exceptions.js";
import { scanSkill, type ScanFinding } from "../src/skills/scan.js";
import type { DecidedReport } from "../src/skills/scan-exceptions.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillscore-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

type F = { path: string; content: Uint8Array };
const A: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };
const B: NormalizeOrigin = { source: "mir", repository: "https://github.com/other/skills", repositoryKey: "github.com/other/skills", commit: "b".repeat(40) };
const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const doc = (name: string, o: { extra?: string; body?: string; description?: string; meta?: string } = {}) =>
  f("SKILL.md", `---\nname: ${name}\ndescription: ${o.description ?? `About ${name}.`}\n${o.meta ? `metadata:\n${o.meta}` : ""}${o.extra ?? ""}---\n\n${o.body ?? "Body."}\n`);
const yaml = (text: string) => f("skill.yaml", text);
const skill = (files: F[], origin: NormalizeOrigin = A): NormalizedSkill => {
  const r = normalizeSkill(origin, { root: "skills/x", files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
};
const cand = (s: NormalizedSkill, approved = false): CollisionCandidate => ({ skill: s, approved, trust: "community", licencesAllowed: ["MIT"] });
const imp = (s: NormalizedSkill, approved = true): ComparedSkill => ({ kind: "imported", candidate: cand(s, approved), licence: "allowed", safety: true });
const reg = (s: NormalizedSkill, o: Partial<RegisteredSkill> = {}): RegisteredSkill => registered(s.package.id, s.package.version, s.package.digest, s.package.capabilities ?? [], o);
const kafkaPkg = loadSkillPackage(join(BUILTIN_SKILLS, "kafka"));
function registered(id: string, version: string, digest: string, capabilities: string[], o: Partial<RegisteredSkill> = {}): RegisteredSkill {
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "x", dir: "", active: true, trust: "approved", pin: "pinned", digest,
    pkg: { ...kafkaPkg, id, version, digest, capabilities },
    ...o,
  };
}
/** The same id from another upstream, which the source-qualified id of a real import does not give but a hand-made record can. */
const otherUpstream = (s: NormalizedSkill): NormalizedSkill => ({ ...s, identity: { ...s.identity, upstream: "other/upstream" } });
const regd =(r: RegisteredSkill): ComparedSkill => ({ kind: "registered", skill: r });

const profileOf = (files: Record<string, string>) => {
  const root = tmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return buildRepoProfile(root);
};
const npm = (deps: Record<string, string>) => JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps });
const KAFKA_REPO = profileOf({ "package.json": npm({ kafkajs: "2" }) });
const REST_REPO = profileOf({ "package.json": npm({ express: "4" }) });
const profiles = new Map([["kafka", KAFKA_REPO], ["rest", REST_REPO]]);

const KAFKA = () => skill([doc("notes"), yaml("capabilities: [kafka]\n")]);
const sel = (id: string, repo: string, expect: "offered" | "not-offered", task = "Change the code.", modules: string[] = []) => ({ id, repo, task, modules, expect });
const bare = (s: NormalizedSkill) => cand(s);
const finding = (id: string, severity: ScanFinding["severity"]): ScanFinding => ({ id, rule: "r", category: "unsafe-network", severity, path: "SKILL.md", evidence: "e" } as ScanFinding);
const decided = (s: NormalizedSkill, ...fs: ScanFinding[]): DecidedReport => ({
  schema: 1, skill: s.identity.id, digest: s.package.digest, report: "sha256:" + "d".repeat(64), findings: fs.map((x) => ({ finding: x, disposition: "open" as const })),
});
const codes = (r: { findings: { code: string }[] }) => r.findings.map((x) => x.code);
const conf = (id = "c1", w: "all" | string[] = "all") => ({ id, with: w });
const registry = () => discoverSkills(ConfigSchema.parse({}).skills, { env: {}, userHome: tmp() }).skills;

describe("scoreSelection", () => {
  it("counts positive and negative scenarios", () => {
    const c = bare(KAFKA());
    const r = scoreSelection(c, [sel("a", "kafka", "offered"), sel("b", "rest", "not-offered")], profiles, []);
    expect(r).toEqual({ sample: 1, findings: [] });
  });
  it("scores a wrong positive and a wrong negative", () => {
    const c = bare(KAFKA());
    const r = scoreSelection(c, [sel("a", "kafka", "offered"), sel("b", "rest", "offered"), sel("c", "kafka", "not-offered"), sel("d", "rest", "not-offered")], profiles, []);
    expect(r.sample).toBe(0.5);
    expect(r.findings).toEqual([
      { code: "not-offered", dimension: "selection", scenario: "b" },
      { code: "offered-unexpectedly", dimension: "selection", scenario: "c" },
    ]);
  });
  it("throws a TypeError for a missing profile", () => {
    expect(() => scoreSelection(bare(KAFKA()), [sel("a", "nope", "offered")], profiles, [])).toThrow(TypeError);
  });
  it("replaces an approved skill with the id of the candidate", () => {
    const s = KAFKA();
    const c = bare(s);
    const dup = reg(s, { description: undefined } as never);
    const r = scoreSelection(c, [sel("a", "kafka", "offered")], profiles, [regd(dup), imp(s)]);
    expect(r.sample).toBe(1);
  });
  it("lets approved imported skills compete: a full catalogue can push the candidate out", () => {
    const s = skill([doc("zzz-notes"), yaml("capabilities: [kafka]\n")]);
    const rivals = Array.from({ length: CATALOGUE_DEFAULTS.maxCandidates }, (_, i) =>
      skill([doc(`aaa-${String(i).padStart(2, "0")}`, { body: `Rival ${i}.` }), yaml("capabilities: [kafka]\n")]));
    const scenario = [sel("a", "kafka", "offered")];
    expect(scoreSelection(bare(s), scenario, profiles, rivals.map((r) => imp(r))).sample).toBe(0);
    expect(scoreSelection(bare(s), scenario, profiles, rivals.map((r) => imp(r, false))).sample).toBe(1);
  });
  it("passes modules on", () => {
    const mono = profileOf({ "services/a/package.json": npm({ kafkajs: "2" }), "services/b/package.json": npm({ express: "4" }) });
    const m = new Map([["mono", mono]]);
    const c = bare(KAFKA());
    expect(scoreSelection(c, [sel("a", "mono", "offered", "Change it.", ["services/a"]), sel("b", "mono", "not-offered", "Change it.", ["services/b"])], m, []).sample).toBe(1);
  });
});

describe("scoreConflicts (imported pool)", () => {
  const base = (origin = A, extra = "", body = "Body.") => skill([doc("notes", { body }), yaml(`version: 1.0.0\n${extra}`)], origin);
  it("scores 1 and mode new when nothing is shared", () => {
    const r = scoreConflicts(bare(base()), [conf()], [imp(skill([doc("other")], B))]);
    expect(r).toMatchObject({ sample: 1, findings: [], mode: "new" });
  });
  it("fails version-reuse: the same upstream and version with other content", () => {
    const r = scoreConflicts(bare(base(A, "", "Changed body.")), [conf()], [imp(base())]);
    expect(r.sample).toBe(0);
    expect(codes(r)).toEqual(["version-reuse"]);
    expect(r.findings[0]!.detail).toMatch(/@1\.0\.0$/);
  });
  it("fails id-conflict: the same id from another repository", () => {
    const r = scoreConflicts(bare(base()), [conf()], [imp(otherUpstream(base(A, "", "Other.")))]);
    expect(r.sample).toBe(0);
    expect(codes(r)).toEqual(["id-conflict"]);
  });
  const older = () => skill([doc("notes", { body: "Older." }), yaml("version: 0.9.0\n")]);
  it("fails a lower approved version without a baseline", () => {
    const r = scoreConflicts(bare(base()), [conf()], [imp(older())]);
    expect(r).toMatchObject({ sample: 0, mode: "new" });
    expect(codes(r)).toEqual(["id-conflict"]);
  });
  it("passes it as an upgrade when the baseline is named", () => {
    const o = imp(older());
    const r = scoreConflicts(bare(base()), [conf()], [o], o);
    expect(r).toMatchObject({ sample: 1, mode: "upgrade" });
    expect(codes(r)).toEqual(["upgrade-of"]);
    expect(r.baseline).toMatchObject({ version: "0.9.0" });
  });
  it("can name the baseline in `with` and still upgrades", () => {
    const o = imp(older());
    const id = o.kind === "imported" ? o.candidate.skill.identity.id : "";
    const r = scoreConflicts(bare(base()), [conf("c1", [id])], [o], o);
    expect(r).toMatchObject({ sample: 1, mode: "upgrade" });
    expect(codes(r)).toEqual(["upgrade-of"]);
  });
  it("refuses a baseline that is higher, another id or another upstream", () => {
    const high = imp(skill([doc("notes", { body: "Newer." }), yaml("version: 2.0.0\n")]));
    const other = imp(skill([doc("other")], B));
    const elsewhere = imp(otherUpstream(skill([doc("notes", { body: "Else." }), yaml("version: 0.5.0\n")])));
    for (const b of [high, other, elsewhere]) {
      const r = scoreConflicts(bare(base()), [conf()], [b], b);
      expect(r.sample).toBe(0);
      expect(codes(r)).toContain("baseline-not-replaceable");
      expect(r.mode).not.toBe("upgrade");
    }
  });
  it("still fails a second approved version next to a valid baseline", () => {
    const o = imp(older());
    const other = imp(skill([doc("notes", { body: "Middle." }), yaml("version: 0.95.0\n")]));
    const r = scoreConflicts(bare(base()), [conf()], [o, other], o);
    expect(r.sample).toBe(0);
    expect(codes(r)).toContain("id-conflict");
  });
  it("reports a fork and marks the evaluation as a duplicate", () => {
    const r = scoreConflicts(bare(base()), [conf()], [imp(skill([doc("notes", { body: "Fork." }), yaml("version: 1.0.0\n")], B))]);
    expect(codes(r)).toEqual(["fork"]);
    expect(r).toMatchObject({ sample: 1, mode: "duplicate" });
  });
  it("reports a capability overlap with the canonical winner as a duplicate", () => {
    const mine = skill([doc("alpha"), yaml("capabilities: [shared]\n")]);
    const r = scoreConflicts(bare(mine), [conf()], [imp(skill([doc("beta"), yaml("capabilities: [shared]\n")], B))]);
    expect(r.findings[0]).toMatchObject({ code: "capability-overlap" });
    expect(r.findings[0]!.detail).toContain("shares shared");
    expect(r).toMatchObject({ sample: 1, mode: "duplicate" });
  });
  it("ignores an unapproved pool member", () => {
    const r = scoreConflicts(bare(base()), [conf()], [imp(base(A, "", "Changed body."), false)]);
    expect(r).toMatchObject({ sample: 1, findings: [], mode: "new" });
  });
  it("compares only the named skills, and fails on an unknown one", () => {
    const clash = imp(otherUpstream(base(A, "", "Other.")));
    const clashId = clash.kind === "imported" ? clash.candidate.skill.identity.id : "";
    expect(scoreConflicts(bare(base()), [conf("c1", ["nothing-here"])], [clash]).sample).toBe(0);
    expect(codes(scoreConflicts(bare(base()), [conf("c1", ["nothing-here"])], [clash]))).toEqual(["compared-skill-missing"]);
    const mine = skill([doc("mine")], B);
    expect(scoreConflicts(bare(mine), [conf("c1", [clashId])], [clash]).sample).toBe(1);
  });
});

describe("scoreConflicts (registered pool)", () => {
  const mine = skill([doc("notes"), yaml("version: 1.0.0\ncapabilities: [shared]\n")]);
  const id = mine.identity.id;
  const run = (r: RegisteredSkill, baseline?: RegisteredSkill) => scoreConflicts(bare(mine), [conf()], [regd(r)], baseline ? regd(baseline) : undefined);
  it("ignores the same digest", () => {
    expect(run(registered(id, "1.0.0", mine.package.digest, [])).findings).toEqual([]);
  });
  it("fails the same id and version with another digest", () => {
    const r = run(registered(id, "1.0.0", "sha256:" + "1".repeat(64), []));
    expect(r.sample).toBe(0);
    expect(codes(r)).toEqual(["version-reuse"]);
  });
  it("fails a lower version without a baseline, and upgrades with one", () => {
    const old = registered(id, "0.9.0", "sha256:" + "2".repeat(64), []);
    expect(codes(run(old))).toEqual(["id-conflict"]);
    expect(run(old, old)).toMatchObject({ sample: 1, mode: "upgrade", baseline: { id, version: "0.9.0" } });
  });
  it("reports a shared capability", () => {
    const r = run(registered("builtin-one", "1.0.0", "sha256:" + "3".repeat(64), ["shared"]));
    expect(codes(r)).toEqual(["capability-overlap"]);
    expect(r.mode).toBe("duplicate");
  });
  it("ignores an unapproved registered skill", () => {
    expect(run(registered(id, "1.0.0", "sha256:" + "1".repeat(64), [], { trust: "unapproved" })).sample).toBe(1);
  });
});

describe("scoreContext", () => {
  const big = (n: number) => "word ".repeat(n);
  const run = (s: NormalizedSkill, limits: { max_instruction_tokens?: number; max_description_chars?: number } = { max_instruction_tokens: 3000, max_description_chars: 160 }) =>
    scoreContext(bare(s), [{ id: "ctx", ...limits }]);
  it("passes within the limits and without budgets", () => {
    expect(run(skill([doc("notes")]))).toEqual({ sample: 1, findings: [] });
  });
  it("fails over the suite limits", () => {
    const r = run(skill([doc("notes", { body: big(400) })]), { max_instruction_tokens: 100 });
    expect(codes(r)).toEqual(["instructions-over-limit"]);
    expect(r.sample).toBe(0);
    expect(codes(run(skill([doc("notes", { description: "d".repeat(50) })]), { max_description_chars: 20 }))).toEqual(["description-over-limit"]);
  });
  it("fails over the declared budgets", () => {
    const tokens = run(skill([doc("notes", { body: big(400), meta: '  budget-coder-tokens: "100"\n' })]), { max_instruction_tokens: 20000 });
    expect(codes(tokens)).toEqual(["instructions-over-budget"]);
    const chars = run(skill([doc("notes", { description: "d".repeat(50), meta: '  budget-planner-chars: "20"\n' })]), { max_description_chars: 1000 });
    expect(codes(chars)).toEqual(["description-over-budget"]);
  });
  it("fails a description the catalogue would cut", () => {
    const r = run(skill([doc("notes", { description: "d".repeat(161) })]), { max_description_chars: 1000 });
    expect(codes(r)).toEqual(["description-cut"]);
    expect(r.sample).toBe(0);
  });
  it("fails an invalid budget", () => {
    const r = run(skill([doc("notes", { meta: '  budget-coder-tokens: "lots"\n' })]));
    expect(codes(r)).toEqual(["budget-invalid"]);
  });
});

describe("scoreTools", () => {
  const policy = (o: Partial<{ shell: boolean; network: boolean; filesystem: "read" | "write" }> = {}) =>
    [{ id: "tool", policy: { shell: false, network: false, filesystem: "read" as const, ...o } }];
  it("passes a read-only skill under a read-only policy", () => {
    const s = skill([doc("notes")]);
    expect(scoreTools(bare(s), policy(), decided(s))).toEqual({ sample: 1, findings: [] });
  });
  it("names the tool the policy does not allow", () => {
    const shell = skill([doc("notes", { extra: "allowed-tools: Bash\n" })]);
    const r = scoreTools(bare(shell), policy(), decided(shell));
    expect(r.sample).toBe(0);
    expect(r.findings).toEqual([{ code: "tool-not-approved", dimension: "tools", scenario: "tool", detail: "shell" }]);
    expect(scoreTools(bare(shell), policy({ shell: true }), decided(shell)).sample).toBe(1);
    const net = skill([doc("notes", { extra: "allowed-tools: WebFetch\n" })]);
    expect(scoreTools(bare(net), policy(), decided(net)).findings[0]).toMatchObject({ detail: "network" });
    const write = skill([doc("notes", { extra: "allowed-tools: Write\n" })]);
    expect(scoreTools(bare(write), policy(), decided(write)).findings[0]).toMatchObject({ detail: "write" });
    expect(scoreTools(bare(write), policy({ filesystem: "write" }), decided(write)).sample).toBe(1);
  });
  it("reports a connector", () => {
    const s = skill([doc("notes"), yaml("connectors: [github]\n")]);
    expect(scoreTools(bare(s), policy(), decided(s)).findings[0]).toMatchObject({ code: "connector-unavailable", detail: "connector:github" });
  });
  it("reports an open high finding, and passes an accepted one", () => {
    const s = skill([doc("notes")]);
    const open = scoreTools(bare(s), policy(), decided(s, finding("0123456789abcdef", "high")));
    expect(open.findings).toEqual([{ code: "scan-high-open", dimension: "tools", scenario: "tool", detail: "0123456789abcdef" }]);
    const accepted = decided(s, finding("0123456789abcdef", "high"));
    accepted.findings[0]!.disposition = "accepted";
    expect(scoreTools(bare(s), policy(), accepted).sample).toBe(1);
    expect(scoreTools(bare(s), policy(), decided(s, finding("0123456789abcdef", "medium"))).sample).toBe(1);
  });
  it("reports a decided report of another package", () => {
    const s = skill([doc("notes")]);
    const other = { ...decided(s), digest: "sha256:" + "9".repeat(64) };
    expect(codes(scoreTools(bare(s), policy(), other))).toEqual(["safety-mismatch"]);
  });
});

describe("scoreEvaluation", () => {
  const suite = (): EvaluationSuite =>
    parseEvaluationSuite({
      schema: 1,
      selection: [
        { id: "yes", repo: "kafka", task: "Change it.", expect: "offered" },
        { id: "no", repo: "rest", task: "Change it.", expect: "not-offered" },
      ],
      conflicts: [{ id: "all", with: "all" }],
      context: [{ id: "ctx", max_instruction_tokens: 3000, max_description_chars: 160 }],
      tools: [{ id: "tool", policy: { shell: false, network: false, filesystem: "read" } }],
    }).suite!;
  const input = (s = KAFKA(), o: Partial<EvaluationScoreInput> = {}): EvaluationScoreInput => ({
    suite: suite(), profiles, candidate: cand(s), approved: [], safety: decided(s), ...o,
  });
  const asRecord = (r: ReturnType<typeof scoreEvaluation>, s: NormalizedSkill) => ({
    schema: 1,
    candidate: { id: s.identity.id, version: s.identity.version, digest: s.package.digest, fingerprint: s.identity.fingerprint, source: "lib", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) },
    suite: r.suite,
    runtime: { foundry: "0.1.0" },
    evaluatedAt: "2026-10-13T10:00:00Z",
    dimensions: r.dimensions,
    findings: r.findings,
    evidence: [],
  });

  it("gives the four offline dimensions with one sample each, and a record that parses", () => {
    const s = KAFKA();
    const r = scoreEvaluation(input(s));
    expect(Object.keys(r.dimensions).sort()).toEqual([...EVALUATION_OFFLINE].sort());
    for (const d of EVALUATION_OFFLINE) expect(r.dimensions[d]).toEqual([1]);
    expect(r.mode).toBe("new");
    expect("record" in parseEvaluationRecord(asRecord(r, s))).toBe(true);
  });
  it("is repeatable and leaves the input alone", () => {
    const s = KAFKA();
    const i = input(s, { approved: [imp(skill([doc("other")], B))] });
    const before = structuredClone({ suite: i.suite, safety: i.safety, approved: i.approved });
    expect(scoreEvaluation(i)).toEqual(scoreEvaluation(i));
    expect({ suite: i.suite, safety: i.safety, approved: i.approved }).toEqual(before);
  });
  it("caps the findings at 500 and marks it", () => {
    const s = KAFKA();
    const scenarios = Array.from({ length: 50 }, (_, i) => ({ id: `t-${String(i).padStart(2, "0")}`, policy: { shell: false, network: false, filesystem: "read" as const } }));
    const many: EvaluationSuite = { ...suite(), tools: scenarios };
    const fs = Array.from({ length: 12 }, (_, i) => finding(i.toString(16).padStart(16, "0"), "high"));
    const r = scoreEvaluation(input(s, { suite: many, safety: decided(s, ...fs) }));
    expect(r.findings).toHaveLength(EVALUATION_LIMITS.findings);
    expect(r.findings.at(-1)).toEqual({ code: "findings-truncated" });
  });
  it("never reads package.files or extraFiles of the candidate", () => {
    const s = KAFKA();
    const trap = (name: string) => new Proxy({}, { get: () => { throw new Error(`${name} was read`); }, ownKeys: () => { throw new Error(`${name} was listed`); } });
    const hostile = { ...s, package: { ...s.package, files: trap("files") }, extraFiles: trap("extraFiles") } as unknown as NormalizedSkill;
    const other = skill([doc("other")], B);
    const hostileOther = { ...other, package: { ...other.package, files: trap("files") }, extraFiles: trap("extraFiles") } as unknown as NormalizedSkill;
    const r = scoreEvaluation({ ...input(s), candidate: cand(hostile), approved: [imp(hostileOther)], safety: decided(s) });
    expect(r.dimensions.selection).toEqual([1]);
  });
});

describe("the shipped example suite", () => {
  it("scores the built-in kafka skill and passes the gate", () => {
    const read = readEvaluationSuite(join(__dirname, "../evals/skill-gate/suite.yaml"));
    if (read.state !== "ok") throw new Error(JSON.stringify(read));
    const dir = join(BUILTIN_SKILLS, "kafka");
    const files = ["REVIEW.md", "SKILL.md", "skill.yaml"].map((p) => ({ path: p, content: new Uint8Array(readFileSync(join(dir, p))) }));
    const pkg = loadSkillPackage(dir);
    const identity = buildSkillIdentity({
      id: pkg.id, source: "scf", repositoryKey: "github.com/example/skills", name: "kafka", version: pkg.version, versionDeclared: true, digest: pkg.digest, files,
    });
    const provenance = {
      schema: 1 as const, source: "scf", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40),
      root: "skills/kafka", name: "kafka", layout: "skill-md" as never, versionDeclared: true, dependencies: [], technologies: [], requiredTools: [],
      entryPoints: { instructions: "SKILL.md" as const, scripts: [], documents: [] }, context: { instructions: 0, text: 0 }, upstream: {},
    };
    const candidate: NormalizedSkill = { package: pkg, provenance, extraFiles: [], identity };
    const safety = applyExceptions("kafka", scanSkill({ root: "kafka", files }), [], "2026-10-13");
    const r = scoreEvaluation({
      suite: read.suite, profiles: read.profiles, safety,
      candidate: cand(candidate, true),
      approved: registry().filter((x) => x.id !== "kafka").map(regd),
    });
    expect(r.findings).toEqual([]);
    for (const d of EVALUATION_OFFLINE) expect(r.dimensions[d]).toEqual([1]);
    expect(r.mode).toBe("new");
    expect(r.suite.digest).toBe(read.digest);

    const record = {
      schema: 1,
      candidate: { id: "kafka", version: pkg.version, digest: pkg.digest, fingerprint: identity.fingerprint, source: "scf", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) },
      suite: r.suite, runtime: { foundry: "0.1.0" }, evaluatedAt: "2026-10-13T10:00:00Z", dimensions: r.dimensions, findings: r.findings, evidence: [],
    };
    const parsed = parseEvaluationRecord(record);
    if (!("record" in parsed)) throw new Error(parsed.problem);
    const result = evaluationGate({ mode: "new", policy: { suite: read.digest }, candidate: { record, digest: pkg.digest, safety, licence: "allowed" } });
    expect(result.verdicts.map((v) => v.reasons.map((x) => x.code))).toEqual([[]]);
  });
});
