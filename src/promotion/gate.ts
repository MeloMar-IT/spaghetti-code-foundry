import { basename, extname } from "node:path";
import { dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import { MAX_FLOW_DEPTH } from "../engine/execute.js";
import { isShippedFlow } from "../engine/guards.js";
import { loadPolicyPacks, repositoryFact } from "../engine/policy-hooks.js";
import type { Flow } from "../flow/schema.js";
import { loadFlow } from "../flow/load.js";
import { BASELINE_POLICY_ID } from "../policy/baseline.js";
import { layeredPackIds } from "../policy/compose.js";
import { policyPackSha256 } from "../policy/evaluate.js";
import { declaredToolProfile, snapshotToolProfile } from "../tool-profile/session.js";
import { toolProfileSha256 } from "../tool-profile/resolve.js";
import { flowSha256, flowVersion, isCounted, lookupVersions, MODEL_ROUTES_ID, modelRoutesSha256, type ComponentKind, type ComponentRef } from "./components.js";
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
  config: Pick<Config, "policy" | "router">;
  toolProfile?: unknown;
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

/** The flow and every flow its `type: flow` steps reach, breadth first, so a flow is reached at its shallowest depth. */
function flowRefs(input: GateInput): { refs: Ref[]; problems: PromotionFinding[] } {
  const refs: Ref[] = [];
  const problems: PromotionFinding[] = [];
  const add = (flow: Flow, id: string) => {
    if (isShippedFlow(flow)) return; // an unchanged built-in flow needs no record
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
        }
      }
    }
    level = next;
  }
  return { refs, problems };
}

/** Every component of the run: refs to check, and the ones that could not be built. */
export function runComponents(input: GateInput, o: GateOptions = {}): { refs: Ref[]; problems: PromotionFinding[] } {
  const home = o.home ?? dataHome();
  const { refs, problems } = flowRefs(input);

  const ids = layeredPackIds(input.config.policy, repositoryFact(input.vars)).map((p) => p.id).filter((id) => id !== BASELINE_POLICY_ID);
  for (const loaded of loadPolicyPacks(ids, home)) {
    if ("problem" in loaded) problems.push(finding("policy-pack", displayId(loaded.id), "-", "problem", fixComponent("policy-pack")));
    else refs.push({ kind: "policy-pack", id: loaded.id, show: displayId(loaded.id), version: loaded.pack.policy.version, sha256: policyPackSha256(loaded.pack) });
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
  return { refs, problems };
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
