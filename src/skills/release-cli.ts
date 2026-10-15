import { matchRelease, type ApprovedRelease } from "./release.js";
import { verifyRelease } from "./release-verify.js";

/** Undefined for `verify <folder>`, else the syntax error. */
export function releaseOperandsProblem(operands: string[]): string | undefined {
  return operands[0] === "verify" && operands.length === 2 ? undefined : 'scf skills release: expects "verify" and one folder';
}

/** `scf skills release verify <dir>`: offline; prints checked fields only. Exit 0 when the release is intact, whether or not it is approved. */
export function releaseVerify(dir: string, out: (line: string) => void, approved: readonly ApprovedRelease[]): number {
  const v = verifyRelease(dir);
  if (!v.ok) {
    out(`PROBLEM ${v.reason}`);
    return 1;
  }
  const m = v.manifest;
  for (const s of [...m.skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    out(`SKILL ${s.id}@${s.version} ${s.digest} evaluation ${s.evaluation.verdict}${s.revoked ? ` REVOKED ${s.revoked.on}: ${s.revoked.reason}` : ""}`);
  }
  out(`VERIFIED ${m.catalogue}@${m.version} ${v.digest} ${m.skills.length} skill${m.skills.length === 1 ? "" : "s"}`);
  out(matchRelease({ state: "ok", manifest: m, digest: v.digest }, approved).state === "approved" ? "APPROVED" : "NOT-APPROVED");
  return 0;
}
