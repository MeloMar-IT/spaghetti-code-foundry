import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stepRepoOps, type ClaudeStep } from "../flow/schema.js";
import type { StepIdentity } from "../evidence/identity.js";
import type { ToolProfile } from "../tool-profile/schema.js";
import { applyChecks, type Engine, type Scope, type StepResult } from "./execute.js";
import { ownDir } from "./os-sandbox.js";
import { brokerRequest, type RepoGrant } from "./repo-broker.js";
import { REPO_OPERATIONS, repoToolOf, type RepoOperation } from "./repo-request.js";

/**
 * Repository requests of an agent step. The agent appends one JSON object per line to `$FACTORY_REPO_REQUESTS`; after the
 * step has succeeded (checks included) the engine passes each line to the repository broker. The agent holds no credential.
 */

export const REPO_REQUESTS_DIR = "repo-requests";
export const MAX_REPO_REQUEST_BYTES = 64 * 1024;
export const MAX_REPO_REQUESTS = 20;

/** `<runDir>/repo-requests/<step id, sanitised>-<visit>.jsonl` (the same sanitising as the push log). */
export const repoRequestsFile = (runDir: string, stepId: string, visit: number): string => join(runDir, REPO_REQUESTS_DIR, `${stepId.replace(/[^\w.-]/g, "_")}-${visit}.jsonl`);

/**
 * The environment of one try. With `repo_ops`: the folder is made (a link there is replaced), an old file is removed and
 * both names are set. Without: both names are unset, so a value of the server's own environment never reaches the agent.
 * Throws when the folder cannot be made.
 */
export function repoRequestsEnv(engine: Pick<Engine, "summary">, scope: Pick<Scope, "prefix" | "visits">, step: Pick<ClaudeStep, "id" | "repo_ops" | "skill_role">): Record<string, string | undefined> {
  if (!stepRepoOps(step)) return { FACTORY_REPO_REQUESTS: undefined, SCF_REPO_REQUESTS: undefined };
  const { runDir } = engine.summary;
  ownDir(join(runDir, REPO_REQUESTS_DIR));
  const file = repoRequestsFile(runDir, scope.prefix + step.id, scope.visits[step.id] ?? 1);
  rmSync(file, { force: true, recursive: true });
  return { FACTORY_REPO_REQUESTS: file, SCF_REPO_REQUESTS: file };
}

export type DrainedRequests = { lines: string[] } | { problem: "not-a-file" | "too-large" | "too-many" };

/**
 * Reads the request file once and removes it. The folder must be a real folder at `<real runDir>/repo-requests` (an agent
 * could have swapped it for a link); the file is opened without following links, must be a plain file, and is removed
 * only when the path still names the file that was opened. Never throws.
 */
export function drainRepoRequests(runDir: string, file: string): DrainedRequests {
  const dir = join(runDir, REPO_REQUESTS_DIR);
  try {
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync(runDir), REPO_REQUESTS_DIR)) return { problem: "not-a-file" };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { lines: [] } : { problem: "not-a-file" };
  }
  let fd: number | undefined;
  try {
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lines: [] };
      // a link (ELOOP) or anything else we cannot open: remove a link, never follow it
      removeLink(file);
      return { problem: "not-a-file" };
    }
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: "not-a-file" };
    if (st.size > MAX_REPO_REQUEST_BYTES) return { problem: "too-large" };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.length > MAX_REPO_REQUESTS ? { problem: "too-many" } : { lines };
  } catch {
    return { problem: "not-a-file" };
  } finally {
    if (fd !== undefined) {
      try {
        const opened = fstatSync(fd);
        const now = lstatSync(file, { throwIfNoEntry: false });
        if (now && now.dev === opened.dev && now.ino === opened.ino) unlinkSync(file);
      } catch {
        // nothing to remove
      }
      closeSync(fd);
    }
  }
}

function removeLink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) unlinkSync(file);
  } catch {
    // nothing to remove
  }
}

/** The one grant of the profile whose kind names this operation (the schema allows only one); the broker checks its targets. */
export function grantFor(profile: ToolProfile, op: RepoOperation): RepoGrant | undefined {
  const t = repoToolOf(op);
  return profile.grants.find((g): g is RepoGrant => g.kind === t.kind && (g.operations as readonly string[]).includes(t.operation));
}

export interface RepoRequestsContext {
  engine: Engine;
  scope: Scope;
  step: ClaudeStep;
  identity: StepIdentity;
  logFile: string;
  /** The session profile of the step (resolved.session.profile). */
  profile: ToolProfile;
  /** Tests only; default brokerRequest. */
  broker?: typeof brokerRequest;
}

const PROBLEM_TEXT = { "not-a-file": "is not a plain file", "too-large": "is larger than 64 KiB", "too-many": `has more than ${MAX_REPO_REQUESTS} requests` } as const;

/**
 * After the final try of an agent step. Unchanged unless the step has `repo_ops`. Applies `pass_if`/`fail_if` to the
 * agent's own output first; the requests run only when that is ok and the run is not cancelled. Never throws.
 */
export async function applyRepoRequests(c: RepoRequestsContext, res: StepResult): Promise<StepResult> {
  const { engine, scope, step } = c;
  const allowed = stepRepoOps(step);
  if (!allowed) return res;
  const checked = applyChecks(step, res);
  const drained = drainRepoRequests(engine.summary.runDir, repoRequestsFile(engine.summary.runDir, scope.prefix + step.id, scope.visits[step.id] ?? 1));
  const count = "lines" in drained ? drained.lines.length : 0;
  if (!checked.ok || engine.signal?.aborted) {
    if (count) engine.log(`    · repo: ${count} request(s) not carried out: the step did not succeed`);
    return checked;
  }
  if ("problem" in drained) {
    const text = `the request file ${PROBLEM_TEXT[drained.problem]}; none was carried out`;
    engine.log(`    ! repo: ${text}`);
    return { ...checked, ok: false, error: `repository requests: ${text}` };
  }
  if (!count) {
    engine.log("    · repo: no requests");
    return checked;
  }
  const broker = c.broker ?? brokerRequest;
  let section = "";
  let failure: { name: string; outcome: string; reason: string; refusal?: string; output: string } | undefined;
  let done = 0;
  for (const line of drained.lines) {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      req = null;
    }
    const given = (req as { op?: unknown } | null)?.op;
    const known = (REPO_OPERATIONS as readonly unknown[]).includes(given) ? (given as RepoOperation) : undefined;
    const name = known ?? "unknown";
    const grant = known && allowed.includes(known) ? grantFor(c.profile, known) : undefined;
    const r = await broker({ engine, scope, step: c.identity, logFile: c.logFile }, req, grant);
    const reason = r.outcome === "refused" ? (r.refusal ?? "") : r.outcome === "failed" ? (r.output.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 120) : "";
    const text = `${name}: ${r.outcome}${reason ? ` (${reason})` : ""}`;
    engine.log(`    · repo ${text}`);
    section += `- ${text}\n`;
    if (r.output.trim()) section += `${r.output.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}\n`;
    done++;
    if (r.outcome !== "done") {
      failure = { name, outcome: r.outcome, reason, refusal: r.refusal, output: r.output };
      break;
    }
  }
  const skipped = count - done;
  if (skipped > 0) {
    const text = `${skipped} later request(s) were not carried out`;
    engine.log(`    · repo: ${text}`);
    section += `- ${text}\n`;
  }
  const output = `${checked.output}\n\n## Repository operations\n${section}`;
  if (!failure) return { ...checked, output };
  const error = failure.refusal === "policy" ? failure.output : `repository operation ${failure.name} ${failure.outcome}${failure.reason ? `: ${failure.reason}` : ""}`;
  return { ...checked, ok: false, output, error };
}
