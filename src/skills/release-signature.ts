import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { ApprovedRelease } from "./release.js";

export const APPROVAL_HEADER = "scf-skill-catalogue-approval-v1\n";
export const MAX_RELEASE_KEYS = 10;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ReleaseKey {
  id: string;
  ed25519: string;
}
export type SignatureState = { state: "signed"; key: string } | { state: "unsigned" } | { state: "bad"; key: string };

/** Canonical base64 that decodes to exactly `bytes` bytes, else undefined. */
export function decodeBase64Exact(s: string, bytes: number): Buffer | undefined {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;
  const buf = Buffer.from(s, "base64");
  return buf.length === bytes && buf.toString("base64") === s ? buf : undefined;
}

export function approvalText(a: { catalogue: string; version: string; digest: string }): string {
  return `${APPROVAL_HEADER}${a.catalogue}\n${a.version}\n${a.digest}\n`;
}

export function ed25519PublicKey(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Base64 of the 32 raw public key bytes of an Ed25519 key. */
export function rawPublicKey(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return (pub.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
}

/** Never throws. A missing key or signature, or an unknown key id, is `unsigned`; anything that does not verify is `bad`. */
export function approvalSignatureState(a: ApprovedRelease, keys: readonly ReleaseKey[]): SignatureState {
  if (a.key === undefined || a.signature === undefined) return { state: "unsigned" };
  const entry = keys.find((k) => k.id === a.key);
  if (!entry) return { state: "unsigned" };
  try {
    const raw = decodeBase64Exact(entry.ed25519, 32);
    const sig = decodeBase64Exact(a.signature, 64);
    if (raw && sig && verify(null, Buffer.from(approvalText(a), "utf8"), ed25519PublicKey(raw), sig)) return { state: "signed", key: entry.id };
  } catch {
    // falls through
  }
  return { state: "bad", key: entry.id };
}

/** Undefined when `keys` is empty or the entry is signed by a listed key; else the reason. */
export function approvalSignatureProblem(a: ApprovedRelease, keys: readonly ReleaseKey[]): string | undefined {
  if (!keys.length) return undefined;
  const s = approvalSignatureState(a, keys);
  if (s.state === "signed") return undefined;
  return s.state === "bad" ? "signature does not verify" : "is not signed by a trusted key";
}

/** The word shown by list and verify. Undefined when no keys are configured. */
export function releaseSignatureToken(
  id: { catalogue: string; version: string; digest: string },
  approved: readonly ApprovedRelease[],
  keys: readonly ReleaseKey[],
): string | undefined {
  if (!keys.length) return undefined;
  const entry = approved.find((a) => a.catalogue === id.catalogue && a.version === id.version && a.digest === id.digest);
  if (!entry) return "UNSIGNED";
  const s = approvalSignatureState(entry, keys);
  return s.state === "signed" ? `SIGNED ${s.key}` : s.state === "bad" ? "BAD-SIGNATURE" : "UNSIGNED";
}

/** Base64 signature of the approval text. */
export function signApproval(a: { catalogue: string; version: string; digest: string }, privateKey: KeyObject): string {
  return sign(null, Buffer.from(approvalText(a), "utf8"), privateKey).toString("base64");
}
