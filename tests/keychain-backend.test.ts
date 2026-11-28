import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYCHAIN_SERVICE, KeyError, addKey, deleteKey, findKey, setKeychainBackendForTests, setKeychainSpawnObserverForTests } from "../src/credentials/keychain.js";
import { addCredential, checkKeychain, readSecret, removeCredential } from "../src/credentials/store.js";
import { fakeKeychain, fakeKeychainTool, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { recordSpawn, takeToolSpawns, unexpectedSpawns } from "./helpers/keychain-spawns.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);

let kc: FakeKeychain | undefined;
let home: string;
let oldHome: string | undefined;
const dirs: string[] = [];

beforeEach(() => {
  takeToolSpawns(); // a failed try leaves its records behind; each test asserts only its own, so a retry can pass
  oldHome = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "keychain-backend-"));
  process.env.FACTORY_HOME = home;
});

afterEach(() => {
  kc?.remove();
  kc = undefined;
  process.env.FACTORY_HOME = oldHome;
  for (const d of [home, ...dirs.splice(0)]) rmSync(d, { recursive: true, force: true });
});

const caught = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

/** The same calls with fixed ids and keys; one item stays stored. */
function sequence() {
  addKey(OTHER_ID, OTHER_KEY);
  addKey(ID, KEY);
  const found = findKey(ID);
  deleteKey(ID);
  return [found, findKey(ID)];
}

describe("the in-process fake Keychain", () => {
  it("starts no tool for any Keychain call", () => {
    kc = fakeKeychain();
    sequence();
    checkKeychain();
    const c = addCredential({ userId: OWNER, type: "token", name: "t", secret: fakeToken() }, { ownerOk: () => true });
    expect(readSecret(OWNER, c.id)).toBe(fakeToken());
    removeCredential(OWNER, c.id);
    expect(kc.calls().length).toBeGreaterThan(0);
    expect(takeToolSpawns()).toEqual([]);
    expect(kc.toolRuns()).toEqual({ self: 0, children: 0 });
  });

  it("answers for the stand-in of tests/setup.ts too, also after a fake is removed", () => {
    const standIn = process.env.SCF_SECURITY_BIN;
    fakeKeychain().remove();
    expect(process.env.SCF_SECURITY_BIN).toBe(standIn);
    expect(sequence()).toEqual([KEY, undefined]);
    deleteKey(OTHER_ID); // the stand-in is shared by this file: leave it empty
    expect(takeToolSpawns()).toEqual([]);
  });

  it("has the same call log and items as the tool", () => {
    kc = fakeKeychain();
    expect(sequence()).toEqual([KEY, undefined]);
    const inProcess = { calls: kc.calls(), items: kc.items() };
    expect(takeToolSpawns()).toEqual([]);
    kc.remove();

    kc = fakeKeychainTool();
    expect(sequence()).toEqual([KEY, undefined]);
    expect({ calls: kc.calls(), items: kc.items() }).toEqual(inProcess);
    expect(Object.values(inProcess.items)).toEqual([OTHER_KEY]);
    expect(kc.toolRuns()).toEqual({ self: kc.calls().length, children: 0 });
    expect(takeToolSpawns()).toEqual(Array(kc.calls().length).fill(join(kc.dir, "security")));
  });

  it("follows the fail switches and the items file", () => {
    kc = fakeKeychain();
    addKey(ID, KEY);
    kc.fail("find");
    const e = caught(() => findKey(ID));
    expect(e).toBeInstanceOf(KeyError);
    expect((e as KeyError).code).toBe("failed");
    kc.fail("add");
    expect(() => addKey(OTHER_ID, OTHER_KEY)).toThrow(KeyError);
    kc.fail();
    process.env.FAKE_KEYCHAIN_FAIL_ONCE = "delete";
    try {
      expect(() => deleteKey(ID)).toThrow(KeyError);
      deleteKey(ID);
    } finally {
      delete process.env.FAKE_KEYCHAIN_FAIL_ONCE;
    }
    addKey(ID, KEY);
    writeFileSync(kc.file, "{}");
    expect(findKey(ID)).toBeUndefined();
    writeFileSync(kc.file, "not json");
    expect(() => findKey(ID)).toThrow(KeyError);
    expect(takeToolSpawns()).toEqual([]);
    expect(kc.toolRuns()).toEqual({ self: 0, children: 0 });
  });

  it("shares its items with the script a child process runs", () => {
    kc = fakeKeychain();
    addKey(ID, KEY);
    const r = spawnSync(join(kc.dir, "security"), ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ID, "-w"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(KEY);
    expect(kc.toolRuns()).toEqual({ self: 1, children: 0 }); // this test started the script itself, past the seam
    expect(takeToolSpawns()).toEqual([]);
  });

  it("does not answer for another tool path", () => {
    kc = fakeKeychain();
    const missing = join(kc.dir, "missing");
    process.env.SCF_SECURITY_BIN = missing;
    expect(() => findKey(ID)).toThrow("could not run (ENOENT)");
    expect(takeToolSpawns()).toEqual([missing]);
  });

  it("is cleared by remove(), and the observer stays", () => {
    kc = fakeKeychain();
    const bin = join(kc.dir, "security");
    kc.remove();
    // the same path as the removed fake: a backend that was left behind would answer for it
    mkdirSync(kc.dir);
    dirs.push(kc.dir);
    const marker = join(kc.dir, "ran");
    writeFileSync(bin, `#!/bin/sh\n: > "${marker}"\nexit 44\n`, { mode: 0o755 });
    process.env.SCF_SECURITY_BIN = bin;
    try {
      expect(findKey(ID)).toBeUndefined();
    } finally {
      delete process.env.SCF_SECURITY_BIN;
    }
    expect(existsSync(marker)).toBe(true);
    expect(takeToolSpawns()).toEqual([bin]);
  });
});

describe("the spawn guard", () => {
  afterEach(() => void takeToolSpawns());

  it("reports a fake used in-process and any other path", () => {
    kc = fakeKeychain();
    const bins = [join(kc.dir, "security"), "/somewhere/security"];
    bins.forEach(recordSpawn);
    expect(unexpectedSpawns("/repo/tests/x.test.ts")).toEqual(bins);
  });

  it("allows the path of fakeKeychainTool()", () => {
    kc = fakeKeychainTool();
    recordSpawn(join(kc.dir, "security"));
    expect(unexpectedSpawns("/repo/tests/x.test.ts")).toEqual([]);
  });

  it("allows the bad-security script only in tests/repos.test.ts", () => {
    const bin = "/tmp/bad-security-abc/security";
    recordSpawn(bin);
    expect(unexpectedSpawns("/repo/tests/repos.test.ts")).toEqual([]);
    expect(unexpectedSpawns("/repo/tests/x.test.ts")).toEqual([bin]);
  });
});

describe("outside a test run", () => {
  it("refuses the test hooks, and Keychain calls go to the tool", () => {
    kc = fakeKeychainTool();
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      const refused = "the Keychain test hooks are for tests only";
      expect(() => setKeychainBackendForTests({ bin: join(kc!.dir, "security"), run: () => ({ status: 0, stdout: KEY }) })).toThrow(refused);
      expect(() => setKeychainSpawnObserverForTests(() => {})).toThrow(refused);
      expect(() => setKeychainBackendForTests(undefined)).not.toThrow();
      expect(() => setKeychainSpawnObserverForTests(undefined)).not.toThrow();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      setKeychainSpawnObserverForTests(recordSpawn);
    }
    expect(findKey(ID)).toBeUndefined();
    expect(kc.toolRuns().self).toBe(1);
    expect(takeToolSpawns()).toEqual([join(kc.dir, "security")]);
  });

  it("accepts the hooks with only NODE_ENV=test", () => {
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
    try {
      expect(() => setKeychainBackendForTests({ bin: "/nowhere", run: () => ({ status: 44, stdout: "" }) })).not.toThrow();
    } finally {
      setKeychainBackendForTests(undefined);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
