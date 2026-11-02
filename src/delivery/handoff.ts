import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
// comment.js loads help/store.js first (help/guard.js and help/store.js import each other); keep it above the guard import.
import { deliveryCommentBody, DeliveryCommentError, isDeliveryComment } from "./comment.js";
import { scrub } from "../help/guard.js";
import { BLOCKED, combineRedactors, liveRedactor, makeRedactor, type Redactor } from "../credentials/redact.js";
import { TOKEN_MIN } from "../credentials/store.js";
import { SAFE_OPTIONS } from "../engine/diff.js";
import { RepositorySchema } from "../evidence/identity.js";
import { EVIDENCE_EVENTS_FILE } from "../evidence/version.js";
import { storeFor } from "../stories/store.js";
import type { DeliveryIo } from "./cli.js";
import { contractDigest, deliveryEvidenceProblem, LOCAL_TEST_INELIGIBLE, localTestEvents, verifyDeliveryContract } from "./contract.js";
import { CommitFactsError, readCommitFacts, type CommitFacts, type CommitFactsOptions } from "./git-facts.js";
import { compareCodeUnits, DeliveryContractSchema, type DeliveryContract, type StopCondition } from "./schema.js";
import { parseKeyLine, parseSshSignature, publicKeyFingerprint } from "./sshsig.js";
import { DELIVERY_DIR, MAX_CONTRACT_BYTES, MAX_EVIDENCE_BYTES, readBoundedText } from "./write.js";

/**
 * The handoff of a release pull request: checks the latest signed delivery contract of the run against the trusted key,
 * the pushed head, the lock and workflow files, the required checks and the evidence, then keeps one delivery comment
 * on the pull request. The verdict is the first stop in check order; nothing here throws.
 */

export const CHECKS_WAIT_DEFAULT_SEC = 600;
export const CHECKS_WAIT_MAX_SEC = 3600;
export const CHECKS_POLL_MS = 15_000;
export const HANDOFF_TEXT_MAX = 300;

const CHECK_ORDER = ["signature", "superseded", "commit", "locks", "workflows", "checks", "evidence"] as const;
export type HandoffCheck = (typeof CHECK_ORDER)[number];
export interface HandoffCheckResult {
  check: HandoffCheck;
  status: "ok" | "stop" | "skipped";
  condition?: StopCondition;
  /** The reason of a stop, or why the check was skipped. */
  reason?: string;
}

export type RemoteHead = { kind: "sha"; sha: string } | { kind: "missing" } | { kind: "unreadable" };
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}
export type CheckRunsRead = { ok: true; runs: CheckRun[]; polls: number } | { ok: false; polls: number };

export interface HandoffInput {
  runDir: string;
  runId: string;
  repository: string;
  pullRequest: number;
  /** The trusted `ssh-ed25519` line; "" for none, "-" for a key that cannot be used. */
  publicKey: string;
  workdir: string;
  git?: Omit<CommitFactsOptions, "reuse">;
  waitSec: number;
  remoteHead: (branch: string) => Promise<RemoteHead>;
  checkRuns: (sha: string) => Promise<CheckRun[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type HandoffResult =
  | { kind: "none"; why: string }
  | { kind: "unsigned"; why: string; contractText: string }
  | { kind: "ok"; checks: HandoffCheckResult[]; contractText: string; sigText: string; digest: string }
  | { kind: "stop"; condition: StopCondition; reason: string; checks: HandoffCheckResult[]; contractText?: string; sigText?: string };

/** `FACTORY_DELIVERY_CHECKS_WAIT_SEC`: whole seconds, at most 3600; anything else gives the default. */
export function checksWaitSec(env: Record<string, string | undefined> = process.env): number {
  const v = env.FACTORY_DELIVERY_CHECKS_WAIT_SEC;
  if (typeof v !== "string" || !/^\d+$/.test(v)) return CHECKS_WAIT_DEFAULT_SEC;
  return Math.min(Number(v), CHECKS_WAIT_MAX_SEC);
}

type Settled = "wait" | "done";
function settled(required: readonly string[], runs: readonly CheckRun[]): Settled {
  let all = true;
  for (const name of required) {
    const mine = runs.filter((r) => r.name === name);
    // a completed run without success cannot turn into a pass any more
    if (mine.some((r) => r.status === "completed" && r.conclusion !== "success")) return "done";
    if (mine.length === 0 || mine.some((r) => r.status !== "completed")) all = false;
  }
  return all ? "done" : "wait";
}

/** Reads the check runs until every required one has finished, one has failed, or the time is up (the last good read is kept). */
export async function waitForChecks(
  required: readonly string[],
  read: () => Promise<CheckRun[]>,
  o: { waitSec: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<CheckRunsRead> {
  const deadline = o.now() + o.waitSec * 1000;
  let last: CheckRun[] | undefined;
  let polls = 0;
  for (;;) {
    polls++;
    try {
      last = await read();
      if (settled(required, last) === "done") return { ok: true, runs: last, polls };
    } catch {
      // keep the last good read
    }
    if (o.now() + CHECKS_POLL_MS > deadline) break;
    await o.sleep(CHECKS_POLL_MS);
  }
  return last ? { ok: true, runs: last, polls } : { ok: false, polls };
}

const more = (list: string[]): string => (list.length > 1 ? `${list[0]} (and ${list.length - 1} more)` : (list[0] ?? ""));

function headProblem(head: RemoteHead, contract: DeliveryContract): string | undefined {
  if (head.kind === "unreadable") return "the pushed head cannot be read";
  if (head.kind === "missing") return `the branch ${contract.commit.branch} is not on the remote`;
  if (head.sha !== contract.commit.sha) return `the pushed head is ${head.sha}, the contract is for ${contract.commit.sha}`;
  return undefined;
}

function diffs(expected: Map<string, string>, actual: Map<string, string>): string[] {
  const out: string[] = [];
  for (const path of [...new Set([...expected.keys(), ...actual.keys()])].sort(compareCodeUnits)) {
    if (!actual.has(path)) out.push(`${path} was removed`);
    else if (!expected.has(path)) out.push(`${path} was added`);
    else if (actual.get(path) !== expected.get(path)) out.push(`${path} was changed`);
  }
  return out;
}

const failedStop = (reason: string): HandoffResult => ({
  kind: "stop",
  condition: "signature-unverified",
  reason,
  checks: CHECK_ORDER.map((check) => (check === "signature" ? { check, status: "stop", condition: "signature-unverified", reason } : { check, status: "skipped", reason: "the handoff could not be completed" })),
});

/** The verdict for the run's latest contract. Never throws. */
export async function checkHandoff(input: HandoffInput): Promise<HandoffResult> {
  try {
    return await run(input);
  } catch {
    return failedStop("the handoff could not be completed");
  }
}

async function run(input: HandoffInput): Promise<HandoffResult> {
  const key = input.publicKey;
  const res: Partial<Record<HandoffCheck, HandoffCheckResult>> = {};
  const done = (check: HandoffCheck, status: "ok"): void => void (res[check] = { check, status });
  const stop = (check: HandoffCheck, condition: StopCondition, reason: string): void => void (res[check] = { check, status: "stop", condition, reason });
  const skip = (check: HandoffCheck, reason: string): void => void (res[check] = { check, status: "skipped", reason });
  const checksOf = (): HandoffCheckResult[] => CHECK_ORDER.map((c) => res[c] ?? { check: c, status: "skipped", reason: "not run" });

  if (key === "-" || (key !== "" && parseKeyLine(key) === undefined)) return failedStop("the signing key cannot be used");

  const dir = join(input.runDir, DELIVERY_DIR);
  const contractText = readBoundedText(join(dir, "contract.json"), MAX_CONTRACT_BYTES);
  const sigText = readBoundedText(join(dir, "contract.json.sig"), MAX_CONTRACT_BYTES);
  if (contractText === undefined) {
    if (key === "") return { kind: "none", why: "the run has no delivery contract" };
    return failedStop("the run has no delivery contract");
  }

  const finish = (): HandoffResult => {
    const checks = checksOf();
    const first = checks.find((c) => c.status === "stop");
    if (first) return { kind: "stop", condition: first.condition!, reason: first.reason ?? "", checks, contractText, ...(sigText !== undefined ? { sigText } : {}) };
    return { kind: "ok", checks, contractText, sigText: sigText ?? "", digest: contractDigest(contractText) };
  };

  if (key === "") {
    // no key: no head check, only "is this a chain of this run that is marked as a local test?"
    const unsigned: HandoffResult = { kind: "unsigned", why: "no signing key is set; the contract is unsigned", contractText };
    const eventsText = readBoundedText(join(input.runDir, EVIDENCE_EVENTS_FILE), MAX_EVIDENCE_BYTES);
    if (eventsText === undefined || !localTestEvents(eventsText, input.runId)) return unsigned;
    for (const c of CHECK_ORDER) if (c !== "evidence") skip(c, "the run is a local test");
    stop("evidence", "evidence-unverified", LOCAL_TEST_INELIGIBLE);
    return finish();
  }

  // 1. signature
  const v = verifyDeliveryContract(contractText, sigText, key);
  if (!v.ok) {
    stop("signature", "signature-unverified", v.message);
    for (const c of CHECK_ORDER.slice(1)) skip(c, "the contract is not trusted");
    return finish();
  }
  done("signature", "ok");
  const contract = v.contract;

  // 2. superseded
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const m = /^contract-([1-9][0-9]{0,8})\.json$/.exec(name);
    if (m) newest = Math.max(newest, Number(m[1]));
  }
  let superseded: string | undefined;
  if (newest === 0 || readBoundedText(join(dir, `contract-${newest}.json`), MAX_CONTRACT_BYTES) !== contractText) superseded = "a newer contract exists";
  else if (readBoundedText(join(dir, `contract-${newest}.json.sig`), MAX_CONTRACT_BYTES) !== sigText) superseded = "the latest copy differs from the newest contract";
  else if (contract.runId !== input.runId) superseded = "the contract is of another run";
  else if (contract.pullRequest.repository.toLowerCase() !== input.repository.toLowerCase() || contract.pullRequest.number !== input.pullRequest) {
    superseded = `the contract is for pull request #${contract.pullRequest.number}, the run's is #${input.pullRequest}`;
  }
  if (superseded !== undefined) {
    stop("superseded", "superseded", superseded);
    for (const c of CHECK_ORDER.slice(2)) skip(c, "the contract is not the latest");
    return finish();
  }
  done("superseded", "ok");

  // 3. commit
  const branch = contract.commit.branch;
  const head = await input.remoteHead(branch);
  let facts: CommitFacts | undefined;
  let factsError: string | undefined;
  try {
    facts = readCommitFacts(input.workdir, input.git);
  } catch (e) {
    factsError = e instanceof CommitFactsError ? e.message : "the commit could not be read";
  }
  const commitProblem =
    headProblem(head, contract) ??
    (facts && facts.commit.branch !== branch ? `the workspace is on branch ${facts.commit.branch}, the contract is for ${branch}` : undefined) ??
    (facts && facts.commit.sha !== contract.commit.sha ? `the checked-out commit is ${facts.commit.sha}, the contract is for ${contract.commit.sha}` : undefined) ??
    factsError;
  if (commitProblem !== undefined) stop("commit", "commit-changed", commitProblem);
  else done("commit", "ok");

  // 4. locks and workflows
  if (!facts) {
    skip("locks", "the commit cannot be read");
    skip("workflows", "the commit cannot be read");
  } else {
    const locks = diffs(new Map(contract.dependencyLock.files.map((f) => [f.path, f.sha256])), new Map(facts.dependencyLocks.map((f) => [f.path, f.sha256])));
    if (locks.length) stop("locks", "lock-changed", more(locks));
    else done("locks", "ok");
    const flows = diffs(new Map(contract.ciWorkflows.map((f) => [f.path, f.blob])), new Map(facts.ciWorkflows.map((f) => [f.path, f.blob])));
    if (flows.length) stop("workflows", "workflow-changed", more(flows));
    else done("workflows", "ok");
  }

  // 5. checks
  if (commitProblem !== undefined) skip("checks", "the commit changed");
  else if (contract.requiredChecks.length === 0) done("checks", "ok");
  else {
    const read = await waitForChecks(contract.requiredChecks, () => input.checkRuns(contract.commit.sha), { waitSec: input.waitSec, sleep: input.sleep, now: input.now });
    const problems: string[] = [];
    if (!read.ok) problems.push("the check runs cannot be read");
    else {
      for (const name of contract.requiredChecks) {
        const mine = read.runs.filter((r) => r.name === name);
        if (mine.length === 0) problems.push(`${name} is missing`);
        else if (mine.some((r) => r.status !== "completed" || r.conclusion !== "success")) problems.push(`${name} did not pass`);
      }
    }
    // a push during the wait must not hand over a head that is not the contract's commit
    const again = read.polls > 1 ? headProblem(await input.remoteHead(branch).catch((): RemoteHead => ({ kind: "unreadable" })), contract) : undefined;
    if (again !== undefined) {
      stop("commit", "commit-changed", `${again} (after waiting for the checks)`);
      skip("checks", "the commit changed");
    } else if (problems.length) stop("checks", "required-check-failed", more(problems));
    else done("checks", "ok");
  }

  // 6. evidence
  const events = readBoundedText(join(input.runDir, EVIDENCE_EVENTS_FILE), MAX_EVIDENCE_BYTES);
  const evidence = events === undefined ? "the events cannot be read" : deliveryEvidenceProblem(events, contract)?.message;
  if (evidence !== undefined) stop("evidence", "evidence-unverified", evidence);
  else done("evidence", "ok");

  return finish();
}

// ---- what is shown -----------------------------------------------------------------------------------------------

const CANNOT_SHOW = "the reason cannot be shown";
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Console text: the whole text scrubbed first, then control characters (newlines too) become `?`, then cut at 300 characters. */
export function handoffText(t: unknown, stored?: () => Redactor): string {
  try {
    const s = scrub(String(t), stored ? { stored } : {}).text.replace(CONTROL, "?");
    const chars = [...s];
    return chars.length > HANDOFF_TEXT_MAX ? `${chars.slice(0, HANDOFF_TEXT_MAX - 1).join("")}…` : s;
  } catch {
    return CANNOT_SHOW;
  }
}

/** One line per check. */
export function handoffCheckLines(r: HandoffResult, stored?: () => Redactor): string[] {
  if (r.kind !== "ok" && r.kind !== "stop") return [];
  return r.checks.map((c) =>
    c.status === "ok" ? `${c.check}: ok` : c.status === "skipped" ? `${c.check}: skipped (${handoffText(c.reason ?? "", stored)})` : `${c.check}: stop ${c.condition}: ${handoffText(c.reason ?? "", stored)}`,
  );
}

export function handoffLines(r: HandoffResult, stored?: () => Redactor): string[] {
  const lines = handoffCheckLines(r, stored);
  if (r.kind === "ok") lines.push("HANDOFF: ok");
  else if (r.kind === "stop") lines.push(`HANDOFF: stop ${r.condition}: ${handoffText(r.reason, stored)}`);
  else lines.push(`HANDOFF: skipped (${handoffText(r.why, stored)})`);
  return lines;
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|KEY/i;
const NOT_SECRET = new Set(["FACTORY_DELIVERY_PUBLIC_KEY", "SCF_DELIVERY_PUBLIC_KEY"]);

/**
 * The redactor for text in a step that may not be able to read the credential store (the OS sandbox denies it): the
 * stored credentials when they can be read, plus the values of the step's own secret-looking variables. `scrub` always
 * applies the known token shapes on top.
 */
export function handoffRedactor(env: Record<string, string | undefined>, live: () => Redactor = liveRedactor): () => Redactor {
  const values = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && !NOT_SECRET.has(k) && typeof v === "string" && v.length >= TOKEN_MIN)
    .map(([, v]) => v as string);
  const own = makeRedactor(values);
  return () => {
    let stored: Redactor;
    try {
      stored = live();
    } catch {
      stored = BLOCKED;
    }
    return stored === BLOCKED ? own : combineRedactors(stored, own);
  };
}

// ---- default dependencies ----------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

export function defaultRemoteHead(workdir: string): (branch: string) => Promise<RemoteHead> {
  return async (branch) => {
    try {
      const ref = `refs/heads/${branch}`;
      const { stdout } = await execFileAsync("git", [...SAFE_OPTIONS, "ls-remote", "origin", ref], {
        cwd: workdir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      for (const line of String(stdout).split("\n")) {
        const m = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line.trim());
        if (m && m[2] === ref) return { kind: "sha", sha: m[1]! };
      }
      return { kind: "missing" };
    } catch {
      return { kind: "unreadable" };
    }
  };
}

export function defaultCheckRuns(repo: string): (sha: string) => Promise<CheckRun[]> {
  return (sha) => storeFor(repo).checks(sha, 30_000);
}

// ---- the command -------------------------------------------------------------------------------------------------

export interface HandoffDeps extends Partial<Pick<HandoffInput, "remoteHead" | "checkRuns" | "sleep" | "now">> {
  live?: () => Redactor;
  /** The checked-out repository; default: the current folder. */
  workdir?: string;
}

function parseContract(text: string | undefined): DeliveryContract | undefined {
  if (text === undefined) return undefined;
  try {
    const p = DeliveryContractSchema.safeParse(JSON.parse(text));
    return p.success ? p.data : undefined;
  } catch {
    return undefined;
  }
}

const demote = (r: HandoffResult, reason: string): HandoffResult =>
  r.kind === "ok" ? { kind: "stop", condition: "signature-unverified", reason, checks: r.checks, contractText: r.contractText, sigText: r.sigText } : r;

/** `delivery-handoff <run-dir>`: prints the verdict, keeps the delivery comment, returns the exit code (0: ok, skipped or unsigned; 1: a stop). */
export async function handoffCommand(args: string[], io: DeliveryIo, deps: HandoffDeps = {}, env: Record<string, string | undefined> = process.env): Promise<number> {
  const out = (line: string): void => io.out(`${line}\n`);
  const key = env.FACTORY_DELIVERY_PUBLIC_KEY ?? "";
  const unusable = (condition: StopCondition, why: string): number => {
    if (key !== "") {
      out(`HANDOFF: stop ${condition}: ${why}`);
      return 1;
    }
    out(`HANDOFF: skipped (${why})`);
    return 0;
  };

  const runDir = args[0];
  const runId = env.FACTORY_RUN_ID ?? "";
  const repo = env.FACTORY_VAR_GITHUB_REPO ?? "";
  if (!runDir || !/^[\w-]{1,128}$/.test(runId) || !RepositorySchema.safeParse(repo).success) return unusable("signature-unverified", "the handoff inputs are missing");
  const prs = [...(env.FACTORY_OUT_RELEASE_PR ?? "").matchAll(/^PR: ([1-9][0-9]{0,9})$/gm)];
  const pr = prs.length ? Number(prs[prs.length - 1]![1]) : undefined;
  if (pr === undefined) return unusable("superseded", "the run has no pull request");

  const workdir = deps.workdir ?? process.cwd();
  const stored = handoffRedactor(env, deps.live);
  const guard = { stored };
  let blocked = false;
  try {
    blocked = (deps.live ?? liveRedactor)() === BLOCKED;
  } catch {
    blocked = true;
  }
  const notes: string[] = [];
  if (blocked) notes.push("secret check: the stored credentials cannot be read here; the step's own secrets and known token shapes are taken out");

  let result = await checkHandoff({
    runDir,
    runId,
    repository: repo,
    pullRequest: pr,
    publicKey: key,
    workdir,
    waitSec: checksWaitSec(env),
    remoteHead: deps.remoteHead ?? defaultRemoteHead(workdir),
    checkRuns: deps.checkRuns ?? defaultCheckRuns(repo),
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
  });

  let body: string | undefined;
  if (result.kind !== "none") {
    const build = (withContract: boolean): string => {
      const r = result;
      const text = withContract && r.kind !== "none" ? r.contractText : undefined;
      const contract = withContract ? parseContract(text) : undefined;
      const sig = contract && (r.kind === "ok" || r.kind === "stop") && r.sigText !== undefined && parseSshSignature(r.sigText) !== undefined ? r.sigText : undefined;
      const fingerprint = parseKeyLine(key) ? publicKeyFingerprint(key) : undefined;
      return deliveryCommentBody(
        {
          status: r.kind === "stop" ? { kind: "stop", condition: r.condition, reason: r.reason } : { kind: r.kind === "ok" ? "ok" : "unsigned" },
          lines: handoffCheckLines(r, stored),
          ...(contract && text !== undefined ? { contract, text, digest: contractDigest(text), ...(sig !== undefined ? { signature: sig } : {}) } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        },
        runId,
        guard,
      );
    };
    try {
      body = build(true);
    } catch (e) {
      if (e instanceof DeliveryCommentError) {
        result = demote(result, `the contract cannot be published in a comment: ${e.message}`);
        try {
          body = build(false);
        } catch {
          body = undefined;
        }
      }
    }
    if (body === undefined) {
      notes.push("delivery comment: could not be built");
      result = demote(result, "the delivery comment could not be built");
    }
  }

  for (const line of handoffLines(result, stored)) out(line);
  for (const n of notes) out(n);

  if (body !== undefined) {
    try {
      const r = await storeFor(repo).upsertStatusComment(pr, body, { create: true, on: "pr", match: isDeliveryComment, timeoutMs: 30_000, deadline: Date.now() + 60_000 });
      out(`delivery comment: ${r.changed ? (r.created ? "posted" : "updated") : "unchanged"}`);
    } catch {
      out("delivery comment: could not be updated");
    }
  }
  return result.kind === "stop" ? 1 : 0;
}
