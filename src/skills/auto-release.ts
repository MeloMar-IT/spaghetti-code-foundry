import { dataHome } from "../auth/store.js";
import { readApprovals, type ApprovalsFile } from "./approvals.js";
import { autoFailure, type AutoSkillFailure } from "./auto-updates.js";
import { autoSkillVersion, bumpPatch, type VersionBase } from "./auto-version.js";

/** How many patch numbers a skill may skip before its version is refused. */
const MAX_VERSION_STEPS = 1000;
import { normalizeImport, sourceQualifiedId } from "./normalize.js";
import { foundryPackageFiles, skillDigest } from "./package.js";
import { MAX_RELEASE_V2_BYTES, readRelease } from "./release.js";
import {
  finishRelease,
  gateReleaseSkills,
  type BuiltRelease,
  type ReleaseGate,
  type ReleasePublishOptions,
  type ReleaseTarget,
} from "./release-publish.js";
import { listStoredReleases, type StoreListing } from "./release-store.js";
import { verifyRelease } from "./release-verify.js";
import { compareSkillVersions, SKILL_ID_RE } from "./schema.js";
import { reviewedFiles, stagedImport } from "./staged-import.js";
import type { SkillLibrarySource, SourcesManifest } from "./sources.js";

// The release of an `update.auto` source (#799): which skills pass the gates, which version each gets, and the catalogue version
// `1.0.<n>`. Reads the data folder only; it writes nothing. Failures carry the skill id, the gate and the Foundry's own sentence,
// never upstream text.

const AUTO_VERSION_RE = /^1\.0\.(\d+)$/;

export interface BaseRelease extends VersionBase {
  /** The version of the catalogue release the skill was found in. */
  release: string;
}
export type AutoBases =
  | { state: "ok"; bases: Map<string, BaseRelease>; latest?: { version: string; skills: Map<string, string> } }
  | { state: "problem"; text: string };

/**
 * The skills of the approved releases of catalogue `sourceId`: per skill id, the entry of the newest approved release that holds it.
 * Each release is checked against the data-folder approval (catalogue, version, digest); a mismatch or an unreadable release is a problem.
 */
export function autoBases(sourceId: string, home: string): AutoBases {
  const approvals = readApprovals({ home });
  if (approvals.state === "unreadable") return { state: "problem", text: `skill-approvals.json ${approvals.reason}; versions cannot be decided` };
  const mine = (approvals.state === "ok" ? approvals.sources[sourceId]?.releases ?? [] : []).filter((r) => r.catalogue === sourceId);
  const listing = listStoredReleases(home);
  const bases = new Map<string, BaseRelease>();
  let latest: { version: string; skills: Map<string, string> } | undefined;
  for (const a of [...mine].sort((x, y) => compareSkillVersions(x.version, y.version))) {
    const stored = listing.releases.find((r) => r.catalogue === a.catalogue && r.version === a.version);
    const label = `${a.catalogue}@${a.version}`;
    if (!stored) return { state: "problem", text: `the approved release ${label} is not in the release store; versions cannot be decided` };
    const v = verifyRelease(stored.dir);
    if (!v.ok) return { state: "problem", text: `the approved release ${label} does not verify; versions cannot be decided` };
    if (v.manifest.catalogue !== a.catalogue || v.manifest.version !== a.version || v.digest !== a.digest) {
      return { state: "problem", text: `the release ${label} in the store is not the one that was approved; versions cannot be decided` };
    }
    const skills = new Map<string, string>();
    for (const s of v.manifest.skills) {
      skills.set(s.id, `${s.version} ${s.digest}`);
      bases.set(s.id, { version: s.version, digest: s.digest, paths: s.files.map((f) => f.path), release: a.version });
    }
    latest = { version: a.version, skills };
  }
  return { state: "ok", bases, ...(latest ? { latest } : {}) };
}

/** `id@version` → digest, for every stored release of every catalogue. A release that cannot be read is skipped. */
export function takenVersions(home: string): Map<string, string> {
  const taken = new Map<string, string>();
  for (const r of listStoredReleases(home).releases) {
    const read = readRelease(r.dir, MAX_RELEASE_V2_BYTES);
    if (read.state !== "ok") continue;
    for (const s of read.manifest.skills) taken.set(`${s.id}@${s.version}`, s.digest);
  }
  return taken;
}

/** `1.0.<n>`: one higher than the highest `1.0.<k>` of catalogue `sourceId` in the release store or in the approvals. */
export function nextAutoVersion(sourceId: string, listing: StoreListing, approvals: ApprovalsFile): string {
  let max = 0;
  const see = (catalogue: string, version: string) => {
    const m = catalogue === sourceId ? AUTO_VERSION_RE.exec(version) : null;
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const r of listing.releases) see(r.catalogue, r.version);
  for (const s of Object.values(approvals)) for (const r of s.releases) see(r.catalogue, r.version);
  return `1.0.${max + 1}`;
}

export type AutoReleaseResult =
  | { state: "built"; target: ReleaseTarget; built: BuiltRelease; failed: AutoSkillFailure[] }
  | { state: "unchanged"; base: { catalogue: string; version: string }; failed: AutoSkillFailure[] }
  | { state: "blocked"; failed: AutoSkillFailure[] }
  | { state: "problem"; text: string };

/** The id of a skill in a failure line: the source-qualified id when it is a valid id, else a fixed placeholder (never upstream text). */
const safeId = (id: string, sourceId: string, n: number): string => (SKILL_ID_RE.test(id) ? id : `${sourceId}-skill-${n}`.slice(0, 64));

/** Failures for `count` skills the import refused: they have no usable name, so each gets a fixed placeholder id. */
export const rejectedFailures = (sourceId: string, count: number): AutoSkillFailure[] =>
  Array.from({ length: count }, (_, i) => autoFailure(safeId("", sourceId, i + 1), "normalize"));

/**
 * Runs the gates on the staged import of `source` at `commit` and builds the release with the automatic versions.
 * `sources` is the manifest in which the source has `ref.approved = commit`. Prints nothing.
 */
export function buildAutoRelease(
  input: { source: SkillLibrarySource; commit: string; sources: SourcesManifest; evaluation: "required" | "not-run"; createdAt: string },
  opts: ReleasePublishOptions,
): AutoReleaseResult {
  const { source, commit, sources } = input;
  const home = opts.home ?? dataHome();
  const problem = (text: string): AutoReleaseResult => ({ state: "problem", text });
  const based = autoBases(source.id, home);
  if (based.state === "problem") return problem(based.text);

  const staged = stagedImport(source.id, () => {}, { cwd: opts.cwd, home, today: opts.today, sources });
  if (!staged) return problem("the staged import cannot be used");
  const { record, files } = staged;

  // Failures before the gates: skills the import refused, and skills that do not normalize. The first failure of a skill is kept.
  const failed: AutoSkillFailure[] = [];
  const fail = (skill: string, gate: ReleaseGate) => {
    if (!failed.some((f) => f.skill === skill)) failed.push(autoFailure(skill, gate));
  };
  record.rejected.forEach((_r, i) => fail(safeId("", source.id, i + 1), "normalize"));
  const normalized = normalizeImport({ record: { ...record, rejected: [] }, files }).skills;
  const origin = { source: record.source, repositoryKey: record.repositoryKey };
  record.skills.forEach((entry, i) => {
    if (normalized.some((s) => s.provenance.root === entry.root)) return;
    fail(safeId(sourceQualifiedId(origin, entry.name), source.id, record.rejected.length + i + 1), "normalize");
  });

  const reviewed = reviewedFiles(() => {}, opts, true);
  if (!reviewed) return problem("the reviewed files of the catalogue cannot be used");

  const taken = takenVersions(home);
  const c12 = commit.slice(0, 12);
  const versionOf = (id: string, pkg: Parameters<NonNullable<Parameters<typeof gateReleaseSkills>[0]["versionOf"]>>[1]): string | undefined => {
    const digestAt = (version: string) => skillDigest(foundryPackageFiles({ ...pkg, version }));
    let v = autoSkillVersion({
      base: based.bases.get(id),
      declared: pkg.version === `0.0.0-g${c12}` ? undefined : pkg.version,
      digestAt,
      paths: foundryPackageFiles(pkg).map((f) => f.path),
    });
    // A version already held with other bytes (for example by an unapproved release after a failed approval) is skipped: the next
    // patch number is tried. Stored releases are never changed, and a version with the same bytes is reused.
    for (let step = 0; step < MAX_VERSION_STEPS; step++) {
      const other = taken.get(`${id}@${v}`);
      if (other === undefined || other === digestAt(v)) return v;
      v = bumpPatch(v);
    }
    return undefined;
  };

  const gated = gateReleaseSkills(
    { skills: normalized.map((s) => ({ source: source.id, id: s.package.id })), sources, reviewed, evaluation: input.evaluation, versionOf },
    () => {},
    opts,
  );
  for (const r of gated.refused) fail(safeId(r.id, source.id, failed.length + 1), r.gate);
  if (gated.built.length === 0) return { state: "blocked", failed };

  // The same skills, versions and digests as the newest approved release: nothing to release.
  const latest = based.latest;
  if (latest && latest.skills.size === gated.built.length && gated.built.every((s) => latest.skills.get(s.id) === `${s.version} ${s.digest}`)) {
    return { state: "unchanged", base: { catalogue: source.id, version: latest.version }, failed };
  }

  const target: ReleaseTarget = { catalogue: source.id, version: nextAutoVersion(source.id, listStoredReleases(home), readApprovalsFile(home)) };
  let stopped: string | undefined;
  const built = finishRelease(target, { createdAt: input.createdAt, source: { repository: source.repositoryKey, commit } }, gated, (...lines) => {
    stopped = lines.join("; ");
    return undefined;
  });
  if (!built) return problem(stopped ?? "the release could not be built");
  return { state: "built", target, built, failed };
}

const readApprovalsFile = (home: string): ApprovalsFile => {
  const r = readApprovals({ home });
  return r.state === "ok" ? r.sources : {};
};
