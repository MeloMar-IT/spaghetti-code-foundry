import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GitTreeError, openGitTree, type GitTree } from "../src/skill-import/git-tree.js";
import { skillImportCommand } from "../src/skill-import/cli.js";
import type { TreeEntry } from "../src/skills/import-plan.js";
import { stageImport } from "../src/skills/import-stage.js";
import { killPids } from "./helpers/kill-pids.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

// Real git against local repositories: one bare remote, one SHA-256 repository. Eight fetches in all, so the file stays fast.

const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody ${extra}\n`;
const REPOSITORY = "https://github.com/example/skills";
const BOM_PATH = "﻿bom/SKILL.md";
const STUB = resolve(__dirname, "fixtures", "fake-skill-git.sh");
const CLI = resolve("dist/cli.js");

const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const GIT_ENV = {
  ...base,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, input, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] }).trim();

const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
  id: "lib",
  repository: REPOSITORY,
  repositoryKey: "github.com/example/skills",
  status: "enabled",
  ref: { approved: c1 },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
  ...over,
});

let fix: string; // fixture folder
let root: string; // private TMPDIR
let remote: string;
let sha256Repo: string;
let c1 = "";
let c2 = "";
let c256 = "";
let tree1 = "";
let zerosId = "";
let bomId = "";
let saved: string | undefined;
let shared: GitTree;
let sharedFolders: string[] = [];
const dirs: string[] = [];
const fresh = (p = "skill-import-git-") => {
  const d = mkdtempSync(join(fix, p));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  saved = process.env.TMPDIR;
  fix = realpathSync(mkdtempSync(join(tmpdir(), "skill-import-fixture-")));
  root = join(fix, "tmp");
  mkdirSync(root);
  const work = join(fix, "work");
  remote = join(fix, "remote.git");
  mkdirSync(work);
  git(work, ["init", "-q", "-b", "main"]);
  const put = (path: string, content: string | Buffer) => {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), content);
  };
  put("skills/a/SKILL.md", md("a"));
  put("skills/a/references/x/y.md", "yy\n");
  put("skills/b/SKILL.md", md("b"));
  put("skills/link/SKILL.md", md("link"));
  put("skills/sub/SKILL.md", md("sub"));
  put("skills/big/SKILL.md", md("big"));
  put("skills/big/zeros.bin", Buffer.alloc(300 * 1024));
  git(work, ["add", "-A"]);
  const target = git(work, ["hash-object", "-w", "--stdin"], "evil-target");
  git(work, ["update-index", "--add", "--cacheinfo", `120000,${target},skills/link/evil`]);
  git(work, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},skills/sub/mod`]);
  bomId = git(work, ["hash-object", "-w", "--stdin"], md("bom", "unique-bom-content"));
  git(work, ["update-index", "--add", "--cacheinfo", `100644,${bomId},${BOM_PATH}`]);
  git(work, ["commit", "-q", "-m", "one"]);
  c1 = git(work, ["rev-parse", "HEAD"]);
  tree1 = git(work, ["rev-parse", "HEAD^{tree}"]);
  zerosId = git(work, ["rev-parse", "HEAD:skills/big/zeros.bin"]);
  put("skills/a/SKILL.md", md("a", "second"));
  git(work, ["commit", "-q", "-am", "two"]);
  c2 = git(work, ["rev-parse", "HEAD"]);
  git(fix, ["init", "-q", "--bare", remote]);
  git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(work, ["push", "-q", remote, "main"]);

  sha256Repo = join(fix, "sha256");
  mkdirSync(sha256Repo);
  git(sha256Repo, ["init", "-q", "-b", "main", "--object-format=sha256"]);
  mkdirSync(join(sha256Repo, "skills/a"), { recursive: true });
  writeFileSync(join(sha256Repo, "skills/a/SKILL.md"), md("a"));
  git(sha256Repo, ["add", "-A"]);
  git(sha256Repo, ["commit", "-q", "-m", "one"]);
  git(sha256Repo, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  c256 = git(sha256Repo, ["rev-parse", "HEAD"]);

  process.env.TMPDIR = root;
  shared = await openGitTree({ repository: REPOSITORY }, c1, { remote, timeoutMs: 10_000 });
  sharedFolders = readdirSync(root);
}, 30_000);
afterAll(() => {
  shared?.close();
  if (saved === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved;
  rmSync(fix, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.TMPDIR = root;
});

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(d, e.name), ...walk(join(d, e.name))] : [join(d, e.name)]));
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitTreeError);
    return (e as GitTreeError).code;
  }
  return "no error";
};
const open = (commit: string, over: Record<string, unknown> = {}) => openGitTree({ repository: REPOSITORY }, commit, { remote, timeoutMs: 10_000, ...over });

describe("openGitTree with a shared tree", { timeout: 15_000, retry: 0 }, () => {
  it("holds one temporary folder with no working tree", () => {
    expect(sharedFolders).toHaveLength(1);
    const folder = join(root, sharedFolders[0]!);
    expect(sharedFolders[0]).toMatch(/^scf-skill-fetch-/);
    expect(walk(join(folder, "repo")).filter((p) => p.endsWith("SKILL.md"))).toEqual([]);
    expect(readdirSync(join(folder, "home"))).toEqual([]);
  });

  it("lists commit 1, not the tip", () => {
    const list = shared.list("skills");
    const a = list.find((e) => e.path === "skills/a/SKILL.md")!;
    expect(a).toMatchObject({ kind: "file", size: Buffer.byteLength(md("a")) });
    expect(list.map((e) => e.path)).toContain("skills/a/references/x/y.md");
    expect(c1).not.toBe(c2);
  });

  it("tells the kinds apart", () => {
    const list = shared.list("skills");
    expect(list.find((e) => e.path === "skills/link/evil")!.kind).toBe("symlink");
    const sub = list.find((e) => e.path === "skills/sub/mod")!;
    expect(sub.kind).toBe("submodule");
    expect(sub.size).toBeUndefined();
    expect(list.find((e) => e.path === "skills/big/zeros.bin")!.size).toBe(300 * 1024);
  });

  it("lists the whole tree with ., and nothing for a missing folder", () => {
    const all = shared.list(".");
    const paths = all.map((e) => e.path);
    for (const e of shared.list("skills")) expect(paths).toContain(e.path);
    expect(paths.some((p) => p.startsWith("﻿"))).toBe(true);
    expect(shared.list("nope")).toEqual([]);
  });

  it("reads exact bytes in order", () => {
    const list = shared.list("skills");
    const a = list.find((e) => e.path === "skills/a/SKILL.md")!;
    const b = list.find((e) => e.path === "skills/b/SKILL.md")!;
    expect(shared.read([b, a]).map((x) => Buffer.from(x).toString())).toEqual([md("b"), md("a")]);
    expect(shared.read([])).toEqual([]);
  });

  it("fails a read with a wrong size or a tree id", () => {
    const a = shared.list("skills").find((e) => e.path === "skills/a/SKILL.md")!;
    expect(() => shared.read([{ ...a, size: a.size! + 1 }])).toThrow(expect.objectContaining({ code: "read-failed" }));
    expect(() => shared.read([{ ...a, id: tree1 }])).toThrow(expect.objectContaining({ code: "read-failed" }));
  });

  it("stages through the real tree and never reads a rejected file", () => {
    const read: string[] = [];
    const wrapped = { list: (p: string) => shared.list(p), read: (es: readonly TreeEntry[]) => (read.push(...es.map((e) => e.id)), shared.read(es)) };
    const home = fresh();
    const r = stageImport(source(), wrapped, { home });
    expect(r.record.skills.map((s) => s.root)).toEqual(["skills/a", "skills/b"]);
    const why = (root: string) => r.record.rejected.find((x) => x.root === root)!.reasons.join(";");
    expect(why("skills/link")).toContain("a symbolic link");
    expect(why("skills/sub")).toContain("a submodule");
    expect(why("skills/big")).toContain("is larger than 262144 bytes");
    expect(read).not.toContain(zerosId);
    expect(readFileSync(join(r.dir, "files/skills/a/SKILL.md"), "utf8")).toBe(md("a"));
    expect(readFileSync(join(r.dir, "files/skills/a/references/x/y.md"), "utf8")).toBe("yy\n");
  });

  it("rejects a skill whose path starts with U+FEFF without reading it", () => {
    const read: string[] = [];
    const wrapped = { list: (p: string) => shared.list(p), read: (es: readonly TreeEntry[]) => (read.push(...es.map((e) => e.id)), shared.read(es)) };
    const home = fresh();
    const r = stageImport(source({ paths: ["."] }), wrapped, { home });
    expect(r.record.skills.map((s) => s.root)).not.toContain("﻿bom");
    expect(r.record.rejected.some((x) => x.root.includes("bom"))).toBe(true);
    expect(existsSync(join(r.dir, "files", "﻿bom"))).toBe(false);
    expect(readdirSync(join(r.dir, "files")).some((n) => n.includes("bom"))).toBe(false);
    expect(read).not.toContain(bomId);
  });
});

describe("openGitTree fetches", { timeout: 15_000, retry: 0 }, () => {
  it("fails for an unknown commit and cleans up", async () => {
    expect(["fetch-failed", "no-commit"]).toContain(await codeOf(open("0".repeat(40))));
    expect(readdirSync(root)).toEqual(sharedFolders);
  });

  it("fails when a tree id is used as the commit", async () => {
    expect(["fetch-failed", "no-commit"]).toContain(await codeOf(open(tree1)));
    expect(readdirSync(root)).toEqual(sharedFolders);
  });

  it("fails for a remote that does not exist", async () => {
    expect(await codeOf(open(c1, { remote: join(fix, "missing.git") }))).toBe("fetch-failed");
    expect(readdirSync(root)).toEqual(sharedFolders);
  });

  it("rejects a malformed commit without starting a process", async () => {
    expect(await codeOf(open("main"))).toBe("no-commit");
    expect(readdirSync(root)).toEqual(sharedFolders);
  });

  it("opens a SHA-256 repository", async () => {
    const t = await openGitTree({ repository: REPOSITORY }, c256, { remote: sha256Repo, timeoutMs: 10_000 });
    expect(c256).toHaveLength(64);
    const list = t.list("skills");
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toHaveLength(64);
    expect(Buffer.from(t.read(list)[0]!).toString()).toBe(md("a"));
    t.close();
    expect(readdirSync(root)).toEqual(sharedFolders);
  });
});

const manifest = (cwd: string, paths: string[]) =>
  writeFileSync(join(cwd, "skill-sources.yaml"), stringify({ schema: 1, sources: [{ id: "lib", repository: REPOSITORY, status: "enabled", ref: { track: "main", approved: c1 }, paths, adapter: "agent-skills", trust: "community", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "@example", review: { by: "@example", on: "2026-01-01", commit: c1, licence: "MIT" } }] }));

describe("skillImportCommand through the real tree", { timeout: 15_000, retry: 0 }, () => {
  it("stages two skills end to end", async () => {
    const cwd = fresh();
    const home = fresh();
    manifest(cwd, ["skills/a", "skills/b"]);
    const lines: string[] = [];
    const rc = await skillImportCommand({ positionals: ["lib"], values: {} }, (l) => lines.push(l), {
      cwd,
      home,
      remote,
      open: (s, c, o) => openGitTree(s, c, { ...o, timeoutMs: 10_000 }),
    });
    expect(lines.join("\n")).toMatch(/OK 2 skills staged from github\.com\/example\/skills@[0-9a-f]{12} sha256:[0-9a-f]{64} \(staged\)/);
    expect(rc).toBe(0);
    expect(existsSync(join(home, "skill-quarantine", "lib", c1, "import.json"))).toBe(true);
    expect(readdirSync(root)).toEqual(sharedFolders);
  });
});

describe("the built CLI and real signals", { timeout: 20_000, retry: 0 }, () => {
  const stubbed = (extra: Record<string, string>) => {
    const d = fresh("skill-import-cli-run-");
    const bin = join(d, "bin");
    mkdirSync(bin);
    copyFileSync(STUB, join(bin, "git"));
    chmodSync(join(bin, "git"), 0o755);
    const scfHome = join(d, "scf");
    const tmp = join(d, "tmp");
    const cwd = join(d, "cwd");
    mkdirSync(tmp);
    mkdirSync(cwd);
    manifest(cwd, ["skills/a", "skills/b"]);
    const pids = join(d, "pids");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(FACTORY_|SCF_|GIT_|STUB_)/.test(k)) env[k] = v;
    Object.assign(env, {
      PATH: `${bin}:${process.env.PATH}`,
      SCF_HOME: scfHome,
      TMPDIR: tmp,
      STUB_MODE: "redirect",
      STUB_REAL: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
      STUB_REMOTE: "file://" + remote,
      STUB_URL: REPOSITORY,
      STUB_PIDS: pids,
      ...extra,
    });
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`npm run build\` first`);
    const r = spawnSync(process.execPath, [CLI, "skills", "import", "lib"], { cwd, env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
    if (r.error) {
      if (existsSync(pids + ".all")) killPids(readFileSync(pids + ".all", "utf8"));
      throw r.error;
    }
    return { r, import: join(scfHome, "skill-quarantine", "lib", c1), tmp };
  };

  it("imports without a signal", () => {
    const { r, import: dir, tmp } = stubbed({});
    expect(r.stdout).toContain("OK 2 skills staged");
    expect(r.status).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it.each([
    ["SIGINT while listing", { STUB_ON: "ls-tree", STUB_SIGNAL: "INT" }],
    ["SIGTERM while reading", { STUB_ON: "cat-file", STUB_SIGNAL: "TERM" }],
  ])("%s stops the import and stages nothing", (_n, extra) => {
    const { r, import: dir, tmp } = stubbed(extra);
    expect(r.stdout).toContain("PROBLEM the import was interrupted; nothing was staged");
    expect(r.status).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
