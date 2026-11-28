// Fails a test file whose own process starts a Keychain tool that it should not: fakeKeychain() answers in-process.
import { afterAll, expect } from "vitest";
import { setKeychainSpawnObserverForTests } from "../src/credentials/keychain.js";
import { recordSpawn, unexpectedSpawns } from "./helpers/keychain-spawns.js";

setKeychainSpawnObserverForTests(recordSpawn);

afterAll(() => {
  expect(unexpectedSpawns(expect.getState().testPath ?? ""), "unexpected Keychain tool starts in the test process (see tests/helpers/keychain.ts)").toEqual([]);
});
