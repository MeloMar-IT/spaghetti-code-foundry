import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { SKILLS_USAGE, skillsCommand } from "../src/skills/cli.js";
import { parseEvaluationRecord, type EvaluationRecord } from "../src/skills/evaluation.js";
import { evaluationsDir, readNewestRecord, writeEvaluationRecord } from "../src/skills/evaluation-store.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import type { GitRun } from "../src/skills/project-pins.js";
import { parseReleaseTarget, releaseOperandsProblem } from "../src/skills/release-cli.js";
import { committedState, gitBlobId, NO_EVALUATION_RECORD, releasePublish } from "../src/skills/release-publish.js";
import { releaseStoreSettings } from "../src/skills/release-store.js";
import { clearSkillRegistryCache } from "../src/skills/registry.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const HEAD = "c".repeat(40);
const TODAY = "2026-10-13";
const RETRIEVED = "2026-10-01T10:00:00Z";
const NOW = new Date("2026-10-13T10:00:00Z");
const KEY = "github.com/example/skills";
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const GPL = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";
const KAFKA_MD = readFileSync("skills/kafka/SKILL.md", "utf8");
const sourcesYaml = (over: { status?: string; allow?: string } = {}) =>
  [
    "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", `    status: ${over.status ?? "enabled"}`, ...(over.status === "disabled" ? ["    reason: paused"] : []),
    `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community", `    licence: {allow: [${over.allow ?? "MIT"}]}`,
    "    update: {cadence: weekly}", "    owner: '@octocat'", `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
  ].join("\n");

const kafka = (name: string, over: { version?: string } = {}): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: KAFKA_MD.replace(/^name: kafka$/m, `name: ${name}`),
  [`skills/${name}/skill.yaml`]: `version: ${over.version ?? "2.0.0"}\ncategory: interface\ncapabilities: [kafka]\nroles: [coder, reviewer]\nrisk: high\n`,
});
const other = (name: string): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: KAFKA_MD.replace(/^name: kafka$/m, `name: ${name}`),
  [`skills/${name}/skill.yaml`]: `version: 1.0.0\ncategory: interface\ncapabilities: [${name}-cap]\nroles: [coder]\nrisk: high\n`,
});

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}

const made: string[] = [];
let home: string;
let cwd: string;
let emptyBuiltin: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillpublish-cli-")));
  made.push(d);
  return d;
};
const savedHome = process.env.FACTORY_HOME;
const realBeforeVerify = releaseStoreSettings.beforeVerify;
beforeEach(() => {
  home = fresh();
  process.env.FACTORY_HOME = home;
  cwd = fresh();
  emptyBuiltin = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml());
  cpSync("evals/skill-gate/fixtures", join(cwd, "fixtures"), { recursive: true });
  cpSync("evals/skill-gate/suite.yaml", join(cwd, "skill-evaluation.yaml"));
});
afterEach(() => {
  releaseStoreSettings.beforeVerify = realBeforeVerify;
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
const discover = () => ({ builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin });
const scoreAll = async () => {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["score", "lib"], values: {} }, (l) => void lines.push(l), { cwd, home, today: TODAY, now: NOW, skills: SKILLS, ...discover() });
  expect(code, lines.join("\n")).toBe(0);
};

interface Rev {
  id: string;
  version?: string;
}
function writeReleases(skills: string[], over: { revoked?: Rev[]; review?: boolean; skip?: boolean } = {}) {
  const lines = ["schema: 1", "repository: github.com/acme/scf-skills", "releases:", "  - catalogue: cat", "    version: 1.0.0", "    skills:", ...skills.map((s) => `      - {source: lib, id: ${s}}`)];
  if (over.review !== false) lines.push("    review: {by: '@octocat', on: '2026-10-01'}");
  if (over.revoked?.length) {
    lines.push("    revoked:");
    for (const r of over.revoked) lines.push(`      - {id: ${r.id}, version: ${r.version ?? "2.0.0"}, on: '2026-10-02', reason: broken}`);
  }
  writeFileSync(join(cwd, "skill-releases.yaml"), lines.join("\n") + "\n");
}

/** A fake git whose HEAD holds the bytes of both files as they are NOW. `onLs` runs when the files are asked for. */
function fakeGit(onLs?: () => void): GitRun {
  const held: Record<string, Buffer | undefined> = {};
  for (const f of ["skill-releases.yaml", "skill-sources.yaml"]) held[f] = existsSync(join(cwd, f)) ? readFileSync(join(cwd, f)) : undefined;
  return (args) => {
    if (args[0] === "rev-parse") return { status: 0, stdout: Buffer.from(HEAD + "\n") };
    onLs?.();
    const paths = args.slice(args.indexOf("--") + 1);
    const text = paths.filter((p) => held[p]).map((p) => `100644 blob ${gitBlobId(held[p]!, 40)}\t${p}\0`).join("");
    return { status: 0, stdout: Buffer.from(text) };
  };
}

async function publish(over: { git?: GitRun | null; target?: string } = {}) {
  const lines: string[] = [];
  const [catalogue, version] = (over.target ?? "cat@1.0.0").split("@") as [string, string];
  const git = over.git === null ? undefined : (over.git ?? fakeGit());
  const code = releasePublish({ catalogue, version }, (l) => void lines.push(l), { cwd, home, today: TODAY, now: NOW, skills: SKILLS, discover: discover(), ...(git ? { git } : {}) });
  return { code, lines, text: lines.join("\n") };
}
const releaseDir = () => join(home, "skill-releases", "cat", "1.0.0");
const manifest = () => JSON.parse(readFileSync(join(releaseDir(), "catalogue-release.json"), "utf8")) as { createdAt: string; source: { repository: string; commit: string }; skills: { id: string; digest: string; licences: string[]; evaluation: { suite: string; record: string; verdict: string }; revoked?: { on: string; reason: string }; provenance: { review?: { licence: string }; trust: string }; attribution: { path: string }[] }[] };
const snapshot = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        const st = statSync(p);
        return e.isDirectory() ? [`${p} ${st.mode}`, ...snapshot(p)] : [`${p} ${st.mode} ${readFileSync(p).toString("hex")}`];
      })
    : [];
const noRelease = (r: { code: number; lines: string[] }) => {
  expect(r.code).toBe(1);
  expect(r.lines.at(-1)).toBe("PROBLEM cat@1.0.0: nothing was published");
  expect(existsSync(join(home, "skill-releases"))).toBe(false);
};
const newest = (id: string) => {
  const r = readNewestRecord("lib", COMMIT, id, { home });
  if (r.state !== "ok") throw new Error("no record");
  return r;
};
function recordFrom(id: string, over: { digest?: string; evaluatedAt?: string }): EvaluationRecord {
  const raw = structuredClone(newest(id).raw) as EvaluationRecord;
  if (over.digest) raw.candidate.digest = over.digest;
  if (over.evaluatedAt) raw.evaluatedAt = over.evaluatedAt;
  const parsed = parseEvaluationRecord(raw);
  if (!("record" in parsed)) throw new Error(parsed.problem);
  return parsed.record;
}
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
const commitAll = () => {
  git("add", "-A");
  git("commit", "-q", "-m", "release");
};

/** One scored, promotable kafka skill and a request for it. */
async function ready(revoked: Rev[] = []) {
  stage(kafka("kafka"));
  await scoreAll();
  writeReleases([idOf("kafka")], { revoked });
  return idOf("kafka");
}

describe("scf skills release publish", () => {
  it("publishes end to end with real git; release verify prints the same digest", async () => {
    const id = await ready();
    git("init", "-q");
    commitAll();
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["release", "publish", "cat@1.0.0"], values: {} }, (l) => void lines.push(l), { cwd, home, today: TODAY, now: NOW, skills: SKILLS, ...discover() });
    expect(code, lines.join("\n")).toBe(0);
    const m = manifest();
    expect(lines[0]).toMatch(new RegExp(`^SKILL ${id}@2\\.0\\.0 sha256:[0-9a-f]{64} from lib evaluation passed$`));
    const published = lines.find((l) => l.startsWith("PUBLISHED "))!;
    const digest = published.split(" ")[2]!;
    expect(published).toBe(`PUBLISHED cat@1.0.0 ${digest} 1 skills to skill-releases/cat/1.0.0`);
    expect(lines.at(-1)).toBe(`APPROVE cat 1.0.0 ${digest}`);
    expect(m.createdAt).toBe("2026-10-01T00:00:00Z");
    expect(m.source).toEqual({ repository: "github.com/acme/scf-skills", commit: git("rev-parse", "HEAD") });
    const s = m.skills[0]!;
    expect(s.evaluation).toEqual({ suite: "skill-evaluation", record: (parseEvaluationRecord(newest(id).raw) as { digest: string }).digest, verdict: "passed" });
    expect(s.provenance.review?.licence).toBe("MIT");
    expect(s.licences).toEqual(["MIT"]);
    expect(s.attribution.length).toBeGreaterThan(0);
    expect(existsSync(join(releaseDir(), ".attribution", id, s.attribution[0]!.path))).toBe(true);
    const v: string[] = [];
    expect(await skillsCommand({ positionals: ["release", "verify", releaseDir()], values: {} }, (l) => void v.push(l), { cwd, home, today: TODAY, now: NOW, skills: SKILLS, ...discover() })).toBe(0);
    expect(v.find((l) => l.startsWith("VERIFIED"))).toBe(`VERIFIED cat@1.0.0 ${digest} 1 skill`);
  });

  it("the same content again is UNCHANGED; after re-scoring it is REFUSED and nothing changes", async () => {
    const id = await ready();
    const first = await publish();
    expect(first.code, first.text).toBe(0);
    const digest = first.lines.find((l) => l.startsWith("APPROVE"))!.split(" ")[3]!;
    const before = snapshot(join(home, "skill-releases"));
    const again = await publish();
    expect(again.code).toBe(0);
    expect(again.lines).toEqual([`UNCHANGED cat@1.0.0 ${digest}: already published`, `APPROVE cat 1.0.0 ${digest}`]);
    expect(snapshot(join(home, "skill-releases"))).toEqual(before);
    // a newer record: another digest
    writeEvaluationRecord(recordFrom(id, { evaluatedAt: "2026-10-14T10:00:00Z" }), { home });
    const refused = await publish();
    expect(refused.code).toBe(1);
    expect(refused.lines).toEqual(["REFUSED cat@1.0.0: already published with another digest"]);
    expect(snapshot(join(home, "skill-releases"))).toEqual(before);
  });

  it("REFUSED when the version folder is not a release", async () => {
    await ready();
    mkdirSync(join(home, "skill-releases", "cat", "1.0.0"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, "skill-releases"), 0o700);
    chmodSync(join(home, "skill-releases", "cat"), 0o700);
    writeFileSync(join(home, "skill-releases", "cat", "1.0.0", "x.txt"), "x");
    const r = await publish();
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["REFUSED cat@1.0.0: already published and the folder does not verify"]);
  });

  it("a failed write leaves no release folder and no temporary folder", async () => {
    await ready();
    releaseStoreSettings.beforeVerify = (tmp) => writeFileSync(join(tmp, "stray.txt"), "x");
    const r = await publish();
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^PROBLEM .*; nothing was published$/);
    expect(existsSync(join(home, "skill-releases", "cat", "1.0.0"))).toBe(false);
    expect(readdirSync(join(home, "skill-releases")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("uses the bytes it checked: editing either file during the git step changes nothing", async () => {
    const id = await ready();
    const src = readFileSync(join(cwd, "skill-sources.yaml"), "utf8");
    const g = fakeGit(() => {
      writeFileSync(join(cwd, "skill-sources.yaml"), src.replace("status: enabled", "status: disabled\n    reason: later").replace(COMMIT, "d".repeat(40)));
      writeFileSync(join(cwd, "skill-releases.yaml"), "schema: 1\nrepository: github.com/acme/other\nreleases:\n  - {catalogue: cat, version: 9.9.9, skills: [{source: lib, id: x}]}\n");
    });
    const r = await publish({ git: g });
    expect(r.code, r.text).toBe(0);
    expect(manifest().source.repository).toBe("github.com/acme/scf-skills");
    expect(manifest().skills[0]!.id).toBe(id);
  });

  it("writes nothing but skill-releases/ and edits no config, pin or lock file", async () => {
    await ready();
    const keep = (d: string) => snapshot(d).filter((l) => !l.includes("skill-releases"));
    const before = keep(home);
    const cwdBefore = snapshot(cwd);
    expect((await publish()).code).toBe(0);
    expect(keep(home)).toEqual(before);
    expect(snapshot(cwd)).toEqual(cwdBefore);
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
    expect(existsSync(join(home, "skills.lock.json"))).toBe(false);
  });
});

describe("refusals", () => {
  it("the request file is missing, invalid, has no entry or no review", async () => {
    stage(kafka("kafka"));
    let r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM the release request file does not exist");
    writeFileSync(join(cwd, "skill-releases.yaml"), "schema: 2\n");
    r = await publish();
    noRelease(r);
    expect(r.lines[0]).toMatch(/^PROBLEM skill-releases\.yaml /);
    writeReleases([idOf("kafka")]);
    r = await publish({ target: "cat@2.0.0" });
    expect(r.lines).toEqual(["PROBLEM cat@2.0.0: not in skill-releases.yaml", "PROBLEM cat@2.0.0: nothing was published"]);
    writeReleases([idOf("kafka")], { review: false });
    r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM cat@1.0.0: the entry has no review");
  });

  it("the source file is missing or invalid", async () => {
    await ready();
    rmSync(join(cwd, "skill-sources.yaml"));
    let r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM the skill source file does not exist");
    writeFileSync(join(cwd, "skill-sources.yaml"), "schema: 7\n");
    r = await publish();
    noRelease(r);
  });

  it("real git: no commit, a file not committed, a file edited after the commit", async () => {
    await ready();
    git("init", "-q");
    let r = await publish({ git: null });
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM the folder has no git commit");
    git("add", "skill-sources.yaml");
    git("commit", "-q", "-m", "one file");
    r = await publish({ git: null });
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM skill-releases.yaml is not committed");
    commitAll();
    appendFileSync(join(cwd, "skill-releases.yaml"), "# edited\n");
    r = await publish({ git: null });
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM skill-releases.yaml differs from HEAD; commit it first");
  });

  it("an unknown, a disabled and an unstaged source", async () => {
    const id = await ready();
    writeFileSync(join(cwd, "skill-releases.yaml"), readFileSync(join(cwd, "skill-releases.yaml"), "utf8").replace("source: lib", "source: nope"));
    let r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe(`PROBLEM nope/${id}: unknown source`);
    writeReleases([id]);
    writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml({ status: "disabled" }));
    r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe(`PROBLEM lib/${id}: the source is disabled; only an enabled source can be published`);
    writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml());
    rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
    r = await publish();
    noRelease(r);
    expect(r.lines.filter((l) => l.includes("no staged import"))).toHaveLength(1);
    expect(r.lines).toContain(`PROBLEM lib/${id}: the staged import of lib cannot be used (see the lines above)`);
  });

  it("a skill that is not staged", async () => {
    await ready();
    writeReleases([idOf("ghost")]);
    const r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe(`PROBLEM lib/${idOf("ghost")}: not staged at ${COMMIT.slice(0, 12)} or not normalized`);
  });

  it("not promotable: a GPL skill under allow [MIT]", async () => {
    stage({ ...kafka("kafka"), "skills/kafka/LICENSE": GPL });
    await scoreAll();
    writeReleases([idOf("kafka")]);
    const r = await publish();
    noRelease(r);
    expect(r.lines.find((l) => l.startsWith(`PROBLEM lib/${idOf("kafka")}: not promotable`))).toBeDefined();
  });

  it("blocked by a high finding", async () => {
    stage({ ...kafka("kafka"), "skills/kafka/scripts/a.sh": "rm -rf /" });
    await scoreAll();
    writeReleases([idOf("kafka")]);
    const r = await publish();
    noRelease(r);
    expect(r.lines.some((l) => l.startsWith(`PROBLEM lib/${idOf("kafka")}: blocked (`))).toBe(true);
  });

  it("the evaluation did not pass: no record, then a record of another digest", async () => {
    const id = idOf("kafka");
    stage(kafka("kafka"));
    writeReleases([id]);
    let r = await publish();
    noRelease(r);
    expect(r.lines.some((l) => l.startsWith(`PROBLEM lib/${id}: evaluation failed: record-invalid`))).toBe(true);
    await scoreAll();
    writeEvaluationRecord(recordFrom(id, { digest: "sha256:" + "1".repeat(64) }), { home });
    r = await publish();
    noRelease(r);
    expect(r.lines.some((l) => l.startsWith(`PROBLEM lib/${id}: evaluation failed`))).toBe(true);
  });

  it("a missing suite file refuses a skill that is not revoked", async () => {
    const id = await ready();
    rmSync(join(cwd, "skill-evaluation.yaml"));
    const r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe("PROBLEM the evaluation suite file does not exist");
    expect(r.lines.some((l) => l.startsWith(`PROBLEM lib/${id}: not judged by the evaluation gate`))).toBe(true);
  });

  it("a revoked entry that names another version", async () => {
    const id = await ready([{ id: idOf("kafka"), version: "9.9.9" }]);
    const r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe(`PROBLEM lib/${id}: revoked names version 9.9.9, but the built skill is 2.0.0`);
  });

  it("every listed skill is checked: two failures print two lines", async () => {
    stage({ ...kafka("kafka"), ...other("other") });
    writeReleases([idOf("kafka"), idOf("other")]);
    const r = await publish();
    noRelease(r);
    expect(r.lines.filter((l) => l.startsWith(`PROBLEM lib/${idOf("kafka")}:`)).length).toBeGreaterThan(0);
    expect(r.lines.filter((l) => l.startsWith(`PROBLEM lib/${idOf("other")}:`)).length).toBeGreaterThan(0);
  });
});

describe("revoked skills (a revoked skill skips the promotion and evaluation gates)", () => {
  const revoked = async (kind?: (id: string) => void) => {
    const id = idOf("kafka");
    stage(kafka("kafka"));
    kind?.(id);
    writeReleases([id], { revoked: [{ id }] });
    return id;
  };

  it("with no record: not-run and the zero digest", async () => {
    const id = await revoked();
    const r = await publish();
    expect(r.code, r.text).toBe(0);
    expect(r.lines[0]).toBe(`SKILL ${id}@2.0.0 ${manifest().skills[0]!.digest} from lib evaluation not-run revoked 2026-10-02`);
    expect(manifest().skills[0]!.evaluation).toEqual({ suite: "skill-evaluation", record: NO_EVALUATION_RECORD, verdict: "not-run" });
    expect(manifest().skills[0]!.revoked).toEqual({ on: "2026-10-02", reason: "broken" });
  });

  it("after score: passed with the record digest", async () => {
    const id = await revoked();
    await scoreAll();
    expect((await publish()).code).toBe(0);
    expect(manifest().skills[0]!.evaluation).toEqual({ suite: "skill-evaluation", record: (parseEvaluationRecord(newest(id).raw) as { digest: string }).digest, verdict: "passed" });
  });

  it("a failing record: failed with its digest", async () => {
    const id = await revoked();
    await scoreAll();
    const bad = recordFrom(id, { digest: "sha256:" + "1".repeat(64) });
    writeEvaluationRecord(bad, { home });
    expect((await publish()).code).toBe(0);
    expect(manifest().skills[0]!.evaluation).toEqual({ suite: "skill-evaluation", record: (parseEvaluationRecord(newest(id).raw) as { digest: string }).digest, verdict: "failed" });
  });

  it("a missing suite file and invalid scan exceptions: not-run with the record digest", async () => {
    const id = await revoked();
    await scoreAll();
    rmSync(join(cwd, "skill-evaluation.yaml"));
    writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), "schema: 99\n");
    const r = await publish();
    expect(r.code, r.text).toBe(0);
    expect(manifest().skills[0]!.evaluation).toEqual({ suite: "skill-evaluation", record: (parseEvaluationRecord(newest(id).raw) as { digest: string }).digest, verdict: "not-run" });
  });

  it("a licence the allowlist no longer allows is still published with its licence id", async () => {
    await revoked();
    writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml().replace("licence: {allow: [MIT]}", "licence: {allow: [Apache-2.0]}").replace("licence: MIT}", "licence: Apache-2.0}"));
    const r = await publish();
    expect(r.code, r.text).toBe(0);
    expect(manifest().skills[0]!.licences).toEqual(["MIT"]);
    expect(manifest().skills[0]!.attribution.length).toBeGreaterThan(0);
  });

  it("no identified licence: refused", async () => {
    const id = idOf("kafka");
    stage(kafka("kafka"), false);
    writeReleases([id], { revoked: [{ id }] });
    const r = await publish();
    noRelease(r);
    expect(r.lines[0]).toBe(`PROBLEM lib/${id}: revoked, but no licence is identified (the release needs one)`);
  });

  it("a corrupt newest record: refused", async () => {
    const id = await revoked();
    await scoreAll();
    const dir = evaluationsDir("lib", COMMIT, home);
    const file = readdirSync(dir).filter((n) => n.startsWith(`${id}--`)).sort().at(-1)!;
    writeFileSync(join(dir, file), "{not json");
    const r = await publish();
    noRelease(r);
    expect(r.lines.some((l) => l.startsWith(`PROBLEM lib/${id}: revoked, but its newest evaluation record cannot be read`))).toBe(true);
  });
});

describe("syntax and helpers", () => {
  it("bad operands give a syntax error with the usage text", async () => {
    for (const bad of [["release", "publish", "foo"], ["release", "publish", "Foo@1"], ["release", "publish", "a@b@c"], ["release", "publish"]]) {
      await expect(skillsCommand({ positionals: bad, values: {} }, () => undefined, { cwd, home, today: TODAY, now: NOW, skills: SKILLS, ...discover() })).rejects.toThrow(SKILLS_USAGE);
    }
    expect(SKILLS_USAGE).toContain("scf skills release publish <catalogue>@<version>");
    expect(existsSync(join(home, "skill-releases"))).toBe(false);
  });

  it("parses the target", () => {
    expect(parseReleaseTarget("cat@1.0.0")).toEqual({ catalogue: "cat", version: "1.0.0" });
    expect(parseReleaseTarget("a@b@c")).toBeUndefined();
    expect(parseReleaseTarget("Foo@1")).toBeUndefined();
    expect(releaseOperandsProblem(["publish", "cat@1.0.0"])).toBeUndefined();
    expect(releaseOperandsProblem(["verify", "x"])).toBeUndefined();
    expect(releaseOperandsProblem(["list"])).toBeUndefined();
    expect(releaseOperandsProblem(["list", "x"])).toMatch(/"list"/);
    expect(releaseOperandsProblem(["publish", "foo"])).toMatch(/<catalogue>@<version>/);
  });

  it("gitBlobId matches git", () => {
    expect(gitBlobId(Buffer.from("hello\n"), 40)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobId(Buffer.from("hello\n"), 64)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("committedState", () => {
    const bytes = Buffer.from("a: 1\n");
    const files = [{ path: "f.yaml", bytes }];
    const ok = (mode = "100644", oid = gitBlobId(bytes, 40)): GitRun => (args) =>
      args[0] === "rev-parse" ? { status: 0, stdout: Buffer.from(HEAD) } : { status: 0, stdout: Buffer.from(`${mode} blob ${oid}\tf.yaml\0`) };
    it("accepts a committed file, with SHA-1 and SHA-256 ids", () => {
      expect(committedState(".", files, ok())).toEqual({ state: "ok", commit: HEAD });
      expect(committedState(".", files, ok("100755"))).toEqual({ state: "ok", commit: HEAD });
      expect(committedState(".", files, ok("100644", gitBlobId(bytes, 64))).state).toBe("ok");
    });
    it("refuses every other case without throwing", () => {
      const reason = (g: GitRun) => (committedState(".", files, g) as { reason: string }).reason;
      expect(reason(() => ({ status: 1, stdout: Buffer.alloc(0) }))).toBe("the folder has no git commit");
      expect(reason(() => ({ status: null, stdout: Buffer.alloc(0) }))).toBe("git cannot read the folder");
      expect(reason((a) => (a[0] === "rev-parse" ? { status: 0, stdout: Buffer.from("nonsense") } : { status: 0, stdout: Buffer.alloc(0) }))).toBe("git cannot read the folder");
      expect(reason((a) => (a[0] === "rev-parse" ? { status: 0, stdout: Buffer.from(HEAD) } : { status: 0, stdout: Buffer.alloc(0) }))).toBe("f.yaml is not committed");
      expect(reason(ok("120000"))).toBe("f.yaml is not a regular file in HEAD");
      expect(reason(ok("100644", "e".repeat(40)))).toBe("f.yaml differs from HEAD; commit it first");
      expect(reason(() => { throw new Error("boom"); })).toBe("git cannot read the folder");
    });
  });
});
