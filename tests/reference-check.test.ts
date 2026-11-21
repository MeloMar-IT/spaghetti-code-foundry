import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { REF_CHANGED, checkReferences, lockedTree } from "../src/engine/reference-check.js";
import { prepareReferences, referencePrompt, removeReferences, type ReferenceDeps } from "../src/engine/reference-repos.js";
import type { RunSummary } from "../src/engine/state.js";

const root = process.getuid?.() === 0;
let tmp: string;
let remote: string;
const savedRemote = process.env.SCF_CONNECT_REMOTE;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "reference-check-"));
  const seed = join(tmp, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "ROUTES.md"), "GET /v1/items\n");
  writeFileSync(join(seed, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  mkdirSync(join(seed, "docs"));
  writeFileSync(join(seed, "docs", "format.md"), "a format\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  remote = join(tmp, "remote.git");
  git(tmp, "clone", "-q", "--bare", seed, remote);
  process.env.SCF_CONNECT_REMOTE = remote;
});
afterAll(() => {
  if (savedRemote === undefined) delete process.env.SCF_CONNECT_REMOTE;
  else process.env.SCF_CONNECT_REMOTE = savedRemote;
  rmSync(tmp, { recursive: true, force: true });
});

let runDir: string;
let n = 0;
let s: RunSummary;
const base = () => join(runDir, "reference");
const lib = () => join(base(), "acme-lib");
const api = () => join(base(), "acme-api");
const deps: ReferenceDeps = { access: () => ({ kind: "server" }), credential: () => "machine", visibility: async () => "public", now: () => new Date("2026-11-15T10:00:00.000Z") };

beforeEach(async () => {
  runDir = join(tmp, `run-${++n}`);
  mkdirSync(runDir);
  s = { runDir, vars: { github_repo: "acme/app" }, owner: "a1", referenceRepos: { repos: ["acme/lib", "acme/api"] } } as unknown as RunSummary;
  await prepareReferences(s, ConfigSchema.parse({}), { log: () => undefined, hold: "file modes" }, deps);
});
afterEach(() => {
  removeReferences(runDir);
});

const check = async (o: Parameters<typeof checkReferences>[2] = {}) => {
  const lines: string[] = [];
  const changed = await checkReferences(s, (l) => void lines.push(l), o);
  return { changed, lines };
};
const rec = (repo: string) => s.references!.find((r) => r.repo === repo)!;
const unlock = (dir: string) => execFileSync("chmod", ["-R", "u+w", dir]);
const relock = (dir: string) => {
  execFileSync("find", [dir, "-type", "f", "-exec", "chmod", "0444", "{}", "+"]);
  execFileSync("find", [dir, "-type", "d", "-exec", "chmod", "0555", "{}", "+"]);
};
const mode = (p: string) => statSync(p).mode & 0o7777;

describe.skipIf(root)("checkReferences", { timeout: 30_000 }, () => {
  it("leaves untouched copies alone, also with a tracked executable file", async () => {
    expect(lockedTree(lib())).toBe(true);
    const { changed, lines } = await check();
    expect([changed, lines]).toEqual([false, []]);
    expect(rec("acme/lib").ok && rec("acme/api").ok).toBe(true);
    expect(existsSync(join(lib(), "run.sh"))).toBe(true);
  });

  it("removes a copy whose file mode changed, keeps the other, and relocks reference/", async () => {
    chmodSync(join(lib(), "ROUTES.md"), 0o644);
    const { changed, lines } = await check();
    expect(changed).toBe(true);
    expect(lines).toEqual(["! reference acme/lib: removed — it was changed during the run"]);
    expect(rec("acme/lib")).toMatchObject({ ok: false, reason: REF_CHANGED });
    expect(rec("acme/lib").folder).toBeUndefined();
    expect(existsSync(lib())).toBe(false);
    expect(rec("acme/api").ok).toBe(true);
    expect(existsSync(api())).toBe(true);
    expect(mode(base())).toBe(0o555);
    expect(referencePrompt(s)!.text).toContain("Not available in this run: acme/lib.");
  });

  it("removes a copy whose content changed with the modes put back", async () => {
    unlock(lib());
    writeFileSync(join(lib(), "ROUTES.md"), "changed\n");
    relock(lib());
    expect((await check()).lines).toHaveLength(1);
    expect(existsSync(lib())).toBe(false);
  });

  it("removes a copy with a new untracked file", async () => {
    unlock(lib());
    writeFileSync(join(lib(), "NEW.md"), "x");
    relock(lib());
    expect((await check()).changed).toBe(true);
    expect(existsSync(lib())).toBe(false);
  });

  it("removes a copy with an extra commit", async () => {
    unlock(lib());
    git(lib(), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "x");
    relock(lib());
    expect((await check()).changed).toBe(true);
    expect(existsSync(lib())).toBe(false);
  });

  it("removes a copy with a link in it", async () => {
    unlock(lib());
    symlinkSync("/etc/hosts", join(lib(), "link"));
    relock(lib());
    expect((await check()).changed).toBe(true);
    expect(existsSync(lib())).toBe(false);
  });

  it("treats a copy deleted by a step as changed, and logs it once", async () => {
    chmodSync(base(), 0o700);
    unlock(lib());
    rmSync(lib(), { recursive: true });
    chmodSync(base(), 0o555);
    const first = await check();
    expect([first.changed, first.lines]).toEqual([true, ["! reference acme/lib: removed — it was changed during the run"]]);
    expect(rec("acme/lib")).toMatchObject({ ok: false, reason: REF_CHANGED });
    expect(await check()).toEqual({ changed: false, lines: [] });
  });

  it("invalidates every usable record when only reference/ changed its mode", async () => {
    chmodSync(base(), 0o755);
    const { changed, lines } = await check();
    expect(changed).toBe(true);
    expect(lines).toHaveLength(2);
    expect(rec("acme/lib").ok || rec("acme/api").ok).toBe(false);
    expect(rec("acme/lib").reason).toBe(REF_CHANGED);
    expect(existsSync(base())).toBe(false);
    expect(existsSync(lib())).toBe(false);
    expect(existsSync(api())).toBe(false);
  });

  it("never follows reference/ replaced by a link", async () => {
    const outside = join(tmp, `outside-${n}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep");
    chmodSync(outside, 0o755);
    chmodSync(base(), 0o700);
    renameSync(base(), join(tmp, `moved-${n}`));
    symlinkSync(outside, base());
    const { changed } = await check();
    expect(changed).toBe(true);
    expect(s.references!.some((r) => r.ok)).toBe(false);
    expect(existsSync(join(outside, "sentinel"))).toBe(true);
    expect(mode(outside)).toBe(0o755);
    // the link itself is removed; the folder it pointed at is not touched
    expect(existsSync(base())).toBe(false);
    renameSync(join(tmp, `moved-${n}`), base());
  });

  it("invalidates the record when the copy cannot be removed, keeps it denied, and relocks reference/", async () => {
    chmodSync(join(lib(), "ROUTES.md"), 0o644);
    const { changed, lines } = await check({ remove: () => false });
    expect(changed).toBe(true);
    expect(lines).toEqual(["! reference acme/lib: unavailable — it was changed during the run and could not be removed"]);
    expect(rec("acme/lib")).toMatchObject({ ok: false, reason: REF_CHANGED, folder: "reference/acme-lib" });
    expect(mode(base())).toBe(0o555);
    expect(referencePrompt(s)!.dirs).toContain(lib());
  });

  it("counts a git error as a change and never throws", async () => {
    const { changed } = await check({ head: async () => { throw new Error("boom"); } });
    expect(changed).toBe(true);
    expect(rec("acme/lib").ok || rec("acme/api").ok).toBe(false);
  });

  it("does not touch failed records or records of an older preparation", async () => {
    s.references!.unshift({ repo: "acme/old", at: "2020-01-01T00:00:00.000Z", ok: true, commit: "a".repeat(40), folder: "reference/acme-old" });
    s.references!.push({ repo: "acme/bad", at: "2026-11-15T10:00:00.000Z", ok: false, reason: "x" });
    expect((await check()).changed).toBe(false);
    expect(s.references![0]!.ok).toBe(true);
    expect(s.references!.at(-1)).toMatchObject({ ok: false, reason: "x" });
  });
});

describe("lockedTree", () => {
  it("is false for a missing folder", () => {
    expect(lockedTree(join(tmp, "nope"))).toBe(false);
  });
});
