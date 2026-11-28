// Fails a test file whose own process starts a Keychain tool that it should not: fakeKeychain() and the stand-in of
// tests/setup.ts answer in-process. Runs after tests/setup.ts (`sequence` in vitest.config.ts).
import { dirname, join } from "node:path";
import { afterAll, expect } from "vitest";
import { setKeychainBackendForTests, setKeychainSpawnObserverForTests } from "../src/credentials/keychain.js";
import { fakeSecurity } from "./fixtures/fake-keychain-core.mjs";
import { recordSpawn, setStandInBackend, standInBackend, unexpectedSpawns } from "./helpers/keychain-spawns.js";

setKeychainSpawnObserverForTests(recordSpawn);

const bin = process.env.SCF_SECURITY_BIN!;
const items = join(dirname(bin), "items.json");
setStandInBackend({ bin, run: (args, input) => fakeSecurity(args, input ?? "", { ...process.env, FAKE_KEYCHAIN_FILE: items }) });
setKeychainBackendForTests(standInBackend());

afterAll(() => {
  expect(unexpectedSpawns(expect.getState().testPath ?? ""), "unexpected Keychain tool starts in the test process (see tests/helpers/keychain.ts)").toEqual([]);
});
