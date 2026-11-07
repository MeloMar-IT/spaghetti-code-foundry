/**
 * Plugin checks (#786): `api.check("run.before" | "step.before", fn)`. A check answers allow, warn or stop. A check that
 * throws, is too slow or answers wrongly is logged and listed as a plugin problem, and the run goes on (fail open).
 * The registry lives in this module, owned by a plugin set, the same pattern as the usage handlers.
 */
export const CHECK_POINTS = ["run.before", "step.before"] as const;
export type CheckPoint = (typeof CHECK_POINTS)[number];
export const MAX_CHECKS = 10;
export const CHECK_TIMEOUT_MS = 5_000;
const MAX_PENDING = 3;
const REASON_MAX = 200;

export interface PluginCheckInput {
  point: CheckPoint;
  runId: string;
  flow: string;
  workspace: string;
  owner: "admin" | "user" | "none";
  repository?: string;
  issue?: number;
  step?: string;
  stepType?: string;
  visit?: number;
  runCostUsd: number;
}
export type PluginCheckResult = void | "allow" | { outcome: "allow" | "warn" | "stop"; reason?: string };
export type PluginCheck = (input: Readonly<PluginCheckInput>) => PluginCheckResult | Promise<PluginCheckResult>;

interface Registered {
  owner: string;
  plugin: string;
  point: CheckPoint;
  fn: PluginCheck;
  report: (reason: string) => void;
  pending: number;
  reported: Set<string>;
}
let checks: Registered[] = [];

export function registerPluginCheck(c: { owner: string; plugin: string; point: CheckPoint; fn: PluginCheck; report: (reason: string) => void }): void {
  checks.push({ ...c, pending: 0, reported: new Set() });
}
export function disposeChecks(owner: string): void {
  checks = checks.filter((c) => c.owner !== owner);
}
/** For tests. */
export function resetPluginChecks(): void {
  checks = [];
}
export function hasPluginChecks(point: CheckPoint): boolean {
  return checks.some((c) => c.point === point);
}

/** One line, no control characters, at most 200 characters; empty becomes "no reason given". */
export function cleanReason(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const one = String(raw ?? "").split(/\r?\n/)[0]!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, REASON_MAX);
  return one || "no reason given";
}

type Verdict = { kind: "answer"; outcome: "allow" | "warn" | "stop"; reason: string } | { kind: "failed"; why: string };

function readAnswer(a: unknown): Verdict {
  if (a === undefined || a === "allow") return { kind: "answer", outcome: "allow", reason: "" };
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const o = (a as { outcome?: unknown }).outcome;
    if (o === "allow" || o === "warn" || o === "stop") return { kind: "answer", outcome: o, reason: o === "allow" && (a as { reason?: unknown }).reason === undefined ? "" : cleanReason((a as { reason?: unknown }).reason) };
  }
  return { kind: "failed", why: "gave an answer that is not valid" };
}

async function askOne(c: Registered, input: PluginCheckInput, timeoutMs: number): Promise<Verdict> {
  if (c.pending >= MAX_PENDING) return { kind: "failed", why: "is skipped: earlier calls still run" };
  c.pending++;
  const took = `took longer than ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}`;
  let timer: NodeJS.Timeout | undefined;
  // The deadline starts before the check runs. A synchronous check cannot be interrupted in this thread, so an answer that
  // arrives after the deadline is rejected (fail open) even when it returned at once.
  const started = performance.now();
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  let call: Promise<unknown>;
  try {
    call = Promise.resolve(c.fn(Object.freeze(structuredClone(input))));
  } catch (e) {
    call = Promise.reject(e);
  }
  // the call keeps counting as pending until it settles, even after the deadline
  void call.then(
    () => c.pending--,
    () => c.pending--,
  );
  try {
    const r = await Promise.race([call.then((v) => ({ v })), limit]);
    if (r === "timeout" || performance.now() - started > timeoutMs) return { kind: "failed", why: took };
    return readAnswer(r.v);
  } catch {
    return { kind: "failed", why: "threw" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks every check of the point (in parallel; the lines are logged in registration order). The first stop wins.
 * `seen` makes an allow line appear once per run start.
 */
export async function askPluginChecks(
  point: CheckPoint,
  input: PluginCheckInput,
  log: (line: string) => void,
  seen?: Set<string>,
  o: { timeoutMs?: number } = {},
): Promise<{ stop?: { plugin: string; reason: string } }> {
  const mine = checks.filter((c) => c.point === point);
  const timeoutMs = o.timeoutMs ?? CHECK_TIMEOUT_MS;
  const verdicts = await Promise.all(mine.map((c) => askOne(c, input, timeoutMs)));
  let stop: { plugin: string; reason: string } | undefined;
  const where = `${point}${input.step ? ` ${input.step}` : ""}`;
  mine.forEach((c, i) => {
    const v = verdicts[i]!;
    if (v.kind === "failed") {
      log(`! plugin ${c.plugin} · ${where}: the check failed (${v.why}) — the run goes on`);
      const reason = `the ${point} check ${v.why}`;
      if (!c.reported.has(reason)) {
        c.reported.add(reason);
        try {
          c.report(reason);
        } catch {
          /* reporting is best effort */
        }
      }
      return;
    }
    if (v.outcome === "allow") {
      const key = `${c.plugin}|${where}`;
      if (seen?.has(key)) return;
      seen?.add(key);
      log(`· plugin ${c.plugin} · ${where}: allow${v.reason ? ` — ${v.reason}` : ""}`);
      return;
    }
    log(`· plugin ${c.plugin} · ${where}: ${v.outcome} — ${v.reason}`);
    if (v.outcome === "stop" && !stop) stop = { plugin: c.plugin, reason: v.reason };
  });
  return stop ? { stop } : {};
}
