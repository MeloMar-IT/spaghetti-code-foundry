import { join } from "node:path";
import type { RunSummary } from "../engine/state.js";
import type { ArtifactRef } from "../evidence/identity.js";
import { readEvidenceChain, splitEvidenceLines } from "../evidence/chain.js";
import { readRunEvidence } from "../evidence/parse.js";
import type { RunEvidence } from "../evidence/schema.js";
import { evidenceIncomplete, readPlainBytes } from "../evidence/stream.js";
import { groupPolicyDecisions, type PolicyDecisionList } from "../policy/explain.js";
import { verifyRunEvidence, type VerifiedFile, type VerifyResult } from "../evidence/verify.js";
import { EVIDENCE_EVENTS_FILE, EVIDENCE_MANIFEST_FILE } from "../evidence/version.js";
import { hidePaths } from "./user-view.js";

/**
 * The evidence of a run as `GET /api/runs/:id/evidence` answers it.
 *
 * It holds what the manifest says, whether the evidence still verifies, and the references of the files the manifest
 * names (a path inside the run folder, a hash, a size). It never holds the content of a file: the changes and the
 * transcripts of a run are read through their own routes, with their own rules.
 * A user gets less than an administrator: no models and no policies (the setup of the Foundry), and no account ids.
 */

export type EvidenceArtifact = ArtifactRef & { state?: VerifiedFile["state"] };

export interface RunEvidenceView {
  runId: string;
  /** `not_available`: the run has no manifest that can be read (it is older than evidence, has not ended, or its evidence stopped or was removed). */
  state: "available" | "not_available";
  /** Why there is no manifest, in one or two sentences. Only with `not_available`. */
  reason?: string;
  verification: Pick<VerifyResult, "status" | "verified" | "explanation" | "checks" | "missingOptional"> & { failure?: VerifyResult["failure"] };
  /** A user: without `models` and `policies`, and with the kind of who approved but no id. */
  manifest?: Omit<RunEvidence, "models" | "policies" | "approvals"> & { models?: RunEvidence["models"]; policies?: RunEvidence["policies"]; approvals: { step: unknown; time: string; decision: string; by: { kind: string; id?: string } }[] };
  /** The files the manifest names, the diff last; `state` says what the verifier found for each. */
  artifacts: EvidenceArtifact[];
  /** Why actions were allowed, warned, denied or sent for approval. Repeated identical decisions are grouped, with their count and times. */
  policyDecisions: PolicyDecisionList;
}

const noDecisions = (complete: boolean): PolicyDecisionList => ({ groups: [], total: 0, omittedGroups: 0, complete });

/** True when the verifier failed on the events (missing, cut, changed) or the stream stopped. */
const eventsFailed = (v: RunEvidenceView["verification"]) =>
  v.status === "failed" && v.failure !== undefined && (v.failure.code === "incomplete" || v.failure.check === "events" || v.failure.check === "chain" || v.failure.check === "terminal");

/** The policy decisions of the events, from the part of the chain that can be read. Never throws. */
function policyDecisionsOf(runDir: string, runId: string, admin: boolean, verification: RunEvidenceView["verification"]): PolicyDecisionList {
  try {
    const bytes = readPlainBytes(join(runDir, EVIDENCE_EVENTS_FILE));
    // no events: a run older than evidence has nothing to show; a manifest without events, or a marker, means they are lost
    if (!bytes) return noDecisions(verification.status === "absent");
    const { lines, tail } = splitEvidenceLines(bytes.toString("utf8"));
    const read = readEvidenceChain(lines, runId);
    const items = read.events.flatMap((e) => (e.type === "policy.decided" ? [{ decision: e.decision, ...(e.step ? { step: e.step } : {}) }] : []));
    const complete = read.ok && tail === "" && !evidenceIncomplete(runDir) && !eventsFailed(verification);
    return { ...groupPolicyDecisions(items, { admin }), complete };
  } catch {
    return noDecisions(false);
  }
}

const UNREADABLE = "The evidence of this run cannot be read.";

function manifestFor(m: RunEvidence, admin: boolean): NonNullable<RunEvidenceView["manifest"]> {
  if (admin) return m;
  const { models: _models, policies: _policies, approvals, ...rest } = m;
  return { ...rest, approvals: approvals.map((a) => ({ step: a.step, time: a.time, decision: a.decision, by: { kind: a.by.kind } })) };
}

/** Never throws: a run whose evidence cannot be read answers `not_available`. */
export function runEvidenceView(s: Pick<RunSummary, "runId" | "runDir" | "workdir" | "repo">, admin: boolean): RunEvidenceView {
  const none = (reason: string, verification?: RunEvidenceView["verification"], decisions?: PolicyDecisionList): RunEvidenceView => ({
    runId: s.runId,
    state: "not_available",
    reason,
    verification: verification ?? { status: "failed", verified: false, explanation: reason, checks: [], missingOptional: [] },
    artifacts: [],
    policyDecisions: decisions ?? noDecisions(false),
  });
  try {
    const v = verifyRunEvidence(s.runDir, s.runId);
    const verification: RunEvidenceView["verification"] = { status: v.status, verified: v.verified, explanation: v.explanation, checks: v.checks, missingOptional: v.missingOptional, ...(v.failure ? { failure: v.failure } : {}) };
    const read = readRunEvidence(readPlainBytes(join(s.runDir, EVIDENCE_MANIFEST_FILE))?.toString("utf8"));
    // a manifest of another run (a copied file) is not this run's evidence
    const policyDecisions = policyDecisionsOf(s.runDir, s.runId, admin, verification);
    const view = read.state !== "ok" || read.evidence.runId !== s.runId ? none(v.explanation || UNREADABLE, verification, policyDecisions) : (() => {
      const m = read.evidence;
      const found = new Map(v.files.map((f) => [f.path, f.state]));
      const artifacts = [...m.artifacts, ...(m.diff ? [m.diff] : [])].map((a) => ({ ...a, ...(found.has(a.path) ? { state: found.get(a.path)! } : {}) }));
      return { runId: s.runId, state: "available" as const, verification, manifest: manifestFor(m, admin), artifacts, policyDecisions };
    })();
    // the manifest holds only paths inside the run folder; the folders of this machine are taken out all the same
    return admin ? view : hidePaths(view, s);
  } catch {
    return none(UNREADABLE);
  }
}
