import { matchRelease, type ApprovedRelease } from "./release.js";
import { readReleaseRequests } from "./release-requests.js";
import { verifyRelease } from "./release-verify.js";
import { SKILL_ID_RE, SKILL_VERSION_RE } from "./schema.js";

/** `<catalogue>@<version>` with exactly one `@`; undefined for anything else. */
export function parseReleaseTarget(s: string): { catalogue: string; version: string } | undefined {
  const parts = s.split("@");
  if (parts.length !== 2) return undefined;
  const [catalogue, version] = parts as [string, string];
  return SKILL_ID_RE.test(catalogue) && SKILL_VERSION_RE.test(version) ? { catalogue, version } : undefined;
}

/** Undefined for `verify <folder>` or `publish <catalogue>@<version>`, else the syntax error. */
export function releaseOperandsProblem(operands: string[]): string | undefined {
  if (operands[0] === "publish" && operands.length === 2) {
    return parseReleaseTarget(operands[1]!) ? undefined : "scf skills release publish: the operand must be <catalogue>@<version>";
  }
  return operands[0] === "verify" && operands.length === 2 ? undefined : 'scf skills release: expects "verify" and one folder, or "publish" and <catalogue>@<version>';
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

/** `scf skills releases check`: offline, read-only; prints checked fields only. */
export function releasesCheck(file: string, out: (line: string) => void, today: string): number {
  const r = readReleaseRequests(file, today);
  if (r.state === "none") {
    out("PROBLEM the release request file does not exist");
    return 1;
  }
  if (r.state === "invalid") {
    for (const p of r.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const m = r.manifest;
  for (const e of m.releases) {
    const review = e.review ? `reviewed by ${e.review.by} on ${e.review.on}` : "NOT REVIEWED";
    out(`${e.catalogue}@${e.version} ${e.skills.length} skills, ${e.revoked?.length ?? 0} revoked, ${review}`);
  }
  out(`OK ${m.releases.length} releases for ${m.repository}`);
  return 0;
}
