import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { appJwt, identityEnv } from "../src/engine/guards.js";
import { liveLogFile } from "../src/engine/state.js";
import { runFlow } from "../src/engine/runner.js";
import { classifyFailure } from "../src/failure.js";
import { parseFlow } from "../src/flow/load.js";
import { GithubAppError, clearTokenCache, installUrl, installationToken, installationTokenInfo, limited, repoApp, repoInstallation } from "../src/github-app.js";
import { type FakeGithubApp, fakeGithubApp } from "./helpers/github-app.js";

let fake: FakeGithubApp;
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
const app = () => ({ app_id: fake.appId, private_key_path: fake.keyPath });

beforeEach(() => {
  clearTokenCache();
  fake = fakeGithubApp();
  fake.installs.set("acme/app", 77);
  fake.installs.set("acme/other", 77);
  fake.installs.set("acme/solo", 78);
});
afterEach(() => fake.restore());

describe("the github_app setting", () => {
  it("loads the old shape and the new one without an installation id", () => {
    expect(cfg({ github_app: { app_id: "1", installation_id: "2", private_key_path: "/k" } }).github_app).toEqual({ app_id: "1", installation_id: "2", private_key_path: "/k" });
    expect(cfg({ github_app: { app_id: "1", private_key_path: "/k", slug: "my-app" } }).github_app?.installation_id).toBeUndefined();
  });
  it("refuses a slug with a slash or a space", () => {
    for (const slug of ["a/b", "a b", "", "a?b"]) expect(() => cfg({ github_app: { app_id: "1", private_key_path: "/k", slug } }), slug).toThrow();
  });
  it("sets the app up for the repository method only with an id and a slug", () => {
    expect(repoApp(cfg())).toBeUndefined();
    expect(repoApp(cfg({ github_app: { app_id: "1", private_key_path: "/k" } }))).toBeUndefined();
    expect(repoApp(cfg({ github_app: { app_id: "", private_key_path: "/k", slug: "x" } }))).toBeUndefined();
    for (const private_key_path of ["", "  "]) expect(repoApp(cfg({ github_app: { app_id: "1", private_key_path, slug: "x" } })), private_key_path).toBeUndefined();
    expect(repoApp(cfg({ github_app: { app_id: "1", private_key_path: "/k", slug: "x" } }))).toEqual({ app_id: "1", private_key_path: "/k", slug: "x" });
    expect(installUrl("my-app")).toBe("https://github.com/apps/my-app/installations/new");
  });
});

describe("identityEnv", () => {
  const withInstall = () => cfg({ github_app: { ...fake.config(), installation_id: "77" } });

  it("uses the app's token with an installation id, asks without a body, and caches", async () => {
    const env = await identityEnv(withInstall());
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: "POST", path: "/app/installations/77/access_tokens", hasBody: false });
    expect(env.GH_TOKEN).toBe(fake.tokens[0]);
    await identityEnv(withInstall());
    expect(fake.calls).toHaveLength(1);
  });

  it("makes no request without an installation id and keeps bot.gh_token_env", async () => {
    process.env.SCF_TEST_BOT_TOKEN = "bot-token";
    try {
      for (const installation_id of [undefined, ""]) {
        const env = await identityEnv(cfg({ bot: { gh_token_env: "SCF_TEST_BOT_TOKEN" }, github_app: { ...fake.config(), installation_id } }));
        expect(env.GH_TOKEN).toBe("bot-token");
      }
    } finally {
      delete process.env.SCF_TEST_BOT_TOKEN;
    }
    expect(fake.calls).toEqual([]);
  });

  it("throws a fixed sentence for a 401 and for a missing key file", async () => {
    fake.force.token = { status: 401, body: '{"message":"MARKER-TEXT"}' };
    await expect(identityEnv(withInstall())).rejects.toThrow(new GithubAppError("status", 401));
    await expect(identityEnv(withInstall())).rejects.toThrow(/^GitHub App token request failed: 401$/);
    fake.force = {};
    const before = fake.calls.length;
    const missing = cfg({ github_app: { ...fake.config(), private_key_path: join(tmpdir(), "nope", "missing.pem"), installation_id: "77" } });
    const e = await identityEnv(missing).then(() => undefined, (x: Error) => x);
    expect(e?.message).toMatch(/^GitHub App token/);
    expect(e?.message).not.toContain("missing.pem");
    expect(fake.calls).toHaveLength(before);
  });
});

describe("a run that cannot get the app's token", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-app-run-"));
    mkdirSync(join(tmp, "repo"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (config: Config) =>
    runFlow(parseFlow("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n"), { task: "t", repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin: "claude", config });

  const check = async (config: Config, secrets: string[]) => {
    const s = await run(config);
    expect(s.status).toBe("failed");
    expect(s.history).toEqual([]);
    expect(classifyFailure(s)).toMatchObject({ cause: "factory", fix: "check the GitHub App settings in the config" });
    const saved = readdirSync(s.runDir).map((f) => (statSync(join(s.runDir, f)).isFile() ? readFileSync(join(s.runDir, f), "utf8") : "")).join("\n");
    // a run that fails this early may have no live log
    const live = existsSync(liveLogFile(s.runDir)) ? readFileSync(liveLogFile(s.runDir), "utf8") : "";
    const everything = [s.reason, saved, live].join("\n");
    for (const secret of secrets) expect(everything).not.toContain(secret);
  };

  it("fails with a missing key file, without the path", async () => {
    await check(cfg({ github_app: { app_id: fake.appId, installation_id: "123456", private_key_path: join(tmp, "KEYFILE-MARKER.pem") } }), ["KEYFILE-MARKER", "123456"]);
  });
  it("fails with a 401, without GitHub's text", async () => {
    fake.force.token = { status: 401, body: "BODY-MARKER-TEXT" };
    await check(cfg({ github_app: { ...fake.config(), installation_id: "77" } }), ["BODY-MARKER-TEXT", fake.keyPath]);
  });
});

describe("appJwt", () => {
  it("is still exported from the guards and signs for the app", () => {
    const jwt = appJwt(fake.appId, fake.pem);
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("installationToken", () => {
  it("limits the token to one repository", async () => {
    const t = await installationToken(app(), "77", { repository: "app" });
    expect(t).toBe(fake.tokens[0]);
    expect(fake.calls[0]!.body).toEqual({ repositories: ["app"] });
  });
  it("caches per repository, and fresh asks again", async () => {
    await installationToken(app(), "77", { repository: "app" });
    await installationToken(app(), "77", { repository: "other" });
    expect(fake.calls).toHaveLength(2);
    await installationToken(app(), "77", { repository: "app" });
    expect(fake.calls).toHaveLength(2);
    await installationToken(app(), "77", { repository: "app", fresh: true });
    expect(fake.calls).toHaveLength(3);
  });
  it("installationTokenInfo returns the end time, and a fresh token is not cached", async () => {
    const before = Date.now();
    const info = await installationTokenInfo(app(), "77", { repository: "app", fresh: true });
    expect(info.token).toBe(fake.tokens[0]);
    expect(info.expires).toBeGreaterThan(before + 3_000_000);
    await installationToken(app(), "77", { repository: "app" });
    expect(fake.calls).toHaveLength(2); // the fresh one was not kept
    await installationToken(app(), "77", { repository: "app" });
    expect(fake.calls).toHaveLength(2);
  });
  it("limited is true for 429 and for 403 with no requests left, false for a plain 403", () => {
    const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });
    expect(limited(res(429))).toBe(true);
    expect(limited(res(403, { "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(limited(res(403))).toBe(false);
    expect(limited(res(403, { "x-ratelimit-remaining": "5" }))).toBe(false);
    expect(limited(res(500))).toBe(false);
  });
  it("marks the error of a rate limit", async () => {
    fake.force.token = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
    await expect(installationToken(app(), "77")).rejects.toMatchObject({ code: "status", status: 403, rateLimited: true });
    fake.force.token = { status: 403 };
    await expect(installationToken(app(), "77")).rejects.toMatchObject({ status: 403, rateLimited: false });
  });
  it("asks again when under five minutes are left", async () => {
    const real = Date.now;
    await installationToken(app(), "77", { repository: "app" });
    try {
      Date.now = () => real() + 56 * 60_000;
      await installationToken(app(), "77", { repository: "app" });
    } finally {
      Date.now = real;
    }
    expect(fake.calls).toHaveLength(2);
  });
  it("does not cache an answer that is not a token", async () => {
    const past = JSON.stringify({ token: "x", expires_at: "2001-01-01T00:00:00Z" });
    for (const raw of ["not json", "{}", '{"token":"","expires_at":"2999-01-01T00:00:00Z"}', '{"token":5,"expires_at":"2999-01-01T00:00:00Z"}', '{"token":"x"}', '{"token":"x","expires_at":"soon"}', past]) {
      fake.force.token = { raw };
      const n = fake.calls.length;
      await expect(installationToken(app(), "77", { repository: "app" }), raw).rejects.toThrow(new GithubAppError("answer"));
      fake.force = {};
      await installationToken(app(), "77", { repository: "app" });
      expect(fake.calls.length - n).toBe(2);
      clearTokenCache();
    }
  });
  it("throws the unreachable sentence for a network error", async () => {
    fake.force.token = "network";
    await expect(installationToken(app(), "77")).rejects.toThrow(new GithubAppError("unreachable"));
  });
});

describe("repoInstallation", () => {
  it("finds the installation, with and without a token", async () => {
    expect(await repoInstallation(app(), "Acme/App")).toEqual({ ok: true, installationId: "77" });
    const r = await repoInstallation(app(), "acme/app", { token: true });
    expect(r).toEqual({ ok: true, installationId: "77", token: fake.tokens[0] });
    expect(fake.calls.at(-1)!.body).toEqual({ repositories: ["app"] });
  });
  it("maps every problem to a fixed word", async () => {
    expect(await repoInstallation(app(), "acme/none")).toEqual({ ok: false, problem: "not-installed" });
    for (const [status, problem] of [[401, "app-broken"], [429, "rate-limit"], [500, "failed"]] as const) {
      fake.force.lookup = { status, body: "GITHUB-TEXT" };
      expect(await repoInstallation(app(), "acme/app"), String(status)).toEqual({ ok: false, problem });
    }
    fake.force.lookup = "network";
    expect(await repoInstallation(app(), "acme/app")).toEqual({ ok: false, problem: "unreachable" });
    fake.force.lookup = { raw: '{"nothing":1}' };
    expect(await repoInstallation(app(), "acme/app")).toEqual({ ok: false, problem: "failed" });
    fake.force.lookup = { raw: "not json" };
    expect(await repoInstallation(app(), "acme/app")).toEqual({ ok: false, problem: "failed" });
  });
  it("tells a spent request limit from another 403", async () => {
    fake.force.lookup = { status: 403 };
    expect(await repoInstallation(app(), "acme/app")).toEqual({ ok: false, problem: "failed" });
  });
  it("does not ask GitHub when the key file is missing", async () => {
    const r = await repoInstallation({ ...app(), private_key_path: join(tmpdir(), "nope", "k.pem") }, "acme/app");
    expect(r).toEqual({ ok: false, problem: "app-broken" });
    expect(fake.calls).toEqual([]);
  });
  it("reports a token the installation does not allow, and a bad token answer, as failed", async () => {
    fake.installs.set("acme/app", 77);
    fake.force.token = { status: 422, body: "TEXT" };
    expect(await repoInstallation(app(), "acme/app", { token: true })).toEqual({ ok: false, problem: "failed" });
    fake.force.token = { raw: "{}" };
    expect(await repoInstallation(app(), "acme/app", { token: true })).toEqual({ ok: false, problem: "failed" });
  });
  it("ends a request that never answers as unreachable", async () => {
    fake.force.lookup = "hang";
    expect(await repoInstallation(app(), "acme/app", { timeoutMs: 50 })).toEqual({ ok: false, problem: "unreachable" });
  });
  it("never holds the key path or GitHub's text", async () => {
    fake.force.lookup = { status: 500, body: `TEXT ${fake.keyPath}` };
    const r = JSON.stringify(await repoInstallation(app(), "acme/app"));
    expect(r).not.toContain(fake.keyPath);
    expect(r).not.toContain("TEXT");
  });
});
