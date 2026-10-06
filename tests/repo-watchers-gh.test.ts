import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, getRepo, setRepoAuth } from "../src/auth/repos.js";
import { saveConfig } from "../src/config.js";
import { removeCredential } from "../src/credentials/store.js";
import { SIGN_IN_PREFIX } from "../src/queue/gh-identity.js";
import { startServer } from "../src/server/server.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const tok = (s: string) => ["github", "pat", ""].join("_") + s.repeat(12);
const TOKEN_A = tok("Aa1");
const TOKEN_B = tok("Bb2");

let gh: ReturnType<typeof fakeGithub>;
let auth: ReturnType<ReturnType<typeof fakeGithub>["authLog"]>;
let home: string;
let saved: string | undefined;
let kc: ReturnType<typeof fakeKeychain>;

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let admin: TestSession;
let ann: TestSession;
let logs: string[];

beforeEach(async () => {
  gh = fakeGithub();
  auth = gh.authLog();
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repo-watchers-gh-"));
  process.env.FACTORY_HOME = home;
  Object.assign(process.env, { GH_TOKEN: "host-token", GITHUB_TOKEN: "host-github", GH_ENTERPRISE_TOKEN: "host-enterprise" });
  logs = [];
  kc = fakeKeychain();
  ({ close, ctx } = await startServer({ repo: gh.tmp, runsDir: join(gh.tmp, "runs"), port, claudeBin, watcherRetryMs: 50, log: (m) => void logs.push(m) }));
  ctx.scheduler.drain();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
});
afterEach(async () => {
  close();
  await new Promise((r) => setTimeout(r, 300)); // a fake gh call may still be writing
  kc.remove();
  gh.restore();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: () => r.text(), json: () => r.json() as Promise<any> };
};
const addWatcher = (repoId: string, id: string) => call(admin, "POST", `/api/admin/repos/${repoId}/watchers`, { id });
const watcher = (id: string) => ctx.watchers.tracked().find((t) => t.watcher.id === id)!;
const firstChecks = async () => {
  for (let i = 0; i < 100 && !ctx.watchers.tracked().every((t) => t.status.lastTick); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
};
const issues = () => {
  const l = [{ name: "claude-factory" }];
  process.env.FAKE_GH_ISSUES_BY_REPO = JSON.stringify({ "acme/app": [{ number: 5, title: "five", labels: l, body: "" }], "acme/web": [{ number: 4, title: "four", labels: l, body: "" }] });
};

describe("a stored watcher's GitHub calls", () => {
  it("two repositories, two tokens: each watcher sends only its own, with an empty settings folder", async () => {
    issues();
    process.env.FAKE_GH_TOKEN_BY_REPO = JSON.stringify({ "acme/app": TOKEN_A, "acme/web": TOKEN_B });
    const a = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN_A });
    const b = addRepo(admin.user.id, { url: "acme/web", method: "github-token", token: TOKEN_B });
    await addWatcher(a.id, "app-w");
    await addWatcher(b.id, "web-w");
    await firstChecks();
    for (const [id, token, repo] of [["app-w", TOKEN_A, "acme/app"], ["web-w", TOKEN_B, "acme/web"]] as const) {
      auth.clear();
      expect((await call(admin, "POST", `/api/watchers/${id}/tick`, {})).status).toBe(200);
      const rows = auth.rows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.token === token && r.githubToken === "-" && r.enterpriseToken === "-" && r.configDir === "0")).toBe(true);
      expect(rows.some((r) => r.args.includes(`--repo ${repo}`))).toBe(true);
      expect(watcher(id).status.lastError).toBeUndefined();
    }
  });

  it("a watcher of config.yaml keeps the host login, next to a stored one on the same repository", async () => {
    issues();
    const a = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN_A });
    await addWatcher(a.id, "app-w");
    saveConfig({ ...(await (await call(admin, "GET", "/api/config")).json()), watchers: [{ id: "file-w", github_repo: "acme/app", label: "other-label" }] });
    ctx.reloadConfig();
    ctx.watchers.sync();
    await firstChecks();
    auth.clear();
    await call(admin, "POST", "/api/watchers/file-w/tick", {});
    expect(auth.rows().length).toBeGreaterThan(0);
    expect(auth.rows().every((r) => r.token === "host-token" && r.githubToken === "host-github" && r.configDir === "host")).toBe(true);
    auth.clear();
    await call(admin, "POST", "/api/watchers/app-w/tick", {});
    expect(auth.rows().every((r) => r.token === TOKEN_A && r.githubToken === "-")).toBe(true);
  });

  it("method none with an admin owner uses the host login", async () => {
    issues();
    const r = addRepo(admin.user.id, { url: "acme/web" });
    await addWatcher(r.id, "web-w");
    await firstChecks();
    auth.clear();
    await call(admin, "POST", "/api/watchers/web-w/tick", {});
    expect(auth.rows().length).toBeGreaterThan(0);
    expect(auth.rows().every((x) => x.token === "host-token" && x.configDir === "host")).toBe(true);
  });

  it("moves to the host board when the method changes to none", async () => {
    issues();
    const a = addRepo(admin.user.id, { url: "acme/web", method: "github-token", token: TOKEN_B });
    await addWatcher(a.id, "web-w");
    await firstChecks();
    auth.clear();
    setRepoAuth(admin.user.id, a.id, { method: "none" });
    ctx.watchers.sync();
    await new Promise((r) => setTimeout(r, 300));
    await call(admin, "POST", "/api/watchers/web-w/tick", {});
    const rows = auth.rows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.token === "host-token" && x.configDir === "host")).toBe(true);
    // the old board's entry is gone from the file
    const file = join(process.env.FACTORY_HOME!, "status-comments.json");
    expect(existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8"))).filter((k) => k.includes("#")) : []).toEqual([]);
  });

  it("a removed credential fails the check with a sentence and makes no call; it works again once the token is set", async () => {
    issues();
    const a = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN_A });
    await addWatcher(a.id, "app-w");
    await firstChecks();
    removeCredential(ann.user.id, getRepo(a.id)!.credentialId!);
    auth.clear();
    const before = watcher("app-w").status.errorCount ?? 0;
    await call(admin, "POST", "/api/watchers/app-w/tick", {});
    expect(watcher("app-w").status.lastError).toMatch(new RegExp(`^${SIGN_IN_PREFIX}`));
    expect(watcher("app-w").status.errorCount).toBeGreaterThan(before);
    expect(auth.rows()).toEqual([]);
    setRepoAuth(ann.user.id, a.id, { method: "github-token", token: TOKEN_B });
    await call(admin, "POST", "/api/watchers/app-w/tick", {});
    expect(watcher("app-w").status.lastError).toBeUndefined();
    expect(auth.rows().every((r) => r.token === TOKEN_B)).toBe(true);
  });

  it("a token GitHub refuses fails the check with the 401 line and no token in the error", async () => {
    issues();
    const a = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN_A });
    await addWatcher(a.id, "app-w");
    await firstChecks();
    process.env.FAKE_GH_TOKEN_BY_REPO = JSON.stringify({ "acme/app": TOKEN_B });
    await call(admin, "POST", "/api/watchers/app-w/tick", {});
    const err = watcher("app-w").status.lastError ?? "";
    expect(err).toContain("401");
    expect(err).not.toContain(TOKEN_A);
  });

  it("hides the token in the log, the watcher list and the status when gh's error holds it", async () => {
    issues();
    const a = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN_A });
    await addWatcher(a.id, "app-w");
    await firstChecks();
    process.env.FAKE_GH_FAIL = "issue list";
    process.env.FAKE_GH_FAIL_TEXT = `denied for ${TOKEN_A}`;
    await call(admin, "POST", "/api/watchers/app-w/tick", {});
    expect(watcher("app-w").status.lastError).toBeTruthy();
    const everything = [logs.join("\n"), await (await call(admin, "GET", "/api/watchers")).text(), JSON.stringify(watcher("app-w").status)].join("\n");
    expect(everything).not.toContain(TOKEN_A);
  });
});
