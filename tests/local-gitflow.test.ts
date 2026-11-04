import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A story of a local project goes through issue-gitflow with no gh at all: the run clones the owner's folder, keeps the feature
// branch in its own workspace and merges it into the owner's develop. Every helper that would reach `gh` is a spy that fails.
const calls = vi.hoisted(() => ({ gh: [] as string[] }));
vi.mock("../src/github.js", async (orig) => {
  const real = await orig<typeof import("../src/github.js")>();
  const never = (name: string) => vi.fn(async () => { calls.gh.push(name); throw new Error(`${name} must not be called`); });
  return { ...real, gh: never("gh"), ghJson: never("ghJson"), canWrite: never("canWrite"), repoPermission: never("repoPermission"), readRateLimit: never("readRateLimit") };
});

import { addRepo, setRepoSettings } from "../src/auth/repos.js";
import { localRepoName } from "../src/auth/local-name.js";
import { ConfigSchema, type WatcherConfig } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { WatcherManager } from "../src/queue/watchers.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { formatStoryFile, parseStoryFile, type FileStory } from "../src/stories/story-file.js";
import { createUser, findUserByEmail } from "../src/auth/users.js";
import { claudeBin } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

let ADMIN = "";
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: { ...process.env, ...ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const story = (n: number, title: string): FileStory => ({
  number: n, title, state: "go", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "Do it.", comments: [],
});
const TEST_CMD = "! grep -q BUG feature.txt 2>/dev/null";

let base: string;
let dir: string;
let name: string;
let repoId: string;
let saved: Record<string, string | undefined>;

/** PATH with every folder that has a `gh` left out; the other executables of those folders are linked in, so node, git and sed still work. */
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
  saved = { PATH: process.env.PATH, FACTORY_CODEX_BIN: process.env.FACTORY_CODEX_BIN, AREA_LOCK_POLL_MS: process.env.AREA_LOCK_POLL_MS, FACTORY_LOCK_DIR: process.env.FACTORY_LOCK_DIR };
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

beforeEach(async () => {
  calls.gh.length = 0;
  ADMIN = (findUserByEmail("admin@example.com") ?? (await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" }))).id;
  base = realpathSync(mkdtempSync(join(tmpdir(), "local-gitflow-")));
  dir = join(base, "my-app");
  mkdirSync(join(dir, ".scf", "stories"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, ".scf", "stories", "1-build-me.md"), formatStoryFile(story(1, "Build me")));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const rec = addRepo(ADMIN, { url: dir, method: "local" }, { ownerOk: () => true });
  repoId = rec.id;
  name = localRepoName({ id: rec.id, url: rec.url });
  process.env.FACTORY_LOCK_DIR = join(base, "locks");
  Object.assign(process.env, ENV);
  process.env.PATH = pathWithoutGh();
});
afterEach(async () => {
  process.env.PATH = saved.PATH;
  // a run keeps the sources of its context read-only
  spawnSync("chmod", ["-R", "u+w", base]);
  rmSync(base, { recursive: true, force: true });
});

const config = () => ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3 });
const run = () =>
  runFlow(loadFlow("issue-gitflow", base).flow, {
    task: "", repo: base, runsDir: join(base, "runs"), claudeBin, config: config(), owner: ADMIN,
    vars: { github_repo: name, issue: "1", test_cmd: TEST_CMD, docs_required: "", union_merge_files: "" },
  });
async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 120_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const storyFile = () => {
  const f = readdirSync(join(dir, ".scf", "stories")).find((n) => n.startsWith("1-"))!;
  const r = parseStoryFile(readFileSync(join(dir, ".scf", "stories", f), "utf8"), f);
  if (!r.ok) throw new Error(r.reason);
  return r.story;
};

describe("issue-gitflow on a local project", { timeout: 240_000 }, () => {
  it("has no gh on PATH in this test", () => {
    expect((spawnSync("gh", ["--version"]).error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });

  it("builds a go story and merges it into the owner's develop, and also pushes it", async () => {
    const remote = join(base, "remote.git");
    git(base, "init", "-q", "--bare", remote);
    git(dir, "remote", "add", "origin", remote);
    setRepoSettings(repoId, { pushRemote: true });
    const mainBefore = git(dir, "rev-parse", "main");
    const r = await run();
    expect(r.status, r.reason).toBe("succeeded");
    expect(git(dir, "log", "-1", "--format=%s", "develop")).toMatch(/^Merge #1:/);
    expect(git(dir, "show", "develop:feature.txt")).toMatch(/^implemented #/);
    expect(git(dir, "branch", "--list", "feature/*")).toBe("");
    expect(git(dir, "for-each-ref", "refs/scf")).toBe("");
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(existsSync(join(dir, "feature.txt"))).toBe(false);
    expect(git(dir, "rev-parse", "main")).toBe(mainBefore);
    expect(git(remote, "rev-parse", "develop")).toBe(git(dir, "rev-parse", "develop"));
    expect(storyFile().state).toBe("closed");
    const report = storyFile().comments.map((c) => c.body).join("\n");
    expect(report).toContain("merged it into `develop` in your folder");
    expect(report).toContain("also pushed");
    expect(report).not.toContain("github.com");
    expect(report).toContain("Merge `develop` into `main`");
    expect(calls.gh).toEqual([]);
    expect(loadFlow("issue-gitflow", base).flow.steps.find((s) => s.id === "review_1")).toMatchObject({ prompt: expect.stringContaining("...HEAD") });
  });

  it("pauses on uncommitted work in the checked-out develop, and the watcher resumes the run when the tree is clean", async () => {
    git(dir, "branch", "develop");
    git(dir, "checkout", "-q", "develop");
    writeFileSync(join(dir, "README.md"), "my own change\n");
    // "Also push" is on, and the remote refuses every push: the merge must stay, with a warning in the report
    const remote = join(base, "remote.git");
    git(base, "init", "-q", "--bare", remote);
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n", { mode: 0o755 });
    git(dir, "remote", "add", "origin", remote);
    setRepoSettings(repoId, { pushRemote: true });
    const developBefore = git(dir, "rev-parse", "develop");

    const cfg = ConfigSchema.parse({
      protected_branches: ["main"], concurrency: 3,
      watchers: [{ id: "local-w", github_repo: "acme/app", label: "claude-factory", flow: "issue-gitflow", every: "1h", vars: { test_cmd: TEST_CMD, docs_required: "", union_merge_files: "" } }],
    });
    cfg.watchers[0] = { ...cfg.watchers[0]!, github_repo: name, repoId, ownerId: ADMIN } as WatcherConfig;
    const scheduler = new Scheduler({ runsDir: join(base, "runs"), config: () => cfg, claudeBin });
    const manager = new WatcherManager({ scheduler, runsDir: join(base, "runs"), repo: dir, config: () => cfg, log: () => {}, ghIdentity: () => { throw new Error("no GitHub sign-in"); } });
    try {
      manager.sync();
      const latest = () => scheduler.list().find((r) => r.flow === "issue-gitflow");
      await until(() => latest()?.status === "stopped" || latest()?.status === "failed", "the pause");
      const paused = latest()!;
      expect(paused.reason).toMatch(/stopped at step "wait_local_tree"/);
      const waited = paused.history.find((h) => h.id === "push_develop")!.output ?? "";
      expect(waited).toMatch(/^PAUSED: /m);
      expect(git(dir, "rev-parse", "develop")).toBe(developBefore);
      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("my own change\n");
      expect(git(dir, "for-each-ref", "refs/scf")).toBe("");

      git(dir, "checkout", "--", "README.md");
      // the next check of the watcher resumes the run (no resumeRun call here)
      await manager.runNow("local-w");
      await until(() => latest()?.status === "succeeded" || latest()?.status === "failed", "the resumed run");
      const done = latest()!;
      expect(done.runId).toBe(paused.runId);
      expect(done.status, done.reason).toBe("succeeded");
      expect(git(dir, "branch", "--show-current")).toBe("develop");
      expect(readFileSync(join(dir, "feature.txt"), "utf8")).toMatch(/^implemented #/);
      expect(git(dir, "log", "-1", "--format=%s", "develop")).toMatch(/^Merge #1:/);
      const report = storyFile().comments.map((c) => c.body).join("\n");
      expect(report).toContain("⚠");
      expect(report).toContain("could not be pushed to the remote");
      expect(report).not.toContain("github.com");
      expect(calls.gh).toEqual([]);
    } finally {
      manager.stopAll();
      scheduler.drain();
    }
  });

  it("clones a local planning folder with plain git", () => {
    const clone = join(base, "clone");
    mkdirSync(clone);
    const flow = loadFlow("issue-plan", base).flow;
    const step = flow.steps.find((s) => s.id === "clone" || s.id === "pull_ticket");
    expect(step).toBeDefined();
    const text = JSON.stringify(flow);
    expect(text).toContain('git clone -q -- \\"$FACTORY_LOCAL_REPO_DIR\\" .');
    const r = spawnSync("sh", ["-c", 'git clone -q -- "$FACTORY_LOCAL_REPO_DIR" . && git log --oneline -1'], { cwd: clone, encoding: "utf8", env: { ...process.env, FACTORY_LOCAL_REPO_DIR: dir } });
    expect(r.status).toBe(0);
    expect(existsSync(join(clone, "README.md"))).toBe(true);
  });
});
