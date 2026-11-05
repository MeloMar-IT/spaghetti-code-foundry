import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantedBranch, isProtectedBranch, ownerPushTarget, pushOwnerBranch, pushTagToOwner, scrubCredentials, updateOwnerBranch, worktrees } from "../src/repos/local-branch.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};

let root: string;
let owner: string;
let ws: string;
const refs = (dir: string, pattern: string) => git(dir, "for-each-ref", "--format=%(refname)", pattern);

/** An owner with main and develop (checked out: main), a clone of it, and a commit adding feature.txt on the clone's develop. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scf-lb-"));
  owner = join(root, "owner");
  ws = join(root, "ws");
  mkdirSync(owner);
  git(owner, "init", "-q", "-b", "main");
  write(owner, "README.md", "hi\n");
  git(owner, "add", "-A");
  git(owner, "commit", "-q", "-m", "first");
  git(owner, "branch", "develop");
  git(root, "clone", "-q", owner, ws);
  git(ws, "checkout", "-q", "-B", "develop", "origin/develop");
  write(ws, "feature.txt", "feature\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "feature");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const update = (o: Partial<Parameters<typeof updateOwnerBranch>[0]> = {}) =>
  updateOwnerBranch({ workspace: ws, ownerDir: owner, branch: "develop", runId: "run1", protectedPatterns: ["main", "release/*"], ...o });
const wsHead = () => git(ws, "rev-parse", "develop");

describe("updateOwnerBranch", () => {
  it("moves a branch that is not checked out and leaves no temporary ref", () => {
    const r = update();
    expect(r).toEqual({ kind: "updated", branch: "develop", sha: wsHead(), synced: false });
    expect(git(owner, "rev-parse", "develop")).toBe(wsHead());
    expect(refs(owner, "refs/scf")).toBe("");
    expect(git(owner, "branch", "--show-current")).toBe("main");
    expect(existsSync(join(owner, "feature.txt"))).toBe(false);
  });

  it("creates a branch that is missing", () => {
    git(ws, "branch", "-q", "newdev", "origin/main");
    const r = update({ branch: "newdev" });
    expect(r.kind).toBe("updated");
    expect(git(owner, "rev-parse", "newdev")).toBe(git(ws, "rev-parse", "origin/main"));
  });

  it("says moved when the owner committed on the branch after the clone", () => {
    git(owner, "checkout", "-q", "develop");
    write(owner, "own.txt", "x\n");
    git(owner, "add", "-A");
    git(owner, "commit", "-q", "-m", "own");
    git(owner, "checkout", "-q", "main");
    const before = git(owner, "rev-parse", "develop");
    expect(update().kind).toBe("moved");
    expect(git(owner, "rev-parse", "develop")).toBe(before);
    expect(refs(owner, "refs/scf")).toBe("");
  });

  it("says moved for a workspace commit that does not descend from the owner's branch", () => {
    git(ws, "checkout", "-q", "--orphan", "other");
    write(ws, "z.txt", "z\n");
    git(ws, "add", "z.txt");
    git(ws, "commit", "-q", "-m", "z");
    git(ws, "branch", "-q", "-f", "develop", "other");
    const before = git(owner, "rev-parse", "develop");
    expect(update().kind).toBe("moved");
    expect(git(owner, "rev-parse", "develop")).toBe(before);
  });

  it("updates the ref and the work tree when the branch is checked out and clean", () => {
    git(owner, "checkout", "-q", "develop");
    const r = update();
    expect(r).toMatchObject({ kind: "updated", synced: true });
    expect(git(owner, "rev-parse", "develop")).toBe(wsHead());
    expect(readFileSync(join(owner, "feature.txt"), "utf8")).toBe("feature\n");
  });

  it("pauses when the checked-out branch has a tracked change", () => {
    git(owner, "checkout", "-q", "develop");
    write(owner, "README.md", "changed\n");
    const before = git(owner, "rev-parse", "develop");
    const r = update();
    expect(r.kind).toBe("paused");
    expect(git(owner, "rev-parse", "develop")).toBe(before);
    expect(readFileSync(join(owner, "README.md"), "utf8")).toBe("changed\n");
    expect(refs(owner, "refs/scf")).toBe("");
  });

  it("does not count changes under .scf/stories", () => {
    write(owner, ".scf/stories/x.md", "s\n");
    git(owner, "add", "-A");
    git(owner, "commit", "-q", "-m", "story");
    git(owner, "branch", "-f", "develop", "main");
    git(ws, "fetch", "-q", "origin");
    git(ws, "checkout", "-q", "-B", "develop", "origin/develop");
    write(ws, "feature.txt", "feature\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "feature");
    git(owner, "checkout", "-q", "develop");
    write(owner, ".scf/stories/x.md", "edited\n");
    expect(update()).toMatchObject({ kind: "updated", synced: true });
    expect(readFileSync(join(owner, ".scf/stories/x.md"), "utf8")).toBe("edited\n");
  });

  it("handles a branch checked out in a linked worktree", () => {
    const linked = join(root, "linked");
    git(owner, "worktree", "add", "-q", linked, "develop");
    write(linked, "README.md", "dirty\n");
    expect(update().kind).toBe("paused");
    git(linked, "checkout", "--", "README.md");
    expect(update()).toMatchObject({ kind: "updated", synced: true });
    expect(existsSync(join(linked, "feature.txt"))).toBe(true);
    expect(existsSync(join(owner, "feature.txt"))).toBe(false);
  });

  it("reads a linked worktree whose path has spaces, quotes and a tab, and updates the branch there", () => {
    const odd = join(root, 'odd "wt"\tname with spaces');
    git(owner, "worktree", "add", "-q", odd, "develop");
    expect(update()).toMatchObject({ kind: "updated", synced: true });
    expect(existsSync(join(odd, "feature.txt"))).toBe(true);
    // the workspace's origin/develop must show the owner's new develop before the next update (else it is "moved")
    git(ws, "fetch", "-q", "origin");
    git(ws, "commit", "-q", "--allow-empty", "-m", "next");
    write(odd, "README.md", "dirty\n");
    expect(update().kind).toBe("paused");
  });

  it("parses the NUL-separated worktree listing, also for paths with line breaks", () => {
    const text = "worktree /a b\0HEAD 1\0branch refs/heads/main\0\0worktree /x\nline\0HEAD 2\0branch refs/heads/develop\0\0worktree /d\0HEAD 3\0detached\0\0";
    expect(worktrees(text)).toEqual([
      { path: "/a b", branch: "refs/heads/main" },
      { path: "/x\nline", branch: "refs/heads/develop" },
      { path: "/d", branch: undefined },
    ]);
  });

  it("refuses protected branches, bad names and a missing temporary ref", () => {
    git(ws, "branch", "-q", "release/1", "develop");
    expect(update({ branch: "release/1" }).kind).toBe("refused");
    expect(update({ branch: "main" }).kind).toBe("refused");
    for (const branch of ["-x", "a..b", "HEAD"]) expect(update({ branch }).kind).toBe("refused");
    expect(refs(owner, "refs/scf")).toBe("");
    expect(() => git(owner, "rev-parse", "--verify", "release/1")).toThrow();
  });

  it("refuses when origin is somewhere else or the address is rewritten", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    git(elsewhere, "init", "-q", "--bare");
    git(ws, "config", "remote.origin.pushurl", elsewhere);
    expect(update().kind).toBe("refused");
    expect(refs(elsewhere, "refs")).toBe("");
    git(ws, "config", "--unset", "remote.origin.pushurl");
    git(ws, "config", `url.${elsewhere}/.insteadOf`, `${owner}/`);
    expect(update().kind).toBe("refused");
    git(ws, "config", "--remove-section", `url.${elsewhere}/`);
    git(ws, "remote", "set-url", "origin", elsewhere);
    expect(update().kind).toBe("refused");
    expect(refs(elsewhere, "refs")).toBe("");
  });

  it("refuses when the push hook refuses", () => {
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(ws, "config", "core.hooksPath", hooks);
    const before = git(owner, "rev-parse", "develop");
    expect(update().kind).toBe("refused");
    expect(git(owner, "rev-parse", "develop")).toBe(before);
  });

  it("never replaces an ignored or untracked file at a path the update adds", () => {
    git(owner, "checkout", "-q", "develop");
    write(owner, ".gitignore", "feature.txt\n");
    git(owner, "add", ".gitignore");
    git(owner, "commit", "-q", "-m", "ignore");
    git(ws, "fetch", "-q", "origin");
    git(ws, "checkout", "-q", "-B", "develop", "origin/develop");
    write(ws, "feature.txt", "feature\n");
    git(ws, "add", "-f", "feature.txt");
    git(ws, "commit", "-q", "-m", "feature");
    write(owner, "feature.txt", "mine\n"); // ignored
    expect(update().kind).toBe("paused");
    expect(readFileSync(join(owner, "feature.txt"), "utf8")).toBe("mine\n");
    rmSync(join(owner, "feature.txt"));
    git(owner, "reset", "-q", "--hard");
  });

  it("never replaces an untracked file at a path the update adds", () => {
    git(owner, "checkout", "-q", "develop");
    write(owner, "feature.txt", "mine\n");
    expect(update().kind).toBe("paused");
    expect(readFileSync(join(owner, "feature.txt"), "utf8")).toBe("mine\n");
  });

  it("does not touch another branch when the owner switched away before the update", () => {
    git(owner, "checkout", "-q", "develop");
    git(owner, "checkout", "-q", "main");
    write(owner, "wip.txt", "wip\n");
    const main = git(owner, "rev-parse", "main");
    expect(update()).toMatchObject({ kind: "updated", synced: false });
    expect(git(owner, "rev-parse", "main")).toBe(main);
    expect(readFileSync(join(owner, "wip.txt"), "utf8")).toBe("wip\n");
    expect(existsSync(join(owner, "feature.txt"))).toBe(false);
  });
});

describe("pushOwnerBranch", () => {
  it("pushes to the remote and prefers the branch's own remote", () => {
    const bare = join(root, "bare.git");
    const backup = join(root, "backup.git");
    for (const d of [bare, backup]) git(root, "init", "-q", "--bare", d);
    git(owner, "remote", "add", "origin", bare);
    expect(pushOwnerBranch({ ownerDir: owner, branch: "develop" })).toEqual({ kind: "pushed", remote: "origin" });
    expect(git(bare, "rev-parse", "develop")).toBe(git(owner, "rev-parse", "develop"));
    git(owner, "remote", "add", "backup", backup);
    git(owner, "config", "branch.develop.remote", "backup");
    expect(pushOwnerBranch({ ownerDir: owner, branch: "develop" })).toEqual({ kind: "pushed", remote: "backup" });
    expect(git(backup, "rev-parse", "develop")).toBe(git(owner, "rev-parse", "develop"));
  });

  it("says none without a remote", () => {
    const o = git(owner, "remote");
    expect(o).toBe("");
    expect(pushOwnerBranch({ ownerDir: owner, branch: "develop" })).toEqual({ kind: "none" });
  });

  it("fails without a credential in the reason", () => {
    git(owner, "remote", "add", "origin", "https://user:secret@127.0.0.1:1/x.git");
    const r = pushOwnerBranch({ ownerDir: owner, branch: "develop", timeoutMs: 20_000 });
    expect(r.kind).toBe("failed");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("the final release: allowProtected, the grant, the tag", () => {
  /** A merge of the workspace's develop into main, tagged, in the workspace. */
  const release = (tag = "release-2026-01-01") => {
    git(ws, "checkout", "-q", "-B", "main", "origin/main");
    git(ws, "merge", "-q", "--no-ff", "--no-edit", "-m", "Release", "develop");
    git(ws, "tag", "-a", tag, "-m", tag);
    return git(ws, "rev-parse", "main");
  };
  const home = () => {
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = join(root, "home");
    return () => { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; };
  };
  const hooksEnv = (dir: string, allow: string): NodeJS.ProcessEnv => ({ FACTORY_PUSH_ALLOW: allow, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: dir });
  const token = "ab12".repeat(8);

  it("moves a protected branch only with allowProtected", () => {
    const sha = release();
    git(owner, "checkout", "-q", "develop");
    expect(update({ branch: "main" })).toEqual({ kind: "refused", reason: "main is a protected branch" });
    expect(git(owner, "rev-parse", "main")).not.toBe(sha);
    expect(update({ branch: "main", allowProtected: true })).toEqual({ kind: "updated", branch: "main", sha, synced: false });
    expect(git(owner, "rev-parse", "main")).toBe(sha);
    // the same commit again counts as updated, so a resume can go on
    expect(update({ branch: "main", allowProtected: true }).kind).toBe("updated");
  });

  it("grantedBranch reads the engine's token file, and nothing else", () => {
    const restore = home();
    try {
      const hooks = join(root, "home", "hooks");
      write(hooks, `allow/${token}`, "main");
      expect(grantedBranch(hooksEnv(hooks, `main:${token}`))).toBe("main");
      expect(grantedBranch(hooksEnv(hooks, `develop:${token}`))).toBeUndefined();
      expect(grantedBranch(hooksEnv(hooks, `main:${"cd34".repeat(8)}`))).toBeUndefined();
      expect(grantedBranch(hooksEnv(hooks, "main:../x"))).toBeUndefined();
      expect(grantedBranch(hooksEnv("hooks", `main:${token}`))).toBeUndefined();
      expect(grantedBranch({})).toBeUndefined();
      expect(grantedBranch({ FACTORY_PUSH_ALLOW: `main:${token}` })).toBeUndefined();
      // a fabricated hooks folder with a matching token file is not the engine's
      const fake = join(root, "fake-hooks");
      write(fake, `allow/${token}`, "main");
      expect(grantedBranch(hooksEnv(fake, `main:${token}`))).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("pushTagToOwner creates the tag, repeats safely and never moves another one", () => {
    release();
    update({ branch: "main", allowProtected: true });
    const t = (tag: string) => pushTagToOwner({ workspace: ws, ownerDir: owner, tag });
    expect(t("release-2026-01-01")).toEqual({ kind: "tagged" });
    expect(git(owner, "rev-parse", "release-2026-01-01^{commit}")).toBe(git(ws, "rev-parse", "main"));
    expect(t("release-2026-01-01")).toEqual({ kind: "tagged" });
    // the owner has a tag of that name on another object
    git(owner, "tag", "other", "develop");
    git(ws, "tag", "-a", "other", "-m", "other");
    const r = t("other");
    expect(r.kind).toBe("refused");
    expect(git(owner, "rev-parse", "other")).toBe(git(owner, "rev-parse", "develop"));
    for (const bad of ["../x", "-x", "a b", ""]) expect(t(bad).kind).toBe("refused");
    expect(t("missing").kind).toBe("refused");
  });

  it("pushOwnerBranch can push a tag with the branch", () => {
    release();
    update({ branch: "main", allowProtected: true });
    pushTagToOwner({ workspace: ws, ownerDir: owner, tag: "release-2026-01-01" });
    const bare = join(root, "bare.git");
    git(root, "init", "-q", "--bare", bare);
    git(owner, "remote", "add", "origin", bare);
    expect(pushOwnerBranch({ ownerDir: owner, branch: "main", tags: ["release-2026-01-01"] })).toEqual({ kind: "pushed", remote: "origin" });
    expect(git(bare, "rev-parse", "release-2026-01-01")).toBe(git(owner, "rev-parse", "release-2026-01-01"));
    expect(pushOwnerBranch({ ownerDir: owner, branch: "main", tags: ["../x"] }).kind).toBe("failed");
  });

  it("the tool refuses `release` without a grant, and does not move main", () => {
    release();
    const before = git(owner, "rev-parse", "main");
    const r = spawnSync("node", [join(process.cwd(), "tools", "local-branch"), "release", "main", "release-2026-01-01"], {
      cwd: ws, encoding: "utf8", env: { ...ENV, FACTORY_LOCAL_REPO_DIR: owner, FACTORY_RUN_ID: "run1", FACTORY_PROTECTED_BRANCHES: "main", FACTORY_PUSH_ALLOW: `main:${token}` },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only the final step");
    expect(git(owner, "rev-parse", "main")).toBe(before);
    expect(git(owner, "tag")).toBe("");
  });

  it("the tool exits 1 with TAG_FAILED when the tag cannot be placed, and 0 with the grant otherwise", () => {
    const restore = home();
    try {
      const sha = release();
      const hooks = join(root, "home", "hooks");
      write(hooks, `allow/${token}`, "main");
      const env = { ...ENV, FACTORY_HOME: join(root, "home"), FACTORY_LOCAL_REPO_DIR: owner, FACTORY_RUN_ID: "run1", FACTORY_PROTECTED_BRANCHES: "main", ...hooksEnv(hooks, `main:${token}`) };
      const run = (tag: string) => spawnSync("node", [join(process.cwd(), "tools", "local-branch"), "release", "main", tag], { cwd: ws, encoding: "utf8", env });
      git(owner, "tag", "taken", "develop");
      git(ws, "tag", "-a", "taken", "-m", "taken");
      const bad = run("taken");
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain("TAG_FAILED:");
      expect(git(owner, "rev-parse", "main")).toBe(sha); // main moved before the tag failed: a resume finishes the tag
      const ok = run("release-2026-01-01");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("TAG: release-2026-01-01");
      expect(git(owner, "rev-parse", "release-2026-01-01^{commit}")).toBe(sha);
    } finally {
      restore();
    }
  });
});

describe("helpers", () => {
  it("matches protected patterns", () => {
    expect(isProtectedBranch("release/1", ["main", "release/*"])).toBe(true);
    expect(isProtectedBranch("main", ["main"])).toBe(true);
    expect(isProtectedBranch("mainx", ["main"])).toBe(false);
    expect(isProtectedBranch("ab", ["a?"])).toBe(true);
    expect(isProtectedBranch("a.b", ["a.b"])).toBe(true);
    expect(isProtectedBranch("axb", ["a.b"])).toBe(false);
  });

  it("scrubs sign-ins from addresses and keeps the last line", () => {
    expect(scrubCredentials("fatal: first\nfatal: unable to access 'https://user:secret@host/x.git/': nope\n")).toBe("fatal: unable to access 'https://***@host/x.git/': nope");
    expect(scrubCredentials("x".repeat(500)).length).toBe(300);
    expect(scrubCredentials("")).toBe("");
  });
});

describe("ownerPushTarget (#796)", () => {
  it("is undefined without a remote", () => {
    expect(ownerPushTarget(owner, "develop")).toBeUndefined();
  });

  it("shows the push address without its sign-in, and resolves each branch on its own remote", () => {
    git(owner, "remote", "add", "origin", "https://user:secret@example.com/a/b.git");
    git(owner, "remote", "add", "other", join(root, "other.git"));
    git(owner, "config", "branch.main.remote", "other");
    const dev = ownerPushTarget(owner, "develop");
    expect(dev).toEqual({ remote: "origin", urls: ["https://user:secret@example.com/a/b.git"], shown: ["https://***@example.com/a/b.git"] });
    expect(JSON.stringify(dev?.shown)).not.toContain("secret");
    expect(ownerPushTarget(owner, "main")).toMatchObject({ remote: "other", shown: [join(root, "other.git")] });
  });

  it("lists every push destination of a remote, since git push goes to all of them", () => {
    git(owner, "remote", "add", "origin", join(root, "one.git"));
    git(owner, "remote", "set-url", "--add", "--push", "origin", join(root, "one.git"));
    git(owner, "remote", "set-url", "--add", "--push", "origin", join(root, "two.git"));
    const t = ownerPushTarget(owner, "develop");
    expect(t?.urls).toEqual([join(root, "one.git"), join(root, "two.git")]);
    expect(t?.shown).toEqual([join(root, "one.git"), join(root, "two.git")]);
  });
});
