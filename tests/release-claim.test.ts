import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimAfterResolve } from "../src/engine/release-claim.js";
import { hasCommit, markCommit, releaseBuildsDir } from "../src/release/build-claims.js";

const SHA = "f".repeat(40);

describe("claimAfterResolve", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claim-"));
    rmSync(releaseBuildsDir(), { recursive: true, force: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (text: string) => {
    mkdirSync(join(dir, "release"), { recursive: true });
    writeFileSync(join(dir, "release", "plan.json"), text);
  };
  const call = (over: Record<string, unknown> = {}) =>
    claimAfterResolve({
      flow: "release-build", stepId: "resolve", ok: true, runDir: dir, runId: "r1",
      vars: { github_repo: "acme/app", ref: "main", release_build_watcher: "rel" }, ...over,
    } as Parameters<typeof claimAfterResolve>[0]);

  it("takes the commit of the plan; a second run is turned into a skip plan, the same run again is fine", () => {
    plan(JSON.stringify({ sha: SHA, recipe: {} }));
    expect(call()).toMatch(/taken by this run/);
    expect(hasCommit("acme/app", "main", SHA)).toBe(true);
    expect(call()).toMatch(/taken by this run/); // a resume
    expect(call({ runId: "r2" })).toMatch(/handled before/);
    expect(JSON.parse(readFileSync(join(dir, "release", "plan.json"), "utf8"))).toEqual({ sha: SHA, skip: "this commit was handled before" });
  });

  it("refuses a commit that was seen before", () => {
    markCommit("acme/app", "main", SHA);
    plan(JSON.stringify({ sha: SHA }));
    expect(call()).toMatch(/handled before/);
  });

  it("does nothing for other steps, other flows, hand-started runs, failed steps and bad plans", () => {
    plan(JSON.stringify({ sha: SHA }));
    expect(call({ stepId: "build" })).toBeUndefined();
    expect(call({ flow: "chore" })).toBeUndefined();
    expect(call({ ok: false })).toBeUndefined();
    expect(call({ vars: { github_repo: "acme/app", ref: "main" } })).toBeUndefined();
    plan("{ nope");
    expect(call()).toBeUndefined();
    plan(JSON.stringify({ sha: "../x" }));
    expect(call()).toBeUndefined();
    expect(hasCommit("acme/app", "main", SHA)).toBe(false);
  });
});
