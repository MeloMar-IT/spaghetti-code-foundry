import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";import { randomUUID } from "node:crypto";
import { addRepo, removeRepo, reposPath } from "../src/auth/repos.js";
import { saveConfig } from "../src/config.js";
import { OWNER_BLOCKED, addRepoWatcher, listRepoWatchers, repoWatchersPath } from "../src/repos/watchers.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

let base: string;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const INTERNAL = "the repository list is not working; see the server log";
let tmp: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
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
  const started = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) });
  ({ close, ctx, base } = started);
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
type AuditView = { actor: { type: string; id?: string }; action: string; target: { type: string; id?: string; text?: string } | null; detail?: string };
/** The audit lines about one repository or account, oldest first. */
const auditFor = async (id: string) =>
  ((await call(admin, "GET", "/api/audit")).json().entries as AuditView[]).reverse().filter((e) => e.target?.text === id || e.target?.id === id);
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

  it("stores the options of the form, removes cleared ones, and names a refused one", async () => {
    const opts = {
      auto_defaults: true, precheck_flow: "epic-questions", priority_labels: ["urgent"], status_labels: { working: "W" }, wait_for_dependencies: false,
      dependency_done_labels: ["released"], remove_on_done: ["go"], comment_on_failure: false, status_comment: false, one_at_a_time: true, pause_while_pr_open: "factory/daily-",
    };
    expect((await call(admin, "POST", path(annRepo), { id: "opt-w", every: "5m", ...opts })).status).toBe(201);
    expect(((await rows()).find((w) => w.id === "opt-w")) as unknown).toMatchObject(opts);
    const cleared = await call(admin, "PUT", path(annRepo, "opt-w"), { pause_while_pr_open: null, precheck_flow: null, status_labels: {} });
    expect(cleared.status).toBe(200);
    const row = (await rows()).find((w) => w.id === "opt-w") as unknown as Record<string, unknown>;
    expect(row.pause_while_pr_open).toBeUndefined();
    expect(row.precheck_flow).toBeUndefined();
    const bad = await call(admin, "PUT", path(annRepo, "opt-w"), { pause_while_pr_open: 5 });
    expect(bad.status).toBe(400);
    expect(String((bad.json() as { error: string }).error)).toMatch(/^pause_while_pr_open:/);
    const bad2 = await call(admin, "PUT", path(annRepo, "opt-w"), { status_labels: { working: 5 } });
    expect(String((bad2.json() as { error: string }).error)).toMatch(/^status_labels\.working:/);
    await call(admin, "DELETE", path(annRepo, "opt-w"));
  });

  it("keeps ids unique on the install, in the store and in config.yaml", async () => {
    expect((await call(admin, "POST", path(adminRepo), { id: "admin-w" })).status).toBe(409);
    expect((await call(admin, "POST", path(annRepo), { id: "admin-w" })).error()).toMatch(/exists already/);
    const config = (await call(admin, "GET", "/api/config")).json();
    const put = (watchers: unknown[]) => call(admin, "PUT", "/api/config", { ...config, watchers });
    const w = { id: "file-w", github_repo: "acme/file", enabled: false };
    saveConfig({ ...config, watchers: [w] }); // a file watcher: the API no longer saves a new one
    ctx.reloadConfig();
    ctx.watchers.sync();
    expect((await call(admin, "POST", path(annRepo), { id: "file-w" })).status).toBe(409);
    expect((await put([w, { ...w, id: "admin-w" }])).error()).toMatch(/invalid config: .*admin-w.*Watchers page/);
    expect((await put([w, { ...w, id: "new" }, { ...w, id: "new" }])).error()).toMatch(/Watchers page/);
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
    addRepoWatcher(randomUUID(), { id: "gone-w" }); // removing a repository removes its watchers, so make the leftover by hand
    ctx.watchers.sync();
    expect((await rows()).find((w) => w.id === "gone-w")!.problem).toMatch(/not connected any more/);
    removeRepo(admin.user.id, rec.id);
    expect((await call(admin, "DELETE", path(rec.id, "gone-w"))).status).toBe(404); // another repository's id
    const orphan = listRepoWatchers().find((w) => w.id === "gone-w")!;
    expect((await call(admin, "DELETE", path(orphan.repoId, "gone-w"))).status).toBe(200);
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
    const log = await audit();
    expect(log).toContain("watchers removed: cascade-w");
    const lines = (await auditFor(rec.id)).filter((l) => l.action === "repo-remove" || l.detail?.startsWith("watchers removed"));
    expect(lines.map((l) => [l.action, l.detail ?? ""])).toEqual([["repo-remove", expect.any(String)], ["repo-change", "watchers removed: cascade-w"]]);
  });

  it("pauses the watchers of a blocked owner and starts them again on unblock", async () => {
    const cat = await signInAs(base, { name: "Cat", email: "cat@example.com", role: "user" });
    const rec = await add(cat, { url: "acme/cat", method: "github-token", token: TOKEN });
    await call(admin, "POST", path(rec.id), { id: "cat-w" });
    const tracked = (id: string) => ctx.watchers.tracked().find((t) => t.watcher.id === id);
    const before = tracked("admin-w")!.status;
    expect(tracked("cat-w")).toBeDefined();
    expect((await call(admin, "POST", `/api/users/${cat.user.id}/block`, {})).status).toBe(200);
    expect(tracked("cat-w")).toBeUndefined();
    const row = (await rows()).find((w) => w.id === "cat-w")!;
    expect(row.state).toMatchObject({ name: "paused", status: OWNER_BLOCKED });
    expect(row.problem).toBe(OWNER_BLOCKED);
    expect(row).not.toHaveProperty("status");
    expect(tracked("admin-w")!.status).toBe(before); // the others did not restart
    expect((await call(admin, "PUT", path(rec.id, "cat-w"), { enabled: false })).json()).toMatchObject({ state: { name: "disabled" } });
    await call(admin, "PUT", path(rec.id, "cat-w"), { enabled: true });
    expect((await call(admin, "POST", `/api/users/${cat.user.id}/unblock`, {})).status).toBe(200);
    expect(tracked("cat-w")).toBeDefined();
    expect(tracked("admin-w")!.status).toBe(before);
    await call(admin, "DELETE", path(rec.id, "cat-w"));
    await call(admin, "DELETE", `/api/users/${cat.user.id}`);
  });

  it("removes the watchers when the repository is deleted by name", async () => {
    const rec = await add(ann, { url: "acme/byname", method: "github-token", token: TOKEN });
    await call(admin, "POST", path(rec.id), { id: "name-w" });
    expect((await call(ann, "DELETE", "/api/repos/acme/byname")).status).toBe(200);
    expect(stored()).not.toContain("name-w");
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).not.toContain("name-w");
    const lines = (await auditFor(rec.id)).filter((l) => l.action === "repo-remove" || l.detail?.startsWith("watchers removed"));
    expect(lines.map((l) => [l.action, l.detail ?? ""])).toEqual([["repo-remove", expect.any(String)], ["repo-change", "watchers removed: name-w"]]);
  });

  it("keeps the watchers when the repository delete fails, and removes them on the retry", async () => {
    const rec = await add(ann, { url: "acme/fails", method: "github-token", token: TOKEN });
    await call(admin, "POST", path(rec.id), { id: "fail-w" });
    mkdirSync(reposPath() + ".tmp");
    expect((await call(ann, "DELETE", `/api/repos/${rec.id}`)).status).toBe(500);
    expect(stored()).toContain("fail-w");
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toContain("fail-w");
    expect(await audit()).not.toContain("watchers removed: fail-w");
    rmSync(reposPath() + ".tmp", { recursive: true });
    expect((await call(ann, "DELETE", `/api/repos/${rec.id}`)).status).toBe(200);
    expect(stored()).not.toContain("fail-w");
    expect(await audit()).toContain("watchers removed: fail-w");
  });

  it("removes the watchers of a deleted account, with the audit lines in order", async () => {
    const dan = await signInAs(base, { name: "Dan", email: "dan@example.com", role: "user" });
    const rec = await add(dan, { url: "acme/dan", method: "github-token", token: TOKEN });
    await call(admin, "POST", path(rec.id), { id: "dan-w" });
    expect((await call(admin, "DELETE", `/api/users/${dan.user.id}`)).status).toBe(200);
    expect(stored()).not.toContain("dan-w");
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).not.toContain("dan-w");
    const change = (await auditFor(rec.id)).find((l) => l.detail === "watchers removed: dan-w");
    expect(change).toMatchObject({ action: "repo-change", actor: { id: admin.user.id } });
    const all = ((await call(admin, "GET", "/api/audit")).json().entries as AuditView[]).reverse();
    const del = all.findIndex((l) => l.action === "delete" && l.target?.id === dan.user.id);
    expect(del).toBeGreaterThan(all.indexOf(all.find((l) => l.detail === "watchers removed: dan-w")!));
  });

  it("stops the watchers of an account whose delete failed half way", async () => {
    const eve = await signInAs(base, { name: "Eve", email: "eve@example.com", role: "user" });
    const rec = await add(eve, { url: "acme/eve", method: "github-token", token: TOKEN });
    await call(admin, "POST", path(rec.id), { id: "eve-w" });
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toContain("eve-w");
    kc.fail("find");
    expect((await call(admin, "DELETE", `/api/users/${eve.user.id}`)).status).toBe(500);
    kc.fail();
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).not.toContain("eve-w");
    expect((await call(admin, "DELETE", `/api/users/${eve.user.id}`)).status).toBe(200);
  });

  describe("described variables", () => {
    const flowFile = (name: string) => join(tmp, ".claude-factory", "flows", `${name}.yaml`);
    const described = `name: described\nvars:\n  risk_threshold: "75"\n  note: x\n  run_id: ""\nvar_info:\n  risk_threshold: {kind: number, min: 0, max: 100}\n  note: {kind: text}\n  run_id: {set_by_run: true}\nsteps:\n  - {id: a, type: shell, run: echo}\n`;
    const post = (body: object) => call(admin, "POST", path(annRepo), body);
    beforeAll(() => {
      mkdirSync(join(tmp, ".claude-factory", "flows"), { recursive: true });
      for (const n of ["described", "issue-gitflow", "release-daily"]) writeFileSync(flowFile(n), described.replace("name: described", `name: ${n}`));
    });
    afterAll(() => {
      for (const n of ["described", "issue-gitflow", "release-daily"]) rmSync(flowFile(n), { force: true });
    });
    const clean = async (id: string) => void (await call(admin, "DELETE", path(annRepo, id)));

    it("refuses a value that does not fit, with the variable named; accepts the rest", async () => {
      const r = await post({ id: "dv1", flow: "described", vars: { risk_threshold: "150" } });
      expect([r.status, r.error()]).toEqual([400, "vars.risk_threshold: 150 is above max 100"]);
      expect((await post({ id: "dv1", flow: "described", vars: { risk_threshold: "abc" } })).error()).toBe('vars.risk_threshold: "abc" is not a number');
      expect((await post({ id: "dv1", flow: "described", vars: { other: "anything", run_id: "x", note: "" } })).status).toBe(201);
      expect((await post({ id: "dv2", flow: "nope", vars: { risk_threshold: "abc" } })).status).toBe(201);
      expect((await post({ id: "dv3", flow: "../x.yaml", vars: { risk_threshold: "abc" } })).status).toBe(201);
      for (const id of ["dv1", "dv2", "dv3"]) await clean(id);
    });

    it("checks a flow given as the path of an existing YAML file, as a run resolves it", async () => {
      const r = await post({ id: "dv6", flow: flowFile("described"), vars: { risk_threshold: "abc" } });
      expect([r.status, r.error()]).toEqual([400, 'vars.risk_threshold: "abc" is not a number']);
      expect((await post({ id: "dv6", flow: flowFile("described"), vars: { risk_threshold: "9" } })).status).toBe(201);
      await clean("dv6");
    });

    it("resolves the flow `default` from the source", async () => {
      expect((await post({ id: "dv4", flow: "default", source: "issues", vars: { risk_threshold: "abc" } })).status).toBe(400);
      expect((await post({ id: "dv4", flow: "default", source: "schedule", task: "t", every: "1d", vars: { risk_threshold: "abc" } })).status).toBe(400);
      expect((await post({ id: "dv4", flow: "default", source: "issues", vars: { risk_threshold: "5" } })).status).toBe(201);
      await clean("dv4");
    });

    it("lets a stored bad value run and be enabled or disabled, and refuses it when saved again", async () => {
      const bad = { id: "dv5", flow: "described", vars: { risk_threshold: "500" } };
      addRepoWatcher(annRepo, bad); // stored without the check, as an old watcher is
      expect((await call(admin, "PUT", path(annRepo, "dv5"), { enabled: false })).status).toBe(200);
      expect((await call(admin, "PUT", path(annRepo, "dv5"), { enabled: true })).status).toBe(200);
      expect((await call(admin, "PUT", path(annRepo, "dv5"), { vars: { risk_threshold: "500" } })).error()).toMatch(/^vars\.risk_threshold: 500 is above max 100/);
      expect((await call(admin, "PUT", path(annRepo, "dv5"), { vars: { risk_threshold: "50" } })).status).toBe(200);
      await clean("dv5");
    });

    it("answers GET /api/flows/<name> with the variables and their descriptions", async () => {
      const r = (await call(admin, "GET", "/api/flows/described")).json() as { vars: object; var_info: Record<string, unknown> };
      expect(r.vars).toEqual({ risk_threshold: "75", note: "x", run_id: "" });
      expect(Object.keys(r.var_info)).toEqual(["risk_threshold", "note", "run_id"]);
    });

    it("PUT /api/config saves an unchanged file watcher with an old value and refuses a changed one", async () => {
      const config = (await call(admin, "GET", "/api/config")).json();
      const w = { id: "file-w", github_repo: "acme/file", enabled: false, flow: "described", vars: { risk_threshold: "500" } };
      saveConfig({ ...config, watchers: [w] });
      ctx.reloadConfig();
      expect((await call(admin, "PUT", "/api/config", { ...config, watchers: [w] })).status).toBe(200);
      const changed = await call(admin, "PUT", "/api/config", { ...config, watchers: [{ ...w, vars: { risk_threshold: "501" } }] });
      expect([changed.status, changed.error()]).toEqual([400, expect.stringMatching(/Watchers page/)]);
      saveConfig({ ...config, watchers: [{ id: "file-w", github_repo: "acme/file", enabled: false }] });
      ctx.reloadConfig();
    });
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
