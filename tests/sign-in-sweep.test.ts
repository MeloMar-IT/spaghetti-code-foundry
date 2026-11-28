import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiSignIn, noteSignInError, noteSignInProbe, recheckAiSignIn, resetAiSignIn } from "../src/auth/ai-sign-in.js";
import { ConfigSchema } from "../src/config.js";
import { SIGN_IN_REASON } from "../src/errors.js";
import { resumeSignInStopped, startSignInSweep, type SignInSweepDeps } from "../src/server/sign-in-sweep.js";

const NOW = new Date("2026-10-07T12:00:00Z");
const LEGACY = 'signed out — the Claude Code login has expired. Sign in again: run "claude" in a terminal and type /login. The run continues by itself after that.';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-sign-in-sweep-"));
  resetAiSignIn();
});
afterEach(() => {
  resetAiSignIn();
  rmSync(tmp, { recursive: true, force: true });
});

/** A run file that stopped for the sign-in an hour ago. */
function stopped(id: string, over: Record<string, unknown> = {}) {
  mkdirSync(join(tmp, id), { recursive: true });
  const finishedAt = new Date(NOW.getTime() - 3_600_000).toISOString();
  writeFileSync(join(tmp, id, "run.json"), JSON.stringify({
    runId: id, flow: "github-issue", status: "stopped", reason: SIGN_IN_REASON, startedAt: finishedAt, finishedAt,
    source: "ui", owner: "u1", vars: {}, history: [], totalCostUsd: 0, ...over,
  }));
}

function deps(over: Partial<SignInSweepDeps> = {}) {
  const submitted: unknown[] = [];
  const d: SignInSweepDeps = {
    runsDir: tmp, watchers: () => [], ready: () => true, log: () => {},
    scheduler: { isActive: () => false, isQueued: () => false, submit: (job, meta) => (submitted.push([job, meta]), "x") },
    ...over,
  };
  return { d, submitted };
}

describe("the sign-in sweep", () => {
  it("resumes a run started by hand with its own source and owner, also a stop of an older version", () => {
    stopped("20261007-100000-aaaa");
    stopped("20261007-100000-bbbb", { reason: LEGACY });
    const { d, submitted } = deps();
    expect(resumeSignInStopped(d).sort()).toEqual(["20261007-100000-aaaa", "20261007-100000-bbbb"]);
    expect(submitted[0]).toEqual([expect.objectContaining({ kind: "resume" }), { source: "ui", owner: "u1" }]);
  });

  it("resumes runs of other watchers, and leaves the runs of an issues watcher to it", () => {
    const watchers = ConfigSchema.parse({ watchers: [{ id: "w", github_repo: "acme/app", flow: "github-issue" }] }).watchers;
    stopped("20261007-100000-cccc", { source: "watcher w", vars: { github_repo: "acme/app", issue: "8" } });
    stopped("20261007-100000-dddd", { source: "watcher ci", flow: "fix-ci", vars: { github_repo: "acme/app" } });
    expect(resumeSignInStopped(deps({ watchers: () => watchers }).d)).toEqual(["20261007-100000-dddd"]);
  });

  it("skips what is queued, active, archived, parked, old, not ready or stopped for something else", () => {
    stopped("20261007-100000-eeee", { archivedAt: NOW.toISOString() });
    stopped("20261007-100000-ffff", { parkedAt: NOW.toISOString() });
    stopped("20261007-100000-gggg", { reason: 'signed out — the Codex login has expired. Sign in again: run "codex login".' });
    stopped("20261007-100000-iiii", { source: "refinement 7d2b0c1e" });
    stopped("20261007-100000-jjjj", { status: "failed" });
    expect(resumeSignInStopped(deps().d)).toEqual([]);
    stopped("20261007-100000-kkkk");
    const base = deps().d.scheduler;
    expect(resumeSignInStopped(deps({ scheduler: { ...base, isQueued: () => true } }).d)).toEqual([]);
    expect(resumeSignInStopped(deps({ scheduler: { ...base, isActive: () => true } }).d)).toEqual([]);
    expect(resumeSignInStopped(deps({ ready: () => false }).d)).toEqual([]);
  });

  it("resumes a run that stopped eight days ago once the sign-in is set again", () => {
    stopped("20260929-100000-hhhh", { startedAt: "2026-09-29T10:00:00Z", finishedAt: "2026-09-29T10:00:00Z" });
    const { d, submitted } = deps();
    expect(resumeSignInStopped(d)).toEqual(["20260929-100000-hhhh"]);
    expect(submitted).toHaveLength(1);
  });

  it("clears a missing sign-in on every tick, even with no run waiting for it", () => {
    noteSignInError(undefined, { source: () => ({ source: "none" }), now: NOW });
    expect(aiSignIn().missing).toBe(true);
    const { d, submitted } = deps({
      recheck: () => recheckAiSignIn({ source: () => ({ source: "keychain" }), now: new Date(NOW.getTime() + 60_000) }),
    });
    startSignInSweep(d)();
    expect(aiSignIn().missing).toBe(false);
    expect(submitted).toEqual([]);
  });

  it("resumes nothing while the sign-in is missing", () => {
    stopped("20261007-100000-llll");
    noteSignInError(undefined, { source: () => ({ source: "none" }) });
    expect(resumeSignInStopped(deps({ ready: undefined }).d)).toEqual([]);
  });

  it("asks Claude Code again only while its answer alone says the sign-in is missing", () => {
    let asked = 0;
    const tick = () => startSignInSweep(deps({ reprobe: async () => void asked++, recheck: () => {} }).d)();
    tick();
    noteSignInProbe(true, { source: () => ({ source: "none" }) });
    tick();
    noteSignInError(undefined, { source: () => ({ source: "none" }) });
    tick();
    expect(asked).toBe(1);
  });
});
