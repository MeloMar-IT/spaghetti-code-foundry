import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicyPack } from "./parse.js";
import type { PolicyPack } from "./schema.js";
import { POLICY_PACK_VERSION } from "./version.js";

/**
 * The baseline pack: built in, owned by the Foundry, asked at every boundary of every run in observe mode.
 * Admins cannot replace it; they can only add stricter packs (see compose.ts).
 * The one file in src/policy/ that reads a file: package.json, once, for the version.
 */

export const BASELINE_POLICY_ID = "foundry.baseline";

/** The baseline pack for a given version (pure). */
export function baselinePack(version: string): PolicyPack {
  return {
    version: POLICY_PACK_VERSION,
    policy: { id: BASELINE_POLICY_ID, version },
    mode: "observe",
    defaultOutcome: "allow",
    rules: [
      { id: "secret-detected", boundaries: ["push"], when: { secretsFound: { over: 0 } }, outcome: "deny", reasonCode: "secret.detected", mode: "observe" },
      { id: "identity-missing", boundaries: ["push"], when: { commitIdentity: false }, outcome: "deny", reasonCode: "identity.missing", mode: "observe" },
      { id: "sandbox-required", boundaries: ["agent.write"], when: { owner: { in: ["user"] }, sandboxed: false }, outcome: "deny", reasonCode: "sandbox.required", mode: "observe" },
      { id: "workspace-admin-only", boundaries: ["run.start"], when: { owner: { in: ["user"] }, workspace: { in: ["inplace"] } }, outcome: "deny", reasonCode: "workspace.admin-only", mode: "observe" },
    ],
  } as PolicyPack;
}

function readVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const v = (JSON.parse(readFileSync(join(dir, "../../package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(v) ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/** The baseline of this build: version = package.json "version", or "unknown". */
export const BASELINE_PACK: PolicyPack = parsePolicyPack(baselinePack(readVersion()));
