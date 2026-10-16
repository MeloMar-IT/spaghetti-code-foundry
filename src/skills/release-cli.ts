import { createPrivateKey, verify, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { matchRelease, type ApprovedRelease } from "./release.js";
import { readReleaseRequests } from "./release-requests.js";
import { approvalText, decodeBase64Exact, ed25519PublicKey, rawPublicKey, releaseSignatureToken, signApproval, type ReleaseKey } from "./release-signature.js";
import { listStoredReleases } from "./release-store.js";
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
  if (operands[0] === "sign" && operands.length === 2) {
    return parseReleaseTarget(operands[1]!) ? undefined : "scf skills release sign: the operand must be <catalogue>@<version>";
  }
  if (operands[0] === "list" && operands.length === 1) return undefined;
  return operands[0] === "verify" && operands.length === 2 ? undefined : 'scf skills release: expects "verify" and one folder, "publish" or "sign" and <catalogue>@<version>, or "list"';
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
