import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../../src/server/server.js";
import { addRepo } from "../../src/auth/repos.js";
import { createUser } from "../../src/auth/users.js";
import { createSession } from "../../src/refinement/store.js";
import { addRepoWatcher } from "../../src/repos/watchers.js";
import { fakeGit, fakeGithub } from "../helpers/fake-github.js";
import { fakeKeychain } from "../helpers/keychain.js";
import { signInAs, TEST_PASSWORD } from "../helpers/session.js";

export interface SeedAccount { id: string; name: string; email: string; password: string; role: "admin" | "user" }

/** What the launcher prints: plain data only. */
export interface SeedData {
  url: string;
  admin: SeedAccount;
  user: SeedAccount;
  /** The admin's runs by status (running, waiting, succeeded, failed, cancelled, stopped). */
  runs: Record<string, string>;
  /** The ids of the runs the user owns. */
  userRuns: string[];
  repoId: string;
  sessionId: string;
  watcherId: string;
}

export interface Seeded extends SeedData {
  close(): Promise<void>;
}

const GATE = `name: gate
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const HOLD = `name: hold
workspace: empty
publish:
  enabled: true
steps:
  - {id: wait, type: shell, run: "sleep 7200"}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the real server on a free port with its own temporary data folder (FACTORY_HOME is set to it and put back on close),
 * two accounts and seeded data. Do not run two at the same time in one process: they would share process.env.
 */
export async function startSeeded(): Promise<Seeded> {
  const saved = { home: process.env.FACTORY_HOME, lock: process.env.FACTORY_LOCK_DIR, path: process.env.PATH };
  // what is set up so far; close() undoes exactly this, also after a failure half way
  let tmp: string | undefined;
  let kc: ReturnType<typeof fakeKeychain> | undefined;
  let gh: ReturnType<typeof fakeGithub> | undefined;
  const liveIds: string[] = [];
  let ctx: Awaited<ReturnType<typeof startServer>>["ctx"] | undefined;
  let stop: (() => void) | undefined;
  let closed: Promise<void> | undefined;
  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const close = (): Promise<void> => (closed ??= (async () => {
    const attempt = async (fn: () => unknown) => {
      try { await fn(); } catch { /* the next step still runs */ }
    };
    if (ctx) {
      const sch = ctx.scheduler;
      for (const id of liveIds) await attempt(() => sch.cancel(id));
      for (const id of liveIds) await attempt(() => Promise.race([sch.wait(id), sleep(5000)]));
    }
    await attempt(() => stop?.());
    await attempt(() => gh?.restore());
    await attempt(() => kc?.remove());
    await attempt(() => tmp && rmSync(tmp, { recursive: true, force: true }));
    restoreEnv("PATH", saved.path);
    restoreEnv("FACTORY_LOCK_DIR", saved.lock);
    restoreEnv("FACTORY_HOME", saved.home);
  })());

  try {
    tmp = mkdtempSync(join(tmpdir(), "ui-harness-"));
    const home = join(tmp, "home");
    process.env.FACTORY_HOME = home;
    process.env.FACTORY_LOCK_DIR = join(home, "locks");
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const runsDir = join(tmp, "runs");

    kc = fakeKeychain();
    gh = fakeGithub();
    fakeGit(gh);

    // accounts, repository, session and watcher first: the server reads the stored watchers when it starts
    await createUser({ name: "Test Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
    const userAcc = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "user" });
    const rec = addRepo(userAcc.id, { url: "acme/app", method: "github-token", token: ["github", "pat", ""].join("_") + "Zx9".repeat(12) });
    const session = createSession(userAcc.id, { repo: "acme/app", idea: "Show the build status on the board" }, { ownerOk: () => true, repoName: (_o, n) => n });
    addRepoWatcher(rec.id, { id: "ui-w" });

    let url = "";
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({ repo, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {}, refinementSweepMs: 3_600_000 });
        ctx = started.ctx;
        stop = started.close;
        url = `http://127.0.0.1:${port}`;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      }
    }

    const admin = await signInAs(url, { create: false });
    const user = await signInAs(url, { name: "Ann", email: "ann@example.com", role: "user", create: false });

    const writeRun = (id: string, owner: string, status: string, reason?: string) => {
      mkdirSync(join(runsDir, id), { recursive: true });
      writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({
        runId: id, flow: "gate", task: `Seeded ${status} run`, vars: {}, repo, source: "ui", status, owner, runDir: join(runsDir, id),
        startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:05:00.000Z", totalCostUsd: 0, history: [],
        state: { next: null, steps: {}, visits: {} }, ...(reason ? { reason } : {}),
      }));
    };
    writeRun("ui-succeeded", admin.user.id, "succeeded");
    writeRun("ui-failed", admin.user.id, "failed", "boom");
    writeRun("ui-cancelled", admin.user.id, "cancelled");
    writeRun("ui-stopped", admin.user.id, "stopped", "daily budget reached");
    writeRun("ui-user-succeeded", user.user.id, "succeeded");
    writeRun("ui-user-failed", user.user.id, "failed", "boom");

    const send = (method: string, path: string, body: unknown) =>
      fetch(url + path, { method, headers: { "content-type": "application/json", ...admin.headers(method) }, body: JSON.stringify(body) });
    for (const [name, yaml] of [["gate", GATE], ["hold", HOLD]] as const) {
      const r = await send("PUT", `/api/flows/${name}`, { yaml, scope: "repo" });
      if (r.status !== 200) throw new Error(`could not save the flow ${name}: ${r.status} ${await r.text()}`);
    }
    const start = async (flow: string) => {
      const r = await send("POST", "/api/runs", { flow, task: `Seeded ${flow} run` });
      if (r.status !== 201) throw new Error(`could not start the ${flow} run: ${r.status} ${await r.text()}`);
      const id = ((await r.json()) as { runId: string }).runId;
      liveIds.push(id);
      return id;
    };
    const sch = ctx!.scheduler;
    const waitingId = await start("gate");
    const waited = await sch.wait(waitingId);
    if (waited?.status !== "waiting") throw new Error(`the gate run should be waiting but is ${waited?.status}`);
    const runningId = await start("hold");
    const end = Date.now() + 10_000;
    while (sch.get(runningId)?.status !== "running" && Date.now() < end) await sleep(50);
    if (sch.get(runningId)?.status !== "running") throw new Error(`the hold run should be running but is ${sch.get(runningId)?.status}`);

    return {
      url,
      admin: { id: admin.user.id, name: "Test Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" },
      user: { id: user.user.id, name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "user" },
      runs: { running: runningId, waiting: waitingId, succeeded: "ui-succeeded", failed: "ui-failed", cancelled: "ui-cancelled", stopped: "ui-stopped" },
      userRuns: ["ui-user-succeeded", "ui-user-failed"],
      repoId: rec.id,
      sessionId: session.id,
      watcherId: "ui-w",
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
