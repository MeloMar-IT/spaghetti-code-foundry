import { dataHome } from "../auth/store.js";
import { COMPONENT_KINDS, componentLine, isCounted, lookupVersions, type ComponentKind, type SeenHash } from "./components.js";
import { promoteCheck } from "./promote.js";
import { readHomeComponents, type ComponentProblem, type FoundComponent } from "./home.js";
import { readVersionBook, recordVersions } from "./versions.js";

export const PROMOTE_USAGE = "usage: scf promote <kind> <id> [--live]";

/** `scf promote <kind> <id> [--live]`: prints one PASSED line per suite that holds and PROMOTABLE, or one BLOCKED line per reason. Read-only. Returns 0 when promotable, else 1. */
export function promoteCommand(positionals: string[], o: { live?: boolean }, out: (line: string) => void): number {
  const [kind, id, ...extra] = positionals;
  if (!kind || !id || extra.length > 0 || !(COMPONENT_KINDS as readonly string[]).includes(kind)) throw new Error(PROMOTE_USAGE);
  const r = promoteCheck(kind as ComponentKind, id, { live: o.live === true });
  for (const l of r.lines) out(l);
  return r.ok ? 0 : 1;
}

export const COMPONENTS_USAGE = `usage: scf components [record] [${COMPONENT_KINDS.join("|")}]`;

/**
 * `scf components [kind]` lists the components of the data folder and changes nothing; a counted component whose hash is
 * not recorded prints `v-` and ` unrecorded`. `scf components record [kind]` gives new hashes a version. Returns the
 * exit code: 1 when any component is a problem.
 */
export function componentsCommand(positionals: string[], out: (line: string) => void, o: { builtinFlowsDir?: string; waitMs?: number } = {}): number {
  const rest = positionals[0] === "record" ? positionals.slice(1) : positionals;
  const record = rest.length < positionals.length;
  if (rest.length > 1 || (rest[0] !== undefined && !(COMPONENT_KINDS as readonly string[]).includes(rest[0]))) throw new Error(COMPONENTS_USAGE);
  const kind = rest[0] as ComponentKind | undefined;

  const { found, problems } = readHomeComponents(dataHome(), { ...(kind ? { kinds: [kind] } : {}), ...(o.builtinFlowsDir ? { builtinFlowsDir: o.builtinFlowsDir } : {}) });
  const counted = found.filter((f): f is FoundComponent & { kind: SeenHash["kind"] } => isCounted(f.kind));
  const seen: SeenHash[] = counted.map((f) => ({ kind: f.kind, id: f.id, sha256: f.sha256 }));

  let versions: (number | undefined)[] = [];
  let failure: string | undefined;
  if (seen.length > 0) {
    if (record) {
      const r = recordVersions(seen, o.waitMs === undefined ? {} : { waitMs: o.waitMs });
      if (r.ok) versions = r.versions;
      else failure = r.reason;
    } else {
      const r = readVersionBook();
      if (r.ok) versions = lookupVersions(r.book, seen);
      else failure = r.reason;
    }
  }

  const all: ComponentProblem[] = [...problems];
  const lines: string[] = [];
  for (const f of found) {
    if (!isCounted(f.kind)) {
      lines.push(componentLine(f, f.builtin ? "builtin" : undefined));
      continue;
    }
    if (failure !== undefined) {
      all.push({ kind: f.kind, id: f.id, reason: failure });
      continue;
    }
    const v = versions[counted.indexOf(f as (typeof counted)[number])];
    lines.push(componentLine({ ...f, ...(v === undefined ? {} : { version: String(v) }) }, v === undefined ? "unrecorded" : undefined));
  }
  for (const l of lines) out(l);
  for (const p of all) out(`! ${p.kind} ${p.id}: ${p.reason}`);
  return all.length > 0 ? 1 : 0;
}
