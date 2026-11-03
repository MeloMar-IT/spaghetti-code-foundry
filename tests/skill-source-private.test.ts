import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GitTreeError, openGitTree, prepareAskpass, shellWord } from "../src/skill-import/git-tree.js";
import { skillImportCommand } from "../src/skill-import/cli.js";
import { LsRemoteError, resolveTrack } from "../src/skill-import/ls-remote.js";

// A private source: a stub in front of real git that, like a private https host, answers only to a credential given through
// GIT_ASKPASS. The remote is a local bare repository.

const STUB = join(__dirname, "fixtures", "fake-skill-git.sh");
const URL = "https://github.com/acme/skills";
const SECRET = "ghs_" + "Zq8Xw3Lm0Pa7Rt5Vb2Nc";
const CRED = { username: "x-access-token", password: SECRET };
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody ${name}\n`;
const sh = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" } }).trim();

let fix: string;
let root: string;
let saved: string | undefined;
let commit: string;
let env: NodeJS.ProcessEnv;
let secretFile: string;
let stubFiles: { args: string; env: string; pids: string };

beforeAll(() => {
  saved = process.env.TMPDIR;
  fix = realpathSync(mkdtempSync(join(tmpdir(), "skill-private-")));
  root = join(fix, "tmp");
  mkdirSync(root);
  const work = join(fix, "work");
  const remote = join(fix, "remote.git");
  mkdirSync(join(work, "skills/a"), { recursive: true });
  mkdirSync(join(work, "skills/example-skill"), { recursive: true });
  writeFileSync(join(work, "skills/a/SKILL.md"), md("a"));
  writeFileSync(join(work, "skills/example-skill/SKILL.md"), md("example-skill"));
  sh(work, ["init", "-q", "-b", "main"]);
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-q", "-m", "one"]);
  commit = sh(work, ["rev-parse", "HEAD"]);
  sh(fix, ["init", "-q", "--bare", remote]);
  sh(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  sh(work, ["push", "-q", remote, "main"]);

  const bin = join(fix, "bin");
  mkdirSync(bin);
  copyFileSync(STUB, join(bin, "git"));
  chmodSync(join(bin, "git"), 0o755);
  secretFile = join(fix, "secret");
  writeFileSync(secretFile, SECRET + "\n");
  stubFiles = { args: join(fix, "args"), env: join(fix, "env"), pids: join(fix, "pids") };
  env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(FACTORY_|SCF_|GIT_|STUB_)/.test(k)) env[k] = v;
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    STUB_MODE: "redirect",
    STUB_REAL: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    STUB_REMOTE: "file://" + remote,
    STUB_URL: URL,
    STUB_SECRET_FILE: secretFile,
    STUB_ARGS: stubFiles.args,
    STUB_ENV: stubFiles.env,
    STUB_PIDS: stubFiles.pids,
  });
});
afterAll(() => {
  if (saved === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved;
  rmSync(fix, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.TMPDIR = root;
  for (const f of Object.values(stubFiles)) rmSync(f, { force: true });
});

const source = { repository: URL };
const filesBelow = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesBelow(join(dir, e.name)) : [join(dir, e.name)]));
const holdsSecret = (dir: string) => filesBelow(dir).some((f) => readFileSync(f).includes(SECRET));
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsOf = () => readFileSync(stubFiles.pids, "utf8").trim().split(" ").map(Number);

describe("openGitTree with a credential", () => {
  it("fails without one, and with a wrong one", async () => {
    await expect(openGitTree(source, commit, { env })).rejects.toMatchObject({ code: "fetch-failed" });
    await expect(openGitTree(source, commit, { env, credential: { ...CRED, password: "wrong" } })).rejects.toMatchObject({ code: "fetch-failed" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("works with the right one and leaves the secret nowhere", async () => {
    const tree = await openGitTree(source, commit, { env, credential: CRED });
    try {
      expect(tree.list("skills").map((e) => e.path)).toContain("skills/a/SKILL.md");
      const args = readFileSync(stubFiles.args, "utf8");
      const seen = readFileSync(stubFiles.env, "utf8");
      expect(args).not.toContain(SECRET);
      expect(seen).not.toContain(SECRET);
      expect(seen).toMatch(/^GIT_ASKPASS='.*askpass'$/m);
      expect(args).toContain("credential.helper=");
      expect(args).toContain("http.followRedirects=false");
      expect(holdsSecret(root)).toBe(false);
    } finally {
      tree.close();
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it("gives git no askpass when the source has no access", async () => {
    // with no STUB_SECRET_FILE the stub does not ask for a credential, so the fetch works plain
    const tree = await openGitTree(source, commit, { env: { ...env, STUB_SECRET_FILE: "" } });
    tree.close();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("resolveTrack with a credential", () => {
  it("answers with the right one and not without", async () => {
    await expect(resolveTrack(URL, "main", { env, credential: CRED })).resolves.toEqual({ commit });
    expect(readFileSync(stubFiles.args, "utf8")).not.toContain(SECRET);
    expect(readFileSync(stubFiles.env, "utf8")).not.toContain(SECRET);
    await expect(resolveTrack(URL, "main", { env })).rejects.toEqual(expect.objectContaining({ code: "unreachable" }));
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("a temporary folder with spaces, non-ASCII characters and quotes", () => {
  it("fetches and resolves a private source", async () => {
    const odd = join(fix, "odd tmp é ü 'q'");
    mkdirSync(odd);
    process.env.TMPDIR = odd;
    try {
      const tree = await openGitTree(source, commit, { env, credential: CRED });
      try {
        expect(tree.list("skills").map((e) => e.path)).toContain("skills/a/SKILL.md");
      } finally {
        tree.close();
      }
      await expect(resolveTrack(URL, "main", { env, credential: CRED })).resolves.toEqual({ commit });
      expect(readdirSync(odd)).toEqual([]);
    } finally {
      process.env.TMPDIR = root;
    }
  });
});

describe("prepareAskpass", () => {
  it("writes a 0600 token in a 0700 folder, and removes it", () => {
    const tmp = mkdtempSync(join(root, "x-"));
    const a = prepareAskpass(tmp, CRED);
    expect(statSync(join(tmp, "access")).mode & 0o777).toBe(0o700);
    expect(statSync(join(tmp, "access", "token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, "access", "askpass")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(tmp, "access", "askpass"), "utf8")).not.toContain(SECRET);
    expect(a.env.GIT_ASKPASS).toBe(shellWord(join(tmp, "access", "askpass")));
    expect(Object.values(a.env).join("")).not.toContain(SECRET);
    a.remove();
    a.remove();
    expect(existsSync(join(tmp, "access"))).toBe(false);
    rmSync(tmp, { recursive: true });
  });

  it("refuses a bad credential or an unwritable folder with a fixed error and leaves nothing", () => {
    const tmp = mkdtempSync(join(root, "x-"));
    for (const c of [{ ...CRED, password: "a\nb" }, { ...CRED, username: "other" }, { ...CRED, password: "" }]) {
      expect(() => prepareAskpass(tmp, c)).toThrowError(expect.objectContaining({ code: "fetch-failed" }));
      expect(existsSync(join(tmp, "access"))).toBe(false);
    }
    expect(() => prepareAskpass(join(tmp, "missing"), CRED)).toThrowError(GitTreeError);
    expect(existsSync(join(tmp, "missing"))).toBe(false);
    rmSync(tmp, { recursive: true });
  });
});

describe("failure paths with a credential", () => {
  it("a fetch that hangs: the files are private while it runs, and gone after an abort", async () => {
    const hang = { ...env, STUB_HANG: "1" };
    const ctl = new AbortController();
    const p = openGitTree(source, commit, { env: hang, credential: CRED, signal: ctl.signal });
    const settled = p.then(() => undefined, (e: unknown) => e);
    await until(() => existsSync(stubFiles.pids));
    const [pid, sleeper] = pidsOf() as [number, number];
    const folder = join(root, readdirSync(root)[0]!, "access");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "token")).mode & 0o777).toBe(0o600);
    ctl.abort();
    const e = await settled;
    expect(e).toBeInstanceOf(GitTreeError);
    expect((e as GitTreeError).code).toBe("interrupted");
    await until(() => !alive(pid) && !alive(sleeper));
    expect(readdirSync(root)).toEqual([]);
  });

  it("a fetch that hangs ends with a timeout and leaves nothing", async () => {
    await expect(openGitTree(source, commit, { env: { ...env, STUB_HANG: "1" }, credential: CRED, timeoutMs: 400 })).rejects.toMatchObject({ code: "timeout" });
    const [pid, sleeper] = pidsOf() as [number, number];
    await until(() => !alive(pid) && !alive(sleeper));
    expect(readdirSync(root)).toEqual([]);
  });

  it("an ls-remote that hangs ends with a timeout or an abort and leaves nothing", async () => {
    const hang = { ...env, STUB_HANG: "1" };
    await expect(resolveTrack(URL, "main", { env: hang, credential: CRED, timeoutMs: 400 })).rejects.toEqual(expect.objectContaining({ code: "timeout" }));
    await until(() => !alive(pidsOf()[1]!));
    expect(readdirSync(root)).toEqual([]);

    rmSync(stubFiles.pids);
    const ctl = new AbortController();
    const settled = resolveTrack(URL, "main", { env: hang, credential: CRED, signal: ctl.signal }).then(() => undefined, (e: unknown) => e);
    await until(() => existsSync(stubFiles.pids));
    ctl.abort();
    const e = await settled;
    expect(e).toBeInstanceOf(LsRemoteError);
    expect((e as LsRemoteError).code).toBe("interrupted");
    await until(() => !alive(pidsOf()[1]!));
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("scf skills import of a private source", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "acme-skills",
    repository: URL,
    status: "enabled",
    ref: { track: "main", approved: commit },
    paths: ["skills"],
    exclude: ["skills/example-skill"],
    adapter: "agent-skills",
    trust: "first-party",
    licence: { allow: ["MIT"] },
    update: { cadence: "daily" },
    access: { repo: "acme/skills" },
    owner: "@octocat",
    ...over,
  });
  const setup = (e: Record<string, unknown>) => {
    const d = mkdtempSync(join(fix, "cwd-"));
    writeFileSync(join(d, "skill-sources.yaml"), stringify({ schema: 1, sources: [e] }));
    return d;
  };
  const run = async (e: Record<string, unknown>, access: (() => Promise<unknown>) | undefined, open?: typeof openGitTree) => {
    const cwd = setup(e);
    const lines: string[] = [];
    const code = await skillImportCommand({ positionals: ["acme-skills"], values: {} }, (l) => lines.push(l), {
      cwd,
      home: join(cwd, "home"),
      env,
      ...(access ? { access: access as never } : {}),
      ...(open ? { open } : {}),
    });
    return { code, lines };
  };

  it("stages the skills with the access, once, and leaves the excluded folder out", async () => {
    let calls = 0;
    const r = await run(entry(), async () => (calls++, { ok: true, credential: CRED }));
    expect(r.lines.join("\n")).toMatch(/^skills\/a /m);
    expect(r.lines.some((l) => l.startsWith("OK 1 skills staged"))).toBe(true);
    expect(r.lines.join("\n")).not.toContain("example-skill");
    expect(r.lines.join("\n")).not.toContain(SECRET);
    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    expect(holdsSecret(root)).toBe(false);
  });

  it("ends with one PROBLEM line and no git call when the access cannot be made", async () => {
    let opened = 0;
    const r = await run(entry(), async () => ({ ok: false, problem: "a fixed sentence" }), (async () => (opened++, undefined as never)) as never);
    expect(r.lines).toEqual(["PROBLEM a fixed sentence"]);
    expect(r.code).toBe(1);
    expect(opened).toBe(0);
    expect(existsSync(stubFiles.args)).toBe(false);
  });

  it("fetches a source without access exactly as before: no askpass", async () => {
    const e = { ...entry(), access: undefined };
    const r = await run(e, undefined, ((s: never, c: string, o: Record<string, unknown>) => {
      expect(Object.keys(o).sort()).toEqual(["env", "remote", "signal"]);
      return openGitTree(s, c, { ...o, env: { ...env, STUB_SECRET_FILE: "" } });
    }) as never);
    expect(r.code).toBe(0);
  });
});
