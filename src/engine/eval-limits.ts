import { isAbsolute } from "node:path";

/**
 * The evaluation limit: one process-wide value that holds every sandboxed step tighter than a normal user's run.
 * It is unset by default and normal runs never set it. It is process-wide, so only a process that runs nothing
 * but the evaluation may set it.
 */

export interface EvaluationLimits {
  /** The only outbound TCP: `*:<port>` or `localhost:<port>`. */
  outbound: readonly string[];
  /** Absolute folders no step may read. */
  denyRead: readonly string[];
  /** The only tools a Claude agent has. */
  tools: readonly string[];
}

export const OUTBOUND_REFUSED = "an outbound rule must be *:<port> or localhost:<port>";
export const READ_DENY_REFUSED = "a read deny must be an absolute path";

/** The entry itself when it is `*:<port>` or `localhost:<port>` with a port of 1 to 65535; else it throws. */
export function checkOutbound(entry: string): string {
  const m = typeof entry === "string" ? /^(\*|localhost):([1-9]\d{0,4})$/.exec(entry) : null;
  if (!m || Number(m[2]) > 65535) throw new Error(OUTBOUND_REFUSED);
  return entry;
}

let current: Readonly<EvaluationLimits> | undefined;

/** Check every entry, then store a deeply frozen copy. `undefined` resets. A refused limit leaves the old one. */
export function setEvaluationLimits(limit: EvaluationLimits | undefined): void {
  if (limit === undefined) {
    current = undefined;
    return;
  }
  const outbound = limit.outbound.map(checkOutbound);
  const denyRead = limit.denyRead.map((p) => {
    if (typeof p !== "string" || !isAbsolute(p)) throw new Error(READ_DENY_REFUSED);
    return p;
  });
  current = Object.freeze({ outbound: Object.freeze(outbound), denyRead: Object.freeze(denyRead), tools: Object.freeze([...limit.tools]) });
}

export function evaluationLimits(): Readonly<EvaluationLimits> | undefined {
  return current;
}
