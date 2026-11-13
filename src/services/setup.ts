import { verify } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { createServiceAccount, getServiceAccount, revokeServiceToken, rotateServiceToken, updateServiceAccount } from "../auth/service-accounts.js";
import { dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { deleteUser } from "../auth/users.js";
import { serviceCommandProblem } from "../config.js";
import { decodeBase64Exact, ed25519PublicKey } from "../skills/release-signature.js";

/** A start that cannot go on, with a fixed sentence (no path, no secret) that the Health page may show. */
export class ServiceProblem extends Error {}

export const MAX_PROGRAM_BYTES = 256 * 1024 * 1024;
const MAX_SIG_BYTES = 1024;
const MAP_NAME = "services-accounts.json";

/** Which account belongs to which service. Next to users.json, never in it, so an older build still reads users.json. */
const MapSchema = z.object({ version: z.literal(1), accounts: z.record(z.string(), z.string()) }).strict();
type AccountMap = z.infer<typeof MapSchema>;
const mapPath = () => join(dataHome(), MAP_NAME);
const readMap = (): AccountMap => readJsonFile(mapPath(), MapSchema, { version: 1, accounts: {} });

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The real path of the program, or why it cannot be started. */
export function programProblem(command: string, where: { home: string; runsDir: string }): { realPath: string } | { problem: string } {
  const bad = serviceCommandProblem(command, where.home);
  if (bad) return { problem: "the command is not allowed" };
  let realPath: string;
  try {
    realPath = realpathSync(command);
  } catch {
    return { problem: "the program does not exist" };
  }
  const forbidden = [where.runsDir, join(where.home, "runs"), join(dirname(where.runsDir), "workspaces"), join(where.home, "workspaces")].map(real);
  if (forbidden.some((d) => realPath === d || realPath.startsWith(d + sep))) return { problem: "the program is inside the run workspaces" };
  try {
    if (!statSync(realPath).isFile()) return { problem: "the program is not a file" };
    accessSync(realPath, constants.X_OK);
  } catch {
    return { problem: "the program is not a file that can be run" };
  }
  return { realPath };
}

function readLimited(path: string, max: number): Buffer | "missing" | "large" {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "missing";
  }
  try {
    const size = fstatSync(fd).size;
    if (size > max) return "large";
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } catch {
    return "missing";
  } finally {
    closeSync(fd);
  }
}

/** Undefined when `<command>.sig` is a valid Ed25519 signature of the program by the key; else a fixed sentence. */
export function signatureProblem(command: string, realPath: string, publicKeyB64: string): string | undefined {
  const sigFile = readLimited(`${command}.sig`, MAX_SIG_BYTES);
  if (sigFile === "missing") return "the signature file is missing";
  if (sigFile === "large") return "the signature file is not a valid Ed25519 signature";
  const sig = sigFile.length === 64 ? sigFile : decodeBase64Exact(sigFile.toString("utf8").trim(), 64);
  if (!sig) return "the signature file is not a valid Ed25519 signature";
  const bytes = readLimited(realPath, MAX_PROGRAM_BYTES);
  if (bytes === "large") return "the program is too large to check";
  if (bytes === "missing") return "the program does not exist";
  const raw = decodeBase64Exact(publicKeyB64, 32);
  try {
    if (raw && verify(null, bytes, ed25519PublicKey(raw), sig)) return undefined;
  } catch {
    // falls through
  }
  return "the signature does not match the program";
}

const ACCOUNT = "the service account cannot be used";

/**
 * The managed account of a service with a fresh token (the old one is dead). The account is made when it is missing; the
 * mapping file records it. An account the mapping does not know is never taken over.
 */
export function serviceToken(name: string, scope: string[]): { accountId: string; token: string } {
  let map: AccountMap;
  try {
    map = readMap();
  } catch {
    throw new ServiceProblem("the list of service accounts cannot be read");
  }
  const known = map.accounts[name];
  const account = known ? getServiceAccountSafe(known) : undefined;
  try {
    if (account) {
      if (account.status !== "active") throw new ServiceProblem("the service account is blocked");
      if (account.scope.length !== scope.length || account.scope.some((k, i) => k !== scope[i])) updateServiceAccount(account.id, { scope });
      const r = rotateServiceToken(account.id);
      return { accountId: account.id, token: r.token! };
    }
    let made;
    try {
      made = createServiceAccount({ name, scope });
    } catch {
      throw new ServiceProblem("a service account with that name exists already, or the account cannot be made");
    }
    try {
      withAuthLock(() => writeJsonFile(mapPath(), { version: 1, accounts: { ...map.accounts, [name]: made.account.id } }));
    } catch {
      try {
        deleteUser(made.account.id);
      } catch {
        // a retry then reports the name as taken; the admin can delete the account
      }
      throw new ServiceProblem("the list of service accounts cannot be written");
    }
    return { accountId: made.account.id, token: made.token! };
  } catch (e) {
    if (e instanceof ServiceProblem) throw e;
    throw new ServiceProblem(ACCOUNT);
  }
}

function getServiceAccountSafe(id: string) {
  try {
    return getServiceAccount(id);
  } catch {
    throw new ServiceProblem("the list of service accounts cannot be read");
  }
}

/** Revokes the token of an account; false on any error (a missing account, a store that cannot be written). */
export function revokeServiceTokenSafe(id: string): boolean {
  try {
    revokeServiceToken(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * At server start: revokes the live token of every managed account (a retained service gets a new one at launch; a service
 * no longer configured stays revoked). A no-op when no mapping file exists. Returns false when something could not be done.
 */
export function reconcileServiceTokens(): boolean {
  let map: AccountMap;
  try {
    map = readMap();
  } catch {
    return false;
  }
  let ok = true;
  for (const id of Object.values(map.accounts)) if (!revokeServiceTokenSafe(id)) ok = false;
  return ok;
}

/** Whether earlier managed-service state exists. */
export function hasServiceState(): boolean {
  try {
    statSync(mapPath());
    return true;
  } catch {
    return false;
  }
}

/** The ids of the managed accounts by service name (empty without state). */
export function managedAccounts(): Record<string, string> {
  try {
    return readMap().accounts;
  } catch {
    return {};
  }
}
