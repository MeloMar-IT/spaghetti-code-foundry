import { endBreakGlass, startBreakGlass } from "./policy-break-glass.js";
import { restorePolicy } from "./policy-store.js";

export const POLICY_USAGE = `usage: scf policy restore <id> [--force]   Put back the last-known-good copy of a mandatory policy overlay
       scf policy break-glass --reason "<text>" --for <n>m|<n>h   Start a time-limited, audited break-glass
       scf policy break-glass --end   End the break-glass now`;

/** `scf policy restore <id> [--force]` and `scf policy break-glass`. Returns the exit code; wrong arguments throw the usage. */
export function policyCommand(
  positionals: string[],
  o: { force?: boolean; reason?: string; for?: string; end?: boolean },
  out: (line: string) => void,
): number {
  const [sub, id, ...rest] = positionals;
  if (sub === "break-glass") {
    if (id !== undefined || rest.length || o.force) throw new Error(POLICY_USAGE);
    if (o.end) {
      if (o.reason !== undefined || o.for !== undefined) throw new Error(POLICY_USAGE);
      const r = endBreakGlass();
      if (!r.ok) {
        out(`✘ ${r.reason}`);
        return 1;
      }
      out("✔ break-glass ended");
      if (r.detail === "expired") out("  it had already expired");
      if (r.detail === "invalid") out("  the file was not valid; it was removed");
      return 0;
    }
    const r = startBreakGlass({ reason: o.reason, for: o.for });
    if (!r.ok) {
      out(`✘ ${r.reason}`);
      return 1;
    }
    out(`✔ break-glass active until ${r.expiresAt}`);
    out("  end it early with: scf policy break-glass --end");
    return 0;
  }
  if (sub !== "restore" || !id || rest.length || o.reason !== undefined || o.for !== undefined || o.end) throw new Error(POLICY_USAGE);
  const r = restorePolicy(id, { force: o.force === true });
  if (!r.ok) {
    out(`✘ ${r.reason}`);
    return 1;
  }
  out(`✔ restored policy ${id} (sha256 ${r.sha256})`);
  if (r.kept) out(`  kept the replaced file as policies/${r.kept}`);
  return 0;
}
