import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appReposPath } from "../src/auth/app-repos.js";
import { auditPath } from "../src/auth/audit.js";
import { repoAccess } from "../src/auth/repos.js";
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
const SENTENCE = "the administrator has not allowed your account to connect this repository through the GitHub App; ask the administrator, or choose another method";
const realEnv = process.env;
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
let cy: TestSession;
let n = 0;

beforeAll(async () => {
  snapshot = { ...realEnv };
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "app-repos-api-"));
  scratch = mkdtempSync(join(tmpdir(), "app-repos-scratch-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  kg = fakeKeygen();
  fg = fakeGithub();
  fake = fakeGithubApp();
  const wrap = join(fg.tmp, "gh-wrap");
  writeFileSync(wrap, `#!/bin/sh\nexec "${resolve("tests/fixtures/fake-gh.sh")}" "$@"\n`);
  chmodSync(wrap, 0o755);
  Object.assign(process.env, { TMPDIR: scratch, SCF_CONNECT_REMOTE: fg.remote, FACTORY_GH_BIN: wrap });
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  cy = await signInAs(base, { name: "Cy", email: "cy@example.com", role: "user" });
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
  expect((await call(admin, "PUT", "/api/config", { github_app: fake.config() })).status).toBe(200);
  for (const who of [ann, bob, cy]) await setList(who, []);
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const setList = async (who: TestSession, repos: unknown) => call(admin, "PUT", `/api/users/${who.user.id}/app-repos`, { repos });
const url = () => `https://github.com/acme/app${++n}`;
const install = (u: string, id = 77) => fake.installs.set(u.replace("https://github.com/", "").toLowerCase(), id);
const list = async (who: TestSession) => (await call(who, "GET", "/api/repos")).json() as { id: string; url: string; method: string; credentialId?: string; installationId?: string; connection?: unknown }[];
const addApp = async (who: TestSession, u = url()) => {
  install(u);
  const r = await call(who, "POST", "/api/repos", { url: u, method: "github-app" });
  expect(r.status).toBe(201);
  return r.json() as { id: string; url: string; installationId: string };
};
const adminRows = async () => (await call(admin, "GET", "/api/admin/repos")).json() as { id: string; offAppList?: boolean }[];

describe("the list of an account (admin only)", () => {
  it("is set and read back, normalised", async () => {
    const put = await setList(ann, ["Acme/One.git", " acme/* ", "acme/one"]);
    expect(put.status).toBe(200);
    expect(put.json()).toEqual({ repos: ["acme/one", "acme/*"] });
    expect((await call(admin, "GET", `/api/users/${ann.user.id}/app-repos`)).json()).toEqual({ repos: ["acme/one", "acme/*"] });
    expect((await call(admin, "GET", `/api/users/${bob.user.id}/app-repos`)).json()).toEqual({ repos: [] });
  });

  it("answers 400 for a bad list and 404 for an unknown account", async () => {
    for (const repos of [["acme"], ["acme/*.git"], ["*/*"], "acme/one", [1]]) expect((await setList(ann, repos)).status, JSON.stringify(repos)).toBe(400);
    expect((await call(admin, "PUT", `/api/users/${ann.user.id}/app-repos`, {})).status).toBe(400);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call(admin, "GET", `/api/users/${unknown}/app-repos`)).status).toBe(404);
    expect((await call(admin, "PUT", `/api/users/${unknown}/app-repos`, { repos: [] })).status).toBe(404);
  });

  it("is refused for a user, for the own and another account, and the list stays", async () => {
    await setList(bob, ["acme/*"]);
    for (const target of [ann, bob]) {
      expect((await call(ann, "GET", `/api/users/${target.user.id}/app-repos`)).status).toBe(403);
      expect((await call(ann, "PUT", `/api/users/${target.user.id}/app-repos`, { repos: ["acme/*"] })).status).toBe(403);
    }
    expect((await call(admin, "GET", `/api/users/${ann.user.id}/app-repos`)).json()).toEqual({ repos: [] });
    expect((await call(admin, "GET", `/api/users/${bob.user.id}/app-repos`)).json()).toEqual({ repos: ["acme/*"] });
  });

  it("writes an audit line only when the list changed", async () => {
    const lines = () => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { action: string; userId?: string; by: string }).filter((l) => l.action === "app-repos-change");
    const before = lines().length;
    await setList(cy, ["acme/one"]);
    await setList(cy, ["acme/one"]);
    const added = lines().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ userId: cy.user.id, by: admin.user.id });
  });
});

describe("adding with the app", () => {
  it("is refused for an account without a list, and GitHub is not asked", async () => {
    const u = url();
    install(u);
    const r = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(r.status).toBe(403);
    expect(r.error()).toBe(SENTENCE);
    expect(fake.calls).toEqual([]);
    expect((await list(ann)).filter((x) => x.url === u)).toEqual([]);
  });

  it("allows a listed repository, refuses another, and allows it after owner/*", async () => {
    const ok = url();
    const other = "https://github.com/acme/other";
    await setList(ann, [ok.replace("https://github.com/", "")]);
    install(ok);
    install(other);
    expect((await call(ann, "POST", "/api/repos", { url: ok, method: "github-app" })).status).toBe(201);
    fake.calls.length = 0;
    const no = await call(ann, "POST", "/api/repos", { url: other, method: "github-app" });
    expect(no.status).toBe(403);
    expect(fake.calls).toEqual([]);
    await setList(ann, ["acme/*"]);
    expect((await call(ann, "POST", "/api/repos", { url: other, method: "github-app" })).status).toBe(201);
  });

  it("answers 403 and not 409 for an off-list repository that belongs to another account", async () => {
    await setList(bob, ["acme/*"]);
    const mine = await addApp(bob);
    fake.calls.length = 0;
    const r = await call(ann, "POST", "/api/repos", { url: mine.url, method: "github-app" });
    expect(r.status).toBe(403);
    expect(r.error()).toBe(SENTENCE);
    expect(fake.calls).toEqual([]);
  });

  it("answers 403, not 400, for an unlisted user when the app is not set up (add and change of method)", async () => {
    const t = await call(ann, "POST", "/api/repos", { url: url(), method: "github-token", token: TOKEN });
    expect(t.status).toBe(201);
    expect((await call(admin, "PUT", "/api/config", {})).status).toBe(200);
    const add = await call(ann, "POST", "/api/repos", { url: url(), method: "github-app" });
    expect(add.status).toBe(403);
    expect(add.error()).toBe(SENTENCE);
    const change = await call(ann, "PUT", `/api/repos/${t.json().id}/auth`, { method: "github-app" });
    expect(change.status).toBe(403);
    // a listed user still hears that the app is not set up
    await setList(ann, ["acme/*"]);
    expect((await call(ann, "POST", "/api/repos", { url: url(), method: "github-app" })).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("does not limit an admin", async () => {
    const u = url();
    install(u);
    expect((await call(admin, "POST", "/api/repos", { url: u, method: "github-app" })).status).toBe(201);
  });

  it("does not list another account's entries in the answer", async () => {
    await setList(bob, ["secret-owner/*"]);
    const r = await call(ann, "POST", "/api/repos", { url: url(), method: "github-app" });
    expect(r.text).not.toContain("secret-owner");
    expect(r.text).not.toContain("acme/*");
  });

  it("answers 500 without asking GitHub when app-repos.json is broken", async () => {
    await setList(ann, ["acme/*"]);
    const good = readFileSync(appReposPath(), "utf8");
    writeFileSync(appReposPath(), "not json");
    const u = url();
    install(u);
    fake.calls.length = 0;
    const r = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(r.status).toBe(500);
    expect(fake.calls).toEqual([]);
    writeFileSync(appReposPath(), good);
  });

  it("saves nothing when the list is taken back while GitHub is being asked", async () => {
    await setList(ann, ["acme/*"]);
    const u = url();
    install(u);
    const inner = globalThis.fetch;
    let once = true;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (once && String(input).includes("/installation")) {
        once = false;
        expect((await setList(ann, [])).status).toBe(200);
      }
      return inner(input, init);
    });
    try {
      const r = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
      expect(r.status).toBe(403);
    } finally {
      vi.stubGlobal("fetch", inner);
    }
    expect((await list(ann)).filter((x) => x.url === u)).toEqual([]);
  });
});

describe("changing to the app", () => {
  const tokenRepo = async (who: TestSession) => {
    const r = await call(who, "POST", "/api/repos", { url: url(), method: "github-token", token: TOKEN });
    expect(r.status).toBe(201);
    return r.json() as { id: string; url: string; credentialId: string };
  };

  it("is refused off the list, with no call to GitHub, and keeps the method and token", async () => {
    const r = await tokenRepo(ann);
    install(r.url);
    fake.calls.length = 0;
    const p = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" });
    expect(p.status).toBe(403);
    expect(p.error()).toBe(SENTENCE);
    expect(fake.calls).toEqual([]);
    expect((await list(ann)).find((x) => x.id === r.id)).toMatchObject({ method: "github-token", credentialId: r.credentialId });
  });

  it("works on the list", async () => {
    const r = await tokenRepo(ann);
    install(r.url);
    await setList(ann, ["acme/*"]);
    expect((await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" })).status).toBe(200);
  });

  it("saves nothing when the list is taken back while GitHub is being asked", async () => {
    const r = await tokenRepo(ann);
    install(r.url);
    await setList(ann, ["acme/*"]);
    const inner = globalThis.fetch;
    let once = true;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (once && String(input).includes("/installation")) {
        once = false;
        expect((await setList(ann, [])).status).toBe(200);
      }
      return inner(input, init);
    });
    try {
      expect((await call(ann, "PUT", `/api/repos/${r.id}/auth`, { method: "github-app" })).status).toBe(403);
    } finally {
      vi.stubGlobal("fetch", inner);
    }
    expect((await list(ann)).find((x) => x.id === r.id)).toMatchObject({ method: "github-token", credentialId: r.credentialId });
  });
});

describe("existing connections", () => {
  it("are not tested for their owner once off the list, and the admin can test them", async () => {
    await setList(ann, ["acme/*"]);
    const r = await addApp(ann);
    await call(ann, "POST", `/api/repos/${r.id}/test`, {});
    const before = (await list(ann)).find((x) => x.id === r.id)!;
    await setList(ann, []);
    fake.calls.length = 0;
    install(r.url, 555);
    const t = await call(ann, "POST", `/api/repos/${r.id}/test`, {});
    expect(t.status).toBe(403);
    expect(t.error()).toBe(SENTENCE);
    expect(fake.calls).toEqual([]);
    const after = (await list(ann)).find((x) => x.id === r.id)!;
    expect(after.connection).toEqual(before.connection);
    expect(after.installationId).toBe("77");
    expect((await call(admin, "POST", `/api/repos/${r.id}/test`, {})).status).toBe(200);
  });

  it("keep working in runs and with another form of the address", async () => {
    await setList(ann, ["acme/*"]);
    const r = await addApp(ann);
    await setList(ann, []);
    expect(repoAccess(ann.user.id, r.url.replace("https://github.com/", ""))).toMatchObject({ kind: "app", installationId: "77" });
    fake.calls.length = 0;
    const p = await call(ann, "PUT", `/api/repos/${r.id}/auth`, { url: r.url.replace("github.com/acme", "github.com/Acme") });
    expect(p.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });
});

describe("the admin's repository list", () => {
  it("marks an off-list app repository of a user, and only that", async () => {
    await setList(ann, ["acme/*"]);
    const on = await addApp(ann);
    const off = await addApp(ann);
    await setList(ann, [on.url.replace("https://github.com/", "")]);
    const adminOwn = await addApp(admin);
    const token = (await call(ann, "POST", "/api/repos", { url: url(), method: "github-token", token: TOKEN })).json() as { id: string };
    const rows = await adminRows();
    const row = (id: string) => rows.find((x) => x.id === id)!;
    expect(row(off.id).offAppList).toBe(true);
    expect(row(on.id).offAppList).toBeUndefined();
    expect(row(adminOwn.id).offAppList).toBeUndefined();
    expect(row(token.id).offAppList).toBeUndefined();
  });

  it("marks a repository that was transferred to a user without a list", async () => {
    const r = await addApp(admin);
    const t = await call(admin, "POST", `/api/admin/repos/${r.id}/transfer`, { email: "cy@example.com" });
    expect(t.status).toBe(200);
    expect(t.json().offAppList).toBe(true);
    expect((await adminRows()).find((x) => x.id === r.id)!.offAppList).toBe(true);
  });
});
