import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../credentials/redact.js";
import { cleanEnv, SAFE_OPTIONS } from "../engine/diff.js";
import { appendLiveLog, type RunSummary } from "../engine/state.js";
import { canonicalHash, canonicalJson } from "./canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "./chain.js";
import { artifactRef, type ArtifactRef, type ModelIdentity, type PolicyIdentity } from "./identity.js";
import { RunEvidenceSchema, TERMINAL_RUN_STATUSES, type EvidenceEvent, type RunEvidence } from "./schema.js";
import { evidenceIncomplete, readPlainBytes } from "./stream.js";
import { EVIDENCE_DIFF_FILE, EVIDENCE_EVENTS_FILE, EVIDENCE_MANIFEST_FILE, RUN_EVIDENCE_VERSION } from "./version.js";

/**
 * Finalizing a run: when it reaches an end (succeeded, failed, cancelled), its event stream is checked as one chain
 * and the manifest `evidence.json` is written from it.
 *
 * The manifest follows from the events and the files of the run. Two finalizations of the same run give the same
 * manifest except for `finalizedAt`, the one field that depends on when it was written.
 * A manifest is there only for the end the run is at now: a resume removes it, and a finalization that fails removes
 * it too, so a run without a manifest is never a verified one.
 */

const STATUS_OF = { "run.completed": "succeeded", "run.failed": "failed", "run.cancelled": "cancelled" } as const;

/** Why a stream has no manifest. `expected`: not a fault, the run simply has no whole evidence (it is older than evidence). */
export class NotFinalizable extends Error {
  constructor(message: string, readonly expected = false) {
    super(message);
  }
}

/** The status a stream ends in; undefined when its last event is not the end of a run. */
export function terminalStatus(events: readonly EvidenceEvent[]): RunEvidence["status"] | undefined {
  const last = events.at(-1);
  return last && Object.hasOwn(STATUS_OF, last.type) ? STATUS_OF[last.type as keyof typeof STATUS_OF] : undefined;
}

/** Each value once, in the order it was first seen. */
function once<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = canonicalJson(v);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/**
 * The manifest of a checked chain. Pure. `flowSha256`: the hash of the flow definition stored with the run;
 * `terminalHash`: the hash of the last event; `diff`: the stored diff, when one was made.
 * Throws NotFinalizable when the events are not those of a whole run that ended.
 */
export function buildRunEvidence(events: readonly EvidenceEvent[], o: { terminalHash: string; flowSha256: string; finalizedAt: string; diff?: ArtifactRef }): RunEvidence {
  const last = events.at(-1);
  const status = terminalStatus(events);
  if (!last || !status) throw new NotFinalizable("the events do not end with the end of the run");
  const created = events.find((e) => e.type !== "run.queued");
  if (created?.type !== "run.created") throw new NotFinalizable("the events do not begin with the start of the run: it was made before evidence existed", true);
  const started = events.find((e) => e.type === "run.started");
  const base = started?.type === "run.started" ? started.base : undefined;
  const final = last.type === "run.completed" ? last.final : undefined;
  const pullRequest = last.type === "run.completed" ? last.pullRequest : undefined;
  const where = final ?? base;

  const models: ModelIdentity[] = [];
  const policies: PolicyIdentity[] = [];
  const approvals: RunEvidence["approvals"] = [];
  const tests: RunEvidence["tests"] = [];
  // a path that is named again (a log that grew) counts as it was named last
  const files = new Map<string, ArtifactRef>();
  for (const e of events) {
    if (e.type === "step.routed") models.push(e.model);
    if (e.type === "step.approved") approvals.push({ step: e.step, time: e.time, decision: "approved", by: e.by });
    if (e.type === "step.denied" && e.denial.kind === "approval") approvals.push({ step: e.step, time: e.time, decision: "rejected", by: e.denial.by });
    if (e.type === "step.denied" && e.denial.kind === "policy") policies.push(e.denial.policy);
    if (e.type === "step.completed" || e.type === "step.failed") {
      if (e.model) models.push(e.model);
      for (const a of e.artifacts) files.set(a.path, a);
      if (e.test) {
        tests.push({ step: e.step, result: e.test });
        if (e.test.report) files.set(e.test.report.path, e.test.report);
      }
    }
  }
  return {
    version: RUN_EVIDENCE_VERSION,
    runId: last.runId,
    status,
    startedAt: created.time,
    finishedAt: last.time,
    finalizedAt: o.finalizedAt,
    flow: { ...created.flow, sha256: o.flowSha256 },
    events: { path: EVIDENCE_EVENTS_FILE, count: events.length, terminalHash: o.terminalHash },
    git: {
      ...(where?.repository ? { repository: where.repository } : {}),
      ...(where?.branch ? { branch: where.branch } : {}),
      ...(base ? { base: base.commit } : {}),
      ...(final ? { final: final.commit } : {}),
    },
    models: once(models),
    policies: once(policies),
    approvals,
    tests,
    artifacts: [...files.values()],
    ...(o.diff ? { diff: o.diff } : {}),
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/** The SHA-256 of a flow definition as it is stored in `run.json`: of its canonical form. */
export function flowDefinitionHash(flowDef: unknown): string {
  return canonicalHash(JSON.parse(JSON.stringify(flowDef ?? null)));
}

/** Writes a file of the run folder in one step: beside it first, then moved over it (a link there is replaced, not followed). */
function writeWhole(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const DIFF_MAX_BYTES = 5_000_000;
const DIFF_TIMEOUT_MS = 3_000;

/**
 * Makes and stores the diff between two commits of the workspace, with stored secrets hidden, and returns its reference.
 * Undefined (and no file) when there is nothing to compare, the workspace is gone, or git fails, takes too long or
 * gives more than 20 MB. The same two commits give the same file.
 */
export function storeRunDiff(run: Pick<RunSummary, "runDir" | "workdir">, base: string | undefined, final: string | undefined, gitBin = "git"): ArtifactRef | undefined {
  const file = join(run.runDir, EVIDENCE_DIFF_FILE);
  try {
    if (!base || !final || !run.workdir || !existsSync(run.workdir)) throw new Error("nothing to compare");
    const patch = execFileSync(gitBin, [...SAFE_OPTIONS, "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, final, "--"], {
      cwd: run.workdir,
      encoding: "utf8",
      maxBuffer: DIFF_MAX_BYTES,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: DIFF_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const text = redactText(patch);
    writeWhole(file, text);
    return artifactRef("diff", EVIDENCE_DIFF_FILE, text, false);
  } catch {
    rmSync(file, { force: true }); // never a diff of an earlier end
    return undefined;
  }
}

/** Removes the manifest and the stored diff of a run that goes on: they describe an end the run is no longer at. Never throws. */
export function dropRunEvidence(runDir: string): void {
  for (const name of [EVIDENCE_MANIFEST_FILE, EVIDENCE_DIFF_FILE]) {
    try {
      rmSync(join(runDir, name), { force: true });
    } catch {
      // a manifest that stays no longer matches the events, and the verifier says so
    }
  }
}

export type Finalized =
  | { state: "written"; evidence: RunEvidence }
  /** No manifest: the run has not ended, or it could not be finalized (`reason`). */
  | { state: "none"; reason?: string };

export interface FinalizeOptions {
  now?: () => Date;
  /** The git program; tests put a script here. */
  gitBin?: string;
  /** Where the one line about a failure goes; the live log of the run by default. */
  report?: (line: string) => void;
}

/**
 * Writes `evidence.json` for a run that ended. Never throws and never changes the run.
 * When it cannot be written, any manifest that is there is removed, and one line in the live log says why.
 */
export function finalizeRunEvidence(run: RunSummary, o: FinalizeOptions = {}): Finalized {
  if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return { state: "none" };
  const file = join(run.runDir, EVIDENCE_MANIFEST_FILE);
  try {
    if (evidenceIncomplete(run.runDir)) throw new NotFinalizable("the evidence of this run stopped earlier", true);
    const bytes = readPlainBytes(join(run.runDir, EVIDENCE_EVENTS_FILE));
    if (!bytes) throw new NotFinalizable("the run has no event stream", true);
    const { lines, tail } = splitEvidenceLines(bytes.toString("utf8"));
    if (tail !== "") throw new NotFinalizable("the event stream ends in a line that was cut off");
    const chain = readEvidenceChain(lines, run.runId);
    if (!chain.ok) throw new NotFinalizable(`the event stream is not an unbroken chain (${chain.message})`);
    const status = terminalStatus(chain.events);
    // a stream that stopped after a failed write has no end event: such a run has no manifest
    if (!status || !chain.terminalHash) throw new NotFinalizable("the events do not end with the end of the run");
    if (status !== run.status) throw new NotFinalizable("the events end in another status than the run");
    const first = buildRunEvidence(chain.events, { terminalHash: chain.terminalHash, flowSha256: flowDefinitionHash(run.flowDef), finalizedAt: chain.events.at(-1)!.time });
    const diff = storeRunDiff(run, first.git.base, first.git.final, o.gitBin);
    // never before the end of the run, also when the clock was set back in between
    const now = (o.now ?? (() => new Date()))().getTime();
    const finalizedAt = new Date(Math.max(now, Date.parse(first.finishedAt))).toISOString();
    const checked = RunEvidenceSchema.safeParse({ ...first, finalizedAt, ...(diff ? { diff } : {}) });
    if (!checked.success) throw new NotFinalizable(`the manifest would not be valid (${[...new Set(checked.error.issues.map((i) => i.path.map(String).join(".") || "(root)"))].slice(0, 5).join(", ")})`);
    writeWhole(file, `${JSON.stringify(checked.data, null, 2)}\n`);
    return { state: "written", evidence: checked.data };
  } catch (e) {
    dropRunEvidence(run.runDir);
    const known = e instanceof NotFinalizable;
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const reason = known ? e.message : `the manifest could not be written (${typeof code === "string" ? code : "error"})`;
    try {
      (o.report ?? ((line: string) => appendLiveLog(run.runDir, line)))(known && e.expected ? `· evidence: no manifest (${reason})` : `! evidence: no manifest was written (${reason}); this run cannot be verified`);
    } catch {
      // a report that fails changes nothing
    }
    return { state: "none", reason };
  }
}
