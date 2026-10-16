import { createPrivateKey, verify, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { matchRelease, type ApprovedRelease } from "./release.js";
import { readReleaseRequests } from "./release-requests.js";
import { loadSkillPackage } from "./package.js";
import type { RegisteredSkill } from "./registry.js";
import { catalogueChangeLines, catalogueChanges, releaseEntry } from "./release-changes.js";
import { personalAgentPath } from "./registry-util.js";
import { approvalSignatureState, approvalText, decodeBase64Exact, ed25519PublicKey, rawPublicKey, releaseSignatureToken, signApproval, type ReleaseKey } from "./release-signature.js";
import { listStoredReleases, publishRelease, readReleaseContent, ReleaseStoreError, releaseStorePath, type StoredRelease } from "./release-store.js";
import { readRunSkillLock } from "./run-lock.js";
import { verifyRelease } from "./release-verify.js";
import { artifactPathProblem, SKILL_ID_RE, SKILL_VERSION_RE } from "./schema.js";

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
  if (operands[0] === "sign" && operands.length === 2) {
    return parseReleaseTarget(operands[1]!) ? undefined : "scf skills release sign: the operand must be <catalogue>@<version>";
  }
  if (operands[0] === "adopt" && operands.length <= 2) {
    return operands.length === 1 || parseReleaseTarget(operands[1]!) ? undefined : "scf skills release adopt: the operand must be <catalogue>@<version>";
  }
  if (operands[0] === "list" && operands.length === 1) return undefined;
  if (operands[0] === "diff") {
    const a = operands.length === 3 ? parseReleaseTarget(operands[1]!) : undefined;
    const b = operands.length === 3 ? parseReleaseTarget(operands[2]!) : undefined;
    return a && b && a.catalogue === b.catalogue ? undefined : "scf skills release diff: expects <catalogue>@<old> <catalogue>@<new> of one catalogue";
  }
  return operands[0] === "verify" && operands.length === 2 ? undefined : 'scf skills release: expects "verify" and one folder, "publish", "sign" or "adopt" and <catalogue>@<version>, "diff" and two <catalogue>@<version>, or "list"';
}

const MAX_KEY_FILE_BYTES = 16384;

/** Reads an Ed25519 PEM private key. Returns the key or a fixed problem text; never a path, message or content. */
export function readSigningKey(path: string): KeyObject | string {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "the key file cannot be read";
  }
  if (st.isSymbolicLink()) return "the key file is a symbolic link";
  if (!st.isFile()) return "the key file is not a regular file";
  if (st.mode & 0o077) return "the key file can be read by group or others; run chmod 600";
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP" ? "the key file is a symbolic link" : "the key file cannot be read";
  }
  let buf: Buffer | undefined;
  try {
    const f = fstatSync(fd);
    if (!f.isFile()) return "the key file is not a regular file";
    if (f.dev !== st.dev || f.ino !== st.ino) return "the key file changed while it was read";
    if (f.mode & 0o077) return "the key file can be read by group or others; run chmod 600";
    if (f.size > MAX_KEY_FILE_BYTES) return "the key file is too large";
    buf = Buffer.alloc(f.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const key = createPrivateKey({ key: buf.subarray(0, off), format: "pem" });
    return key.asymmetricKeyType === "ed25519" ? key : "the key is not an Ed25519 private key";
  } catch {
    return "the key file is not a readable unencrypted Ed25519 PEM private key";
  } finally {
    closeSync(fd);
    buf?.fill(0);
  }
}

/** `scf skills release sign <catalogue>@<version> --key <file>`: signs a stored release. Prints the approved entry, never key material. */
export function releaseSign(target: { catalogue: string; version: string }, out: (line: string) => void, opts: { keyFile: string; home: string; keys: readonly ReleaseKey[] }): number {
  const problem = (why: string) => {
    out(`PROBLEM ${why}`);
    return 1;
  };
  const priv = readSigningKey(opts.keyFile);
  if (typeof priv === "string") return problem(priv);
  const pub = rawPublicKey(priv);
  const entry = opts.keys.find((k) => k.ed25519 === pub);
  if (!entry) return problem("the key is not listed in skills.releases.keys");
  const name = `${target.catalogue}@${target.version}`;
  const stored = listStoredReleases(opts.home).releases.find((r) => r.catalogue === target.catalogue && r.version === target.version);
  if (!stored) return problem(`${name} is not in the release store`);
  const v = verifyRelease(stored.dir);
  if (!v.ok) return problem(v.reason);
  if (v.manifest.catalogue !== target.catalogue || v.manifest.version !== target.version) return problem(`the release folder does not hold ${name}`);
  const id = { catalogue: target.catalogue, version: target.version, digest: v.digest };
  const signature = signApproval(id, priv);
  const raw = decodeBase64Exact(entry.ed25519, 32);
  if (!raw || !verify(null, Buffer.from(approvalText(id), "utf8"), ed25519PublicKey(raw), Buffer.from(signature, "base64"))) return problem("the new signature does not verify");
  out(`APPROVE ${id.catalogue} ${id.version} ${id.digest} key ${entry.id} signature ${signature}`);
  return 0;
}

export interface ReleaseAdoptOptions {
  home: string;
  approved: readonly ApprovedRelease[];
  keys: readonly ReleaseKey[];
  env: NodeJS.ProcessEnv;
  userHome: string;
}

/**
 * `scf skills release adopt [<catalogue>@<version>]`: copies each approved release that is missing from the store from its local
 * artifact, after verify, identity and signature checks. Offline. Output never shows a path. Exit 1 on any REFUSED, a store that
 * cannot be read, or a named entry with MISSING-ARTIFACT.
 */
export function releaseAdopt(target: { catalogue: string; version: string } | undefined, out: (line: string) => void, opts: ReleaseAdoptOptions): number {
  const { home } = opts;
  let refused = false;
  let missing = false;
  const refuse = (name: string, why: string) => {
    refused = true;
    out(`REFUSED ${name}: ${why}`);
  };
  const entries = target ? opts.approved.filter((a) => a.catalogue === target.catalogue && a.version === target.version) : [...opts.approved];
  if (target && !entries.length) {
    refuse(`${target.catalogue}@${target.version}`, "not in skills.releases.approved");
    return 1;
  }
  if (!entries.length) {
    out("No releases are approved");
    return 0;
  }
  const listing = listStoredReleases(home);
  if (listing.refused || listing.unreadable) {
    out("PROBLEM the release store cannot be read completely; nothing was adopted");
    return 1;
  }
  for (const a of entries) {
    const name = `${a.catalogue}@${a.version}`;
    const other = `the release store holds ${name} with another digest`;
    const stored = listing.releases.find((r) => r.catalogue === a.catalogue && r.version === a.version);
    if (stored) {
      const v = verifyRelease(stored.dir);
      if (!v.ok) refuse(name, `the release store holds ${name}, but it does not verify`);
      else if (v.digest !== a.digest || v.manifest.catalogue !== a.catalogue || v.manifest.version !== a.version) refuse(name, other);
      else out(`PRESENT ${name}`);
      continue;
    }
    if (a.artifact === undefined) {
      missing = true;
      out(`MISSING-ARTIFACT ${name}: no artifact is set in skills.releases.approved`);
      continue;
    }
    const pathProblem = artifactPathProblem(a.artifact);
    if (pathProblem) {
      refuse(name, `the artifact ${pathProblem}`);
      continue;
    }
    try {
      lstatSync(a.artifact);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        missing = true;
        out(`MISSING-ARTIFACT ${name}: the artifact folder does not exist`);
      } else refuse(name, "the artifact cannot be read");
      continue;
    }
    let real: string;
    try {
      real = realpathSync(a.artifact);
    } catch {
      refuse(name, "the artifact cannot be read");
      continue;
    }
    if (personalAgentPath(real, opts.env, opts.userHome)) {
      refuse(name, "the artifact is in a personal agent folder");
      continue;
    }
    if (releaseStorePath(real, home)) {
      refuse(name, "the artifact is inside the release store");
      continue;
    }
    const sig = approvalSignatureState(a, opts.keys);
    if (sig.state !== "signed") {
      refuse(name, !opts.keys.length ? "no skills.releases.keys are set; adopt needs a signed approval" : sig.state === "unsigned" ? "is not signed by a trusted key" : "signature does not verify");
      continue;
    }
    const v = verifyRelease(real);
    if (!v.ok) {
      refuse(name, v.reason);
      continue;
    }
    const m = v.manifest;
    if (m.catalogue !== a.catalogue || m.version !== a.version) {
      refuse(name, `the artifact holds ${m.catalogue}@${m.version}`);
      continue;
    }
    if (v.digest !== a.digest) {
      refuse(name, `the artifact has digest ${v.digest}, not the approved one`);
      continue;
    }
    const content = readReleaseContent(real, m);
    if (typeof content === "string") {
      refuse(name, content);
      continue;
    }
    try {
      const r = publishRelease(content, { home });
      if (r.state === "refused") refuse(name, r.why === "other-digest" ? other : `the release store holds ${name} that does not verify`);
      else out(r.state === "published" ? `ADOPTED ${name} ${r.digest}` : `PRESENT ${name}`);
    } catch (e) {
      refuse(name, `${e instanceof ReleaseStoreError ? e.message : "the release cannot be written"}; nothing was adopted`);
    }
  }
  return refused || (target && missing) ? 1 : 0;
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
export function releaseList(out: (line: string) => void, opts: { home: string; runsDir: string; approved: readonly ApprovedRelease[]; keys?: readonly ReleaseKey[] }): number {
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
    const state = matchRelease({ state: "ok", manifest: m, digest: v.digest }, opts.approved, opts.keys).state;
    const token = releaseSignatureToken({ catalogue: m.catalogue, version: m.version, digest: v.digest }, opts.approved, opts.keys ?? []);
    const runs = new Set<string>();
    for (const s of m.skills) for (const n of locked.get(`${s.id}@${s.version} ${s.digest}`) ?? []) runs.add(n);
    const n = m.skills.length;
    out(`RELEASE ${name} ${v.digest} ${state}${token ? ` ${token}` : ""} ${n} skill${n === 1 ? "" : "s"}, ${runs.size ? `locked by ${runs.size} run${runs.size === 1 ? "" : "s"}` : "not locked by any run"}${state === "approved" ? " (source catalogue)" : ""}`);
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
export function releaseVerify(dir: string, out: (line: string) => void, approved: readonly ApprovedRelease[], keys: readonly ReleaseKey[] = []): number {
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
  const token = releaseSignatureToken({ catalogue: m.catalogue, version: m.version, digest: v.digest }, approved, keys);
  out(`${matchRelease({ state: "ok", manifest: m, digest: v.digest }, approved, keys).state === "approved" ? "APPROVED" : "NOT-APPROVED"}${token ? ` ${token}` : ""}`);
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
