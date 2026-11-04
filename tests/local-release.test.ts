import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The daily release of a local project (Make this version final): green checks, one question, then develop goes into main in the
// owner's folder with a tag. Every helper that would reach `gh` is a spy that fails, and `gh` is not on PATH.
const calls = vi.hoisted(() => ({ gh: [] as string[] }));
vi.mock("../src/github.js", async (orig) => {
  const real = await orig<typeof import("../src/github.js")>();
  const never = (name: string) => vi.fn(async () => { calls.gh.push(name); throw new Error(`${name} must not be called`); });
  return { ...real, gh: never("gh"), ghJson: never("ghJson"), canWrite: never("canWrite"), repoPermission: never("repoPermission"), readRateLimit: never("readRateLimit") };
});

import { addRepo, setRepoSettings } from "../src/auth/repos.js";
import { localRepoName } from "../src/auth/local-name.js";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { runNextStep } from "../src/next-step.js";
import { formatStoryFile, parseStoryFile, type FileStory } from "../src/stories/story-file.js";
import { createUser, findUserByEmail } from "../src/auth/users.js";
import { claudeBin } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

let ADMIN = "";
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: { ...process.env, ...ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const story = (n: number, title: string, state: FileStory["state"] = "go"): FileStory => ({
  number: n, title, state, kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "Do it.", comments: [],
  ...(state === "closed" ? { closedAt: "2026-01-02T00:00:00Z" } : {}),
});
const today = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const RECIPE = "builds:\n  - {name: a, run: echo x > a.txt, artifacts: [a.txt]}\n";

let base: string;
let dir: string;
let name: string;
let repoId: string;
let saved: Record<string, string | undefined>;

/** PATH with every folder that has a `gh` left out; the other executables of those folders are linked in. */
function pathWithoutGh(): string {
  const bin = join(base, "bin");
  mkdirSync(bin);
  const out: string[] = [bin];
  for (const d of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (!existsSync(join(d, "gh"))) {
      out.push(d);
      continue;
    }
    for (const f of readdirSync(d)) {
      if (f === "gh" || existsSync(join(bin, f))) continue;
      try {
        symlinkSync(realpathSync(join(d, f)), join(bin, f));
      } catch {
        // not linkable: skip
      }
    }
  }
  return out.join(delimiter);
}

beforeAll(() => {
  saved = { PATH: process.env.PATH, FACTORY_LOCK_DIR: process.env.FACTORY_LOCK_DIR, AREA_LOCK_POLL_MS: process.env.AREA_LOCK_POLL_MS };
  process.env.AREA_LOCK_POLL_MS = "100";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

/** An owner folder: main (checked out), and develop with two finished stories on top of it. Story 1 is closed, story 2 is open. */
async function setup(recipe = false): Promise<void> {
  calls.gh.length = 0;
  ADMIN = (findUserByEmail("admin@example.com") ?? (await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" }))).id;
  base = realpathSync(mkdtempSync(join(tmpdir(), "local-release-")));
  dir = join(base, "my-app");
  mkdirSync(join(dir, ".scf", "stories"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, ".scf", "stories", "1-build-me.md"), formatStoryFile(story(1, "Build me", "closed")));
  writeFileSync(join(dir, ".scf", "stories", "2-fix-colours.md"), formatStoryFile(story(2, "Fix colours")));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "develop");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Merge #1: Build me (feature/1-x)");
  writeFileSync(join(dir, "b.txt"), "two\n");
  if (recipe) {
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "release-build.yaml"), RECIPE);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Merge #2: Fix colours (feature/2-y)");
  git(dir, "checkout", "-q", "main");
  const rec = addRepo(ADMIN, { url: dir, method: "local" }, { ownerOk: () => true });
  repoId = rec.id;
  name = localRepoName({ id: rec.id, url: rec.url });
  process.env.FACTORY_LOCK_DIR = join(base, "locks");
  Object.assign(process.env, ENV);
  process.env.PATH = pathWithoutGh();
}
afterEach(() => {
  process.env.PATH = saved.PATH;
  spawnSync("chmod", ["-R", "u+w", base]);
  rmSync(base, { recursive: true, force: true });
});

const config = () => ConfigSchema.parse({ protected_branches: ["main", "develop"], concurrency: 3 });
const runsDir = () => join(base, "runs");
const start = (test_cmd = "true") =>
  runFlow(loadFlow("release-daily", base).flow, { task: "", repo: base, runsDir: runsDir(), claudeBin, config: config(), owner: ADMIN, vars: { github_repo: name, test_cmd } });
const decide = (runId: string, approved: boolean, note?: string) =>
  resumeRun({ runId, runsDir: runsDir(), claudeBin, config: config(), decision: { approved, by: "t", ...(note ? { note } : {}) } });
const again = (runId: string) => resumeRun({ runId, runsDir: runsDir(), claudeBin, config: config() });
const storyOf = (n: number): FileStory => {
  const f = readdirSync(join(dir, ".scf", "stories")).find((x) => x.startsWith(`${n}-`))!;
  const r = parseStoryFile(readFileSync(join(dir, ".scf", "stories", f), "utf8"), f);
  if (!r.ok) throw new Error(r.reason);
  return r.story;
};
const comments = (n: number): string[] => storyOf(n).comments.map((c) => c.body);
const files = (d: string, rel = ""): string[] =>
  readdirSync(join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(d, join(rel, e.name)) : [join(rel, e.name)]));

describe("release-daily on a local project", { timeout: 240_000 }, () => {
  it("has no gh on PATH in this test", async () => {
    await setup();
    expect((spawnSync("gh", ["--version"]).error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });

  it("waits for the OK, then merges the tested develop into main, tags it, closes the stories, keeps the files and pushes", async () => {
    await setup(true);
    const remote = join(base, "remote.git");
    git(base, "init", "-q", "--bare", remote);
    git(dir, "remote", "add", "origin", remote);
    setRepoSettings(repoId, { pushRemote: true });
    const mainBefore = git(dir, "rev-parse", "main");
    const developTip = git(dir, "rev-parse", "develop");

    const s = await start();
    expect(s.status, s.reason).toBe("waiting");
    expect(s.waiting?.stepId).toBe("make_final");
    expect(s.waiting?.message).toMatch(/^Make this version final\?/);
    expect(s.waiting?.message).toContain("- #1 Build me");
    expect(s.waiting?.message).toContain("- #2 Fix colours");
    expect(runNextStep(s)).toMatchObject({ kind: "approval", final: true, title: "Make this version final", who: "You" });
    expect(git(dir, "rev-parse", "main")).toBe(mainBefore);

    const r = await decide(s.runId, true);
    expect(r.status, r.reason).toBe("succeeded");
    const tag = `release-${today()}`;
    expect(git(dir, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
    expect(git(dir, "rev-parse", "main^2")).toBe(developTip);
    expect(git(dir, "rev-parse", `${tag}^{commit}`)).toBe(git(dir, "rev-parse", "main"));
    expect(git(dir, "cat-file", "-t", tag)).toBe("tag");
    for (const n of [1, 2]) {
      expect(storyOf(n).state).toBe("closed");
      expect(comments(n).filter((c) => c.includes(`\`${tag}\``))).toHaveLength(1);
    }
    expect(storyOf(1).closedAt).toBe("2026-01-02T00:00:00Z");
    expect(git(dir, "for-each-ref", "refs/scf")).toBe("");
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(git(dir, "rev-parse", "develop")).toBe(developTip);
    expect(calls.gh).toEqual([]);
    // the files of the recipe, kept under the data folder
    const folder = join(process.env.FACTORY_HOME!, "releases", name.slice(6), tag);
    expect(existsSync(join(folder, "SHA256SUMS"))).toBe(true);
    expect(files(folder).some((f) => f.endsWith("a.txt"))).toBe(true);
    expect(readFileSync(join(r.runDir, "outputs.json"), "utf8")).toContain(tag);
    expect(r.history.find((h) => h.id === "final_report")?.output).toContain(`Final version ${tag}`);
    // "Also push to the remote": main and the tag
    expect(git(remote, "rev-parse", "main")).toBe(git(dir, "rev-parse", "main"));
    expect(git(remote, "rev-parse", `${tag}^{commit}`)).toBe(git(dir, "rev-parse", "main"));
  });

  it("without a recipe it says there are no release files, and a tag of the same day gets a number", async () => {
    await setup();
    const tag = `release-${today()}`;
    git(dir, "tag", tag, "main");
    const s = await start();
    const r = await decide(s.runId, true);
    expect(r.status, r.reason).toBe("succeeded");
    expect(git(dir, "rev-parse", `${tag}`)).toBe(git(dir, "rev-parse", "main~0^1"));
    expect(git(dir, "rev-parse", `${tag}-2^{commit}`)).toBe(git(dir, "rev-parse", "main"));
    expect(r.history.find((h) => h.id === "final_files")?.output).toContain("NO_FILES");
    expect(existsSync(join(process.env.FACTORY_HOME!, "releases", name.slice(6)))).toBe(false);
  });

  it("Not yet leaves main, develop and the tags alone, and puts the reason on the stories", async () => {
    await setup();
    const before = [git(dir, "rev-parse", "main"), git(dir, "rev-parse", "develop")];
    const s = await start();
    const r = await decide(s.runId, false, "Wait for the logo");
    expect(r.status, r.reason).toBe("succeeded");
    expect([git(dir, "rev-parse", "main"), git(dir, "rev-parse", "develop")]).toEqual(before);
    expect(git(dir, "tag")).toBe("");
    for (const n of [1, 2]) expect(comments(n).some((c) => c.includes("Wait for the logo"))).toBe(true);
    expect(storyOf(2).state).not.toBe("closed");
    expect(r.history.some((h) => h.id === "final_merge")).toBe(false);
    expect(calls.gh).toEqual([]);
  });

  it("stops without a question when the checks are red", async () => {
    await setup();
    const s = await start("false");
    expect(s.status).toBe("failed");
    expect(s.history.at(-1)).toMatchObject({ id: "final_ask", ok: false });
    expect(s.history.at(-1)?.output).toContain("did not pass");
    expect(s.history.some((h) => h.id === "make_final")).toBe(false);
  });

  it("pauses on a dirty main in the owner's folder, and a resume finishes when it is clean", async () => {
    await setup();
    writeFileSync(join(dir, "README.md"), "my own change\n");
    const mainBefore = git(dir, "rev-parse", "main");
    const s = await start();
    const failed = await decide(s.runId, true);
    expect(failed.status).toBe("failed");
    expect(failed.history.at(-1)).toMatchObject({ id: "final_merge", ok: false });
    expect(failed.history.at(-1)?.output).toContain("Commit or stash");
    expect(git(dir, "rev-parse", "main")).toBe(mainBefore);
    expect(git(dir, "tag")).toBe("");
    git(dir, "checkout", "--", "README.md");
    const r = await again(s.runId);
    expect(r.status, r.reason).toBe("succeeded");
    expect(git(dir, "rev-parse", "main^2")).toBe(git(dir, "rev-parse", "develop"));
    expect(git(dir, "tag")).toBe(`release-${today()}`);
  });

  it("approves with every guard off: no protected branch, no secret scan, no observing policy", async () => {
    await setup();
    const bare = ConfigSchema.parse({ protected_branches: [], secret_scan: false, concurrency: 3 });
    const s = await runFlow(loadFlow("release-daily", base).flow, { task: "", repo: base, runsDir: runsDir(), claudeBin, config: bare, owner: ADMIN, vars: { github_repo: name, test_cmd: "true" } });
    expect(s.status, s.reason).toBe("waiting");
    const r = await resumeRun({ runId: s.runId, runsDir: runsDir(), claudeBin, config: bare, decision: { approved: true, by: "t" } });
    expect(r.status, r.reason).toBe("succeeded");
    expect(git(dir, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
    expect(git(dir, "rev-parse", `release-${today()}^{commit}`)).toBe(git(dir, "rev-parse", "main"));
    expect(calls.gh).toEqual([]);
  });

  it("goes on after a stop once main moved: the tag, the stories and no second merge", async () => {
    await setup();
    const s = await start();
    // the run stopped right after main moved: the same merge is in the owner's folder, the tag is not
    const sha = readFileSync(join(s.runDir, "final-sha"), "utf8").trim();
    git(dir, "merge", "-q", "--no-ff", "-m", "merged before the stop", sha);
    const merged = git(dir, "rev-parse", "main");
    // and the stories cannot be written now: the step fails and a resume does the rest
    const storiesDir = join(dir, ".scf", "stories");
    chmodSync(storiesDir, 0o555);
    const failed = await decide(s.runId, true);
    expect(failed.status).toBe("failed");
    expect(failed.history.at(-1)).toMatchObject({ id: "final_close", ok: false });
    expect(git(dir, "rev-parse", "main")).toBe(merged);
    const tag = `release-${today()}`;
    expect(git(dir, "rev-parse", `${tag}^{commit}`)).toBe(merged);
    chmodSync(storiesDir, 0o755);
    const r = await again(s.runId);
    expect(r.status, r.reason).toBe("succeeded");
    expect(git(dir, "rev-parse", "main")).toBe(merged);
    expect(git(dir, "rev-list", "--merges", "--count", "main")).toBe("1");
    for (const n of [1, 2]) {
      expect(storyOf(n).state).toBe("closed");
      expect(comments(n).filter((c) => c.includes(`\`${tag}\``))).toHaveLength(1);
    }
  });
});
