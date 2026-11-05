import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkoutPreview, killCheckouts, PREVIEW_FILE_MAX } from "../src/preview/checkout.js";
import { fakeToken } from "./helpers/keychain.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
const YAML = 'command: "node app.js"\n';

let base: string;
let src: string;
let bare: string;
let n = 0;
const target = () => join(base, "out", `c${n++}`);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "preview-checkout-")));
  src = join(base, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "develop");
  git(src, "config", "user.email", "t@example.com");
  git(src, "config", "user.name", "T");
  mkdirSync(join(src, ".factory"));
  writeFileSync(join(src, ".factory", "preview.yaml"), YAML);
  writeFileSync(join(src, "a.txt"), "a\n");
  git(src, "add", ".");
  git(src, "commit", "-qm", "one");
  // a branch with no preview file, one with a link, one with a big file
  git(src, "checkout", "-qb", "plain");
  git(src, "rm", "-q", "-r", ".factory");
  git(src, "commit", "-qm", "no file");
  git(src, "checkout", "-qb", "linked", "develop");
  git(src, "rm", "-q", ".factory/preview.yaml");
  mkdirSync(join(src, ".factory"), { recursive: true });
  symlinkSync("/etc/hostname", join(src, ".factory", "preview.yaml"));
  git(src, "add", ".");
  git(src, "commit", "-qm", "link");
  git(src, "checkout", "-qb", "big", "develop");
  writeFileSync(join(src, ".factory", "preview.yaml"), "#" + "x".repeat(PREVIEW_FILE_MAX));
  git(src, "commit", "-qam", "big");
  git(src, "checkout", "-q", "develop");
  bare = join(base, "bare.git");
  git(base, "clone", "-q", "--bare", src, bare);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.SCF_CONNECT_REMOTE;
});

/** A git that writes down its arguments, then runs the real one. */
function recorder(): { bin: string; log: string } {
  const dir = mkdtempSync(join(base, "rec-"));
  const bin = join(dir, "git");
  const log = join(dir, "args.log");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec git "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

const path = (p: string) => ({ kind: "path" as const, path: p });

describe("checkoutPreview", () => {
  it("clones a branch of a bare repository and returns the text of preview.yaml", async () => {
    const dir = target();
    const r = await checkoutPreview({ source: path(bare), branch: "develop", dir });
    expect(r).toEqual({ ok: true, config: YAML });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
  });

  it("answers ok without text for a branch without the file", async () => {
    expect(await checkoutPreview({ source: path(bare), branch: "plain", dir: target() })).toEqual({ ok: true });
  });

  it("refuses a link and a big file", async () => {
    expect(await checkoutPreview({ source: path(bare), branch: "linked", dir: target() })).toMatchObject({ ok: true, configProblem: expect.stringContaining("not a regular file") });
    expect(await checkoutPreview({ source: path(bare), branch: "big", dir: target() })).toMatchObject({ ok: true, configProblem: expect.stringContaining("larger than 64 KiB") });
  });

  it("tells an unknown branch and a missing folder apart", async () => {
    const dir = target();
    expect(await checkoutPreview({ source: path(bare), branch: "nope", dir })).toMatchObject({ ok: false, reason: "no-branch" });
    expect(existsSync(dir)).toBe(false);
    expect(await checkoutPreview({ source: path(join(base, "missing")), branch: "develop", dir })).toMatchObject({ ok: false, reason: "no-source" });
    expect(await checkoutPreview({ source: path(src), branch: "develop", dir: join(base, "x", "y"), gitBin: join(base, "missing-git") })).toMatchObject({ ok: false, reason: "checkout-failed" });
  });

  it("never calls git for a bad branch name", async () => {
    const rec = recorder();
    for (const branch of ["-x", "a..b", "", "a b"]) {
      expect(await checkoutPreview({ source: path(bare), branch, dir: target(), gitBin: rec.bin })).toMatchObject({ ok: false, reason: "checkout-failed" });
    }
    expect(existsSync(rec.log)).toBe(false);
  });

  it("runs git without hooks and without a template", async () => {
    const rec = recorder();
    const dir = target();
    expect((await checkoutPreview({ source: path(bare), branch: "develop", dir, gitBin: rec.bin })).ok).toBe(true);
    expect(existsSync(join(dir, ".git", "hooks"))).toBe(false);
    const lines = readFileSync(rec.log, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l).toContain("core.hooksPath=/dev/null");
    expect(lines.filter((l) => l.includes(" clone ")).every((l) => l.includes("--template="))).toBe(true);
  });

  it("clones a branch of a plain local repository and leaves that repository unchanged", async () => {
    const snapshot = () => [git(src, "rev-parse", "HEAD"), git(src, "for-each-ref"), git(src, "status", "--porcelain"), readdirSync(src).join(",")].join("|");
    const before = snapshot();
    const r = await checkoutPreview({ source: path(src), branch: "develop", dir: target() });
    expect(r).toEqual({ ok: true, config: YAML });
    expect(snapshot()).toBe(before);
  });

  it("signs in to a remote with the token in the environment, never in the arguments, and removes its folder", async () => {
    process.env.SCF_CONNECT_REMOTE = bare;
    const rec = recorder();
    const secret = "github_pat_" + fakeToken("Pv7").slice(4);
    const scratch = mkdtempSync(join(base, "tmp-"));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const r = await checkoutPreview({ source: { kind: "remote", url: "https://github.com/acme/app", auth: { method: "github-token", secret } }, branch: "develop", dir: target(), gitBin: rec.bin });
      expect(r).toEqual({ ok: true, config: YAML });
      expect(readFileSync(rec.log, "utf8")).not.toContain(secret);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
  });

  it("fails a remote without a secret with a fixed sentence", async () => {
    const r = await checkoutPreview({ source: { kind: "remote", url: "https://github.com/acme/app", auth: { method: "github-token" } }, branch: "develop", dir: target() });
    expect(r).toEqual({ ok: false, reason: "checkout-failed", detail: "the project could not be checked out" });
  });

  describe("a git that starts a child", () => {
    function slowGit() {
      const dir = mkdtempSync(join(base, "slow-"));
      const pids = join(dir, "pids");
      const bin = join(dir, "git");
      writeFileSync(bin, `#!/bin/sh\nsleep 300 &\necho "$$ $!" > "${pids}"\nwait\n`);
      chmodSync(bin, 0o755);
      const read = () => readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
      return { bin, ready: () => vi.waitFor(() => read(), { timeout: 5000 }), read };
    }
    const dead = (pids: number[]) => vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 5000 });

    it("kills git and its child when the signal aborts", async () => {
      const s = slowGit();
      const ac = new AbortController();
      const p = checkoutPreview({ source: path(bare), branch: "develop", dir: target(), gitBin: s.bin, signal: ac.signal });
      const pids = await s.ready();
      expect(pids.every(alive)).toBe(true);
      ac.abort();
      expect(await p).toMatchObject({ ok: false, reason: "checkout-failed" });
      await dead(pids);
    });

    it("kills git and its child with killCheckouts()", async () => {
      const s = slowGit();
      const p = checkoutPreview({ source: path(bare), branch: "develop", dir: target(), gitBin: s.bin });
      const pids = await s.ready();
      killCheckouts();
      expect(await p).toMatchObject({ ok: false, reason: "checkout-failed" });
      await dead(pids);
    });

    it("kills the group after the time limit", async () => {
      const s = slowGit();
      const r = await checkoutPreview({ source: path(bare), branch: "develop", dir: target(), gitBin: s.bin, timeoutMs: 1500 });
      expect(r).toMatchObject({ ok: false, reason: "checkout-failed" });
      await dead(s.read());
    });

    it("does not start git when the signal is aborted already", async () => {
      const s = slowGit();
      const ac = new AbortController();
      ac.abort();
      expect(await checkoutPreview({ source: path(bare), branch: "develop", dir: target(), gitBin: s.bin, signal: ac.signal })).toMatchObject({ ok: false });
      expect(existsSync(join(s.bin, "..", "pids"))).toBe(false);
    });
  });
});
