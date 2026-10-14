import { describe, expect, it } from "vitest";
import { COLLISION_LIMITS } from "../src/skills/collision-rules.js";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import { PROVIDER_MARKERS } from "../src/skills/provider-rules.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import type { SkillSelection } from "../src/skills/selections.js";
import * as sourceEvaluation from "../src/skills/source-evaluation.js";
import {
  applySelection, evaluateSourceSkills, providerMarkerRules, SOURCE_SKILL_REASONS,
  type SourceSkillReason, type SourceSkillsEvaluation, type SourceSkillsInput,
} from "../src/skills/source-skill-evaluation.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

type F = { path: string; content: Uint8Array };
const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT };
const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const md = (name: string, body = "Do the work.", front = "") => f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n${front}---\n\n${body}\n`);

function skill(name: string, o: { body?: string; front?: string; yaml?: string; extra?: F[]; root?: string } = {}): NormalizedSkill {
  const files = [md(name, o.body, o.front), ...(o.yaml ? [f("skill.yaml", o.yaml)] : []), ...(o.extra ?? [])];
  const r = normalizeSkill(ORIGIN, { root: o.root ?? `skills/${name}`, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
  id: "lib", repository: ORIGIN.repository, repositoryKey: ORIGIN.repositoryKey, status: "enabled", ref: { approved: COMMIT }, paths: ["skills"],
  adapter: "agent-skills", trust: "community", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "@example", ...over,
});
function select(s: NormalizedSkill, o: Partial<SkillSelection> & { requires?: Partial<SkillSelection["requires"]> } = {}): SkillSelection {
  const { requires, ...rest } = o;
  return {
    source: "lib", skill: s.provenance.name, digest: s.package.digest, scope: "portable", category: "database", capabilities: [],
    requires: { clis: [], mcp: [], credentials: [], services: [], ...requires }, owner: "@example", reviewed: "2026-10-01", ...rest,
  };
}
const registered = (id: string, caps: string[], o: { pin?: RegisteredSkill["pin"]; active?: boolean; provider?: boolean; digest?: string; version?: string } = {}): RegisteredSkill =>
  ({
    key: `${id}@${o.version ?? "1.0.0"}`, id, version: o.version ?? "1.0.0", source: "builtin", label: "built-in", dir: "/x", active: o.active ?? true, trust: "builtin", pin: o.pin ?? "pinned",
    digest: o.digest ?? "sha256:" + id.padEnd(64, "b").slice(0, 64),
    pkg: {
      id, version: o.version ?? "1.0.0", capabilities: caps, category: "database", risk: "low", connectors: [], tool_profile: { shell: false, network: false, filesystem: "read" },
      files: { references: [], scripts: [], assets: [], evals: [] }, description: id, instructions: id, digest: "sha256:" + id,
      ...(o.provider ? { provider: { name: "azure" } } : {}),
    },
  }) as unknown as RegisteredSkill;

const POLICY = { exclusive: [] as string[], highRisk: [] as string[] };
interface Setup { skills: NormalizedSkill[]; selections?: SkillSelection[]; licences?: Record<string, "allowed" | "review">; over?: Partial<SourceSkillsInput> }
function run({ skills, selections, licences, over }: Setup): SourceSkillsEvaluation {
  return evaluateSourceSkills({
    source: source(), skills, selections: selections ?? skills.map((s) => select(s)),
    licences: licences ?? Object.fromEntries(skills.map((s) => [s.provenance.root, "allowed" as const])), blocked: [], registered: [], policy: POLICY, ...over,
  });
}
const one = (e: SourceSkillsEvaluation, name: string) => {
  const v = e.skills.find((s) => s.name === name);
  if (!v) throw new Error("missing " + name);
  return v;
};
const permutations = <T>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object" && !ArrayBuffer.isView(v) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
};

const CASES: Record<SourceSkillReason, () => ReturnType<typeof one>> = {
  "not-selected": () => one(run({ skills: [skill("a")], selections: [] }), "a"),
  "selection-stale": () => {
    const s = skill("a");
    return one(run({ skills: [s], selections: [select(s, { digest: "sha256:" + "0".repeat(64) })] }), "a");
  },
  licence: () => one(run({ skills: [skill("a")], licences: { "skills/a": "review" } }), "a"),
  safety: () => one(run({ skills: [skill("a")], over: { blocked: [skill("a").package.id] } }), "a"),
  "source-not-approved": () => one(run({ skills: [skill("a")], over: { source: source({ status: "quarantined" }) } }), "a"),
  "needs-unavailable-tools": () => {
    const s = skill("a");
    return one(run({ skills: [s], selections: [select(s, { scope: "provider", requires: { clis: ["tool"] } })] }), "a");
  },
  "provider-content-in-portable": () => one(run({ skills: [skill("a", { body: "Run `az login` first." })] }), "a"),
  "undeclared-requirement": () => {
    const s = skill("a", { body: "Use DefaultAzureCredential." });
    return one(run({ skills: [s], selections: [select(s, { scope: "provider" })] }), "a");
  },
  incompatible: () => {
    const s = skill("a");
    return one(run({ skills: [s], selections: [select(s, { product: { name: "azure-cosmos-db", version: ">=4" } })], over: { evidence: [{ name: "node", version: "20.0.0" }] } }), "a");
  },
  "compatibility-unchecked": () => {
    const s = skill("a");
    return one(run({ skills: [s], selections: [select(s, { product: { name: "azure-cosmos-db", version: ">=4" } })], over: { evidence: [{ name: "azure-cosmos-db", version: "latest" }] } }), "a");
  },
  "blocking-collision": () => {
    const x = skill("a", { yaml: "version: 1.0.0\n", body: "One." });
    const y = skill("a", { yaml: "version: 1.0.0\n", body: "Two.", root: "skills/a2" });
    const e = run({ skills: [x, y], selections: [select(x)] });
    return e.skills.find((s) => s.digest === x.package.digest)!;
  },
  "provider-without-policy": () => {
    const p = skill("cosmos-cql", { yaml: "capabilities: [cql]\n" });
    const q = skill("cql-guide", { yaml: "capabilities: [cql, cql-basics]\n" });
    return one(run({ skills: [p, q], selections: [select(p, { scope: "provider", capabilities: ["cql"] }), select(q)] }), "cosmos-cql");
  },
};

describe("evaluateSourceSkills", () => {
  it("passes a selected portable skill with an allowed licence", () => {
    const e = run({ skills: [skill("a", { yaml: "capabilities: [thing]\n" })] });
    expect(e.skills[0]).toMatchObject({ eligible: true, reasons: [], scope: "portable", rules: [] });
  });

  it.each(SOURCE_SKILL_REASONS)("reports %s", (reason) => {
    const v = CASES[reason]();
    expect(v.reasons).toContain(reason);
    expect(v.eligible).toBe(false);
    expect(v.reasons).toEqual([...v.reasons].sort());
  });
  it("has a case for every reason code", () => {
    expect(Object.keys(CASES).sort()).toEqual([...SOURCE_SKILL_REASONS].sort());
  });

  it("ignores a selection of another source and treats a missing licence root as unknown", () => {
    const s = skill("a");
    expect(one(run({ skills: [s], selections: [select(s, { source: "other" })] }), "a").reasons).toEqual(["not-selected"]);
    expect(one(run({ skills: [s], licences: {} }), "a").reasons).toEqual(["licence"]);
  });
  it("does not give a stale or missing selection a scope", () => {
    expect(CASES["not-selected"]().scope).toBeUndefined();
    expect(CASES["selection-stale"]().scope).toBeUndefined();
  });
  it("source-not-approved also holds for another approved commit", () => {
    const v = one(run({ skills: [skill("a")], over: { source: source({ ref: { approved: "b".repeat(40) } }) } }), "a");
    expect(v.reasons).toContain("source-not-approved");
  });

  it("turns declared requirements into connectors, raises the risk and never lets the skill win", () => {
    const s = skill("a", { yaml: "capabilities: [thing]\n" });
    const e = run({ skills: [s], selections: [select(s, { scope: "provider", requires: { clis: ["az"] } })], over: { policy: { ...POLICY, exclusive: ["thing"] } } });
    const v = one(e, "a");
    expect(v.connectors).toEqual(["cli-az"]);
    expect(v.risk).toBe("medium");
    expect(v.reasons).toContain("needs-unavailable-tools");
    expect(v.wins).toEqual([]);
    expect(e.canonical.resolutions[0]!.rejected.map((r) => r.code)).toContain("tools");
    expect(s.package.connectors).toEqual([]);
    expect(s.package.risk).toBe("low");
  });

  describe("markers", () => {
    const SAMPLES: Record<string, string> = {
      "azure-cli": "Run `az login` and then az group list.",
      "azure-developer-cli": "Use azd up to deploy.",
      "azure-identity": "const c = new DefaultAzureCredential();",
      "azure-mcp": "Call mcp__azure__storage__list.",
      "azure-portal": "Open https://portal.azure.com/ now.",
      "azure-cosmos-host": "Endpoint myacct-zz9.documents.azure.com",
      "azure-storage-host": "https://acct.blob.core.windows.net/x",
      "azure-key-vault-host": "https://kv.vault.azure.net/",
      "azure-sql-host": "srv.database.windows.net",
      "azure-service-bus-host": "ns.servicebus.windows.net",
      "azure-openai-host": "res.openai.azure.com",
      "azure-search-host": "svc.search.windows.net",
      "azure-app-host": "app.azurewebsites.net",
      "azure-registry-host": "reg.azurecr.io",
      "azure-management-host": "https://management.azure.com/subscriptions",
      "azure-entra-host": "https://login.microsoftonline.com/tenant",
    };
    it("has a sample for every rule", () => {
      expect(Object.keys(SAMPLES).sort()).toEqual(PROVIDER_MARKERS.map((m) => m.rule).sort());
    });
    it.each(Object.entries(SAMPLES))("finds %s", (rule, text) => {
      expect(providerMarkerRules(skill("a", { body: text }))).toEqual([rule]);
    });
    it.each(["Requires the `az` CLI.", "Check az --version first.", "Needs the Azure CLI."])("finds a standalone CLI reference: %s", (text) => {
      expect(providerMarkerRules(skill("a", { body: text }))).toEqual(["azure-cli"]);
    });
    it.each(["Run /usr/bin/az login.", "Run az appconfig list.", "Run /opt/homebrew/bin/az --version"])("finds a CLI call outside the usual forms: %s", (text) => {
      expect(providerMarkerRules(skill("a", { body: text }))).toEqual(["azure-cli"]);
      expect(run({ skills: [skill("a", { body: text })] }).skills[0]!.reasons).toEqual(["provider-content-in-portable"]);
      const s = skill("a", { body: text });
      expect(one(run({ skills: [s], selections: [select(s, { scope: "provider" })] }), "a").reasons).toEqual(["undeclared-requirement"]);
    });
    it("does not mix up az and azd, or hit unrelated words", () => {
      expect(providerMarkerRules(skill("a", { body: "azd up" }))).toEqual(["azure-developer-cli"]);
      for (const text of ["A jazz band plays.", "foo.az login", "raise an error"]) expect(providerMarkerRules(skill("a", { body: text })), text).toEqual([]);
    });
    it("finds a marker in a reference file, in the frontmatter and in metadata", () => {
      expect(providerMarkerRules(skill("a", { extra: [f("references/x.md", "https://portal.azure.com")] }))).toEqual(["azure-portal"]);
      expect(providerMarkerRules(skill("a", { front: "compatibility: Requires az login\n" }))).toEqual(["azure-cli"]);
      expect(providerMarkerRules(skill("a", { front: "metadata:\n  note: uses DefaultAzureCredential\n" }))).toEqual(["azure-identity"]);
    });
    it("refuses frontmatter-only content in a portable skill", () => {
      expect(run({ skills: [skill("a", { front: "compatibility: Requires az login\n" })] }).skills[0]!.reasons).toEqual(["provider-content-in-portable"]);
    });
    it("names the rule and never keeps the matched text", () => {
      const e = run({ skills: [skill("a", { body: "Endpoint myacct-zz9.documents.azure.com" })] });
      expect(e.skills[0]).toMatchObject({ reasons: ["provider-content-in-portable"], rules: ["azure-cosmos-host"] });
      expect(JSON.stringify(e)).not.toContain("myacct-zz9");
    });
    it("accepts a declared requirement and refuses an undeclared one", () => {
      const s = skill("a", { body: "Use DefaultAzureCredential." });
      const declared = run({ skills: [s], selections: [select(s, { scope: "provider", requires: { credentials: ["azure-identity"] } })] });
      expect(one(declared, "a").reasons).toEqual(["needs-unavailable-tools"]);
      const missing = run({ skills: [s], selections: [select(s, { scope: "provider" })] });
      expect(one(missing, "a")).toMatchObject({ reasons: ["undeclared-requirement"], rules: ["azure-identity"] });
    });
    it("does not let another Azure service cover the detected one", () => {
      const s = skill("a", { body: "Endpoint x.documents.azure.com" });
      const wrong = run({ skills: [s], selections: [select(s, { scope: "provider", requires: { services: ["azure-storage"] } })] });
      expect(one(wrong, "a").reasons).toContain("undeclared-requirement");
      for (const ok of ["azure-cosmos-db", "azure-cosmos", "azure"]) {
        const right = run({ skills: [s], selections: [select(s, { scope: "provider", requires: { services: [ok] } })] });
        expect(one(right, "a").reasons, ok).not.toContain("undeclared-requirement");
      }
    });
    it("does not scan a skill without a current selection", () => {
      expect(one(run({ skills: [skill("a", { body: "az login" })], selections: [] }), "a").reasons).toEqual(["not-selected"]);
    });
  });

  describe("metadata", () => {
    it("adds product, SDK, category and capabilities to a copy", () => {
      const s = skill("a", { yaml: "capabilities: [one]\ntechnologies:\n  azure-cosmos-db: '>=3'\n" });
      const sel = select(s, { product: { name: "azure-cosmos-db", version: ">=4" }, sdk: { name: "@azure/cosmos", language: "ts", version: "^4.0.0" }, category: "cloud", capabilities: ["two"] });
      const copy = applySelection(s, sel);
      expect(copy.package.capabilities).toEqual(["one", "two"]);
      expect(copy.package.category).toBe("cloud");
      expect(copy.provenance.technologies).toEqual([{ name: "azure-cosmos", version: "^4.0.0" }, { name: "azure-cosmos-db", version: ">=3" }]);
      expect(s.package.capabilities).toEqual(["one"]);
      expect(s.provenance.technologies).toEqual([{ name: "azure-cosmos-db", version: ">=3" }]);
      const v = one(run({ skills: [s], selections: [sel] }), "a");
      expect(v).toMatchObject({ capabilities: ["one", "two"], technologies: copy.provenance.technologies });
    });
    it("gives a technology the skill declares without a version the selection's", () => {
      const s = skill("a", { yaml: "technologies: [azure-cosmos-db]\n" });
      expect(applySelection(s, select(s, { product: { name: "azure-cosmos-db", version: ">=4" } })).provenance.technologies).toEqual([{ name: "azure-cosmos-db", version: ">=4" }]);
    });
  });

  describe("overlaps", () => {
    const cosmos = () => skill("cosmos", { yaml: "capabilities: [cql]\n" });
    it("reports a Cosmos DB skill sharing cql with built-in cassandra, which wins", () => {
      const s = cosmos();
      const e = run({
        skills: [s], selections: [select(s, { scope: "provider", capabilities: ["cql"] })], over: { source: source({ trust: "verified" }), registered: [registered("cassandra", ["cql"])] },
      });
      expect(e.collisions).toHaveLength(1);
      expect(e.collisions[0]).toMatchObject({ class: "capability-overlap", reason: "capability.shared", shared: ["cql"], skills: ["cassandra", s.package.id] });
      expect(e.exclusive).toEqual(["cql"]);
      const r = e.canonical.resolutions[0]!;
      expect(r.winner!.id).toBe("cassandra");
      expect(r.rejected[0]).toMatchObject({ code: "outranked", level: "trust-tier" });
      expect(one(e, "cosmos")).toMatchObject({ eligible: true, wins: [], collisions: [e.collisions[0]!.id] });
    });
    it("does not report an unchanged installed copy as a collision", () => {
      const s = cosmos();
      const copy = registered(s.package.id, ["cql"], { digest: s.package.digest, version: s.package.version });
      const e = run({ skills: [s], over: { registered: [copy] } });
      expect(e.collisions).toEqual([]);
      expect(one(e, "cosmos").reasons).toEqual([]);
    });
    it("keeps the installed skill and its tier when its imported copy is unselected or stale", () => {
      const s = cosmos();
      const incumbent = { ...registered(s.package.id, ["cql"], { digest: s.package.digest, version: s.package.version }), source: "admin", trust: "approved" } as unknown as RegisteredSkill;
      const challenger = registered("other-cql", ["cql"]);
      const policy = { ...POLICY, exclusive: ["cql"] };
      const stale = select(s, { digest: "sha256:" + "0".repeat(64) });
      for (const selections of [[], [stale], [select(s)]]) {
        const e = run({ skills: [s], selections, over: { registered: [incumbent, challenger], policy } });
        expect(e.canonical.resolutions[0]!.winner!.id, JSON.stringify(selections.length)).toBe(s.package.id);
      }
    });
    it("ignores an inactive registered skill and never lets a mismatching one win", () => {
      const s = cosmos();
      const sel = [select(s, { capabilities: ["cql"] })];
      expect(run({ skills: [s], selections: sel, over: { registered: [registered("cassandra", ["cql"], { active: false })] } }).collisions).toEqual([]);
      const bad = run({ skills: [s], selections: sel, over: { registered: [registered("cassandra", ["cql"], { pin: "mismatch" })] } });
      expect(bad.canonical.resolutions[0]!.winner!.id).toBe(s.package.id);
    });
  });

  describe("provider rule", () => {
    const pair = () => {
      const p = skill("cosmos-cql", { yaml: "capabilities: [cql]\n" });
      const q = skill("cql-guide", { yaml: "capabilities: [cql, cql-basics]\n" });
      const selections = [select(p, { scope: "provider", capabilities: ["cql"] }), select(q)];
      return { p, q, selections };
    };
    it("takes out a provider skill that would win over a portable one", () => {
      const { p, q, selections } = pair();
      const e = run({ skills: [p, q], selections });
      expect(one(e, "cosmos-cql")).toMatchObject({ eligible: false, reasons: ["provider-without-policy"], wins: [] });
      expect(one(e, "cql-guide")).toMatchObject({ eligible: true, wins: ["cql"] });
    });
    it("lets a pin or an override name the provider skill", () => {
      const { p, q, selections } = pair();
      const id = p.package.id;
      for (const policy of [{ ...POLICY, pins: { cql: id } }, { ...POLICY, overrides: { cql: `${id}@${p.package.version}` } }]) {
        const e = run({ skills: [p, q], selections, over: { policy } });
        expect(one(e, "cosmos-cql")).toMatchObject({ eligible: true, wins: ["cql"] });
      }
    });
    it("is not helped by a pin for another capability", () => {
      const { p, q, selections } = pair();
      const e = run({ skills: [p, q], selections, over: { policy: { ...POLICY, pins: { other: p.package.id } } } });
      expect(one(e, "cosmos-cql").reasons).toEqual(["provider-without-policy"]);
    });
    it("takes the provider out against a portable registered skill too", () => {
      const p = skill("cosmos-cql", { yaml: "capabilities: [cql]\n" });
      const e = run({
        skills: [p], selections: [select(p, { scope: "provider" })],
        over: { source: source({ trust: "first-party" }), registered: [registered("generic-cql", ["cql", "cql-extra"], { provider: false })] },
      });
      expect(one(e, "cosmos-cql").reasons).toEqual(["provider-without-policy"]);
    });
  });

  describe("determinism", () => {
    const set = () => {
      const a = skill("alpha", { yaml: "capabilities: [cql]\n" });
      const b = skill("beta", { yaml: "capabilities: [cql, cql-basics]\n" });
      const c = skill("gamma", { body: "az login", yaml: "capabilities: [other]\n" });
      return {
        skills: [a, b, c],
        selections: [select(a, { scope: "provider" }), select(b), select(c)],
        registered: [registered("cassandra", ["cql"]), registered("oracle", ["sql"])],
      };
    };
    it("gives the same result for every order", () => {
      const { skills, selections, registered: reg } = set();
      const base = run({ skills, selections, over: { registered: reg } });
      for (const sk of permutations(skills)) for (const se of permutations(selections)) for (const rg of permutations(reg))
        expect(run({ skills: sk, selections: se, over: { registered: rg } })).toEqual(base);
    });
    it("never changes its input", () => {
      const { skills, selections, registered: reg } = set();
      const input: SourceSkillsInput = {
        source: source(), skills, selections, licences: { "skills/alpha": "allowed", "skills/beta": "allowed", "skills/gamma": "allowed" }, blocked: [], registered: reg,
        policy: { exclusive: ["cql"], highRisk: [], pins: { cql: "cassandra" } },
      };
      const before = structuredClone(input);
      deepFreeze(input);
      evaluateSourceSkills(input);
      expect(input).toEqual(before);
    });
    it("rejects too many candidates, a duplicate selection and a skill of another source", () => {
      const s = skill("a");
      const many = Array.from({ length: COLLISION_LIMITS.candidates + 1 }, () => s);
      expect(() => run({ skills: many, selections: [] })).toThrow(RangeError);
      expect(() => run({ skills: [s], selections: [select(s), select(s)] })).toThrow(TypeError);
      const other = normalizeSkill({ ...ORIGIN, source: "else" }, { root: "x", files: [md("a")] });
      if (!other.ok) throw new Error("bad");
      expect(() => run({ skills: [other.skill], selections: [] })).toThrow(TypeError);
    });
  });

  it("is re-exported from source-evaluation.js", () => {
    expect(sourceEvaluation.evaluateSourceSkills).toBe(evaluateSourceSkills);
  });
});
