import { COMPONENT_KINDS, componentLine, type ComponentKind } from "./components.js";
import { promoteCheck, promoteWithReport, REPORT_ID_RE } from "./promote.js";
import { governanceFields } from "./governance.js";
import { listGoverned } from "./governed.js";

export const PROMOTE_USAGE = "usage: scf promote <kind> <id> [--report <report-id>] [--live]";

/**
 * `scf promote <kind> <id> [--live]`: prints one PASSED line per suite that holds and PROMOTABLE, or one BLOCKED line per
 * reason. Read-only. With `--report <report-id>` it also writes the promotion record (promotions/records.json) and prints
 * PROMOTED. Returns 0 when promotable (and recorded), else 1.
 */
export function promoteCommand(positionals: string[], o: { live?: boolean; report?: string }, out: (line: string) => void): number {
  const [kind, id, ...extra] = positionals;
  if (!kind || !id || extra.length > 0 || !(COMPONENT_KINDS as readonly string[]).includes(kind)) throw new Error(PROMOTE_USAGE);
  if (o.report === undefined) {
    const r = promoteCheck(kind as ComponentKind, id, { live: o.live === true });
    for (const l of r.lines) out(l);
    return r.ok ? 0 : 1;
  }
  if (!REPORT_ID_RE.test(o.report)) throw new Error(PROMOTE_USAGE);
  const r = promoteWithReport(kind as ComponentKind, id, o.report, { live: o.live === true, by: "cli" });
  for (const l of r.decision.lines) out(l);
  if (!r.ok) {
    if (r.reason !== undefined) out(`! ${r.reason}`);
    return 1;
  }
  const e = r.entry;
  out(`PROMOTED ${e.kind} ${e.id} v${e.version} sha256:${e.sha256} report:${e.reportId}`);
  return 0;
}

export const COMPONENTS_USAGE = `usage: scf components [record] [${COMPONENT_KINDS.join("|")}]`;

/**
 * `scf components [kind]` lists the components of the data folder and changes nothing; a counted component whose hash is
 * not recorded prints `v-` and ` unrecorded`. `scf components record [kind]` gives new hashes a version. Returns the
 * exit code: 1 when any component is a problem. Each line ends with the owner, risk, lifecycle and status of its governance
 * record (governance.ts); a record that names nothing, or a file that cannot be used, is a problem too.
 */
export function componentsCommand(positionals: string[], out: (line: string) => void, o: { builtinFlowsDir?: string; waitMs?: number; now?: Date } = {}): number {
  const rest = positionals[0] === "record" ? positionals.slice(1) : positionals;
  const record = rest.length < positionals.length;
  if (rest.length > 1 || (rest[0] !== undefined && !(COMPONENT_KINDS as readonly string[]).includes(rest[0]))) throw new Error(COMPONENTS_USAGE);
  const kind = rest[0] as ComponentKind | undefined;

  const list = listGoverned({
    ...(kind ? { kinds: [kind] } : {}),
    record,
    ...(o.builtinFlowsDir ? { builtinFlowsDir: o.builtinFlowsDir } : {}),
    ...(o.waitMs === undefined ? {} : { waitMs: o.waitMs }),
    ...(o.now ? { now: o.now } : {}),
  });
  // a counted component whose versions cannot be read has no line, only its problem
  for (const r of list.rows) if (!r.versionFailed) out(`${componentLine(r.component, r.mark)} ${governanceFields(r.record, r.status)}`);
  for (const p of list.problems) out(`! ${p.kind} ${p.id}: ${p.reason}`);
  if (list.bookProblem !== undefined) out(`! ${list.bookProblem}`);
  return list.problems.length > 0 || list.bookProblem !== undefined ? 1 : 0;
}
