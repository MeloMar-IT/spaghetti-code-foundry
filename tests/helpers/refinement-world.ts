import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addRepo, listRepos, type RepoRecord } from "../../src/auth/repos.js";
import { startServer, type ServerOptions } from "../../src/server/server.js";
import { fakeGit, fakeGithub } from "./fake-github.js";
import { fakeKeychain } from "./keychain.js";
import { signInAs, type TestSession } from "./session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"];

export interface Reply {
  status: number;
  text: string;
  json(): any;
  error(): string;
}

/** A running Foundry with the fake claude, gh and git, an admin, Ann (acme/app) and Bob (other/thing). */
export interface World {
  base: string;
  tmp: string;
  gh: ReturnType<typeof fakeGithub>;
  admin: TestSession;
  ann: TestSession;
  bob: TestSession;
  started: Awaited<ReturnType<typeof startServer>>;
  call(who: TestSession, method: string, path: string, body?: unknown): Promise<Reply>;
  /** GET /api/refinement/:id */
  get(id: string, who?: TestSession): Promise<any>;
  /** Polls every 100 ms, for at most 30 s. */
  until(id: string, test: (s: any) => boolean): Promise<any>;
  idle(id: string): Promise<any>;
  runJson(runId: string): any;
  annRepo(): RepoRecord;
  close(): Promise<void>;
}

export async function openWorld(name: string): Promise<World> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV) saved[k] = process.env[k];
  const tmp = mkdtempSync(join(tmpdir(), `${name}-`));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  for (const k of ["FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"]) delete process.env[k];
  const kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  const started = await startServer(opts);
  const admin = await signInAs(base);
  const ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  const bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  addRepo(bob.user.id, { url: "other/thing", method: "github-token", token: TOKEN });

  const call: World["call"] = async (who, method, path, body) => {
    const send = () =>
      fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const r = await send().catch(() => send());
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
  };
  const get: World["get"] = async (id, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
  const until: World["until"] = async (id, test) => {
    for (let i = 0; i < 300; i++) {
      const s = await get(id);
      if (test(s)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${JSON.stringify((await get(id)).architect)}`);
  };
  return {
    base, tmp, gh, admin, ann, bob, started, call, get, until,
    idle: (id) => until(id, (s) => s.architect.state === "idle"),
    runJson: (runId) => JSON.parse(readFileSync(join(tmp, "runs", runId, "run.json"), "utf8")),
    annRepo: () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!,
    async close() {
      if (!started.ctx.scheduler.draining) await started.ctx.scheduler.idle();
      started.close();
      kc.remove();
      gh.restore();
      for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
