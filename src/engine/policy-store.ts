import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, fchmodSync, lstatSync, mkdirSync, openSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { appendAuditLocked, prepareAuditLocked } from "../auth/audit.js";
import { dataHome, StoreError, withAuthLock } from "../auth/store.js";
import { PolicyIdentitySchema } from "../evidence/identity.js";
import { BASELINE_POLICY_ID } from "../policy/baseline.js";
import { policyPackSha256 } from "../policy/evaluate.js";
import { parsePolicyPack } from "../policy/parse.js";
import type { PolicyPack } from "../policy/schema.js";
import { loadPolicyPacks, MAX_PACK_BYTES, POLICY_FOLDER, readPolicyFile } from "./policy-hooks.js";

/**
 * The last-known-good copy of each mandatory overlay: saved at every start of a run for a pack that loaded, and put back
 * by `scf policy restore`. The SHA-256 in the copy is not a signature: it catches a change by mistake, not an attacker
 * who can already write to the policies folder.
 */

export const LAST_KNOWN_GOOD = "last-known-good";
export const lastKnownGoodFile = (home: string, id: string): string => join(home, POLICY_FOLDER, LAST_KNOWN_GOOD, `${id}.json`);

const idSchema = PolicyIdentitySchema.shape.id;
const validId = (id: string): boolean => idSchema.safeParse(id).success && id !== BASELINE_POLICY_ID;
const realFolder = (path: string): boolean => lstatSync(path).isDirectory();
export const randomTmp = (dir: string, name: string): string => join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);

/** Opens `tmp` (new, mode 0600) and writes `text` to it. */
export function writeTmp(tmp: string, text: string): void {
  const fd = openSync(tmp, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const buf = Buffer.from(text, "utf8");
    let done = 0;
    while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done);
  } finally {
    closeSync(fd);
  }
}

/** A temp file with a random name, then one rename; the temp file is gone on every path. */
function writeAtomic(file: string, text: string): void {
  const tmp = randomTmp(dirname(file), basename(file));
  try {
    writeTmp(tmp, text);
    renameSync(tmp, file);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
  }
}

/** Saves the copy of a valid mandatory pack. Never throws; one "!" line when it cannot be saved. */
export function saveLastKnownGood(home: string, id: string, pack: PolicyPack, log: (l: string) => void): void {
  const fail = (): void => {
    try {
      log(`! policy ${id}: the last-known-good copy could not be saved`);
    } catch {
      // a failing logger must not stop the run
    }
  };
  try {
    if (!validId(id) || pack.policy.id !== id) return fail();
    const dir = join(home, POLICY_FOLDER, LAST_KNOWN_GOOD);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (!realFolder(dir)) throw new Error("not a folder");
    if ((lstatSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    const record = { version: 1, id, savedAt: new Date().toISOString(), policyPackSha256: policyPackSha256(pack), pack };
    writeAtomic(join(dir, `${id}.json`), JSON.stringify(record));
  } catch {
    fail();
  }
}

const LastKnownGoodSchema = z
  .object({ version: z.literal(1), id: z.string(), savedAt: z.iso.datetime(), policyPackSha256: z.string().regex(/^[0-9a-f]{64}$/), pack: z.unknown() })
  .strict();

export type LastKnownGoodRead = { ok: true; pack: PolicyPack; sha256: string; text: string } | { ok: false; reason: string };

/** Reads and checks the copy of `id`. The reasons name no machine path and no content. */
export function readLastKnownGood(id: string, home: string): LastKnownGoodRead {
  const what = `the last-known-good copy of policy ${id}`;
  const no = (reason: string): LastKnownGoodRead => ({ ok: false, reason });
  const dir = join(home, POLICY_FOLDER, LAST_KNOWN_GOOD);
  try {
    if (!realFolder(dir)) return no(`${what} is a link or not a plain file`);
  } catch (e) {
    return no((e as NodeJS.ErrnoException).code === "ENOENT" ? `there is no last-known-good copy of policy ${id}` : `${what} could not be read`);
  }
  const read = readPolicyFile(lastKnownGoodFile(home, id), 2 * MAX_PACK_BYTES);
  if ("problem" in read) {
    if (read.problem === "missing") return no(`there is no last-known-good copy of policy ${id}`);
    if (read.problem === "not-file") return no(`${what} is a link or not a plain file`);
    if (read.problem === "too-large") return no(`${what} is larger than 2 MiB`);
    return no(`${what} could not be read`);
  }
  let pack: PolicyPack;
  let stored: string;
  try {
    const record = LastKnownGoodSchema.parse(JSON.parse(read.text));
    pack = parsePolicyPack(record.pack);
    stored = record.policyPackSha256;
    if (record.id !== id || pack.policy.id !== id || pack.mode !== "observe") return no(`${what} is not valid`);
  } catch {
    return no(`${what} is not valid`);
  }
  const changed = no(`${what} has been changed: its SHA-256 does not match`);
  const sha = policyPackSha256(pack);
  if (sha !== stored) return changed;
  const text = JSON.stringify(pack);
  if (Buffer.byteLength(text) > MAX_PACK_BYTES) return no(`${what} is larger than 1 MiB as compact JSON`);
  try {
    if (policyPackSha256(parsePolicyPack(JSON.parse(text))) !== sha) return changed;
  } catch {
    return no(`${what} is not valid`);
  }
  return { ok: true, pack, sha256: sha, text };
}

export type RestoreResult = { ok: true; sha256: string; kept?: string } | { ok: false; reason: string };

const backupStamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");

/**
 * Puts the copy back as policies/<id>.json under the data-folder lock. The replaced entry is kept as
 * <id>.json.replaced-<time>; the active file is only ever replaced by one rename. Uses dataHome(), like the lock and the audit log.
 */
export function restorePolicy(id: string, o: { force?: boolean; now?: () => Date } = {}): RestoreResult {
  if (!idSchema.safeParse(id).success) return { ok: false, reason: `${JSON.stringify(id)} is not a policy id: use lower-case letters, digits, . _ or -` };
  if (id === BASELINE_POLICY_ID) return { ok: false, reason: `${BASELINE_POLICY_ID} is built in: there is nothing to restore` };
  const now = o.now ?? (() => new Date());
  let committed: RestoreResult | undefined;

  const locked = (): RestoreResult => {
    const home = dataHome();
    const dir = join(home, POLICY_FOLDER);
    const cur = join(dir, `${id}.json`);
    const refuse = (reason: string): RestoreResult => {
      try {
        appendAuditLocked("cli", { action: "policy-restore", result: "failed", target: id });
      } catch {
        // best effort
      }
      return { ok: false, reason };
    };
    const r = readLastKnownGood(id, home);
    if (!r.ok) return refuse(r.reason);
    let st: Stats | undefined;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return refuse(`policies/${id}.json could not be checked; nothing was restored`);
    }
    if (st) {
      if (st.isDirectory()) return refuse(`policies/${id}.json is a folder; nothing was restored`);
      if (!st.isFile() && !st.isSymbolicLink()) return refuse(`policies/${id}.json is not a plain file or a link; nothing was restored`);
      if (!o.force && "pack" in loadPolicyPacks([id], home)[0]!) return refuse(`policies/${id}.json is valid; add --force to replace it`);
    }
    let log;
    try {
      log = prepareAuditLocked("cli", { action: "policy-restore", result: "ok", target: id });
    } catch {
      return refuse("the audit log could not be opened; nothing was restored");
    }
    let tmp: string | undefined;
    let backup: string | undefined;
    try {
      try {
        tmp = randomTmp(dir, `${id}.json`);
        writeTmp(tmp, r.text);
        if (st) {
          for (let n = 0; ; n++) {
            const name = `${id}.json.replaced-${backupStamp(now())}${n ? `-${n}` : ""}`;
            try {
              if (st.isSymbolicLink()) symlinkSync(readlinkSync(cur), join(dir, name));
              else copyFileSync(cur, join(dir, name), constants.COPYFILE_EXCL);
              backup = name;
              break;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            }
          }
        }
        renameSync(tmp, cur);
        tmp = undefined;
      } catch {
        if (tmp) {
          try {
            rmSync(tmp, { force: true });
          } catch {
            // left behind
          }
        }
        if (backup) {
          try {
            rmSync(join(dir, backup), { force: true });
          } catch {
            // left behind
          }
        }
        return refuse(`policies/${id}.json could not be replaced; nothing was restored`);
      }
      try {
        log.write();
      } catch {
        return { ok: false, reason: `policy ${id} was restored, but its audit line could not be written` };
      }
      return { ok: true, sha256: r.sha256, ...(backup ? { kept: backup } : {}) };
    } finally {
      try {
        log.close();
      } catch {
        // already closed
      }
    }
  };

  try {
    return withAuthLock(() => (committed = locked()));
  } catch (e) {
    if (committed) return committed;
    if (e instanceof StoreError && e.kind === "locked") return { ok: false, reason: "another scf command holds the data-folder lock; try again" };
    return { ok: false, reason: "the data folder could not be locked; nothing was restored" };
  }
}
