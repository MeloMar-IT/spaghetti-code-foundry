import { basename, extname } from "node:path";
import { dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import { MAX_FLOW_DEPTH } from "../engine/execute.js";
import { isShippedFlow } from "../engine/guards.js";
import { loadPolicyPacks, repositoryFact, type LoadedPack } from "../engine/policy-hooks.js";
import type { Flow } from "../flow/schema.js";
import { loadFlow } from "../flow/load.js";
import { contextSelectorInput } from "../context/settings.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../policy/baseline.js";
import { layeredPackIds } from "../policy/compose.js";
import { policyPackSha256 } from "../policy/evaluate.js";
import { declaredToolProfile, snapshotToolProfile } from "../tool-profile/session.js";
import { toolProfileSha256 } from "../tool-profile/resolve.js";
import { LEGACY_PROFILE_IDENTITY, legacyToolProfile } from "../tool-profile/legacy.js";
import { stepToolSettings } from "../agents/tool-gate.js";
import { CONTEXT_SELECTOR_ID, contextSelectorSha256, flowSha256, flowVersion, isCounted, lookupVersions, MODEL_ROUTES_ID, modelRoutesSha256, type ComponentKind, type ComponentRef } from "./components.js";
import { decideGovernance, governanceCheckFailed, readGovernanceBook, type GovernanceDecision, type GovernedComponent } from "./governance.js";
import { componentBlock, suiteVerdict, type PromoteCode, type SuiteVerdict } from "./promote.js";
import { REQUIRED_SUITES, SUITE_REMEDIATION } from "./required-suites.js";
import { readVersionBook } from "./versions.js";

/**
 * The run start check (#740): the components a run uses, each checked with the rule of `scf promote` (suiteVerdict and
 * componentBlock). Never throws. Messages hold kinds, ids, versions, suite names and fixed codes, never a path.
 */

export interface PromotionFinding {
  kind: ComponentKind;
  /** Sanitized for display (see displayId). */
  id: string;
  version: string;
  code: PromoteCode;
  suite?: string;
  remediation: string;
}

export interface PromotionRecord {
  enforce: "warn" | "on";
  promoted: boolean;
  components: ComponentRef[];
  findings: PromotionFinding[];
}

export interface GateInput {
  flow: Flow;
  /** The id the custom flow would have under `scf promote` (its file name). */
  flowId: string;
  repo: string;
  vars: Record<string, string>;
  config: Config;
  toolProfile?: unknown;
  /** The packs the run read at its start; when given, exactly these are checked and no file is read again. */
  policyPacks?: readonly LoadedPack[];
}

export interface GateOptions {
  home?: string;
  evalsDir?: string;
  safetyDir?: string;
}

/** A flow name can hold any text: only these characters are shown. */
export function displayId(raw: string): string {
  const text = String(raw).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return text === "" ? "(unnamed)" : text;
}

/** A ref with the id to match on; `show` is the id to print and save. */
export interface Ref extends ComponentRef {
  show: string;
}

const finding = (kind: ComponentKind, id: string, version: string, code: PromoteCode, remediation: string, suite?: string): PromotionFinding => ({
  kind,
  id,
  version,
  code,
  ...(suite ? { suite } : {}),
  remediation,
});

const fixComponent = (kind: ComponentKind) => `scf components ${kind}`;

/** A component that could not be loaded: its raw id (for a governance record) and the id to show. */
export interface UnloadedComponent {
  kind: ComponentKind;
  id: string;
  show: string;
}

/** The flow and every flow its `type: flow` steps reach, breadth first, so a flow is reached at its shallowest depth. */
function flowRefs(input: GateInput, everything: boolean): { refs: Ref[]; problems: PromotionFinding[]; unloaded: UnloadedComponent[]; flows: Flow[] } {
  const refs: Ref[] = [];
  const problems: PromotionFinding[] = [];
  const unloaded: UnloadedComponent[] = [];
  const flows: Flow[] = [];
  const add = (flow: Flow, id: string) => {
    flows.push(flow);
    if (!everything && isShippedFlow(flow)) return; // an unchanged built-in flow needs no record (but governance may have one)
    refs.push({ kind: "flow", id, show: displayId(id), version: flowVersion(flow), sha256: flowSha256(flow) });
  };
  add(input.flow, input.flowId);
  const seen = new Set<string>();
  let level: Flow[] = [input.flow];
  for (let depth = 0; depth < MAX_FLOW_DEPTH && level.length; depth++) {
    const next: Flow[] = [];
    for (const flow of level) {
      for (const step of flow.steps) {
        if (step.type !== "flow") continue;
        try {
          const child = loadFlow(step.flow, input.repo);
          if (seen.has(child.path)) continue;
          seen.add(child.path);
          add(child.flow, basename(child.path, extname(child.path)));
          next.push(child.flow);
        } catch {
          problems.push(finding("flow", displayId(step.flow), "-", "not-found", fixComponent("flow")));
          unloaded.push({ kind: "flow", id: step.flow, show: displayId(step.flow) });
        }
      }
    }
    level = next;
  }
  return { refs, problems, unloaded, flows };
}

/**
 * The generated tool profile of each agent step of the flows (#665), for a run without a declared profile: the profile the
 * step's settings give it. It is built without the run's `boxed` and `isolated` facts, so its hash can differ from the one
 * the run records; the lifecycle of the record is exact either way. Only top-level steps are read.
 */
function generatedProfiles(input: GateInput, flows: readonly Flow[]): { refs: Ref[]; unloaded: UnloadedComponent[] } {
  const id = LEGACY_PROFILE_IDENTITY.id;
  const refs: Ref[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (const flow of flows) {
    for (const step of flow.steps) {
      if (step.type !== "claude") continue;
      try {
        const settings = stepToolSettings(step, { flow }, { config: input.config }, { boxed: false, isolated: false });
        const sha256 = toolProfileSha256(legacyToolProfile(settings).profile);
        if (!seen.has(sha256)) {
          seen.add(sha256);
          refs.push({ kind: "tool-profile", id, show: id, version: "-", sha256 });
        }
      } catch {
        failed = true;
      }
    }
  }
  return { refs, unloaded: failed ? [{ kind: "tool-profile", id, show: id }] : [] };
}

/**
 * Every component of the run: refs to check, the ones that could not be built (`problems`, display ids only) and the same
 * ones with their raw ids (`unloaded`). With `everything` the unchanged built-in flows, the baseline and the context selector
 * are listed too (the governance check); the promotion check does not pass it.
 */
export function runComponents(input: GateInput, o: GateOptions & { everything?: boolean } = {}): { refs: Ref[]; problems: PromotionFinding[]; unloaded: UnloadedComponent[] } {
  const home = o.home ?? dataHome();
  const everything = o.everything === true;
  const { refs, problems, unloaded, flows } = flowRefs(input, everything);

  const ids = layeredPackIds(input.config.policy, repositoryFact(input.vars)).map((p) => p.id).filter((id) => id !== BASELINE_POLICY_ID);
  const packs = input.policyPacks ? input.policyPacks.filter((p) => p.id !== BASELINE_POLICY_ID) : loadPolicyPacks(ids, home);
  for (const loaded of packs) {
    if ("problem" in loaded) {
      problems.push(finding("policy-pack", displayId(loaded.id), "-", "problem", fixComponent("policy-pack")));
      unloaded.push({ kind: "policy-pack", id: loaded.id, show: displayId(loaded.id) });
    } else refs.push({ kind: "policy-pack", id: loaded.id, show: displayId(loaded.id), version: loaded.pack.policy.version, sha256: policyPackSha256(loaded.pack) });
  }

  refs.push({ kind: "model-routes", id: MODEL_ROUTES_ID, show: MODEL_ROUTES_ID, version: "-", sha256: modelRoutesSha256(input.config.router) });

  if (input.toolProfile !== undefined) {
    const snapshot = snapshotToolProfile(input.toolProfile);
    if (snapshot === null) problems.push(finding("tool-profile", "(declared)", "-", "problem", fixComponent("tool-profile")));
    else {
      const profile = declaredToolProfile(snapshot);
      refs.push({ kind: "tool-profile", id: profile.profile.id, show: displayId(profile.profile.id), version: "-", sha256: toolProfileSha256(profile) });
    }
  }

  if (everything && input.toolProfile === undefined) {
    const generated = generatedProfiles(input, flows);
    refs.push(...generated.refs);
    unloaded.push(...generated.unloaded);
  }

  if (everything) {
    refs.push({ kind: "policy-pack", id: BASELINE_POLICY_ID, show: BASELINE_POLICY_ID, version: BASELINE_PACK.policy.version, sha256: policyPackSha256(BASELINE_PACK) });
    try {
      refs.push({ kind: "context-selector", id: CONTEXT_SELECTOR_ID, show: CONTEXT_SELECTOR_ID, version: "-", sha256: contextSelectorSha256(contextSelectorInput(input.config.context)) });
    } catch {
      unloaded.push({ kind: "context-selector", id: CONTEXT_SELECTOR_ID, show: CONTEXT_SELECTOR_ID });
    }
  }
  return { refs, problems, unloaded };
}

/**
 * The components of the run with their versions, for the governance check. A counted version is looked up in versions.json;
 * a version that is not recorded, or a book that cannot be read, leaves it unset. A component that could not be loaded
 * keeps its raw id and has no version. Never throws for a missing record.
 */
export function governedComponents(input: GateInput, o: GateOptions = {}): GovernedComponent[] {
  const home = o.home ?? dataHome();
  const { refs, unloaded } = runComponents(input, { ...o, home, everything: true });
  const book = refs.some((r) => isCounted(r.kind)) ? readVersionBook(home) : undefined;
  const out: GovernedComponent[] = [];
  for (const ref of refs) {
    let version: string | undefined = ref.version;
    if (isCounted(ref.kind)) {
      const v = book?.ok ? lookupVersions(book.book, [{ kind: ref.kind, id: ref.id, sha256: ref.sha256 }])[0] : undefined;
      version = v === undefined ? undefined : String(v);
    }
    out.push({ kind: ref.kind, id: ref.id, show: ref.show, ...(version !== undefined ? { version } : {}) });
  }
  for (const u of unloaded) out.push({ kind: u.kind, id: u.id, show: u.show });
  return out;
}

/** The governance check of a production run (#665): reads the book first, then the components. Never throws; a check that cannot run refuses. */
export function governanceGate(input: GateInput, o: GateOptions & { now?: Date } = {}): GovernanceDecision {
  try {
    const home = o.home ?? dataHome();
    const read = readGovernanceBook(home);
    if (!read.ok) return decideGovernance([], read, o.now ?? new Date());
    return decideGovernance(governedComponents(input, { ...o, home }), read, o.now ?? new Date());
  } catch {
    return governanceCheckFailed();
  }
}

/** One finding per component that is not promoted, the first block. Never throws. */
export function promotionGate(input: GateInput, o: GateOptions = {}): Omit<PromotionRecord, "enforce"> {
  try {
    const home = o.home ?? dataHome();
    const { refs, problems } = runComponents(input, { ...o, home });
    const findings = [...problems];
    const book = refs.some((r) => isCounted(r.kind)) ? readVersionBook(home) : undefined;
    const verdicts = new Map<string, SuiteVerdict>();
    const components: ComponentRef[] = [];
    for (const ref of refs) {
      let version = ref.version;
      let blocked: PromotionFinding | undefined;
      if (isCounted(ref.kind)) {
        if (!book?.ok) blocked = finding(ref.kind, ref.show, "-", "versions-invalid", "fix or restore promotions/versions.json");
        else {
          const v = lookupVersions(book.book, [{ kind: ref.kind, id: ref.id, sha256: ref.sha256 }])[0];
          if (v === undefined) blocked = finding(ref.kind, ref.show, "-", "unrecorded", `scf components record ${ref.kind}`);
          else version = String(v);
        }
      }
      if (!blocked) {
        for (const suite of REQUIRED_SUITES[ref.kind]) {
          let verdict = verdicts.get(suite);
          if (!verdict) {
            verdict = suiteVerdict(suite, { live: false, evalsDir: o.evalsDir, safetyDir: o.safetyDir });
            verdicts.set(suite, verdict);
          }
          const stop = componentBlock(ref, verdict);
          if (stop) {
            blocked = finding(ref.kind, ref.show, version, stop.code, SUITE_REMEDIATION, suite);
            break;
          }
        }
      }
      components.push({ kind: ref.kind, id: ref.show, version, sha256: ref.sha256 });
      if (blocked) findings.push(blocked);
    }
    return { promoted: findings.length === 0, components, findings };
  } catch {
    return { promoted: false, components: [], findings: [finding("flow", displayId(input.flowId), "-", "problem", fixComponent("flow"))] };
  }
}

/** `! <kind> <id> v<n> is not promoted: <suite> (<code>) — <remediation>`. The suite's detail is left out. */
export function findingLine(f: PromotionFinding): string {
  const what = f.suite ? `${f.suite} (${f.code})` : `(${f.code})`;
  return `! ${f.kind} ${f.id} v${f.version} is not promoted: ${what} — ${f.remediation}`;
}
