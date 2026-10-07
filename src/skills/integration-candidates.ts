/**
 * Interface and database candidates (REST/OpenAPI, Kafka, IBM MQ, Cassandra, Oracle) from the evidence in a
 * repository profile. Pure and read-only: it uses only finding kind, name, path and detector, never a finding's
 * value, so no version, endpoint or credential can reach a candidate. Configuration files are named, never read.
 */
import { z } from "zod";
import type { RepoFinding, RepoProfile } from "./repo-profile.js";
import {
  DOC_SEGMENTS, FILE_RULES, INTEGRATION_CAPABILITIES, INTEGRATION_CATEGORY, INTEGRATION_SCORING as S, PACKAGE_RULES,
  type Ecosystem, type IntegrationCapability,
} from "./integration-rules.js";
import { relativePathProblem, SKILL_ID_RE } from "./schema.js";

export const CandidateEvidenceSchema = z
  .object({
    kind: z.enum(["dependency", "import", "schema"]),
    name: z.string().min(1).max(120),
    path: z.string().min(1).max(200),
    detector: z.string().regex(SKILL_ID_RE),
    count: z.number().int().positive().optional(),
    documentation: z.literal(true).optional(),
  })
  .strict();

export const IntegrationCandidateSchema = z
  .object({
    capability: z.enum(INTEGRATION_CAPABILITIES),
    category: z.enum(["interface", "database"]),
    score: z.number().int().min(0).max(100),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(CandidateEvidenceSchema).min(1).max(S.evidence),
    evidenceMore: z.number().int().positive().optional(),
  })
  .strict();

export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;
export type IntegrationCandidate = z.infer<typeof IntegrationCandidateSchema>;
export interface IntegrationCandidateOptions {
  /** Repository-relative folders ("" is the root). Missing or empty means the whole repository. */
  affectedModules?: readonly string[];
}

const NAME_RE = /^@?[A-Za-z0-9._/:-]{1,120}$/;
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
/** `p` is `dir` or inside it ("web" does not contain "website"). */
const inside = (p: string, dir: string) => dir === "" || p === dir || p.startsWith(`${dir}/`);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function manifestEcosystem(path: string): Ecosystem | undefined {
  const b = baseOf(path);
  if (b === "package.json") return "npm";
  if (b === "go.mod") return "go";
  if (b === "Cargo.toml") return "rust";
  if (b === "pyproject.toml" || /^requirements[\w.-]*\.txt$/.test(b)) return "python";
  if (b === "pom.xml" || b === "build.gradle" || b === "build.gradle.kts") return "jvm";
  if (b === "Gemfile") return "ruby";
  return undefined;
}

/** Build systems (manifest finding names) whose child folders own their dependencies. Maven and Gradle inherit from parents. */
const OWNING: Partial<Record<Ecosystem, string[]>> = { npm: ["npm"], go: ["go"], rust: ["cargo"], python: ["python"], ruby: ["bundler"] };

function matches(pattern: string, name: string, eco: Ecosystem, cls: "dependency" | "import"): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (name === pattern) return true;
  if (eco === "go" && name.startsWith(`${pattern}/`)) return true;
  return eco === "jvm" && cls === "import" && name.startsWith(`${pattern}.`);
}

interface Hit { ev: CandidateEvidence; cls: "dependency" | "import" | "schema"; weight: number }

/** Pure. Throws Error("invalid module path") for a module that is not "" and fails relativePathProblem. */
export function detectIntegrationCandidates(profile: RepoProfile, opts: IntegrationCandidateOptions = {}): IntegrationCandidate[] {
  const modules: string[] = [];
  for (const raw of opts.affectedModules ?? []) {
    const m = raw === "." ? "" : raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (m !== "" && (relativePathProblem(m) || /[\u0000-\u001f\u007f]/.test(m))) throw new Error("invalid module path");
    modules.push(m);
  }

  const manifests = profile.findings.filter((f) => f.kind === "manifest" && f.value === undefined);
  const owned = (depPath: string, eco: Ecosystem, mod: string): boolean => {
    const mdir = dirOf(depPath);
    if (inside(mdir, mod)) return true; // the manifest is in the module
    if (!inside(mod, mdir)) return false; // neither way: unrelated
    const systems = OWNING[eco];
    if (!systems) return true; // inherited from parent
    // A nearer manifest of the same build system between the module and this manifest owns the module's dependencies.
    return !manifests.some((m) => systems.includes(m.name) && dirOf(m.path) !== mdir && inside(dirOf(m.path), mdir) && inside(mod, dirOf(m.path)));
  };

  const hits = new Map<IntegrationCapability, Hit[]>();
  const add = (cap: IntegrationCapability, h: Hit) => {
    const l = hits.get(cap) ?? [];
    l.push(h);
    hits.set(cap, l);
  };

  for (const f of profile.findings as RepoFinding[]) {
    if (f.kind !== "dependency" && f.kind !== "import" && f.kind !== "schema") continue;
    if (!NAME_RE.test(f.name) || f.name.includes("//")) continue;
    if (relativePathProblem(f.path) || /[\u0000-\u001f\u007f]/.test(f.path)) continue;

    let eco: Ecosystem | undefined;
    if (f.kind === "dependency") eco = manifestEcosystem(f.path);
    else if (f.kind === "import") eco = f.value as Ecosystem | undefined;
    if (f.kind !== "schema" && !eco) continue;

    if (modules.length > 0) {
      const ok = modules.some((m) => (f.kind === "dependency" ? owned(f.path, eco!, m) : inside(dirOf(f.path), m)));
      if (!ok) continue;
    }

    const doc = f.path.split("/").some((s) => DOC_SEGMENTS.has(s.toLowerCase()));
    const ev: CandidateEvidence = { kind: f.kind, name: f.name, path: f.path, detector: f.detector };
    if (f.count !== undefined) ev.count = f.count;
    if (doc) ev.documentation = true;
    const factor = doc ? S.docsFactor : 1;

    if (f.kind === "schema") {
      for (const r of FILE_RULES) if (r.schema === f.name) add(r.capability, { ev, cls: "schema", weight: r.weight * factor });
      continue;
    }
    let name = f.name.toLowerCase();
    if (eco === "python" || eco === "rust") name = name.replace(/[_.]+/g, "-");
    for (const r of PACKAGE_RULES) {
      if (r.ecosystem !== eco || (r.on !== "both" && r.on !== f.kind) || !matches(r.pattern, name, eco!, f.kind)) continue;
      add(r.capability, { ev, cls: f.kind, weight: (r.weak ? S.weak : S.strong) * factor });
    }
  }

  const out: IntegrationCandidate[] = [];
  for (const cap of INTEGRATION_CAPABILITIES) {
    const list = hits.get(cap);
    if (!list?.length) continue;
    const best = (cls: Hit["cls"]) => Math.max(0, ...list.filter((h) => h.cls === cls).map((h) => h.weight));
    let score = Math.min(100, best("dependency") + best("import") + best("schema"));
    if (list.every((h) => h.ev.documentation)) score = Math.min(score, S.docsOnlyCap);
    score = Math.round(score);
    list.sort(
      (a, b) =>
        Number(!!a.ev.documentation) - Number(!!b.ev.documentation) || b.weight - a.weight ||
        a.ev.path.split("/").length - b.ev.path.split("/").length || cmp(a.ev.path, b.ev.path) || cmp(a.ev.name, b.ev.name),
    );
    const evidence = list.slice(0, S.evidence).map((h) => h.ev);
    const c: IntegrationCandidate = {
      capability: cap,
      category: INTEGRATION_CATEGORY[cap],
      score,
      confidence: score >= S.high ? "high" : score >= S.medium ? "medium" : "low",
      evidence,
    };
    if (list.length > evidence.length) c.evidenceMore = list.length - evidence.length;
    out.push(c);
  }
  const order = (c: IntegrationCandidate) => INTEGRATION_CAPABILITIES.indexOf(c.capability);
  return out.sort((a, b) => b.score - a.score || order(a) - order(b));
}
