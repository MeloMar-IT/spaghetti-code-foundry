import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mayConsume, readContextBundle } from "../context/bundle.js";
import { planCitations } from "../context/citations.js";
import { contextIndex, ContextIndexError, renderContextIndex } from "../context/prompt-index.js";
import { CONTEXT_BUNDLE_FILE, CONTEXT_SOURCES_DIR } from "../context/version.js";
import type { ClaudeStep, Step } from "../flow/schema.js";
import { readPlainFile } from "./os-sandbox.js";
import { isTicketRecord } from "./run-context.js";
import type { RunSummary } from "./state.js";
import type { TemplateContext } from "./template.js";

/**
 * Before an agent step: swaps `{{context.index}}` for the list of the run's context files, or, when the run has no
 * bundle (or the issue was fetched again after it), for the pasted issue as before. A bundle that exists but cannot be
 * used makes the step refuse: the pasted issue would undo the filters of the bundle. Never throws.
 */

export type StepContextIndex =
  | { prompt: string; ctx: TemplateContext; readOnlyDirs?: string[]; log?: string }
  | { refuse: string };

export interface StepContextIndexDeps {
  now?: () => string;
  /** The text of the file; undefined when it is not there. */
  read?: (path: string) => string | undefined;
  real?: (path: string) => string;
  /** True for a regular file (not a link). */
  isFile?: (path: string) => boolean;
}

const PLACEHOLDER = /\{\{\s*context\.index\s*\}\}/g;
const FALLBACK = "{{steps.pull_ticket.output}}";
/** A run folder path an agent rule (`Read(//path/**)`) can name without a glob or a pattern character. */
const RULE_SAFE_PATH = /^\/[A-Za-z0-9._/@+~,:=% -]+$/;
const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

const unusable = (code: string, what: string): { refuse: string } => ({ refuse: `CONTEXT_UNUSABLE ${code}: ${what}; the step did not start` });

function readFile(path: string): string | undefined {
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return readPlainFile(path, BUNDLE_MAX_BYTES);
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

const PLAN_READY = /^PLAN_STATUS: READY\s*$/m;

/**
 * After a top-level agent step whose prompt has `{{context.index}}` and whose output is a READY plan: how many of the
 * plan's Requirements, Constraints and Acceptance criteria sections cite none of the bundle's sources the step's role
 * may consume. Undefined (the fact is not given) in every other case, also when the bundle cannot be read. Never throws.
 */
export function stepContextUncited(
  o: { summary: Pick<RunSummary, "runDir">; step: Step; topLevel: boolean; output: string | undefined },
  deps: Pick<StepContextIndexDeps, "read"> = {},
): number | undefined {
  const { summary, step, output } = o;
  if (!o.topLevel || step.type !== "claude" || output === undefined) return undefined;
  PLACEHOLDER.lastIndex = 0;
  if (!PLACEHOLDER.test(step.prompt) || !PLAN_READY.test(output)) return undefined;
  try {
    const text = (deps.read ?? readFile)(join(summary.runDir, CONTEXT_BUNDLE_FILE));
    if (text === undefined) return undefined;
    const read = readContextBundle(text);
    if (read.state !== "ok") return undefined;
    const role = step.skill_role ?? "coder";
    const known = new Set(read.bundle.sources.filter((s) => mayConsume(s, role)).map((s) => s.id));
    return planCitations(output, known).uncited;
  } catch {
    return undefined;
  }
}

export function stepContextIndex(
  o: { summary: Pick<RunSummary, "runDir" | "history">; step: Pick<ClaudeStep, "prompt" | "skill_role">; ctx: TemplateContext },
  deps: StepContextIndexDeps = {},
): StepContextIndex {
  const { summary, step, ctx } = o;
  PLACEHOLDER.lastIndex = 0;
  if (!PLACEHOLDER.test(step.prompt)) return { prompt: step.prompt, ctx };
  const fallback = (log: string): StepContextIndex => ({ prompt: step.prompt.replace(PLACEHOLDER, FALLBACK), ctx, log });
  try {
    const text = (deps.read ?? readFile)(join(summary.runDir, CONTEXT_BUNDLE_FILE));
    if (text === undefined) return fallback("· context: no context bundle; the prompt has the issue text");
    const read = readContextBundle(text);
    if (read.state !== "ok") return unusable(`bundle-invalid (${read.state === "unreadable" ? read.code : "absent"})`, "the run's context bundle cannot be read");
    const { bundle } = read;
    const created = Date.parse(bundle.createdAt);
    if (summary.history.some((h) => isTicketRecord(h) && Date.parse(h.startedAt) > created)) {
      return fallback("! context: the issue was fetched again after the bundle was made; the prompt has the issue text");
    }
    if (!RULE_SAFE_PATH.test(summary.runDir)) return unusable("run-path", "the run folder's path has a character an agent rule cannot name");
    const role = step.skill_role ?? "coder";
    const isFile = deps.isFile ?? isRegularFile;
    const index = contextIndex(bundle, {
      role,
      now: (deps.now ?? (() => new Date().toISOString()))(),
      runDir: summary.runDir,
      present: (s) => isFile(join(summary.runDir, CONTEXT_SOURCES_DIR, s.id)),
    });
    const folder = join(summary.runDir, CONTEXT_SOURCES_DIR);
    const dirs = [folder];
    try {
      const real = (deps.real ?? realpathSync)(folder);
      if (real !== folder) {
        if (!RULE_SAFE_PATH.test(real)) return unusable("run-path", "the run folder's path has a character an agent rule cannot name");
        dirs.push(real);
      }
    } catch {
      // the folder is not there; every source is listed as missing
    }
    return {
      prompt: step.prompt.replace(PLACEHOLDER, "{{context.index}}"),
      ctx: { ...ctx, context: { index: renderContextIndex(index) } },
      readOnlyDirs: dirs,
      log: `· context: ${index.entries.length} sources for ${role}, ${index.leftOut.length} left out`,
    };
  } catch (e) {
    if (e instanceof ContextIndexError) return unusable(e.code, "a source in the context bundle is not at context/<id>");
    return unusable("internal", "the context index could not be made");
  }
}
