import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LsRemoteError, resolveHead } from "../src/skill-import/ls-remote.js";
import { skillDiscoverCommand } from "../src/skill-import/discover-cli.js";
import { candidatesPath } from "../src/skills/discovery.js";
import { killPids } from "./helpers/kill-pids.js";

// Stub git and a private TMPDIR; one real local repository for the real-git case.

const STUB = join(__dirname, "fixtures", "fake-skill-git.sh");
const REPO = "https://github.com/example/skills";
const HEAD40 = "a".repeat(40);

let work: string;
let root: string; // private TMPDIR
let bin: string;
let pids: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.TMPDIR;
  work = mkdtempSync(join(tmpdir(), "ls-remote-work-"));
  root = join(work, "tmp");
  mkdirSync(root);
  bin = join(work, "bin");
  mkdirSync(bin);
  copyFileSync(STUB, join(bin, "git"));
  chmodSync(join(bin, "git"), 0o755);
  pids = join(work, "pids");
  process.env.TMPDIR = root;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved;
  if (existsSync(pids)) killPids(readFileSync(pids, "utf8").split(/\s+/).slice(0, 2).join(" "));
  rmSync(work, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}:${process.env.PATH}`, STUB_MODE: "fake", STUB_PIDS: pids, ...extra });
const folders = () => readdirSync(root).filter((n) => n.startsWith("scf-skill-resolve-"));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LsRemoteError);
    return (e as LsRemoteError).code;
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

describe("resolveHead with a stub git", { timeout: 15_000, retry: 0 }, () => {
  it("returns the commit and calls git as planned", async () => {
    const out = join(work, "args.txt");
    expect(await resolveHead(REPO, { env: env({ STUB_ARGS: out }) })).toBe(HEAD40);
    const args = readFileSync(out, "utf8").trim();
    expect(args).toMatch(/^-c credential\.helper= -c http\.followRedirects=false .* ls-remote --quiet -- https:\/\/github\.com\/example\/skills HEAD$/);
    expect(folders()).toEqual([]);
  });

  it("gives git a private environment", async () => {
    const out = join(work, "env.txt");
    await resolveHead(REPO, { env: env({ STUB_ENV: out, GIT_ASKPASS: "x", GIT_DIR: "/x" }) });
    const lines = readFileSync(out, "utf8").split("\n");
    const get = (k: string) => lines.find((l) => l.startsWith(k + "="))?.slice(k.length + 1);
    expect(get("GIT_ALLOW_PROTOCOL")).toBe("https");
    expect(get("GIT_DIR")).toBeUndefined();
    expect(get("GIT_ASKPASS")).toBeUndefined();
    expect(get("HOME")).toMatch(/scf-skill-resolve-[^/]+\/home$/);
    expect(get("GIT_CEILING_DIRECTORIES")).toMatch(/scf-skill-resolve-/);
  });

  it("reads a local path as file:// when remote is given", async () => {
    const out = join(work, "args.txt");
    const outEnv = join(work, "env.txt");
    await resolveHead(REPO, { remote: "/nowhere", env: env({ STUB_ARGS: out, STUB_ENV: outEnv }) });
    expect(readFileSync(out, "utf8")).toContain("-- file:///nowhere HEAD");
    expect(readFileSync(outEnv, "utf8")).toContain("GIT_ALLOW_PROTOCOL=file");
  });

  it("reports a missing git", async () => {
    const empty = join(work, "empty");
    mkdirSync(empty);
    expect(await code(resolveHead(REPO, { env: { PATH: empty } }))).toBe("no-git");
    expect(folders()).toEqual([]);
  });

  it("maps a failure and a bad answer to fixed codes", async () => {
    expect(await code(resolveHead(REPO, { env: env({ STUB_HEAD: "fail" }) }))).toBe("unreachable");
    expect(await code(resolveHead(REPO, { env: env({ STUB_HEAD: "junk" }) }))).toBe("bad-answer");
    expect(await code(resolveHead(REPO, { env: env({ STUB_HEAD: "two" }) }))).toBe("bad-answer");
    expect(await code(resolveHead(REPO, { env: env({ STUB_HEAD: "flood" }) }))).toBe("bad-answer");
    expect(folders()).toEqual([]);
  });

  it("times out on a stalled helper and kills git and the helper", async () => {
    expect(await code(resolveHead(REPO, { env: env({ STUB_MODE: "hang" }), timeoutMs: 1500 }))).toBe("timeout");
    const p = pidFile();
    await gone(p.pid);
    await gone(p.child);
    expect(folders()).toEqual([]);
  });

  it("stops on an abort while hung", async () => {
    const ac = new AbortController();
    const done = code(resolveHead(REPO, { env: env({ STUB_MODE: "hang" }), signal: ac.signal }));
    await hung();
    ac.abort();
    expect(await done).toBe("interrupted");
    const p = pidFile();
    await gone(p.pid);
    await gone(p.child);
    expect(folders()).toEqual([]);
  });

  it("starts nothing when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await code(resolveHead(REPO, { env: env({ STUB_MODE: "hang" }), signal: ac.signal }))).toBe("interrupted");
    expect(existsSync(pids)).toBe(false);
    expect(folders()).toEqual([]);
  });
});

describe("the command with the real resolver", { timeout: 15_000, retry: 0 }, () => {
  it("leaves no process, no folder and no change on SIGTERM", async () => {
    const home = join(work, "home");
    mkdirSync(home);
    const savedHome = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    try {
      writeFileSync(join(work, "export.txt"), "example/skills\n");
      const lines: string[] = [];
      const run = skillDiscoverCommand({ positionals: [join(work, "export.txt")], values: {} }, (l) => lines.push(l), {
        resolve: (repository, { signal }) => resolveHead(repository, { env: env({ STUB_MODE: "hang" }), signal }),
      });
      await hung();
      process.emit("SIGTERM");
      expect(await run).toBe(1);
      expect(lines).toContain("PROBLEM the discovery was interrupted; the candidate list was not changed");
      const p = pidFile();
      await gone(p.pid);
      await gone(p.child);
      expect(folders()).toEqual([]);
      expect(existsSync(candidatesPath())).toBe(false);
    } finally {
      process.env.FACTORY_HOME = savedHome;
    }
  });
});

describe("resolveHead with real git", { timeout: 30_000, retry: 0 }, () => {
  let repo: string;
  let commit: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ls-remote-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "--quiet");
    writeFileSync(join(repo, "f"), "x");
    git("add", "f");
    git("commit", "--quiet", "-m", "one");
    commit = git("rev-parse", "HEAD").trim();
  });

  it("returns the commit of HEAD without a GIT_DIR", async () => {
    expect(await resolveHead(REPO, { remote: repo })).toBe(commit);
  });
  it("gives unreachable for a missing path", async () => {
    expect(await code(resolveHead(REPO, { remote: join(repo, "missing") }))).toBe("unreachable");
  });
});
