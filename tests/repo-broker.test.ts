import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { NO_COMMIT_IDENTITY, TOKEN_REFUSED_RUN } from "../src/engine/guards.js";
import type { Engine, Scope } from "../src/engine/execute.js";
import { RunPolicy } from "../src/engine/policy-hooks.js";
import { APP_PERMISSIONS, brokerRequest, type BrokerContext, type BrokerExec, type ExecResult, type RepoGrant } from "../src/engine/repo-broker.js";
import { REPO_OPERATIONS, RepoRequestSchema, tailBytes, unsafeGitSettings, validBranchName } from "../src/engine/repo-request.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../src/policy/baseline.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import { closeEvidenceStream } from "../src/evidence/stream.js";
import { GitIdentitySchema } from "../src/evidence/identity.js";
import { runRecorder } from "../src/evidence/record.js";
import { clearTokenCache } from "../src/github-app.js";
import { fakeGithubApp, type FakeGithubApp } from "./helpers/github-app.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const BOT_TOKEN = ["ghp", ""].join("_") + "Bot7".repeat(9);
const STEP = { id: "work", visit: 1, type: "shell" } as const;

let tmp: string;
let kc: FakeKeychain;
let app: FakeGithubApp;
let admin: { id: string };
let user: { id: string };
let n = 0;

// Users, keychain and the fake App are made once (creating a user is slow); every test starts with no repositories.
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "repo-broker-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  app = fakeGithubApp();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
beforeEach(() => {
  app.installs.set("acme/app", 77);
  app.calls.length = 0;
  app.tokens.length = 0;
  app.force = {};
  clearTokenCache();
  rmSync(reposPath(), { force: true });
});
const runDirs: string[] = [];
afterEach(() => {
  for (const d of runDirs.splice(0)) closeEvidenceStream(d);
  delete process.env.BROKER_BOT_TOKEN;
});
afterAll(() => {
  app.restore();
  kc.remove();
  rmSync(tmp, { recursive: true, force: true });
});

const grant = (over: Partial<RepoGrant> = {}, kind: "git" | "github" = "git"): RepoGrant =>
  ({
    kind,
    operations: kind === "git" ? ["status", "clone", "fetch", "branch", "commit", "push"] : ["pull-request.write"],
    targets: ["acme/app"],
    dataClassification: "internal",
    credential: "repository",
    timeoutMs: 60_000,
    maxConcurrent: null,
    outputCapBytes: 20_000,
    approval: "none",
    ...over,
  }) as RepoGrant;
const prGrant = (over: Partial<RepoGrant> = {}) => grant(over, "github");

interface Call {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  stdin?: string;
  cleanEnv: boolean;
  ownGroup: boolean;
  signal?: AbortSignal;
  cwd: string;
  pinnedSecrets?: string[];
  ghEmpty: boolean;
}
type Script = (c: Call, i: number) => Partial<ExecResult> | Error | undefined;

function fakeExec(script: Script = () => undefined, listing = "core.bare\nfalse\0") {
  const calls: Call[] = [];
  const exec: BrokerExec = async (cmd, args, o) => {
    const dir = o.env.GH_CONFIG_DIR;
    const call: Call = { cmd, args, ...o, ghEmpty: Boolean(dir && existsSync(dir) && readdirSync(dir).length === 0) };
    calls.push(call);
    const own = script(call, calls.length - 1);
    if (own instanceof Error) throw own;
    if (own) return { exitCode: 0, stdout: "", stderr: "", ...own };
    if (args[0] === "config") return { exitCode: 0, stdout: listing, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, exec, ops: () => calls.filter((c) => c.args[0] !== "config") };
}

interface Rig {
  ctx: BrokerContext;
  engine: Engine;
  runDir: string;
  workdir: string;
  events: () => Record<string, unknown>[];
  abort: () => void;
  logs: string[];
}
function rig(over: { owner?: string; config?: object; vars?: Record<string, string>; policy?: RunPolicy; exec?: BrokerExec; workdir?: string } = {}): Rig {
  const id = `r${++n}`;
  const runDir = join(tmp, id);
  const workdir = over.workdir ?? join(tmp, `${id}-work`);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  runDirs.push(runDir);
  const vars = over.vars ?? { github_repo: "acme/app" };
  const logs: string[] = [];
  const ac = new AbortController();
  const evidence = runRecorder({ runDir, runId: id, vars });
  const engine = {
    summary: { owner: over.owner ?? admin.id, workdir, runDir, vars },
    config: ConfigSchema.parse({ protected_branches: [], bot: { name: "Bot", email: "bot@example.com", gh_token_env: "BROKER_BOT_TOKEN" }, ...over.config }),
    baseEnv: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/hooks" },
    signal: ac.signal,
    log: (l: string) => logs.push(l),
    evidence,
    ...(over.policy ? { policy: over.policy } : {}),
  } as unknown as Engine;
  const scope = { flow: { name: "f", steps: [] }, ctx: { vars, steps: {}, run: {} }, visits: {}, prefix: "", depth: 0 } as unknown as Scope;
  const ctx: BrokerContext = { engine, scope, step: STEP, logFile: join(runDir, "broker.log"), ...(over.exec ? { exec: over.exec } : {}) };
  const events = () => {
    const file = join(runDir, "evidence.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l) as unknown as Record<string, unknown>)
      : [];
  };
  return { ctx, engine, runDir, workdir, events, abort: () => ac.abort(), logs };
}
const repoEvents = (r: Rig) => r.events().filter((e) => e.type === "repo.operation");
const tokenRepo = (owner: { id: string }) => addRepo(owner.id, { url: "acme/app", method: "github-token", token: TOKEN });

describe("the request", () => {
  it("accepts a valid request of every operation and refuses a field it does not know", () => {
    const valid = [
      { op: "clone" },
      { op: "fetch" },
      { op: "fetch", branch: "main" },
      { op: "branch", name: "feat/x", from: "main" },
      { op: "commit", message: "msg" },
      { op: "push", branch: "feat/x" },
      { op: "pull-request", head: "feat/x", base: "main", title: "T", body: "B", draft: true },
      { op: "status" },
    ];
    expect(new Set(valid.map((v) => v.op))).toEqual(new Set(REPO_OPERATIONS));
    for (const v of valid) {
      expect(RepoRequestSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
      for (const extra of ["repo", "url", "remote", "other"]) expect(RepoRequestSchema.safeParse({ ...v, [extra]: "x" }).success, `${v.op} ${extra}`).toBe(false);
    }
    expect(RepoRequestSchema.safeParse({ op: "delete" }).success).toBe(false);
  });

  it("refuses the branch names git refuses", () => {
    const bad = ["-x", "/x", "a..b", "a@{1}", "a b", "a\tb", "a b", "a\u0085b", "x".repeat(256), "a.lock", ".a", "a/", "*", "HEAD", "a//b", "a~b", "a:b", "a\\b", "a\0b", ""];
    for (const b of bad) expect(validBranchName(b), JSON.stringify(b)).toBe(false);
  });

  it("only accepts branch names that evidence can hold", () => {
    for (const b of ["feat/x", "a-b_c.1", "ü/ß", "x".repeat(255), "release/1.2"]) {
      expect(validBranchName(b), b).toBe(true);
      expect(GitIdentitySchema.shape.branch.safeParse(b).success, b).toBe(true);
    }
  });

  it("limits messages, bodies and titles", () => {
    const commit = (message: string) => RepoRequestSchema.safeParse({ op: "commit", message }).success;
    expect([commit(""), commit("x".repeat(5001)), commit("a\0b"), commit("x".repeat(5000)), commit("two\nlines")]).toEqual([false, false, false, true, true]);
    const pr = (title: string, body?: string) => RepoRequestSchema.safeParse({ op: "pull-request", head: "a", base: "b", title, ...(body !== undefined ? { body } : {}) }).success;
    expect([pr("a\nb"), pr("x".repeat(257)), pr(""), pr("x".repeat(256)), pr("t", ""), pr("t", "b\0")]).toEqual([false, false, false, true, false, false]);
  });

  it("cuts text to bytes, never in the middle of a character", () => {
    expect(tailBytes("abc", 0)).toBe("");
    expect(tailBytes("é".repeat(10), 5)).toBe("éé");
    expect(tailBytes("short", 100)).toBe("short");
    expect(tailBytes("a😀b", 4)).toBe("b");
    expect(tailBytes("a😀b", 5)).toBe("😀b");
  });

  it("finds the git settings that are not allowed", () => {
    const list = (...keys: string[]) => keys.map((k) => `${k}\nv`).join("\0") + "\0";
    expect(unsafeGitSettings(list("core.bare", "remote.origin.url", "remote.origin.fetch", "branch.main.remote", "branch.a/b.merge", "user.name", "user.email"))).toEqual([]);
    expect(unsafeGitSettings(list("http.proxy", "include.path", "url.x.insteadof", "core.fsmonitor", "core.bare", "filter.a.clean", "core.hookspath", "remote.evil.url"))).toEqual([
      "http.proxy", "include.path", "url.x.insteadof", "core.fsmonitor", "filter.a.clean", "core.hookspath", "remote.evil.url",
    ]);
  });
});

describe("the target", () => {
  it("refuses a request that names a repository, URL or remote, and starts nothing", async () => {
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    for (const extra of ["repo", "url", "remote"]) {
      const res = await brokerRequest(r.ctx, { op: "push", branch: "x", [extra]: "evil/repo" }, grant());
      expect(res).toMatchObject({ outcome: "refused", refusal: "invalid-request" });
    }
    expect(f.calls).toEqual([]);
    expect(repoEvents(r).map((e) => [e.operation, e.refusal, e.credential])).toEqual([["push", "invalid-request", "none"], ["push", "invalid-request", "none"], ["push", "invalid-request", "none"]]);
  });

  it("records a request with no known operation as unknown, without keeping any of it", async () => {
    const r = rig({ exec: fakeExec().exec });
    expect(await brokerRequest(r.ctx, { op: "rm", secret: "ghp_notforevidence" }, grant())).toMatchObject({ outcome: "refused", refusal: "invalid-request" });
    expect(await brokerRequest(r.ctx, null, grant())).toMatchObject({ refusal: "invalid-request" });
    expect(repoEvents(r).map((e) => [e.operation, e.outcome, e.refusal, e.credential])).toEqual([
      ["unknown", "refused", "invalid-request", "none"],
      ["unknown", "refused", "invalid-request", "none"],
    ]);
    expect(JSON.stringify(r.events())).not.toContain("notforevidence");
    expect(r.logs.length).toBe(2);
  });

  it("refuses a missing, placeholder or wildcard repository, and asks GitHub for no token", async () => {
    app.installs.set("acme/app", 77);
    for (const repo of [undefined, "owner/repo", "*", "a*/b", "bad name", "acme", "acme/app/extra"]) {
      const f = fakeExec();
      const r = rig({ vars: repo === undefined ? {} : { github_repo: repo }, exec: f.exec, config: { github_app: { ...app.config(), installation_id: "77" } } });
      const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant({ credential: "machine", targets: ["*"] }));
      expect(res, String(repo)).toMatchObject({ outcome: "refused", refusal: "no-target" });
      expect(f.calls, String(repo)).toEqual([]);
      expect(repoEvents(r)[0], String(repo)).toMatchObject({ refusal: "no-target", credential: "none" });
      expect(repoEvents(r)[0]!.repository).toBeUndefined();
    }
    expect(app.calls).toEqual([]);
  });
});

describe("the commands", () => {
  it("runs each operation with the exact argument list", async () => {
    tokenRepo(admin);
    const url = "https://github.com/acme/app"; // the address the repository was stored with
    const f = fakeExec();
    const r = rig({ exec: f.exec, workdir: join(tmp, "empty-work") });
    const go = (req: object, g: RepoGrant = grant()) => brokerRequest(r.ctx, req, g);
    expect(await go({ op: "clone" })).toMatchObject({ outcome: "done" });
    expect(f.ops().map((c) => [c.cmd, ...c.args])).toEqual([["git", "clone", "-q", "--", url, "."]]);
    f.calls.length = 0;
    await go({ op: "fetch" });
    await go({ op: "fetch", branch: "main" });
    await go({ op: "push", branch: "feat/x" });
    await go({ op: "pull-request", head: "feat/x", base: "main", title: "-x title", body: "the body", draft: true });
    await go({ op: "pull-request", head: "feat/x", base: "main", title: "T" }, prGrant());
    await go({ op: "branch", name: "feat", from: "main" });
    await go({ op: "branch", name: "feat" });
    await go({ op: "status" });
    const ops = f.ops();
    expect(ops.map((c) => [c.cmd, ...c.args])).toEqual([
      ["git", "fetch", "--no-tags", "--no-recurse-submodules", "--", url, "+refs/heads/*:refs/remotes/origin/*"],
      ["git", "fetch", "--no-tags", "--no-recurse-submodules", "--", url, "+refs/heads/main:refs/remotes/origin/main"],
      ["git", "push", "--recurse-submodules=no", "--", url, "HEAD:refs/heads/feat/x"],
      ["gh", "pr", "create", "--repo=acme/app", "--head=feat/x", "--base=main", "--title=T", "--body-file", "-"],
      ["git", "checkout", "-q", "-B", "feat", "origin/main"],
      ["git", "checkout", "-q", "-B", "feat"],
      ["git", "status", "--porcelain=v1", "--branch"],
    ]);
    expect(f.calls.filter((c) => c.cmd === "gh")).toHaveLength(1); // only the one made with the github grant
  });

  it("makes the pull request with the body on stdin and reads its address", async () => {
    tokenRepo(admin);
    const f = fakeExec((c) => (c.cmd === "gh" ? { stdout: "Creating pull request...\nhttps://github.com/acme/app/pull/12\n" } : undefined));
    const r = rig({ exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "pull-request", head: "feat/x", base: "main", title: "-x title", body: "the body", draft: true }, prGrant());
    const gh = f.calls.find((c) => c.cmd === "gh")!;
    expect(gh.args).toEqual(["pr", "create", "--repo=acme/app", "--head=feat/x", "--base=main", "--title=-x title", "--body-file", "-", "--draft"]);
    expect(gh.stdin).toBe("the body");
    expect(res.pullRequest).toEqual({ repository: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12" });
    expect(repoEvents(r)[0]).toMatchObject({ operation: "pull-request", outcome: "done", pullRequest: { number: 12 } });
    await brokerRequest(r.ctx, { op: "pull-request", head: "a", base: "b", title: "T" }, prGrant());
    expect(f.calls.filter((c) => c.cmd === "gh").at(-1)!.args).not.toContain("--draft");
    expect(f.calls.filter((c) => c.cmd === "gh").at(-1)!.stdin).toBe("");
  });

  it("lists the git settings first, with the machine's settings switched off", async () => {
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    await brokerRequest(r.ctx, { op: "status" }, grant());
    expect(f.calls[0]!.args).toEqual(["config", "--list", "--null", "--no-includes"]);
    expect(f.calls[0]!.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" });
    expect(f.calls[1]!.args[0]).toBe("status");
  });

  it("runs a commit as add, diff and commit, and stops at the first failure", async () => {
    const seq = async (script: Script) => {
      const f = fakeExec(script);
      const r = rig({ exec: f.exec });
      const res = await brokerRequest(r.ctx, { op: "commit", message: "the message" }, grant());
      return { res, args: f.ops().map((c) => c.args.join(" ")), r };
    };
    const full = await seq((c) => (c.args[0] === "diff" ? { exitCode: 1 } : undefined));
    expect(full.args).toEqual(["add -A", "diff --cached --quiet", "commit -q --no-gpg-sign -m the message"]);
    expect(full.res.outcome).toBe("done");
    const nothing = await seq(() => undefined);
    expect(nothing.args).toEqual(["add -A", "diff --cached --quiet"]);
    expect(nothing.res).toMatchObject({ outcome: "done", output: "nothing to commit" });
    const noAdd = await seq((c) => (c.args[0] === "add" ? { exitCode: 128, stderr: "fatal" } : undefined));
    expect(noAdd.args).toEqual(["add -A"]);
    expect(noAdd.res.outcome).toBe("failed");
    for (const bad of [{ exitCode: 128 }, { exitCode: null }, { timedOut: true, exitCode: null }, { aborted: true, exitCode: null }]) {
      const out = await seq((c) => (c.args[0] === "diff" ? bad : undefined));
      expect(out.args, JSON.stringify(bad)).toEqual(["add -A", "diff --cached --quiet"]);
      expect(out.res.outcome, JSON.stringify(bad)).toBe("failed");
    }
  });

  it("starts every process in its own group with the run's signal", async () => {
    tokenRepo(admin);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(f.calls.length).toBeGreaterThan(1);
    for (const c of f.calls) {
      expect(c.ownGroup).toBe(true);
      expect(c.signal).toBe(r.engine.signal);
    }
  });

  it("clones only into an empty folder", async () => {
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    writeFileSync(join(r.workdir, "file"), "x");
    expect(await brokerRequest(r.ctx, { op: "clone" }, grant({ credential: "none" }))).toMatchObject({ outcome: "refused", refusal: "not-empty" });
    expect(f.calls).toEqual([]);
  });
});

describe("the environment", () => {
  it("speaks https only, never prompts, and gives gh an empty settings folder that is removed", async () => {
    tokenRepo(admin);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    const c = f.ops()[0]!;
    expect(c.env).toMatchObject({ GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" });
    expect(c.ghEmpty).toBe(true);
    expect(existsSync(c.env.GH_CONFIG_DIR!)).toBe(false);
    expect(c.env.FACTORY_PUSH_LOG).toBeUndefined();
  });

  it("keeps the engine's hooks first and adds the helper after them", async () => {
    tokenRepo(admin);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    const env = f.ops()[0]!.env;
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(["core.hooksPath", "/hooks"]);
    const entries = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
    expect(entries.slice(0, 2)).toEqual(["core.hooksPath=/hooks", "user.useConfigOnly=true"]);
    expect(entries.findIndex((e) => e.startsWith("credential.helper="))).toBeGreaterThan(1);
    expect(env.SCF_GIT_PASSWORD).toBe(TOKEN);
    expect(env.GH_TOKEN).toBe(TOKEN);
  });

  it("adds no helper without a credential, and blocks the repository's own hooks without the engine's", async () => {
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    (r.engine as { baseEnv: Record<string, string> }).baseEnv = {};
    await brokerRequest(r.ctx, { op: "fetch" }, grant({ credential: "none" }));
    const env = f.ops()[0]!.env;
    const entries = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(entries).toContainEqual(["core.hooksPath", "/dev/null"]);
    expect(entries).toContainEqual(["credential.helper", ""]);
    expect(env.SCF_GIT_PASSWORD).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(f.ops()[0]!.ghEmpty).toBe(true);
  });

  it("uses the bot's name for a run that is not isolated, and the owner's for an isolated one", async () => {
    const ident = async (over: Parameters<typeof rig>[0], bot?: object) => {
      const f = fakeExec((c) => (c.args[0] === "diff" ? { exitCode: 1 } : undefined));
      const r = rig({ exec: f.exec, ...over, config: { ...(bot ? { bot } : {}), ...over.config } });
      const res = await brokerRequest(r.ctx, { op: "commit", message: "m" }, grant());
      return { res, env: f.ops().at(-1)!.env, f };
    };
    const admin1 = await ident({ owner: admin.id });
    expect(admin1.env).toMatchObject({ GIT_AUTHOR_NAME: "Bot", GIT_COMMITTER_EMAIL: "bot@example.com", GIT_CONFIG_COUNT: expect.any(String) });
    tokenRepo(user);
    const userBot = await ident({ owner: user.id }, { name: "Bot2", email: "bot2@example.com" });
    expect(userBot.env).toMatchObject({ GIT_AUTHOR_NAME: "Bot2", GIT_AUTHOR_EMAIL: "bot2@example.com" });
    const userOwn = await ident({ owner: user.id }, { name: "", email: "" });
    expect(userOwn.env).toMatchObject({ GIT_AUTHOR_NAME: "User", GIT_COMMITTER_EMAIL: "user@example.com" });
  });

  it("fails an isolated commit with no name for the commit, and runs nothing", async () => {
    tokenRepo(user);
    const f = fakeExec();
    const r = rig({ owner: "unknown-owner", exec: f.exec, config: { bot: { name: "", email: "" } } });
    const res = await brokerRequest(r.ctx, { op: "commit", message: "m" }, grant());
    expect(res).toMatchObject({ outcome: "failed", output: NO_COMMIT_IDENTITY });
    expect(f.ops()).toEqual([]);
    expect(repoEvents(r)[0]).toMatchObject({ outcome: "failed" });
    expect(repoEvents(r)[0]!.refusal).toBeUndefined();
  });

  it("needs a name only for a commit: a branch, a push and a pull request go on without one", async () => {
    const run = async (req: object, g: RepoGrant) => {
      const f = fakeExec();
      const r = rig({ owner: "unknown-owner", exec: f.exec, config: { bot: { name: "", email: "" } } });
      const res = await brokerRequest(r.ctx, req, g);
      return { res, env: f.ops()[0]?.env };
    };
    for (const [req, g] of [
      [{ op: "branch", name: "feat" }, grant()],
      [{ op: "push", branch: "feat" }, grant({ credential: "none" })],
      [{ op: "pull-request", head: "feat", base: "main", title: "T" }, prGrant({ credential: "none" })],
    ] as [object, RepoGrant][]) {
      const { res, env } = await run(req, g);
      expect(res.outcome, JSON.stringify(req)).toBe("done");
      expect(env?.GIT_AUTHOR_NAME).toBeUndefined();
    }
  });

  it("uses the stored address of the repository, not the default one", async () => {
    addRepo(admin.id, { url: "https://github.com/Acme/App.git", method: "github-token", token: TOKEN });
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(f.ops()[0]!.args).toContain("https://github.com/Acme/App.git");
    expect(f.ops()[0]!.env.SCF_REPO_URL).toBe("https://github.com/Acme/App.git");
  });

  it("gives a user's run the short environment", async () => {
    tokenRepo(user);
    const f = fakeExec();
    const r = rig({ owner: user.id, exec: f.exec });
    await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(f.calls.length).toBeGreaterThan(1);
    for (const c of f.calls) expect(c.cleanEnv).toBe(true);
    const admin2 = fakeExec();
    await brokerRequest(rig({ exec: admin2.exec }).ctx, { op: "status" }, grant());
    for (const c of admin2.calls) expect(c.cleanEnv).toBe(false);
  });
});

describe("the refusals", () => {
  const expectRefused = (r: Rig, f: ReturnType<typeof fakeExec>, res: { outcome: string; refusal?: string }, refusal: string) => {
    expect(res).toMatchObject({ outcome: "refused", refusal });
    expect(f.ops()).toEqual([]);
    expect(repoEvents(r)).toHaveLength(1);
    expect(repoEvents(r)[0]).toMatchObject({ outcome: "refused", refusal });
  };

  it("refuses what the profile does not grant, and records a denial", async () => {
    tokenRepo(admin);
    const cases: [string, RepoGrant | undefined][] = [
      ["no grant", undefined],
      ["wrong kind", prGrant()],
      ["operation not granted", grant({ operations: ["status"] })],
      ["target not covered", grant({ targets: ["other/repo"] })],
    ];
    for (const [name, g] of cases) {
      const f = fakeExec();
      const r = rig({ exec: f.exec });
      const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, g);
      expectRefused(r, f, res, "not-in-profile");
      expect(r.events().find((e) => e.type === "step.denied"), name).toMatchObject({ denial: { kind: "tool", tool: { name: "git.push" } } });
    }
  });

  it("refuses an operation that needs approval", async () => {
    tokenRepo(admin);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant({ approval: "required" }));
    expectRefused(r, f, res, "approval-required");
    expect(r.events().find((e) => e.type === "step.denied")).toMatchObject({ denial: { kind: "tool", tool: { name: "git.push" } } });
  });

  it("refuses a deploy key", async () => {
    addRepo(admin.id, { url: "git@github.com:acme/app.git", method: "ssh-deploy-key", key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n" } as never);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "fetch" }, grant({ credential: "machine" }));
    expectRefused(r, f, res, "deploy-key");
  });

  it("refuses a user's run with nothing stored, even with a machine grant and a bot", async () => {
    process.env.BROKER_BOT_TOKEN = BOT_TOKEN;
    const f = fakeExec();
    const r = rig({ owner: user.id, exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant({ credential: "machine" }));
    expectRefused(r, f, res, "no-credential");
    const g = fakeExec();
    const r2 = rig({ owner: user.id, exec: g.exec });
    expectRefused(r2, g, await brokerRequest(r2.ctx, { op: "push", branch: "x" }, grant()), "no-credential");
  });

  it("refuses git settings that could redirect git or read a token", async () => {
    for (const key of ["http.proxy", "include.path", "url.x.insteadof", "core.fsmonitor", "filter.a.clean"]) {
      const f = fakeExec(undefined, `core.bare\nfalse\0${key}\nvalue\0`);
      const r = rig({ exec: f.exec });
      const res = await brokerRequest(r.ctx, { op: "status" }, grant());
      expectRefused(r, f, res, "unsafe-git-settings");
    }
    const f = fakeExec((c) => (c.args[0] === "config" ? { exitCode: 128 } : undefined));
    const r = rig({ exec: f.exec });
    expectRefused(r, f, await brokerRequest(r.ctx, { op: "status" }, grant()), "unsafe-git-settings");
  });
});

describe("the credential", () => {
  it("uses the stored token for the repository level, and none for a local operation or a grant of none", async () => {
    tokenRepo(admin);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    await brokerRequest(r.ctx, { op: "fetch" }, grant());
    await brokerRequest(r.ctx, { op: "status" }, grant());
    await brokerRequest(r.ctx, { op: "fetch" }, grant({ credential: "none" }));
    const [fetch, status, none] = f.ops();
    expect(fetch!.env.SCF_GIT_PASSWORD).toBe(TOKEN);
    expect(status!.env.SCF_GIT_PASSWORD).toBeUndefined();
    expect(none!.env.SCF_GIT_PASSWORD).toBeUndefined();
    expect(repoEvents(r).map((e) => e.credential)).toEqual(["repository", "none", "none"]);
  });

  it("asks for an App token limited to the repository and to the permissions of the operation", async () => {
    addRepo(admin.id, { url: "acme/app", method: "github-app" }, { installationId: "77" });
    const cases: [object, RepoGrant, object][] = [
      [{ op: "clone" }, grant(), { contents: "read" }],
      [{ op: "fetch" }, grant(), { contents: "read" }],
      [{ op: "push", branch: "x" }, grant(), { contents: "write" }],
      [{ op: "pull-request", head: "a", base: "b", title: "T" }, prGrant(), { pull_requests: "write" }],
    ];
    expect(APP_PERMISSIONS.push).toEqual({ contents: "write" });
    for (const [req, g, permissions] of cases) {
      app.calls.length = 0;
      const f = fakeExec();
      const r = rig({ exec: f.exec, config: { github_app: app.config() }, workdir: join(tmp, `clone-${++n}`) });
      const res = await brokerRequest(r.ctx, req, g);
      expect(res.outcome, JSON.stringify(req)).toBe("done");
      const token = app.calls.find((c) => c.path.endsWith("/access_tokens"))!;
      expect(token.body, JSON.stringify(req)).toEqual({ repositories: ["app"], permissions });
      expect(f.ops()[0]!.env.GH_TOKEN).toBe(app.tokens.at(-1));
      expect(repoEvents(r)[0]).toMatchObject({ credential: "repository" });
    }
    const f = fakeExec();
    const r = rig({ exec: f.exec, config: { github_app: app.config() } });
    app.calls.length = 0;
    await brokerRequest(r.ctx, { op: "status" }, grant());
    expect(app.calls).toEqual([]);
  });

  it("fails with a fixed sentence when the App token cannot be made", async () => {
    addRepo(admin.id, { url: "acme/app", method: "github-app" }, { installationId: "77" });
    app.force.token = { status: 403, body: "{}" };
    const f = fakeExec();
    const r = rig({ exec: f.exec, config: { github_app: app.config() } });
    const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(res.outcome).toBe("failed");
    expect(res.output).toMatch(/app/i);
    expect(f.ops()).toEqual([]);
    expect(repoEvents(r)).toHaveLength(1);
  });

  it("falls back to the bot only under a machine grant and only for a run that is not isolated", async () => {
    process.env.BROKER_BOT_TOKEN = BOT_TOKEN;
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    expect(await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant({ credential: "machine" }))).toMatchObject({ outcome: "done" });
    expect(f.ops()[0]!.env.GH_TOKEN).toBe(BOT_TOKEN);
    expect(repoEvents(r)[0]).toMatchObject({ credential: "machine" });
    // a repository grant never uses the bot
    const g = fakeExec();
    const r2 = rig({ exec: g.exec });
    expect(await brokerRequest(r2.ctx, { op: "push", branch: "x" }, grant({ credential: "repository" }))).toMatchObject({ refusal: "no-credential" });
    // a stored sign-in makes the run isolated: its own sign-in is used, never the bot
    tokenRepo(admin);
    const h = fakeExec();
    const r3 = rig({ exec: h.exec });
    await brokerRequest(r3.ctx, { op: "push", branch: "x" }, grant({ credential: "machine" }));
    expect(h.ops()[0]!.env.GH_TOKEN).toBe(TOKEN);
    delete process.env.BROKER_BOT_TOKEN;
    const none = fakeExec();
    const r4 = rig({ owner: undefined as never, exec: none.exec });
    (r4.engine.summary as { owner?: string }).owner = undefined;
    expect(await brokerRequest(r4.ctx, { op: "push", branch: "x" }, grant({ credential: "machine" }))).toMatchObject({ refusal: "no-credential" });
  });

  it("asks the App for a token limited to the repository for the bot", async () => {
    const f = fakeExec();
    const r = rig({ exec: f.exec, config: { github_app: { ...app.config(), installation_id: "77" } } });
    expect(await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant({ credential: "machine" }))).toMatchObject({ outcome: "done" });
    const token = app.calls.find((c) => c.path.endsWith("/access_tokens"))!;
    expect(token.body).toEqual({ repositories: ["app"], permissions: { contents: "write" } });
    expect(f.ops()[0]!.env.GH_TOKEN).toBe(app.tokens.at(-1));
    // an isolated run does not get it
    const g = fakeExec();
    const r2 = rig({ owner: user.id, exec: g.exec, config: { github_app: { ...app.config(), installation_id: "77" } } });
    app.calls.length = 0;
    expect(await brokerRequest(r2.ctx, { op: "push", branch: "x" }, grant({ credential: "machine" }))).toMatchObject({ refusal: "no-credential" });
    expect(app.calls).toEqual([]);
  });
});

describe("the policy", () => {
  const outage = (r?: { events: () => unknown }) => {
    void r;
    return (rec: ReturnType<typeof runRecorder>) =>
      new RunPolicy({ runId: "r", packs: [{ layer: "mandatory", id: "p1", problem: "policy.unavailable", detail: "x" }], base: {}, log: () => {}, evidence: rec });
  };

  it("refuses an operation with a sign-in when a mandatory policy cannot be used, before any token is made", async () => {
    addRepo(admin.id, { url: "acme/app", method: "github-app" }, { installationId: "77" });
    const f = fakeExec();
    const r = rig({ exec: f.exec, config: { github_app: app.config() } });
    (r.engine as { policy?: RunPolicy }).policy = outage()(r.engine.evidence!);
    const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(res).toMatchObject({ outcome: "refused", refusal: "policy" });
    expect(r.engine.accessFailed).toBe(true);
    expect(f.ops()).toEqual([]);
    expect(app.calls.filter((c) => c.path.endsWith("/access_tokens"))).toEqual([]);
    expect(repoEvents(r)[0]).toMatchObject({ policy: "deny", refusal: "policy", credential: "repository" });
    expect(r.events().some((e) => e.type === "policy.decided")).toBe(true);
  });

  it("lets a local operation pass the same outage", async () => {
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    (r.engine as { policy?: RunPolicy }).policy = outage()(r.engine.evidence!);
    expect(await brokerRequest(r.ctx, { op: "status" }, grant())).toMatchObject({ outcome: "done" });
    expect(r.engine.accessFailed).toBeUndefined();
  });

  it("asks both repository.access and push for a push, and records the combined outcome", async () => {
    tokenRepo(admin);
    const f = fakeExec();
    const r = rig({ exec: f.exec });
    (r.engine as { policy?: RunPolicy }).policy = new RunPolicy({ runId: "r", packs: [{ layer: "mandatory", id: BASELINE_POLICY_ID, pack: BASELINE_PACK }], base: {}, log: () => {}, evidence: r.engine.evidence });
    await brokerRequest(r.ctx, { op: "push", branch: "feat/x" }, grant());
    const boundaries = r.events().filter((e) => e.type === "policy.decided").map((e) => (e.decision as { boundary: string }).boundary);
    expect(boundaries).toContain("repository.access");
    expect(boundaries).toContain("push");
    expect(repoEvents(r)[0]).toMatchObject({ operation: "push", branch: "feat/x", outcome: "done" });
    expect(repoEvents(r)[0]!.policy).toBeDefined();
  });
});

describe("the outcome and the output", () => {
  it("reports cancelled and timed out as failed and removes the gh folder", async () => {
    tokenRepo(admin);
    for (const [flag, text] of [["aborted", "cancelled"], ["timedOut", "timed out"]] as const) {
      const f = fakeExec((c) => (c.args[0] === "push" ? { exitCode: null, [flag]: true } : undefined));
      const r = rig({ exec: f.exec });
      const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
      expect(res.outcome).toBe("failed");
      expect(res.output).toContain(text);
      expect(existsSync(f.ops()[0]!.env.GH_CONFIG_DIR!)).toBe(false);
      expect(repoEvents(r)).toHaveLength(1);
    }
  });

  it("turns a process that cannot start into a failure with one event and no token", async () => {
    tokenRepo(admin);
    const f = fakeExec((c) => (c.args[0] === "push" ? new Error(`failed to start "git": spawn git ENOENT ${TOKEN}`) : undefined));
    const r = rig({ exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(res.outcome).toBe("failed");
    expect(res.output).toContain("could not run");
    expect(res.output).not.toContain(TOKEN);
    expect(existsSync(f.ops()[0]!.env.GH_CONFIG_DIR!)).toBe(false);
    expect(repoEvents(r)).toHaveLength(1);
    expect(repoEvents(r)[0]).toMatchObject({ outcome: "failed" });
  });

  it("fails with the default exec when the program is missing or the log cannot be written", async () => {
    const r = rig();
    const saved = process.env.PATH;
    const empty = join(tmp, "empty-path");
    mkdirSync(empty);
    process.env.PATH = empty;
    try {
      const res = await brokerRequest(r.ctx, { op: "status" }, grant());
      expect(res.outcome).toBe("failed");
    } finally {
      process.env.PATH = saved;
    }
    expect(repoEvents(r)).toHaveLength(1);
    const r2 = rig();
    rmSync(r2.runDir, { recursive: true, force: true });
    mkdirSync(r2.runDir);
    const gone = { ...r2.ctx, logFile: join(tmp, "no-such-folder", "x.log") };
    expect((await brokerRequest(gone, { op: "status" }, grant())).outcome).toBe("failed");
    expect(repoEvents(r2)).toHaveLength(1);
  });

  it("never returns the token", async () => {
    tokenRepo(admin);
    const f = fakeExec((c) => (c.args[0] === "fetch" ? { stderr: `see ${TOKEN} here`, stdout: `out ${TOKEN}` } : undefined));
    const r = rig({ exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "fetch" }, grant());
    expect(res.output).not.toContain(TOKEN);
    expect(res.output).toContain("[redacted]");
    expect(f.ops()[0]!.pinnedSecrets).toEqual([TOKEN]);
    expect(JSON.stringify(r.events())).not.toContain(TOKEN);
  });

  it("says when GitHub refused the token", async () => {
    tokenRepo(admin);
    const f = fakeExec((c) => (c.args[0] === "push" ? { exitCode: 128, stderr: "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed" } : undefined));
    const r = rig({ exec: f.exec });
    const res = await brokerRequest(r.ctx, { op: "push", branch: "x" }, grant());
    expect(res.outcome).toBe("failed");
    expect(res.output.startsWith(TOKEN_REFUSED_RUN)).toBe(true);
  });

  it("cuts the output to the cap in bytes, keeping the sentence first", async () => {
    const out = (cap: number | null, stdout: string, exitCode = 0) => {
      const f = fakeExec((c) => (c.args[0] === "status" ? { stdout, exitCode } : undefined));
      return brokerRequest(rig({ exec: f.exec }).ctx, { op: "status" }, grant({ outputCapBytes: cap }));
    };
    expect((await out(0, "abc")).output).toBe("");
    const cut = (await out(10, "é".repeat(20))).output;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(10);
    expect(cut).toBe("é".repeat(5));
    expect((await out(null, "x".repeat(30_000))).output).toHaveLength(20_000);
    const timed = fakeExec((c) => (c.args[0] === "status" ? { exitCode: null, timedOut: true, stdout: "y".repeat(100) } : undefined));
    const res = await brokerRequest(rig({ exec: timed.exec }).ctx, { op: "status" }, grant({ outputCapBytes: 20 }));
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(20);
    expect(res.output.startsWith("timed out\n")).toBe(true);
  });
});

describe("with a real repository", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

  it("commits with the run's name, says when there is nothing to commit, switches branch and shows the status", async () => {
    const work = join(tmp, "real");
    mkdirSync(work);
    git(work, "init", "-q");
    writeFileSync(join(work, "a.txt"), "one\n");
    const r = rig({ workdir: work });
    const grantAll = grant();
    expect(await brokerRequest(r.ctx, { op: "commit", message: "first" }, grantAll)).toMatchObject({ outcome: "done" });
    expect(git(work, "log", "-1", "--format=%an <%ae>|%s")).toBe("Bot <bot@example.com>|first");
    expect(await brokerRequest(r.ctx, { op: "commit", message: "again" }, grantAll)).toMatchObject({ outcome: "done", output: "nothing to commit" });
    expect(git(work, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await brokerRequest(r.ctx, { op: "branch", name: "feat" }, grantAll)).toMatchObject({ outcome: "done" });
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
    const status = await brokerRequest(r.ctx, { op: "status" }, grantAll);
    expect(status.output).toContain("## feat");
    expect(repoEvents(r).map((e) => [e.operation, e.outcome])).toEqual([["commit", "done"], ["commit", "done"], ["branch", "done"], ["status", "done"]]);
  });

  it("refuses a workspace whose git settings were changed", async () => {
    const work = join(tmp, "real-bad");
    mkdirSync(work);
    git(work, "init", "-q");
    git(work, "config", "http.proxy", "http://evil.example:3128");
    const r = rig({ workdir: work });
    expect(await brokerRequest(r.ctx, { op: "status" }, grant())).toMatchObject({ outcome: "refused", refusal: "unsafe-git-settings" });
  });
});
