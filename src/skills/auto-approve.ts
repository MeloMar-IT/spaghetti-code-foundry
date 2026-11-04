import { DETAIL_MAX, prepareAuditLocked, writeAudit, type PreparedAudit } from "../auth/audit.js";
import { StoreError, withAuthLock } from "../auth/store.js";
import type { Config } from "../config.js";
import { MAX_RELEASES_PER_SOURCE, approvedReleases, updateSourceApprovals } from "./approvals.js";
import type { ApprovedRelease } from "./release.js";
import { readSigningKey } from "./release-cli.js";
import { approvalSignatureState, rawPublicKey, signApproval } from "./release-signature.js";
import { listStoredReleases } from "./release-store.js";
import { verifyRelease } from "./release-verify.js";
import { SKILL_ID_RE, SKILL_VERSION_RE } from "./schema.js";
import type { SkillLibrarySource } from "./sources.js";

// Approves a catalogue release of an `update.auto` first-party source in the data folder (skill-approvals.json) and, when
// skills.releases.keys is set, signs the approval with the server key skills.releases.auto_key. Nothing here deletes a release.
// Order: checks, signature, audit log opened (a log that cannot be opened stops it), store entry written, audit line written.

export interface AutoApproveInput {
  sourceId: string;
  catalogue: string;
  version: string;
}
export interface AutoApproveOptions {
  releases: Config["skills"]["releases"];
  sources: readonly SkillLibrarySource[];
  /** The audit actor: "cli" (default), "monitor" or an account id. */
  by?: string;
  /** Receives fixed-word lines about problems that are not in the result. */
  log?: (line: string) => void;
}
export type AutoApproveResult =
  | { state: "approved" | "unchanged"; entry: ApprovedRelease; notes: string[] }
  | { state: "refused"; reason: string; notes: string[] };

/** Test hook: runs just before the audit line is written. */
export const autoApproveSettings: { beforeAuditWrite?: () => void } = {};

const key = (a: { catalogue: string; version: string }) => `${a.catalogue}@${a.version}`;

export function approveAutoRelease(input: AutoApproveInput, opts: AutoApproveOptions): AutoApproveResult {
  const by = opts.by ?? "cli";
  const target = SKILL_ID_RE.test(input.catalogue) && SKILL_VERSION_RE.test(input.version) ? key(input) : "invalid release";
  const notes: string[] = [];
  const refuse = (reason: string, audit = true): AutoApproveResult => {
    if (audit) {
      try {
        writeAudit(by, { action: "skill-auto-approve", result: "failed", target, detail: reason.slice(0, DETAIL_MAX) }, 0);
      } catch {
        // best effort
      }
    }
    return { state: "refused", reason, notes };
  };

  // 1. Input and source.
  if (!SKILL_ID_RE.test(input.sourceId) || !SKILL_ID_RE.test(input.catalogue) || !SKILL_VERSION_RE.test(input.version)) {
    return refuse("the source id, catalogue id or version is not valid");
  }
  const source = opts.sources.find((s) => s.id === input.sourceId);
  if (!source || source.status !== "enabled" || source.trust !== "first-party" || source.update.auto !== true) {
    return refuse(`source ${input.sourceId} is not an enabled first-party source with update.auto`);
  }

  // 2. The release in the store, and where it comes from.
  const stored = listStoredReleases().releases.find((r) => r.catalogue === input.catalogue && r.version === input.version);
  if (!stored) return refuse(`release ${target} is not in the release store`);
  const verified = verifyRelease(stored.dir);
  if (!verified.ok) return refuse(`release ${target} does not verify: ${verified.reason}`);
  const m = verified.manifest;
  if (m.catalogue !== input.catalogue || m.version !== input.version) return refuse(`the release folder does not hold ${target}`);
  if (!m.skills.every((s) => s.provenance.repositoryKey === source.repositoryKey && s.provenance.trust === "first-party")) {
    return refuse(`release ${target} holds content that is not from source ${source.id}`);
  }
  const base = { catalogue: input.catalogue, version: input.version, digest: verified.digest };

  // 3. Conflicts and repeats, before anything is signed.
  const inConfig = opts.releases.approved.filter((a) => key(a) === target);
  if (inConfig.some((a) => a.digest !== base.digest)) return refuse(`${target} is approved with another digest in skills.releases.approved`);
  const known = approvedReleases(opts.releases);
  if (known.conflicts.has(target)) return refuse(`${target} is approved with different digests`);
  if (inConfig.length > 0) return { state: "unchanged", entry: inConfig[0]!, notes };

  // 4. Signature.
  let entry: ApprovedRelease = base;
  const keys = opts.releases.keys;
  if (keys.length > 0) {
    const ak = opts.releases.auto_key;
    if (!ak) return refuse("skills.releases.keys is set but skills.releases.auto_key is not");
    const pub = keys.find((k) => k.id === ak.id);
    if (!pub) return refuse(`"${ak.id}" is not in skills.releases.keys`);
    const priv = readSigningKey(ak.file);
    if (typeof priv === "string") return refuse(priv);
    if (rawPublicKey(priv) !== pub.ed25519) return refuse(`the auto_key file does not hold the key ${ak.id}`);
    entry = { ...base, key: ak.id, signature: signApproval(base, priv) };
    if (approvalSignatureState(entry, keys).state !== "signed") return refuse("the signature does not verify");
  }

  // 5. Audit first, then the store, then the audit line.
  const at = new Date().toISOString();
  let result: AutoApproveResult | undefined;
  let refusedInside: string | undefined;
  let auditOpenFailed = false;
  try {
    withAuthLock(() => {
      let prepared: PreparedAudit;
      try {
        prepared = prepareAuditLocked(by, {
          action: "skill-auto-approve",
          result: "ok",
          target,
          detail: `source ${source.id} digest ${base.digest} key ${entry.key ?? "none"}`,
        });
      } catch {
        auditOpenFailed = true;
        return;
      }
      try {
        const written = updateSourceApprovals(
          (cur) => {
            for (const s of Object.values(cur)) {
              for (const r of s.releases) {
                if (key(r) === target && r.digest !== base.digest) {
                  refusedInside = `${target} is approved with another digest in skill-approvals.json`;
                  return undefined;
                }
              }
            }
            if (opts.releases.approved.some((a) => key(a) === target && a.digest !== base.digest)) {
              refusedInside = `${target} is approved with another digest in skills.releases.approved`;
              return undefined;
            }
            const mine = cur[source.id];
            if (mine && mine.repositoryKey !== source.repositoryKey) {
              refusedInside = `skill-approvals.json holds approvals for source ${source.id} from another repository`;
              return undefined;
            }
            // The same release with the same signing fields is a repeat. Anything else (unsigned to signed, another key) replaces the entry.
            const old = mine?.releases.find((r) => key(r) === target);
            if (old && old.key === entry.key && old.signature === entry.signature) return undefined;
            const kept = mine?.releases.filter((r) => key(r) !== target) ?? [];
            if (kept.length >= MAX_RELEASES_PER_SOURCE) {
              refusedInside = `skill-approvals.json holds ${MAX_RELEASES_PER_SOURCE} releases for this source`;
              return undefined;
            }
            cur[source.id] = {
              repositoryKey: source.repositoryKey,
              ...(mine?.ref ? { ref: mine.ref } : {}),
              releases: [...kept, { ...entry, at }],
            };
            return cur;
          },
          { claimed: true },
        );
        if (refusedInside !== undefined) return;
        if (written === "unchanged") {
          result = { state: "unchanged", entry, notes };
          return;
        }
        result = { state: "approved", entry, notes };
        try {
          autoApproveSettings.beforeAuditWrite?.();
          prepared.write();
        } catch {
          notes.push("the approval is not in the audit log");
          opts.log?.("audit: audit.jsonl not-written (skill-auto-approve)");
        }
      } finally {
        prepared.close();
      }
    }, 0);
  } catch (e) {
    if (e instanceof StoreError) {
      const reason = `skill-approvals.json ${e.kind}`;
      return refuse(reason);
    }
    throw e;
  }
  if (auditOpenFailed) return refuse("the audit log cannot be written; nothing was approved", false);
  if (refusedInside !== undefined) return refuse(refusedInside);
  return result ?? refuse("nothing was approved");
}
