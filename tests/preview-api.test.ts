import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectRun, previewsOf, runBranch } from "../src/server/api-preview.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
const fixture = resolve("tests/fixtures/fake-preview-server.mjs");
const previewYaml = (print: string) => `command: ${JSON.stringify(`exec "${process.execPath}" "${fixture}"`)}\nenv:\n  FAKE_PREVIEW_PRINT: ${print}\n`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let tmp: string;
let home: string;
let bare: string;
let localRepo: string;
let close: () => void;
let closed = false;
let base: string;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
let kc: FakeKeychain;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let annRepo: string;
let localId: string;
let waitingRun: string;
let annWaiting: string;
let otherRun: string;
let doneRun: string;
let workspace: string;
const saved = { home: process.env.FACTORY_HOME, remote: process.env.SCF_CONNECT_REMOTE };

/** A repository with a develop branch that has a preview file. */
function seed(dir: string, print: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  git(dir, "checkout", "-qb", "develop");
  mkdirSync(join(dir, ".factory"));
  writeFileSync(join(dir, ".factory", "preview.yaml"), previewYaml(print));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "preview");
  git(dir, "checkout", "-qb", "feature/8-empty", "main");
}

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
}
const url = (id: string) => `/api/repos/${id}/preview`;
const folder = (id: string) => join(home, "previews", id);
const previews = () => previewsOf(ctx);

/** Flows for the runs: one that builds a branch in its workspace and waits for approval, one that ends. */
const flows = () => {
  const yamlFile = join(tmp, "checking.yaml");
  writeFileSync(yamlFile, previewYaml("checking"));
  const build = [
    "set -e",
    `git clone -q "${bare}" .`,
    "git checkout -q -b feature/7-try origin/develop",
    `cp "${yamlFile}" .factory/preview.yaml`,
    "git add .",
    "git -c user.email=t@example.com -c user.name=T commit -qm try",
    'echo "BRANCH: feature/7-try (new, from develop)"',
  ]
    .map((l) => `      ${l}`)
    .join("\n");
  return {
    gated: `name: pv-gated\nworkspace: empty\nvars:\n  github_repo: owner/repo\npublish:\n  enabled: true\n  vars:\n    github_repo: {mode: input, label: Repository}\nsteps:\n  - id: feature_branch\n    type: shell\n    run: |\n${build}\n  - {id: gate, type: approval, message: "Looks good?"}\n`,
    plain: `name: pv-plain\nworkspace: empty\nvars:\n  github_repo: owner/repo\npublish:\n  enabled: true\n  vars:\n    github_repo: {mode: input, label: Repository}\nsteps:\n  - {id: a, type: shell, run: "true"}\n`,
  };
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "preview-api-")));
  home = join(tmp, "home");
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  const work = join(tmp, "work");
  seed(work, "develop");
  bare = join(tmp, "remote.git");
  git(tmp, "clone", "-q", "--bare", work, bare);
  localRepo = join(tmp, "local-app");
  seed(localRepo, "local");
  git(localRepo, "checkout", "-q", "main");
  process.env.SCF_CONNECT_REMOTE = bare;
  ({ close, base, ctx } = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  const token = "github_pat_" + fakeToken("Pv7").slice(4);
  const added = await call(ann, "POST", "/api/repos", { url: "https://github.com/acme/app", method: "github-token", token });
  expect(added.status).toBe(201);
  annRepo = added.json().id as string;
  const local = await call(admin, "POST", "/api/repos", { url: localRepo, method: "local" });
  expect(local.status).toBe(201);
  localId = local.json().id as string;
  const f = flows();
  for (const [name, yaml] of [["pv-gated", f.gated], ["pv-plain", f.plain]] as const) expect((await call(admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
  const start = async (who: TestSession, flow: string, repo: string) => {
    const r = await call(who, "POST", "/api/runs", { flow, task: flow, vars: { github_repo: repo } });
    expect(r.status).toBe(201);
    return r.json().runId as string;
  };
  waitingRun = await start(admin, "pv-gated", "acme/app"); // an admin's run of the same project: not Ann's
  annWaiting = await start(ann, "pv-gated", "acme/app");
  otherRun = await start(admin, "pv-gated", "other/thing");
  doneRun = await start(ann, "pv-plain", "acme/app");
  for (const id of [waitingRun, annWaiting, otherRun, doneRun]) await ctx.scheduler.wait(id);
  expect(ctx.scheduler.get(annWaiting)?.status).toBe("waiting");
  workspace = ctx.scheduler.get(annWaiting)!.workdir ?? join(ctx.scheduler.get(annWaiting)!.runDir, "workspace");
}, 60_000);
afterAll(() => {
  if (!closed) close();
  kc.remove();
  for (const [k, v] of [["FACTORY_HOME", saved.home], ["SCF_CONNECT_REMOTE", saved.remote]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("preview routes", () => {
  it("starts the develop version of a GitHub record, shows it, and keeps output for GET only", async () => {
    const r = await call(ann, "POST", url(annRepo), { version: "develop" });
    expect(r.status).toBe(202);
    expect(r.json()).toMatchObject({ state: "starting", version: "develop" });
    expect(r.text).not.toContain("output");
    const view = await previews().settled(annRepo);
    expect(view).toMatchObject({ state: "ready", version: "develop" });
    expect((await fetch(view.url!)).status).toBe(200);
    expect(existsSync(join(folder(annRepo), ".factory", "preview.yaml"))).toBe(true);
    const got = await call(ann, "GET", url(annRepo));
    expect(got.status).toBe(200);
    expect(got.json()).toMatchObject({ state: "ready", url: view.url });
    expect(got.json().output).toContain("develop");
    expect(got.text).not.toMatch(/"pid"|"appPort"/);
  });

  it("answers 404 to another account and shows the output to an admin", async () => {
    for (const [m, b] of [["POST", { version: "develop" }], ["GET", undefined], ["DELETE", undefined]] as const) {
      const r = await call(bob, m, url(annRepo), b);
      expect(r.status, m).toBe(404);
      expect(r.text).not.toContain("output");
    }
    expect((await call(ann, "GET", url(annRepo))).status).toBe(200);
    expect((await call(admin, "GET", url(annRepo))).json().output).toContain("develop");
    expect((await call(ann, "GET", url("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("checks out the work of a run that waits, from the run's workspace only, and replaces the develop preview", async () => {
    const old = previews().runner.get(annRepo)!.pid!;
    const head = git(workspace, "rev-parse", "HEAD");
    // a run of the same project that another account owns is not named to Ann, even though the project is hers
    expect((await call(ann, "POST", url(annRepo), { version: "checking", runId: waitingRun })).status).toBe(404);
    const r = await call(ann, "POST", url(annRepo), { version: "checking", runId: annWaiting });
    expect(r.status).toBe(202);
    const view = await previews().settled(annRepo);
    expect(view).toMatchObject({ state: "ready", version: "checking", runId: annWaiting });
    expect(alive(old)).toBe(false);
    expect((await call(ann, "GET", url(annRepo))).json().output).toContain("checking");
    // the branch was never pushed: the remote does not have it
    expect(git(bare, "branch", "--list", "feature/7-try")).toBe("");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(head);
    expect(git(workspace, "status", "--porcelain")).toBe("");
  });

  it("stops with DELETE: the process is gone and the folder is removed", async () => {
    const pid = previews().runner.get(annRepo)!.pid!;
    const r = await call(ann, "DELETE", url(annRepo));
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ state: "stopped" });
    expect(r.text).not.toContain("output");
    expect(alive(pid)).toBe(false);
    expect(existsSync(folder(annRepo))).toBe(false);
  });

  it("fails with no-config when the develop branch has no preview file", async () => {
    expect((await call(admin, "PUT", `/api/admin/repos/${annRepo}/settings`, { developBranch: "feature/8-empty" })).status).toBe(200);
    expect((await call(ann, "POST", url(annRepo), { version: "develop" })).status).toBe(202);
    expect(await previews().settled(annRepo)).toMatchObject({ state: "failed", reason: "no-config" });
    expect((await call(admin, "PUT", `/api/admin/repos/${annRepo}/settings`, { developBranch: "no-such-branch" })).status).toBe(200);
    await call(ann, "POST", url(annRepo), { version: "develop" });
    expect(await previews().settled(annRepo)).toMatchObject({ state: "failed", reason: "no-branch" });
  });

  it("previews a local record from its folder and leaves that folder unchanged", async () => {
    const snapshot = () => [git(localRepo, "rev-parse", "HEAD"), git(localRepo, "for-each-ref"), git(localRepo, "status", "--porcelain"), readdirSync(localRepo).join(",")].join("|");
    const before = snapshot();
    expect((await call(admin, "POST", url(localId), { version: "develop" })).status).toBe(202);
    const view = await previews().settled(localId);
    expect(view).toMatchObject({ state: "ready", version: "develop" });
    expect((await call(admin, "GET", url(localId))).json().output).toContain("local");
    expect(snapshot()).toBe(before);
    expect((await call(admin, "DELETE", url(localId))).status).toBe(200);
  });

  it("refuses wrong runs and bad bodies", async () => {
    const post = (b: unknown) => call(ann, "POST", url(annRepo), b);
    expect((await post({ version: "checking", runId: otherRun })).status).toBe(404);
    expect((await post({ version: "checking", runId: waitingRun })).status).toBe(404);
    expect((await post({ version: "checking", runId: "no-such-run" })).status).toBe(404);
    expect((await post({ version: "checking", runId: doneRun })).status).toBe(409);
    for (const b of [{}, { version: "main" }, { version: "develop", runId: annWaiting }, { version: "checking" }, { version: "checking", runId: "../x" }, { version: "checking", runId: 5 }]) {
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(previews().view(annRepo).state).not.toBe("starting");
  });

  it("the real close() of the server stops the preview process", async () => {
    await call(admin, "PUT", `/api/admin/repos/${annRepo}/settings`, { developBranch: "develop" });
    await call(ann, "POST", url(annRepo), { version: "develop" });
    await previews().settled(annRepo);
    const pid = previews().runner.get(annRepo)!.pid!;
    expect(alive(pid)).toBe(true);
    closed = true;
    close();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
  });
});

describe("runBranch and projectRun", () => {
  const step = (id: string, output: string, ok = true) => ({ id, type: "shell", visit: 1, ok, output }) as never;
  it("reads the BRANCH line of the newest successful branch step, else the run's branch", () => {
    expect(runBranch({ history: [step("feature_branch", "BRANCH: feature/1-a (new, from develop)\nabc")], branch: "x" })).toBe("feature/1-a");
    expect(runBranch({ history: [step("feature_branch", "BRANCH: feature/1-a (new)"), step("hotfix_branch", "BRANCH: hotfix/2-b (new, from main)")], branch: "x" })).toBe("hotfix/2-b");
    expect(runBranch({ history: [step("feature_branch", "BRANCH: feature/1-a (new)"), step("feature_branch", "BRANCH: feature/9-z (new)", false)], branch: "x" })).toBe("feature/1-a");
    expect(runBranch({ history: [step("other", "BRANCH: feature/1-a (new)")], branch: "run-branch" })).toBe("run-branch");
    expect(runBranch({ history: [], branch: undefined })).toBeUndefined();
  });

  it("matches a GitHub run by key (any case), a local run by its name, and no run of another kind of record", () => {
    const gh = { id: "a".repeat(8) + "-0000", url: "https://github.com/Acme/App", method: "github-token" } as never;
    expect(projectRun(gh, { vars: { github_repo: "acme/app" } })).toBe(true);
    expect(projectRun(gh, { vars: { github_repo: "ACME/App" } })).toBe(true);
    expect(projectRun(gh, { vars: { github_repo: "acme/other" } })).toBe(false);
    expect(projectRun(gh, { vars: { github_repo: "../x" } })).toBe(false);
    expect(projectRun(gh, { vars: {} })).toBe(false);
    const local = { id: "1234abcd-0000", url: "/tmp/My-App", method: "local" } as never;
    expect(projectRun(local, { vars: { github_repo: "local:my-app-1234abcd" } })).toBe(true);
    expect(projectRun(local, { vars: { github_repo: "acme/app" } })).toBe(false);
    expect(projectRun({ id: "x", url: "https://git.example.com/a/b", method: "https-token" } as never, { vars: { github_repo: "a/b" } })).toBe(false);
  });
});
