import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { applyConnector, connectorCanonical, connectorEvidence, type ConnectedSkill, type EvaluationResult } from "../src/skills/connector.js";
import { PRISMA_CONNECTOR, type SourceConnector } from "../src/skills/connector-rules.js";
import { normalizeSkill, type NormalizeOrigin } from "../src/skills/normalize.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { runSkillCatalogue } from "../src/skills/run-catalogue.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "prisma", repository: "https://github.com/prisma/skills", repositoryKey: "github.com/prisma/skills", commit: COMMIT };
const SOURCE: SkillLibrarySource = {
  id: "prisma", repository: ORIGIN.repository, repositoryKey: ORIGIN.repositoryKey, status: "enabled", ref: { approved: COMMIT }, paths: ["skills"],
  adapter: "agent-skills", trust: "verified", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "@example",
};
const empty = mkdtempSync(join(tmpdir(), "connector-catalogue-"));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

function connect(connector: SourceConnector, bodies: Record<string, string>): ConnectedSkill[] {
  const skills = Object.entries(bodies).map(([name, body]) => {
    const files = [{ path: "SKILL.md", content: new Uint8Array(Buffer.from(`---\nname: ${name}\ndescription: About ${name}.\n---\n\n${body}\n`)) }];
    const r = normalizeSkill(ORIGIN, { root: `skills/${name}`, files });
    if (!r.ok) throw new Error(r.reasons.join("; "));
    return r.skill;
  });
  return applyConnector(connector, skills).mapped;
}
const registered = (c: ConnectedSkill): RegisteredSkill =>
  ({
    key: `${c.skill.package.id}@${c.skill.package.version}`, id: c.skill.package.id, version: c.skill.package.version, source: "admin", label: "x", dir: "/x", active: true,
    trust: "approved", pin: "pinned", digest: c.skill.package.digest, pkg: { ...c.skill.package, dependencies: [], conflicts: [], roles: [] },
  }) as unknown as RegisteredSkill;
const passAll = (mapped: ConnectedSkill[]): EvaluationResult[] =>
  mapped.flatMap((c) => c.record.evaluations.map((evaluation) => ({ skill: c.record.id, digest: c.record.digest, evaluation, result: "passed" as const })));

function offered(connector: SourceConnector, bodies: Record<string, string>, over: { results?: boolean; scanClean?: boolean; include?: string[] } = {}) {
  const mapped = connect(connector, bodies);
  const evidence = connectorEvidence(connector, { findings: [] });
  const canonical = connectorCanonical({
    connector, mapped, source: SOURCE, licence: "allowed", scanClean: over.scanClean ?? true, results: over.results === false ? [] : passAll(mapped), evidence,
  });
  const r = runSkillCatalogue(
    { workdir: "/work", config: ConfigSchema.parse({ skills: over.include ? { selection: { include: over.include } } : {} }), task: "" },
    { discover: () => ({ skills: mapped.map(registered), byKey: new Map(mapped.map((m) => [registered(m).key, registered(m)])), problems: [] }), profile: () => buildRepoProfile(empty), canonical },
  );
  const names = r.text.split("\n").filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as { id: string }).id);
  return { r, names, mapped };
}
const REVIEWED: SourceConnector = { ...PRISMA_CONNECTOR, reviewed: [COMMIT] };
const BODIES = { "prisma-orm-setup": "Set up.", "prisma-client-api": "Use the client.", "prisma-cli": "Run the CLI." };
const idOf = (name: string) => connect(REVIEWED, { [name]: "x" })[0]!.skill.package.id;

describe("connector skills in the run catalogue", () => {
  it("offers a skill with required evaluations only when they passed, even without an exclusive capability", () => {
    const ok = offered(REVIEWED, BODIES);
    expect(ok.names).toContain(idOf("prisma-orm-setup"));
    const gated = offered(REVIEWED, BODIES, { results: false });
    expect(gated.names).toEqual([idOf("prisma-client-api")]);
  });
  it("also withholds a low-risk skill whose text has a migration command", () => {
    const bodies = { "prisma-client-api": "Run npx prisma migrate deploy first." };
    expect(offered(REVIEWED, bodies).names).toEqual([idOf("prisma-client-api")]);
    const gated = offered(REVIEWED, bodies, { results: false });
    expect(gated.names).toEqual([]);
    expect(gated.r.blocked).toBeUndefined();
  });
  it("withholds everything of a commit that is not reviewed, and a dirty scan", () => {
    expect(offered(PRISMA_CONNECTOR, BODIES).names).toEqual([]);
    expect(offered(REVIEWED, BODIES, { scanClean: false }).names).toEqual([]);
  });
  it("stops when a withheld skill is always loaded", () => {
    const r = offered(REVIEWED, BODIES, { results: false, include: [idOf("prisma-orm-setup")] }).r;
    expect(r.text).toBe("");
    expect(r.blocked).toContain("fails a safety gate");
  });
});
