import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { APP_BROKEN_RUN, APP_FAILED_RUN, APP_NOT_INSTALLED_RUN, APP_NOT_SET_UP_RUN, APP_RATE_LIMIT_RUN, APP_REFUSED_RUN, APP_TOKEN_EXPIRED, APP_UNREACHABLE_RUN } from "../src/engine/guards.js";
import { appTokenAccess } from "../src/engine/repo-access.js";
import { runFlow } from "../src/engine/runner.js";
import { explainError } from "../src/errors.js";
import { classifyFailure } from "../src/failure.js";
import { parseFlow } from "../src/flow/load.js";
import { clearTokenCache, installationToken } from "../src/github-app.js";
import { claudeBin, fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { type FakeGithubApp, fakeGithubApp } from "./helpers/github-app.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const BOT = ["ghp", ""].join("_") + "Bot".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let fake: FakeGithubApp;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh);
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  fake = fakeGithubApp();
  fake.installs.set("acme/app", 77);
  clearTokenCache();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  delete process.env.FAKE_GH_EXPECT_TOKEN;
  clearTokenCache();
  fake.restore();
  kc.remove();
  gh.restore();
});

const appRepo = (owner: { id: string }, url = "acme/app") => addRepo(owner.id, { url, method: "github-app" }, { installationId: "77" });
const runs = () => join(gh.tmp, "runs");
const cfg = (over: object = {}, extra: object = {}): Config => ConfigSchema.parse({ protected_branches: [], github_app: fake.config(over), ...extra });
const flowOf = (yaml: string) => parseFlow(yaml, "probe.yaml");
const go = (flow: ReturnType<typeof flowOf>, extra: { owner?: string; config?: Config } = {}) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: cfg(), owner: user.id, ...extra });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const one = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n    repo_access: true\n${extra}    run: ${JSON.stringify(run)}\n`;
const plain = (id: string, run: string) => `  - id: ${id}\n    type: shell\n    run: ${JSON.stringify(run)}\n`;
const mini = (...steps: string[]) => flowOf(`name: mini\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps.join("")}`);
const fileOf = (name: string) => join(gh.tmp, name);

describe("a marked step with the GitHub App", { timeout: 60_000 }, () => {
  it("gets a new token limited to the repository, as GH_TOKEN and as git's credential", async () => {
    const r = appRepo(user);
    const ask = "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill";
    const s = await go(mini(one("marked", `printf %s "$GH_TOKEN" > ${fileOf("tok")}; echo "url=$FACTORY_REPO_URL"; ${ask} | grep -E '^(username|password)=' | sed 's/^password=.*/password=SET/'; test "$(${ask} | grep '^password=' | cut -d= -f2)" = "$GH_TOKEN" && echo same`)));
    expect(s.status).toBe("succeeded");
    expect(fake.tokens).toHaveLength(1);
    expect(readFileSync(fileOf("tok"), "utf8")).toBe(fake.tokens[0]);
    expect(fake.calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/app/installations/77/access_tokens", hasBody: true, body: { repositories: ["app"] } }]);
    expect(out(s, "marked").split("\n")).toEqual([`url=${r.url}`, "username=x-access-token", "password=SET", "same"]);
  });

  it("gives nothing to the plain step and the agent step", async () => {
    appRepo(user);
    const s = await go(flowOf(`name: probe\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${one("marked", "true")}${plain("plain", 'echo "gh=${GH_TOKEN:-none} url=${FACTORY_REPO_URL:-none}"')}  - id: agent\n    type: claude\n    prompt: SHOWGH\n`));
    expect(out(s, "plain")).toBe("gh=none url=none");
    expect(out(s, "agent")).toContain("gh_token=none");
  });

  it("makes a different token for each marked step, and never stores or logs one", async () => {
    appRepo(user);
    const s = await go(mini(one("a", 'echo "$GH_TOKEN"'), one("b", 'echo "$GH_TOKEN $SCF_GIT_PASSWORD"')));
    expect(out(s, "a")).toBe("[redacted]");
    expect(out(s, "b")).toBe("[redacted] [redacted]");
    expect(fake.tokens).toHaveLength(2);
    expect(new Set(fake.tokens).size).toBe(2);
    for (const f of [...files(s.runDir), ...files(process.env.FACTORY_HOME!).filter((f) => !/credentials|keys/i.test(f))]) {
      for (const t of fake.tokens) expect(readFileSync(f, "utf8"), f).not.toContain(t);
    }
    const before = fake.calls.length;
    await installationToken(fake.config(), "77", { repository: "app" });
    expect(fake.calls.length).toBe(before + 1);
  });

  it("is used for an admin too, and replaces the bot's token in the marked step only", async () => {
    appRepo(admin);
    process.env.BOT_TOKEN_FOR_TEST = BOT;
    const s = await go(mini(one("marked", 'echo "$GH_TOKEN"'), plain("plain", 'echo "$GH_TOKEN"')), { owner: admin.id, config: cfg({}, { bot: { gh_token_env: "BOT_TOKEN_FOR_TEST" } }) });
    expect(out(s, "marked")).toBe("[redacted]");
    expect(out(s, "plain")).toBe(BOT);
    expect(fake.tokens).toHaveLength(1);
  });

  it("kills a background process of the step when it ends", async () => {
    appRepo(user);
    const pidFile = fileOf("bg.pid");
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

  it("blocks a push to main and a push with a secret", async () => {
    appRepo(user);
    const c = cfg({}, { protected_branches: ["main"], secret_scan: true });
    const prep = 'git clone -q "$FACTORY_REPO_URL" repo && cd repo && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x';
    const before = gh.remoteGit("rev-parse", "main").trim();
    const s = await go(mini(one("main_push", `${prep} && git push origin HEAD:main 2>&1`)), { config: c });
    expect(out(s, "main_push")).toContain("protected branch 'main' is blocked");
    expect(gh.remoteGit("rev-parse", "main").trim()).toBe(before);
    const leak = ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const t = await go(mini(one("secret", `${prep} && echo "k = ${leak}" > leak.js && git add leak.js && git -c user.email=t@t -c user.name=t commit -qm leak && git push origin HEAD:feature/x 2>&1`)), { config: c });
    expect(t.status).toBe("failed");
    expect(() => gh.remoteGit("rev-parse", "--verify", "feature/x")).toThrow();
  });
});

describe("a marked step that cannot get an app token", { timeout: 60_000 }, () => {
  const MARKERS = ["BODY-MARKER", "KEYFILE-MARKER"];
  const cases: [string, () => Config, (() => void) | undefined, string, boolean][] = [
    ["no app", () => ConfigSchema.parse({ protected_branches: [] }), undefined, APP_NOT_SET_UP_RUN, true],
    ["no slug", () => ConfigSchema.parse({ protected_branches: [], github_app: { app_id: fake.appId, private_key_path: fake.keyPath } }), undefined, APP_NOT_SET_UP_RUN, true],
    ["installation removed", () => cfg(), () => fake.installs.clear(), APP_NOT_INSTALLED_RUN, false],
    ["repository outside the installation", () => cfg(), () => fake.installs.set("acme/other", 77) && fake.installs.delete("acme/app"), APP_NOT_INSTALLED_RUN, false],
    ["401", () => cfg(), () => (fake.force.token = { status: 401, body: "BODY-MARKER" }), APP_BROKEN_RUN, false],
    ["missing key file", () => cfg({ private_key_path: "/nonexistent/KEYFILE-MARKER.pem" }), undefined, APP_BROKEN_RUN, false],
    ["403", () => cfg(), () => (fake.force.token = { status: 403, body: "BODY-MARKER" }), APP_REFUSED_RUN, false],
    ["429", () => cfg(), () => (fake.force.token = { status: 429 }), APP_RATE_LIMIT_RUN, false],
    ["403 limit", () => cfg(), () => (fake.force.token = { status: 403, headers: { "x-ratelimit-remaining": "0" } }), APP_RATE_LIMIT_RUN, false],
    ["500", () => cfg(), () => (fake.force.token = { status: 500, body: "BODY-MARKER" }), APP_FAILED_RUN, false],
    ["not json", () => cfg(), () => (fake.force.token = { raw: "not json" }), APP_FAILED_RUN, false],
    ["network", () => cfg(), () => (fake.force.token = "network"), APP_UNREACHABLE_RUN, false],
  ];

  it.each(cases)("%s fails with a fixed sentence and no text of GitHub or the key path", async (_name, config, setup, sentence, noCalls) => {
    appRepo(user);
    setup?.();
    const s = await go(mini(one("marked", "echo hi", "    on_failure: handler\n"), plain("handler", "echo handled")), { config: config() });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(`step "marked" failed: ${sentence}`);
    expect(s.history.map((h) => h.id)).toEqual(["marked"]);
    if (noCalls) expect(fake.calls).toEqual([]);
    expect(classifyFailure(s)).toMatchObject({ cause: "factory" });
    expect(explainError(s.reason, "run").why).not.toBe("");
    const everything = [...files(s.runDir)].map((f) => readFileSync(f, "utf8")).join("\n");
    for (const m of [...MARKERS, fake.keyPath, "/app/installations"]) expect(everything).not.toContain(m);
  });

  it("gives APP_UNREACHABLE_RUN when GitHub does not answer in time", async () => {
    fake.force.token = "hang";
    const r = appRepo(user);
    expect(r.installationId).toBe("77");
    const res = await appTokenAccess({ kind: "app", installationId: "77", url: r.url, github: "acme/app" }, cfg(), 200);
    expect(res).toEqual({ ok: false, reason: APP_UNREACHABLE_RUN });
  });
});

describe("a refused or expired app token", { timeout: 60_000 }, () => {
  it("fails with APP_REFUSED_RUN when GitHub refuses the token, without on_failure", async () => {
    appRepo(user);
    const s = await go(mini(one("marked", "echo 'HTTP 401: Bad credentials' >&2; echo done", "    on_failure: handler\n"), plain("handler", "echo handled")));
    expect(s.reason).toBe(`step "marked" failed: ${APP_REFUSED_RUN}`);
    expect(s.history.map((h) => h.id)).toEqual(["marked"]);
  });

  it("says the token ran out when a step ran past its end", async () => {
    appRepo(user);
    const token = `ghs_${"ab".repeat(18)}`;
    fake.force.token = { raw: JSON.stringify({ token, expires_at: new Date(Date.now() + 1500).toISOString() }) };
    const slow = await go(mini(one("marked", "sleep 2; echo 'HTTP 401: Bad credentials' >&2; exit 1")));
    expect(slow.reason).toBe(`step "marked" failed: ${APP_TOKEN_EXPIRED}`);
    fake.force.token = { raw: JSON.stringify({ token, expires_at: new Date(Date.now() + 600_000).toISOString() }) };
    const quick = await go(mini(one("marked", "echo 'HTTP 401: Bad credentials' >&2; exit 1")));
    expect(quick.reason).toBe(`step "marked" failed: ${APP_REFUSED_RUN}`);
    expect(existsSync(join(slow.runDir, "sign-in"))).toBe(false);
  });
});
