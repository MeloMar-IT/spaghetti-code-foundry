import { execFileSync, spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forbiddenCalls, git, sigCounts } from "./helpers/skill-update-world.js";
import { P, pBranches, pCalls, propose, pworld, useProposeWorld, type PWorld } from "./helpers/skill-propose-world.js";

// Failures and interrupts of `scf skills release propose` after the checks: no half-made branch, no text of git or gh, and a branch
// that someone else made is never touched. Kept apart from skill-release-propose.test.ts so each file stays fast.

useProposeWorld();
const BRANCH = "skill-catalogue/acme-1.1.0";
const URL99 = "https://github.com/owner/repo/pull/99";
const creates = (w: PWorld) => pCalls(w).filter((c) => c.includes("pr create"));
const hook = (dir: string, name: string, body: string) => {
  const p = join(dir, "hooks", name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
};
const check = (w: PWorld, r: { text: string }) => {
  expect(r.text).not.toContain("SECRET-TEXT");
  expect(r.text).not.toContain("SECRET-GIT-TEXT");
  expect(forbiddenCalls(w as never)).toEqual([]);
};

describe("failures leave no half-made branch", () => {
  it("a failing pr list prints a fixed sentence", async () => {
    const w = pworld(undefined, { FAKE_GH_FAIL: "pr list", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r).toMatchObject({ rc: 1, text: "PROBLEM the open pull requests could not be listed with gh; nothing was proposed" });
    expect(pBranches(w)).toEqual([]);
    check(w, r);
  });

  it("a failing pr create deletes the branch again", async () => {
    const w = pworld(undefined, { FAKE_GH_FAIL: "pr create", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM gh could not open the pull request");
    expect(pBranches(w)).toEqual([]);
    check(w, r);
  });

  it("a refused push leaves no branch and opens no pull request", async () => {
    const w = pworld();
    hook(w.bare, "pre-receive", "echo SECRET-GIT-TEXT >&2\nexit 1");
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the branch could not be pushed to origin; no pull request was opened");
    expect(pBranches(w)).toEqual([]);
    expect(creates(w)).toEqual([]);
    check(w, r);
  });

  it("never changes a branch that someone else made", async () => {
    const w = pworld();
    execFileSync("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`], { cwd: w.clone, env: w.env });
    const theirs = git(w.bare, "rev-parse", BRANCH);
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.lines.at(-1)).toBe("PROBLEM the branch could not be pushed to origin; no pull request was opened");
    expect(git(w.bare, "rev-parse", BRANCH)).toBe(theirs);
    writeFileSync(`${w.log}.prs.json`, JSON.stringify([{ number: 7, headRefName: BRANCH, state: "OPEN", url: "https://github.com/acme/deploy/pull/7" }]));
    const again = await propose(w, ["acme@1.1.0"]);
    expect(again.lines).toEqual(["OPEN https://github.com/acme/deploy/pull/7 for acme@1.1.0; no second pull request was opened"]);
    expect(git(w.bare, "rev-parse", BRANCH)).toBe(theirs);
    expect(creates(w)).toEqual([]);
    check(w, again);
  });

  it("names the branch it could not remove", async () => {
    const w = pworld(undefined, { FAKE_GH_FAIL: "pr create" });
    hook(join(w.clone, ".git"), "pre-push", 'while read l ls r rs; do [ "$l" = "(delete)" ] && exit 1; done\nexit 0');
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe(`PROBLEM gh could not open the pull request; the branch ${BRANCH} may still be on origin: delete it by hand`);
    expect(pBranches(w)).toEqual([`refs/heads/${BRANCH}`]);
  });

  it("reports a pull request that gh made before it failed", async () => {
    const w = pworld(undefined, { FAKE_GH_CREATE_THEN_FAIL: "1", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(0);
    expect(r.lines.at(-1)).toBe(`OK opened ${URL99} for acme@1.1.0; an installation uses it only after its config names it`);
    expect(pBranches(w)).toEqual([`refs/heads/${BRANCH}`]);
    expect(creates(w)).toHaveLength(1);
    check(w, r);
  });
});

describe("interrupts", () => {
  it("a SIGINT during the push removes the branch and opens nothing", async () => {
    const w = pworld(undefined, { SCF_TEST_PID: String(process.pid) });
    hook(join(w.clone, ".git"), "pre-push", 'while read l ls r rs; do [ "$l" != "(delete)" ] && kill -INT "$SCF_TEST_PID"; done\nexit 0');
    const signals = sigCounts();
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the proposal was interrupted; nothing was proposed");
    expect(pBranches(w)).toEqual([]);
    expect(creates(w)).toEqual([]);
    expect(sigCounts()).toEqual(signals);
  });

  it("a SIGINT while the pull request is opened still reports it", async () => {
    const hold = join(P.root, "hold-pr-create");
    writeFileSync(hold, "");
    const w = pworld(undefined, { FAKE_GH_HOLD: hold, FAKE_GH_HOLD_ON: "pr create" });
    // a helper outside this process: it waits for `pr create` in the fake log, signals this process, then lets gh go on
    const script = 'i=0; while [ $i -lt 600 ]; do grep -q "pr create" "$1" 2>/dev/null && break; i=$((i+1)); sleep 0.05; done; kill -INT "$2"; rm -f "$3"';
    spawn("sh", ["-c", script, "sh", w.log, String(process.pid), hold], { detached: true, stdio: "ignore" }).unref();
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(0);
    expect(r.lines.at(-1)).toBe(`OK opened ${URL99} for acme@1.1.0; an installation uses it only after its config names it (interrupted after the pull request was opened)`);
    expect(pBranches(w)).toEqual([`refs/heads/${BRANCH}`]);
  });
});
