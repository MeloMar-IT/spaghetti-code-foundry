import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath, setRepoSettings } from "../src/auth/repos.js";
import { ConfigSchema, RepoWatcherSchema, WatcherSchema } from "../src/config.js";
import { loadFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import {
  checkReleaseBuild, mainBranchOf, releaseBuildLock, releaseCheckEvery, type ReleaseCheck, type ReleaseJobs,
} from "../src/queue/release-trigger.js";
import { claimCommit, hasCommit, markCommit, readReleaseState, releaseBuildsDir } from "../src/release/build-claims.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const ANN = "11111111-1111-4111-8111-111111111111";
const STORED = "builds:\n  - {name: stored, run: make, artifacts: [out]}\n";

describe("release trigger", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let alive: boolean;
  let busyId: string | undefined;
  let queued: string[];
  let failQueue: boolean;
  let n: number;

  beforeEach(() => {
    gh = fakeGithub();
    rmSync(releaseBuildsDir(), { recursive: true, force: true });
    rmSync(reposPath(), { force: true });
    delete process.env.FAKE_GH_MAIN_SHA;
    delete process.env.FAKE_GH_RECIPE;
    delete process.env.FAKE_GH_FAIL;
    alive = true; busyId = undefined; queued = []; failQueue = false; failAfterAccept = false; accepted.clear(); n = 0;
  });
  afterEach(() => {
    delete process.env.FAKE_GH_MAIN_SHA;
    delete process.env.FAKE_GH_RECIPE;
    delete process.env.FAKE_GH_FAIL;
    rmSync(reposPath(), { force: true });
    gh.restore();
  });

  let failAfterAccept = false;
  const accepted = new Set<string>();
  const jobs: ReleaseJobs = {
    busy: () => busyId,
    queue: (_lock, submission) => {
      if (failQueue) throw new Error("queue is down");
      const id = `r${++n}`;
      queued.push(id);
      accepted.add(submission);
      if (failAfterAccept) throw new Error("queue file cannot be written");
      return id;
    },
    accepted: (submission) => accepted.has(submission),
  };
  const check = (over: Partial<ReleaseCheck> = {}) =>
    checkReleaseBuild({ repo: "acme/app", branch: "main", jobs, alive: () => { if (!alive) throw new Error("this check was given up"); }, ...over });
  const at = async (sha: string, over: Partial<ReleaseCheck> = {}) => {
    process.env.FAKE_GH_MAIN_SHA = sha;
    return check(over);
  };
  const calls = (re: RegExp) => gh.ghLog().split("\n").filter((l) => re.test(l)).length;
  const contents = () => calls(/contents\/\.factory/);
  const state = () => readReleaseState("acme/app", "main");

  it("the first check only remembers the commit", async () => {
    process.env.FAKE_GH_RECIPE = "1";
    expect((await at(A)).kind).toBe("first");
    expect(queued).toEqual([]);
    expect(contents()).toBe(0);
    expect(state()).toMatchObject({ head: A });
    expect(hasCommit("acme/app", "main", A)).toBe(true);
    expect((await at(A)).kind).toBe("same");
  });

  it("a new commit with a recipe queues one build; while it is busy nothing is asked", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    const r = await at(B);
    expect(r).toMatchObject({ kind: "queued", runId: "r1", head: B });
    expect(state()?.pending).toMatchObject({ head: B, runId: "r1" });
    busyId = "r1";
    const before = gh.ghLog();
    expect((await at(C)).kind).toBe("busy");
    expect(gh.ghLog()).toBe(before);
    expect(queued).toEqual(["r1"]);
  });

  it("a commit without a recipe is built never, and the contents are asked once", async () => {
    await at(A);
    expect((await at(B)).kind).toBe("no_recipe");
    expect((await at(B)).kind).toBe("same");
    expect(contents()).toBe(1);
    expect(queued).toEqual([]);
  });

  it("a stored recipe is enough and needs no contents call", async () => {
    const rec = addRepo(ANN, "acme/app", { ownerOk: () => true });
    setRepoSettings(rec.id, { releaseRecipe: STORED });
    await at(A);
    expect((await at(B)).kind).toBe("queued");
    expect(contents()).toBe(0);
  });

  it("B queued, C without a recipe, D with one: the pending build is not lost and only one job is queued at a time", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    await at(B);
    busyId = "r1";
    expect((await at(C)).kind).toBe("busy");
    busyId = undefined; // r1 ran and claimed C, the newest commit when it started
    markCommit("acme/app", "main", C, "r1");
    expect((await at(D)).kind).toBe("queued");
    expect(queued).toEqual(["r1", "r2"]);
    expect(hasCommit("acme/app", "main", B)).toBe(true); // settled
  });

  it("a build that took the newest commit means that commit is not queued again", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    await at(B);
    markCommit("acme/app", "main", C, "r1"); // main moved to C before r1 started; r1 claimed it
    expect((await at(C)).kind).toBe("same");
    expect(queued).toEqual(["r1"]);
  });

  it("a commit is not built again when main goes back to it, also far later and after a restart", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    await at(B);
    markCommit("acme/app", "main", B, "r1");
    await at(C);
    expect((await at(B)).kind).toBe("same");
    expect(queued).toEqual(["r1", "r2"]);
    // the list is kept for good: more than 500 later commits do not push the first out
    for (let i = 0; i < 520; i++) markCommit("acme/app", "main", i.toString(16).padStart(40, "0"));
    expect((await at(A)).kind).toBe("same");
    expect(hasCommit("acme/app", "main", B)).toBe(true);
    expect(queued).toHaveLength(2);
  });

  it("a claim is for one run: another run (or a commit seen before) is refused", () => {
    expect(claimCommit("acme/app", "main", B, "r1")).toBe(true);
    expect(claimCommit("acme/app", "main", B, "r1")).toBe(true); // a resume
    expect(claimCommit("Acme/App", "main", B, "r2")).toBe(false);
    markCommit("acme/app", "main", C);
    expect(claimCommit("acme/app", "main", C, "r1")).toBe(false);
    expect(() => claimCommit("acme/app", "main", "../x", "r1")).toThrow();
  });

  describe("with a real scheduler and a queue file", () => {
    let dir: string;
    let queueFile: string;
    const config = ConfigSchema.parse({ protected_branches: [], concurrency: 2 });
    const make = () => {
      const s = new Scheduler({ runsDir: join(dir, "runs"), config: () => config, claudeBin, queueFile });
      s.drain();
      return s;
    };
    const jobsOf = (s: Scheduler, lock: string): ReleaseJobs => ({
      busy: (l) => [...s.queue().pending, ...s.queue().active].find((j) => j.lockKey === l)?.runId,
      queue: (l, submission) =>
        s.submit(
          { kind: "run", flow: loadFlow("release-build", gh.tmp).flow, repo: gh.tmp, task: "t", vars: { github_repo: "acme/app", ref: "main", release_build_watcher: "w", release_build_submission: submission } },
          { lockKey: l, source: "watcher w release-build" },
        ),
      accepted: (submission) => s.list(1000).some((r) => r.vars?.release_build_submission === submission),
    });
    const lock = releaseBuildLock("acme/app", "main");
    beforeEach(() => {
      dir = join(gh.tmp, "sched");
      mkdirSync(dir, { recursive: true });
      queueFile = join(dir, "queue.json");
    });

    it("after a restart the queued job is found by its lock key", async () => {
      let s = make();
      await at(A, { jobs: jobsOf(s, lock) });
      process.env.FAKE_GH_RECIPE = "1";
      const r = await at(B, { jobs: jobsOf(s, lock) });
      s = make();
      const again = await at(C, { jobs: jobsOf(s, lock) });
      expect(again).toMatchObject({ kind: "busy", runId: r.runId });
      expect(s.queue().pending).toHaveLength(1);
    });

    it("a queue file that cannot be written after the job was accepted: the next check adopts the job, no second one", async () => {
      const s = make();
      await at(A, { jobs: jobsOf(s, lock) });
      process.env.FAKE_GH_RECIPE = "1";
      mkdirSync(`${queueFile}.tmp`); // persist() fails after the job is in the queue
      await expect(at(B, { jobs: jobsOf(s, lock) })).rejects.toThrow();
      expect(state()?.pending?.runId).toBeUndefined();
      expect(s.queue().pending).toHaveLength(1);
      rmSync(`${queueFile}.tmp`, { recursive: true });
      const r = await at(C, { jobs: jobsOf(s, lock) });
      expect(r.kind).toBe("busy");
      expect(state()?.pending?.runId).toBe(s.queue().pending[0]!.runId);
      expect(s.queue().pending).toHaveLength(1);
    });
  });

  it("a queue that failed before the job was accepted: the commit is queued again at the next check", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    failQueue = true;
    await expect(at(B)).rejects.toThrow("queue is down");
    expect(state()?.pending?.submission).toBeTruthy();
    failQueue = false;
    const r = await at(B);
    expect(r).toMatchObject({ kind: "queued", runId: "r1" });
    expect(r.notes.join(" ")).toMatch(/was not queued; trying again/);
    expect(queued).toEqual(["r1"]);
  });

  it("a job that was accepted before the queue failed, and finished, is not queued again", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    failAfterAccept = true;
    await expect(at(B)).rejects.toThrow("cannot be written");
    failAfterAccept = false;
    markCommit("acme/app", "main", C, "r1"); // the job started, took C and is gone from the queue
    expect((await at(C)).kind).toBe("same");
    expect(hasCommit("acme/app", "main", B)).toBe(true); // settled
    expect((await at(B)).kind).toBe("same");
    expect(queued).toEqual(["r1"]);
  });

  it("two checks at once: the second reads main itself afterwards and finds the job", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    process.env.FAKE_GH_MAIN_SHA = B;
    const release = gh.hold("git/ref");
    const first = check();
    const second = (async () => {
      await Promise.resolve();
      process.env.FAKE_GH_MAIN_SHA = C;
      return check({ jobs: { busy: () => (queued.length ? "r1" : undefined), queue: jobs.queue } });
    })();
    await new Promise((r) => setTimeout(r, 300)); // both are waiting; the second has not asked GitHub
    expect(calls(/git\/ref/)).toBeLessThanOrEqual(2);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.kind).toBe("queued");
    expect(two.kind).toBe("busy");
    expect(queued).toEqual(["r1"]);
    expect(state()?.head).toBe(B);
  });

  it("different branches do not wait for each other", async () => {
    const release = gh.hold("heads/main");
    process.env.FAKE_GH_MAIN_SHA = A;
    const slow = check();
    const quick = await check({ branch: "other" });
    expect(quick.kind).toBe("first");
    release();
    expect((await slow).kind).toBe("first");
  });

  it("a check that is given up writes nothing and queues nothing", async () => {
    await at(A);
    process.env.FAKE_GH_RECIPE = "1";
    const file = join(releaseBuildsDir(), readdirSync(releaseBuildsDir())[0]!, "state.json");
    const before = readFileSync(file, "utf8");
    const release = gh.hold("contents/.factory");
    process.env.FAKE_GH_MAIN_SHA = B;
    const p = check();
    const done = expect(p).rejects.toThrow("given up");
    await new Promise((r) => setTimeout(r, 300));
    alive = false;
    release();
    await done;
    expect(queued).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(hasCommit("acme/app", "main", B)).toBe(false);
  });

  it("Acme/App and acme/app are one repository", async () => {
    await at(A, { repo: "Acme/App" });
    process.env.FAKE_GH_RECIPE = "1";
    await at(B, { repo: "Acme/App" });
    busyId = "r1";
    expect((await at(C, { repo: "acme/app" })).kind).toBe("busy");
    expect(releaseBuildLock("Acme/App", "main")).toBe("release-build:github.com/acme/app#main");
  });

  it("a broken state file is the first check, never a surprise build", async () => {
    await at(A);
    const dirs = readdirSync(releaseBuildsDir());
    writeFileSync(join(releaseBuildsDir(), dirs[0]!, "state.json"), "{ nope");
    process.env.FAKE_GH_RECIPE = "1";
    expect((await at(B)).kind).toBe("first");
    expect(queued).toEqual([]);
  });

  it("names of the longest valid size give a short folder and a state that reads back", async () => {
    const repo = `${"o".repeat(39)}/${"n".repeat(100)}`;
    const branch = `${"x".repeat(99)}/${"y".repeat(100)}`;
    await at(A, { repo, branch });
    expect(readReleaseState(repo, branch)).toMatchObject({ head: A, branch });
    expect(readReleaseState(repo, "main")).toBeUndefined();
    expect(readdirSync(releaseBuildsDir())[0]!.length).toBe(64);
  });

  it("failures are plain sentences and change nothing; bad names stop before GitHub is asked", async () => {
    await at(A);
    process.env.FAKE_GH_FAIL = "api repos/acme/app/git/ref/heads/main";
    process.env.FAKE_GH_MAIN_SHA = B;
    await expect(check()).rejects.toThrow("cannot read the newest commit of main in acme/app");
    expect(state()?.head).toBe(A);
    delete process.env.FAKE_GH_FAIL;
    process.env.FAKE_GH_MAIN_SHA = "not-a-sha";
    await expect(check()).rejects.toThrow(/GitHub gave no commit id/);
    process.env.FAKE_GH_MAIN_SHA = B;
    process.env.FAKE_GH_FAIL = "api repos/acme/app/contents/.factory/release-build.yaml?ref=" + B;
    await expect(check()).rejects.toThrow(/cannot look for the release-build recipe/);
    expect(queued).toEqual([]);
    delete process.env.FAKE_GH_FAIL;
    const before = gh.ghLog();
    for (const o of [{ branch: "-x" }, { branch: "a b" }, { repo: "x" }]) await expect(check(o)).rejects.toThrow();
    expect(gh.ghLog()).toBe(before);
  });

  it("a branch name with reserved characters is encoded in the URL", async () => {
    await at(A, { branch: "rel#1%x/y" });
    expect(gh.ghLog()).toContain("git/ref/heads/rel%231%25x/y");
  });

  it("releaseCheckEvery and mainBranchOf", () => {
    const sched = WatcherSchema.parse({ id: "s", github_repo: "a/b", source: "schedule", task: "x", every: "7d", release_build: true });
    expect(releaseCheckEvery(sched, 7 * 86_400_000)).toBe(5 * 60_000);
    expect(releaseCheckEvery(sched, 60_000)).toBe(60_000);
    expect(releaseCheckEvery({ ...sched, release_build: false }, 7 * 86_400_000)).toBe(7 * 86_400_000);
    expect(releaseCheckEvery({ ...sched, source: "issues" }, 7 * 86_400_000)).toBe(7 * 86_400_000);
    expect(mainBranchOf(sched)).toBe("main");
    const rec = addRepo(ANN, "acme/app", { ownerOk: () => true });
    setRepoSettings(rec.id, { mainBranch: "trunk" });
    expect(mainBranchOf({ repoId: rec.id })).toBe("trunk");
  });

  it("only a schedule watcher can build release files", () => {
    expect(() => WatcherSchema.parse({ id: "i", github_repo: "a/b", release_build: true })).toThrow(/only a schedule watcher builds release files/);
    expect(() => RepoWatcherSchema.parse({ id: "i", release_build: true })).toThrow(/only a schedule watcher builds release files/);
    expect(WatcherSchema.parse({ id: "i", github_repo: "a/b" }).release_build).toBe(false);
  });

  describe("the watcher", () => {
    let scheduler: Scheduler;
    const config = ConfigSchema.parse({ protected_branches: [], concurrency: 2 });
    beforeEach(() => {
      scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
      scheduler.drain(); // jobs stay queued: only what the watcher queues is looked at
    });
    const watcher = (over: Record<string, unknown> = {}) =>
      new Watcher(WatcherSchema.parse({ id: "rel", github_repo: "acme/app", source: "schedule", every: "7d", task: "x", flow: "chore", release_build: true, ...over }), {
        scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => undefined,
      });
    const builds = () => scheduler.queue().pending.filter((p) => p.flow === "release-build");

    it("queues one release-build of the branch for a new commit", async () => {
      const w = watcher();
      process.env.FAKE_GH_MAIN_SHA = A;
      await w.tick();
      expect(builds()).toHaveLength(0);
      process.env.FAKE_GH_RECIPE = "1";
      process.env.FAKE_GH_MAIN_SHA = B;
      await w.tick();
      expect(w.status.lastError).toBeUndefined();
      expect(builds()).toHaveLength(1);
      const job = scheduler.queuedJob(builds()[0]!.runId)!;
      expect(job.job).toMatchObject({ kind: "run", vars: { github_repo: "acme/app", ref: "main", release_build_watcher: "rel" } });
      expect(job).toMatchObject({ source: "watcher rel release-build", lockKey: "release-build:github.com/acme/app#main" });
      process.env.FAKE_GH_MAIN_SHA = C;
      await w.tick();
      expect(builds()).toHaveLength(1); // it builds the branch, whatever main is when it starts
    });

    it("does not look at main with the option off", async () => {
      const w = watcher({ release_build: false });
      process.env.FAKE_GH_MAIN_SHA = A;
      await w.tick();
      expect(calls(/git\/ref/)).toBe(0);
      expect(builds()).toHaveLength(0);
    });

    it("a stopped watcher queues nothing", async () => {
      const w = watcher();
      process.env.FAKE_GH_MAIN_SHA = A;
      await w.tick();
      process.env.FAKE_GH_RECIPE = "1";
      process.env.FAKE_GH_MAIN_SHA = B;
      const release = gh.hold("contents/.factory");
      const t = w.tick();
      await new Promise((r) => setTimeout(r, 300));
      w.stop(true);
      release();
      await t;
      expect(builds()).toHaveLength(0);
      expect(w.status.lastError).toMatch(/given up|stopped/);
    });
  });
});
