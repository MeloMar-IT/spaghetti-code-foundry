import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKEN_MISSING, TOKEN_UNREADABLE, addRepo, getRepo, reposPath, setRepoAuth } from "../src/auth/repos.js";
import { createUser, setStatus, usersPath } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { credentialsPath, listCredentials, removeCredential } from "../src/credentials/store.js";
import { APP_BROKEN_RUN, APP_FAILED_RUN, APP_NOT_INSTALLED_RUN, APP_NOT_SET_UP_RUN, APP_RATE_LIMIT_RUN, APP_UNREACHABLE_RUN } from "../src/engine/guards.js";
import { clearTokenCache } from "../src/github-app.js";
import { DATA_UNREADABLE, NOT_CONNECTED, OWNER_BLOCKED, REREAD_MS, RENEW_MS, SIGN_IN_PREFIX, repoGhIdentity } from "../src/queue/gh-identity.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { type FakeGithubApp, fakeGithubApp } from "./helpers/github-app.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let app: FakeGithubApp;
let admin: { id: string };
let user: { id: string };
let time: number;
const config = (): Config => ConfigSchema.parse({ protected_branches: [], github_app: app.config() });
const identity = (repoId: string, cfg: () => Config = config) => repoGhIdentity(repoId, { config: cfg, now: () => time });
const sentence = (s: string) => `${SIGN_IN_PREFIX}${s}`;

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  app = fakeGithubApp();
  app.installs.set("acme/app", 77);
  clearTokenCache();
  time = Date.now();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  clearTokenCache();
  app.restore();
  kc.remove();
  gh.restore();
});

const tokenRepo = (owner: { id: string }, token = TOKEN) => addRepo(owner.id, { url: "acme/app", method: "github-token", token });
const appRepo = (owner: { id: string }) => addRepo(owner.id, { url: "acme/app", method: "github-app" }, { installationId: "77" });
const rejects = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: Error) => e.message)) ?? "";

describe("a repository's token", () => {
  it("makes a frozen session with the token and an empty settings folder", async () => {
    const id = identity(tokenRepo(user).id);
    const s = await id.prepare();
    expect(s.env?.GH_TOKEN).toBe(TOKEN);
    expect(s.env?.GITHUB_TOKEN).toBeUndefined();
    expect(s.env?.GH_ENTERPRISE_TOKEN).toBeUndefined();
    const dir = s.env!.GH_CONFIG_DIR!;
    expect(readdirSync(dir)).toEqual([]);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.env)).toBe(true);
    expect(id.usesHostLogin()).toBe(false);
    id.dispose();
    expect(existsSync(dir)).toBe(false);
    expect((await id.prepare()).env?.GH_CONFIG_DIR).toBeTruthy();
    id.dispose();
  });

  it("method none with an admin owner is the host login", async () => {
    const id = identity(addRepo(admin.id, "acme/app").id);
    const s = await id.prepare();
    expect(s.env).toBeUndefined();
    expect(s.stamp).toBe("host");
    expect(id.usesHostLogin()).toBe(true);
  });

  it("has a sentence for a user's repository with none, a blocked owner, a removed repository and the methods that cannot call the API", async () => {
    const none = addRepo(user.id, "acme/app");
    expect(await rejects(identity(none.id).prepare())).toMatch(new RegExp(`^${SIGN_IN_PREFIX}.*admin`));
    const t = addRepo(user.id, { url: "acme/web", method: "github-token", token: TOKEN });
    await setStatus(user.id, "blocked");
    const blocked = identity(t.id);
    expect(await rejects(blocked.prepare())).toBe(sentence(OWNER_BLOCKED));
    expect(await rejects(identity("00000000-0000-4000-8000-000000000000").prepare())).toBe(sentence(NOT_CONNECTED));
    const https = addRepo(user.id, { url: "acme/other", method: "https-token", username: "u", token: TOKEN2 });
    expect(await rejects(identity(https.id).prepare())).toMatch(/cannot call the GitHub API/);
  });

  it("a removed credential gives the sentence, and the next check works again after the token is set", async () => {
    const r = tokenRepo(user);
    const id = identity(r.id);
    await id.prepare();
    removeCredential(user.id, getRepo(r.id)!.credentialId!);
    expect(await rejects(id.prepare())).toBe(sentence(TOKEN_MISSING));
    setRepoAuth(user.id, r.id, { method: "github-token", token: TOKEN2 });
    expect((await id.prepare()).env?.GH_TOKEN).toBe(TOKEN2);
  });

  it("a replaced token is used at the next prepare; a session made before keeps the old one", async () => {
    const r = tokenRepo(user);
    const id = identity(r.id);
    const before = await id.prepare();
    setRepoAuth(user.id, r.id, { method: "github-token", token: TOKEN2 });
    const after = await id.prepare();
    expect(before.env?.GH_TOKEN).toBe(TOKEN);
    expect(after.env?.GH_TOKEN).toBe(TOKEN2);
    expect(after.stamp).not.toBe(before.stamp);
  });

  it("does not write the credentials file on every check, and sets 'last used' at most once an hour", async () => {
    const r = tokenRepo(user);
    const id = identity(r.id);
    await id.prepare();
    const file = readFileSync(credentialsPath(), "utf8");
    const mtime = statSync(credentialsPath()).mtimeMs;
    const used = listCredentials(user.id)[0]!.lastUsed;
    expect(used).toBeTruthy();
    for (let i = 0; i < 10; i++) await id.prepare();
    expect(readFileSync(credentialsPath(), "utf8")).toBe(file);
    expect(statSync(credentialsPath()).mtimeMs).toBe(mtime);
    time += REREAD_MS + 1000;
    await new Promise((r2) => setTimeout(r2, 20));
    await id.prepare();
    expect(readFileSync(credentialsPath(), "utf8")).not.toBe(file);
    expect(listCredentials(user.id)[0]!.lastUsed).not.toBe(used);
  });

  it("an unreadable Keychain key gives the sentence, and it works again when the key is back", async () => {
    const r = tokenRepo(user);
    const id = identity(r.id);
    kc.fail("find");
    expect(await rejects(id.prepare())).toBe(sentence(TOKEN_UNREADABLE));
    kc.fail();
    expect((await id.prepare()).env?.GH_TOKEN).toBe(TOKEN);
  });

  it("an invalid store file gives a fixed sentence with no path and no content", async () => {
    const r = tokenRepo(user);
    const id = identity(r.id);
    await id.prepare();
    for (const path of [reposPath(), usersPath(), credentialsPath()]) {
      const old = readFileSync(path, "utf8");
      writeFileSync(path, "SECRET-CONTENT not json");
      const msg = await rejects(id.prepare());
      expect(msg).toMatch(new RegExp(`^${SIGN_IN_PREFIX}`));
      expect(msg).not.toContain("SECRET-CONTENT");
      expect(msg).not.toContain(process.env.FACTORY_HOME!);
      if (path !== credentialsPath()) expect(msg).toBe(sentence(DATA_UNREADABLE));
      writeFileSync(path, old);
    }
  });
});

describe("a repository's GitHub App", () => {
  it("asks for a token limited to this repository, once for many calls, and renews it before it ends", async () => {
    const id = identity(appRepo(user).id);
    const [a, b] = await Promise.all([id.prepare(), id.prepare()]);
    await id.prepare();
    const tokenCalls = () => app.calls.filter((c) => c.path.endsWith("/access_tokens"));
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.body).toEqual({ repositories: ["app"] });
    expect(a).toBe(b);
    expect(a.app).toBe(true);
    expect(a.env?.GH_TOKEN).toBe(app.tokens[0]);
    time += 3_600_000 - RENEW_MS + 1000;
    const c = await id.prepare();
    expect(tokenCalls()).toHaveLength(2);
    expect(c.stamp).toBe(a.stamp);
    expect(c.env?.GH_TOKEN).toBe(app.tokens[1]);
  });

  const cases: [string, Parameters<typeof Object>[0], string][] = [
    ["404", { status: 404 }, APP_NOT_INSTALLED_RUN],
    ["401", { status: 401 }, APP_BROKEN_RUN],
    ["network", "network", APP_UNREACHABLE_RUN],
    ["rate limit", { status: 429 }, APP_RATE_LIMIT_RUN],
    ["no token in the answer", { raw: "{}" }, APP_FAILED_RUN],
  ];
  it.each(cases)("a failing token request (%s) gives its sentence only", async (_n, forced, expected) => {
    const id = identity(appRepo(user).id);
    app.force.token = forced as never;
    const msg = await rejects(id.prepare());
    expect(msg).toBe(sentence(expected));
    expect(msg).not.toContain(app.keyPath);
  });

  it("a cached token is not used after the app is removed or replaced in the settings", async () => {
    let cfg = config();
    const id = identity(appRepo(user).id, () => cfg);
    const first = await id.prepare();
    cfg = ConfigSchema.parse({ protected_branches: [] });
    expect(await rejects(id.prepare())).toBe(sentence(APP_NOT_SET_UP_RUN));
    cfg = ConfigSchema.parse({ protected_branches: [], github_app: app.config({ app_id: "999" }) });
    const calls = app.calls.length;
    await rejects(id.prepare()); // another app id: its JWT is refused by the fake, but a new request is made
    expect(app.calls.length).toBeGreaterThan(calls);
    expect(first.stamp).toBe(`app:${app.appId}:77`);
  });

  it("an app that is not set up gives its sentence", async () => {
    const id = identity(appRepo(user).id, () => ConfigSchema.parse({ protected_branches: [] }));
    expect(await rejects(id.prepare())).toBe(sentence(APP_NOT_SET_UP_RUN));
  });
});
