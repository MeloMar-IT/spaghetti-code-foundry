import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRepoName } from "../src/auth/local-name.js";
import { addRepo, getRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { removeCredential } from "../src/credentials/store.js";
import { isBot, isStatusComment } from "../src/github.js";
import { addRepoWatcher } from "../src/repos/watchers.js";
import { type Entry, UNREADABLE_TITLE } from "../src/stories/local-map.js";
import {
  CONNECT_FIRST, issueLabels, mapRefs, MAX_COMMENT_CHARS, moveLockFile, MOVED_COMMENTS_MARKER, movedComments, moveToGithub, planFrom, withFrontMatterLinks,
} from "../src/stories/move-to-github.js";
import { type FileStory, formatStoryFile, parseStoryFile, storyFileName } from "../src/stories/story-file.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const story = (n: number, o: Partial<FileStory> = {}): FileStory => ({
  number: n, title: `Story ${n}`, state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: `Body ${n}.`, comments: [], ...o,
});
const entry = (s: FileStory): Entry => ({ ok: true, n: s.number, file: storyFileName(s.number, s.title), rel: `.scf/stories/${s.number}`, mtimeMs: 0, story: s });
const map = (pairs: [number, number][]) => new Map(pairs);

describe("links in the text", () => {
  it("maps #N in the Depends on section, in Foundry markers and on Epic lines, and leaves other numbers alone", () => {
    const body = ["See #5 and #6.", "", "## Depends on", "- #2", "- #3", "", "## Notes", "Issue #2 again.", "**Epic:** #4", "<!-- claude-factory depends-on -->", "- #2", "<!-- claude-factory depends-on end -->"].join("\n");
    const out = mapRefs(body, map([[2, 12], [4, 14]]));
    expect(out).toContain("See #5 and #6.");
    expect(out).toContain("- #12\n- local story 3, not moved");
    expect(out).toContain("Issue #2 again.");
    expect(out).toContain("**Epic:** #14");
    expect(out).toContain("<!-- claude-factory depends-on -->\n- #12\n");
    expect(out).not.toMatch(/local story 3, not moved.*#3/);
  });
  it("maps references past 1,000 characters of the section", () => {
    const body = `## Depends on\n${"filler text ".repeat(120)}\n- #2\n`;
    expect(mapRefs(body, map([[2, 77]]))).toContain("- #77");
    expect(mapRefs(`**Epic:** #9`, new Map())).toBe("**Epic:** local story 9, not moved");
  });
  it("does not read a mapped number twice", () => {
    expect(mapRefs("## Depends on\n- #1\n- #2", map([[1, 2], [2, 3]]))).toBe("## Depends on\n- #2\n- #3");
  });
  it("withFrontMatterLinks still writes a dependency on the story's own epic", () => {
    expect(withFrontMatterLinks(story(1, { epic: 4, dependsOn: [4], body: "Do it." }))).toBe("**Epic:** #4\n\nDo it.\n\n## Depends on\n- #4");
  });
  it("withFrontMatterLinks writes an epic and dependencies that are only in the front matter, and never twice", () => {
    const s = story(1, { epic: 4, dependsOn: [2, 3], body: "Do it." });
    const text = withFrontMatterLinks(s);
    expect(text).toBe("**Epic:** #4\n\nDo it.\n\n## Depends on\n- #2\n- #3");
    expect(withFrontMatterLinks({ ...s, body: text })).toBe(text);
    expect(withFrontMatterLinks(story(1, { dependsOn: [3], body: "A\n\n## Depends on\n- #2\n\n## Next\nB" }))).toBe("A\n\n## Depends on\n- #2\n- #3\n\n## Next\nB");
    expect(withFrontMatterLinks(story(1))).toBe("Body 1.");
  });
});

describe("comments and labels", () => {
  it("keeps every comment whole, with author and time, and nothing reads it as written by the Foundry", () => {
    const s = story(1, { comments: [
      { author: "alice", createdAt: "2026-01-02T00:00:00Z", body: "Hello\n<!-- claude-factory run=3 -->" },
      { author: "Foundry", createdAt: "2026-01-03T00:00:00Z", body: "Status\n\n<!-- claude-factory status -->" },
      { author: "bob", createdAt: "2026-01-04T00:00:00Z", body: "<!-- spaghetti-code-foundry decision -->\nx\n<!-- spaghetti-code-foundry status -->" },
    ] });
    const text = movedComments(s)!;
    expect(text.startsWith(`${MOVED_COMMENTS_MARKER}\n`)).toBe(true);
    expect(text).toContain("### Comment by alice on 2026-01-02T00:00:00Z");
    expect(text).toContain("Status");
    expect(text).toContain("<!-- moved: claude-factory run=3 -->");
    expect(text).toContain("<!-- moved: spaghetti-code-foundry decision -->");
    expect(text).not.toMatch(/ status -->/);
    expect(isBot({ body: text })).toBe(false);
    expect(isStatusComment({ body: text })).toBe(false);
    expect(movedComments(story(1))).toBeUndefined();
  });
  it("issueLabels drops a literal go and adds the build label only when asked, once", () => {
    const s = story(1, { state: "go", labels: ["Bug", "GO", "bug", "x"] });
    expect(issueLabels(s, "Factory_go", false)).toEqual(["Bug", "x"]);
    expect(issueLabels(s, "Factory_go", true)).toEqual(["Bug", "x", "Factory_go"]);
    expect(issueLabels({ ...s, state: "open" }, "Factory_go", true)).toEqual(["Bug", "x"]);
  });
  it("planFrom lists open and go stories, moved ones, broken files and too large comments; closed ones only when asked", () => {
    const big = story(5, { comments: [{ author: "a", createdAt: "2026-01-01T00:00:00Z", body: "x".repeat(MAX_COMMENT_CHARS) }] });
    const entries: Entry[] = [
      entry(story(1)), entry(story(2, { state: "go", githubIssue: 40, githubRepo: "acme/app" })), entry(story(3, { state: "closed" })),
      { ok: false, n: 4, file: "4-x.md", rel: ".scf/stories/4-x.md", mtimeMs: 0, reason: "title is missing" }, entry(big),
    ];
    expect(planFrom(entries).map((p) => [p.number, p.status, p.githubIssue ?? p.reason ?? ""])).toEqual([
      [1, "create", ""], [2, "already-moved", 40], [4, "unreadable", "title is missing"], [5, "too-large", ""],
    ]);
    expect(planFrom(entries)[2]!.title).toBe(UNREADABLE_TITLE);
    expect(planFrom(entries, true).map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---- the move, with the fake gh -------------------------------------------------------------------------------------

let gh: ReturnType<typeof fakeGithub>;
let base: string;
let dir: string;
let name: string;
let admin: { id: string };
const config = () => ConfigSchema.parse({ protected_branches: [] });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const folder = () => join(dir, ".scf", "stories");
const put = (s: FileStory) => {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(join(folder(), storyFileName(s.number, s.title)), formatStoryFile(s));
};
const snapshot = () => Object.fromEntries(readdirSync(folder()).map((f) => [f, readFileSync(join(folder(), f), "utf8")]));
const fileOf = (n: number): FileStory => {
  const f = readdirSync(folder()).find((x) => x.startsWith(`${n}-`))!;
  const r = parseStoryFile(readFileSync(join(folder(), f), "utf8"), f);
  if (!r.ok) throw new Error(r.reason);
  return r.story;
};
const target = (url = "acme/app") => addRepo(admin.id, { url, method: "github-token", token: TOKEN });
const mv = (o: Partial<Parameters<typeof moveToGithub>[0]> = {}) => moveToGithub({ local: name, target: "acme/app", owner: admin.id, config, ...o });
const createdCalls = () => (gh.ghLog().match(/^--- created issue/gm) ?? []).length;

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  base = realpathSync(mkdtempSync(join(tmpdir(), "move-gh-")));
  dir = join(base, "my-app");
  mkdirSync(folder(), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const rec = addRepo(admin.id, { url: dir, method: "local" }, { ownerOk: () => true });
  name = localRepoName({ id: rec.id, url: rec.url });
});
afterEach(() => {
  delete process.env.FAKE_GH_FAIL_CREATE_AT;
  delete process.env.FAKE_GH_EXPECT_TOKEN;
  delete process.env.FAKE_GH_COMMENTS_FROM_LOG;
  gh.restore();
  rmSync(base, { recursive: true, force: true });
});

const sample = () => {
  put(story(1, { state: "go", labels: ["bug", "go"], epic: 4, body: "Do A.\n\n## Depends on\n- #2\n- #9\n" }));
  put(story(2, { comments: [
    { author: "alice", createdAt: "2026-01-02T00:00:00Z", body: "Looks fine." },
    { author: "Foundry", createdAt: "2026-01-03T00:00:00Z", body: "Working\n\n<!-- claude-factory status -->" },
  ] }));
  put(story(3, { state: "closed", body: "Old." }));
  put(story(4, { kind: "epic", title: "The epic" }));
  put(story(5, { dependsOn: [3], body: "Needs the old one." }));
  writeFileSync(join(folder(), "6-broken.md"), "no front matter\n");
};

describe("moveToGithub", () => {
  it("a dry run lists the plan and changes nothing", async () => {
    target();
    sample();
    const before = snapshot();
    const r = await mv({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.plan.map((p) => [p.number, p.status])).toEqual([[1, "create"], [2, "create"], [4, "create"], [5, "create"], [6, "unreadable"]]);
    expect(snapshot()).toEqual(before);
    expect(createdCalls()).toBe(0);
    expect(gh.ghLog()).not.toMatch(/updated issue|--- comment on/);
    expect(git(dir, "branch", "--list", "scf/stories")).toBe("");
  });

  it("creates the issues lowest number first, maps the numbers, posts one comment and saves the numbers", async () => {
    target();
    sample();
    const r = await mv();
    expect(r.created).toEqual([{ story: 1, issue: 101 }, { story: 2, issue: 102 }, { story: 4, issue: 103 }, { story: 5, issue: 104 }]);
    expect(gh.createdBodies().map((c) => c.title)).toEqual(["Story 1", "Story 2", "The epic", "Story 5"]);
    expect(gh.createdBodies()[0]!.labels).toEqual(["bug"]); // the build label waits for pass 2
    const issues = gh.bugIssues();
    expect(issues[0]!.labels.map((l) => l.name).sort()).toEqual(["bug", "go"]);
    expect(issues[0]!.body).toContain("**Epic:** #103");
    expect(issues[0]!.body).toContain("- #102\n- local story 9, not moved");
    expect(issues[3]!.body).toContain("## Depends on\n- local story 3, not moved");
    expect(gh.labels()).toContain("go");
    const comments = gh.comments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.issue).toBe(102);
    expect(comments[0]!.body).toContain("alice");
    expect(isBot({ body: comments[0]!.body })).toBe(false);
    expect(fileOf(1)).toMatchObject({ githubIssue: 101, githubRepo: "acme/app", githubDone: true });
    expect(fileOf(3).githubIssue).toBeUndefined();
    expect(git(dir, "log", "--format=%s", "scf/stories")).toContain("scf: story #1 moved");
    expect(r.done).toEqual([1, 2, 4, 5]);
  });

  it("uses the label of the target's first issues watcher", async () => {
    const rec = target();
    addRepoWatcher(rec.id, { id: "b-w", label: "Second" });
    addRepoWatcher(rec.id, { id: "a-w", label: "Factory_go" });
    put(story(1, { state: "go" }));
    await mv();
    expect(gh.bugIssues()[0]!.labels.map((l) => l.name)).toEqual(["Factory_go"]);
    expect(gh.labels()).toContain("Factory_go");
  });

  it("a repeat creates nothing, posts no comment, and leaves a removed label and a reopened issue alone", async () => {
    target();
    put(story(1, { state: "go", labels: ["bug"], body: "A\n\n## Depends on\n- #3\n" }));
    put(story(2, { comments: [{ author: "alice", createdAt: "2026-01-02T00:00:00Z", body: "Hi" }] }));
    put(story(3, { state: "closed" }));
    await mv({ includeClosed: true });
    expect(gh.closedIssues().map((c) => c.issue)).toEqual([103]);
    expect(createdCalls()).toBe(3);
    const bodies = gh.bugIssues().map((i) => i.body);
    expect(bodies[0]).toContain("- #103");
    gh.setBugIssues(gh.bugIssues().map((i) => (i.number === 101 ? { ...i, labels: i.labels.filter((l) => l.name !== "go") } : i.number === 103 ? { ...i, state: "open", closed_at: null } : i)));
    const edits = gh.updatedBodies().length;
    const r = await mv({ includeClosed: true });
    expect(r.created).toEqual([]);
    expect(createdCalls()).toBe(3);
    expect(gh.comments()).toHaveLength(1);
    expect(gh.updatedBodies().length).toBe(edits + 3);
    expect(gh.bugIssues().map((i) => i.body)).toEqual(bodies);
    expect(gh.bugIssues().find((i) => i.number === 101)!.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(gh.bugIssues().find((i) => i.number === 103)!.state).toBe("open");
  });

  it("goes on after a stop, with no duplicates", async () => {
    target();
    for (const n of [1, 2, 3]) put(story(n));
    process.env.FAKE_GH_FAIL_CREATE_AT = "2";
    await expect(mv()).rejects.toThrow();
    expect(fileOf(1).githubIssue).toBe(101);
    expect(fileOf(2).githubIssue).toBeUndefined();
    delete process.env.FAKE_GH_FAIL_CREATE_AT;
    const r = await mv();
    expect(r.created.map((c) => c.story)).toEqual([2, 3]);
    expect(gh.bugIssues().map((i) => i.title)).toEqual(["Story 1", "Story 2", "Story 3"]);
    expect([1, 2, 3].map((n) => fileOf(n).githubDone)).toEqual([true, true, true]);
  });

  it("does not post the combined comment again when a stop came after it", async () => {
    process.env.FAKE_GH_COMMENTS_FROM_LOG = "1";
    target();
    put(story(2, { comments: [{ author: "alice", createdAt: "2026-01-02T00:00:00Z", body: "Hi" }] }));
    await mv();
    const f = join(folder(), readdirSync(folder()).find((x) => x.startsWith("2-"))!);
    writeFileSync(f, readFileSync(f, "utf8").replace("github_done: true\n", ""));
    expect(fileOf(2).githubDone).toBeUndefined();
    await mv();
    expect(gh.comments()).toHaveLength(1);
    expect(fileOf(2).githubDone).toBe(true);
  });

  it("never creates a story whose combined comment is too large", async () => {
    target();
    put(story(1, { comments: [{ author: "a", createdAt: "2026-01-01T00:00:00Z", body: "x".repeat(MAX_COMMENT_CHARS) }] }));
    put(story(2));
    const r = await mv();
    expect(r.plan.map((p) => p.status)).toEqual(["too-large", "create"]);
    expect(gh.bugIssues().map((i) => i.title)).toEqual(["Story 2"]);
    expect(fileOf(1).githubIssue).toBeUndefined();
  });

  it("refuses a second target before any GitHub write", async () => {
    target();
    put(story(1));
    await mv();
    target("acme/other");
    const writes = gh.ghLog().length;
    await expect(mv({ target: "acme/other" })).rejects.toThrow("this project was already moved to acme/app");
    expect(gh.ghLog().length).toBe(writes);
    expect(createdCalls()).toBe(1);
  });

  it("stops with the connect message when the sign-in is missing, removed or refused, and creates nothing", async () => {
    put(story(1));
    const before = snapshot();
    await expect(mv({ target: "acme/missing" })).rejects.toThrow(CONNECT_FIRST); // not in the owner's repositories
    addRepo(admin.id, "acme/host"); // method none: the server's own login
    await expect(mv({ target: "acme/host" })).rejects.toThrow(CONNECT_FIRST);
    const rec = target();
    process.env.FAKE_GH_EXPECT_TOKEN = "another-token";
    await expect(mv()).rejects.toThrow(CONNECT_FIRST); // GitHub answers 401
    delete process.env.FAKE_GH_EXPECT_TOKEN;
    removeCredential(admin.id, getRepo(rec.id)!.credentialId!);
    await expect(mv()).rejects.toThrow(CONNECT_FIRST);
    expect(createdCalls()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("refuses a story with github_issue but no github_repo before any GitHub write", async () => {
    target();
    put(story(1, { githubIssue: 41 }));
    const before = snapshot();
    await expect(mv()).rejects.toThrow("story #1 has github_issue but no github_repo");
    expect(gh.ghLog()).toBe("");
    expect(createdCalls()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("refuses the local project of another user", async () => {
    target();
    put(story(1));
    const other = await createUser({ name: "Other", email: "other@example.com", password: TEST_PASSWORD, role: "user" });
    await expect(mv({ owner: other.id })).rejects.toThrow("not in My repositories");
    expect(createdCalls()).toBe(0);
  });

  it("allows one move of a project at a time, and takes over the lock of a dead process", async () => {
    target();
    put(story(1));
    const lock = moveLockFile(dir);
    writeFileSync(lock, `${process.pid}\n`);
    await expect(mv()).rejects.toThrow("a move of this project is already running");
    expect(existsSync(lock)).toBe(true);
    expect(createdCalls()).toBe(0);
    writeFileSync(lock, "2147483646\n");
    await mv();
    expect(createdCalls()).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });
});
