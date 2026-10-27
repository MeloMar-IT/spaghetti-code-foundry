import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VALIDATOR_SCRIPT } from "../delivery/cli.js";

export const VALIDATOR_PREFIX = "scf-delivery-validate-";

/** `scf-delivery-validate-<version>.mjs` */
export function validatorFileName(version: string): string {
  return VALIDATOR_PREFIX + version + ".mjs";
}

/** Runs `node <script> --version` (no shell, empty environment, 10 s) and returns the one `N.N.N` line it prints. */
export function validatorVersion(script: string = VALIDATOR_SCRIPT): string {
  let out = "";
  try {
    out = execFileSync(process.execPath, [script, "--version"], { env: {}, timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    throw new Error("the delivery validator has no usable version", { cause: e });
  }
  const v = out.trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("the delivery validator has no usable version");
  return v;
}

/** Copies the validator into `outDir` and writes `<name>.sha256` (`sha256sum -c` format). Never overwrites a file. */
export function addValidator(outDir: string, script: string = VALIDATOR_SCRIPT): { version: string; name: string; sha256: string } {
  const version = validatorVersion(script);
  const name = validatorFileName(version);
  for (const n of [name, name + ".sha256"]) {
    if (existsSync(join(outDir, n))) throw new Error("the release files already have " + n + "; the Foundry adds it itself");
  }
  copyFileSync(script, join(outDir, name));
  const sha256 = createHash("sha256").update(readFileSync(join(outDir, name))).digest("hex");
  writeFileSync(join(outDir, name + ".sha256"), sha256 + "  " + name + "\n");
  return { version, name, sha256 };
}
