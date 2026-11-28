import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { setKeychainBackendForTests } from "../../src/credentials/keychain.js";
import { resetRedactCache } from "../../src/credentials/redact.js";
import { fakeSecurity } from "../fixtures/fake-keychain-core.mjs";
import { allowToolBin } from "./keychain-spawns.js";

const FAKE = resolve("tests/fixtures/fake-security.mjs");

export interface FakeKeychain {
  dir: string;
  file: string;
  log: string;
  /** The items as `{ "<service>\0<account>": key }`. */
  items(): Record<string, string>;
  /** The lines of the call log (arguments only). */
  calls(): string[][];
  clearLog(): void;
  /** Sets or clears FAKE_KEYCHAIN_FAIL. */
  fail(op?: "find" | "add" | "delete"): void;
  /** How often this fake's script ran: started by this process, or by another one (a child's Keychain call). */
  toolRuns(): { self: number; children: number };
  remove(): void;
}

/** The in-process fake: what the script would do, without starting it. */
function inProcessRun(args: string[], input?: string) {
  try {
    return fakeSecurity(args, input ?? "");
  } catch (e) {
    return { status: 1, stdout: "", stderr: String(e) }; // the script would end with status 1
  }
}

/**
 * Points the credential store at a fake Keychain. Calls of this process are answered in-process; child processes
 * run the fake `security` script on the same files. Call `remove()` when done.
 */
export const fakeKeychain = (): FakeKeychain => setUp(true);

/** Like `fakeKeychain()`, but every call runs the fake `security` script: for tests of the call to the tool. */
export const fakeKeychainTool = (): FakeKeychain => setUp(false);

function setUp(inProcess: boolean): FakeKeychain {
  const dir = mkdtempSync(join(tmpdir(), "fake-keychain-"));
  const bin = join(dir, "security");
  const runs = join(dir, "spawns.log");
  writeFileSync(bin, `#!/bin/sh\necho "$PPID" >> "${runs}"\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const file = join(dir, "items.json");
  const log = join(dir, "calls.log");
  process.env.SCF_SECURITY_BIN = bin;
  process.env.FAKE_KEYCHAIN_FILE = file;
  process.env.FAKE_KEYCHAIN_LOG = log;
  delete process.env.FAKE_KEYCHAIN_FAIL;
  if (inProcess) {
    try {
      setKeychainBackendForTests({ bin, run: inProcessRun });
    } catch {
      // not a test run (the browser harness): the script is used. In vitest the spawn guard would report it.
      setKeychainBackendForTests(undefined);
    }
  } else {
    setKeychainBackendForTests(undefined);
    allowToolBin(bin);
  }
  resetRedactCache();
  return {
    dir,
    file,
    log,
    items: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as string[])
        : [],
    clearLog: () => writeFileSync(log, ""),
    fail: (op) => {
      if (op) process.env.FAKE_KEYCHAIN_FAIL = op;
      else delete process.env.FAKE_KEYCHAIN_FAIL;
    },
    toolRuns: () => {
      const pids = existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean) : [];
      const self = pids.filter((p) => p === String(process.pid)).length;
      return { self, children: pids.length - self };
    },
    remove: () => {
      setKeychainBackendForTests(undefined);
      delete process.env.SCF_SECURITY_BIN;
      delete process.env.FAKE_KEYCHAIN_FILE;
      delete process.env.FAKE_KEYCHAIN_LOG;
      delete process.env.FAKE_KEYCHAIN_FAIL;
      resetRedactCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A token built at run time, so no test file holds a token-shaped string. */
export const fakeToken = (tag = "Zx9") => "ghp_" + tag.repeat(12);

/** A real ed25519 private key in PEM form (LF line ends, final newline). */
export const fakeKey = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/** A PEM-shaped text whose last base64 line has `last` characters. */
export function pemWithLastLine(last: number): string {
  const body = randomBytes(200).toString("base64").replace(/=+$/, "").slice(0, 64 * 2 + last);
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
