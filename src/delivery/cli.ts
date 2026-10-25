import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `scf delivery validate …`: runs the dependency-free validator script, so the command and a CI job give the same answer. */

export const DELIVERY_USAGE =
  "usage: scf delivery validate --contract <file> --signature <file> --public-key <ssh-ed25519 line or file> [--repo <dir>] [--checks <file>] [--comment <file>] [--events <file>] [--json]\n" +
  "       Check a delivery contract against the checked-out commit. Exit code 0: no stop. 1: a stop. 2: a usage or read error.";

/** Works from `src/delivery/` and from `dist/delivery/`: both are two folders below the repository root. */
export const VALIDATOR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../tools/delivery-validate/validate.mjs");

export interface DeliveryIo {
  out: (chunk: string) => void;
  err: (chunk: string) => void;
}

export function deliveryCommand(args: string[], io: DeliveryIo): number {
  if (args[0] !== "validate") {
    io.err(DELIVERY_USAGE + "\n");
    return 2;
  }
  const r = spawnSync(process.execPath, [VALIDATOR_SCRIPT, ...args.slice(1)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    io.err("delivery-validate: the validator could not be started\n");
    return 2;
  }
  if (r.stdout) io.out(r.stdout);
  if (r.stderr) io.err(r.stderr);
  return r.status ?? 2;
}
