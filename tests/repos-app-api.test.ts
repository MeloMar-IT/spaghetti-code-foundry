import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache } from "../src/github-app.js";
import { startServer } from "../src/server/server.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { type FakeGithubApp, fakeGithubApp } from "./helpers/github-app.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const realEnv = process.env; // fakeGithub().restore() swaps in a copy; os.tmpdir() reads the real one
let snapshot: NodeJS.ProcessEnv;
let tmp: string;
let scratch: string;
let close: () => void;
let kc: FakeKeychain;
let kg: FakeKeygen;
let fg: ReturnType<typeof fakeGithub>;
let fake: FakeGithubApp;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let ghEnvLog: string;
const logs: string[] = [];
const seen: string[] = [];
let n = 0;

beforeAll(async () => {
  snapshot = { ...realEnv };
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "repos-app-api-"));
  scratch = mkdtempSync(join(tmpdir(), "connect-app-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  kg = fakeKeygen();
  fg = fakeGithub();
  fake = fakeGithubApp();
  // a gh that writes down the token it got, then acts as the fake gh
  ghEnvLog = join(fg.tmp, "gh-token.log");
  writeFileSync(ghEnvLog, "");
  const wrap = join(fg.tmp, "gh-wrap");
  writeFileSync(wrap, `#!/bin/sh\necho "GH_TOKEN=$GH_TOKEN|CONFIG=$GH_CONFIG_DIR" >> "${ghEnvLog}"\nexec "${resolve("tests/fixtures/fake-gh.sh")}" "$@"\n`);
  chmodSync(wrap, 0o755);
  Object.assign(process.env, { TMPDIR: scratch, SCF_CONNECT_REMOTE: fg.remote, FACTORY_GH_BIN: wrap });
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  // the admin lets both accounts connect any acme repository through the app
  for (const who of [ann, bob]) expect((await call(admin, "PUT", `/api/users/${who.user.id}/app-repos`, { repos: ["acme/*"] })).status).toBe(200);
});
afterAll(() => {
  close();
  fake.restore();
  fg.restore();
  kg.remove();
  kc.remove();
  process.env = realEnv;
  for (const k of Object.keys(realEnv)) if (!(k in snapshot)) delete realEnv[k];
  Object.assign(realEnv, snapshot);
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  clearTokenCache();
  fake.calls.length = 0;
  fake.force = {};
  logs.length = 0;
  await setApp(fake.config());
});
afterEach(() => {
  delete process.env.FAKE_GH_EXPECT_TOKEN;
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  // the admin's own settings answers show the key path on purpose; everything else must not
  if (path !== "/api/config") seen.push(text);
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
/** Saves the app settings through the admin API (undefined: no app). */
const setApp = async (github_app: object | undefined) => {
  expect((await call(admin, "PUT", "/api/config", github_app ? { github_app } : {})).status).toBe(200);
};
const url = () => `https://github.com/acme/app${++n}`;
const install = (u: string, id = 77) => fake.installs.set(u.replace("https://github.com/", "").toLowerCase(), id);
const list = async (who: TestSession) => (await call(who, "GET", "/api/repos")).json() as { id: string; url: string; method: string; credentialId?: string; installationId?: string; connection?: { ok: boolean; checks: { check: string; code: string }[] } }[];
const addApp = async (who: TestSession, u = url(), id = 77) => {
  install(u, id);
  const r = await call(who, "POST", "/api/repos", { url: u, method: "github-app" });
  expect(r.status).toBe(201);
  return r.json() as { id: string; url: string; installationId: string };
};
const testIt = (who: TestSession, id: string) => call(who, "POST", `/api/repos/${id}/test`, {});

describe("GET /api/repos/methods", () => {
  it("lists the methods and the install link when the app is set up", async () => {
    for (const [who, none] of [[ann, false], [admin, true]] as const) {
      const r = await call(who, "GET", "/api/repos/methods");
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({
        methods: [...(none ? ["none"] : []), "github-token", "https-token", "ssh-deploy-key", "github-app"],
        githubApp: { available: true, installUrl: `https://github.com/apps/${fake.slug}/installations/new` },
      });
    }
  });

  it("says the app is not available when it is not set up, and never shows the app's id or key", async () => {
    for (const app of [undefined, { app_id: fake.appId, private_key_path: fake.keyPath }]) {
      await setApp(app);
      for (const who of [ann, admin]) {
        const r = await call(who, "GET", "/api/repos/methods");
        expect(r.json().githubApp).toEqual({ available: false });
        expect(r.json().methods).not.toContain("github-app");
        expect(r.text).not.toContain(fake.appId);
        expect(r.text).not.toContain(fake.keyPath);
      }
    }
    await setApp(fake.config());
    const on = await call(ann, "GET", "/api/repos/methods");
    expect(on.text).not.toContain(fake.appId);
    expect(on.text).not.toContain(fake.keyPath);
  });

  it("does not let a user read the app settings", async () => {
    expect((await call(ann, "GET", "/api/config")).status).toBe(403);
    expect((await call(ann, "PUT", "/api/config", { github_app: fake.config() })).status).toBe(403);
  });
});

describe("adding with the GitHub App", () => {
  it("answers 400 when the app is not set up, and saves nothing", async () => {
    await setApp(undefined);
    const u = url();
    install(u);
    const r = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(r.status).toBe(400);
    expect(r.error()).toContain("not set up");
    expect(fake.calls).toEqual([]);
    expect((await list(ann)).filter((x) => x.url === u)).toEqual([]);
  });

  it("answers 409 when the app is not installed, and saves nothing", async () => {
    const u = url();
    const r = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(r.status).toBe(409);
    expect(r.error()).toContain("not installed on this repository");
    expect((await list(ann)).filter((x) => x.url === u)).toEqual([]);
  });

  it("saves the installation id, with no credential, and ignores an id from the client", async () => {
    const u = url();
    install(u, 4242);
    const r = await call(ann, "POST", "/api/repos", { url: u, method: "github-app", installationId: "999", credentialId: "x" });
    expect(r.status).toBe(201);
    expect(r.json()).toMatchObject({ method: "github-app", installationId: "4242" });
    expect(r.json().credentialId).toBeUndefined();
    expect(JSON.stringify(fake.calls)).not.toContain("999");
    expect((await call(ann, "GET", "/api/credentials")).json().filter((c: { name: string }) => c.name.includes(r.json().id))).toEqual([]);
  });

  it("makes no call to GitHub for a request the server refuses itself", async () => {
    const own = await addApp(ann);
    const cases: [number, object][] = [
      [400, { url: "file:///x" }],
      [400, { url: "git@github.com:acme/ssh.git" }],
      [400, { url: "https://gitlab.com/acme/x" }],
      [400, { url: url(), token: TOKEN }],
      [400, { url: url(), username: "ann" }],
      [409, { url: own.url }],
    ];
    for (const [status, body] of cases) {
      fake.calls.length = 0;
      const r = await call(ann, "POST", "/api/repos", { method: "github-app", ...body });
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(fake.calls, JSON.stringify(body)).toEqual([]);
    }
    fake.calls.length = 0;
    const taken = await call(bob, "POST", "/api/repos", { url: own.url, method: "github-app" });
    expect(taken.status).toBe(409);
    expect(fake.calls).toEqual([]);
  });

  it("answers 502 when GitHub is down and 500 when the app is broken, with a fixed word in the log", async () => {
    const u = url();
    install(u);
    fake.force.lookup = "network";
    const down = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(down.status).toBe(502);
    expect(logs).toContain("repos: github-app unreachable");
    fake.force.lookup = { status: 401, body: "SECRET-GITHUB-TEXT" };
    const broken = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(broken.status).toBe(500);
    expect(broken.text).not.toContain("SECRET-GITHUB-TEXT");
    expect(logs).toContain("repos: github-app app-broken");
    expect((await list(ann)).filter((x) => x.url === u)).toEqual([]);
  });
});

describe("changing to the GitHub App", () => {
  const tokenRepo = async (who: TestSession) => {
    const r = await call(who, "POST", "/api/repos", { url: url(), method: "github-token", token: TOKEN });
    expect(r.status).toBe(201);
    return r.json() as { id: string; url: string; credentialId: string };
  };
  const creds = async (who: TestSession) => (await call(who, "GET", "/api/credentials")).json() as { id: string }[];

  it("wipes the token of the old method", async () => {
    const r = await tokenRepo(ann);
    install(r.url);
    const p = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" });
    expect(p.status).toBe(200);
    expect(p.json()).toMatchObject({ method: "github-app", installationId: "77" });
    expect(p.json().credentialId).toBeUndefined();
    expect((await creds(ann)).map((c) => c.id)).not.toContain(r.credentialId);
  });

  it("makes no call to GitHub for a request the server refuses itself", async () => {
    const r = await tokenRepo(ann);
    install(r.url);
    const other = await tokenRepo(bob);
    const cases: [number, string, object][] = [
      [404, "00000000-0000-4000-8000-000000000000", {}],
      [404, other.id, {}],
      [400, r.id, { url: "acme/else" }],
      [400, r.id, { token: TOKEN }],
      [400, r.id, { username: "ann" }],
      [400, r.id, { newKey: true }],
    ];
    for (const [status, id, extra] of cases) {
      fake.calls.length = 0;
      const p = await call(ann, "PUT", `/api/repos/${id}/auth`, { method: "github-app", ...extra });
      expect(p.status, JSON.stringify(extra)).toBe(status);
      expect(fake.calls, JSON.stringify(extra)).toEqual([]);
    }
  });

  it("answers 409 when the app is not installed there, and keeps the old method", async () => {
    const r = await tokenRepo(ann);
    const p = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" });
    expect(p.status).toBe(409);
    expect((await list(ann)).find((x) => x.id === r.id)).toMatchObject({ method: "github-token", credentialId: r.credentialId });
  });

  it("reports an old key left in the Keychain, and the repeat finishes and keeps the id", async () => {
    const r = await tokenRepo(ann);
    install(r.url, 91);
    kc.fail("delete");
    const first = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" });
    kc.fail();
    expect(first.status).toBe(500);
    expect(first.error()).toContain("an old key is still in the Keychain");
    const again = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" });
    expect(again.status).toBe(200);
    expect(again.json().installationId).toBe("91");
  });

  it("asks GitHub nothing when only another form of the address comes, and keeps the id", async () => {
    const r = await addApp(ann);
    fake.calls.length = 0;
    const p = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { url: r.url.replace("github.com/acme", "github.com/Acme") });
    expect(p.status).toBe(200);
    expect(p.json().installationId).toBe("77");
    expect(fake.calls).toEqual([]);
  });

  it("moves to the new owner with the method and the id", async () => {
    const r = await addApp(ann);
    const t = await call(admin, "POST", `/api/admin/repos/${r.id}/transfer`, { email: "bob@example.com" });
    expect(t.status).toBe(200);
    expect(t.json()).toMatchObject({ method: "github-app", installationId: "77" });
    expect((await list(bob)).map((x) => x.id)).toContain(r.id);
  });
});

describe("testing the connection", () => {
  const tokenCalls = () => fake.calls.filter((c) => c.path.endsWith("/access_tokens"));
  const tokensSeenByGh = () => readFileSync(ghEnvLog, "utf8").split("\n").filter(Boolean).map((l) => /^GH_TOKEN=([^|]*)\|CONFIG=(.*)$/.exec(l)!);

  it("passes the three checks with a token limited to this repository, which gh gets through its environment", async () => {
    const r = await addApp(ann);
    fake.calls.length = 0;
    writeFileSync(ghEnvLog, "");
    const t = await testIt(ann, r.id);
    expect(t.status).toBe(200);
    expect(t.json().ok).toBe(true);
    expect(t.json().checks.map((c: { check: string; ok: boolean }) => [c.check, c.ok])).toEqual([["clone", true], ["push", true], ["github-api", true]]);
    expect(tokenCalls().map((c) => c.body)).toEqual([{ repositories: [r.url.split("/").pop()] }]);
    const gh = tokensSeenByGh();
    expect(gh.length).toBeGreaterThan(0);
    for (const m of gh) {
      expect(m[1]).toBe(fake.tokens.at(-1));
      expect(m[2]).not.toBe("");
    }
    expect((await list(ann)).find((x) => x.id === r.id)!.connection).toMatchObject({ ok: true });
  });

  it("asks for a token at every test", async () => {
    const r = await addApp(ann);
    fake.calls.length = 0;
    await testIt(ann, r.id);
    await testIt(ann, r.id);
    expect(tokenCalls()).toHaveLength(2);
    expect(fake.calls.filter((c) => c.path.endsWith("/installation"))).toHaveLength(2);
  });

  it("says so when the app was uninstalled, saves the result and logs a fixed word", async () => {
    const r = await addApp(ann);
    fake.installs.delete(r.url.replace("https://github.com/", "").toLowerCase());
    const t = await testIt(ann, r.id);
    expect(t.status).toBe(200);
    expect(t.json().ok).toBe(false);
    expect(t.json().checks[0]).toMatchObject({ check: "clone", code: "app-not-installed" });
    expect(t.json().checks.slice(1).every((c: { skipped?: boolean }) => c.skipped)).toBe(true);
    expect((await list(ann)).find((x) => x.id === r.id)!.connection!.checks[0]!.code).toBe("app-not-installed");
    expect(logs).toContain("repos: test clone app-not-installed");
  });

  it("stores a new installation id", async () => {
    const r = await addApp(ann);
    install(r.url, 555);
    expect((await testIt(ann, r.id)).status).toBe(200);
    expect((await list(ann)).find((x) => x.id === r.id)!.installationId).toBe("555");
  });

  it("saves a failed result for a token answer that is not a token", async () => {
    const r = await addApp(ann);
    fake.force.token = { raw: "{}" };
    const t = await testIt(ann, r.id);
    expect(t.status).toBe(200);
    expect(t.json().checks[0]).toMatchObject({ code: "failed" });
    expect((await list(ann)).find((x) => x.id === r.id)!.connection!.ok).toBe(false);
  });

  it("says the app is not set up after the admin removed it", async () => {
    const r = await addApp(ann);
    await setApp(undefined);
    fake.calls.length = 0;
    const t = await testIt(ann, r.id);
    expect(t.json().checks[0]).toMatchObject({ code: "app-not-set-up" });
    expect(fake.calls).toEqual([]);
  });

  it("holds no token, JWT or line of the key in any answer or log", async () => {
    const all = seen.join("\n") + logs.join("\n") + readFileSync(ghEnvLog, "utf8").replace(/GH_TOKEN=[^|]*/g, "");
    for (const token of fake.tokens) expect(all).not.toContain(token);
    expect(all).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}\./);
    for (const line of fake.pem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"))) expect(all).not.toContain(line);
    expect(all).not.toContain(fake.keyPath);
  });
});
