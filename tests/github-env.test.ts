import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { type GhSession, ghActsAsApp, gh, currentGhSession, withGhEnv } from "../src/github.js";
import { type Job, Scheduler } from "../src/queue/scheduler.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

let fake: ReturnType<typeof fakeGithub>;
let log: ReturnType<ReturnType<typeof fakeGithub>["authLog"]>;
let dir: string;

const TOKEN_A = "tokenA-" + "a1".repeat(10);
const TOKEN_B = "tokenB-" + "b2".repeat(10);
const session = (token: string, app = false): GhSession => ({ env: { GH_TOKEN: token, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GH_CONFIG_DIR: dir }, app, stamp: token });

beforeEach(() => {
  fake = fakeGithub();
  log = fake.authLog();
  dir = mkdtempSync(join(tmpdir(), "gh-env-"));
  Object.assign(process.env, { GH_TOKEN: "host-token", GITHUB_TOKEN: "host-github", GH_ENTERPRISE_TOKEN: "host-enterprise" });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  fake.restore();
});

describe("withGhEnv", () => {
  it("without a scope the child env is the process env", async () => {
    await gh(["api", "user"]);
    expect(log.rows()[0]).toMatchObject({ token: "host-token", githubToken: "host-github", enterpriseToken: "host-enterprise", configDir: "host" });
  });

  it("inside a scope the token and the empty settings folder are set, the inherited ones are gone", async () => {
    await withGhEnv(session(TOKEN_A), () => gh(["api", "user"]));
    expect(log.rows()[0]).toMatchObject({ token: TOKEN_A, githubToken: "-", enterpriseToken: "-", configDir: "0" });
  });

  it("an explicit env wins over the scope, and an inner host scope gives the host env", async () => {
    await withGhEnv(session(TOKEN_A), async () => {
      await gh(["api", "user"], { GH_TOKEN: "explicit" });
      await withGhEnv(undefined, () => gh(["api", "user"]));
    });
    const rows = log.rows();
    expect(rows[0]!.token).toBe("explicit");
    expect(rows[1]).toMatchObject({ token: "host-token", configDir: "host" });
  });

  it("overlapping scopes never mix tokens, and timers and promises keep their scope", async () => {
    process.env.FAKE_GH_SLEEP = "0.2";
    const a = withGhEnv(session(TOKEN_A), async () => {
      await new Promise((r) => setTimeout(r, 20));
      await gh(["api", "user"]);
      return currentGhSession()?.stamp;
    });
    const b = withGhEnv(session(TOKEN_B), async () => {
      await Promise.resolve().then(() => gh(["api", "user"]));
      return currentGhSession()?.stamp;
    });
    expect(await Promise.all([a, b])).toEqual([TOKEN_A, TOKEN_B]);
    expect(log.rows().map((r) => r.token).sort()).toEqual([TOKEN_A, TOKEN_B]);
    expect(ghActsAsApp()).toBe(false);
    expect(withGhEnv(session(TOKEN_A, true), () => ghActsAsApp())).toBe(true);
  });

  it("an error whose text holds the token has it replaced", async () => {
    process.env.FAKE_GH_FAIL = "api user";
    process.env.FAKE_GH_FAIL_TEXT = `bad news about ${TOKEN_A}`;
    const e = await withGhEnv(session(TOKEN_A), () => gh(["api", "user"])).catch((x: Error & { stderr?: string }) => x);
    expect(e).toBeInstanceOf(Error);
    const err = e as Error & { stderr?: string };
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain(TOKEN_A);
    expect(err.stderr).toContain("[redacted]");
    expect(err.stderr).not.toContain(TOKEN_A);
  });
});

describe("the scheduler starts jobs in a host scope", () => {
  const FLOW = "name: quick\nworkspace: inplace\nsteps:\n  - id: a\n    type: shell\n    run: \"true\"\n";
  let seen: { runId: string; session: GhSession | undefined }[];
  let concurrency: number;
  let scheduler: Scheduler;
  beforeEach(() => {
    seen = [];
    concurrency = 1;
    mkdirSync(join(fake.tmp, "runs"), { recursive: true });
    scheduler = new Scheduler({
      runsDir: join(fake.tmp, "runs"),
      config: () => ({ ...ConfigSchema.parse({}), concurrency }),
      claudeBin,
      onFinished: (s) => void seen.push({ runId: s.runId, session: currentGhSession() }),
    });
  });
  const job = (): Job => ({ kind: "run", flow: parseFlow(FLOW), task: "t", repo: fake.tmp, vars: {} });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 100 && !f(); i++) await sleep(100);
  };

  it("a job submitted inside a scope finishes without it", async () => {
    const id = withGhEnv(session(TOKEN_A), () => scheduler.submit(job(), { source: "ui" }));
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ runId: id, session: undefined }]);
  });

  it("setPriority() inside a scope starts a job without it, and so does the job that starts after it", async () => {
    concurrency = 0;
    const a = scheduler.submit(job(), { source: "ui" });
    const b = scheduler.submit(job(), { source: "ui" });
    await sleep(50);
    expect(scheduler.queue().active).toHaveLength(0);
    concurrency = 1;
    withGhEnv(session(TOKEN_A), () => scheduler.setPriority(b, true));
    await until(() => seen.length === 2);
    expect(seen.map((s) => s.runId).sort()).toEqual([a, b].sort());
    expect(seen.every((s) => s.session === undefined)).toBe(true);
  });
});

