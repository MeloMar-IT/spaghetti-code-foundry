import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo, removeRepo } from "../src/auth/repos.js";
import { repoWatchersPath } from "../src/repos/watchers.js";
import { startServer } from "../src/server/server.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const INTERNAL = "the repository list is not working; see the server log";
let tmp: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let kc: FakeKeychain;
let kg: FakeKeygen;
let gh: ReturnType<typeof fakeGithub>;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
const logs: string[] = [];
const seen: string[] = [];

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  gh = fakeGithub();
  tmp = mkdtempSync(join(tmpdir(), "repo-watchers-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  kg = fakeKeygen();
  const started = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) });
  ({ close, ctx } = started);
  ctx.scheduler.drain(); // runs stay queued
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
});
afterAll(async () => {
  close();
  await new Promise((r) => setTimeout(r, 500)); // a fake gh call may still be writing
  kc.remove();
  kg.remove();
  gh.restore();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
type Row = { id: string; repoId?: string; github_repo: string; owner?: string; enabled: boolean; problem?: string; state: { name: string }; status?: unknown };
const rows = async () => (await call(admin, "GET", "/api/watchers")).json() as Row[];
const add = async (who: TestSession, body: unknown) => (await call(who, "POST", "/api/repos", body)).json() as { id: string };
const audit = async () => JSON.stringify((await call(admin, "GET", "/api/audit")).json());
const stored = () => readFileSync(repoWatchersPath(), "utf8");
const path = (id: string, wid?: string) => `/api/admin/repos/${id}/watchers${wid ? `/${wid}` : ""}`;

let annRepo: string;
let adminRepo: string;

describe("watchers of a repository: the routes", () => {
  it("answers 403 to a user and 404 to an unknown repository or watcher", async () => {
    for (const [m, p, b] of [["GET", path(UNKNOWN)], ["POST", path(UNKNOWN), {}], ["PUT", path(UNKNOWN, "x"), {}], ["DELETE", path(UNKNOWN, "x")]] as const) {
      expect((await call(ann, m, p, b)).status).toBe(403);
      expect((await call(admin, m, p, b)).status).toBe(404);
    }
    annRepo = (await add(ann, { url: "acme/app", method: "github-token", token: TOKEN })).id;
    adminRepo = (await add(admin, { url: "acme/web" })).id;
    expect((await call(admin, "PUT", path(annRepo, "x"), {})).status).toBe(404);
    expect((await call(admin, "DELETE", path(annRepo, "x"))).status).toBe(404);
  });

  it("refuses a repository whose sign-in cannot call the GitHub API, with a sentence", async () => {
    const key = await add(ann, { url: "git@github.com:acme/key.git", method: "ssh-deploy-key" });
    const r = await call(admin, "POST", path(key.id), { id: "k" });
    expect([r.status, r.error()]).toEqual([400, expect.stringMatching(/cannot call the GitHub API/)]);
    const other = addRepo(ann.user.id, { url: "https://github.com/acme/https", method: "https-token", username: "ann", token: TOKEN });
    expect((await call(admin, "POST", path(other.id), { id: "h" })).status).toBe(400);
    const gitlab = addRepo(ann.user.id, { url: "https://gitlab.com/acme/lab", method: "https-token", username: "ann", token: TOKEN });
    expect((await call(admin, "POST", path(gitlab.id), { id: "g" })).error()).toMatch(/GitHub repository/);
    const none = addRepo(ann.user.id, { url: "acme/none" }, {});
    expect((await call(admin, "POST", path(none.id), { id: "n" })).error()).toMatch(/admin/);
  });

  it("adds, lists, changes and deletes watchers, and writes the audit log", async () => {
    const a = await call(admin, "POST", path(annRepo), { id: "ann-w", every: "5m" });
    expect(a.status).toBe(201);
    expect(a.json()).toMatchObject({ id: "ann-w", repoId: annRepo, github_repo: "acme/app", owner: "ann@example.com", enabled: true });
    expect((await call(admin, "POST", path(adminRepo), { id: "admin-w" })).status).toBe(201);
    expect(ctx.watchers.tracked().map((t) => t.watcher.id).sort()).toEqual(["admin-w", "ann-w"]);
    expect(ctx.watchers.tracked().find((t) => t.watcher.id === "ann-w")!.watcher.ownerId).toBe(ann.user.id);
    expect(((await call(admin, "GET", path(annRepo))).json() as Row[]).map((w) => w.id)).toEqual(["ann-w"]);
    const all = await rows();
    expect(all.find((w) => w.id === "ann-w")!.repoId).toBe(annRepo);
    expect(all.find((w) => w.id === "admin-w")!.repoId).toBe(adminRepo);

    const before = ctx.watchers.tracked().find((t) => t.watcher.id === "ann-w")!.status.startedAt;
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(admin, "PUT", path(annRepo, "ann-w"), { every: "10m" })).json()).toMatchObject({ every: "10m" });
    expect(ctx.watchers.tracked().find((t) => t.watcher.id === "ann-w")!.status.startedAt).not.toBe(before);
    expect((await call(admin, "PUT", path(annRepo, "ann-w"), { enabled: false })).json()).toMatchObject({ enabled: false });
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toEqual(["admin-w"]);
    expect((await call(admin, "PUT", path(annRepo, "ann-w"), { enabled: false })).status).toBe(200); // no change, no audit line
    await call(admin, "PUT", path(annRepo, "ann-w"), { enabled: true });
    expect(ctx.watchers.tracked()).toHaveLength(2);
    expect((await call(admin, "DELETE", path(annRepo, "ann-w"))).json()).toEqual({ ok: true });
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toEqual(["admin-w"]);

    const log = await audit();
    for (const line of ["watcher ann-w: added", "watcher ann-w: disabled", "watcher ann-w: enabled", "watcher ann-w: removed"]) expect(log).toContain(line);
    expect(log.split("watcher ann-w: disabled").length).toBe(2);
    expect(log).toContain(annRepo);
  });

  it("keeps ids unique on the install, in the store and in config.yaml", async () => {
    expect((await call(admin, "POST", path(adminRepo), { id: "admin-w" })).status).toBe(409);
    expect((await call(admin, "POST", path(annRepo), { id: "admin-w" })).error()).toMatch(/exists already/);
    const config = (await call(admin, "GET", "/api/config")).json();
    const put = (watchers: unknown[]) => call(admin, "PUT", "/api/config", { ...config, watchers });
    const w = { id: "file-w", github_repo: "acme/file", enabled: false };
    expect((await put([w])).status).toBe(200);
    expect((await call(admin, "POST", path(annRepo), { id: "file-w" })).status).toBe(409);
    expect((await put([w, { ...w, id: "admin-w" }])).error()).toMatch(/invalid config: .*admin-w.*repository/);
    expect((await put([w, { ...w, id: "new" }, { ...w, id: "new" }])).error()).toMatch(/used twice/);
  });

  it("keeps stored watchers out of GET and PUT /api/config", async () => {
    const config = (await call(admin, "GET", "/api/config")).json() as { watchers: { id: string }[] };
    expect(config.watchers.map((w) => w.id)).toEqual(["file-w"]);
    const before = stored();
    expect((await call(admin, "PUT", "/api/config", config)).status).toBe(200);
    expect(stored()).toBe(before);
    expect(readFileSync(join(process.env.FACTORY_HOME!, "config.yaml"), "utf8")).not.toContain("admin-w");
  });

  it("lists a watcher that cannot run with its problem, and runs it again when it can", async () => {
    await call(admin, "POST", path(annRepo), { id: "ann-w" });
    expect((await call(ann, "PUT", `/api/repos/${annRepo}/auth`, { method: "https-token", username: "ann", token: TOKEN })).status).toBe(200);
    const w = (await rows()).find((x) => x.id === "ann-w")!;
    expect(w).toMatchObject({ repoId: annRepo, state: { name: "error" } });
    expect(w.problem).toMatch(/cannot call the GitHub API/);
    expect(w).not.toHaveProperty("status");
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).not.toContain("ann-w");
    expect(((await call(admin, "GET", path(annRepo))).json() as Row[]).map((x) => x.id)).toEqual(["ann-w"]);
    expect((await call(admin, "PUT", path(annRepo, "ann-w"), { enabled: false })).status).toBe(200);
    expect((await rows()).find((x) => x.id === "ann-w")!.state.name).toBe("disabled");
    await call(admin, "PUT", path(annRepo, "ann-w"), { enabled: true });
    expect((await call(ann, "PUT", `/api/repos/${annRepo}/auth`, { method: "github-token", token: TOKEN })).status).toBe(200);
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toContain("ann-w");
  });

  it("lists a watcher of a removed repository, and lets the admin delete it", async () => {
    const rec = addRepo(admin.user.id, { url: "acme/gone" });
    await call(admin, "POST", path(rec.id), { id: "gone-w" });
    removeRepo(admin.user.id, rec.id); // no cascade here
    ctx.watchers.sync();
    expect((await rows()).find((w) => w.id === "gone-w")!.problem).toMatch(/not connected any more/);
    expect((await call(admin, "DELETE", path(rec.id, "gone-w"))).status).toBe(200);
    expect((await call(admin, "POST", path(adminRepo), { id: "gone-w" })).status).toBe(201);
    await call(admin, "DELETE", path(adminRepo, "gone-w"));
  });

  it("removes the watchers with their repository", async () => {
    const rec = await add(ann, { url: "acme/cascade", method: "github-token", token: TOKEN });
    await call(admin, "POST", path(rec.id), { id: "cascade-w" });
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toContain("cascade-w");
    expect((await call(ann, "DELETE", `/api/repos/${rec.id}`)).status).toBe(200);
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).not.toContain("cascade-w");
    expect(stored()).not.toContain("cascade-w");
    expect(await audit()).toContain("watchers removed: cascade-w");
  });

  it("answers a broken store with a fixed sentence and no path", async () => {
    const good = stored();
    writeFileSync(repoWatchersPath(), "not json");
    for (const [m, p, b] of [["GET", path(annRepo)], ["POST", path(annRepo), { id: "z" }], ["PUT", path(annRepo, "ann-w"), {}], ["DELETE", path(annRepo, "ann-w")]] as const) {
      const r = await call(admin, m, p, b);
      expect([r.status, r.error()]).toEqual([500, INTERNAL]);
    }
    expect(readFileSync(repoWatchersPath(), "utf8")).toBe("not json");
    expect(logs).toContain("repos: repo-watchers.json not-json");
    writeFileSync(repoWatchersPath(), good);
  });

  it("never shows the token", () => {
    expect(seen.join("\n")).not.toContain(TOKEN);
  });
});
