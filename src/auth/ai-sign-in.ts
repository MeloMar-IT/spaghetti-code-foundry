import { LIMIT_RETRY_MS } from "../next-step.js";
import type { RunSummary } from "../engine/state.js";
import { claudeSignInState, createProbe, type Probe } from "../setup-check.js";
import { aiTokenSetAt, aiTokenSource, type AiTokenSource } from "./ai-token.js";

/**
 * Does the Foundry have an AI sign-in? Kept in memory. It is missing only when there is no token and no key variable, and
 * either Claude Code says at the start that it is signed out, or an admin's step stopped on a sign-in error. So an
 * install that works with Claude Code's own login is never held. A found token ends it, and so does a new start.
 */
export interface AiSignIn {
  missing: boolean;
  since?: string;
  /** `probe`: only Claude Code's answer says so, so it is worth asking again. */
  why?: "probe" | "step";
}

type SourceFn = () => { source: AiTokenSource };
type Options = { source?: SourceFn; now?: Date };

/** The Keychain is read synchronously: while the sign-in is missing, it is looked at no more often than this. */
export const SIGN_IN_RECHECK_MIN_MS = 10_000;
const PROBE_TIMEOUT_MS = 5000;

let probeSignedOut = false;
let stepFailed = false;
let since: string | undefined;
let checkedAt: number | undefined;

function clear(): void {
  probeSignedOut = false;
  stepFailed = false;
  since = undefined;
  checkedAt = undefined;
}

/** The cached state. No file or Keychain access. */
export function aiSignIn(): AiSignIn {
  if (!probeSignedOut && !stepFailed) return { missing: false };
  return { missing: true, since, why: stepFailed ? "step" : "probe" };
}

/** True when there is no token: then the caller may mark the sign-in missing. A token that is there clears the state. */
function noToken(o: Options, source: SourceFn): boolean {
  if (source().source !== "none") {
    clear();
    return false;
  }
  const now = o.now ?? new Date();
  since ??= now.toISOString();
  checkedAt = now.getTime();
  return true;
}

/** What Claude Code answered about its own login. */
export function noteSignInProbe(signedOut: boolean, o: Options = {}): void {
  if (!signedOut) {
    probeSignedOut = false;
    if (!stepFailed) since = undefined;
  } else if (noToken(o, o.source ?? aiTokenSource)) probeSignedOut = true;
}

/** An admin's step stopped on a sign-in error. */
export function noteSignInError(log?: (m: string) => void, o: Options = {}): void {
  const was = aiSignIn().missing;
  if (!noToken(o, o.source ?? (() => aiTokenSource(log)))) return;
  stepFailed = true;
  if (!was) log?.("AI sign-in: missing; jobs that need it wait until a token is set (scf auth set-token)");
}

/** While missing: looks for a token (at most once per SIGN_IN_RECHECK_MIN_MS) and clears the state when there is one. */
export function recheckAiSignIn(o: Options = {}): AiSignIn {
  if (!aiSignIn().missing) return aiSignIn();
  const now = (o.now ?? new Date()).getTime();
  if (checkedAt !== undefined && now >= checkedAt && now - checkedAt < SIGN_IN_RECHECK_MIN_MS) return aiSignIn();
  checkedAt = now;
  if ((o.source ?? aiTokenSource)().source !== "none") clear();
  return aiSignIn();
}

/** Asks Claude Code whether it is signed in, when there is no token. At the server's start and by the sweep. Never throws. */
export async function probeAiSignIn(o: Options & { claudeBin?: string; probe?: Probe } = {}): Promise<void> {
  // tests: no server may reach a real `claude`
  if (!o.probe && process.env.FACTORY_NO_SIGN_IN_PROBE) return;
  try {
    const source = o.source ?? aiTokenSource;
    if (source().source !== "none") return clear();
    const state = await claudeSignInState({ probe: o.probe ?? createProbe(undefined, { timeoutMs: PROBE_TIMEOUT_MS }), claudeBin: o.claudeBin });
    // no clear answer changes nothing
    if (state !== "unknown") noteSignInProbe(state === "signed-out", { source, now: o.now });
  } catch {
    // not known: nothing waits
  }
}

/**
 * May a run that stopped for the sign-in be tried again? Never while it is missing. At once when a token was set after the
 * stop; else after the usual wait of a limit. Cheap for many runs: the Keychain is only looked at through recheckAiSignIn.
 */
export function signInRetry(run: Pick<RunSummary, "finishedAt" | "startedAt">, o: { now?: number; setAt?: () => string | undefined; source?: SourceFn } = {}): boolean {
  const now = o.now ?? Date.now();
  if (recheckAiSignIn({ source: o.source, now: new Date(now) }).missing) return false;
  const stopped = new Date(run.finishedAt ?? run.startedAt).getTime();
  const setAt = (o.setAt ?? aiTokenSetAt)();
  return (setAt !== undefined && Date.parse(setAt) > stopped) || now - stopped >= LIMIT_RETRY_MS;
}

/** Tests: back to the state of a new process. */
export const resetAiSignIn = clear;
