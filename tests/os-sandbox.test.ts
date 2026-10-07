import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { ownDir, readPlainFile, resetSandboxCache, SANDBOX_FOLDER_FAILED, SANDBOX_REFUSED, sandboxedRun, sandboxHomeEnv, sandboxProfile, wrapsStep, type SandboxPaths } from "../src/engine/os-sandbox.js";
import { spawnTarget } from "../src/steps/process.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const same = (p: string) => p;
const base: SandboxPaths = {
  home: "/Users/mac",
  data: "/Users/mac/.data",
  runs: "/Users/mac/.data/runs",
  runDir: "/Users/mac/.data/runs/r1",
  tools: "/repo/tools",
  hooks: "/Users/mac/.data/hooks",
  learnings: "/Users/mac/.data/learnings/app.md",
  lockDir: "/Users/mac/.data/locks",
  temp: "/var/tmpx",
  ghDir: "/var/tmpx/scf-gh-1",
};
const at = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};
const lines = (text: string) => text.split("\n");

describe("sandboxProfile", () => {
  const text = sandboxProfile(base, same);

  it("denies reads of the home, the data folder, the runs folder and the temp folder", () => {
    for (const p of ["/Users/mac", "/Users/mac/.data", "/Users/mac/.data/runs", "/var/tmpx"]) expect(text).toContain(`(deny file-read* (subpath "${p}"))`);
  });

  it("allows reads again of the run folder, tools, hooks, locks, the gh folder, the learnings file and known_hosts", () => {
    for (const p of ["/Users/mac/.data/runs/r1", "/repo/tools", "/Users/mac/.data/hooks", "/Users/mac/.data/locks", "/var/tmpx/scf-gh-1"]) expect(text).toContain(`(allow file-read* (subpath "${p}"))`);
    expect(text).toContain('(allow file-read* (literal "/Users/mac/.data/learnings/app.md"))');
    expect(text).toContain('(allow file-read* (literal "/Users/mac/.data/known_hosts"))');
  });

  it("allows writes only in the run folder, its tmp, the lock folder, the gh folder, the learnings file and three devices", () => {
    const writes = lines(text).filter((l) => l.startsWith("(allow file-write*"));
    expect(writes).toEqual([
      '(allow file-write* (subpath "/Users/mac/.data/runs/r1"))',
      '(allow file-write* (subpath "/Users/mac/.data/runs/r1/tmp"))',
      '(allow file-write* (subpath "/Users/mac/.data/locks"))',
      '(allow file-write* (subpath "/var/tmpx/scf-gh-1"))',
      '(allow file-write* (literal "/Users/mac/.data/learnings/app.md"))',
      '(allow file-write* (literal "/dev/null"))',
      '(allow file-write* (literal "/dev/tty"))',
      '(allow file-write* (literal "/dev/dtracehelper"))',
    ]);
  });

  it("keeps run.json, live.log, logs and the markers read-only", () => {
    expect(text).toContain('(deny file-write* (literal "/Users/mac/.data/runs/r1/run.json") (literal "/Users/mac/.data/runs/r1/live.log") (subpath "/Users/mac/.data/runs/r1/logs"))');
    expect(text).toContain('(deny file-write* (subpath "/Users/mac/.data/locks/.running"))');
  });

  it("is ordered so that the last matching rule gives the right answer", () => {
    const order = [
      '(deny file-read* (subpath "/Users/mac"))',
      '(deny file-read* (subpath "/Users/mac/.data"))',
      '(deny file-read* (subpath "/Users/mac/.data/runs"))',
      '(deny file-read* (subpath "/var/tmpx"))',
      '(allow file-read* (subpath "/Users/mac/.data/runs/r1"))',
      "(deny file-write*)",
      '(allow file-write* (subpath "/Users/mac/.data/runs/r1"))',
      '(deny file-write* (literal "/Users/mac/.data/runs/r1/run.json")',
      '(deny file-write* (subpath "/Users/mac/.data/locks/.running"))',
      '(deny file-write* (literal "/Users/mac/.data/runs/r1") (literal "/Users/mac/.data/locks"))',
      "(deny file-link)",
      "(deny file-clone)",
    ].map((n) => at(text, n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("denies the Keychain, unix sockets, opening apps, Apple events and launchd jobs, and leaves the network open", () => {
    expect(text).toContain('(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))');
    expect(text).toContain("(deny network-outbound (remote unix-socket))");
    expect(text).toContain("mDNSResponder");
    for (const op of ["lsopen", "appleevent-send", "job-creation"]) expect(text).toContain(`(deny ${op})`);
    expect(lines(text).filter((l) => /^\(deny network\*/.test(l))).toEqual([]);
  });

  it("gives the metadata of each folder above an allowed path under a denied folder, once", () => {
    const meta = lines(text).filter((l) => l.startsWith("(allow file-read-metadata"));
    expect(meta).toContain('(allow file-read-metadata (literal "/Users/mac/.data/runs"))');
    expect(meta).toContain('(allow file-read-metadata (literal "/Users/mac/.data"))');
    expect(meta).toContain('(allow file-read-metadata (literal "/Users/mac"))');
    expect(new Set(meta).size).toBe(meta.length);
    expect(meta).not.toContain('(allow file-read-metadata (literal "/Users"))');
  });

  it("follows links of the parents but not of the run folder, the lock folder or the learnings file", () => {
    const real = (p: string) => {
      if (p === "/tmp/x") return "/private/tmp/x";
      if (p === "/tmp") return "/private/tmp";
      if (p === "/Users/mac" || p.startsWith("/Users/mac/")) return p;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const t = sandboxProfile({ ...base, runs: "/tmp/x", runDir: "/tmp/x/r1", lockDir: "/tmp/x/locks", learnings: "/tmp/x/L/app.md", temp: undefined, ghDir: undefined }, real);
    expect(t).toContain('(deny file-read* (subpath "/private/tmp/x"))');
    expect(t).toContain('(allow file-read* (subpath "/private/tmp/x/r1"))');
    expect(t).toContain('(allow file-write* (subpath "/private/tmp/x/r1/tmp"))');
    expect(t).toContain('(allow file-read* (literal "/private/tmp/x/L/app.md"))'); // does not exist yet: still gets its rule
  });

  it("does not bring the target of a tmp link into the profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-link-"));
    const outside = join(dir, "outside");
    mkdirSync(join(dir, "run"));
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "run", "tmp"));
    const t = sandboxProfile({ ...base, runs: dir, runDir: join(dir, "run"), temp: undefined, ghDir: undefined });
    expect(t).not.toContain(outside);
    expect(t).toContain(`${join(execFileSync("/bin/realpath", [dir]).toString().trim(), "run", "tmp")}"`);
  });

  it("quotes a path with a quote, a backslash or a space and refuses a line break", () => {
    const t = sandboxProfile({ ...base, userRead: ['/opt/a "b"', "/opt/c\\d", "/opt/e f"] }, same);
    expect(t).toContain('(allow file-read* (subpath "/opt/a \\"b\\""))');
    expect(t).toContain('(allow file-read* (subpath "/opt/c\\\\d"))');
    expect(t).toContain('(allow file-read* (subpath "/opt/e f"))');
    expect(() => sandboxProfile({ ...base, userRead: ["/opt/a\nb"] }, same)).toThrow(/line break/);
  });

  it("puts every exception (user_read, program folders) after all broad denies, also inside the data, runs and temp folders", () => {
    const nested = ["/Users/mac/.data/tools-extra", "/Users/mac/.data/runs/shared", "/var/tmpx/cache", "/opt/extra1", "/Users/mac/nvm/bin"];
    const t = sandboxProfile({ ...base, userRead: [...nested.slice(0, 4), "/opt/extra2", "relative"], programs: ["/Users/mac/nvm/bin/node", "/usr/bin/git", "/Users/mac/claude", "claude"] }, same);
    const lastDeny = Math.max(...["/Users/mac", "/Users/mac/.data", "/Users/mac/.data/runs", "/var/tmpx"].map((p) => at(t, `(deny file-read* (subpath "${p}"))`)));
    for (const p of [...nested, "/opt/extra2"]) expect(at(t, `(allow file-read* (subpath "${p}"))`), p).toBeGreaterThan(lastDeny);
    expect(t).not.toContain('"/usr/bin"');
    expect(t).not.toContain("relative");
    expect(t).not.toContain('(allow file-read* (subpath "/Users/mac"))'); // a program whose folder is the home
  });
});

describe("ownDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sbx-own-"));
  });
  const mode = (p: string) => statSync(p).mode & 0o777;

  it("replaces a link by a real folder and leaves the link's target alone", () => {
    const target = join(dir, "target");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    writeFileSync(join(target, "f"), "x");
    symlinkSync(target, join(dir, "home"));
    ownDir(join(dir, "home"));
    expect(statSync(join(dir, "home")).isDirectory()).toBe(true);
    expect(mode(join(dir, "home"))).toBe(0o700);
    expect(mode(target)).toBe(0o755);
    expect(readFileSync(join(target, "f"), "utf8")).toBe("x");
  });

  it("replaces a file and tightens an open folder", () => {
    writeFileSync(join(dir, "a"), "x");
    ownDir(join(dir, "a"));
    expect(statSync(join(dir, "a")).isDirectory()).toBe(true);
    mkdirSync(join(dir, "b"), { mode: 0o755 });
    chmodSync(join(dir, "b"), 0o755);
    ownDir(join(dir, "b"));
    expect(mode(join(dir, "b"))).toBe(0o700);
  });

  it("throws SANDBOX_FOLDER_FAILED where the folder cannot be made", () => {
    expect(() => ownDir(join(dir, "missing", "deeper"))).toThrow(SANDBOX_FOLDER_FAILED);
  });

  it("makes HOME and the temp folders inside the run folder", () => {
    expect(sandboxHomeEnv(dir)).toEqual({ HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), TMP: join(dir, "tmp"), TEMP: join(dir, "tmp") });
  });
});

describe("readPlainFile", () => {
  it("reads at most the given number of bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-big-"));
    writeFileSync(join(dir, "f"), "0123456789");
    expect(readPlainFile(join(dir, "f"), 4)).toBe("0123");
  });

  it("reads a file and gives nothing for a link, a pipe, a folder or a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-read-"));
    writeFileSync(join(dir, "f"), "hello");
    symlinkSync(join(dir, "f"), join(dir, "l"));
    execFileSync("mkfifo", [join(dir, "p")]);
    expect(readPlainFile(join(dir, "f"))).toBe("hello");
    for (const n of ["l", "p", "", "missing"]) expect(readPlainFile(join(dir, n))).toBe("");
  });
});

describe("sandboxedRun", () => {
  const cfg = (user_runs: "required" | "off" = "required") => ConfigSchema.parse({ sandbox: { user_runs } });
  let admin: { id: string };
  let user: { id: string };
  let saved: [string | undefined, string | undefined];
  beforeAll(async () => {
    admin = await createUser({ name: "A", email: "a@example.com", password: TEST_PASSWORD, role: "admin" });
    user = await createUser({ name: "U", email: "u@example.com", password: TEST_PASSWORD, role: "user" });
  });
  beforeEach(() => {
    saved = [process.env.SCF_USER_SANDBOX, process.env.FACTORY_USER_SANDBOX];
    delete process.env.SCF_USER_SANDBOX;
    delete process.env.FACTORY_USER_SANDBOX;
  });
  afterEach(() => {
    for (const [i, k] of ["SCF_USER_SANDBOX", "FACTORY_USER_SANDBOX"].entries()) {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    }
    resetSandboxCache();
  });

  it("is off for an admin and for a run without an owner", () => {
    expect(sandboxedRun(admin.id, cfg(), () => false)).toBe("off");
    expect(sandboxedRun(undefined, cfg(), () => false)).toBe("off");
  });
  it("is off for a user when the setting or a server variable says so", () => {
    expect(sandboxedRun(user.id, cfg("off"), () => false)).toBe("off");
    process.env.SCF_USER_SANDBOX = "off";
    expect(sandboxedRun(user.id, cfg(), () => false)).toBe("off");
    delete process.env.SCF_USER_SANDBOX;
    process.env.FACTORY_USER_SANDBOX = "off";
    expect(sandboxedRun(user.id, cfg(), () => false)).toBe("off");
  });
  it("is on for a user where a sandbox works, and refused where it does not", () => {
    expect(sandboxedRun(user.id, cfg(), () => true)).toBe("on");
    expect(sandboxedRun(user.id, cfg(), () => false)).toEqual({ refused: SANDBOX_REFUSED });
    expect(SANDBOX_REFUSED).toBe("This computer cannot hold a user's run in a sandbox, so the run was not started. An admin can allow user runs without it in Settings.");
  });
  it("counts an unknown owner as a user", () => {
    expect(sandboxedRun("nobody", cfg(), () => true)).toBe("on");
  });
});

describe("wrapsStep and spawnTarget", () => {
  it("wraps a step of a sandboxed run unless a Docker image holds it", () => {
    expect(wrapsStep("on", undefined)).toBe(true);
    expect(wrapsStep("on", "node:22")).toBe(false);
    expect(wrapsStep("off", undefined)).toBe(false);
  });
  it("starts sandbox-exec only with a profile", () => {
    expect(spawnTarget("/bin/sh", ["-c", "x"])).toEqual({ cmd: "/bin/sh", args: ["-c", "x"] });
    expect(spawnTarget("/bin/sh", ["-c", "x"], "(version 1)")).toEqual({ cmd: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)", "/bin/sh", "-c", "x"] });
  });
});

describe("the sandbox settings", () => {
  it("default to required and no extra paths, also for an old config", () => {
    expect(ConfigSchema.parse({}).sandbox).toEqual({ user_runs: "required", user_read: [] });
    expect(ConfigSchema.parse({ sandbox: { claude: true } }).sandbox).toEqual({ claude: true, user_runs: "required", user_read: [] });
  });
  it("refuse a relative path, more than 50 paths and an unknown mode", () => {
    expect(() => ConfigSchema.parse({ sandbox: { user_read: ["rel/path"] } })).toThrow();
    expect(() => ConfigSchema.parse({ sandbox: { user_read: Array.from({ length: 51 }, (_, i) => `/p${i}`) } })).toThrow();
    expect(() => ConfigSchema.parse({ sandbox: { user_runs: "maybe" } })).toThrow();
  });
});
