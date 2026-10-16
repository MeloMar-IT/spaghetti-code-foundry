import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSkillLock } from "./lock.js";
import { matchRelease, type ApprovedRelease } from "./release.js";
import { readReleaseRequests } from "./release-requests.js";
import { loadSkillPackage } from "./package.js";
import type { RegisteredSkill } from "./registry.js";
import { catalogueChangeLines, catalogueChanges, releaseEntry } from "./release-changes.js";
import { listStoredReleases, type StoredRelease } from "./release-store.js";
import { readRunSkillLock } from "./run-lock.js";
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
  if (operands[0] === "list" && operands.length === 1) return undefined;
  if (operands[0] === "diff") {
    const a = operands.length === 3 ? parseReleaseTarget(operands[1]!) : undefined;
    const b = operands.length === 3 ? parseReleaseTarget(operands[2]!) : undefined;
    return a && b && a.catalogue === b.catalogue ? undefined : "scf skills release diff: expects <catalogue>@<old> <catalogue>@<new> of one catalogue";
  }
  return operands[0] === "verify" && operands.length === 2 ? undefined : 'scf skills release: expects "verify" and one folder, "publish" and <catalogue>@<version>, "diff" and two <catalogue>@<version>, or "list"';
}

type Target = { catalogue: string; version: string };

/** One stored release, checked and loaded: its manifest and the registered packages. Prints the PROBLEM and returns undefined on failure. */
function loadStored(t: Target, releases: readonly StoredRelease[], out: (line: string) => void) {
  const name = `${t.catalogue}@${t.version}`;
  const found = releases.find((r) => r.catalogue === t.catalogue && r.version === t.version);
  if (!found) {
    out(`PROBLEM release ${name} is not in the release store`);
    return undefined;
  }
  const v = verifyRelease(found.dir);
  if (!v.ok) {
    out(`PROBLEM release ${name} invalid: ${v.reason}`);
    return undefined;
  }
  const m = v.manifest;
  if (m.catalogue !== t.catalogue || m.version !== t.version) {
    out(`PROBLEM release ${name} invalid: the release folder does not hold ${name}`);
    return undefined;
  }
  const packages: RegisteredSkill[] = [];
  for (const s of m.skills) {
    try {
      const pkg = loadSkillPackage(join(found.dir, s.id));
      if (pkg.id !== s.id || pkg.version !== s.version || pkg.digest !== s.digest) throw new Error("differs");
      packages.push(releaseEntry(pkg, t));
    } catch {
      out(`PROBLEM release ${name}: skill ${s.id} does not load`);
      return undefined;
    }
  }
  return { manifest: m, digest: v.digest, packages };
}

/** `scf skills release diff <catalogue>@<old> <catalogue>@<new>`: offline, from the release store. Approval is not needed. Reads only. */
export function releaseDiff(old: Target, next: Target, out: (line: string) => void, opts: { home: string; highRisk: readonly string[] }): number {
  const listing = listStoredReleases(opts.home);
  if (listing.refused) {
    out(`PROBLEM skill-releases is ${listing.refused}`);
    return 1;
  }
  const a = loadStored(old, listing.releases, out);
  if (!a) return 1;
  const b = loadStored(next, listing.releases, out);
  if (!b) return 1;
  let changes;
  try {
    changes = catalogueChanges(a.manifest, b.manifest, { old: a.packages, next: b.packages }, { highRisk: opts.highRisk });
  } catch (e) {
    if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
    out(`PROBLEM ${e.message}`);
    return 1;
  }
  const lines = catalogueChangeLines(changes);
  for (const l of lines) out(l);
  const n = lines.length;
  out(`DIFF ${old.catalogue}@${old.version} ${a.digest} -> ${next.catalogue}@${next.version} ${b.digest}: ${n === 0 ? "no changes" : `${n} change${n === 1 ? "" : "s"}`}`);
  return 0;
}

/** `scf skills release list`: every stored release with its approval state and the run locks that use it. Reads only. */
export function releaseList(out: (line: string) => void, opts: { home: string; runsDir: string; approved: readonly ApprovedRelease[] }): number {
  // `id@version digest` → names of the runs whose lock holds it
  const locked = new Map<string, Set<string>>();
  try {
    for (const d of readdirSync(opts.runsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const r = readRunSkillLock(join(opts.runsDir, d.name));
      if (!r.ok) continue;
      for (const s of r.lock.skills) {
        const k = `${s.id}@${s.version} ${s.digest}`;
        (locked.get(k) ?? locked.set(k, new Set()).get(k)!).add(d.name);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") out("NOTE the runs folder cannot be read; run locks are not checked");
  }
  const lock = readSkillLock(opts.home);
  const listing = listStoredReleases(opts.home);
  if (listing.refused) out(`NOTE skill-releases is ${listing.refused.replace(", not scanned", "; it is not read")}`);
  if (listing.unreadable) out(`PROBLEM ${listing.unreadable} catalogue folder${listing.unreadable === 1 ? "" : "s"} in skill-releases cannot be read; their releases are not listed`);
  const incomplete = !!listing.refused || listing.unreadable > 0;
  for (let i = 0; i < listing.hidden; i++) out("RELEASE (name not shown) invalid: the folder name looks like a credential");
  for (const r of listing.releases) {
    const name = `${r.catalogue}@${r.version}`;
    const v = verifyRelease(r.dir);
    if (!v.ok) {
      out(`RELEASE ${name} invalid: ${v.reason}`);
      continue;
    }
    const m = v.manifest;
    if (m.catalogue !== r.catalogue || m.version !== r.version) {
      out(`RELEASE ${name} invalid: the release folder does not hold ${name}`);
      continue;
    }
    const state = matchRelease({ state: "ok", manifest: m, digest: v.digest }, opts.approved).state;
    const runs = new Set<string>();
    for (const s of m.skills) for (const n of locked.get(`${s.id}@${s.version} ${s.digest}`) ?? []) runs.add(n);
    const n = m.skills.length;
    out(`RELEASE ${name} ${v.digest} ${state} ${n} skill${n === 1 ? "" : "s"}, ${runs.size ? `locked by ${runs.size} run${runs.size === 1 ? "" : "s"}` : "not locked by any run"}`);
    if (state !== "approved" || !lock.ok) continue;
    for (const s of m.skills) {
      if (!s.revoked && !lock.pins[`${s.id}@${s.version}`]) out(`PIN scf skills pin ${s.id}@${s.version} ${s.digest}`);
    }
  }
  const total = listing.releases.length + listing.hidden;
  if (incomplete) {
    out(`The release store could not be read completely; ${total} release${total === 1 ? "" : "s"} listed`);
    return 1;
  }
  out(total ? `OK ${total} release${total === 1 ? "" : "s"}` : "No releases are published");
  return 0;
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
