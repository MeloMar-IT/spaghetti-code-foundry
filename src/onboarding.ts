import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthError } from "./agents/targets.js";
import { createProbe, hasAuthCommand, setupCheck, type SetupCheckOptions, type SetupReport } from "./setup-check.js";
import { resolveClaudeBinAsync, runClaude } from "./steps/claude.js";
import { resolveCodexBin, runCodex } from "./steps/codex.js";

// Sign in to Claude Code and Codex from the Foundry, and check with one tiny call that the tool works.
// The sign-in is the tool's own (`claude auth login`, `codex login`): fixed arguments, no shell, stdin closed, output thrown away.
// The Foundry never asks for a password and never returns the tool's output; the answers are plain sentences.

export type OnboardingTool = "claude" | "codex";
export const ONBOARDING_TOOLS: readonly OnboardingTool[] = ["claude", "codex"];
export const SIGN_IN_LIMIT_MS = 5 * 60_000;
export const TEST_PROMPT = "Reply with exactly the word: OK";

export type SignInState = "started" | "done" | "missing" | "failed";
export interface SignInAnswer { tool: OnboardingTool; state: SignInState; explain: string }
export type TestCallState = "ok" | "missing" | "signed-out" | "failed";
export interface TestCallAnswer { tool: OnboardingTool; state: TestCallState; explain: string; seconds: number }

export interface OnboardingOptions {
  claudeBin?: string;
  codexBin?: string;
  /** Tests: a fake child process. */
  spawnFn?: typeof spawn;
  /** How long the sign-in call waits for the tool to end before it answers `started` (default 2000). */
  startWaitMs?: number;
  /** The time limit of a sign-in (default 5 minutes). */
  limitMs?: number;
  /** Time between SIGTERM and SIGKILL of a sign-in (default 1000). */
  graceMs?: number;
  check?: (o: SetupCheckOptions) => Promise<SetupReport>;
  /** The time limit of the test call (default 120 000). */
  timeoutMs?: number;
}

const NAMES: Record<OnboardingTool, string> = { claude: "Claude Code", codex: "Codex" };
const TERMINAL: Record<OnboardingTool, string> = { claude: "type claude in a terminal, then /login", codex: "type codex login in a terminal" };

const text = {
  started: (t: OnboardingTool) => `The ${NAMES[t]} sign-in has started. A sign-in window opens on the computer that runs the Foundry. Sign in there, then run the test call. If no window opens, ${TERMINAL[t]} on that computer.`,
  already: (t: OnboardingTool) => `A sign-in window is already open for ${NAMES[t]}, on the computer that runs the Foundry. Finish it there, then run the test call.`,
  done: (t: OnboardingTool) => `The ${NAMES[t]} sign-in finished on the computer that runs the Foundry. Run the test call to check it.`,
  missing: (t: OnboardingTool) => `${NAMES[t]} is not on the computer that runs the Foundry. Install it first.`,
  oldClaude: "This Claude Code is too old to sign in from here. Update Claude Code, or type claude in a terminal on the computer that runs the Foundry, then /login.",
  failed: (t: OnboardingTool) => `The ${NAMES[t]} sign-in did not finish. On the computer that runs the Foundry, ${TERMINAL[t]}.`,
  ok: (t: OnboardingTool) => `${NAMES[t]} works: one tiny call went through.`,
  signedOut: (t: OnboardingTool) => `${NAMES[t]} is not signed in. Start the sign-in, or ${TERMINAL[t]} on the computer that runs the Foundry.`,
  callFailed: (t: OnboardingTool) => `${NAMES[t]} is installed and signed in, but the tiny call did not work. Try again in a moment.`,
};

/** `tool` of a request: exactly `claude` or `codex`. */
export function parseTool(v: unknown): OnboardingTool {
  if (typeof v !== "string" || !(ONBOARDING_TOOLS as readonly string[]).includes(v)) throw new Error(`tool must be one of: ${ONBOARDING_TOOLS.join(", ")}`);
  return v as OnboardingTool;
}

interface Slot { child?: ChildProcess; cancelled?: boolean }
/** One sign-in per tool. The slot is taken before any await and freed when the child has really closed. */
const slots = new Map<OnboardingTool, Slot>();

const resolveBin = (tool: OnboardingTool, o: OnboardingOptions): Promise<string> | string =>
  tool === "claude" ? (o.claudeBin ?? resolveClaudeBinAsync()) : (o.codexBin ?? resolveCodexBin());

/** A spawn that keeps the child in the slot, so a shutdown can reach it. `onEnd` runs when the child closes or fails to start. */
function tracked(slot: Slot, spawnFn: typeof spawn, onEnd?: () => void): typeof spawn {
  return ((cmd: string, args: string[], opts: object) => {
    const child = (spawnFn as unknown as (c: string, a: string[], o: object) => ChildProcess)(cmd, args, opts);
    slot.child = child;
    if (onEnd) {
      child.once("close", onEnd);
      child.once("error", onEnd);
    }
    return child;
  }) as unknown as typeof spawn;
}

export async function startSignIn(tool: OnboardingTool, o: OnboardingOptions = {}): Promise<SignInAnswer> {
  if (slots.has(tool)) return { tool, state: "started", explain: text.already(tool) };
  const slot: Slot = {};
  slots.set(tool, slot);
  const release = () => {
    if (slots.get(tool) === slot) slots.delete(tool);
  };
  const spawnFn = o.spawnFn ?? spawn;
  try {
    const bin = await resolveBin(tool, o);
    if (slot.cancelled) return release(), { tool, state: "failed", explain: text.failed(tool) };
    if (tool === "claude") {
      const help = await createProbe(tracked(slot, spawnFn))(bin, ["--help"]);
      slot.child = undefined;
      // A shutdown during the probe: no login is started after it.
      if (slot.cancelled) return release(), { tool, state: "failed", explain: text.failed(tool) };
      if (help.missing) return release(), { tool, state: "missing", explain: text.missing(tool) };
      if (!hasAuthCommand(help)) return release(), { tool, state: "failed", explain: text.oldClaude };
    }
    const tracking = tracked(slot, spawnFn, release);
    const login = createProbe(tracking, { timeoutMs: o.limitMs ?? SIGN_IN_LIMIT_MS, graceMs: o.graceMs ?? 1000 })(bin, tool === "claude" ? ["auth", "login"] : ["login"]);
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<"waited">((resolve) => {
      timer = setTimeout(() => resolve("waited"), o.startWaitMs ?? 2000);
      timer.unref?.();
    });
    const r = await Promise.race([login, waited]);
    clearTimeout(timer);
    if (r === "waited") return { tool, state: "started", explain: text.started(tool) };
    if (r.missing) return release(), { tool, state: "missing", explain: text.missing(tool) };
    if (r.code === 0) return { tool, state: "done", explain: text.done(tool) };
    return { tool, state: "failed", explain: text.failed(tool) };
  } catch {
    if (!slot.child) release();
    return { tool, state: "failed", explain: text.failed(tool) };
  }
}

/** Server shutdown: stop every running sign-in (SIGTERM, then SIGKILL after the grace). */
export function stopSignIns(graceMs = 1000): void {
  for (const slot of slots.values()) {
    // Marked first: a sign-in still resolving its binary or running the help probe starts no login.
    slot.cancelled = true;
    const child = slot.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
    t.unref?.();
    child.once("close", () => clearTimeout(t));
  }
}

const calls = new Map<string, Promise<TestCallAnswer>>();

/** One tiny call to check the tool. While one runs for the same tool, a second request gets the same answer. */
export function testCall(tool: OnboardingTool, o: OnboardingOptions = {}): Promise<TestCallAnswer> {
  const key = `${tool}|${o.claudeBin ?? ""}|${o.codexBin ?? ""}`;
  const have = calls.get(key);
  if (have) return have;
  const p = runTestCall(tool, o).finally(() => calls.delete(key));
  calls.set(key, p);
  return p;
}

async function runTestCall(tool: OnboardingTool, o: OnboardingOptions): Promise<TestCallAnswer> {
  const started = Date.now();
  const answer = (state: TestCallState, explain: string): TestCallAnswer => ({ tool, state, explain, seconds: Math.round((Date.now() - started) / 1000) });
  const claudeBin = o.claudeBin ?? (await resolveClaudeBinAsync());
  const codexBin = o.codexBin ?? resolveCodexBin();
  const report = await (o.check ?? setupCheck)({ claudeBin, codexBin });
  const state = (id: string) => report.items.find((i) => i.id === id)?.state;
  if (state(tool) === "missing") return answer("missing", text.missing(tool));
  if (state(`${tool}-sign-in`) === "signed-out") return answer("signed-out", text.signedOut(tool));
  const dir = mkdtempSync(join(tmpdir(), "factory-onboarding-"));
  const timeoutMs = o.timeoutMs ?? 120_000;
  try {
    const r = tool === "claude"
      ? await runClaude({ prompt: TEST_PROMPT, cwd: dir, logFile: join(dir, "log"), claudeBin, model: "haiku", noTools: true, tools: [], permissionMode: "plan", timeoutMs })
      : await runCodex({ prompt: TEST_PROMPT, cwd: dir, logFile: join(dir, "log"), codexBin, sandbox: "read-only", reviewer: true, clean: true, effort: "low", timeoutMs });
    if (r.ok) return answer("ok", text.ok(tool));
    return isAuthError(r.error, r.output) ? answer("signed-out", text.signedOut(tool)) : answer("failed", text.callFailed(tool));
  } catch {
    return answer("failed", text.callFailed(tool));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
