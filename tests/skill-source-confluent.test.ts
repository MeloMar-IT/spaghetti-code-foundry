import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ConfigSchema } from "../src/config.js";
import { providerEvidence } from "../src/skills/catalogue.js";
import { skillsCommand } from "../src/skills/cli.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { normalizeSkill } from "../src/skills/normalize.js";
import { profileSkill } from "../src/skills/source-profile.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";
import { APACHE_LICENCE_PATH, CONFLUENT_COMMUNITY_TEXT, CONFLUENT_FILES } from "./fixtures/skill-layouts/confluent.js";

const TODAY = "2026-10-15";
const COMMIT = "c".repeat(40);
const ID = "confluent-agent-skills";
const EXAMPLE = resolve("docs/examples/skill-sources.confluent.yaml");
const APACHE = readFileSync(APACHE_LICENCE_PATH, "utf8");
const FILES: Record<string, string> = { ...CONFLUENT_FILES, LICENSE: APACHE };
const PATHS = Object.keys(CONFLUENT_FILES).map((p) => p.replace(/\/SKILL\.md$/, "")).sort();
const PROJECT = { "apache-kafka": "4.1.0", "confluent-platform": "8.0.0", flink: "1.20.0" };

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "confluent-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
  cwd = fresh();
  const doc = parse(readFileSync(EXAMPLE, "utf8"));
  const s = doc.sources[0];
  s.status = "enabled";
  delete s.reason;
  s.ref.approved = COMMIT;
  writeFileSync(join(cwd, "skill-sources.yaml"), stringify(doc));
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"), undefined, TODAY);
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
const stage = (files: Record<string, string>, into = home) => {
  const t = tree(files);
  const prep = prepareImport(source(), t);
  const licence = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
  return publishImport(addLicenceEvidence(prep, licence, "2026-10-01T10:00:00Z"), { home: into });
};
const dev = () => ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
async function run(positionals: string[], opts: { home?: string; builtinRoot?: string } = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals, values: {} }, (l) => void lines.push(l), {
    cwd, home: opts.home ?? home, today: TODAY, ...(opts.builtinRoot ? { builtinRoot: opts.builtinRoot, userHome: join(home, "u"), env: {}, skills: dev() } : {}),
  });
  return { code, lines, text: lines.join("\n") };
}
const promote = (h?: string) => run(["promote", "check", ID], { home: h });
const digests = (lines: string[]) => new Map(lines.filter((l) => l.startsWith("EVALUATION ")).map((l) => [`${l.split(" ")[1]!.split("/")[1]} ${l.split(" ")[2]}`, l.split(" ")[3]!.slice(0, -1)] as const));
const names = ["kafka-clients", "streams-apps", "schema-registry", "flink-sql", "cloud-migration"];
const recordsFor = (d: Map<string, string>, skip: (name: string, suite: string) => object | undefined = () => ({})) => {
  const evaluations = [];
  for (const [key, digest] of d) {
    const [skill, suite] = key.split(" ") as [string, string];
    const over = skip(skill, suite);
    if (!over) continue;
    evaluations.push({
      source: ID, skill, digest, suite, result: "passed", ...(suite === "compatibility" ? { project: { ...PROJECT } } : {}),
      owner: "@octocat", reviewed: "2026-10-01", ...over,
    });
  }
  writeFileSync(join(cwd, "skill-evaluations.yaml"), stringify({ schema: 1, evaluations }));
};
const refused = (text: string, path: string) => text.split("\n").find((l) => l.startsWith(`REFUSED ${path}:`));

describe("the Confluent example declaration", () => {
  const entry = () => parse(readFileSync(EXAMPLE, "utf8")).sources[0];
  it("is read without problems and holds the reviewed fields", () => {
    const r = readSources(EXAMPLE, undefined, TODAY);
    expect(r.state).toBe("ok");
    const s = (r as { manifest: { sources: SkillLibrarySource[] } }).manifest.sources[0]!;
    expect(s).toMatchObject({
      id: ID, repository: "https://github.com/confluentinc/agent-skills", status: "disabled", ref: { track: "main" }, adapter: "agent-skills", trust: "verified",
      licence: { allow: ["Apache-2.0"] }, scope: { capabilities: [], technologies: [{ name: "apache-kafka", version: ">=4.0" }] },
      update: { cadence: "manual" }, owner: "@MeloMar-IT",
      profile: {
        provider: "confluent",
        products: [{ name: "apache-kafka", version: ">=4.0" }, { name: "confluent-platform", version: ">=8.0" }, { name: "flink", version: ">=1.19" }],
      },
    });
    expect(s.reason).toBeTruthy();
    expect(s.ref.approved).toBeUndefined();
    expect(s.paths).toHaveLength(5);
    expect(s.paths.every((p) => p.startsWith("placeholder/"))).toBe(true);
    expect(s.profile!.portable.map((p) => p.capability).sort()).toEqual(["kafka-consumer", "kafka-producer", "kafka-schema", "kafka-streams", "kafka-transactions"]);
  });
  it("maps only to capabilities of skills/kafka and never to a confluent- name", () => {
    const own = new Set(loadSkillPackage("skills/kafka").capabilities);
    const targets = Object.values<string>(entry().profile.portable);
    expect(targets).toHaveLength(5);
    for (const t of targets) {
      expect(own.has(t)).toBe(true);
      expect(t.startsWith("confluent-")).toBe(false);
    }
  });
  it("is shipped in the package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(pkg.files).toContain("docs/examples/skill-sources.confluent.yaml");
  });
});

describe("scf skills with the Confluent layout", () => {
  it("scans five skills and blocks none", async () => {
    stage(FILES);
    const r = await run(["scan", ID]);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toMatch(/^SCANNED 5 skills from github\.com\/confluentinc\/agent-skills@c{12} sha256:[0-9a-f]{64}: 0 blocked$/);
  });

  describe("promote check", () => {
    it("refuses every skill until its evaluations are recorded, streams-apps included", async () => {
      stage(FILES);
      const r = await promote();
      expect(r.code).toBe(1);
      for (const p of PATHS) {
        expect(refused(r.text, p)).toBe(`REFUSED ${p}: evaluation (messaging-semantics: not-recorded; compatibility: not-recorded)`);
      }
      const evaluation = r.lines.filter((l) => l.startsWith("EVALUATION "));
      expect(evaluation).toHaveLength(10);
      for (const l of evaluation) expect(l).toMatch(new RegExp(`^EVALUATION ${ID}/\\S+ (?:messaging-semantics|compatibility) sha256:[0-9a-f]{64}: not-recorded$`));
      expect(r.lines.at(-1)).toMatch(/: 0 promotable, 5 refused$/);
    });

    it("promotes all five once both suites are recorded at the staged digests", async () => {
      stage(FILES);
      recordsFor(digests((await promote()).lines));
      const r = await promote();
      expect(r.code).toBe(0);
      const ok = r.lines.filter((l) => l.startsWith("PROMOTABLE "));
      expect(ok).toHaveLength(5);
      for (const l of ok) expect(l).toMatch(/ Apache-2\.0$/);
      expect(r.lines.filter((l) => l.startsWith("EVALUATION ")).every((l) => l.endsWith(": passed"))).toBe(true);
    });

    it("refuses a skill with only one suite recorded", async () => {
      stage(FILES);
      recordsFor(digests((await promote()).lines), (n, s) => (n === "flink-sql" && s === "compatibility" ? undefined : {}));
      const r = await promote();
      expect(refused(r.text, "placeholder/flink/flink-sql")).toBe("REFUSED placeholder/flink/flink-sql: evaluation (compatibility: not-recorded)");
      expect(r.lines.filter((l) => l.startsWith("PROMOTABLE "))).toHaveLength(4);
    });

    it("refuses a project that does not fit, a failed record and a partial project", async () => {
      stage(FILES);
      const d = digests((await promote()).lines);
      recordsFor(d, (n, s) => (n === "flink-sql" && s === "compatibility" ? { project: { "apache-kafka": "3.8.0" } } : {}));
      expect(refused((await promote()).text, "placeholder/flink/flink-sql")).toBe("REFUSED placeholder/flink/flink-sql: evaluation (compatibility: incompatible)");
      recordsFor(d, (n, s) => (n === "flink-sql" && s === "compatibility" ? { project: { "apache-kafka": "4.1.0" } } : {}));
      expect(refused((await promote()).text, "placeholder/flink/flink-sql")).toBe("REFUSED placeholder/flink/flink-sql: evaluation (compatibility: unchecked)");
      recordsFor(d, (n, s) => (n === "flink-sql" && s === "messaging-semantics" ? { result: "failed" } : {}));
      expect(refused((await promote()).text, "placeholder/flink/flink-sql")).toBe("REFUSED placeholder/flink/flink-sql: evaluation (messaging-semantics: recorded-failed)");
    });

    it("prints a PROBLEM and exits 1 for an invalid skill-evaluations.yaml", async () => {
      stage(FILES);
      writeFileSync(join(cwd, "skill-evaluations.yaml"), "schema: 2\nevaluations: []\n");
      const r = await promote();
      expect(r.code).toBe(1);
      expect(r.lines).toContain("PROBLEM skill-evaluations.yaml schema: schema must be 1");
    });

    it("a changed skill needs new records: its old digest is other-digest, and the others stay promotable", async () => {
      stage(FILES);
      recordsFor(digests((await promote()).lines));
      const changed = { ...FILES, "placeholder/kafka-streams/streams-apps/SKILL.md": FILES["placeholder/kafka-streams/streams-apps/SKILL.md"] + "\nKafka gives exactly-once delivery.\n" };
      const second = fresh();
      stage(changed, second);
      const r = await promote(second);
      expect(r.code).toBe(1);
      expect(refused(r.text, "placeholder/kafka-streams/streams-apps")).toBe(
        "REFUSED placeholder/kafka-streams/streams-apps: evaluation (messaging-semantics: exactly-once, other-digest; compatibility: other-digest)",
      );
      expect(r.text).toMatch(/EVALUATION \S+ messaging-semantics sha256:[0-9a-f]{64}: exactly-once, other-digest at placeholder\/kafka-streams\/streams-apps\/SKILL\.md:\d+/);
      expect(r.lines.filter((l) => l.startsWith("PROMOTABLE "))).toHaveLength(4);
    });
  });

  describe("licence", () => {
    it("refuses all five without a LICENSE file", async () => {
      const { LICENSE: _l, ...bare } = FILES;
      stage(bare);
      const r = await promote();
      for (const p of PATHS) expect(refused(r.text, p)).toMatch(/^REFUSED \S+: missing \(/);
    });
    const withConfluent = (declared: string) => ({
      ...FILES,
      "placeholder/flink/flink-sql/SKILL.md": FILES["placeholder/flink/flink-sql/SKILL.md"]!.replace("license: Apache-2.0", `license: ${declared}`),
      "placeholder/flink/flink-sql/LICENSE": CONFLUENT_COMMUNITY_TEXT,
    });
    it("rejects the Confluent Community License and leaves the others alone", async () => {
      stage(withConfluent("Confluent Community License"));
      recordsFor(digests((await promote()).lines));
      const r = await promote();
      expect(refused(r.text, "placeholder/flink/flink-sql")).toMatch(/^REFUSED placeholder\/flink\/flink-sql: rejected \(/);
      expect(r.lines.filter((l) => l.startsWith("PROMOTABLE "))).toHaveLength(4);
    });
    it("calls an Apache declaration over a Confluent file ambiguous", async () => {
      stage(withConfluent("Apache-2.0"));
      const r = await promote();
      expect(refused(r.text, "placeholder/flink/flink-sql")).toMatch(/^REFUSED placeholder\/flink\/flink-sql: ambiguous \(/);
    });
  });

  describe("overlap", () => {
    let builtin: string;
    const selection = (digest: string) =>
      writeFileSync(
        join(cwd, "skill-selections.yaml"),
        stringify({
          schema: 1,
          selections: [{
            source: ID, skill: "streams-apps", digest, scope: "portable", category: "interface", capabilities: ["kafka-schema", "kafka-streams"],
            requires: {}, owner: "@octocat", reviewed: "2026-10-01",
          }],
        }),
      );
    beforeEach(() => {
      builtin = fresh();
      cpSync(resolve("skills/kafka"), join(builtin, "kafka"), { recursive: true });
    });

    it("without a selection the upstream-shaped skill declares nothing", async () => {
      stage(FILES);
      const r = await run(["overlap", ID], { builtinRoot: builtin });
      expect(r.code).toBe(0);
      const canonical = r.lines.filter((l) => l.startsWith("CANONICAL ")).map((l) => l.split(" ")[1]);
      expect(canonical).toEqual(["kafka-consumer:", "kafka-producer:", "kafka-transactions:"]);
      expect(r.text).not.toMatch(/kafka-streams|kafka-schema/);
    });

    it("with a reviewed selection it compares five portable and four vendor capabilities, with versions", async () => {
      stage(FILES);
      const staged = new Map<string, string>();
      for (const [path, text] of Object.entries(CONFLUENT_FILES)) {
        const n = normalizeSkill(
          { source: ID, repository: "https://github.com/confluentinc/agent-skills", repositoryKey: "github.com/confluentinc/agent-skills", commit: COMMIT },
          { root: path.replace(/\/SKILL\.md$/, ""), files: [{ path: "SKILL.md", content: new Uint8Array(Buffer.from(text)) }] },
        );
        if (n.ok) staged.set(n.skill.provenance.name, n.skill.package.digest);
      }
      selection(staged.get("streams-apps")!);
      const r = await run(["overlap", ID], { builtinRoot: builtin });
      expect(r.lines.filter((l) => l.startsWith("PROBLEM "))).toEqual([]);
      expect(r.code).toBe(0);
      for (const cap of ["kafka-consumer", "kafka-producer", "kafka-schema", "kafka-streams", "kafka-transactions"]) {
        const at = r.lines.indexOf(`CANONICAL ${cap}: kafka@1.0.0 (trust-tier)`);
        expect(at, cap).toBeGreaterThanOrEqual(0);
        expect(r.lines[at + 1]).toMatch(/^REJECTED \S+@\S+: outranked$/);
      }
      for (const cap of ["confluent-cloud-clients", "confluent-cloud-migration", "confluent-flink-sql", "confluent-schema-registry"]) {
        expect(r.lines.find((l) => l.startsWith(`NEW ${cap}: `)), cap).toMatch(/ provider confluent$/);
      }
      const versions = r.lines.filter((l) => l.startsWith("VERSIONS "));
      expect(versions).toHaveLength(5);
      const vendor = versions.filter((l) => l.endsWith("apache-kafka >=4.0, confluent-platform >=8.0, flink >=1.19"));
      expect(vendor).toHaveLength(3);
      expect(versions.filter((l) => l.endsWith(": apache-kafka >=4.0"))).toHaveLength(2);
      expect(r.lines.at(-1)).toMatch(/: 5 shared, 4 new, 4 vendor-only, 0 conflicts$/);
    });

    it("an invalid skill-selections.yaml is a PROBLEM", async () => {
      stage(FILES);
      writeFileSync(join(cwd, "skill-selections.yaml"), "schema: 3\nselections: []\n");
      const r = await run(["overlap", ID], { builtinRoot: builtin });
      expect(r.code).toBe(1);
      expect(r.lines.some((l) => l.startsWith("PROBLEM skill-selections.yaml "))).toBe(true);
    });
  });

  it("the provider evidence of a profiled skill names the provider and its products", () => {
    const s = source();
    const n = normalizeSkill(
      { source: ID, repository: s.repository, repositoryKey: s.repositoryKey, commit: COMMIT },
      { root: "placeholder/schema-registry/schema-registry", files: [{ path: "SKILL.md", content: new Uint8Array(Buffer.from(CONFLUENT_FILES["placeholder/schema-registry/schema-registry/SKILL.md"]!)) }] },
    );
    if (!n.ok) throw new Error(n.reasons.join("; "));
    const profiled = profileSkill(n.skill, s).skill!;
    expect(providerEvidence(profiled.package.provider!)).toBe("needs provider: confluent (apache-kafka >=4.0, confluent-platform >=8.0, flink >=1.19)");
  });
});
