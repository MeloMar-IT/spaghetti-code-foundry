import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_MISSING, KEY_UNREADABLE, addRepo, getRepo, repoAccess } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { listCredentials, removeCredential } from "../src/credentials/store.js";
import { DEPLOY_KEY_NO_GH, KEY_REFUSED_RUN, SIGN_IN_NOT_REMOVED, keyRefused } from "../src/engine/guards.js";
import { processStart, removeSignInDir, repoKeyEnv, signInDir, sweepSignInDirs } from "../src/engine/repo-access.js";
import { cancelWaitingRun, resumeRun, runFlow } from "../src/engine/runner.js";
import { explainError } from "../src/errors.js";
import { classifyFailure } from "../src/failure.js";
import { parseFlow } from "../src/flow/load.js";
import { classifyGit, sshKeyEnv } from "../src/repos/connect.js";
import { startServer } from "../src/server/server.js";
import { claudeBin, fakeGithub, fakeSsh } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

const SSH_URL = "git@github.com:acme/app.git";
const BOT = ["ghp", ""].join("_") + "Bot".repeat(12);
const isRoot = process.getuid?.() === 0;

let gh: ReturnType<typeof fakeGithub>;
let ssh: ReturnType<typeof fakeSsh>;
let kc: FakeKeychain;
let kg: FakeKeygen;
let admin: { id: string };
let user: { id: string };

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  kg = fakeKeygen();
  ssh = fakeSsh(gh);
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  delete process.env.SSH_AUTH_SOCK;
  delete process.env.FAKE_SSH_FAIL;
  kg.remove();
  kc.remove();
  gh.restore();
});

const keyRepo = (owner: { id: string }, url = SSH_URL) => addRepo(owner.id, { url, method: "ssh-deploy-key" });
const runs = () => join(gh.tmp, "runs");
const flowOf = (yaml: string) => parseFlow(yaml, "probe.yaml");
const go = (flow: ReturnType<typeof flowOf>, extra: { source?: string; owner?: string; config?: Config; signal?: AbortSignal } = {}) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: ConfigSchema.parse({ protected_branches: [] }), owner: user.id, ...extra });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const one = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n    repo_access: true\n${extra}    run: ${JSON.stringify(run)}\n`;
const plain = (id: string, run: string) => `  - id: ${id}\n    type: shell\n    run: ${JSON.stringify(run)}\n`;
const mini = (...steps: string[]) => flowOf(`name: mini\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps.join("")}`);
const keyLines = (pem: string) => pem.split("\n").filter((l) => l.length >= 8 && !l.startsWith("-----"));
const dirOfKey = '$(dirname "$SCF_SSH_KEY")';
const config = (extra: object = {}) => ConfigSchema.parse({ protected_branches: [], ...extra });
const MODES = `node -e 'const fs=require("fs"),p=require("path");const k=process.env.SCF_SSH_KEY;console.log((fs.statSync(k).mode&0o777).toString(8),(fs.statSync(p.dirname(k)).mode&0o777).toString(8))'`;

describe("repoAccess with a deploy key", () => {
  it("gives the key to a user and an admin, and sets lastUsed", () => {
    const r = keyRepo(user);
    const a = keyRepo(admin, "git@github.com:acme/web.git");
    const key = kg.pairs()[0]!.privateKey;
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "key", key, url: r.url });
    expect(repoAccess(admin.id, "acme/web")).toEqual({ kind: "key", key: kg.pairs()[1]!.privateKey, url: a.url });
    expect(listCredentials(user.id).find((c) => c.id === r.credentialId)?.lastUsed).not.toBeNull();
  });

  it("says KEY_MISSING for a removed credential and KEY_UNREADABLE (with a detail) for a failing Keychain", () => {
    const r = keyRepo(user);
    kc.fail("find");
    const bad = repoAccess(user.id, "acme/app");
    expect(bad).toMatchObject({ kind: "refused", reason: KEY_UNREADABLE });
    expect((bad as { detail?: string }).detail).toBeTruthy();
    kc.fail();
    removeCredential(user.id, r.credentialId!);
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "refused", reason: KEY_MISSING });
    expect(getRepo(r.id)).toBeDefined();
  });
});

describe("a marked step with a deploy key", { timeout: 60_000 }, () => {
  it("gets the key in a 0600 file in a 0700 folder of the run folder, outside the workspace, and no GH_TOKEN", async () => {
    keyRepo(user);
    process.env.BOT_TOKEN_FOR_TEST = BOT;
    const copy = join(gh.tmp, "keycopy");
    const run = `${MODES}; echo "dir=${dirOfKey}"; echo "work=$FACTORY_WORKDIR"; echo "url=$FACTORY_REPO_URL gh=\${GH_TOKEN:-unset}"; cp "$SCF_SSH_KEY" ${copy}`;
    const s = await go(mini(one("marked", run)), { config: config({ bot: { gh_token_env: "BOT_TOKEN_FOR_TEST" } }) });
    expect(s.status).toBe("succeeded");
    const lines = out(s, "marked").split("\n");
    expect(lines[0]).toBe("600 700");
    expect(lines[1]).toBe(`dir=${signInDir(s.runDir)}`);
    expect(lines[2]!.startsWith(`work=${s.workdir}`)).toBe(true);
    expect(signInDir(s.runDir).startsWith(s.workdir!)).toBe(false);
    expect(lines[3]).toBe(`url=${SSH_URL} gh=unset`);
    expect(readFileSync(copy, "utf8").trim()).toBe(kg.pairs()[0]!.privateKey.trim());
    expect(existsSync(signInDir(s.runDir))).toBe(false);
  });

  it("keeps the key and the address from the plain step and the agent step", async () => {
    keyRepo(user);
    process.env.BOT_TOKEN_FOR_TEST = BOT;
    const s = await go(
      flowOf(`name: probe\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${one("marked", "true")}${plain("plain", 'echo "key=${SCF_SSH_KEY:-none} url=${FACTORY_REPO_URL:-none} gh=$GH_TOKEN"; test ! -e "{{run.dir}}/sign-in" && echo clean')}  - id: agent\n    type: claude\n    prompt: SHOWGH\n`),
      { config: config({ bot: { gh_token_env: "BOT_TOKEN_FOR_TEST" } }) },
    );
    expect(s.status).toBe("succeeded");
    expect(out(s, "plain")).toBe("key=none url=none gh=\nclean");
    expect(out(s, "agent")).toContain("gh_token=none");
  });

  it("uses only that key: no agent, no ssh files of the account, host keys in the data folder", async () => {
    keyRepo(user);
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    const run = 'echo "agent=${SSH_AUTH_SOCK:-unset}"; echo "cmd=$GIT_SSH_COMMAND"; echo "kh=$SCF_KNOWN_HOSTS"; echo "proto=$GIT_ALLOW_PROTOCOL cfg=$GIT_CONFIG_GLOBAL"';
    const s = await go(mini(one("marked", run)));
    const o = out(s, "marked");
    expect(o).toContain("agent=unset");
    expect(o).toMatch(/cmd=.*-F \/dev\/null.*IdentitiesOnly=yes.*BatchMode=yes/);
    expect(o).toContain(`kh=${join(process.env.FACTORY_HOME!, "known_hosts")}`);
    expect(o).toContain("proto=ssh cfg=/dev/null");
  });

  it("clones and pushes through ssh with that key only", async () => {
    keyRepo(user);
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    const run = 'git clone -q "$FACTORY_REPO_URL" repo && cd repo && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x && git push -q origin HEAD:feature/k 2>&1';
    const s = await go(mini(one("marked", run)));
    expect(s.status).toBe("succeeded");
    expect(gh.remoteGit("rev-parse", "--verify", "feature/k").trim()).toMatch(/^[0-9a-f]{40}$/);
    const log = ssh.log();
    expect(log).toContain(`-i ${signInDir(s.runDir)}/key`);
    expect(log).toContain("agent=none");
    expect(log).toContain("-F /dev/null");
  });

  it("does not run a hostile core.sshCommand of the workspace", async () => {
    keyRepo(user);
    const pwned = join(gh.tmp, "pwned");
    const run = `git init -q repo && cd repo && git config core.sshCommand 'touch ${pwned} #' && git remote add origin "$FACTORY_REPO_URL" && git fetch -q origin 2>&1; true`;
    const s = await go(mini(one("marked", run)));
    expect(s.status).toBe("succeeded");
    expect(existsSync(pwned)).toBe(false);
    expect(ssh.log()).toContain("ssh ");
  });

  it("blocks a push to a protected branch and a push with a secret", async () => {
    keyRepo(user);
    const cfg = ConfigSchema.parse({ protected_branches: ["main"], secret_scan: true });
    const prep = 'git clone -q "$FACTORY_REPO_URL" repo && cd repo && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x';
    const before = gh.remoteGit("rev-parse", "main").trim();
    const s = await go(mini(one("main_push", `${prep} && git push origin HEAD:main 2>&1`)), { config: cfg });
    expect(out(s, "main_push")).toContain("protected branch 'main' is blocked");
    expect(gh.remoteGit("rev-parse", "main").trim()).toBe(before);
    const leak = ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const t = await go(mini(one("secret", `${prep} && echo "k = ${leak}" > leak.js && git add leak.js && git -c user.email=t@t -c user.name=t commit -qm leak && git push origin HEAD:feature/x 2>&1`)), { config: cfg });
    expect(t.status).toBe("failed");
    expect(out(t, "secret")).toContain("leak.js");
    expect(() => gh.remoteGit("rev-parse", "--verify", "feature/x")).toThrow();
  });

  it("gets the key in a refinement run", async () => {
    keyRepo(user);
    const s = await go(mini(one("marked", 'echo "key=${SCF_SSH_KEY:+yes}"')), { source: "refinement 6b1c1d52-1111-4111-8111-111111111111" });
    expect(out(s, "marked")).toBe("key=yes");
  });
});

describe("a background process of a marked step", { timeout: 60_000 }, () => {
  it("is killed when the step ends", async () => {
    keyRepo(user);
    const pidFile = join(gh.tmp, "bg.pid");
    const s = await go(mini(one("marked", `sleep 30 >/dev/null 2>&1 </dev/null & echo $! > ${pidFile}`)));
    expect(s.status).toBe("succeeded");
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe("gh with a deploy key",{ timeout: 60_000 }, () => {
  it.each([["gh issue list"], ["gh issue list || true; echo done"], ["gh issue list 2>/dev/null || true"]])("fails the run with the fixed sentence for: %s", async (run) => {
    keyRepo(user);
    const handler = plain("handler", "echo handled");
    const s = await go(mini(one("marked", run, "    on_failure: handler\n"), handler));
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(`step "marked" failed: ${DEPLOY_KEY_NO_GH}`);
    expect(gh.ghLog()).toBe("");
    expect(s.history.map((h) => h.id)).toEqual(["marked"]);
    expect(classifyFailure(s)).toMatchObject({ cause: "factory" });
    expect(explainError(s.reason, "run").why).toMatch(/deploy key/);
  });
});

describe("a deploy key that is gone or refused", { timeout: 60_000 }, () => {
  it("fails with KEY_MISSING for a removed key and makes no folder", async () => {
    const r = keyRepo(user);
    removeCredential(user.id, r.credentialId!);
    const s = await go(mini(one("marked", "echo hi")));
    expect(s.reason).toBe(`step "marked" failed: ${KEY_MISSING}`);
    expect(existsSync(signInDir(s.runDir))).toBe(false);
  });

  it("fails with KEY_REFUSED_RUN when the host refuses the key, without on_failure", async () => {
    keyRepo(user);
    process.env.FAKE_SSH_FAIL = "git@github.com: Permission denied (publickey).";
    const s = await go(mini(one("marked", 'git clone -q "$FACTORY_REPO_URL" repo; echo done', "    on_failure: handler\n"), plain("handler", "echo handled")));
    expect(s.reason).toBe(`step "marked" failed: ${KEY_REFUSED_RUN}`);
    expect(s.history.map((h) => h.id)).toEqual(["marked"]);
    const good = await go(mini(one("marked", "echo 'git@github.com: Permission denied (publickey).'")));
    expect(good.status).toBe("succeeded");
  });

  it("recognises what hosts say, and nothing else", () => {
    const samples = ["git@github.com: Permission denied (publickey).", "ERROR: Permission to acme/app.git denied to deploy key.", "ERROR: Repository not found.", "remote: Write access to repository not granted.", "ERROR: The key you are authenticating with has been marked as read only."];
    for (const t of samples) {
      expect(keyRefused(t), t).toBe(true);
      expect(["bad-key", "read-only", "not-found"], t).toContain(classifyGit("push", t, { method: "ssh-deploy-key" }));
    }
    for (const t of ["npm ERR! 404 Not Found", "sh: foo: command not found", "error: 403"]) expect(keyRefused(t), t).toBe(false);
  });
});

describe("hiding the key", { timeout: 60_000 }, () => {
  it("hides the key in output and writes it in no file", async () => {
    keyRepo(user);
    const s = await go(mini(one("marked", 'cat "$SCF_SSH_KEY"')));
    const lines = keyLines(kg.pairs()[0]!.privateKey);
    for (const l of lines) expect(out(s, "marked")).not.toContain(l);
    for (const f of [...files(s.runDir), ...files(process.env.FACTORY_HOME!).filter((f) => !/credentials|keys/i.test(f))]) {
      const text = readFileSync(f, "utf8");
      for (const l of lines) expect(text, f).not.toContain(l);
    }
  });

  it("hides the key when its credential is removed while the step runs", async () => {
    const r = keyRepo(user);
    const p = go(mini(one("late", 'sleep 0.3; cat "$SCF_SSH_KEY"')));
    await new Promise((res) => setTimeout(res, 100));
    removeCredential(user.id, r.credentialId!);
    const s = await p;
    for (const l of keyLines(kg.pairs()[0]!.privateKey)) expect(out(s, "late")).not.toContain(l);
  });
});

describe("when the folder goes away", { timeout: 60_000 }, () => {
  const gone = (s: { runDir: string }) => expect(existsSync(signInDir(s.runDir))).toBe(false);

  it("is removed after a run that succeeded, failed, stopped or was cancelled", async () => {
    keyRepo(user);
    gone(await go(mini(one("marked", "true"))));
    gone(await go(mini(one("marked", "exit 1"))));
    gone(await go(mini(one("marked", "exit 1", "    on_failure: stop\n"))));
    const ctl = new AbortController();
    const p = go(mini(one("marked", "sleep 5")), { signal: ctl.signal });
    await new Promise((res) => setTimeout(res, 400));
    ctl.abort();
    const s = await p;
    expect(s.status).toBe("cancelled");
    gone(s);
  });

  it("is removed by cancelWaitingRun", async () => {
    const s = await go(flowOf("name: wait\nworkspace: empty\nsteps:\n  - {id: gate, type: approval, message: 'Go?'}\n"));
    expect(s.status).toBe("waiting");
    mkdirSync(signInDir(s.runDir));
    writeFileSync(join(signInDir(s.runDir), "key"), "x");
    expect(cancelWaitingRun(runs(), s.runId, config())?.status).toBe("cancelled");
    gone(s);
  });

  it("is removed from a failed run before its first step when it is resumed", async () => {
    const s = await go(mini(plain("boom", "exit 1"), plain("check", 'test ! -e "{{run.dir}}/sign-in" && echo clean')));
    expect(s.status).toBe("failed");
    mkdirSync(signInDir(s.runDir));
    writeFileSync(join(signInDir(s.runDir), "key"), "x");
    const again = await resumeRun({ runId: s.runId, runsDir: runs(), claudeBin, from: "check", config: config() });
    expect(out(again, "check")).toBe("clean");
  });

  it.skipIf(isRoot)("removes a folder whose mode a step made too strict", async () => {
    keyRepo(user);
    const s = await go(mini(one("marked", `chmod 500 "${dirOfKey}"`)));
    expect(s.status).toBe("succeeded");
    gone(s);
  });

  it.skipIf(isRoot)("fails the run when the folder cannot be removed, and a resume fails the same way until it is fixed", async () => {
    keyRepo(user);
    const stuck = `d="${dirOfKey}"; mkdir "$d/x" && touch "$d/x/f" && chmod 000 "$d/x"`;
    const s = await go(mini(one("marked", stuck, "    on_failure: handler\n"), plain("after", "echo ok"), plain("handler", "echo handled")));
    const x = join(signInDir(s.runDir), "x");
    try {
      expect(s.status).toBe("failed");
      expect(s.reason).toBe(`step "marked" failed: ${SIGN_IN_NOT_REMOVED}`);
      expect(s.history.map((h) => h.id)).toEqual(["marked"]);
      expect(existsSync(join(signInDir(s.runDir), "key"))).toBe(false);
      expect(classifyFailure(s)).toMatchObject({ cause: "factory" });
      const blocked = await resumeRun({ runId: s.runId, runsDir: runs(), claudeBin, from: "after", config: config() });
      expect(blocked.reason).toBe(SIGN_IN_NOT_REMOVED);
      expect(blocked.history.map((h) => h.id)).toEqual(["marked"]);
    } finally {
      chmodSync(x, 0o700);
    }
    const ok = await resumeRun({ runId: s.runId, runsDir: runs(), claudeBin, from: "after", config: config() });
    expect(ok.status).toBe("succeeded");
    gone(s);
  });

  it("reports false and does not throw when the remover throws", () => {
    const runDir = join(gh.tmp, "r1");
    mkdirSync(signInDir(runDir), { recursive: true });
    expect(removeSignInDir(runDir, () => { throw new Error("x"); })).toBe(false);
    expect(removeSignInDir(runDir)).toBe(true);
    expect(removeSignInDir(runDir)).toBe(true);
  });

  it("removes a link as a link and leaves what it points to", () => {
    const runDir = join(gh.tmp, "r2");
    const other = join(gh.tmp, "other");
    mkdirSync(runDir);
    mkdirSync(other);
    writeFileSync(join(other, "key"), "keep");
    symlinkSync(other, signInDir(runDir));
    expect(removeSignInDir(runDir)).toBe(true);
    expect(() => lstatSync(signInDir(runDir))).toThrow();
    expect(readFileSync(join(other, "key"), "utf8")).toBe("keep");
  });
});

describe("the sweep at server start", () => {
  const folder = (name: string, holder?: string) => {
    const runDir = join(runs(), name);
    mkdirSync(signInDir(runDir), { recursive: true });
    writeFileSync(join(signInDir(runDir), "key"), "x");
    if (holder !== undefined) writeFileSync(join(signInDir(runDir), "holder"), holder);
    return runDir;
  };

  it("removes what nobody holds and keeps what a live process holds", () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const dead = spawnSync("true");
    try {
      const live = child.pid!;
      const start = processStart(live);
      folder("a-none");
      folder("b-dead", `${dead.pid}\n${processStart(process.pid)}\n`);
      folder("c-self", `${process.pid}\n${processStart(process.pid)}\n`);
      folder("d-reused", `${live}\nMon Jan  1 00:00:00 2001\n`);
      folder("e-live", `${live}\n${start}\n`);
      folder("f-nostart", `${live}\n\n`);
      expect(sweepSignInDirs(runs())).toEqual({ removed: 4, failed: 0 });
      expect(readdirSync(runs()).filter((n) => existsSync(signInDir(join(runs(), n)))).sort()).toEqual(["e-live", "f-nostart"]);
      expect(sweepSignInDirs(join(gh.tmp, "no-such-folder"))).toEqual({ removed: 0, failed: 0 });
    } finally {
      child.kill();
    }
  });

  it("runs when the server starts", async () => {
    const runDir = folder("leftover");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const logs: string[] = [];
    const { close } = await startServer({ repo: gh.tmp, runsDir: runs(), port, claudeBin, watchers: false, log: (m) => void logs.push(m) });
    try {
      expect(existsSync(signInDir(runDir))).toBe(false);
      expect(logs.some((l) => /1 leftover sign-in folder\(s\) of interrupted runs removed/.test(l))).toBe(true);
    } finally {
      close();
    }
  });
});

describe("the environment of the key", () => {
  it("sshKeyEnv writes a 0600 key and returns the three variables", () => {
    const dir = join(gh.tmp, "k");
    mkdirSync(dir);
    const env = sshKeyEnv(dir, "SECRET", join(gh.tmp, "kh"));
    expect(Object.keys(env).sort()).toEqual(["GIT_SSH_COMMAND", "SCF_KNOWN_HOSTS", "SCF_SSH_KEY"]);
    expect(readFileSync(env.SCF_SSH_KEY, "utf8")).toBe("SECRET\n");
    expect(lstatSync(env.SCF_SSH_KEY).mode & 0o777).toBe(0o600);
  });

  it("keeps the engine's own GIT_CONFIG entries and adds one", () => {
    const env = repoKeyEnv({ kind: "key", key: "k", url: SSH_URL }, { GIT_CONFIG_COUNT: "1" }, { SCF_SSH_KEY: "/k", SCF_KNOWN_HOSTS: "/h", GIT_SSH_COMMAND: "ssh" }, "/bin", "/m");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(Object.hasOwn(env, "GH_TOKEN") && env.GH_TOKEN === undefined).toBe(true);
  });
});
