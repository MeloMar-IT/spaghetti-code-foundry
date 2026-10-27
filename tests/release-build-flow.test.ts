import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath, setRepoSettings } from "../src/auth/repos.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { hasCommit, markCommit } from "../src/release/build-claims.js";
import { TOOLCHAIN_VARS } from "../src/release/host.js";
import { releaseMarker } from "../src/release/recipe.js";
import { validatorFileName, validatorVersion } from "../src/release/validator.js";
import { claudeBin, fakeGithub, fakeRelease } from "./helpers/fake-github.js";

// The flow release-build end to end: a bare git repository as the remote, three recipes of different kinds.
const MARKERS = { JAVA_HOME: "m-java", GH_TOKEN: "m-gh", GITHUB_TOKEN: "m-github", GH_ENTERPRISE_TOKEN: "m-ent", MY_BOT_TOKEN: "m-bot", FACTORY_VAR_SECRETISH: "m-factory" };
const DATE = "2026-10-18T20:30:00Z";
const V = validatorFileName(validatorVersion());
const VSUM = V + ".sha256";
const config = ConfigSchema.parse({ protected_branches: ["main"], bot: { gh_token_env: "JAVA_HOME" } });

describe("release-build flow", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let saved: NodeJS.ProcessEnv;
  let commits = 0;
  const homeConfig = () => join(process.env.FACTORY_HOME!, "config.yaml");

  beforeEach(() => {
    saved = { ...process.env };
    gh = fakeGithub();
    Object.assign(process.env, MARKERS, {
      FACTORY_LOCK_DIR: join(gh.tmp, "locks"),
      FACTORY_REPO_URL: gh.remote,
      FACTORY_VAR_TEST_SLOTS: "0",
      FACTORY_TEST_RELEASE_HOST: "linux-arm64",
    });
    writeFileSync(homeConfig(), "bot:\n  gh_token_env: JAVA_HOME\n");
  });
  afterEach(() => {
    rmSync(homeConfig(), { force: true });
    rmSync(reposPath(), { force: true });
    gh.restore();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  /** Commit `files` and the recipe on main of the remote (committer date fixed). Returns the commit. */
  function commit(recipe: string | undefined, files: Record<string, string> = {}, tag?: string): string {
    const dir = join(gh.tmp, `work${++commits}`);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: DATE, GIT_AUTHOR_DATE: DATE } }).trim();
    execFileSync("git", ["clone", "-q", gh.remote, dir]);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    if (recipe !== undefined) {
      mkdirSync(join(dir, ".factory"), { recursive: true });
      writeFileSync(join(dir, ".factory", "release-build.yaml"), recipe);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", `commit ${commits}`);
    if (tag) git("tag", tag);
    git("push", "-q", "origin", "HEAD:main", ...(tag ? [tag] : []));
    return git("rev-parse", "HEAD");
  }

  async function go(ref = "main", signal?: AbortSignal, log: string[] = [], extra: Record<string, string> = {}) {
    const s = await runFlow(loadFlow("release-build", gh.tmp).flow, {
      task: "", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, config, vars: { github_repo: "acme/app", ref, ...extra }, signal,
      log: (l) => void log.push(l),
    });
    const out = join(s.runDir, "release", "out");
    const outputs = s.history.map((h) => h.output ?? "");
    return { s, log: [...log, ...outputs].join("\n"), out, files: existsSync(out) ? readdirSync(out, { recursive: true }).map(String).filter((f) => statSync(join(out, f)).isFile()).sort() : [], text: (f: string) => readFileSync(join(out, f), "utf8") };
  }
  const worktrees = (s: { workdir?: string }) => execFileSync("git", ["worktree", "list"], { cwd: s.workdir, encoding: "utf8" }).trim().split("\n");

  it("builds a Node CLI package with a short environment and no tokens", async () => {
    commit(
      [
        "builds:",
        "  - name: cli",
        "    requires: [tar]",
        "    run: env > build-env.txt && tar -czf mycli-$FACTORY_RELEASE_VERSION.tgz package.json bin",
        "    artifacts: ['*.tgz', build-env.txt]",
      ].join("\n"),
      { "package.json": '{"name":"mycli"}\n', "bin/cli.js": "console.log(1)\n" },
    );
    const r = await go();
    expect(r.s.status, r.s.reason).toBe("succeeded");
    expect(r.log).toContain("VERSION: 202610182030");
    expect(r.log).toContain("TAG: v202610182030");
    // without assemble the collected files are used as they are: one folder per build
    expect(r.files).toEqual(["SHA256SUMS", "cli/build-env.txt", "cli/mycli-202610182030.tgz", V, VSUM]);
    expect(r.text("SHA256SUMS")).toMatch(/^[0-9a-f]{64} {2}cli\/build-env\.txt\n[0-9a-f]{64} {2}cli\/mycli-202610182030\.tgz\n[0-9a-f]{64} {2}scf-delivery-validate-[\d.]+\.mjs\n[0-9a-f]{64} {2}scf-delivery-validate-[\d.]+\.mjs\.sha256\n$/);
    const env = r.text("cli/build-env.txt");
    for (const v of Object.values(MARKERS)) expect(env).not.toContain(v);
    const allowed = new Set([
      "PATH", "HOME", "LANG", ...TOOLCHAIN_VARS, "FACTORY_RELEASE_VERSION", "FACTORY_RELEASE_TAG", "FACTORY_RELEASE_IN", "FACTORY_RELEASE_OUT", "FACTORY_RELEASE_SHA",
      "FACTORY_VAR_TEST_SLOTS", "FACTORY_TEST_SLOT_WAIT_SEC", "FACTORY_TEST_SLOT_POLL_MS", "FACTORY_TEST_NICE", "FACTORY_TEST_SLOT_STRICT", "FACTORY_IN_TEST_SLOT", "PWD", "SHLVL", "_", "OLDPWD",
      "__CF_USER_TEXT_ENCODING", // added by macOS to every process it starts
    ]);
    const names = env.split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => l.split("=")[0]!);
    expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    expect(names).toContain("FACTORY_RELEASE_SHA");
    // the only gh calls are the upload's (the clone uses git); the build steps never call gh
    const calls = gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((l) => l.startsWith("gh api "))).toBe(true);
    expect(worktrees(r.s)).toHaveLength(1);
  });

  it("builds a static site, skips a build for another machine and assembles", async () => {
    commit(
      [
        "builds:",
        "  - name: site",
        "    run: mkdir -p public/docs && echo hi > public/docs/index.html",
        "    artifacts: ['public/**/*.html']",
        "  - {name: windows-x64, on: [windows], arch: x64, run: exit 1, artifacts: [x]}",
        "assemble: |",
        '  gzip -c "$FACTORY_RELEASE_IN/site/public/docs/index.html" > "$FACTORY_RELEASE_OUT/site.html.gz"',
        '  env > "$FACTORY_RELEASE_OUT/assemble-env.txt"',
      ].join("\n"),
    );
    const r = await go();
    expect(r.s.status, r.s.reason).toBe("succeeded");
    expect(r.log).toContain("windows-x64: skipped, needs windows");
    expect(r.files).toEqual(["SHA256SUMS", "assemble-env.txt", V, VSUM, "site.html.gz"]);
    for (const v of Object.values(MARKERS)) expect(r.text("assemble-env.txt")).not.toContain(v);
    expect(worktrees(r.s)).toHaveLength(1);
  });

  it("fails when the build's own files already have the validator name", async () => {
    commit(["builds:", "  - {name: a, run: echo x > a.txt, artifacts: [a.txt]}", "assemble: |", `  echo mine > "$FACTORY_RELEASE_OUT/${V}"`].join("\n"));
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("validator: failed, the release files already have " + V);
    expect(r.text(V)).toBe("mine\n");
  });

  it("builds a binary per platform from a tag, skipping the other platform", async () => {
    const tagged = commit(
      [
        "builds:",
        "  - {name: macos-arm64, on: [macos], arch: arm64, run: 'mkdir -p bin && echo mac > bin/app', artifacts: [bin/app]}",
        "  - {name: linux-x64, on: [linux], arch: x64, run: 'mkdir -p bin && echo lin > bin/app', artifacts: [bin/app]}",
        "assemble: cp \"$FACTORY_RELEASE_IN/macos-arm64/bin/app\" \"$FACTORY_RELEASE_OUT/app-macos-arm64\"",
      ].join("\n"),
      {},
      "v1",
    );
    commit(undefined, { "later.txt": "x" });
    process.env.FACTORY_TEST_RELEASE_HOST = "macos-arm64";
    const r = await go("v1");
    expect(r.s.status, r.s.reason).toBe("succeeded");
    expect(r.log).toContain(`COMMIT: ${tagged}`);
    expect(r.log).toContain("linux-x64: skipped, needs linux");
    expect(r.files).toEqual(["SHA256SUMS", "app-macos-arm64", V, VSUM]);
    expect(r.text("app-macos-arm64")).toBe("mac\n");
  });

  describe("started by a watcher", () => {
    const RECIPE = "builds:\n  - {name: cli, run: 'echo one > a.tgz', artifacts: ['*.tgz']}\n";
    const auto = { release_build_watcher: "rel" };

    it("claims the commit it builds, and a second run of the same commit builds and uploads nothing", async () => {
      const sha = commit(RECIPE);
      const one = await go("main", undefined, [], auto);
      expect(one.s.status, one.s.reason).toBe("succeeded");
      expect(one.s.outputs?.release_url).toMatch(/^https:/);
      expect(hasCommit("acme/app", "main", sha)).toBe(true);
      const two = await go("main", undefined, [], auto);
      expect(two.s.status, two.s.reason).toBe("succeeded");
      expect(two.log).toContain("this commit was handled before");
      expect(two.s.outputs).toBeUndefined();
      expect(two.files).toEqual([]);
      expect(gh.releases()).toHaveLength(1);
    });

    it("does not build a commit that was seen before (main went back to it)", async () => {
      const sha = commit(RECIPE);
      markCommit("acme/app", "main", sha);
      const r = await go("main", undefined, [], auto);
      expect(r.s.status, r.s.reason).toBe("succeeded");
      expect(r.log).toContain("skipped");
      expect(gh.releases()).toHaveLength(0);
    });

    it("a run started by hand builds a seen commit", async () => {
      const sha = commit(RECIPE);
      markCommit("acme/app", "main", sha);
      const r = await go();
      expect(r.s.status, r.s.reason).toBe("succeeded");
      expect(gh.releases()).toHaveLength(1);
    });
  });

  it("fails at once when the repository has no recipe", async () => {
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("this repository has no release-build recipe");
    expect(r.log).toContain("is not a repository in the Foundry");
    expect(r.s.history.map((h) => h.id)).toEqual(["lock", "clone", "resolve"]);
  });

  describe("upload", () => {
    const RECIPE_KEEP2 = "keep: 2\nbuilds:\n  - {name: cli, run: 'echo one > a.tgz && echo twotwo > b.tgz', artifacts: ['*.tgz']}\n";
    const marker = releaseMarker({ tag: "v{version}" });
    const drafts = () => [
      fakeRelease(11, "v202501010101", { body: marker, created_at: "2025-01-01T00:00:00Z" }),
      fakeRelease(12, "v202501020101", { body: marker, created_at: "2025-01-02T00:00:00Z" }),
      fakeRelease(13, "v202501030101", { body: marker, created_at: "2025-01-03T00:00:00Z" }),
      fakeRelease(14, "v202501040101", { body: "by hand", created_at: "2025-01-04T00:00:00Z" }),
      fakeRelease(15, "v202501050101", { body: marker, draft: false, created_at: "2025-01-05T00:00:00Z" }),
      fakeRelease(16, "nightly", { body: marker, created_at: "2025-01-06T00:00:00Z" }),
    ];

    it("uploads to a new draft at the commit, prunes old drafts of this recipe only and records the url", async () => {
      const sha = commit(RECIPE_KEEP2);
      gh.setReleases(drafts());
      const r = await go();
      expect(r.s.status, r.s.reason).toBe("succeeded");
      const calls = gh.ghLog();
      expect(calls).toContain("gh api --paginate repos/acme/app/releases?per_page=100");
      expect(calls).toContain(`target_commitish=${sha}`);
      expect(calls).toContain("draft=true");
      const rels = gh.releases();
      const made = rels.find((x) => x.tag_name === "v202610182030")!;
      expect(made).toMatchObject({ draft: true, prerelease: true, target_commitish: sha });
      expect(made.assets.map((a) => [a.name, a.size])).toEqual([["SHA256SUMS", expect.any(Number)], ["cli-a.tgz", 4], ["cli-b.tgz", 7], [V, expect.any(Number)], [VSUM, expect.any(Number)]]);
      expect(made.assets[0]!.text).toMatch(/^[0-9a-f]{64} {2}cli-a\.tgz\n[0-9a-f]{64} {2}cli-b\.tgz\n[0-9a-f]{64} {2}scf-delivery-validate-[\d.]+\.mjs\n[0-9a-f]{64} {2}scf-delivery-validate-[\d.]+\.mjs\.sha256\n$/);
      // the uploaded validator is this install's script, and its .sha256 file matches it
      const hash = createHash("sha256").update(readFileSync("tools/delivery-validate/validate.mjs")).digest("hex");
      const asset = (n: string) => made.assets.find((a) => a.name === n)!;
      expect(createHash("sha256").update(asset(V).text!).digest("hex")).toBe(hash);
      expect(asset(VSUM).text).toBe(hash + "  " + V + "\n");
      // the two oldest marked drafts went; the newest marked one, the hand-made draft, the published release and "nightly" stayed
      expect(rels.map((x) => x.id).sort((a, b) => a - b)).toEqual([13, 14, 15, 16, made.id]);
      expect(r.s.outputs).toEqual({
        release_url: made.html_url,
        release_tag: "v202610182030",
        release_files: expect.stringMatching(/^SHA256SUMS \(\d+ B\); cli-a\.tgz \(4 B\); cli-b\.tgz \(7 B\); scf-delivery-validate-[\d.]+\.mjs \([\d.]+ [KM]?B\); scf-delivery-validate-[\d.]+\.mjs\.sha256 \(\d+ B\)$/),
      });
      expect(made.html_url).toMatch(/^https:\/\/github\.com\/acme\/app\/releases\/tag\/untagged-\d+$/);
      expect(r.log).toContain("UPLOADED: 5 files");
      expect(r.log).toContain("cli-a.tgz  4 B");
      expect(r.log).toContain(`URL: ${made.html_url}`);
      expect(r.log).toContain("PRUNED: v202501020101 (12), v202501010101 (11)");
      expect(JSON.parse(readFileSync(join(r.s.runDir, "run.json"), "utf8")).outputs.release_tag).toBe("v202610182030");
    });

    it("does not rely on the order of GitHub's list", async () => {
      commit(RECIPE_KEEP2);
      gh.setReleases(drafts());
      process.env.FAKE_GH_RELEASE_ORDER = "reverse-id";
      const r = await go();
      expect(r.s.status, r.s.reason).toBe("succeeded");
      expect(gh.releases().map((x) => x.id).filter((id) => id < 100).sort((a, b) => a - b)).toEqual([13, 14, 15, 16]);
    });

    it("fails when a published release has the tag, and changes nothing on GitHub", async () => {
      commit(RECIPE_KEEP2);
      gh.setReleases([...drafts(), fakeRelease(21, "v202610182030", { draft: false, body: marker })]);
      const before = readFileSync(gh.releasesFile, "utf8");
      const r = await go();
      expect(r.s.status).toBe("failed");
      expect(r.s.history.at(-1)!.id).toBe("upload");
      expect(r.log).toContain("already published");
      expect(readFileSync(gh.releasesFile, "utf8")).toBe(before);
      expect(gh.ghLog()).not.toMatch(/-X (POST|DELETE)/);
    });

    it("replaces the files of an existing draft with the tag", async () => {
      commit(RECIPE_KEEP2);
      gh.setReleases([fakeRelease(30, "v202610182030", { body: marker, assets: [{ id: 300, name: "cli-a.tgz", size: 1 }, { id: 301, name: "keep.txt", size: 2 }] })]);
      const r = await go();
      expect(r.s.status, r.s.reason).toBe("succeeded");
      const rels = gh.releases();
      expect(rels.map((x) => x.id)).toEqual([30]);
      // the old cli-a.tgz (id 300) was deleted by id and uploaded again with its new size
      expect(rels[0]!.assets.map((a) => [a.name, a.size])).toEqual([["keep.txt", 2], ["SHA256SUMS", expect.any(Number)], ["cli-a.tgz", 4], ["cli-b.tgz", 7], [V, expect.any(Number)], [VSUM, expect.any(Number)]]);
      expect(rels[0]!.assets.some((a) => a.id === 300)).toBe(false);
      expect(gh.ghLog()).toContain("gh api -X DELETE repos/acme/app/releases/assets/300");
    });
  });

  it("gives only the clone and the upload step the login, and takes the lock in every step that does work", () => {
    const { flow } = loadFlow("release-build", gh.tmp);
    expect(flow.steps.filter((s) => s.type === "shell" && s.repo_access).map((s) => s.id)).toEqual(["clone", "upload"]);
    for (const id of ["lock", "resolve", "build", "upload"]) {
      const step = flow.steps.find((s) => s.id === id)!;
      if (step.type !== "shell") throw new Error("not a shell step");
      expect(step.run, id).toContain('"$FACTORY_TOOLS/area-lock" acquire "$FACTORY_RUN_ID"');
      expect(step.run, id).toContain("@release-build");
      const wait = Number(/--wait-sec (\d+)/.exec(step.run)![1]);
      expect(wait, id).toBeLessThan(step.timeout_sec ?? flow.defaults?.timeout_sec ?? 3600);
    }
  });

  const store = (recipe: string) => {
    const rec = addRepo("11111111-1111-4111-8111-111111111111", "https://github.com/Acme/App", { ownerOk: () => true });
    setRepoSettings(rec.id, { releaseRecipe: recipe });
  };
  const STORED = "builds:\n  - {name: stored, on: [linux, macos, windows], run: echo s > s.txt, artifacts: [s.txt]}\n";
  const FILE = "builds:\n  - {name: filed, on: [linux, macos, windows], run: echo f > f.txt, artifacts: [f.txt]}\n";

  it("says so when the repository is in the Foundry but has no recipe at all", async () => {
    addRepo("11111111-1111-4111-8111-111111111111", "https://github.com/Acme/App", { ownerOk: () => true });
    commit(undefined);
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("none stored in the Foundry settings");
  });

  it("uses the recipe stored in the Foundry settings when the commit has no file", async () => {
    store(STORED);
    commit(undefined);
    const r = await go();
    expect(r.s.status, r.s.reason).toBe("succeeded");
    expect(r.log).toContain("recipe: stored in the Foundry settings");
    expect(r.files).toContain("stored/s.txt");
  });

  it("lets the file at the commit win over the stored recipe", async () => {
    store(STORED);
    commit(FILE);
    const r = await go();
    expect(r.s.status, r.s.reason).toBe("succeeded");
    expect(r.log).toContain("recipe: .factory/release-build.yaml");
    expect(r.files).toContain("filed/f.txt");
    expect(r.files).not.toContain("stored/s.txt");
  });

  it("fails when every build is for another machine", async () => {
    commit("builds:\n  - {name: w, on: [windows], run: x, artifacts: [x]}\n");
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("w: skipped, needs windows");
    expect(r.log).toContain("nothing to build on this machine");
  });

  it("fails a build whose required command is missing, before anything runs", async () => {
    commit("builds:\n  - {name: a, run: 'touch ran', artifacts: [ran]}\n  - {name: b, requires: [no-such-tool-xyz], run: x, artifacts: [x]}\n");
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toMatch(/b: failed, the command no-such-tool-xyz is not installed/);
    expect(r.log).not.toContain("a: building");
  });

  it("keeps equal file names of two builds apart when there is no assemble", async () => {
    commit("builds:\n  - {name: one, run: 'mkdir -p bin && echo 1 > bin/app', artifacts: [bin/app]}\n  - {name: two, run: 'mkdir -p bin && echo 2 > bin/app', artifacts: [bin/app]}\n");
    const r = await go();
    expect(r.s.status, r.s.reason).toBe("succeeded");
    expect(r.files).toEqual(["SHA256SUMS", "one/bin/app", V, VSUM, "two/bin/app"]);
    expect(r.text("SHA256SUMS")).toContain("  two/bin/app\n");
  });

  it("stops before any build when the settings cannot be read, so no secret name is missed", async () => {
    commit("builds:\n  - {name: a, run: 'touch ran', artifacts: [ran]}\n");
    writeFileSync(homeConfig(), "bot: [this is not a mapping\n");
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("the settings cannot be read");
    expect(r.log).not.toContain("a: building");
    expect(r.files).toEqual([]);
  });

  it("fails a build that matches no files", async () => {
    commit("builds:\n  - {name: a, run: 'true', artifacts: ['*.nope']}\n");
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("a: failed, no files match");
    expect(worktrees(r.s)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("cancelling stops a build that ignores TERM, with its children, and removes the worktree", async () => {
    const pidFile = join(gh.tmp, "build.pid");
    rmSync(pidFile, { force: true });
    commit(`builds:\n  - name: a\n    run: |\n      echo $$ > "${pidFile}"\n      trap '' TERM\n      sleep 60 &\n      wait\n    artifacts: [x]\n`);
    const stop = new AbortController();
    const running = go("main", stop.signal);
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    const r = await running;
    expect(r.s.status).toBe("cancelled");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(worktrees(r.s)).toHaveLength(1);
  });
});
