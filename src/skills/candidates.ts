/**
 * Language and platform skill candidates (Java, Spring Boot, TypeScript, Node.js) from a repository profile.
 *
 * Pure and bounded: reads only the profile, touches no file, process or network. Every candidate rests on
 * findings with concrete paths; task text is only matched against fixed patterns and never reaches the output.
 * A technology is scored per module (a folder with a package.json, pom.xml or Gradle file, plus the repository
 * root), so a mono-repository does not select every technology: a module needs evidence of its own.
 */
import { z } from "zod";
import {
  CANDIDATE_LIMITS, CANDIDATE_SKILLS, CONFIDENCES, confidenceOf, KEYWORD_WEIGHT, SIGNAL_STRENGTHS, SKILL_RULES,
  type SignalRule, type SkillRule,
} from "./candidate-rules.js";
import { RepoProfileSchema, type RepoFinding, type RepoProfile } from "./repo-profile.js";
import { relativePathProblem, SKILL_ID_RE } from "./schema.js";

export const CandidateEvidenceSchema = z
  .object({
    signal: z.string().regex(SKILL_ID_RE),
    strength: z.enum(SIGNAL_STRENGTHS),
    weight: z.number().int().positive(),
    path: z.string().min(1).max(200),
    /** Module the evidence comes from ("" = repository root); it can be an ancestor of the module it counts for. */
    module: z.string().max(200),
    name: z.string().min(1).max(120),
    reason: z.string().min(1).max(160),
  })
  .strict();

export const SkillCandidateSchema = z
  .object({
    skill: z.enum(CANDIDATE_SKILLS),
    category: z.enum(["language", "platform"]),
    score: z.number().int().min(1).max(100),
    confidence: z.enum(CONFIDENCES),
    /** Fixed label from the rule, never task text. */
    keyword: z.string().max(40).optional(),
    modules: z.array(z.object({ path: z.string().max(200), score: z.number().int().min(1).max(100) }).strict()).min(1).max(CANDIDATE_LIMITS.modules),
    evidence: z.array(CandidateEvidenceSchema).min(1).max(CANDIDATE_LIMITS.evidence),
  })
  .strict();

export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;
export type SkillCandidate = z.infer<typeof SkillCandidateSchema>;

export interface CandidateOptions {
  task?: string;
  /** Repository-relative files or folders the work touches. Absent or empty: the whole repository. */
  affectedPaths?: readonly string[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const MODULE_FILE = /^(?:package\.json|pom\.xml|build\.gradle(?:\.kts)?)$/;
const MODULE_MANIFEST = /^(?:package\.json|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Module roots of a profile: "" plus the folder of every package.json, pom.xml or Gradle file (named by a manifest or dependency finding), sorted. */
export function moduleRoots(profile: RepoProfile): string[] {
  const roots = new Set<string>([""]);
  for (const f of profile.findings) {
    if (f.kind === "manifest" && f.value !== "lockfile" && MODULE_MANIFEST.test(baseOf(f.path))) roots.add(dirOf(f.path));
    else if (f.kind === "dependency" && MODULE_FILE.test(baseOf(f.path))) roots.add(dirOf(f.path)); // survives a dropped manifest finding
  }
  return [...roots].sort(cmp);
}

/** True when folder `a` is `b` or contains it (whole path segments). */
const isAncestor = (a: string, b: string) => a === "" || a === b || b.startsWith(`${a}/`);

/** The longest module root that contains `path`. */
function moduleOf(roots: readonly string[], path: string): string {
  let best = "";
  for (const r of roots) if (r.length > best.length && isAncestor(r, path)) best = r;
  return best;
}

/** undefined: whole repository. [] : nothing valid was given, so nothing is in scope. */
function relevantModules(roots: readonly string[], affected: readonly string[] | undefined): Set<string> | undefined {
  if (!affected || affected.length === 0) return undefined;
  const valid: string[] = [];
  for (const raw of affected.slice(0, CANDIDATE_LIMITS.affectedPaths)) {
    if (typeof raw !== "string" || raw.length > CANDIDATE_LIMITS.pathChars + 1) continue;
    const p = raw.replace(/\/$/, "");
    if (relativePathProblem(p) === undefined && !CONTROL.test(p)) valid.push(p);
  }
  const out = new Set<string>();
  for (const p of valid) {
    out.add(moduleOf(roots, p));
    for (const r of roots) if (r !== "" && isAncestor(p, r)) out.add(r);
  }
  return out;
}

interface Hit { rule: SignalRule; finding: RepoFinding; module: string; own: boolean }

export function detectSkillCandidates(profile: RepoProfile, opts: CandidateOptions = {}): SkillCandidate[] {
  const prof = RepoProfileSchema.parse(profile);
  const roots = moduleRoots(prof);
  const relevant = relevantModules(roots, opts.affectedPaths);
  if (relevant && relevant.size === 0) return [];

  // When the manifest findings may have been cut, source findings that only the root claims are uncertain.
  const manifests = prof.findings.filter((f) => f.kind === "manifest").length;
  const onlyEarlyKinds = prof.findings.every((f) => f.kind === "language" || f.kind === "manifest");
  const uncertain = prof.truncated.findings && (manifests >= prof.limits.findings.manifest || onlyEarlyKinds);

  const located = prof.findings
    .map((finding) => ({ finding, module: moduleOf(roots, dirOf(finding.path)) }))
    .filter(({ finding, module }) => !(uncertain && module === "" && dirOf(finding.path) !== "" && (finding.kind === "language" || finding.kind === "import")));
  const scoped = [...roots].filter((r) => !relevant || relevant.has(r));

  const task = (opts.task ?? "").slice(0, CANDIDATE_LIMITS.taskChars);
  const out: SkillCandidate[] = [];
  for (const rule of SKILL_RULES) {
    const keyword = rule.keyword.test(task);
    const scored = scoreModules(rule, scoped, located, keyword);
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.score - a.score || cmp(a.module, b.module));
    const shown = scored.slice(0, CANDIDATE_LIMITS.modules);
    const seen = new Set<string>();
    const evidence: CandidateEvidence[] = [];
    // The best module's own signals come first, so the evidence always supports the advertised score.
    for (const m of shown) {
      for (const h of m.hits) {
        const key = `${h.rule.signal}\0${h.finding.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({
          signal: h.rule.signal, strength: h.rule.strength, weight: h.rule.weight, path: h.finding.path,
          module: h.module, name: h.finding.name, reason: h.rule.reason,
        });
      }
    }
    const top = evidence.slice(0, scored[0]!.hits.length);
    const rest = evidence.slice(top.length).sort((a, b) => b.weight - a.weight || cmp(a.path, b.path) || cmp(a.signal, b.signal));
    const kept = [...top, ...rest].slice(0, CANDIDATE_LIMITS.evidence).sort((a, b) => b.weight - a.weight || cmp(a.path, b.path) || cmp(a.signal, b.signal));
    const score = scored[0]!.score;
    out.push({
      skill: rule.skill, category: rule.category, score, confidence: confidenceOf(score),
      ...(keyword ? { keyword: rule.keywordLabel } : {}),
      modules: shown.map((m) => ({ path: m.module, score: m.score })),
      evidence: kept,
    });
  }
  out.sort((a, b) => b.score - a.score || cmp(a.skill, b.skill));
  return out.map((c) => SkillCandidateSchema.parse(c));
}

function scoreModules(
  rule: SkillRule,
  modules: readonly string[],
  located: readonly { finding: RepoFinding; module: string }[],
  keyword: boolean,
): { module: string; score: number; hits: Hit[] }[] {
  const result: { module: string; score: number; hits: Hit[] }[] = [];
  for (const m of modules) {
    const hits: Hit[] = [];
    for (const sig of rule.signals) {
      if (sig.needsOwnLanguage && !located.some((l) => l.module === m && l.finding.kind === "language" && l.finding.name === sig.needsOwnLanguage)) continue;
      let best: Hit | undefined;
      for (const l of located) {
        if (!isAncestor(l.module, m) || !sig.matches(l.finding)) continue;
        const h: Hit = { rule: sig, finding: l.finding, module: l.module, own: l.module === m };
        if (!best || rank(h) < rank(best) || (rank(h) === rank(best) && cmp(h.finding.path, best.finding.path) < 0)) best = h;
      }
      if (best) hits.push(best);
    }
    if (!hits.some((h) => h.own)) continue;
    const base = hits.reduce((n, h) => n + h.rule.weight, 0);
    if (base <= 0) continue;
    hits.sort((a, b) => b.rule.weight - a.rule.weight || cmp(a.finding.path, b.finding.path) || cmp(a.rule.signal, b.rule.signal));
    result.push({ module: m, score: Math.min(100, base + (keyword ? KEYWORD_WEIGHT : 0)), hits });
  }
  return result;
}

/** Lower is better: own hits first, then the deepest module. */
const rank = (h: Hit) => (h.own ? 0 : 1) * 1000 - h.module.length;
