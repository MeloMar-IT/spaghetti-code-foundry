import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWN_KEY_VARS } from "../src/agents/targets.js";
import { collectArtifacts, copyTree, globToRegExp, planBuilds, runCommand, writeSha256Sums } from "../src/release/build.js";
import { buildEnv, deniedNames, findCommand, hostOf, killTree, matchBuild, TOOLCHAIN_VARS } from "../src/release/host.js";
import { parseRecipe } from "../src/release/recipe.js";

const roots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "scf-rb-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const put = (root: string, rel: string, text = "x") => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("host and matching", () => {
  it("reads the machine, with a test override", () => {
    expect(hostOf({ FACTORY_TEST_RELEASE_HOST: "windows-x64" })).toEqual({ platform: "windows", arch: "x64" });
    const real = hostOf({});
    expect(["macos", "linux", "windows"]).toContain(real.platform === "darwin" ? "macos" : real.platform);
    expect(real.arch).toBe(process.arch);
  });

  it("matches on and arch, and says what is needed", () => {
    const b = { on: ["windows" as const], arch: "x64" as const };
    expect(matchBuild(b, { platform: "windows", arch: "x64" })).toEqual({ ok: true });
    expect(matchBuild(b, { platform: "linux", arch: "x64" })).toEqual({ ok: false, why: "needs windows" });
    expect(matchBuild(b, { platform: "windows", arch: "arm64" })).toEqual({ ok: false, why: "needs x64" });
    expect(matchBuild({ on: ["linux", "macos"] }, { platform: "linux", arch: "arm64" })).toEqual({ ok: true });
  });

  it("plans: runs, skips and missing commands", () => {
    const recipe = parseRecipe(
      [
        "builds:",
        "  - {name: a, on: [linux], run: x, artifacts: [x]}",
        "  - {name: b, on: [windows], arch: x64, run: x, artifacts: [x]}",
        "  - {name: c, run: x, artifacts: [x], requires: [definitely-not-a-command-xyz, sh]}",
      ].join("\n"),
    );
    const p = planBuilds(recipe, { platform: "linux", arch: "arm64" }, process.env.PATH ?? "");
    expect(p.run.map((b) => b.name)).toEqual(["a", "c"]);
    expect(p.skipped).toEqual([{ name: "b", why: "needs windows" }]);
    expect(p.missing).toEqual([{ name: "c", commands: ["definitely-not-a-command-xyz"] }]);
    expect(planBuilds(recipe, { platform: "beos", arch: "x64" }, "").run).toEqual([]);
  });

  it("finds commands on PATH without a shell", () => {
    const d = tmp();
    put(d, "tool");
    expect(findCommand("tool", d, "linux")).toBe(false); // not executable
    chmodSync(join(d, "tool"), 0o755);
    expect(findCommand("tool", d, "linux")).toBe(true);
    expect(findCommand("tool", "", "linux")).toBe(false);
  });
});

describe("buildEnv", () => {
  const r = { version: "1", tag: "v1", sha: "abc", inDir: "/in", outDir: "/out" };
  const source = {
    PATH: "/bin", HOME: "/h", LANG: "C", JAVA_HOME: "/jdk", GOPATH: "/go",
    GH_TOKEN: "t1", GITHUB_TOKEN: "t2", GH_ENTERPRISE_TOKEN: "t3", GITHUB_ENTERPRISE_TOKEN: "t4", MY_BOT_TOKEN: "t5",
    FACTORY_VAR_X: "x", FACTORY_TASK: "task", SSH_AUTH_SOCK: "/s", HTTPS_PROXY: "http://u:p@h", HTTP_PROXY: "http://proxy:3128",
    FACTORY_VAR_TEST_SLOTS: "2", FACTORY_TEST_NICE: "abc", FACTORY_IN_TEST_SLOT: "1",
  };

  it("passes only the allowed names and sets the five release variables", () => {
    expect(buildEnv(source, r, deniedNames())).toEqual({
      PATH: "/bin", HOME: "/h", LANG: "C", JAVA_HOME: "/jdk", GOPATH: "/go", HTTP_PROXY: "http://proxy:3128", FACTORY_VAR_TEST_SLOTS: "2",
      FACTORY_RELEASE_VERSION: "1", FACTORY_RELEASE_TAG: "v1", FACTORY_RELEASE_IN: "/in", FACTORY_RELEASE_OUT: "/out", FACTORY_RELEASE_SHA: "abc",
    });
  });

  it("drops a configured token or key name even when it is an allowed name", () => {
    const denied = deniedNames({ bot: { gh_token_env: "JAVA_HOME" }, providers: { x: { api_key_env: "GOPATH" } } } as never);
    const env = buildEnv(source, r, denied);
    expect(env.JAVA_HOME).toBeUndefined();
    expect(env.GOPATH).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("names the built-in secrets without a config, and the toolchain list holds no secret-like name", () => {
    const d = deniedNames();
    for (const n of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", ...KNOWN_KEY_VARS]) expect(d.has(n)).toBe(true);
    for (const n of TOOLCHAIN_VARS) expect(n).not.toMatch(/TOKEN|SECRET|PASSW|CREDENTIAL|_KEY|AUTH/i);
  });
});

describe("killTree", () => {
  it("uses taskkill on Windows", () => {
    const calls: unknown[][] = [];
    killTree(42, "SIGTERM", "win32", ((...a: unknown[]) => void calls.push(a)) as never);
    expect(calls[0]!.slice(0, 2)).toEqual(["taskkill", ["/PID", "42", "/T", "/F"]]);
  });

  it.skipIf(process.platform === "win32")("kills a whole group, also one that ignores TERM", async () => {
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 30 & wait"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    const exited = new Promise((r) => child.on("close", r));
    killTree(pid, "SIGTERM");
    killTree(pid, "SIGKILL");
    await exited;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(-pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the group is still there");
  });
});

describe("artifacts", () => {
  it("matches globs", () => {
    expect(globToRegExp("*.tgz").test("a.tgz")).toBe(true);
    expect(globToRegExp("*.tgz").test("d/a.tgz")).toBe(false);
    expect(globToRegExp("dist/**/*.zip").test("dist/a/b/x.zip")).toBe(true);
    expect(globToRegExp("dist/**/*.zip").test("dist/x.zip")).toBe(true);
    expect(globToRegExp("**/app-*").test("app-1")).toBe(true);
    expect(globToRegExp("**/app-*").test("x/y/app-1")).toBe(true);
    expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("collects files, skipping .git and symlinks", () => {
    const d = tmp();
    put(d, "a.tgz");
    put(d, "dist/x/app.zip");
    put(d, ".git/x.zip");
    put(d, "other.txt");
    symlinkSync(join(d, "a.tgz"), join(d, "link.tgz"));
    expect(collectArtifacts(d, ["*.tgz", "dist/**/*.zip", "**/*.zip"])).toEqual(["a.tgz", "dist/x/app.zip"]);
    expect(collectArtifacts(d, ["nothing/*"])).toEqual([]);
  });

  it("copies the collected tree as it is, so equal file names of two builds both stay", () => {
    const d = tmp();
    put(d, "in/linux/bin/app", "1");
    put(d, "in/macos/bin/app", "2");
    copyTree(join(d, "in"), join(d, "out"));
    expect(readFileSync(join(d, "out/linux/bin/app"), "utf8")).toBe("1");
    expect(readFileSync(join(d, "out/macos/bin/app"), "utf8")).toBe("2");
  });

  it("writes SHA256SUMS over the whole tree unless there is one", async () => {
    const d = tmp();
    put(d, "a.txt", "hello");
    put(d, "sub/b.txt", "world");
    expect(await writeSha256Sums(d)).toBe(true);
    const sum = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(readFileSync(join(d, "SHA256SUMS"), "utf8")).toBe(`${sum("hello")}  a.txt\n${sum("world")}  sub/b.txt\n`);
    writeFileSync(join(d, "SHA256SUMS"), "mine\n");
    expect(await writeSha256Sums(d)).toBe(false);
    expect(readFileSync(join(d, "SHA256SUMS"), "utf8")).toBe("mine\n");
  });
});

describe.skipIf(process.platform === "win32")("runCommand", () => {
  const testSlot = resolve("tools/test-slot");
  const run = (d: string, cmd: string, more: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    runCommand({
      cmd, cwd: d, testSlot, slotsDir: join(d, "slots"), timeoutMs: more.timeoutMs ?? 30_000, logFile: join(d, "log.txt"), signal: more.signal,
      env: { PATH: process.env.PATH ?? "", FACTORY_VAR_TEST_SLOTS: "0" },
    });

  it("passes the exit code and writes the log", async () => {
    const d = tmp();
    expect(await run(d, "echo hi; exit 0")).toEqual({ code: 0, timedOut: false, aborted: false });
    expect(await run(d, "exit 3")).toMatchObject({ code: 3 });
    expect(readFileSync(join(d, "log.txt"), "utf8")).toContain("hi");
  });

  it("in strict mode never runs without a slot: it waits, then fails", async () => {
    const d = tmp();
    mkdirSync(join(d, "slots/slot-1"), { recursive: true });
    writeFileSync(join(d, "slots/slot-1/pid"), String(process.pid)); // a holder that is alive
    const r = await runCommand({
      cmd: `touch "${d}/ran"`, cwd: d, testSlot, slotsDir: join(d, "slots"), timeoutMs: 30_000, logFile: join(d, "log.txt"),
      env: { PATH: process.env.PATH ?? "", FACTORY_VAR_TEST_SLOTS: "1", FACTORY_TEST_SLOT_WAIT_SEC: "0", FACTORY_TEST_SLOT_POLL_MS: "20", FACTORY_TEST_SLOT_STRICT: "1" },
    });
    expect(r.code).toBe(75);
    expect(existsSync(join(d, "ran"))).toBe(false);
    expect(readFileSync(join(d, "log.txt"), "utf8")).toMatch(/no free slot .* not running/);
  });

  it("stops a command at the time limit", async () => {
    const d = tmp();
    const r = await run(d, "sleep 30", { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it("kills a command that ignores TERM when aborted, and its children", async () => {
    const d = tmp();
    const stop = new AbortController();
    const running = run(d, `echo $$ > "${d}/pid"; trap '' TERM; sleep 60 & wait`, { signal: stop.signal });
    while (!existsSync(join(d, "pid"))) await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    stop.abort();
    const r = await running;
    expect(r.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(gone(Number(readFileSync(join(d, "pid"), "utf8")))).toBe(true);
  });
});
