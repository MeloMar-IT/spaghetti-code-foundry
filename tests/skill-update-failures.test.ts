import { execFileSync, spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogueError, openPullRequest, openSourcePullRequests } from "../src/skill-import/catalogue-git.js";
import { bodies, branches, branchOf, FAKE_GH, forbiddenCalls, ghCalls, git, GOOD_REVIEW, setBody, sigCounts, update, useWorlds, W, world, type World } from "./helpers/skill-update-world.js";

// Failures and interrupts of `scf skills update` after the staging: no half-made branch, no text of git or gh, and a branch that
// someone else made is never touched (see tests/helpers/skill-update-world.ts).

useWorlds();

describe("failures after the staging leave no half-made branch", () => {
  it("a failing gh call prints a fixed sentence, never gh's text", async () => {
    const w = world(undefined, { FAKE_GH_FAIL: "pr list", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r).toMatchObject({ rc: 1, text: "PROBLEM the open pull requests could not be listed with gh; nothing was proposed" });
    expect(branches(w)).toEqual([]);
    const w2 = world(undefined, { FAKE_GH_FAIL: "pr create", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const r2 = await update(w2, ["lib"], GOOD_REVIEW);
    expect(r2.rc).toBe(1);
    expect(r2.lines.at(-1)).toBe("PROBLEM gh could not open the pull request");
    expect(r2.text).not.toContain("SECRET-TEXT");
    expect(branches(w2)).toEqual([]);
  });

  it("a refused push leaves no branch and prints a fixed sentence", async () => {
    const w = world();
    const hook = join(w.bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho SECRET-GIT-TEXT >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the branch could not be pushed to origin; no pull request was opened");
    expect(r.text).not.toContain("SECRET-GIT-TEXT");
    expect(branches(w)).toEqual([]);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toEqual([]);
  });

  it("never changes or deletes a branch that someone else made", async () => {
    const w = world();
    const name = branchOf("lib", W.c2);
    execFileSync("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${name}`], { cwd: w.clone, env: w.env });
    const theirs = git(w.bare, "rev-parse", name);
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the branch could not be pushed to origin; no pull request was opened");
    expect(git(w.bare, "rev-parse", name)).toBe(theirs);
    // with a pull request open for that branch, it is reported instead
    writeFileSync(`${w.log}.prs.json`, JSON.stringify([{ number: 7, headRefName: name, state: "OPEN", url: "https://github.com/acme/catalogue/pull/7" }]));
    const again = await update(w, ["lib"], GOOD_REVIEW);
    expect(again.lines).toEqual([`OPEN https://github.com/acme/catalogue/pull/7 for lib@${W.c2.slice(0, 12)}; no second pull request was opened`]);
    expect(git(w.bare, "rev-parse", name)).toBe(theirs);
    expect(ghCalls(w).filter((c) => c.includes("pr view") || c.includes("pr edit"))).toEqual([]);
    expect(forbiddenCalls(w)).toEqual([]);
  });

  it("a failing gh pr edit prints a fixed sentence and leaves the pull request as it was", async () => {
    const w = world(undefined, { FAKE_GH_FAIL: "pr edit", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const first = await update(w, ["lib"], GOOD_REVIEW);
    const url = first.lines.at(-1)!.split(" ")[2]!;
    setBody(w, url, { body: "planted" });
    const head = git(w.bare, "rev-parse", branchOf("lib", W.c2));
    const r = await update(w, ["lib"]);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe(`PROBLEM gh could not update the pull request ${url}; it was left as it was`);
    expect(r.text).not.toContain("SECRET-TEXT");
    expect(bodies(w)[url]!.body).toBe("planted");
    expect(git(w.bare, "rev-parse", branchOf("lib", W.c2))).toBe(head);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
    expect(forbiddenCalls(w)).toEqual([]);
  });

  it("a failing gh pr view prints a fixed sentence and edits nothing", async () => {
    const w = world(undefined, { FAKE_GH_FAIL: "pr view", FAKE_GH_FAIL_TEXT: "SECRET-TEXT" });
    const first = await update(w, ["lib"], GOOD_REVIEW);
    const url = first.lines.at(-1)!.split(" ")[2]!;
    const r = await update(w, ["lib"]);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe(`PROBLEM the pull request ${url} could not be read with gh; it was left as it was`);
    expect(r.text).not.toContain("SECRET-TEXT");
    expect(ghCalls(w).filter((c) => c.includes("pr edit"))).toEqual([]);
  });

  it("an open pull request whose branch is not on origin is a problem, not an edit", async () => {
    const w = world();
    const name = branchOf("lib", W.c2);
    const url = "https://github.com/acme/catalogue/pull/7";
    writeFileSync(`${w.log}.prs.json`, JSON.stringify([{ number: 7, headRefName: name, state: "OPEN", url }]));
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe(`PROBLEM the branch ${name} of the pull request ${url} could not be read from origin; it was left as it was`);
    expect(ghCalls(w).filter((c) => c.includes("pr view") || c.includes("pr edit") || c.includes("pr create"))).toEqual([]);
  });

  it("names the branch it could not remove", async () => {
    const w = world(undefined, { FAKE_GH_FAIL: "pr create" });
    const hook = join(w.clone, ".git", "hooks", "pre-push");
    writeFileSync(hook, '#!/bin/sh\nwhile read l ls r rs; do [ "$l" = "(delete)" ] && exit 1; done\nexit 0\n');
    chmodSync(hook, 0o755);
    const r = await update(w, ["lib"], GOOD_REVIEW);
    const name = branchOf("lib", W.c2);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe(`PROBLEM gh could not open the pull request; the branch ${name} may still be on origin: delete it by hand`);
    expect(branches(w)).toEqual([`refs/heads/${name}`]);
  });
});

describe("openSourcePullRequests", () => {
  const ctx = (prs: string) => ({ cwd: W.root, env: { FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: join(W.root, "unit-gh.log"), FAKE_GH_PRS: prs } });
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof CatalogueError ? e.code : "other";
    }
    return "none";
  };
  it("keeps open pull requests of the exact prefix and a safe address", () => {
    const list = [
      { url: "https://github.com/a/b/pull/1", headRefName: "skill-update/lib-aaaaaaaaaaaa", state: "OPEN" },
      { url: "https://github.com/a/b/pull/1", headRefName: "skill-update/lib-aaaaaaaaaaaa", state: "OPEN" },
      { url: "https://github.com/a/b/pull/2", headRefName: "skill-update/lib-AAAAAAAAAAAA", state: "OPEN" },
      { url: "https://github.com/a/b/pull/3", headRefName: "skill-update/lib-aaaaaaaaaaaaa", state: "OPEN" },
      { url: "https://github.com/a/b/pull/4", headRefName: "skill-update/lib-bbbbbbbbbbbb", state: "MERGED" },
      { url: "https://github.com/a/b/issues/5", headRefName: "skill-update/lib-cccccccccccc", state: "OPEN" },
    ];
    expect(openSourcePullRequests(ctx(JSON.stringify(list)), "a/b", "skill-update/lib-")).toEqual([{ url: "https://github.com/a/b/pull/1", branch: "skill-update/lib-aaaaaaaaaaaa" }]);
  });
  it("counts a branch the store refuses as a failed gh call, and does not run gh", () => {
    // A missing gh would be "no-gh": the code shows that gh never ran.
    const missing = { cwd: W.root, env: { FACTORY_GH_BIN: join(W.root, "no-such-gh") } };
    expect(code(() => openPullRequest(missing, "a/b", "-x"))).toBe("gh-failed");
    expect(code(() => openPullRequest(missing, "a/b", "x"))).toBe("no-gh");
  });
  it("fails with gh-failed on an answer it cannot use or a prefix it refuses", () => {
    expect(code(() => openSourcePullRequests(ctx("not json"), "a/b", "skill-update/lib-"))).toBe("gh-failed");
    expect(code(() => openSourcePullRequests(ctx('{"a":1}'), "a/b", "skill-update/lib-"))).toBe("gh-failed");
    expect(code(() => openSourcePullRequests(ctx("[]"), "a/b", "skill-update/li b-"))).toBe("gh-failed");
  });
});

describe("interrupts", () => {
  const hookFor = (w: World) => {
    const hook = join(w.clone, ".git", "hooks", "pre-push");
    writeFileSync(hook, '#!/bin/sh\nwhile read l ls r rs; do [ "$l" != "(delete)" ] && kill -INT "$SCF_TEST_PID"; done\nexit 0\n');
    chmodSync(hook, 0o755);
  };

  it("a SIGINT during the push removes the branch and opens nothing", async () => {
    const w = world(undefined, { SCF_TEST_PID: String(process.pid) });
    hookFor(w);
    const signals = sigCounts();
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the update was interrupted; nothing was proposed");
    expect(branches(w)).toEqual([]);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toEqual([]);
    expect(sigCounts()).toEqual(signals);
  });

  it("a SIGINT while the pull request is being opened still reports it", async () => {
    const hold = join(W.root, "hold-pr-create");
    writeFileSync(hold, "");
    const w = world(undefined, { FAKE_GH_HOLD: hold, FAKE_GH_HOLD_ON: "pr create" });
    // a helper outside this process: it waits for `pr create` in the fake log, signals this process, then lets gh go on
    const script = 'i=0; while [ $i -lt 600 ]; do grep -q "pr create" "$1" 2>/dev/null && break; i=$((i+1)); sleep 0.05; done; kill -INT "$2"; rm -f "$3"';
    spawn("sh", ["-c", script, "sh", w.log, String(process.pid), hold], { detached: true, stdio: "ignore" }).unref();
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(0);
    expect(r.lines.at(-1)).toBe(`OK opened https://github.com/owner/repo/pull/99 for lib@${W.c2.slice(0, 12)}; nothing is approved until it is merged (interrupted after the pull request was opened)`);
    expect(branches(w)).toEqual([`refs/heads/${branchOf("lib", W.c2)}`]);
  });
});
