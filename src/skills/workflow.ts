// The workflow gate for skills of a connector profile (#216). Pure: no file system, no process, no clock, and nothing
// here runs or rewrites the content it reads. Called by `scf skills assess` (cli.ts). The rules and the profile are
// in workflow-rules.ts.
//
// The declaration of the profile is the ceiling. Upstream metadata or text that asks for more excludes the skill; it
// never raises the declaration. Nothing is adapted, merged or promoted here. A later promotion step calls
// `workflowBlockers` next to `promotionBlockers`, and `declaredPackage` and `workflowProvenance` for a candidate.
import { byteCmp } from "./import-plan.js";
import type { NormalizedSkill } from "./normalize.js";
import { RESOLVE_DEFAULTS } from "./resolve-rules.js";
import type { FlowSkillMode, SkillPackage, SkillRisk, SkillRole, SkillToolProfile } from "./schema.js";
import { shownValue } from "./sources.js";
import { skillNeeds, type FlowSkillStep, type ToolNeed } from "./tool-policy.js";
import {
  CONNECTOR_PROFILES, WORKFLOW_EFFECT, WORKFLOW_LIMITS, WORKFLOW_RULES,
  type ConnectorProfile, type WorkflowCode, type WorkflowDeclaration, type WorkflowEffect, type WorkflowRule,
} from "./workflow-rules.js";

/** The bytes of the SKILL.md a skill was normalized from. */
export type SkillSource = (skill: NormalizedSkill) => Uint8Array | undefined;
export interface WorkflowFlow { name: string; skills: FlowSkillMode; steps: readonly FlowSkillStep[] }
export interface WorkflowFinding { code: WorkflowCode; effect: WorkflowEffect; rule?: string; path: string; line?: number; evidence: string }
export interface SkillWorkflow {
  schema: 1;
  profile: string;
  tools: SkillToolProfile;
  requiredTools: ToolNeed[];
  roles: SkillRole[];
  capability: string;
  /** The compatible built-in flows. */
  flows: string[];
  context: { instructions: number; max: number; payloadMax: number };
}
export interface WorkflowAssessment {
  root: string;
  id: string;
  name: string;
  digest: string;
  status: "candidate" | "excluded";
  /** Every distinct exclude code, sorted. Computed before the findings are cut. */
  blockers: WorkflowCode[];
  declaration?: SkillWorkflow;
  /** For display: exclude first, then path, line, rule; at most WORKFLOW_LIMITS.findings. */
  findings: WorkflowFinding[];
  /** Findings past the limit. */
  omitted: number;
}
export interface WorkflowReport { schema: 1; profile: string; skills: WorkflowAssessment[] }

const STRICT = new TextDecoder("utf-8", { fatal: true });
const RISK_RANK: Record<SkillRisk, number> = { low: 0, medium: 1, high: 2 };
const GLOBAL_RULES: readonly (WorkflowRule & { global: RegExp })[] = WORKFLOW_RULES.map((r) => ({ ...r, global: new RegExp(r.re.source, r.re.flags.replace("g", "") + "g") }));

export function connectorProfile(repositoryKey: string): ConnectorProfile | undefined {
  return CONNECTOR_PROFILES.find((p) => p.repositoryKey === repositoryKey);
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return STRICT.decode(bytes);
  } catch {
    return undefined;
  }
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

const needsOf = (tools: WorkflowDeclaration["tools"]): ToolNeed[] =>
  skillNeeds({ tool_profile: { shell: tools.shell, network: tools.network, filesystem: tools.filesystem }, connectors: [], dependencies: [] });

function finding(code: WorkflowCode, path: string, evidence: string, extra: { rule?: string; line?: number } = {}): WorkflowFinding {
  const f: WorkflowFinding = { code, effect: WORKFLOW_EFFECT[code], path: shownValue(path), evidence: shownValue(evidence) };
  if (extra.rule !== undefined) f.rule = extra.rule;
  if (extra.line !== undefined) f.line = extra.line;
  return f;
}

/** The text rules over one text. A repeated match of one rule in one path is one finding, at its smallest line. */
function scanText(path: string, text: string, decl: WorkflowDeclaration, out: Map<string, WorkflowFinding>): void {
  // A mention that ends where a requirement ends is the same place: it is reported once, as the requirement.
  const required = new Set<number>();
  for (const rule of GLOBAL_RULES) {
    if (rule.needs && (rule.needs === "write" ? decl.tools.filesystem === "write" : decl.tools[rule.needs])) continue;
    const re = rule.global;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      const end = m.index + m[0].length;
      if (rule.code === "requires-skill") required.add(end);
      if (rule.code === "mentions-skill" && required.has(end)) continue;
      const matched = m[0].trim();
      const key = `${rule.id}\0${path}\0${matched}`;
      const line = lineOf(text, m.index);
      const old = out.get(key);
      if (old) {
        if (old.line === undefined || line < old.line) old.line = line;
        continue;
      }
      const shown = shownValue(matched);
      const evidence = `${rule.says}: ${shown}`.slice(0, WORKFLOW_LIMITS.evidenceChars);
      out.set(key, finding(rule.code, path, evidence, { rule: rule.id, line }));
    }
  }
}

function flowReason(flow: WorkflowFlow, decl: WorkflowDeclaration): string | undefined {
  if (flow.skills === "off") return "the flow has skills off";
  if (!decl.roles.includes("coder")) return `no step loads skills for role ${decl.roles.join(",")}`;
  const steps = flow.steps.filter((s) => s.mode === "selected" && s.role === "coder");
  if (steps.length === 0) return "no step loads selected skills for role coder";
  // One step must give every declared tool: the session tool gate looks at the step that receives the skill.
  const wanted: { has: (s: FlowSkillStep) => boolean; text: string }[] = [];
  if (decl.tools.shell) wanted.push({ has: (s) => s.capabilities.shell, text: "a shell" });
  if (decl.tools.network) wanted.push({ has: (s) => s.capabilities.network, text: "network access" });
  if (decl.tools.filesystem === "write") wanted.push({ has: (s) => s.capabilities.filesystem === "write", text: "write access" });
  if (!steps.some((s) => wanted.every((w) => w.has(s)))) return `no receiving step gives ${wanted.map((w) => w.text).join(" and ")}`;
  return undefined;
}

function assessOne(profile: ConnectorProfile, skill: NormalizedSkill, flows: readonly WorkflowFlow[], skillMd?: SkillSource): WorkflowAssessment {
  const { package: pkg, provenance: prov } = skill;
  if (prov.repositoryKey !== profile.repositoryKey) throw new TypeError(`skill ${shownValue(prov.name)} is not from ${profile.repositoryKey}`);
  const base = { root: prov.root, id: pkg.id, name: prov.name, digest: pkg.digest };
  const decl = Object.hasOwn(profile.skills, prov.name) ? profile.skills[prov.name] : undefined;
  if (!decl) {
    return { ...base, status: "excluded", blockers: ["not-selected"], findings: [finding("not-selected", "SKILL.md", "The skill is not in the profile")], omitted: 0 };
  }

  const found = new Map<string, WorkflowFinding>();
  // The whole document, so a line number is a line of the file. Without the source, the description and the instructions are scanned
  // (their lines are then counted from the start of each text).
  const source = skillMd?.(skill);
  const doc = source === undefined ? undefined : decodeText(source);
  if (doc !== undefined) scanText("SKILL.md", doc, decl, found);
  else {
    scanText("SKILL.md", pkg.description, decl, found);
    scanText("SKILL.md", pkg.instructions, decl, found);
  }
  const files = [...Object.values(pkg.files).flat(), ...skill.extraFiles];
  for (const f of files) {
    const text = decodeText(f.content);
    if (text !== undefined) scanText(f.path, text, decl, found);
  }
  const list: WorkflowFinding[] = [...found.values()];

  const grant = (why: string) => list.push(finding("grants-tools", "SKILL.md", why));
  if (prov.requiredTools.length > 0) grant(`Asks for tools: ${prov.requiredTools.join(", ")}`);
  // A declared dependency is a required skill: the package would carry it into a run.
  if (pkg.dependencies.length > 0 || prov.dependencies.length > 0) {
    const names = [...new Set([...prov.dependencies.map((d) => d.name), ...pkg.dependencies.map((d) => d.id)])];
    list.push(finding("requires-skill", "SKILL.md", `Declares dependencies: ${names.join(", ")}`));
  }
  if (pkg.connectors.length > 0) grant(`Asks for connectors: ${pkg.connectors.join(", ")}`);
  if (pkg.allowedTools !== undefined) grant("Sets allowed-tools");
  if (prov.entryPoints.scripts.length > 0 && !decl.tools.shell) grant("Has scripts and the declaration has no shell");
  for (const k of Object.keys(prov.upstream)) {
    if (k.startsWith("manifest.tool_profile") || k.startsWith("manifest.connectors")) grant(`Sets ${k}`);
  }
  if (skill.extraFiles.length > 0) list.push(finding("extra-files", "SKILL.md", `${skill.extraFiles.length} files are not part of the package`));

  const max = decl.maxTokens;
  const limit = Math.min(max, RESOLVE_DEFAULTS.maxSkillTokens);
  if (prov.context.instructions > limit) list.push(finding("context-over-budget", "SKILL.md", `${prov.context.instructions} tokens, limit ${limit}`));

  const compatible: string[] = [];
  for (const name of decl.flows) {
    const flow = flows.find((f) => f.name === name);
    if (!flow) {
      list.push(finding("flow-unknown", `flow:${name}`, "The declared flow does not exist"));
      continue;
    }
    const why = flowReason(flow, decl);
    if (why) list.push(finding("flow-incompatible", `flow:${name}`, why));
    else compatible.push(name);
  }
  if (compatible.length === 0) list.push(finding("no-compatible-flow", "SKILL.md", "No declared flow has a step that receives this skill"));

  const blockers = [...new Set(list.filter((f) => f.effect === "exclude").map((f) => f.code))].sort(byteCmp);
  list.sort((a, b) =>
    Number(b.effect === "exclude") - Number(a.effect === "exclude") || byteCmp(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || byteCmp(a.rule ?? a.code, b.rule ?? b.code));
  const shown = list.slice(0, WORKFLOW_LIMITS.findings);

  const declaration: SkillWorkflow = {
    schema: 1,
    profile: profile.id,
    tools: { shell: decl.tools.shell, network: decl.tools.network, filesystem: decl.tools.filesystem },
    requiredTools: needsOf(decl.tools),
    roles: [...decl.roles],
    capability: decl.capability,
    flows: compatible.sort(byteCmp),
    context: { instructions: prov.context.instructions, max, payloadMax: max + WORKFLOW_LIMITS.wrapperTokens },
  };
  return { ...base, status: blockers.length === 0 ? "candidate" : "excluded", blockers, declaration, findings: shown, omitted: list.length - shown.length };
}

/** Each skill is assessed on its own; nothing is shared between skills. */
export function assessWorkflows(input: { profile: ConnectorProfile; skills: readonly NormalizedSkill[]; flows: readonly WorkflowFlow[]; skillMd?: SkillSource }): WorkflowReport {
  const skills = input.skills.map((s) => assessOne(input.profile, s, input.flows, input.skillMd)).sort((a, b) => byteCmp(a.id, b.id) || byteCmp(a.root, b.root));
  return { schema: 1, profile: input.profile.id, skills };
}

export function workflowBlockers(a: WorkflowAssessment): WorkflowCode[] {
  return [...a.blockers];
}

/** The declaration of a candidate, after proof that the assessment is of this very skill. */
function bound(skill: NormalizedSkill, a: WorkflowAssessment): SkillWorkflow {
  if (a.status !== "candidate" || a.blockers.length > 0 || !a.declaration) throw new TypeError("the skill is not a workflow candidate");
  if (a.root !== skill.provenance.root || a.id !== skill.package.id || a.name !== skill.provenance.name || a.digest !== skill.package.digest) {
    throw new TypeError("the assessment is not of this skill");
  }
  return a.declaration;
}

/** The provenance entry for a promoted skill. */
export function workflowProvenance(skill: NormalizedSkill, a: WorkflowAssessment): SkillWorkflow {
  const d = bound(skill, a);
  return { ...d, tools: { ...d.tools }, requiredTools: [...d.requiredTools], roles: [...d.roles], flows: [...d.flows], context: { ...d.context } };
}

/** The package with exactly the declared tools and roles; upstream tool metadata is dropped. */
export function declaredPackage(skill: NormalizedSkill, a: WorkflowAssessment): SkillPackage {
  const d = bound(skill, a);
  const { allowedTools: _dropped, ...rest } = skill.package;
  const risk: SkillRisk = d.tools.shell && RISK_RANK[rest.risk] < RISK_RANK.medium ? "medium" : rest.risk;
  return {
    ...rest,
    tool_profile: { ...d.tools },
    connectors: [],
    roles: [...d.roles],
    capabilities: [...new Set([...rest.capabilities, d.capability])].sort(byteCmp),
    risk,
  };
}
