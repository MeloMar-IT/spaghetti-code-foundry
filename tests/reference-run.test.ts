import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { REF_NO_SANDBOX } from "../src/engine/reference-repos.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadRun } from "../src/engine/state.js";
import { sandboxAvailable } from "../src/engine/os-sandbox.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

/**
 * A watcher's reference repositories (#878, #894), from the watcher's job to the run and its copies. A sandboxed run
 * and an admin's run without the sandbox (held by file modes) get copies; a user's run without the sandbox gets none.
 */

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
let gh: ReturnType<typeof fakeGithub>;
let admin: { id: string };
let user: { id: string };
const savedRemote = process.env.SCF_CONNECT_REMOTE;

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  // every clone of a reference reads the fake remote (one commit on main with README.md)
  process.env.SCF_CONNECT_REMOTE = join(gh.tmp, "remote.git");
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
  own(admin.id); // a repository belongs to one account: the user's tests take it over with `own(user.id)` in a fresh home
});
// one account owns acme/lib; a test that needs it for the user starts from a clean home
const own = (id: string) => addRepo(id, { url: "acme/lib", method: "github-token", token: TOKEN });
const ownByUser = async () => {
  process.env.FACTORY_HOME = join(gh.tmp, "home-user");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
  own(user.id);
};
afterEach(() => {
  if (savedRemote === undefined) delete process.env.SCF_CONNECT_REMOTE;
  else process.env.SCF_CONNECT_REMOTE = savedRemote;
  gh.restore();
});

const runs = () => join(gh.tmp, "runs");
const config = ConfigSchema.parse({ protected_branches: [] });
const REF = '"$FACTORY_WORKDIR/../reference/acme-lib"';
const read = `cat ${REF}/README.md`;
const look = [
  `cat ${REF}/README.md`,
  `(echo x > ${REF}/README.md) 2>/dev/null && echo WROTE || echo NOWRITE`,
  `(echo x > ${REF}/NEW.md) 2>/dev/null && echo CREATED || echo NOCREATE`,
  `(chmod u+w ${REF}/README.md && echo x > ${REF}/README.md) 2>/dev/null && echo CHMODDED || echo NOCHMOD`,
  `git -C ${REF} -c user.email=t@t -c user.name=t commit --allow-empty -qm x 2>/dev/null && echo COMMITTED || echo NOCOMMIT`,
].join("; ");
const flowOf = (extra = "", script = look) =>
  parseFlow(
    `name: refs\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${extra}  - id: look\n    type: shell\n    run: ${JSON.stringify(script)}\n  - id: agent\n    type: claude\n    prompt: SHOWPROMPT\n`,
    "refs.yaml",
  );
const out = (s: { history: { id: string; output: string }[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)?.output ?? "";
const sandboxed = ConfigSchema.parse({ protected_branches: [], sandbox: { user_runs: "required" } });
const go = (flow: ReturnType<typeof flowOf>, references?: unknown, owner = admin.id, cfg = config) =>
  runFlow(flow, { task: "t", repo: gh.tmp, runsDir: runs(), claudeBin, config: cfg, owner, vars: { github_repo: "acme/app" }, ...(references ? { references } : {}) });

describe("a run with reference repositories", { timeout: 60_000 }, () => {
  it("an admin's run without the OS sandbox holds the copy by file modes, and removes it at the end", async () => {
    const s = await go(flowOf("", read), { repos: ["acme/lib", "acme/gone"], privateOk: true });
    expect(s.status).toBe("succeeded");
    const saved = loadRun(runs(), s.runId)!;
    const copy = saved.references!.find((r) => r.repo === "acme/lib")!;
    expect(copy).toMatchObject({ ok: true, held: "file modes", folder: "reference/acme-lib" });
    expect(saved.references!.find((r) => r.repo === "acme/gone")!.ok).toBe(false);
    const prompt = out(s, "agent");
    expect(prompt).toContain(`- acme/lib: ${join(s.runDir, "reference", "acme-lib")} (commit ${copy.commit!.slice(0, 12)})`);
    expect(prompt).toContain("Not available in this run: acme/gone.");
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain("; held: file modes)");
    expect(existsSync(join(s.runDir, "reference"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("a copy changed by a shell step is removed before the next agent step, and the run goes on", async () => {
    const s = await go(flowOf("", `chmod u+w ${REF}/README.md; echo CHMODDED`), { repos: ["acme/lib"], privateOk: true });
    expect(s.status).toBe("succeeded");
    expect(out(s, "look")).toContain("CHMODDED");
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain("! reference acme/lib: removed — it was changed during the run");
    const prompt = out(s, "agent");
    expect(prompt).toContain("Not available in this run: acme/lib.");
    expect(prompt).not.toContain("- acme/lib:");
    expect(loadRun(runs(), s.runId)!.references!.at(-1)).toMatchObject({ ok: false, reason: "it was changed during the run" });
  });

  it("a user's run without the OS sandbox makes no copy and records why", async () => {
    await ownByUser();
    const s = await go(flowOf("", "echo hi"), { repos: ["acme/lib"], privateOk: true }, user.id);
    expect(s.status).toBe("succeeded");
    expect(loadRun(runs(), s.runId)!.references!.map((r) => [r.ok, r.reason])).toEqual([[false, REF_NO_SANDBOX]]);
    expect(existsSync(join(s.runDir, "reference"))).toBe(false);
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toMatch(/! reference acme\/lib: skipped — this run has no OS sandbox/);
  });

  it.skipIf(!sandboxAvailable())("a sandboxed user's run reads a locked copy, refuses every write and chmod, and removes the copy at the end", async () => {
    // the test setup turns the user sandbox off for every test; this one needs it on
    const keep = { SCF_USER_SANDBOX: process.env.SCF_USER_SANDBOX, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    delete process.env.SCF_USER_SANDBOX;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-878";
    try {
      await sandboxedCase();
    } finally {
      for (const [k, v] of Object.entries(keep)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  const sandboxedCase = async () => {
    await ownByUser();
    const s = await go(flowOf(), { repos: ["acme/lib", "acme/gone"], privateOk: true }, user.id, sandboxed);
    expect([s.status, s.reason]).toEqual(["succeeded", undefined]);
    const lines = out(s, "look").trim().split("\n");
    expect(lines[0]).toBe("hi");
    expect(lines.slice(1)).toEqual(["NOWRITE", "NOCREATE", "NOCHMOD", "NOCOMMIT"]);
    const saved = loadRun(runs(), s.runId)!;
    const copy = saved.references!.find((r) => r.repo === "acme/lib")!;
    expect(copy).toMatchObject({ ok: true, folder: "reference/acme-lib", held: "sandbox" });
    expect(saved.references!.find((r) => r.repo === "acme/gone")!.ok).toBe(false);
    const prompt = out(s, "agent");
    expect(prompt).toContain(`- acme/lib: ${join(s.runDir, "reference", "acme-lib")} (commit ${copy.commit!.slice(0, 12)})`);
    expect(prompt).toContain("Not available in this run: acme/gone.");
    expect(existsSync(join(s.runDir, "reference"))).toBe(false);
  };

  it("waits without copies, and resumes without copies in an admin's run; the references are kept in run.json", async () => {
    const s = await go(flowOf("  - id: ok\n    type: approval\n    message: go on?\n", read), { repos: ["acme/lib"], privateOk: true });
    expect(s.status).toBe("waiting");
    expect(existsSync(join(s.runDir, "reference"))).toBe(false);
    const r = await resumeRun({ runsDir: runs(), runId: s.runId, claudeBin, config, decision: { approved: true, by: "admin" } });
    expect(r.status).toBe("succeeded");
    const saved = loadRun(runs(), s.runId)!;
    expect(saved.referenceRepos).toEqual({ repos: ["acme/lib"], privateOk: true });
    expect(saved.references!.map((x) => [x.ok, x.held])).toEqual([[true, "file modes"], [true, "file modes"]]);
    expect(existsSync(join(s.runDir, "reference"))).toBe(false);
  });

  it("changes nothing without references", async () => {
    const s = await go(flowOf());
    expect(s.status).toBe("succeeded");
    const saved = JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8"));
    expect("referenceRepos" in saved || "references" in saved).toBe(false);
    expect(out(s, "agent")).not.toContain("Reference repositories");
  });

  it("goes from the watcher's job through the scheduler to the saved run", async () => {
    const scheduler = new Scheduler({ runsDir: runs(), config: () => config, claudeBin });
    scheduler.drain();
    const cfg = WatcherSchema.parse({ id: "rel", github_repo: "acme/app", source: "schedule", flow: "release-daily", every: "1d", task: "tidy", reference_repos: ["acme/lib"], reference_private_ok: true });
    const w = new Watcher(cfg, { scheduler, runsDir: runs(), repo: gh.tmp, log: () => undefined });
    await (w as unknown as { tickChore(): Promise<void> }).tickChore();
    const queued = scheduler.queue().pending.map((p) => scheduler.queuedJob(p.runId)!.job);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "run", references: { repos: ["acme/lib"], privateOk: true } });
    // without the option the job has no references
    const plain = new Scheduler({ runsDir: join(gh.tmp, "runs2"), config: () => config });
    plain.drain();
    const w2 = new Watcher(WatcherSchema.parse({ ...cfg, reference_repos: undefined, reference_private_ok: undefined }), { scheduler: plain, runsDir: join(gh.tmp, "runs2"), repo: gh.tmp, log: () => undefined });
    await (w2 as unknown as { tickChore(): Promise<void> }).tickChore();
    expect("references" in plain.queuedJob(plain.queue().pending[0]!.runId)!.job).toBe(false);
    // the scheduler passes the job's list to the run
    const live = new Scheduler({ runsDir: runs(), config: () => config, claudeBin });
    const runId = live.submit({ kind: "run", flow: flowOf("", read), task: "t", repo: gh.tmp, vars: { github_repo: "acme/app" }, references: { repos: ["acme/lib"], privateOk: true } }, { source: "test", owner: admin.id });
    const done = await live.wait(runId);
    expect(done?.status).toBe("succeeded");
    expect(loadRun(runs(), runId)!.referenceRepos).toEqual({ repos: ["acme/lib"], privateOk: true });
    expect(loadRun(runs(), runId)!.references!.map((r) => r.ok)).toEqual([true]);
  });
});
