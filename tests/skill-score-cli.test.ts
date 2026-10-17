import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { SKILLS_USAGE, skillsCommand } from "../src/skills/cli.js";
import { evaluateOperandsProblem, gateChecks, registryBlockers } from "../src/skills/evaluate-cli.js";
import { parseEvaluationRecord, type EvaluationRecord } from "../src/skills/evaluation.js";
import { evaluationsDir, evaluationStoreSettings, readNewestRecord, writeEvaluationRecord } from "../src/skills/evaluation-store.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport, readStagedImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport, sourceQualifiedId, type NormalizedSkill } from "../src/skills/normalize.js";
import { stringify } from "yaml";
import { breakEffect, writeEffect, type EffectKind } from "./helpers/effect-records.js";
import { clearSkillRegistryCache, discoverSkills, type RegisteredSkill, type SkillRegistry } from "../src/skills/registry.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

vi.mock("../src/skills/import-stage.js", async (orig) => {
  const m = await orig<typeof import("../src/skills/import-stage.js")>();
  return { ...m, readStagedImport: vi.fn(m.readStagedImport) };
});

const COMMIT = "a".repeat(40);
const OLD = "b".repeat(40);
const TODAY = "2026-10-13";
const RETRIEVED = "2026-10-01T10:00:00Z";
const NOW = new Date("2026-10-13T10:00:00Z");
const KEY = "github.com/example/skills";
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const KAFKA_MD = readFileSync("skills/kafka/SKILL.md", "utf8");
const sourcesYaml = (status = "enabled") =>
  [
    "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", `    status: ${status}`, ...(status === "disabled" ? ["    reason: paused"] : []),
    `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community", "    licence: {allow: [MIT]}",
    "    update: {cadence: weekly}", "    owner: '@octocat'", `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
  ].join("\n");

/** A kafka skill under another name: the files of the built-in one, with `capabilities: [kafka]`. */
const kafka = (name: string, over: { version?: string; caps?: string; md?: string } = {}): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: (over.md ?? KAFKA_MD).replace(/^name: kafka$/m, `name: ${name}`),
  [`skills/${name}/skill.yaml`]: `version: ${over.version ?? "2.0.0"}\ncategory: interface\ncapabilities: ${over.caps ?? "[kafka]"}\nroles: [coder, reviewer]\nrisk: high\n`,
});

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillscore-cli-")));
  made.push(d);
  return d;
};
const realLink = evaluationStoreSettings.link;
const savedHome = process.env.FACTORY_HOME;
beforeEach(() => {
  home = fresh();
  // pins and the evaluation store both use the data folder
  process.env.FACTORY_HOME = home;
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml());
  cpSync("evals/skill-gate/fixtures", join(cwd, "fixtures"), { recursive: true });
  cpSync("evals/skill-gate/suite.yaml", join(cwd, "skill-evaluation.yaml"));
});
afterEach(() => {
  evaluationStoreSettings.link = realLink;
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  for (const d of made.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
  clearSkillRegistryCache();
});

function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
/** Stages with licence evidence (a root LICENSE), unless `licence` is false. */
function stage(files: Record<string, string>, licence = true) {
  const all = licence ? { LICENSE: MIT, ...files } : files;
  const t = tree(all);
  const prep = prepareImport(source(), t);
  if (!licence) return publishImport(prep, { home });
  const ev = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
  return publishImport(addLicenceEvidence(prep, ev, RETRIEVED), { home });
}
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);
const SKILLS = ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
const registryOptions = (extra: Record<string, unknown> = {}) => ({ skills: SKILLS, builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin, ...extra });
let emptyBuiltin: string;
async function run(sub: "score" | "gate", operands: string[] = ["lib"], over: { now?: Date; values?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  emptyBuiltin ??= fresh();
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: [sub, ...operands], values: over.values ?? {} }, (l) => void lines.push(l), {
    cwd, home, today: TODAY, now: over.now ?? NOW, ...registryOptions(over.extra),
  });
  return { code, lines, text: lines.join("\n") };
}
const score = (over = {}) => run("score", ["lib"], over);
const DECIDED = { owner: "@octocat", reviewed: "2026-10-01", note: "not measured yet" };
/** Writes skill-evaluations.yaml with one decision of the given kind for every skill of the staged import (effect records are not needed). */
function decide(accept: "not-measured" | "no-effect" = "not-measured", only?: string[]): void {
  const staged = readStagedImport("lib", COMMIT, { home });
  if (staged.state !== "ok") return;
  const skills = normalizeImport({ record: { ...staged.record, rejected: [] }, files: staged.files }).skills;
  const decisions = skills.filter((s) => !only || only.includes(s.package.id)).map((s) => ({ skill: s.package.id, digest: s.package.digest, accept, ...DECIDED }));
  writeFileSync(join(cwd, "skill-evaluations.yaml"), stringify({ schema: 1, evaluations: [], effect_decisions: decisions }));
}
// Every skill needs an effect verdict or an owner decision, so these gates start with "not measured" decisions.
const gate = (over = {}) => {
  decide();
  return run("gate", ["lib"], over);
};
const snapshot = (dir: string, skip = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (p === skip) return [];
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode}`, ...snapshot(p, skip)] : [`${p} ${st.mode} ${readFileSync(p).toString("hex")}`];
  });
const newest = (id: string) => {
  const r = readNewestRecord("lib", COMMIT, id, { home });
  if (r.state !== "ok") throw new Error("no record");
  return r;
};
/** A valid record taken from the newest of `id`, with other facts. */
function recordFrom(id: string, over: { id?: string; version?: string; digest?: string; commit?: string; source?: string; scores?: Partial<Record<"selection" | "conflicts" | "context" | "tools", number>>; digestOnly?: boolean }): EvaluationRecord {
  const raw = structuredClone(newest(id).raw) as EvaluationRecord;
  if (over.id) raw.candidate.id = over.id;
  if (over.version) raw.candidate.version = over.version;
  if (over.digest) raw.candidate.digest = over.digest;
  if (over.commit) raw.candidate.commit = over.commit;
  if (over.source) raw.candidate.source = over.source;
  for (const [d, v] of Object.entries(over.scores ?? {})) raw.dimensions[d as "selection"] = [v!];
  const parsed = parseEvaluationRecord(raw);
  if (!("record" in parsed)) throw new Error(parsed.problem);
  return parsed.record;
}
const recordDir = () => evaluationsDir("lib", COMMIT, home);
const recordFiles = (id: string) => readdirSync(recordDir()).filter((n) => n.startsWith(`${id}--`));

/** An administrator skill: the built-in kafka folder under another id. */
function adminSkill(id: string, version: string, caps = "[kafka]") {
  const dir = join(home, "skills", id);
  cpSync("skills/kafka", dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), KAFKA_MD.replace(/^name: kafka$/m, `name: ${id}`));
  writeFileSync(join(dir, "skill.yaml"), `id: ${id}\nversion: ${version}\ncategory: interface\ncapabilities: ${caps}\nroles: [coder, reviewer]\nrisk: high\n`);
  return dir;
}
const registry = (): SkillRegistry => discoverSkills(SKILLS, { home, builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin });
async function pin(id: string, version: string) {
  const s = registry().byKey.get(`${id}@${version}`);
  if (!s) throw new Error("not found");
  await skillsCommand({ positionals: ["pin", `${id}@${version}`, s.digest], values: {} }, () => {}, { home, builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin, skills: SKILLS });
  return s;
}

describe("syntax", () => {
  it("is checked before anything is read", async () => {
    const calls = vi.mocked(readStagedImport).mock.calls.length;
    for (const sub of ["score", "gate"] as const) {
      for (const operands of [[], ["a", "b", "c"], ["Bad_Id"]]) {
        await expect(run(sub, operands)).rejects.toThrow(`scf skills ${sub}`);
        await expect(run(sub, operands)).rejects.toThrow("usage: scf skills");
      }
      await expect(run(sub, ["lib"], { values: { repo: "x" } })).rejects.toThrow("unexpected option --repo");
      expect(SKILLS_USAGE).toContain(`scf skills ${sub} <source-id> [<suite-file>]`);
    }
    expect(vi.mocked(readStagedImport).mock.calls.length).toBe(calls);
    expect(evaluateOperandsProblem("score", ["lib"])).toBeUndefined();
    expect(evaluateOperandsProblem("gate", ["lib", "s.yaml"])).toBeUndefined();
  });
});

describe("the suite", () => {
  it("a missing suite is a PROBLEM and nothing is written", async () => {
    stage(kafka("kafka"));
    rmSync(join(cwd, "skill-evaluation.yaml"));
    for (const sub of ["score", "gate"] as const) {
      const r = await run(sub);
      expect(r.code).toBe(1);
      expect(r.lines).toEqual(["PROBLEM the evaluation suite file does not exist"]);
    }
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
    const named = await run("score", ["lib", "nope.yaml"]);
    expect(named.lines).toEqual(["PROBLEM the evaluation suite file does not exist"]);
  });

  it("an invalid suite prints PROBLEM lines", async () => {
    stage(kafka("kafka"));
    writeFileSync(join(cwd, "skill-evaluation.yaml"), "schema: 2\n");
    const r = await score();
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => l.startsWith("PROBLEM "))).toBe(true);
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
  });
});

describe("scf skills score", () => {
  it("writes one record per skill, outside the quarantine, and the import stays valid", async () => {
    stage({ ...kafka("a"), ...kafka("b") });
    const r = await score();
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("SCORED "))).toHaveLength(2);
    expect(r.lines.at(-1)).toMatch(/^EVALUATED 2 skills from github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64} with suite sha256:[0-9a-f]{64}: 2 records written to skill-evaluations\/lib\/aaaaaaaaaaaa$/);
    for (const name of ["a", "b"]) {
      const id = idOf(name);
      const files = recordFiles(id);
      expect(files).toEqual([`${id}--0000000001.json`]);
      expect(statSync(join(recordDir(), files[0]!)).mode & 0o777).toBe(0o600);
      const parsed = parseEvaluationRecord(JSON.parse(readFileSync(join(recordDir(), files[0]!), "utf8")));
      expect("record" in parsed).toBe(true);
      const rec = (parsed as { record: EvaluationRecord }).record;
      expect(rec.candidate).toMatchObject({ id, source: "lib", commit: COMMIT, repositoryKey: KEY });
    }
    expect(statSync(join(home, "skill-evaluations")).mode & 0o777).toBe(0o700);
    expect(statSync(recordDir()).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(home, "skill-quarantine", "lib", COMMIT)).sort()).toEqual(["files", "import.json", "licence", "licence.json"]);
    expect(readStagedImport("lib", COMMIT, { home }).state).toBe("ok");
  });

  it("a kafka skill scores 1 on every dimension", async () => {
    stage(kafka("kafka"));
    const r = await score();
    expect(r.lines.some((l) => l.startsWith("SCORED ") && l.endsWith("selection=1.00 conflicts=1.00 context=1.00 tools=1.00"))).toBe(true);
  });

  it("a second run adds a record and keeps the first", async () => {
    stage(kafka("kafka"));
    await score();
    const first = readFileSync(join(recordDir(), `${idOf("kafka")}--0000000001.json`), "utf8");
    await score({ now: new Date("2026-10-14T10:00:00Z") });
    expect(recordFiles(idOf("kafka"))).toEqual([`${idOf("kafka")}--0000000001.json`, `${idOf("kafka")}--0000000002.json`]);
    expect(readFileSync(join(recordDir(), `${idOf("kafka")}--0000000001.json`), "utf8")).toBe(first);
  });

  it("a root that is not normalized is a PROBLEM in both commands", async () => {
    stage({ ...kafka("a"), "skills/a2/SKILL.md": KAFKA_MD.replace(/^name: kafka$/m, "name: a") });
    for (const sub of ["score", "gate"] as const) {
      const r = await run(sub);
      expect(r.code).toBe(1);
      expect(r.lines.some((l) => l.startsWith("PROBLEM ") && l.includes("not normalized"))).toBe(true);
    }
  });
});

describe("scf skills gate, mode new", () => {
  it("passes after score, and writes nothing", async () => {
    stage(kafka("kafka"));
    await score();
    const before = snapshot(home);
    const r = await gate();
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(new RegExp(`^PASSED ${idOf("kafka")}@2\\.0\\.0 new$`));
    expect(r.lines.at(-1)).toMatch(/^GATED 1 skill from .*: 1 passed, 0 failed$/);
    expect(snapshot(home)).toEqual(before);
  });

  it("judges the newest record: the highest number wins, also within one second", async () => {
    stage(kafka("kafka"));
    await score();
    const id = idOf("kafka");
    const good = recordFrom(id, {});
    writeEvaluationRecord(recordFrom(id, { scores: { selection: 0.5 } }), { home });
    expect(recordFiles(id)).toHaveLength(2);
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.text).toContain("below-threshold:selection");
    writeEvaluationRecord(good, { home }); // the same time as the first, published last
    expect((await gate()).code).toBe(0);
  });

  it("FAILED, never passed: no record", async () => {
    stage(kafka("kafka"));
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain(`FAILED ${idOf("kafka")}@2.0.0 new: record-invalid`);
    expect(r.lines[0]).toContain('run "scf skills score lib"');
  });

  it("FAILED: wrong file mode, a link, or another digest", async () => {
    stage(kafka("kafka"));
    await score();
    const id = idOf("kafka");
    const file = join(recordDir(), `${id}--0000000001.json`);
    chmodSync(file, 0o644);
    expect((await gate()).lines[0]).toContain("FAILED");
    expect((await gate()).text).toContain("record-invalid");
    chmodSync(file, 0o600);
    expect((await gate()).code).toBe(0);
    writeEvaluationRecord(recordFrom(id, { digest: "sha256:" + "1".repeat(64) }), { home });
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.text).toContain("digest-mismatch");
    rmSync(join(recordDir(), `${id}--0000000002.json`));
    rmSync(file);
    symlinkSync(join(recordDir(), "other"), file);
    expect((await gate()).text).toContain("record-invalid");
  });

  it("FAILED: the suite changed after scoring", async () => {
    stage(kafka("kafka"));
    await score();
    writeFileSync(join(cwd, "skill-evaluation.yaml"), readFileSync(join(cwd, "skill-evaluation.yaml"), "utf8").replace("Refactor the pricing service.", "Refactor the pricing code."));
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.text).toContain("suite-mismatch");
  });

  it("FAILED: a high finding blocks, and a missing licence does not pass", async () => {
    stage({ ...kafka("kafka"), "skills/kafka/scripts/x.sh": "rm -rf /" });
    await score();
    expect((await gate()).text).toContain("safety-blocked");
    rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
    rmSync(join(home, "skill-evaluations"), { recursive: true, force: true });
    stage(kafka("kafka"), false);
    await score();
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.text).toContain("licence-not-allowed:missing");
  });

  it("a disabled source is a PROBLEM", async () => {
    stage(kafka("kafka"));
    await score();
    writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml("disabled"));
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^PROBLEM the source lib is disabled/);
  });
});

describe("catalogue description override", () => {
  const LONG = "Kafka producers, consumers and streams. ".repeat(8).trim();
  const SHORT = "Kafka work: keys, order, retries and schemas.";
  const longKafka = () => kafka("kafka", { md: KAFKA_MD.replace(/^description:.*$/m, `description: "${LONG}"`) });
  /** The selections entry of the staged kafka skill; `description` undefined: no override. */
  function selectFor(description: string | undefined, over: Record<string, unknown> = {}): void {
    const staged = readStagedImport("lib", COMMIT, { home });
    if (staged.state !== "ok") throw new Error("not staged");
    const s = normalizeImport({ record: { ...staged.record, rejected: [] }, files: staged.files }).skills.find((x) => x.provenance.name === "kafka")!;
    const entry = {
      source: "lib", skill: "kafka", digest: s.package.digest, scope: "portable", category: "interface", capabilities: ["kafka"], owner: "@octocat", reviewed: "2026-10-01",
      ...(description !== undefined ? { catalogue_description: description } : {}), ...over,
    };
    writeFileSync(join(cwd, "skill-selections.yaml"), stringify({ schema: 1, selections: [entry] }));
  }
  const check = async () => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["selections", "check"], values: {} }, (l) => void lines.push(l), { cwd, home, today: TODAY, now: NOW, ...registryOptions() });
    return { code, text: lines.join("\n") };
  };

  it("a long description fails the gate on context, as before", async () => {
    stage(longKafka());
    const s = await score();
    expect(s.text).toContain("description-over-limit");
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.text).toContain("below-threshold:context");
  });

  it("judges the context on the override: score, then gate passes, and the record names the scored text", async () => {
    stage(longKafka());
    selectFor(SHORT);
    const s = await score();
    expect(s.text).not.toContain("description-over-limit");
    expect(s.text).not.toContain("description-cut");
    const id = idOf("kafka");
    const ev = (newest(id).raw as EvaluationRecord).evidence.find((e) => e.name === "catalogue-description");
    expect(ev?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const r = await gate();
    expect(r.text).toContain(`PASSED ${id}@2.0.0 new`);
    expect(r.code).toBe(0);
  });

  it("a short package description with no override stores no description evidence", async () => {
    stage(kafka("kafka"));
    await score();
    expect((newest(idOf("kafka")).raw as EvaluationRecord).evidence.some((e) => e.name === "catalogue-description")).toBe(false);
  });

  it("fails with description-changed when the override is not the one that was scored", async () => {
    stage(longKafka());
    selectFor(SHORT);
    await score();
    selectFor("Another short text for kafka.");
    const changed = await gate();
    expect(changed.code).toBe(1);
    expect(changed.text).toContain("description-changed");
    expect(changed.text).toContain('run "scf skills score lib"');
    selectFor(undefined);
    expect((await gate()).text).toContain("description-changed");
    selectFor(SHORT);
    expect((await gate()).code).toBe(0);
  });

  it("fails with description-changed when an override is added after scoring", async () => {
    stage(kafka("kafka"));
    await score();
    selectFor(SHORT);
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.text).toContain("description-changed");
  });

  it("prepareEvaluation uses the selections it is given and not the file", async () => {
    const { prepareEvaluation } = await import("../src/skills/evaluate-cli.js");
    stage(longKafka());
    selectFor("From the file.");
    const base = { cwd, home, today: TODAY, now: NOW, skills: SKILLS, discover: registryOptions() as never };
    const lines: string[] = [];
    const fromFile = prepareEvaluation("lib", undefined, (l) => void lines.push(l), base, "t");
    expect(fromFile?.items[0]?.description).toBe("From the file.");
    const given = prepareEvaluation("lib", undefined, (l) => void lines.push(l), { ...base, selections: [] }, "t");
    expect(given?.items[0]?.description).toBeUndefined();
    const digest = fromFile!.items[0]!.skill.package.digest;
    const snap = [{ source: "lib", skill: "kafka", digest, catalogueDescription: "From the snapshot." }] as never;
    expect(prepareEvaluation("lib", undefined, (l) => void lines.push(l), { ...base, selections: snap }, "t")?.items[0]?.description).toBe("From the snapshot.");
  });

  it("an invalid selections file is a PROBLEM for score", async () => {
    stage(kafka("kafka"));
    writeFileSync(join(cwd, "skill-selections.yaml"), "schema: 2\n");
    const r = await score();
    expect(r.code).toBe(1);
    expect(r.text).toContain("PROBLEM skill-selections.yaml");
  });

  it("selections check accepts an override of a staged skill", async () => {
    stage(longKafka());
    selectFor(SHORT);
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.text).toContain(`description=${SHORT.length} chars`);
    expect(r.text).toContain("OK 1 selections");
  });

  it("selections check without an override needs no staged import", async () => {
    stage(kafka("kafka"));
    selectFor(undefined, { digest: "sha256:" + "f".repeat(64) });
    rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
    rmSync(join(cwd, "skill-sources.yaml"));
    expect((await check()).code).toBe(0);
  });

  it("selections check: PROBLEM for another digest, a disabled source and a source that is not there", async () => {
    stage(longKafka());
    selectFor(SHORT, { digest: "sha256:" + "f".repeat(64) });
    const other = await check();
    expect(other.code).toBe(1);
    expect(other.text).toContain("PROBLEM selections[0] (lib/kafka) catalogue_description: no staged skill kafka with this digest");
    selectFor(SHORT);
    writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml("disabled"));
    const disabled = await check();
    expect(disabled.code).toBe(1);
    expect(disabled.text).toContain("PROBLEM selections[0] (lib/kafka) catalogue_description: the source lib is disabled");
    rmSync(join(cwd, "skill-sources.yaml"));
    expect((await check()).text).toContain("cannot be checked");
  });

  it("selections check refuses an override over 160 characters", async () => {
    stage(longKafka());
    selectFor("d".repeat(161));
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.text).toContain("catalogue_description: must be at most 160 characters");
  });
});

describe("scf skills gate, mode duplicate", () => {
  it("names the mode, and the worse one fails", async () => {
    const long = KAFKA_MD.replace(/^description: ".*"$/m, `description: "${"Kafka producers and consumers. ".repeat(10)}"`);
    stage({ ...kafka("a"), ...kafka("b", { md: long }) });
    await score();
    const r = await gate();
    expect(r.code).toBe(1);
    const a = r.lines.find((l) => l.includes(idOf("a")) && /^(PASSED|FAILED)/.test(l))!;
    const b = r.lines.find((l) => l.includes(idOf("b")) && /^(PASSED|FAILED)/.test(l))!;
    expect(a).toMatch(/duplicate/);
    expect(b).toMatch(/duplicate/);
    expect(b.startsWith("FAILED")).toBe(true);
    expect(a.startsWith("PASSED")).toBe(true);
  });

  it("two equal-quality candidates are not both promoted silently: the gate prints a line for each", async () => {
    stage({ ...kafka("a"), ...kafka("b") });
    await score();
    const r = await gate();
    expect(r.lines.filter((l) => /^(PASSED|FAILED) /.test(l))).toHaveLength(2);
    expect(r.lines.filter((l) => /duplicate/.test(l))).toHaveLength(2);
  });
});

describe("scf skills gate, mode upgrade", () => {
  it("same id: FAILED without a baseline record, PASSED with one", async () => {
    const id = idOf("kafka");
    adminSkill(id, "1.0.0");
    const admin = await pin(id, "1.0.0");
    stage(kafka("kafka"));
    await score();
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain(`FAILED ${id}@2.0.0 upgrade: baseline-missing`);
    writeEvaluationRecord(recordFrom(id, { version: "1.0.0", digest: admin.digest, commit: OLD, scores: {} }), { home });
    const p = await gate();
    expect(p.code).toBe(0);
    expect(p.lines[0]).toBe(`PASSED ${id}@2.0.0 upgrade`);
  });

  it("a suite with mandatory instructions: FAILED without results, PASSED with a paired baseline and no stored record", async () => {
    const id = idOf("kafka");
    adminSkill(id, "1.0.0");
    const admin = await pin(id, "1.0.0");
    appendFileSync(
      join(cwd, "skill-evaluation.yaml"),
      [
        "instructions:", "  mandatory: true", "  scenarios:",
        "    - { id: ag-1, repo: fixtures/rest-service, task: Fix it, check: npm test, policy: { shell: true, network: false, filesystem: write } }", "",
      ].join("\n"),
    );
    stage(kafka("kafka"));
    expect((await score()).code).toBe(0);
    const failed = await gate();
    expect(failed.code).toBe(1);
    expect(failed.lines[0]).toContain("dimension-missing:instructions");
    const raw = structuredClone(newest(id).raw) as EvaluationRecord;
    const instructions = [1, 1, 1];
    const offline = { ...raw.dimensions };
    raw.runtime = { ...raw.runtime, agent: "claude", model: "m-1" };
    raw.dimensions = { ...offline, instructions };
    const run = (arm: "candidate" | "baseline", digest: string, p: string) => (score: number, i: number) => ({ scenario: "ag-1", arm, skill: id, digest, attempt: i + 1, runId: `${p}-${i}`, score });
    raw.agent = {
      sandbox: "container",
      network: "host-limited",
      outbound: [],
      repeat: 3,
      runs: [...instructions.map(run("candidate", raw.candidate.digest, "c")), ...instructions.map(run("baseline", admin.digest, "b"))],
      baselines: [{ id, version: "1.0.0", digest: admin.digest, dimensions: { ...offline, instructions } }],
    };
    const parsed = parseEvaluationRecord(raw);
    if (!("record" in parsed)) throw new Error(parsed.problem);
    writeEvaluationRecord(parsed.record, { home });
    const passed = await gate();
    expect(passed.lines[0]).toBe(`PASSED ${id}@2.0.0 upgrade`);
    expect(passed.code).toBe(0);
  });

  it("capability only: compared with the record of the approved skill of another id", async () => {
    adminSkill("admin-kafka", "1.0.0");
    const admin = await pin("admin-kafka", "1.0.0");
    stage(kafka("kafka"));
    await score();
    const id = idOf("kafka");
    expect((await gate()).lines[0]).toContain("upgrade: baseline-missing");
    const baseline = recordFrom(id, { id: "admin-kafka", version: "1.0.0", digest: admin.digest, source: "adm", commit: OLD, scores: { selection: 0.8 } });
    const other = evaluationsDir("adm", OLD, home);
    writeEvaluationRecord(baseline, { home });
    expect(existsSync(other)).toBe(true);
    const r = await gate();
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`PASSED ${id}@2.0.0 upgrade`);
  });

  it("two capabilities: every baseline must have a record", async () => {
    adminSkill("admin-kafka", "1.0.0", "[kafka]");
    adminSkill("admin-rabbit", "1.0.0", "[rabbit]");
    const k = await pin("admin-kafka", "1.0.0");
    const q = await pin("admin-rabbit", "1.0.0");
    stage(kafka("kafka", { caps: "[kafka, rabbit]" }));
    await score();
    const id = idOf("kafka");
    writeEvaluationRecord(recordFrom(id, { id: "admin-kafka", version: "1.0.0", digest: k.digest, source: "adm", commit: OLD }), { home });
    const half = await gate();
    expect(half.code).toBe(1);
    expect(half.lines[0]).toContain(`FAILED ${id}@2.0.0 upgrade: baseline-missing`);
    writeEvaluationRecord(recordFrom(id, { id: "admin-rabbit", version: "1.0.0", digest: q.digest, source: "adm", commit: OLD }), { home });
    const both = await gate();
    expect(both.lines[0]).toBe(`PASSED ${id}@2.0.0 upgrade`);
  });

  it("capability only: a record of a third skill under the approved skill's name never passes", async () => {
    adminSkill("admin-kafka", "1.0.0");
    const admin = await pin("admin-kafka", "1.0.0");
    stage(kafka("kafka"));
    await score();
    const id = idOf("kafka");
    const third = recordFrom(id, { id: "third-skill", version: "1.0.0", digest: admin.digest, source: "adm", commit: OLD });
    writeEvaluationRecord(third, { home });
    const dir = evaluationsDir("adm", OLD, home);
    const written = readdirSync(dir).find((n) => n.startsWith("third-skill--"))!;
    linkSync(join(dir, written), join(dir, "admin-kafka--0000000001.json"));
    const r = await gate();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^FAILED .*upgrade: /);
  });
});

describe("registry problems", () => {
  it("an unreadable admin skill root is a PROBLEM; score writes nothing and gate passes nothing", async () => {
    stage(kafka("kafka"));
    mkdirSync(join(home, "skills"), { mode: 0o700 });
    chmodSync(join(home, "skills"), 0o000);
    const s = await score();
    const g = await gate();
    chmodSync(join(home, "skills"), 0o700);
    expect(s.code).toBe(1);
    expect(g.code).toBe(1);
    expect(s.lines.every((l) => l.startsWith("PROBLEM "))).toBe(true);
    expect(g.text).not.toContain("PASSED");
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
  });

  it("a corrupt skill lock is a PROBLEM", async () => {
    stage(kafka("kafka"));
    writeFileSync(join(home, "skills.lock.json"), "{not json");
    const r = await score();
    expect(r.code).toBe(1);
    expect(r.text).toContain("PROBLEM");
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
  });

  it("an approved skill that shares a capability must be pinned and unchanged", async () => {
    stage(kafka("kafka"));
    const dir = adminSkill("admin-kafka", "1.0.0");
    const unpinned = await score();
    expect(unpinned.code).toBe(1);
    expect(unpinned.text).toContain(`PROBLEM ${idOf("kafka")}: approved skill admin-kafka@1.0.0 cannot be verified (unpinned); no record`);
    await pin("admin-kafka", "1.0.0");
    writeFileSync(join(dir, "REVIEW.md"), "changed after the pin\n");
    const g = await gate();
    expect(g.code).toBe(1);
    expect(g.text).toContain("cannot be verified (mismatch); it cannot be promoted");
    expect(g.text).not.toContain("PASSED");
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
  });

  it("registryBlockers keeps the problems that hide approved skills", () => {
    const p = (kind: string, source = "admin") => ({ kind, source, label: "x", root: "x", reason: "bad" });
    const reg = { problems: [p("too-many"), p("root-missing"), p("duplicate"), p("integrity"), p("lock"), p("root-unreadable", "repository"), p("invalid-package")] } as unknown as SkillRegistry;
    expect(registryBlockers(reg)).toHaveLength(3);
  });
});

describe("a failed or interrupted score changes nothing but skill-evaluations", () => {
  it("is byte for byte the same outside the evaluation folder", async () => {
    stage({ ...kafka("a"), ...kafka("b") });
    adminSkill("admin-other", "1.0.0", "[other-thing]");
    await pin("admin-other", "1.0.0");
    const skip = join(home, "skill-evaluations");
    const before = [...snapshot(home, skip), ...snapshot(cwd)];
    let n = 0;
    evaluationStoreSettings.link = (from, to) => {
      if (++n === 2) throw Object.assign(new Error("disk"), { code: "EIO" });
      linkSync(from, to);
    };
    const store = await score();
    expect(store.code).toBe(1);
    expect(store.text).toContain("PROBLEM the evaluation folder cannot be written (EIO); records written before it are kept");
    expect(readdirSync(recordDir()).filter((x) => x.startsWith(".tmp-"))).toEqual([]);
    expect(readdirSync(recordDir()).filter((x) => x.endsWith(".json"))).toHaveLength(1);
    expect([...snapshot(home, skip), ...snapshot(cwd)]).toEqual(before);

    evaluationStoreSettings.link = () => {
      throw new Error("interrupted");
    };
    const hit = await score().then(
      (r) => r,
      (e: Error) => ({ code: 1, lines: [e.message], text: e.message }),
    );
    expect(hit.code).toBe(1);
    expect(readdirSync(recordDir()).filter((x) => x.startsWith(".tmp-"))).toEqual([]);
    expect([...snapshot(home, skip), ...snapshot(cwd)]).toEqual(before);

    evaluationStoreSettings.link = realLink;
    expect((await score()).code).toBe(0);
    expect([...snapshot(home, skip), ...snapshot(cwd)]).toEqual(before);
  });
});

describe("gateChecks", () => {
  const skill = (id: string, caps: string[], version = "1.0.0", digest = "sha256:" + "1".repeat(64)) =>
    ({ package: { id, version, digest, capabilities: caps } }) as unknown as NormalizedSkill;
  const reg = (id: string, caps: string[], o: Partial<RegisteredSkill> = {}, version = "1.0.0", digest = "sha256:" + "2".repeat(64)): RegisteredSkill =>
    ({ key: `${id}@${version}`, id, version, source: "admin", label: "x", dir: "", active: true, trust: "approved", pin: "pinned", digest, pkg: { id, version, digest, capabilities: caps, category: "interface", risk: "low" }, ...o }) as unknown as RegisteredSkill;

  it("new: no overlap", () => {
    const c = skill("c", ["kafka"]);
    expect(gateChecks(c, [c], [reg("other", ["java"])])).toMatchObject({ upgrade: false, rivals: [], unverified: [] });
  });
  it("the same id with another digest: that skill is the baseline", () => {
    const c = skill("c", ["kafka"], "2.0.0");
    const r = gateChecks(c, [c], [reg("c", ["java"])]);
    expect(r.upgrade).toBe(true);
    expect(r.baseline?.id).toBe("c");
  });
  it("the same artifact is not an upgrade", () => {
    const c = skill("c", ["kafka"]);
    expect(gateChecks(c, [c], [reg("c", ["kafka"], {}, "1.0.0", c.package.digest)]).upgrade).toBe(false);
  });
  it("shared capability: the canonical winner is the baseline; unapproved and inactive skills are ignored", () => {
    const c = skill("c", ["kafka"]);
    const a = reg("a", ["kafka"], {}, "1.0.0", "sha256:" + "3".repeat(64));
    const z = reg("z", ["kafka"], { trust: "unapproved" });
    const y = reg("y", ["kafka"], { active: false });
    const r = gateChecks(c, [c], [z, y, a]);
    expect(r.baseline?.id).toBe("a");
    expect(gateChecks(c, [c], [z, y]).upgrade).toBe(false);
  });
  it("every shared capability gets its own baseline; a capability without a winner is unresolved", () => {
    const c = skill("c", ["kafka", "rabbit"]);
    const a = reg("a", ["kafka"], {}, "1.0.0", "sha256:" + "3".repeat(64));
    const b = reg("b", ["rabbit"], {}, "1.0.0", "sha256:" + "4".repeat(64));
    const r = gateChecks(c, [c], [a, b]);
    expect(r.baselines.map((s) => s.id)).toEqual(["a", "b"]);
    expect(r.unresolved).toBe(false);
    expect(gateChecks(skill("c", ["kafka", "none-yet"]), [c], [a]).unresolved).toBe(false);
  });
  it("a relevant skill that is not pinned is unverified, an unrelated one is not", () => {
    const c = skill("c", ["kafka"]);
    const r = gateChecks(c, [c], [reg("a", ["kafka"], { pin: "mismatch" }), reg("b", ["java"], { pin: "unpinned" })]);
    expect(r.unverified.map((s) => s.id)).toEqual(["a"]);
  });
  it("rivals share a capability, never the candidate itself, and are sorted by id", () => {
    const c = skill("c", ["kafka"]);
    const peers = [skill("z", ["kafka"]), c, skill("m", ["x"]), skill("b", ["kafka", "x"])];
    expect(gateChecks(c, peers, []).rivals.map((s) => s.package.id)).toEqual(["b", "z"]);
  });
});

describe("scf skills gate, effect", () => {
  const kid = () => idOf("kafka");
  /** The staged kafka skill as the effect store knows it. */
  function kafkaSkill() {
    const staged = readStagedImport("lib", COMMIT, { home });
    if (staged.state !== "ok") throw new Error("not staged");
    const s = normalizeImport({ record: { ...staged.record, rejected: [] }, files: staged.files }).skills.find((x) => x.package.id === kid())!;
    return { id: s.package.id, version: s.package.version, digest: s.package.digest };
  }
  const setup = async () => {
    stage(kafka("kafka"));
    await score();
    return kafkaSkill();
  };
  const gateNow = () => run("gate", ["lib"]);
  const decision = (skill: { id: string; digest: string }, accept: string) => ({ skill: skill.id, digest: skill.digest, accept, ...DECIDED });
  const writeDecisions = (list: object[]) => writeFileSync(join(cwd, "skill-evaluations.yaml"), stringify({ schema: 1, evaluations: [], effect_decisions: list }));

  it("harms is blocked, even with both decisions", async () => {
    const s = await setup();
    writeEffect(home, s, "harms" satisfies EffectKind);
    writeDecisions([decision(s, "no-effect"), decision(s, "not-measured")]);
    const r = await gateNow();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe(`FAILED ${kid()}@2.0.0 new: effect-harms`);
    expect(r.text).not.toContain("DECISION");
    expect(r.lines.at(-1)).toMatch(/: 0 passed, 1 failed$/);
  });

  it("no measurable effect is blocked without a decision and passes with one", async () => {
    const s = await setup();
    writeEffect(home, s, "no-effect");
    const blocked = await gateNow();
    expect(blocked.code).toBe(1);
    expect(blocked.lines[0]).toBe(`FAILED ${kid()}@2.0.0 new: effect-no-effect`);
    writeDecisions([decision(s, "not-measured")]);
    expect((await gateNow()).lines[0]).toContain("effect-no-effect");
    writeDecisions([decision(s, "no-effect")]);
    const r = await gateNow();
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual([`PASSED ${kid()}@2.0.0 new`, `DECISION ${kid()}@2.0.0 effect no-effect accepted by @octocat on 2026-10-01`]);
  });

  it("a decision of another digest does not count", async () => {
    const s = await setup();
    writeEffect(home, s, "no-effect");
    writeDecisions([{ ...decision(s, "no-effect"), digest: "sha256:" + "0".repeat(64) }]);
    expect((await gateNow()).lines[0]).toContain("effect-no-effect");
  });

  it("not measured is blocked without a decision, with a note, and passes with one", async () => {
    const s = await setup();
    const blocked = await gateNow();
    expect(blocked.code).toBe(1);
    expect(blocked.lines[0]).toBe(`FAILED ${kid()}@2.0.0 new: effect-not-measured (no effect record; run "scf skills effect lib ${kid()}")`);
    writeDecisions([decision(s, "no-effect")]);
    expect((await gateNow()).lines[0]).toContain("effect-not-measured");
    writeDecisions([decision(s, "not-measured")]);
    const r = await gateNow();
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual([`PASSED ${kid()}@2.0.0 new`, `DECISION ${kid()}@2.0.0 effect not-measured accepted by @octocat on 2026-10-01`]);
  });

  it("helps passes and prints no decision", async () => {
    const s = await setup();
    writeEffect(home, s, "helps");
    const r = await gateNow();
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`PASSED ${kid()}@2.0.0 new`);
    expect(r.text).not.toContain("DECISION");
  });

  it("a newer record replaces an older one", async () => {
    const s = await setup();
    writeEffect(home, s, "helps");
    expect((await gateNow()).code).toBe(0);
    writeEffect(home, s, "harms");
    expect((await gateNow()).lines[0]).toContain("effect-harms");
  });

  it("an unreadable record fails with effect-invalid, even with decisions", async () => {
    const s = await setup();
    writeEffect(home, s, "helps");
    breakEffect(home, s.id, s.digest);
    writeDecisions([decision(s, "no-effect"), decision(s, "not-measured")]);
    const r = await gateNow();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(new RegExp(`^FAILED ${kid()}@2\\.0\\.0 new: effect-invalid \\(effect: `));
  });

  it("lists the effect code after the evaluation codes", async () => {
    stage(kafka("kafka"));
    const r = await gateNow();
    expect(r.lines[0]).toMatch(/^FAILED \S+ new: record-invalid, effect-not-measured/);
  });

  it("an invalid skill-evaluations.yaml is a PROBLEM and nothing is judged", async () => {
    await setup();
    writeFileSync(join(cwd, "skill-evaluations.yaml"), stringify({ schema: 1, evaluations: [], effect_decisions: [{ skill: "x", accept: "maybe" }] }));
    const r = await gateNow();
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => l.startsWith("PROBLEM skill-evaluations.yaml "))).toBe(true);
    expect(r.text).not.toMatch(/PASSED|FAILED/);
  });

  it("writes nothing", async () => {
    const s = await setup();
    writeDecisions([decision(s, "not-measured")]);
    const before = snapshot(home);
    await gateNow();
    expect(snapshot(home)).toEqual(before);
  });
});
