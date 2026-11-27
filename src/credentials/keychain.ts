import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export const KEYCHAIN_SERVICE = "claude-factory-credential-key";
const TIMEOUT_MS = 10_000;

export type KeyErrorCode = "missing" | "failed" | "unsupported" | "wrong-key";

/** A problem with the master key. The message never holds the key or a secret. */
export class KeyError extends Error {
  constructor(
    public code: KeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

/** `SCF_SECURITY_BIN` replaces the macOS tool (for tests). Without it only macOS is supported. */
function securityBin(): string {
  const bin = process.env.SCF_SECURITY_BIN;
  if (bin) return bin;
  if (process.platform !== "darwin") throw new KeyError("unsupported", "stored credentials need the macOS Keychain; other systems are not supported yet");
  return "/usr/bin/security";
}

/**
 * Runs the tool. `detached` gives it no controlling terminal, so a password prompt reads stdin.
 * The arguments never hold the key (it goes through stdin).
 */
function security(args: string[], input?: string) {
  // `detached` is honoured by spawnSync but missing from its type
  const options = { input, encoding: "utf8", detached: true, timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] } as SpawnSyncOptionsWithStringEncoding;
  const r = spawnSync(securityBin(), args, options);
  if (r.error) throw new KeyError("failed", `the Keychain tool could not run (${(r.error as NodeJS.ErrnoException).code ?? "error"})`);
  return r;
}

const NOT_FOUND = 44;

/** What the tool prints for an item (with its newline), or undefined when there is no such item. */
function readItem(service: string, account: string, problem: string): string | undefined {
  const r = security(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (r.status === NOT_FOUND) return undefined;
  if (r.status !== 0) throw new KeyError("failed", problem);
  return r.stdout ?? "";
}

/** Adds or replaces an item. `-w` is last, so the tool asks for the value (twice) and reads it from stdin. */
function writeItem(service: string, account: string, value: string, problem: string): void {
  const r = security(["add-generic-password", "-U", "-s", service, "-a", account, "-w"], `${value}\n${value}\n`);
  if (r.status !== 0) throw new KeyError("failed", problem);
}

/** True when an item was removed, false when there was none. */
function removeItem(service: string, account: string, problem: string): boolean {
  const r = security(["delete-generic-password", "-s", service, "-a", account]);
  if (r.status === NOT_FOUND) return false;
  if (r.status !== 0) throw new KeyError("failed", problem);
  return true;
}

const UNREADABLE = "the Keychain could not be read (is the login keychain locked?)";

/** The value of a generic password item, or undefined when there is no such item. */
export function findItem(service: string, account: string): string | undefined {
  const out = readItem(service, account, UNREADABLE);
  if (out === undefined) return undefined;
  const value = out.replace(/\n$/, "");
  if (!value) throw new KeyError("failed", UNREADABLE);
  return value;
}

/** Stores a one-line value and reads it back; an item that does not hold it is removed again. */
export function addItem(service: string, account: string, value: string): void {
  if (!value || /[\r\n]/.test(value)) throw new KeyError("failed", "the Keychain can only be given a value of one line");
  writeItem(service, account, value, "the Keychain did not accept the value");
  if (findItem(service, account) !== value) {
    try {
      deleteItem(service, account);
    } catch {
      // best effort
    }
    throw new KeyError("failed", "the Keychain item does not hold the value that was written");
  }
}

/** Removes an item: true when it did, false when there was none. */
export function deleteItem(service: string, account: string): boolean {
  return removeItem(service, account, "the Keychain did not remove the item");
}

/** The key (64 hex digits) of an item, or undefined when there is no such item. */
export function findKey(keyId: string): string | undefined {
  const problem = "the Keychain did not give the credential key (is the login keychain locked?)";
  const out = readItem(KEYCHAIN_SERVICE, keyId, problem);
  if (out === undefined) return undefined;
  const key = out.trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new KeyError("failed", problem);
  return key;
}

/** Stores the key as a new item and reads it back; a wrong write contract is an error here, never a silent leak. */
export function addKey(keyId: string, keyHex: string): void {
  writeItem(KEYCHAIN_SERVICE, keyId, keyHex, "the Keychain did not accept the credential key");
  if (findKey(keyId) !== keyHex) {
    try {
      deleteKey(keyId);
    } catch {
      // best effort
    }
    throw new KeyError("failed", "the Keychain item does not hold the key that was written");
  }
}

/** Removes an item. An item that is already gone is fine. */
export function deleteKey(keyId: string): void {
  removeItem(KEYCHAIN_SERVICE, keyId, "the Keychain did not remove the old credential key");
}
