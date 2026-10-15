import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

// Stub git only: no repository, no real git. `node:fs` is wrapped so two calls can fail inside the fetch folder.
const sw = vi.hoisted(() => ({ readdir: false, mkdir: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const inFetch = (p: unknown) => String(p).includes("scf-skill-fetch-");
  const readdirSync = ((p: unknown, ...rest: unknown[]) => {
    if (sw.readdir && inFetch(p)) throw Object.assign(new Error("io"), { code: "EIO" });
    return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readdirSync;
  const mkdirSync = ((p: unknown, ...rest: unknown[]) => {
    if (sw.mkdir && inFetch(p)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (actual.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.mkdirSync;
  return { ...actual, readdirSync, mkdirSync, default: { ...actual, readdirSync, mkdirSync } };
});

const { GitTreeError, openGitTree } = await import("../src/skill-import/git-tree.js");
const { skillImportCommand } = await import("../src/skill-import/cli.js");

import { killPids } from "./helpers/kill-pids.js";

const C40 = "a".repeat(40);
const C64 = "b".repeat(64);
const SOURCE = { repository: "https://github.com/example/skills" };
const STUB = join(__dirname, "fixtures", "fake-skill-git.sh");
const ENTRY = { path: "f", kind: "file" as const, size: 10, id: "c".repeat(40) };

let root: string; // private TMPDIR
let bin: string;
let work: string;
let pids: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.TMPDIR;
  work = mkdtempSync(join(tmpdir(), "limits-work-"));
  root = join(work, "tmp");
  mkdirSync(root);
  bin = join(work, "bin");
  mkdirSync(bin);
  copyFileSync(STUB, join(bin, "git"));
  chmodSync(join(bin, "git"), 0o755);
  pids = join(work, "pids");
  process.env.TMPDIR = root;
  sw.readdir = false;
  sw.mkdir = false;
});
afterEach(() => {
  sw.readdir = false;
  sw.mkdir = false;
  if (saved === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved;
  if (existsSync(pids)) killPids(readFileSync(pids, "utf8").split(/\s+/).slice(0, 2).join(" "));
  rmSync(work, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: `${bin}:${process.env.PATH}`,
  STUB_MODE: "fake",
  STUB_PIDS: pids,
  ...extra,
});
const fetchFolders = () => readdirSync(root).filter((n) => n.startsWith("scf-skill-fetch-"));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitTreeError);
    return (e as InstanceType<typeof GitTreeError>).code;
  }
  return "no error";
};
const pidFile = () => {
  const t = readFileSync(pids, "utf8").trim().split(" ");
  return { pid: Number(t[0]), child: Number(t[1]), dir: t[2]! };
};
const gone = (pid: number) =>
  vi.waitFor(
    () => {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return;
        throw e;
      }
      throw new Error(`${pid} is still alive`);
    },
    { timeout: 5000, interval: 20 },
  );
const hung = () => vi.waitFor(() => expect(/^\d+ \d+ \S+/.test(existsSync(pids) ? readFileSync(pids, "utf8") : "")).toBe(true), { timeout: 5000, interval: 10 });

describe("the environment of git", { timeout: 15_000, retry: 0 }, () => {
  it("drops the caller's git setup and uses an empty HOME", async () => {
    const out = join(work, "env.txt");
    const tree = await openGitTree(SOURCE, C40, {
      remote: "/nowhere",
      timeoutMs: 10_000,
      env: env({ STUB_ENV: out, GIT_ASKPASS: "x", GIT_SSH_COMMAND: "x", SSH_ASKPASS: "x", NETRC: "/x", XDG_CONFIG_HOME: "/x" }),
    });
    const lines = readFileSync(out, "utf8").split("\n");
    for (const k of ["GIT_ASKPASS", "GIT_SSH_COMMAND", "SSH_ASKPASS", "NETRC", "XDG_CONFIG_HOME"]) expect(lines.some((l) => l.startsWith(k + "="))).toBe(false);
    const get = (k: string) => lines.find((l) => l.startsWith(k + "="))?.slice(k.length + 1);
    const [folder] = fetchFolders();
    expect(get("HOME")).toBe(join(root, folder!, "home"));
    expect(get("HOME")).not.toBe(process.env.HOME);
    expect(get("GIT_CONFIG_GLOBAL")).toBe("/dev/null");
    expect(get("GIT_CONFIG_NOSYSTEM")).toBe("1");
    expect(get("GIT_TERMINAL_PROMPT")).toBe("0");
    expect(get("GIT_ALLOW_PROTOCOL")).toBe("file");
    tree.close();
    expect(fetchFolders()).toEqual([]);
  });

  it("allows https only without a remote", async () => {
    const out = join(work, "env.txt");
    const tree = await openGitTree(SOURCE, C40, { timeoutMs: 10_000, env: env({ STUB_ENV: out }) });
    expect(readFileSync(out, "utf8")).toContain("\nGIT_ALLOW_PROTOCOL=https\n");
    tree.close();
  });

  it.each([
    [C40, "--object-format=sha1"],
    [C64, "--object-format=sha256"],
  ])("names the object format for %s", async (commit, flag) => {
    const args = join(work, "args.txt");
    const tree = await openGitTree(SOURCE, commit, { timeoutMs: 10_000, env: env({ STUB_ARGS: args }) });
    expect(readFileSync(args, "utf8")).toContain(flag);
    tree.close();
  });

  it("reports no-git when git is not on the PATH", async () => {
    const empty = join(work, "empty");
    mkdirSync(empty);
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 10_000, env: { PATH: empty } }))).toBe("no-git");
    expect(fetchFolders()).toEqual([]);
  });

  it("starts nothing for a bad commit or an aborted signal", async () => {
    expect(await code(openGitTree(SOURCE, "main", { env: env() }))).toBe("no-commit");
    const ac = new AbortController();
    ac.abort();
    expect(await code(openGitTree(SOURCE, C40, { env: env(), signal: ac.signal }))).toBe("interrupted");
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(pids + ".all")).toBe(false);
  });
});

describe("setup and start failures", { timeout: 15_000, retry: 0 }, () => {
  it("fails when the folder cannot be made", async () => {
    sw.mkdir = true;
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 10_000, env: env() }))).toBe("fetch-failed");
    sw.mkdir = false;
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(pids + ".all")).toBe(false);
  });

  it("settles when the fetch cannot be started", async () => {
    // Its own copy of the stub, alone on the PATH: once init removed it, no git is left to find.
    const own = join(work, "own");
    mkdirSync(own);
    copyFileSync(STUB, join(own, "git"));
    chmodSync(join(own, "git"), 0o755);
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 10_000, env: { PATH: own, STUB_MODE: "fake", STUB_INIT: "vanish" } }))).toBe("no-git");
    expect(readdirSync(root)).toEqual([]);
  });

  it("times out a stalled init", async () => {
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 300, env: env({ STUB_INIT: "stall" }) }))).toBe("timeout");
    expect(readdirSync(root)).toEqual([]);
  });

  it("times out a stalled cat-file -t", async () => {
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 300, env: env({ STUB_TYPE: "stall" }) }))).toBe("timeout");
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("fetch watchdog", { timeout: 15_000, retry: 0 }, () => {
  const opts = (extra: Record<string, unknown> = {}, e: Record<string, string> = {}) => ({ timeoutMs: 10_000, pollMs: 50, env: env({ STUB_MODE: "hang", ...e }), ...extra });
  const finish = async () => {
    const { pid, child, dir } = pidFile();
    await gone(pid);
    await gone(child);
    expect(dir.startsWith(root + "/scf-skill-fetch-")).toBe(true);
    sw.readdir = false;
    expect(readdirSync(root)).toEqual([]);
  };

  it("stops on an abort", async () => {
    const ac = new AbortController();
    const p = openGitTree(SOURCE, C40, opts({ signal: ac.signal }));
    p.catch(() => undefined);
    await hung();
    expect(fetchFolders()).toHaveLength(1);
    ac.abort();
    expect(await code(p)).toBe("interrupted");
    await finish();
  });

  it("stops at the size limit", async () => {
    expect(await code(openGitTree(SOURCE, C40, opts({ repoBytes: 4096 }, { STUB_FILL: "64" })))).toBe("too-large");
    await finish();
  });

  it("stops at the time limit", async () => {
    expect(await code(openGitTree(SOURCE, C40, opts({ timeoutMs: 300 })))).toBe("timeout");
    await finish();
  });

  it("reports a failing size check as fetch-failed", async () => {
    const p = openGitTree(SOURCE, C40, opts({ pollMs: 100 }));
    p.catch(() => undefined);
    await hung();
    sw.readdir = true;
    expect(await code(p)).toBe("fetch-failed");
    await finish();
  });
});

describe("size check at the end of the fetch", { timeout: 15_000, retry: 0 }, () => {
  it("catches a fetch that ends at once with too much data", async () => {
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 10_000, pollMs: 60_000, repoBytes: 4096, env: env({ STUB_FILL: "64" }) }))).toBe("too-large");
    expect(readdirSync(root)).toEqual([]);
  });

  it("reports a failing last size check", async () => {
    sw.readdir = true;
    expect(await code(openGitTree(SOURCE, C40, { timeoutMs: 10_000, pollMs: 60_000, env: env() }))).toBe("fetch-failed");
    sw.readdir = false;
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("listing and reading bounds", { timeout: 15_000, retry: 0 }, () => {
  const open = (e: Record<string, string>, timeoutMs = 10_000) => openGitTree(SOURCE, C40, { timeoutMs, env: env(e) });

  it.each([
    ["flood", { STUB_LIST: "flood" }, 10_000, "bad-listing"],
    ["stall", { STUB_LIST: "stall" }, 2000, "timeout"],
    ["junk", { STUB_LIST: "junk" }, 10_000, "bad-listing"],
  ])("list: %s", async (_n, e, t, expected) => {
    const tree = await open(e, t);
    expect(await code(Promise.resolve().then(() => tree.list(".")))).toBe(expected);
    tree.close();
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ["flood", { STUB_READ: "flood" }, 10_000, "read-failed"],
    ["stall", { STUB_READ: "stall" }, 2000, "timeout"],
    ["short", { STUB_READ: "short" }, 10_000, "read-failed"],
  ])("read: %s", async (_n, e, t, expected) => {
    const tree = await open(e, t);
    expect(await code(Promise.resolve().then(() => tree.read([ENTRY])))).toBe(expected);
    tree.close();
    expect(readdirSync(root)).toEqual([]);
  });

  it("an empty listing is an empty list", async () => {
    const tree = await open({});
    expect(tree.list(".")).toEqual([]);
    expect(tree.read([])).toEqual([]);
    tree.close();
    tree.close();
  });
});

describe("the command with a failing listing", { timeout: 15_000, retry: 0 }, () => {
  it("prints a fixed sentence and stages nothing", async () => {
    const cwd = join(work, "cwd");
    const home = join(work, "home");
    mkdirSync(cwd);
    writeFileSync(
      join(cwd, "skill-sources.yaml"),
      stringify({
        schema: 1,
        sources: [
          {
            id: "lib",
            repository: SOURCE.repository,
            status: "enabled",
            ref: { track: "main", approved: C40 },
            paths: ["skills"],
            adapter: "agent-skills",
            trust: "community",
            licence: { allow: ["MIT"] },
            update: { cadence: "manual" },
            owner: "@example",
            review: { by: "@example", on: "2026-01-01", commit: C40, licence: "MIT" },
          },
        ],
      }),
    );
    const lines: string[] = [];
    const rc = await skillImportCommand({ positionals: ["lib"], values: {} }, (l) => lines.push(l), {
      cwd,
      home,
      env: env({ STUB_LIST: "flood" }),
      open: (s, c, o) => openGitTree(s, c, { ...o, timeoutMs: 10_000 }),
    });
    expect(rc).toBe(1);
    expect(lines).toEqual(["PROBLEM the file list of the commit could not be read"]);
    expect(existsSync(join(home, "skill-quarantine"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
