import { restorePolicy } from "./policy-store.js";

export const POLICY_USAGE = `usage: scf policy restore <id> [--force]   Put back the last-known-good copy of a mandatory policy overlay`;

/** `scf policy restore <id> [--force]`. Returns the exit code; wrong arguments throw the usage. */
export function policyCommand(positionals: string[], o: { force?: boolean }, out: (line: string) => void): number {
  const [sub, id, ...rest] = positionals;
  if (sub !== "restore" || !id || rest.length) throw new Error(POLICY_USAGE);
  const r = restorePolicy(id, { force: o.force === true });
  if (!r.ok) {
    out(`✘ ${r.reason}`);
    return 1;
  }
  out(`✔ restored policy ${id} (sha256 ${r.sha256})`);
  if (r.kept) out(`  kept the replaced file as policies/${r.kept}`);
  return 0;
}
