import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ContextSettingsSchema, contextSelectorInput } from "../context/settings.js";
import { ISSUE_FILE, readIssueFiles } from "../context/issue-files.js";
import { gitHead, openRepositoryAt, ContextRepositoryError, type ContextRepositoryErrorCode, type OpenRepositoryOptions, type RepositorySnapshot } from "../context/repository.js";
import { ContextSelectError, selectContext } from "../context/select.js";
import { ContextStoreError, writeContextBundle, type ContextStoreErrorCode, type ContextStoreHooks } from "../context/store.js";
import { ContextSchemaError } from "../context/version.js";
import { CONTEXT_ATTEMPT_FILE, CONTEXT_BUNDLE_FILE, CONTEXT_SOURCES_DIR } from "../context/version.js";
import { classificationAtMost, contextTotalBytes } from "../context/bundle.js";
import { CONTEXT_CLASSIFICATIONS, type ContextBundle } from "../context/schema.js";
import type { Facts } from "../policy/schema.js";
import { RepositorySchema } from "../evidence/identity.js";
import type { Engine } from "./execute.js";
import type { RunSummary } from "./state.js";

/**
 * A run's context bundle: made once, at the commit the workspace has, just before the first agent step of an issue
 * run, and finished within 30 s or not stored at all. The files are made read-only (0400, folders 0500).
 * `context.attempt` is written first and stays: one attempt per run, also after a resume or a restart.
 */

export const CONTEXT_DEADLINE_MS = 30_000;

type CodeUnion =
  | "marker-failed"
  | "issue-unreadable"
  | "comments-unreadable"
  | "select-invalid"
  | "bundle-invalid"
  | "timeout"
  | "lock-failed"
  | "internal"
  | `repository-${ContextRepositoryErrorCode}`
  | `store-${ContextStoreErrorCode}`;

/** Every code a failed context attempt can give, as a list evidence can check against. */
export const RUN_CONTEXT_CODES = [
  "marker-failed", "issue-unreadable", "comments-unreadable", "select-invalid", "bundle-invalid", "timeout", "lock-failed", "internal",
  "repository-no-git", "repository-not-a-repository", "repository-no-commit", "repository-too-large", "repository-timeout", "repository-bad-listing", "repository-read-failed",
  "store-no-folder", "store-exists", "store-texts-do-not-match", "store-write-failed",
] as const;
export type RunContextCode = (typeof RUN_CONTEXT_CODES)[number];

// Fails the build when the list and the codes of the repository and the store drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const everyCodeIsListed: Same<RunContextCode, CodeUnion> = true;
void everyCodeIsListed;

export type RunContextResult = { written: { sources: number; omitted: number; commit: string; skippedComments: number; bundle: ContextBundle } } | { failed: RunContextCode };

/** The facts policy gets at `context.select`: how big the bundle is, how much was left out and how private its most private source is. */
export function contextSelectFacts(bundle: ContextBundle): Facts {
  const classes = bundle.sources.map((s) => s.classification);
  const highest = CONTEXT_CLASSIFICATIONS.find((c) => classes.length > 0 && classes.every((k) => classificationAtMost(k, c)));
  return {
    contextSources: bundle.sources.length,
    contextBytes: contextTotalBytes(bundle),
    contextOmitted: bundle.omitted.length,
    ...(highest ? { contextClassification: highest } : {}),
  };
}

export interface RunContextDeps {
  /** One clock for the deadline, the selection time and git. Default Date.now. */
  now?: () => number;
  gitHead?: (dir: string, deadlineMs: number, now: () => number) => string;
  openRepository?: (dir: string, commit: string, opts: OpenRepositoryOptions) => RepositorySnapshot;
  storeHooks?: ContextStoreHooks;
  lock?: (runDir: string) => void;
}

type ContextEngine = Pick<Engine, "summary" | "config" | "log"> & Partial<Pick<Engine, "evidence" | "policy">>;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isTicketRecord =(h: RunSummary["history"][number]): boolean => h.id === "pull_ticket" && h.parent === undefined && h.ok;

/** Whether nothing is there at `path` (lstat: a link, even a dangling one, is something). Any error but ENOENT counts as there. */
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function contextPending(summary: RunSummary): boolean {
  if (!summary.flowDef.steps.some((s) => s.id === "pull_ticket" && s.type === "shell" && s.run.includes(ISSUE_FILE))) return false;
  if (!summary.history.some(isTicketRecord)) return false;
  if (summary.history.some((h) => h.type === "claude" || h.type === "parallel" || h.type === "flow")) return false;
  return [CONTEXT_ATTEMPT_FILE, CONTEXT_BUNDLE_FILE, CONTEXT_SOURCES_DIR].every((n) => absent(join(summary.runDir, n)));
}

function codeOf(e: unknown): RunContextCode {
  if (e instanceof ContextRepositoryError) return `repository-${e.code}`;
  if (e instanceof ContextSelectError) return "select-invalid";
  if (e instanceof ContextSchemaError) return "bundle-invalid";
  if (e instanceof ContextStoreError) return `store-${e.code}`;
  return "internal";
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Opens `path` without following a link, checks it is still a file or folder as expected, and sets its mode. */
function chmodStrict(path: string, folder: boolean, mode: number): void {
  const fd = openSync(path, OPEN_FLAGS | (folder ? (constants.O_DIRECTORY ?? 0) : 0));
  try {
    const st = fstatSync(fd);
    if (folder ? !st.isDirectory() : !st.isFile()) throw new Error("not the expected type");
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/** Sets files under `context/` and `context.json` to 0400 and folders to 0500, deepest first. Throws on a link or anything else. */
export function lockRunContext(runDir: string): void {
  const order: { path: string; folder: boolean }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        walk(path);
        order.push({ path, folder: true });
      } else if (st.isFile()) order.push({ path, folder: false });
      else throw new Error("not a file or folder");
    }
  };
  const sources = join(runDir, CONTEXT_SOURCES_DIR);
  if (!lstatSync(sources).isDirectory()) throw new Error("not a folder");
  walk(sources);
  order.push({ path: sources, folder: true });
  for (const e of order.filter((x) => !x.folder)) chmodStrict(e.path, false, 0o400);
  chmodStrict(join(runDir, CONTEXT_BUNDLE_FILE), false, 0o400);
  for (const e of order.filter((x) => x.folder)) chmodStrict(e.path, true, 0o500); // post-order: deepest first, `context/` last
}

/** Sets the folders of `context/` back to 0700, top-down, so they can be removed. Never throws. */
export function unlockRunContext(runDir: string): void {
  const visit = (dir: string): void => {
    try {
      if (!lstatSync(dir).isDirectory()) return;
      chmodStrict(dir, true, 0o700);
    } catch {
      return;
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) visit(join(dir, n));
  };
  visit(join(runDir, CONTEXT_SOURCES_DIR));
}

/** Takes away what a bundle made: its files, then its folders, never recursively. A foreign file keeps its folder. */
function removeOwnBundle(runDir: string, bundle: ContextBundle): void {
  unlockRunContext(runDir);
  const attempt = (f: () => void): void => {
    try {
      f();
    } catch {
      // already gone, or not ours
    }
  };
  const folders = new Set<string>([CONTEXT_SOURCES_DIR]); // made even when no source is selected
  for (const s of bundle.sources) {
    const parts = s.content.path.split("/");
    attempt(() => rmSync(join(runDir, ...parts)));
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  attempt(() => rmSync(join(runDir, CONTEXT_BUNDLE_FILE)));
  const depth = (p: string): number => p.split("/").length;
  for (const f of [...folders].sort((a, b) => depth(b) - depth(a))) attempt(() => rmdirSync(join(runDir, ...f.split("/"))));
}

export function writeRunContext(o: { summary: RunSummary; settings: unknown; commit: string; deadlineMs: number }, deps: RunContextDeps = {}): RunContextResult {
  const { summary, deadlineMs } = o;
  const now = deps.now ?? Date.now;
  const runDir = summary.runDir;
  try {
    const ticket = summary.history.filter(isTicketRecord).at(-1);
    if (!ticket) return { failed: "internal" };
    if (!/^\d+$/.test(summary.vars.issue ?? "") || !Number.isSafeInteger(Number(summary.vars.issue))) return { failed: "issue-unreadable" };
    const files = readIssueFiles(runDir, Number(summary.vars.issue), ticket.startedAt);
    if ("failed" in files) return { failed: files.failed };
    const settings = ContextSettingsSchema.safeParse(o.settings);
    if (!settings.success) return { failed: "select-invalid" };
    const snapshot = (deps.openRepository ?? openRepositoryAt)(summary.workdir ?? "", o.commit, { deadlineMs, now });
    const repo = summary.vars.github_repo;
    const { bundle, texts } = selectContext({
      snapshot,
      runId: summary.runId,
      now: new Date(now()).toISOString(),
      task: { issue: files.ok.issue },
      policies: [],
      ...contextSelectorInput(settings.data),
      ...(repo !== undefined && RepositorySchema.safeParse(repo).success ? { repository: repo } : {}),
    });
    if (now() >= deadlineMs) return { failed: "timeout" };
    writeContextBundle(runDir, bundle, texts, deps.storeHooks);
    try {
      (deps.lock ?? lockRunContext)(runDir);
    } catch {
      removeOwnBundle(runDir, bundle);
      return { failed: "lock-failed" };
    }
    if (now() >= deadlineMs) {
      removeOwnBundle(runDir, bundle);
      return { failed: "timeout" };
    }
    return { written: { sources: bundle.sources.length, omitted: bundle.omitted.length, commit: o.commit, skippedComments: files.ok.leftComments, bundle } };
  } catch (e) {
    return { failed: codeOf(e) };
  }
}

export function contextBeforeStep(engine: ContextEngine, deps: RunContextDeps = {}): "skipped" | RunContextResult {
  const { summary } = engine;
  let result: RunContextResult;
  try {
    if (!contextPending(summary)) return "skipped";
    const now = deps.now ?? Date.now;
    const deadlineMs = now() + CONTEXT_DEADLINE_MS;
    result = attempt(summary, engine.config.context, deadlineMs, deps);
  } catch {
    result = { failed: "internal" };
  }
  try {
    engine.evidence?.contextBundled("written" in result ? { bundle: result.written.bundle } : result);
  } catch {
    // evidence never stops the run
  }
  try {
    if ("written" in result) engine.policy?.at("context.select", contextSelectFacts(result.written.bundle));
  } catch {
    // policy is only observed here
  }
  try {
    engine.log(
      "written" in result
        ? `· context: ${result.written.sources} sources, ${result.written.omitted} left out, commit ${result.written.commit.slice(0, 12)}${result.written.skippedComments > 0 ? `, ${result.written.skippedComments} comments skipped` : ""}`
        : `! context: CONTEXT_FAILED ${result.failed}`,
    );
  } catch {
    // a log that fails must not stop the run
  }
  return result;
}

function attempt(summary: RunSummary, settings: unknown, deadlineMs: number, deps: RunContextDeps): RunContextResult {
  try {
    closeSync(openSync(join(summary.runDir, CONTEXT_ATTEMPT_FILE), "wx", 0o400));
  } catch {
    return { failed: "marker-failed" };
  }
  const now = deps.now ?? Date.now;
  let commit: string;
  try {
    commit = (deps.gitHead ?? gitHead)(summary.workdir ?? "", deadlineMs, now);
  } catch (e) {
    return { failed: codeOf(e) };
  }
  if (!COMMIT.test(commit)) return { failed: "repository-no-commit" };
  return writeRunContext({ summary, settings, commit, deadlineMs }, deps);
}
