import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyRunEvidence, type VerifyResult } from "./verify.js";

export const EVIDENCE_USAGE = `usage: scf evidence verify <run-id> [--json] [--runs-dir <dir>]
       Check the evidence of a run: the manifest, the chain of events and the files they name.
       Exit code 0: verified. 1: not verified. 2: nothing to verify (no evidence, or the run has not ended).`;

/** The lines a person reads. */
export function verifyReport(r: VerifyResult): string[] {
  const mark = r.status === "verified" ? "✔ verified" : r.status === "failed" ? "✘ not verified" : r.status === "not-finalized" ? "■ not finalized" : "· no evidence";
  const out = [`${mark} · run ${r.runId}`, `  ${r.explanation}`];
  if (r.failure) out.push(`  check:     ${r.failure.check} (${r.failure.code})`);
  if (r.events) out.push(`  events:    ${r.events.count}${r.events.terminalHash ? `, last hash ${r.events.terminalHash}` : ""}`);
  if (r.manifest) out.push(`  manifest:  sha256 ${r.manifest.sha256} (${r.manifest.status}, written ${r.manifest.finalizedAt})`);
  for (const f of r.files) if (f.state !== "ok") out.push(`  file:      ${f.path} — ${f.state}${f.required ? "" : " (optional)"}`);
  return out;
}

/** The exit code of a result: 0 verified, 1 a check failed, 2 nothing to verify yet. */
export const verifyExitCode = (r: VerifyResult): number => (r.status === "verified" ? 0 : r.status === "failed" ? 1 : 2);

/**
 * `scf evidence verify <run-id>`. Reads the run folder only: no server, no model, no network, and nothing is written.
 * Prints through `out`; returns the exit code.
 */
export function evidenceCommand(positionals: string[], o: { runsDir: string; json?: boolean }, out: (line: string) => void): number {
  const [sub, runId, ...rest] = positionals;
  if (sub !== "verify" || !runId || rest.length) throw new Error(EVIDENCE_USAGE);
  // the id is the name of a folder under the runs folder, and nothing else
  if (!/^[\w-]{1,128}$/.test(runId)) throw new Error("a run id has only letters, digits, _ and -");
  const runDir = join(o.runsDir, runId);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new Error(`run ${runId} not found`);
  const result = verifyRunEvidence(runDir, runId);
  if (o.json) out(JSON.stringify(result, null, 2));
  else for (const line of verifyReport(result)) out(line);
  return verifyExitCode(result);
}
