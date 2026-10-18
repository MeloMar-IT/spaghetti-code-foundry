import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { TOOLCHAIN_VARS } from "../src/release/host.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// The flow release-build end to end: a bare git repository as the remote, three recipes of different kinds.
const MARKERS = { JAVA_HOME: "m-java", GH_TOKEN: "m-gh", GITHUB_TOKEN: "m-github", GH_ENTERPRISE_TOKEN: "m-ent", MY_BOT_TOKEN: "m-bot", FACTORY_VAR_SECRETISH: "m-factory" };
const DATE = "2026-10-18T20:30:00Z";
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

  async function go(ref = "main", signal?: AbortSignal, log: string[] = []) {
    const s = await runFlow(loadFlow("release-build", gh.tmp).flow, {
      task: "", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, config, vars: { github_repo: "acme/app", ref }, signal,
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
    expect(r.files).toEqual(["SHA256SUMS", "cli/build-env.txt", "cli/mycli-202610182030.tgz"]);
    expect(r.text("SHA256SUMS")).toMatch(/^[0-9a-f]{64} {2}cli\/build-env\.txt\n[0-9a-f]{64} {2}cli\/mycli-202610182030\.tgz\n$/);
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
    expect(gh.ghLog()).toBe("");
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
    expect(r.files).toEqual(["SHA256SUMS", "assemble-env.txt", "site.html.gz"]);
    for (const v of Object.values(MARKERS)) expect(r.text("assemble-env.txt")).not.toContain(v);
    expect(worktrees(r.s)).toHaveLength(1);
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
    expect(r.files).toEqual(["SHA256SUMS", "app-macos-arm64"]);
    expect(r.text("app-macos-arm64")).toBe("mac\n");
  });

  it("fails at once when the repository has no recipe", async () => {
    const r = await go();
    expect(r.s.status).toBe("failed");
    expect(r.log).toContain("this repository has no release-build recipe");
    expect(r.s.history.map((h) => h.id)).toEqual(["clone", "resolve"]);
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
    expect(r.files).toEqual(["SHA256SUMS", "one/bin/app", "two/bin/app"]);
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
