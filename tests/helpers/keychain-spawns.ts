// The record of the Keychain tool starts of the test process. tests/setup-keychain.ts fills and checks it.
// No vitest import here: the browser harness loads this outside vitest.
import { basename, dirname } from "node:path";
import type { KeychainTestBackend } from "../../src/credentials/keychain.js";

let spawns: string[] = [];
const toolBins = new Set<string>();
let standIn: KeychainTestBackend | undefined;

/** The in-process answer for the stand-in tool of tests/setup.ts: `remove()` of a fake goes back to it. */
export const setStandInBackend = (backend: KeychainTestBackend) => void (standIn = backend);
export const standInBackend = () => standIn;

export const recordSpawn = (bin: string) => void spawns.push(bin);

/** Allows the tool path of a fake that is meant to run as a process. */
export const allowToolBin = (bin: string) => void toolBins.add(bin);

/** Returns and clears the record; for a test that asserts its own tool starts. */
export function takeToolSpawns(): string[] {
  const taken = spawns;
  spawns = [];
  return taken;
}

/** The one exception: the failing script that tests/repos.test.ts writes itself. */
const isException = (testPath: string, bin: string) => testPath.endsWith("/tests/repos.test.ts") && basename(dirname(bin)).startsWith("bad-security-");

export const unexpectedSpawns = (testPath: string): string[] => spawns.filter((bin) => !toolBins.has(bin) && !isException(testPath, bin));
