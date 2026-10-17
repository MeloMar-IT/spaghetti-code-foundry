import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { localGit } from "../engine/local-git.js";
import { CHOICE_LIMITS } from "./choice-rules.js";
import { credentialProblem } from "./credential-scan.js";
import { CATALOGUE_DESCRIPTION_FROM, catalogueDescriptionOf } from "./catalogue-description.js";
import { judgeItems, prepareEvaluation, type EvaluateCliOptions, type JudgedItem, type Out, type Prepared } from "./evaluate-cli.js";
import { parseEvaluationRecord } from "./evaluation.js";
import { readNewestRecord } from "./evaluation-store.js";
import { SkillImportError } from "./import-plan.js";
import { evaluateLicence, type LicenceEvidence } from "./licence.js";
import { reviewImport } from "./licence-review.js";
import { normalizeImport, type NormalizedSkill } from "./normalize.js";
import { foundryPackageFiles, parseSkillPackage, readRegular, skillDigest } from "./package.js";
import { NO_EVIDENCE_TIME, promoteImport, type PackageProvenance } from "./promotion.js";
import type { GitRun } from "./project-pins.js";
import { ReleaseManifestSchema, releaseDigest, releaseText, type ReleaseFileEntry, type ReleaseManifestV2, type ReleaseSkillV2 } from "./release.js";
import { findReleaseRequest, RELEASES_FILE, releaseRequestsFromBytes, type ReleaseRequest } from "./release-requests.js";
import { publishRelease, ReleaseStoreError, type ReleaseContent, type ReleaseFile } from "./release-store.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, type ScanException } from "./scan-exceptions.js";
import { loadExceptions, filesOf, hidden, plural, reviewedFiles, stagedImport } from "./staged-import.js";
import { MAX_SOURCES_BYTES, SOURCES_FILE, sourcesFromBytes, type SkillLibrarySource, type SourcesManifest } from "./sources.js";
import { suiteRefusal, suiteVerdicts } from "./suite-checks.js";

// `scf skills release publish <catalogue>@<version>`: builds a schema-2 release from the skills that skill-releases.yaml lists and
// writes it once through publishRelease (release-store.ts). Offline: no network, no model. It writes only below <data folder>/skill-releases/.
// It runs git only as read-only plumbing (rev-parse, ls-tree). Each of the two input files is read ONCE: those bytes are compared
// with HEAD, parsed, and used for the whole run, so nothing that was checked can change before it is used.

export const RELEASE_EVALUATION_SUITE = "skill-evaluation";
/** The record digest of a revoked skill that was never evaluated (its verdict is `not-run`). */
export const NO_EVALUATION_RECORD = "sha256:" + "0".repeat(64);

export interface ReleaseTarget {
  catalogue: string;
  version: string;
}
export interface ReleasePublishOptions extends EvaluateCliOptions {
  git?: GitRun;
}
export type CommittedState = { state: "ok"; commit: string } | { state: "problem"; reason: string };

const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The git object id of a blob: SHA-1 (40 hex digits) or SHA-256 (64), by the length of the object ids of the repository. */
export function gitBlobId(bytes: Uint8Array, oidLength: 40 | 64): string {
  return createHash(oidLength === 64 ? "sha256" : "sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/**
 * HEAD of the folder, and whether each given file is committed there byte for byte. Receives the bytes (it reads nothing).
 * Returns the first problem. Never throws.
 */
export function committedState(cwd: string, files: readonly { path: string; bytes: Uint8Array }[], git?: GitRun): CommittedState {
  try {
    const run = git ?? localGit(cwd, { timeoutMs: CHOICE_LIMITS.gitMs, maxBytes: 65536 });
    const rp = run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (rp.status === 1) return { state: "problem", reason: "the folder has no git commit" };
    const commit = rp.stdout.toString("utf8").trim();
    if (rp.status !== 0 || !HASH_RE.test(commit)) return { state: "problem", reason: "git cannot read the folder" };
    const ls = run(["ls-tree", "-z", commit, "--", ...files.map((f) => f.path)]);
    if (ls.status !== 0) return { state: "problem", reason: "git cannot read the folder" };
    const entries = new Map<string, { mode: string; type: string; oid: string }>();
    for (const line of ls.stdout.toString("utf8").split("\0")) {
      if (!line) continue;
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t(.*)$/s.exec(line);
      if (!m) return { state: "problem", reason: "git cannot read the folder" };
      entries.set(m[4]!, { mode: m[1]!, type: m[2]!, oid: m[3]! });
    }
    for (const f of files) {
      const e = entries.get(f.path);
      if (!e) return { state: "problem", reason: `${f.path} is not committed` };
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) return { state: "problem", reason: `${f.path} is not a regular file in HEAD` };
      if (gitBlobId(f.bytes, e.oid.length === 64 ? 64 : 40) !== e.oid) return { state: "problem", reason: `${f.path} differs from HEAD; commit it first` };
    }
    return { state: "ok", commit };
  } catch {
    return { state: "problem", reason: "git cannot read the folder" };
  }
}

const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** The bytes of an input file, "none" when it does not exist, or the problem text. Same rules as readSources: no link, no special file, size limit. */
function readInput(cwd: string, file: string): { bytes: Uint8Array } | "none" | string {
  const path = resolve(cwd, file);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "none" : `cannot be read (${errCode(e)})`;
  }
  if (st.isSymbolicLink()) return "is a symbolic link";
  if (!st.isFile()) return "is not a readable regular file";
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, MAX_SOURCES_BYTES);
  } catch (e) {
    return `cannot be read (${errCode(e)})`;
  }
  if (data === "link") return "is a symbolic link";
  if (data === "other") return "is not a readable regular file";
  if (data === "large") return `is larger than ${MAX_SOURCES_BYTES} bytes`;
  return { bytes: data };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const entryOf = (f: { path: string; content: Uint8Array }): ReleaseFileEntry => ({ path: f.path, sha256: sha(f.content), bytes: f.content.byteLength });
const byteCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface BuiltRelease {
  content: ReleaseContent;
  lines: string[];
  digest: string;
}

/**
 * Checks every gate and builds the release. Prints PROBLEM lines (every failing skill gets its own) and returns undefined when it
 * cannot publish; nothing is written either way. See the issue for the gates; revoked skills skip the promotion and evaluation gates.
 */
export function buildRelease(target: ReleaseTarget, out: Out, opts: ReleasePublishOptions): BuiltRelease | undefined {
  const label = `${target.catalogue}@${target.version}`;
  const stop = (...lines: string[]): undefined => {
    for (const l of lines) out(`PROBLEM ${l}`);
    out(`PROBLEM ${label}: nothing was published`);
    return undefined;
  };

  // 1. The release request file, read once.
  const relIn = readInput(opts.cwd, RELEASES_FILE);
  if (relIn === "none") return stop("the release request file does not exist");
  if (typeof relIn === "string") return stop(`${RELEASES_FILE} file: ${relIn}`);
  const relRead = releaseRequestsFromBytes(relIn.bytes, opts.today);
  if (relRead.state === "none") return stop("the release request file does not exist");
  if (relRead.state === "invalid") return stop(...relRead.problems.map((p) => `${RELEASES_FILE} ${p.where}: ${p.message}`));
  const requests = relRead.manifest;
  const entry: ReleaseRequest | undefined = findReleaseRequest(requests, target.catalogue, target.version);
  if (!entry) return stop(`${label}: not in ${RELEASES_FILE}`);
  const review = entry.review;
  if (!review) return stop(`${label}: the entry has no review`);

  // 2. The source file, read once.
  const srcIn = readInput(opts.cwd, SOURCES_FILE);
  if (srcIn === "none") return stop("the skill source file does not exist");
  if (typeof srcIn === "string") return stop(`${SOURCES_FILE} file: ${srcIn}`);

  // 3. Both files are committed and unchanged (the bytes above are the ones compared).
  const committed = committedState(opts.cwd, [{ path: RELEASES_FILE, bytes: relIn.bytes }, { path: SOURCES_FILE, bytes: srcIn.bytes }], opts.git);
  if (committed.state === "problem") return stop(committed.reason);
  const headCommit = committed.commit;

  // 4. The same bytes, parsed. From here on no step reads either file again.
  const srcRead = sourcesFromBytes(srcIn.bytes, opts.today);
  if (srcRead.state === "none") return stop("the skill source file does not exist");
  if (srcRead.state === "invalid") return stop(...srcRead.problems.map((p) => `${p.where}: ${p.message}`));
  const sources: SourcesManifest = srcRead.manifest;

  const revokedOf = (id: string) => entry.revoked?.find((r) => r.id === id);
  const anyGated = entry.skills.some((s) => !revokedOf(s.id));

  // 5. The reviewed files (selections, suite records), only for skills that are not revoked.
  let reviewed: NonNullable<ReturnType<typeof reviewedFiles>> = { selections: [], records: [], decisions: [] };
  if (anyGated) {
    const r = reviewedFiles(out, opts, true);
    if (!r) return stop();
    reviewed = r;
  }
  // The selections were read once (above); the evaluation uses this snapshot and does not read the file again.
  const snap: ReleasePublishOptions = { ...opts, sources, selections: reviewed.selections };

  // 6. Per source group, then per skill.
  let problems = 0;
  const skillProblem = (source: string, id: string, reason: string) => {
    out(`PROBLEM ${source}/${id}: ${reason}`);
    problems++;
  };
  const home = opts.home;
  const built: ReleaseSkillV2[] = [];
  const packages = new Map<string, ReleaseFile[]>();
  const attributions = new Map<string, ReleaseFile[]>();
  const lines: { id: string; line: string }[] = [];
  const decoder = new TextDecoder();

  const groups = new Map<string, string[]>();
  for (const s of entry.skills) groups.set(s.source, [...(groups.get(s.source) ?? []), s.id]);

  for (const [sourceId, ids] of groups) {
    const source: SkillLibrarySource | undefined = sources.sources.find((s) => s.id === sourceId);
    const failAll = (reason: string) => ids.forEach((id) => skillProblem(sourceId, id, reason));
    if (!source) {
      failAll("unknown source");
      continue;
    }
    if (source.status !== "enabled") {
      failAll(`the source is ${source.status}; only an enabled source can be published`);
      continue;
    }
    if (!source.ref.approved) {
      failAll("the source has no approved commit (ref.approved)");
      continue;
    }
    const gatedIds = ids.filter((id) => !revokedOf(id));
    const buf: string[] = [];
    let printed = false;
    const flush = () => {
      if (printed) return;
      printed = true;
      for (const l of buf) out(l);
    };
    const p: Prepared | undefined = prepareEvaluation(sourceId, undefined, (l) => buf.push(l), snap, "nothing was published");
    if (!p && gatedIds.length > 0) flush();
    let staged = p?.staged;
    if (!staged) {
      const buf2: string[] = [];
      staged = stagedImport(sourceId, (l) => buf2.push(l), snap);
      // A group with a gated skill already printed the same problem through `buf`.
      if (!staged && gatedIds.length === 0) for (const l of buf2) out(l);
    }
    if (!staged) {
      for (const id of ids) skillProblem(sourceId, id, `the staged import of ${sourceId} cannot be used (see the lines above)`);
      continue;
    }
    const { record, files, commit } = staged;
    const retrievedAt = record.retrievedAt ?? NO_EVIDENCE_TIME;
    const evidence: LicenceEvidence = staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] };
    const prep = { record: { ...record, rejected: [] }, files };
    let normalized: NormalizedSkill[] = normalizeImport(prep).skills;
    let importReview: ReturnType<typeof reviewImport> | undefined;
    let reviewProblem: string | undefined;
    if (gatedIds.length > 0) {
      try {
        importReview = reviewImport({ allow: source.licence.allow, prep, evidence });
        normalized = importReview.normalized.skills;
      } catch (e) {
        if (!(e instanceof SkillImportError)) throw e;
        reviewProblem = `not promotable (${hidden(e.message)})`;
      }
    }
    const judged: JudgedItem[] = p ? judgeItems(p, { home }) : [];
    let exceptions: ScanException[] | undefined;
    if (gatedIds.length > 0) {
      const exLines: string[] = [];
      exceptions = loadExceptions(undefined, (l) => exLines.push(l), opts);
      // Without `p` the same problem is already in `buf`.
      if (!exceptions && p) for (const l of exLines) out(l);
    }

    for (const id of ids) {
      const skill = normalized.find((s) => s.package.id === id);
      if (!skill) {
        skillProblem(sourceId, id, `not staged at ${commit.slice(0, 12)} or not normalized`);
        continue;
      }
      const pkg = skill.package;
      const rev = revokedOf(id);
      if (rev && rev.version !== pkg.version) {
        skillProblem(sourceId, id, `revoked names version ${rev.version}, but the built skill is ${pkg.version}`);
        continue;
      }
      const mine = judged.find((j) => j.item.id === id);
      let reasons = 0;
      const bad = (reason: string) => {
        skillProblem(sourceId, id, reason);
        reasons++;
      };
      let licences: string[] = [];
      let attribution: { path: string; content: Uint8Array }[] = [];
      let provenance: PackageProvenance | undefined;
      let evaluation: ReleaseSkillV2["evaluation"] | undefined;

      if (!rev) {
        // The checks of `promote check`.
        if (reviewProblem || !importReview) bad(reviewProblem ?? "not promotable");
        else {
          let promoted: ReturnType<typeof promoteImport> | undefined;
          try {
            promoted = promoteImport({ source, record, skills: [skill], evidence: importReview.evidence, retrievedAt, review: importReview });
          } catch (e) {
            if (!(e instanceof SkillImportError)) throw e;
            bad(`not promotable (${hidden(e.message)})`);
          }
          const pp = promoted?.promoted[0];
          if (promoted && !pp) {
            const r = promoted.manifest.refused[0];
            bad(`not promotable (${r ? `${r.status}: ${r.reasons.map(hidden).join("; ")}` : "refused"})`);
          }
          if (pp) {
            provenance = pp.provenance;
            licences = pp.provenance.licences;
            attribution = pp.attribution.map((a) => ({ path: a.path, content: a.content }));
          }
        }
        const root = skill.provenance.root;
        const mineFiles = filesOf(root, files);
        if (!exceptions) bad("the scan exceptions file cannot be used");
        else {
          const n = promotionBlockers(applyExceptions(id, scanSkill({ root, files: mineFiles }), exceptions, opts.today)).length;
          if (n > 0) bad(`blocked (${plural(n, "high finding")})`);
        }
        const texts = mineFiles.filter((f) => f.path.endsWith(".md")).map((f) => ({ path: `${root}/${f.path}`, text: decoder.decode(f.content) }));
        const refusal = suiteRefusal(suiteVerdicts({ source, skill, selections: reviewed.selections, records: reviewed.records, texts }));
        if (refusal !== undefined) bad(`evaluation suites (${refusal})`);
        if (!mine) {
          flush();
          bad(`not judged by the evaluation gate; run "scf skills gate ${sourceId}"`);
        } else if (!mine.passed) {
          bad(`evaluation failed: ${mine.codes.join(", ") || "record-invalid"}${mine.notes.length ? ` (${mine.notes.map(hidden).join("; ")})` : ""}`);
        } else if (mine.record.state !== "ok") {
          bad("evaluation failed: record-invalid");
        } else {
          const parsed = parseEvaluationRecord(mine.record.raw);
          if ("record" in parsed) evaluation = { suite: RELEASE_EVALUATION_SUITE, record: parsed.digest, verdict: "passed" };
          else bad(`evaluation failed: ${hidden(parsed.problem)}`);
        }
      } else {
        // Q1 (b): a revoked skill needs a package that loads, an identified licence and a readable record; no other gate.
        try {
          const lic = evaluateLicence({ root: skill.provenance.root, ...(pkg.license === undefined ? {} : { declared: pkg.license }), allow: source.licence.allow, evidence });
          if (lic.licences.length === 0) bad("revoked, but no licence is identified (the release needs one)");
          licences = lic.licences;
          attribution = lic.attribution;
        } catch {
          bad("revoked, but its licence cannot be read");
        }
        const rec = readNewestRecord(sourceId, commit, id, { home });
        if (rec.state === "none") evaluation = { suite: RELEASE_EVALUATION_SUITE, record: NO_EVALUATION_RECORD, verdict: "not-run" };
        else {
          const parsed = rec.state === "ok" ? parseEvaluationRecord(rec.raw) : undefined;
          if (parsed && "record" in parsed) {
            evaluation = { suite: RELEASE_EVALUATION_SUITE, record: parsed.digest, verdict: mine ? (mine.passed ? "passed" : "failed") : "not-run" };
          } else {
            bad(`revoked, but its newest evaluation record cannot be read (${hidden(rec.state === "invalid" ? rec.problem : parsed && "problem" in parsed ? parsed.problem : "invalid")})`);
          }
        }
      }

      // The package in Foundry format, loaded again from memory.
      const pkgFiles = foundryPackageFiles(pkg);
      const digest = skillDigest(pkgFiles);
      try {
        const loaded = parseSkillPackage(pkgFiles.map((f) => ({ path: f.path, kind: "file" as const, content: f.content })), id, id);
        if (loaded.id !== id || loaded.version !== pkg.version || loaded.digest !== digest) bad("the Foundry package does not load again with the same id and version");
      } catch {
        bad("the Foundry package does not load again with the same id and version");
      }
      if (reasons > 0 || !evaluation) continue;

      const desc = catalogueDescriptionOf(skill, sourceId, reviewed.selections);
      const prov = {
        source: sourceId,
        repositoryKey: provenance?.repositoryKey ?? skill.provenance.repositoryKey,
        commit: provenance?.commit ?? skill.provenance.commit,
        path: provenance?.path ?? skill.provenance.root,
        trust: provenance?.trust ?? source.trust,
        ...(source.review ? { review: { by: source.review.by, on: source.review.on, commit: source.review.commit, licence: source.review.licence } } : {}),
      };
      built.push({
        id,
        version: pkg.version,
        digest,
        files: pkgFiles.map(entryOf),
        provenance: prov,
        licences,
        attribution: attribution.map(entryOf),
        evaluation,
        ...(rev ? { revoked: { on: rev.on, reason: rev.reason } } : {}),
        ...(desc !== undefined ? { catalogueDescription: { text: desc, source: CATALOGUE_DESCRIPTION_FROM } } : {}),
      });
      packages.set(id, pkgFiles.map((f) => ({ path: f.path, content: f.content })));
      if (attribution.length > 0) attributions.set(id, attribution.map((a) => ({ path: a.path, content: a.content })));
      lines.push({ id, line: `SKILL ${id}@${pkg.version} ${digest} from ${sourceId} evaluation ${evaluation.verdict}${rev ? ` revoked ${rev.on}` : ""}${desc !== undefined ? " description skill-selections" : ""}` });
    }
  }
  if (problems > 0) return stop();

  // 9. The manifest.
  const manifest: ReleaseManifestV2 = {
    schema: 2,
    catalogue: target.catalogue,
    version: target.version,
    createdAt: `${review.on}T00:00:00Z`,
    source: { repository: requests.repository, commit: headCommit },
    skills: built.sort((a, b) => byteCmp(a.id, b.id)),
  };
  if (!ReleaseManifestSchema.safeParse(manifest).success) return stop(`${label}: the release manifest has the wrong format`);
  const cred = credentialProblem(releaseText(manifest));
  if (cred) return stop(`${label}: the release manifest holds what looks like a credential (${cred})`);
  return {
    content: { manifest, packages, attribution: attributions },
    lines: lines.sort((a, b) => byteCmp(a.id, b.id)).map((l) => l.line),
    digest: releaseDigest(manifest),
  };
}

/** `scf skills release publish`: builds the release, writes it once, prints the result. Returns 1 when nothing was published and it is not already there. */
export function releasePublish(target: ReleaseTarget, out: Out, opts: ReleasePublishOptions): number {
  const label = `${target.catalogue}@${target.version}`;
  const built = buildRelease(target, out, opts);
  if (!built) return 1;
  let result;
  try {
    result = publishRelease(built.content, { home: opts.home });
  } catch (e) {
    if (!(e instanceof ReleaseStoreError)) throw e;
    out(`PROBLEM ${e.message}; nothing was published`);
    return 1;
  }
  if (result.state === "refused") {
    out(`REFUSED ${label}: already published ${result.why === "other-digest" ? "with another digest" : "and the folder does not verify"}`);
    return 1;
  }
  if (result.state === "unchanged") {
    out(`UNCHANGED ${label} ${result.digest}: already published`);
  } else {
    for (const l of built.lines) out(l);
    out(`PUBLISHED ${label} ${result.digest} ${built.content.manifest.skills.length} skills to skill-releases/${target.catalogue}/${target.version}`);
  }
  out(`APPROVE ${target.catalogue} ${target.version} ${result.digest}`);
  return 0;
}
