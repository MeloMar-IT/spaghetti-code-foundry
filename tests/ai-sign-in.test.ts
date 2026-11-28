import { beforeEach, describe, expect, it } from "vitest";
import { aiSignIn, noteSignInError, noteSignInProbe, probeAiSignIn, recheckAiSignIn, resetAiSignIn, SIGN_IN_RECHECK_MIN_MS, signInRetry } from "../src/auth/ai-sign-in.js";
import type { AiTokenSource } from "../src/auth/ai-token.js";
import { explainError, isSignInStop, NOT_EXPLAINED, SIGN_IN_REASON } from "../src/errors.js";
import type { Probe } from "../src/setup-check.js";

// The sign-in state, with a stand-in for the token and for `claude`: no Keychain, no process.

const T0 = new Date("2026-10-01T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A token source that counts how often it is asked. */
function tokens(start: AiTokenSource = "none") {
  const t = { is: start, reads: 0, source: () => (t.reads++, { source: t.is }) };
  return t;
}

/** A `claude` that answers `--help` and `auth status`. */
function claude(status: string, help = "Commands:\n  auth    Manage authentication\n") {
  const calls: string[] = [];
  const probe: Probe = async (_cmd, args) => {
    calls.push(args.join(" "));
    return { code: 0, out: args[0] === "--help" ? help : status, missing: false };
  };
  return { probe, calls };
}

beforeEach(() => resetAiSignIn());

describe("the AI sign-in state", () => {
  it("the probe and a step error mark it missing only when there is no token", () => {
    for (const source of ["keychain", "environment"] as const) {
      noteSignInProbe(true, { source: tokens(source).source });
      noteSignInError(undefined, { source: tokens(source).source });
      expect(aiSignIn()).toEqual({ missing: false });
    }
    noteSignInProbe(true, { source: tokens().source, now: T0 });
    expect(aiSignIn()).toEqual({ missing: true, since: T0.toISOString(), why: "probe" });
    noteSignInProbe(false);
    expect(aiSignIn()).toEqual({ missing: false });
    const lines: string[] = [];
    noteSignInError((m) => lines.push(m), { source: tokens().source, now: T0 });
    expect(aiSignIn()).toMatchObject({ missing: true, why: "step" });
    expect(lines).toHaveLength(1);
    // a signed-in answer of Claude Code does not take back what a step found
    noteSignInProbe(false);
    expect(aiSignIn().missing).toBe(true);
  });

  it("a recheck finds a token and clears; it reads at most once per interval, and not at all when nothing is missing", () => {
    const t = tokens();
    recheckAiSignIn({ source: t.source, now: T0 });
    expect(t.reads).toBe(0);
    noteSignInError(undefined, { source: t.source, now: T0 });
    t.reads = 0;
    t.is = "keychain";
    expect(recheckAiSignIn({ source: t.source, now: at(1000) }).missing).toBe(true);
    expect(t.reads).toBe(0);
    expect(recheckAiSignIn({ source: t.source, now: at(SIGN_IN_RECHECK_MIN_MS) })).toEqual({ missing: false });
    expect(t.reads).toBe(1);
  });

  it("many waiting runs do not multiply the reads of the Keychain", () => {
    const t = tokens();
    noteSignInError(undefined, { source: t.source, now: T0 });
    t.reads = 0;
    const run = { startedAt: T0.toISOString(), finishedAt: T0.toISOString() };
    for (let i = 0; i < 200; i++) expect(signInRetry(run, { source: t.source, now: at(SIGN_IN_RECHECK_MIN_MS + i).getTime() })).toBe(false);
    expect(t.reads).toBe(1);
  });

  it("a stopped run goes on at once with a token set after it stopped, else after 30 minutes", () => {
    const run = { startedAt: at(-1000).toISOString(), finishedAt: T0.toISOString() };
    const ask = (ms: number, setAt?: Date) => signInRetry(run, { now: at(ms).getTime(), setAt: () => setAt?.toISOString() });
    expect(ask(60_000, at(30_000))).toBe(true);
    expect(ask(60_000, at(-30_000))).toBe(false);
    expect(ask(60_000)).toBe(false);
    expect(ask(30 * 60_000)).toBe(true);
    noteSignInError(undefined, { source: tokens().source, now: T0 });
    expect(signInRetry(run, { source: tokens().source, now: at(3_600_000).getTime(), setAt: () => at(30_000).toISOString() })).toBe(false);
  });

  it("the probe asks Claude Code only when there is no token, and only a clear 'signed out' counts", async () => {
    const out = claude('{"loggedIn": false}');
    await probeAiSignIn({ probe: out.probe, claudeBin: "claude", source: tokens("keychain").source });
    expect(out.calls).toEqual([]);
    await probeAiSignIn({ probe: out.probe, claudeBin: "claude", source: tokens().source });
    expect(aiSignIn()).toMatchObject({ missing: true, why: "probe" });
    // no clear answer changes nothing; a signed-in answer clears
    const old = claude("", "Commands:\n  mcp\n");
    await probeAiSignIn({ probe: old.probe, claudeBin: "claude", source: tokens().source });
    expect(old.calls).toEqual(["--help"]);
    expect(aiSignIn().missing).toBe(true);
    await probeAiSignIn({ probe: claude('{"loggedIn": true}').probe, claudeBin: "claude", source: tokens().source });
    expect(aiSignIn().missing).toBe(false);
    await probeAiSignIn({ probe: old.probe, claudeBin: "claude", source: tokens().source });
    expect(aiSignIn().missing).toBe(false);
    await probeAiSignIn({ probe: () => Promise.reject(new Error("boom")), claudeBin: "claude", source: tokens().source });
    expect(aiSignIn().missing).toBe(false);
  });
});

describe("the words of a sign-in error", () => {
  it("are explained, for an administrator and for a user", () => {
    for (const raw of ["Failed to refresh OAuth token", "can't save to the Keychain", "OAuth token has expired", 'claude exited with code 1: OAuth token has expired', SIGN_IN_REASON]) {
      expect(explainError(raw).why, raw).toBe("the Foundry has no AI sign-in");
      expect(explainError(raw).why).not.toBe(NOT_EXPLAINED);
      expect(explainError(raw, "run", true).todo).toBe("Ask the administrator");
    }
  });

  it("a Claude stop of this or an older version is a sign-in stop; a Codex stop is not", () => {
    expect(isSignInStop(SIGN_IN_REASON)).toBe(true);
    expect(isSignInStop('signed out — the Claude Code login has expired. Sign in again: run "claude" in a terminal and type /login.')).toBe(true);
    expect(isSignInStop('signed out — the Codex login has expired. Sign in again: run "codex login".')).toBe(false);
    expect(isSignInStop(undefined)).toBe(false);
  });
});
