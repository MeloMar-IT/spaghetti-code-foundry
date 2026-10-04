import { execFileSync } from "node:child_process";
import { HELPER, repoTokenEnv } from "../src/engine/repo-access.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEEDS_TOKEN, TOKEN_MISSING, addRepo, setRepoAuth } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { listCredentials, removeCredential } from "../src/credentials/store.js";
import { TOKEN_REFUSED_REASON, TOKEN_REFUSED_RUN } from "../src/engine/guards.js";
import { explainError } from "../src/errors.js";
import { classifyFailure } from "../src/failure.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin, fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
const BOT = ["ghp", ""].join("_") + "Bot".repeat(12);
const SHOW = 'if [ "$GH_TOKEN" = "$FAKE_GH_EXPECT_TOKEN" ]; then echo "stored host=$GH_HOST url=$FACTORY_REPO_URL"; else echo "${GH_TOKEN:-none}"; fi';

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  delete process.env.FAKE_GH_EXPECT_TOKEN;
  delete process.env.FAKE_GH_FAIL;
  delete process.env.GH_CONFIG_DIR;
  kc.remove();
  gh.restore();
});

const tokenRepo = (owner: { id: string }, token = TOKEN, url = "acme/app") => addRepo(owner.id, { url, method: "github-token", token });
const runs = () => join(gh.tmp, "runs");
const FLOW = `
name: probe
workspace: empty
vars: { github_repo: acme/app }
steps:
  - id: marked
    type: shell
    repo_access: true
    run: '${SHOW}'
  - id: plain
    type: shell
    run: '${SHOW}'
  - id: agent
    type: claude
    prompt: SHOWGH
`;
const flowOf = (yaml = FLOW) => parseFlow(yaml, "probe.yaml");
const go = (flow: ReturnType<typeof flowOf>, extra: { source?: string; owner?: string; config?: Config; vars?: Record<string, string> } = {}) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: ConfigSchema.parse({ protected_branches: [] }), ...extra });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const lastUsed = (r: { credentialId?: string }, uid: string) => listCredentials(uid).find((c) => c.id === r.credentialId)?.lastUsed;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const one = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n    repo_access: true\n${extra}    run: ${JSON.stringify(run)}\n`;
const mini = (...steps: string[]) => flowOf(`name: mini\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps.join("")}`);

describe("a marked step", { timeout: 60_000 }, () => {
  it.each([["ui"], ["cli"], ["watcher w issue #1"], [undefined]])("gets the stored token for the source %s, and nothing else does", async (source) => {
    const r = tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const s = await go(flowOf(), { source, owner: user.id });
    expect(s.status).toBe("succeeded");
    expect(out(s, "marked")).toBe("stored host=github.com url=acme/app".replace("acme/app", r.url));
    expect(out(s, "plain")).toBe("none");
    expect(out(s, "agent")).toContain("gh_token=none");
    expect(lastUsed(r, user.id)).not.toBeNull();
  });

  it("replaces the bot's token in the marked step only", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    process.env.BOT_TOKEN_FOR_TEST = BOT;
    const config = ConfigSchema.parse({ protected_branches: [], bot: { gh_token_env: "BOT_TOKEN_FOR_TEST" } });
    const s = await go(flowOf(), { owner: user.id, config });
    expect(out(s, "marked")).toContain("stored host=github.com");
    expect(out(s, "plain")).toBe(BOT);
    expect(out(s, "agent")).toContain("gh_token=other");
  });

  it("is signed in two sub-flows deep", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    mkdirSync(join(gh.tmp, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(gh.tmp, ".claude-factory", "flows", "inner.yaml"), `name: inner\nworkspace: empty\nsteps:\n${one("deep", SHOW)}`);
    writeFileSync(join(gh.tmp, ".claude-factory", "flows", "middle.yaml"), "name: middle\nworkspace: empty\nsteps:\n  - id: m\n    type: flow\n    flow: inner\n");
    const s = await go(flowOf("name: outer\nworkspace: empty\nsteps:\n  - id: o\n    type: flow\n    flow: middle\n"), { owner: user.id });
    expect(s.status).toBe("succeeded");
    expect(s.history.find((h) => h.id === "o/m/deep")?.output).toContain("stored host=github.com");
  });

  it("gets the token of the repository named by github_repo", async () => {
    tokenRepo(user);
    tokenRepo(user, TOKEN2, "acme/web");
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const s = await go(flowOf(), { owner: user.id, vars: { github_repo: "acme/web" } });
    expect(out(s, "marked")).toContain("stored host=github.com");
  });

  it("looks the token up when the step starts: a resume sees the new one", async () => {
    const r = tokenRepo(user);
    const flow = mini(one("first", "exit 1"), one("marked", 'test "$GH_TOKEN" = "$FAKE_GH_EXPECT_TOKEN" && echo stored'));
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const s = await go(flow, { owner: user.id });
    expect(s.status).toBe("failed");
    setRepoAuth(user.id, r.id, { token: TOKEN2 });
    const again = await resumeRun({ runId: s.runId, runsDir: runs(), claudeBin, from: "marked", config: ConfigSchema.parse({ protected_branches: [] }) });
    expect(out(again, "marked")).toBe("stored");
  });
});

describe("the environment of a marked step", { timeout: 60_000 }, () => {
  it("answers git credential fill for github.com only, with the name x-access-token", async () => {
    tokenRepo(user);
    const ask = (host: string) => `printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill`;
    const s = await go(
      mini(
        one("fill", `${ask("github.com")} | grep -q "^username=x-access-token$" && ${ask("github.com")} | grep -q "^password=$GH_TOKEN$" && echo good`),
        one("other", `${ask("example.invalid")} 2>/dev/null | grep -c '^password=' || true`),
      ),
      { owner: user.id },
    );
    expect(out(s, "fill")).toBe("good");
    expect(out(s, "other")).toBe("0");
  });

  it("uses the stored user name for https-token", async () => {
    addRepo(user.id, { url: "https://github.com/acme/app", method: "https-token", username: "bob", token: TOKEN });
    const s = await go(mini(one("fill", "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | grep '^username='")), { owner: user.id });
    expect(out(s, "fill")).toBe("username=bob");
  });

  it("ignores a hostile helper in the workspace and speaks https only", async () => {
    tokenRepo(user);
    const s = await go(
      mini(
        one("prep", "git init -q . && git config credential.helper '!echo username=evil; echo password=evil #'"),
        one("fill", "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | grep '^username='"),
        one("proto", 'echo "$GIT_ALLOW_PROTOCOL"; git ls-remote file:///nowhere 2>&1 || true'),
      ),
      { owner: user.id },
    );
    expect(out(s, "fill")).toBe("username=x-access-token");
    expect(out(s, "proto")).toMatch(/^https\n.*not allowed/s);
  });

  it("gives gh an empty folder of its own for each step, removed afterwards", async () => {
    tokenRepo(user);
    const seen = join(gh.tmp, "seen.txt");
    process.env.GH_CONFIG_DIR = join(gh.tmp, "server-gh");
    const run = `echo "$GH_CONFIG_DIR" >> ${seen}; test -d "$GH_CONFIG_DIR" && test -z "$(ls -A "$GH_CONFIG_DIR")" && echo "enterprise=\${GH_ENTERPRISE_TOKEN:-unset}"`;
    const plain = `echo "$GH_CONFIG_DIR"`;
    const s = await go(mini(one("a", run), one("b", run), `  - id: plain\n    type: shell\n    run: ${JSON.stringify(plain)}\n`), { owner: user.id });
    expect(out(s, "a")).toBe("enterprise=unset");
    const dirs = readFileSync(seen, "utf8").trim().split("\n");
    expect(new Set(dirs).size).toBe(2);
    expect(dirs).not.toContain(process.env.GH_CONFIG_DIR);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
    expect(out(s, "plain")).toBe(process.env.GH_CONFIG_DIR);
  });

  it("hides the token and writes it nowhere", async () => {
    tokenRepo(user);
    const s = await go(mini(one("leak", 'echo "$GH_TOKEN $SCF_GIT_PASSWORD"')), { owner: user.id });
    expect(out(s, "leak")).toBe("[redacted] [redacted]");
    for (const f of [...files(s.runDir), ...files(process.env.FACTORY_HOME!).filter((f) => !/credentials|keys/i.test(f))]) {
      expect(readFileSync(f, "utf8")).not.toContain(TOKEN);
    }
  });

  it("hides the token when it is removed while the step runs", async () => {
    const r = tokenRepo(user);
    const gone = `test -n "$GH_TOKEN"; node -e 'process.exit(0)'; sleep 0.2; echo "$GH_TOKEN"`;
    const p = go(mini(one("late", gone)), { owner: user.id });
    await new Promise((res) => setTimeout(res, 50));
    removeCredential(user.id, r.credentialId!);
    expect(out(await p, "late")).toBe("[redacted]");
  });
});

describe("the hooks in a marked step", { timeout: 60_000 }, () => {
  const config = ConfigSchema.parse({ protected_branches: ["main"], secret_scan: true });
  const prep = 'git clone -q "$FACTORY_REPO_URL" repo && cd repo && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x';

  it("blocks a push to a protected branch and a push with a secret, and lets a clean one through", async () => {
    tokenRepo(user);
    const fake = fakeGit(gh);
    const before = gh.remoteGit("rev-parse", "main").trim();
    const s = await go(mini(one("main_push", `${prep} && git push origin HEAD:main 2>&1`)), { owner: user.id, config });
    expect(out(s, "main_push")).toContain("protected branch 'main' is blocked");
    expect(gh.remoteGit("rev-parse", "main").trim()).toBe(before);
    expect(s.status).toBe("failed");
    const clean = await go(mini(one("ok", `${prep} && git push origin HEAD:feature/y 2>&1`)), { owner: user.id, config });
    expect(clean.status).toBe("succeeded");
    expect(fake.log()).toMatch(/allow=https/);
    expect(fake.log()).not.toMatch(/allow=(?!https|file|$)\S/m); // the engine's own calls have none; the step's are https
  });

  it("blocks a push with a secret", async () => {
    tokenRepo(user);
    fakeGit(gh);
    const leak = ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const s = await go(mini(one("secret", `${prep} && echo "k = ${leak}" > leak.js && git add leak.js && git -c user.email=t@t -c user.name=t commit -qm leak && git push origin HEAD:feature/x 2>&1`)), { owner: user.id, config });
    expect(s.status).toBe("failed");
    expect(out(s, "secret")).toContain("leak.js");
    expect(() => gh.remoteGit("rev-parse", "--verify", "feature/x")).toThrow();
  });
});

describe("the credential helper and the locale", () => {
  it("hands a token with backslashes to git unchanged", () => {
    const token = String.raw`ab\n\\cd\t`;
    const script = HELPER.slice(1); // the leading "!" means "run with the shell"
    const got = execFileSync("sh", ["-c", `${script.replace(/; f$/, "; f get")}`], { env: { SCF_GIT_USERNAME: "bob", SCF_GIT_PASSWORD: token }, encoding: "utf8" });
    expect(got).toBe(`username=bob\npassword=${token}\n`);
  });

  it("sets LC_ALL=C for the step", () => {
    const env = repoTokenEnv({ kind: "token", token: TOKEN, url: "https://github.com/acme/app", username: "x-access-token" }, {});
    expect(env.LC_ALL).toBe("C");
  });
});

describe("no token method",{ timeout: 60_000 }, () => {
  const server = (s: { history: { id: string; output: string }[] }) => out(s, "marked");
  const SERVER_ENV = 'echo "${GH_TOKEN:-none} ${FACTORY_REPO_URL:-nourl}"';

  it.each([["none"], ["not listed"], ["placeholder"]])("an admin's run works as today (%s)", async (kind) => {
    if (kind === "none") addRepo(admin.id, { url: "acme/app", method: "none" });
    if (kind === "not listed") tokenRepo(admin, TOKEN, "acme/other");
    const s = await go(mini(one("marked", SERVER_ENV)), { owner: admin.id, vars: { github_repo: kind === "placeholder" ? "owner/repo" : "acme/app" } });
    expect(s.status).toBe("succeeded");
    expect(server(s)).toBe("none nourl");
  });

  it.each([["none"], ["not listed"]])("a user's run fails with one sentence (%s)", async (kind) => {
    if (kind === "none") addRepo(user.id, { url: "acme/app", method: "none" });
    const s = await go(mini(one("marked", SERVER_ENV)), { owner: user.id });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(`step "marked" failed: ${NEEDS_TOKEN}`);
    expect(gh.ghLog()).toBe("");
  });

  it("a run without an owner works as today", async () => {
    process.env.FACTORY_HOME = join(gh.tmp, "no-accounts-home"); // no account exists, so nobody adopts the run
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    const s = await go(mini(one("marked", SERVER_ENV)), {});
    expect(s.owner).toBeUndefined();
    expect(s.status).toBe("succeeded");
    expect(server(s)).toBe("none nourl");
  });

  it("a missing token fails with TOKEN_MISSING", async () => {
    const r = tokenRepo(user);
    removeCredential(user.id, r.credentialId!);
    const s = await go(mini(one("marked", "echo hi")), { owner: user.id });
    expect(s.reason).toBe(`step "marked" failed: ${TOKEN_MISSING}`);
  });
});

describe("a refused token", { timeout: 60_000 }, () => {
  it("fails the run with the fixed sentence and counts as an environment failure", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const s = await go(mini(one("marked", "gh issue list")), { owner: user.id });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(`step "marked" failed: ${TOKEN_REFUSED_RUN}`);
    expect(classifyFailure(s)).toMatchObject({ cause: "factory" });
    expect(explainError(s.reason, "run").why).toMatch(/set it again under My repositories/);
  });

  it("uses the refinement sentence for a refinement run", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const s = await go(mini(one("marked", "gh issue list")), { owner: user.id, source: "refinement 6b1c1d52-1111-4111-8111-111111111111" });
    expect(s.reason).toBe(`step "marked" failed: ${TOKEN_REFUSED_REASON}`);
  });

  it("fails a step whose script ignores the refusal on stderr, but not one that prints it on stdout", async () => {
    tokenRepo(user);
    const text = "Resource not accessible by personal access token";
    const bad = await go(mini(one("marked", `echo '${text}' >&2; echo done`)), { owner: user.id });
    expect(bad.status).toBe("failed");
    expect(bad.history[0]!.exitCode).toBe(0);
    expect(bad.reason).toBe(`step "marked" failed: ${TOKEN_REFUSED_RUN}`);
    const good = await go(mini(one("marked", `echo '${text}'`)), { owner: user.id });
    expect(good.status).toBe("succeeded");
    const limit = await go(mini(one("marked", `echo '${text} (rate limit)' >&2`)), { owner: user.id });
    expect(limit.status).toBe("succeeded");
    const server = await go(mini(one("marked", `echo '${text}' >&2; echo done`)), { owner: admin.id });
    expect(server.status).toBe("succeeded");
  });

  it("still sees a refusal that is followed by more than 20,000 characters of output", async () => {
    tokenRepo(user);
    const s = await go(mini(one("marked", "echo 'HTTP 401: Bad credentials' >&2; head -c 30000 /dev/zero | tr '\\\\0' x; echo; exit 1")), { owner: user.id });
    expect(s.reason).toBe(`step "marked" failed: ${TOKEN_REFUSED_RUN}`);
    const ok = await go(mini(one("marked", "echo 'HTTP 401: Bad credentials' >&2; head -c 30000 /dev/zero | tr '\\\\0' x; echo")), { owner: user.id });
    expect(ok.status).toBe("failed");
    expect(ok.reason).toBe(`step "marked" failed: ${TOKEN_REFUSED_RUN}`);
  });

  it("does not follow on_failure after a failed sign-in, but does after a plain failure", async () => {
    const handler = one("handler", "echo handled");
    const marked = (run: string) => mini(one("marked", run, "    on_failure: handler\n"), handler);
    addRepo(user.id, { url: "acme/nokey", method: "none" });
    const none = await go(marked("echo hi"), { owner: user.id, vars: { github_repo: "acme/nokey" } });
    expect(none.reason).toBe(`step "marked" failed: ${NEEDS_TOKEN}`);
    expect(none.history.map((h) => h.id)).toEqual(["marked"]);
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const refused = await go(marked("gh issue list"), { owner: user.id });
    expect(refused.history.map((h) => h.id)).toEqual(["marked"]);
    const plain = await go(marked("exit 1"), { owner: user.id });
    expect(plain.history.map((h) => h.id)).toEqual(["marked", "handler"]);
  });

  it("ends a run with on_failure around a sub-flow whose marked step has none", async () => {
    mkdirSync(join(gh.tmp, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(gh.tmp, ".claude-factory", "flows", "inner.yaml"), `name: inner\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${one("deep", "echo hi")}`);
    const flow = flowOf(`name: outer\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n  - id: o\n    type: flow\n    flow: inner\n    on_failure: handler\n${one("handler", "echo handled")}`);
    addRepo(user.id, { url: "acme/app", method: "none" });
    const s = await go(flow, { owner: user.id });
    expect(s.status).toBe("failed");
    expect(s.history.some((h) => h.id === "handler")).toBe(false);
    expect(classifyFailure(s)).toMatchObject({ cause: "factory" });
    expect(explainError(s.reason, "run").why).toMatch(/My repositories/);
  });
});
