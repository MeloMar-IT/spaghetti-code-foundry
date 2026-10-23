import type { KeyObject } from "node:crypto";
import { canonicalHash, canonicalJson } from "../evidence/canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "../evidence/chain.js";
import { sha256Hex, type PullRequestIdentity } from "../evidence/identity.js";
import { EVIDENCE_EVENTS_FILE } from "../evidence/version.js";
import { compareCodeUnits, DELIVERY_CONTRACT_VERSION, DeliveryContractSchema, STOP_CONDITIONS, type DeliveryContract } from "./schema.js";
import { signSsh, verifySshSignature } from "./sshsig.js";

/** Build, sign and verify a delivery contract. Pure: no clock, no files, no randomness. */

export const DELIVERY_SIGNATURE_NAMESPACE = "scf-delivery-contract";

export interface DeliveryFacts {
  runId: string;
  sequence: number;
  supersedes?: string;
  repository: string;
  pullRequest: PullRequestIdentity;
  commit: { sha: string; branch: string };
  dependencyLocks: readonly { path: string; sha256: string }[];
  ciWorkflows: readonly { path: string; blob: string }[];
  requiredChecks: readonly string[];
  evidence: { count: number; terminalHash: string };
  artifacts: readonly { name: string; sha256?: string }[];
  provenance: { required: boolean };
}

export class DeliveryContractError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`the delivery contract is not valid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    this.name = "DeliveryContractError";
  }
}

const byPath = <T extends { path: string }>(a: T, b: T): number => compareCodeUnits(a.path, b.path);

/** Builds the contract from the facts. Lists are sorted; duplicates are refused. Throws DeliveryContractError. */
export function buildDeliveryContract(facts: DeliveryFacts): DeliveryContract {
  const files = facts.dependencyLocks.map((f) => ({ path: f.path, sha256: f.sha256 })).sort(byPath);
  const candidate = {
    version: DELIVERY_CONTRACT_VERSION,
    runId: facts.runId,
    sequence: facts.sequence,
    ...(facts.supersedes === undefined ? {} : { supersedes: facts.supersedes }),
    repository: facts.repository,
    pullRequest: facts.pullRequest,
    commit: { sha: facts.commit.sha, branch: facts.commit.branch },
    dependencyLock: { files, sha256: canonicalHash(files) },
    ciWorkflows: facts.ciWorkflows.map((f) => ({ path: f.path, blob: f.blob })).sort(byPath),
    requiredChecks: [...facts.requiredChecks].sort(compareCodeUnits),
    evidence: { path: EVIDENCE_EVENTS_FILE, count: facts.evidence.count, terminalHash: facts.evidence.terminalHash },
    artifacts: facts.artifacts.map((a) => ({ name: a.name, ...(a.sha256 === undefined ? {} : { sha256: a.sha256 }) })).sort((a, b) => compareCodeUnits(a.name, b.name)),
    provenance: { required: facts.provenance.required },
    stopConditions: [...STOP_CONDITIONS],
  };
  const parsed = DeliveryContractSchema.safeParse(candidate);
  if (!parsed.success) throw new DeliveryContractError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return parsed.data;
}

export const deliveryContractText = (c: DeliveryContract): string => canonicalJson(c);
export const contractDigest = (text: string): string => sha256Hex(Buffer.from(text, "utf8"));
export const signDeliveryContract = (text: string, key: KeyObject): string => signSsh(text, key, DELIVERY_SIGNATURE_NAMESPACE);

export type DeliveryVerifyFault = "unreadable" | "wrong-version" | "signature-missing" | "signature-bad" | "wrong-key" | "evidence-head-mismatch";
export type DeliveryVerifyResult = { ok: true; contract: DeliveryContract; digest: string } | { ok: false; fault: DeliveryVerifyFault; message: string };

/**
 * Checks a contract text and its signature against the trusted public key line (`ssh-ed25519 AAAA…`).
 * `eventsText`, when given, is the evidence file: its event at `count - 1` must have the contract's `terminalHash`
 * (events added later do not matter). Returns the first fault. Never throws.
 */
export function verifyDeliveryContract(text: string, sigText: string | undefined, publicKey: string, eventsText?: string): DeliveryVerifyResult {
  const no = (fault: DeliveryVerifyFault, message: string): DeliveryVerifyResult => ({ ok: false, fault, message });
  try {
    if (typeof text !== "string") return no("unreadable", "the contract is not text");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return no("unreadable", "the contract is not JSON");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return no("unreadable", "the contract is not a JSON object");
    if ((raw as Record<string, unknown>).version !== DELIVERY_CONTRACT_VERSION) return no("wrong-version", "the contract is of a version this Foundry does not read");
    if (canonicalJson(raw) !== text) return no("unreadable", "the contract is not written in the canonical form");
    const parsed = DeliveryContractSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(contract)"))].slice(0, 5).join(", ");
      return no("unreadable", `the contract is not valid (${fields})`);
    }
    const contract = parsed.data;
    if (typeof sigText !== "string" || sigText.trim() === "") return no("signature-missing", "the contract has no signature");
    const check = verifySshSignature(text, sigText, publicKey, DELIVERY_SIGNATURE_NAMESPACE);
    if (!check.ok) {
      return check.fault === "wrong-key" || check.fault === "public-key" ? no("wrong-key", "the contract is not signed by the trusted key") : no("signature-bad", "the signature does not verify");
    }
    if (eventsText !== undefined) {
      const { count, terminalHash } = contract.evidence;
      const { lines } = splitEvidenceLines(eventsText);
      if (lines.length < count) return no("evidence-head-mismatch", "the events have fewer events than the contract");
      const chain = readEvidenceChain(lines.slice(0, count), contract.runId);
      if (!chain.ok) return no("evidence-head-mismatch", `line ${chain.line} of the events is not a chain`);
      if (chain.terminalHash !== terminalHash) return no("evidence-head-mismatch", "the event at count - 1 does not have the contract's hash");
    }
    return { ok: true, contract, digest: contractDigest(text) };
  } catch {
    return no("unreadable", "the contract could not be read");
  }
}
