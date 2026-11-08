import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStore, StoryCommitError } from "../src/stories/local-store.js";
import { commitStory, storyCommitMessage } from "../src/stories/story-commit.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "scf-commit-"));
  dirs.push(d);
  return d;
};
const git = (d: string, ...args: string[]): string => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (s: string): string[] => s.split("\n").filter(Boolean);
const log = (d: string): string[] => lines(git(d, "log", "--format=%s"));
const paths = (d: string, rev = "HEAD"): string[] => lines(git(d, "show", "--name-only", "--format=", rev)).sort();
const stories = ".scf/stories";

function repo(): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "T");
  git(d, "config", "user.email", "t@example.invalid");
  git(d, "config", "commit.gpgsign", "false");
  for (const f of ["README.md", "a.txt", "b.txt"]) writeFileSync(join(d, f), "x\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "init");
  return d;
}
const store = (d: string): LocalStore => new LocalStore(d, "local/x", { lockPollMs: 5 });
const storyFile = (d: string, n: number): string => lines(git(d, "ls-files", stories)).find((f) => f.startsWith(`${stories}/${n}-`))!;

describe("story commits", () => {
  it("makes the message from a number and a fixed word", () => {
    expect(storyCommitMessage(7, "status")).toBe("scf: story #7 status");
  });

  it("commits a new story and next-number", async () => {
    const d = repo();
    await store(d).create({ title: "Hello", body: "b", labels: [] });
    expect(log(d)[0]).toBe("scf: story #1 created");
    expect(paths(d)).toEqual([`${stories}/1-hello.md`, `${stories}/next-number`].sort());
    expect(git(d, "status", "--porcelain", "--", ".scf")).toBe("");
  });

  it("makes one commit per kind of write, holding only that story file", async () => {
    const d = repo();
    const s = store(d);
    await s.create({ title: "Hello", body: "b", labels: [] });
    const steps: [string, () => Promise<unknown>][] = [
      ["edited", () => s.edit(1, { body: "new" })],
      ["labels", () => s.setLabels(1, "ready", [])],
      ["comment", () => s.comment(1, "hi")],
      ["status", () => s.upsertStatusComment(1, "state", { create: true } as never)],
      ["closed", () => s.close(1, "completed")],
      ["reopened", () => s.reopen(1)],
    ];
    for (const [word, run] of steps) {
      const before = log(d).length;
      await run();
      expect(log(d)).toHaveLength(before + 1);
      expect(log(d)[0]).toBe(`scf: story #1 ${word}`);
      expect(paths(d)).toEqual([`${stories}/1-hello.md`]);
    }
  });

  it("makes no commit when the status comment is unchanged", async () => {
    const d = repo();
    const s = store(d);
    await s.create({ title: "Hello", body: "b", labels: [] });
    await s.upsertStatusComment(1, "state", { create: true } as never);
    const count = log(d).length;
    await s.upsertStatusComment(1, "state", { create: true } as never);
    expect(log(d)).toHaveLength(count);
  });

  it("leaves staged, unstaged and untracked changes alone", async () => {
    const d = repo();
    const s = store(d);
    await s.create({ title: "Hello", body: "b", labels: [] });
    writeFileSync(join(d, "a.txt"), "staged\n");
    git(d, "add", "a.txt");
    writeFileSync(join(d, "b.txt"), "unstaged\n");
    writeFileSync(join(d, "c.txt"), "new\n");
    await s.comment(1, "hi");
    expect(paths(d)).toEqual([`${stories}/1-hello.md`]);
    expect(git(d, "diff", "--cached", "--name-only")).toBe("a.txt");
    expect(git(d, "diff", "--name-only")).toBe("b.txt");
    expect(git(d, "status", "--porcelain", "--", "c.txt")).toBe("?? c.txt");
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("staged\n");
    expect(readFileSync(join(d, "b.txt"), "utf8")).toBe("unstaged\n");
  });

  it("does not commit a hand edit to another story, until that story is written", async () => {
    const d = repo();
    const s = store(d);
    await s.create({ title: "One", body: "b", labels: [] });
    await s.create({ title: "Two", body: "b", labels: [] });
    const f2 = join(d, storyFile(d, 2));
    writeFileSync(f2, readFileSync(f2, "utf8").replace("Two", "Renamed"));
    await s.comment(1, "hi");
    expect(paths(d)).toEqual([`${stories}/1-one.md`]);
    expect(git(d, "status", "--porcelain", "--", ".scf")).toContain(`M ${storyFile(d, 2)}`);
    expect((await s.get(2))?.title).toBe("Renamed");
    await s.comment(2, "yo");
    expect(paths(d)).toEqual([storyFile(d, 2)]);
    expect(git(d, "show", "HEAD")).toContain("Renamed");
  });

  it("commits on the checked-out branch", async () => {
    const d = repo();
    const s = store(d);
    await s.create({ title: "Hello", body: "b", labels: [] });
    const main = git(d, "rev-parse", "main");
    git(d, "checkout", "-q", "-b", "feature/x");
    await s.comment(1, "hi");
    expect(git(d, "rev-parse", "main")).toBe(main);
    expect(git(d, "log", "-1", "--format=%s", "feature/x")).toBe("scf: story #1 comment");
  });

  it("keeps the file and releases the lock outside a git repository", async () => {
    const d = tmp();
    const s = store(d);
    await expect(s.create({ title: "Hello", body: "b", labels: [] })).rejects.toThrow(StoryCommitError);
    await expect(s.create({ title: "Again", body: "b", labels: [] })).rejects.toThrow(/not in a git repository/);
    expect(existsSync(join(d, stories, "1-hello.md"))).toBe(true);
    expect(existsSync(join(d, stories, "next-number"))).toBe(true);
    expect(existsSync(join(d, stories, ".lock"))).toBe(false);
    expect(existsSync(join(d, stories, "2-again.md"))).toBe(true);
  });

  it("rejects on a detached HEAD and does not move it", async () => {
    const d = repo();
    const s = store(d);
    await s.create({ title: "Hello", body: "b", labels: [] });
    git(d, "checkout", "-q", "--detach");
    const head = git(d, "rev-parse", "HEAD");
    await expect(s.comment(1, "hi")).rejects.toThrow(/HEAD is detached/);
    expect(git(d, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(d, storyFile(d, 1)), "utf8")).toContain("hi");
  });

  it("names the branch when git fails on an ignored folder", async () => {
    const d = repo();
    writeFileSync(join(d, ".gitignore"), ".scf/\n");
    git(d, "add", ".gitignore");
    git(d, "commit", "-q", "-m", "ignore");
    await expect(store(d).create({ title: "Hello", body: "b", labels: [] })).rejects.toThrow(/1-hello\.md.*on branch main/);
    expect(existsSync(join(d, stories, "1-hello.md"))).toBe(true);
  });

  it("keeps the user's excludes file: an ignored story is not committed", async () => {
    const d = repo();
    const ex = join(tmp(), "ignore");
    writeFileSync(ex, ".scf/\n");
    git(d, "config", "core.excludesFile", ex);
    await expect(store(d).create({ title: "Hello", body: "b", labels: [] })).rejects.toThrow(/on branch main/);
    expect(existsSync(join(d, stories, "1-hello.md"))).toBe(true);
    expect(log(d)).toEqual(["init"]);
  });

  it("reads a file name literally, not as a pattern", async () => {
    const d = repo();
    mkdirSync(join(d, stories), { recursive: true });
    const text = (n: number): string => `---\nnumber: ${n}\ntitle: T${n}\nstate: open\nkind: story\nlabels: []\ndependsOn: []\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n---\n\nbody\n`;
    writeFileSync(join(d, stories, "5-[a].md"), text(5));
    writeFileSync(join(d, stories, "5-a.md"), text(5));
    git(d, "--literal-pathspecs", "add", ".scf/stories/5-[a].md", ".scf/stories/5-a.md");
    git(d, "commit", "-q", "-m", "hand");
    writeFileSync(join(d, stories, "5-a.md"), `${text(5)}more\n`);
    expect(() => commitStory(d, 5, [`${stories}/5-[a].md`], "comment")).not.toThrow();
    expect(log(d)[0]).toBe("hand");
    expect(git(d, "status", "--porcelain")).toContain("5-a.md");
  });

  it("fails clearly when the time is used up", () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "changed\n");
    expect(() => commitStory(d, 1, ["a.txt"], "comment", { budgetMs: 0 })).toThrow(/story #1 is saved in a\.txt, but git did not commit it: out of time/);
    expect(log(d)).toEqual(["init"]);
  });

  it("commits nothing and does not throw when committing is off", async () => {
    const d = tmp();
    await expect(new LocalStore(d, "local/x", { commit: false }).create({ title: "Hello", body: "b", labels: [] })).resolves.toBeTruthy();
  });
});

describe("story commits on their own branch", () => {
  it("commits on scf/stories and leaves the checked-out branch, HEAD and index unchanged", async () => {
    const d = repo();
    git(d, "checkout", "-q", "-b", "work");
    writeFileSync(join(d, "c.txt"), "staged, not committed\n");
    git(d, "add", "c.txt");
    const headBefore = git(d, "rev-parse", "HEAD");
    const indexBefore = git(d, "ls-files", "-s");
    const s = new LocalStore(d, "local/x", { lockPollMs: 5, branch: "scf/stories" });
    const first = await s.create({ title: "One", body: "b", labels: [] });
    const second = await s.create({ title: "Two", body: "b", labels: [] });
    expect(git(d, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work");
    expect(git(d, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(d, "ls-files", "-s")).toBe(indexBefore);
    expect(git(d, "diff", "--cached", "--name-only")).toBe("c.txt");
    expect(log(d)).toEqual(["init"]);
    expect(git(d, "log", "-1", "--format=%s", "scf/stories")).toMatch(/^scf: story #2 created$/);
    expect(lines(git(d, "show", "--name-only", "--format=", "scf/stories")).some((f) => f.startsWith(`${stories}/${second.number}-`))).toBe(true);
    expect(lines(git(d, "ls-tree", "--name-only", "-r", "scf/stories")).some((f) => f.startsWith(`${stories}/${first.number}-`))).toBe(true);
    expect(lines(git(d, "ls-tree", "--name-only", "-r", "scf/stories"))).toContain(`${stories}/next-number`);
    expect(lines(git(d, "ls-tree", "--name-only", "-r", "HEAD"))).not.toContain(`${stories}/next-number`);
  });

  it("does nothing for unchanged files, and leaves no branch when the commit fails", () => {
    const d = repo();
    expect(() => commitStory(d, 9, [`${stories}/missing`], "edited", { branch: "scf/stories" })).not.toThrow();
    expect(() => commitStory(join(d, "nope"), 9, ["x"], "edited", { branch: "scf/stories" })).toThrow(StoryCommitError);
    expect(git(d, "branch", "--list", "scf/stories")).toBe("");
  });
});

describe("the moved commit", () => {
  it("commits once per change, adds none for the same values, and commits a file whose first commit failed", async () => {
    const d = repo();
    const s = new LocalStore(d, "local/x", { lockPollMs: 5, branch: "scf/stories" });
    await s.create({ title: "Hello", body: "b", labels: [] });
    const commits = (): string[] => lines(git(d, "log", "--format=%s", "scf/stories"));
    await s.setGithubIssue(1, 9, "acme/app");
    expect(commits()[0]).toBe("scf: story #1 moved");
    const n = commits().length;
    await s.setGithubIssue(1, 9, "acme/app");
    expect(commits()).toHaveLength(n);
    await s.markGithubDone(1);
    expect(commits()).toHaveLength(n + 1);
    // the file is saved but its commit is missing (the first commit failed): the same call again commits it
    const file = join(d, stories, "1-hello.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/updated: .*/, "updated: 2030-01-01T00:00:00.000Z"));
    await s.setGithubIssue(1, 9, "acme/app");
    expect(commits()).toHaveLength(n + 2);
    expect(git(d, "show", "scf/stories:.scf/stories/1-hello.md")).toContain("updated: 2030-01-01T00:00:00.000Z");
  });
});

describe("commitCreated", () => {
  const branch = "scf/stories";
  /** A story saved without its commit, as after a failed commit. */
  async function saved(): Promise<{ d: string; s: LocalStore }> {
    const d = repo();
    await new LocalStore(d, "local/x", { lockPollMs: 5, commit: false }).create({ title: "Hello", body: "b", labels: [] });
    return { d, s: new LocalStore(d, "local/x", { lockPollMs: 5, branch }) };
  }

  it("commits the saved story and the number file once, and does nothing the second time", async () => {
    const { d, s } = await saved();
    await s.commitCreated(1);
    const n = lines(git(d, "log", "--format=%s", branch)).length;
    expect(git(d, "show", "--name-only", "--format=%s", branch).split("\n").filter(Boolean).sort()).toEqual(["scf: story #1 created", `${stories}/1-hello.md`, `${stories}/next-number`].sort());
    await s.commitCreated(1);
    expect(lines(git(d, "log", "--format=%s", branch))).toHaveLength(n);
  });

  it("runs the guard under the lock before anything is written, and a throwing guard commits nothing", async () => {
    const { d, s } = await saved();
    await expect(s.commitCreated(1, undefined, () => { throw new Error("not-yours"); })).rejects.toThrow("not-yours");
    expect(git(d, "branch", "--list", branch)).toBe("");
    const f = new LocalStore(d, "local/x", { lockPollMs: 5, commit: false });
    const before = readFileSync(join(d, stories, "next-number"), "utf8");
    await expect(f.create({ title: "Two", body: "", labels: [] }, undefined, () => { throw new Error("not-yours"); })).rejects.toThrow("not-yours");
    expect(readFileSync(join(d, stories, "next-number"), "utf8")).toBe(before);
    expect(existsSync(join(d, stories, "2-two.md"))).toBe(false);
  });

  it("refuses a linked stories directory before it makes a lock file in the target", async () => {
    const d = repo();
    const target = tmp();
    mkdirSync(join(d, ".scf"));
    symlinkSync(target, join(d, stories));
    await expect(new LocalStore(d, "local/x", { lockPollMs: 5, branch }).commitCreated(1)).rejects.toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses a linked or malformed number file, and commits nothing from it", async () => {
    const { d, s } = await saved();
    const next = join(d, stories, "next-number");
    const outside = join(tmp(), "n");
    writeFileSync(outside, "5\n");
    rmSync(next);
    symlinkSync(outside, next);
    await expect(s.commitCreated(1)).rejects.toThrow(/next-number/);
    rmSync(next);
    writeFileSync(next, "banana\n");
    await expect(s.commitCreated(1)).rejects.toThrow(/next-number/);
    expect(git(d, "branch", "--list", branch)).toBe("");
    expect(readFileSync(outside, "utf8")).toBe("5\n");
  });
});
