import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { RESTART_INTERRUPTED } from "../src/engine/running.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type Job } from "../src/queue/scheduler.js";

const SLOW = `name: slow\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "sleep 0.6"}\n`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Scheduler.drain", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("lets the active run finish, starts nothing queued or newly submitted, and keeps the queue for the next server", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drain-"));
    dirs.push(tmp);
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const queueFile = join(tmp, "queue.json");
    const config = () => ({ ...ConfigSchema.parse({}), concurrency: 1 });
    const job = (): Job => ({ kind: "run", flow: parseFlow(SLOW), task: "t", repo, vars: {} });
    const s = new Scheduler({ runsDir: join(tmp, "runs"), queueFile, config });
    s.submit(job(), { source: "ui" });
    const queued = s.submit(job(), { source: "ui" });
    expect(s.queue().active).toHaveLength(1);
    expect(s.queue().pending.map((p) => p.runId)).toEqual([queued]);

    s.drain();
    expect(s.draining).toBe(true);
    const late = s.submit(job(), { source: "ui" }); // an API submission during the drain
    for (let i = 0; i < 200 && s.queue().active.length; i++) await sleep(50);
    await sleep(300);
    expect(s.queue().active).toHaveLength(0);
    expect(s.queue().pending.map((p) => p.runId)).toEqual([queued, late]);
    expect(JSON.parse(readFileSync(queueFile, "utf8")).map((q: { runId: string }) => q.runId)).toEqual([queued, late]);

    const next = new Scheduler({ runsDir: join(tmp, "runs"), queueFile, config });
    await sleep(100);
    expect(next.queue().active.map((a) => a.runId)).toEqual([queued]);
    expect(next.queue().pending.map((p) => p.runId)).toEqual([late]);
  });

  it("resume() starts the queued jobs again; without a drain it does nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drain-"));
    dirs.push(tmp);
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const config = () => ({ ...ConfigSchema.parse({}), concurrency: 1 });
    const job = (): Job => ({ kind: "run", flow: parseFlow(SLOW), task: "t", repo, vars: {} });
    const s = new Scheduler({ runsDir: join(tmp, "runs"), queueFile: join(tmp, "queue.json"), config });
    s.resume();
    expect(s.draining).toBe(false);
    s.drain();
    const id = s.submit(job(), { source: "ui" });
    expect(s.queue().pending.map((p) => p.runId)).toEqual([id]);
    s.resume();
    expect(s.draining).toBe(false);
    expect(s.queue().active.map((a) => a.runId)).toEqual([id]);
    await s.idle();
  });
});

describe("Scheduler.interrupt", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const BG = `name: bg
workspace: inplace
steps:
  - id: a
    type: shell
    run: |
      sh -c 'trap "" TERM; echo $$ > child.pid; sleep 60' >/dev/null 2>&1 &
      sleep 60
`;
  const setup = () => {
    const tmp = mkdtempSync(join(tmpdir(), "interrupt-"));
    dirs.push(tmp);
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const config = () => ({ ...ConfigSchema.parse({}), concurrency: 1 });
    const s = new Scheduler({ runsDir: join(tmp, "runs"), queueFile: join(tmp, "queue.json"), config });
    const id = s.submit({ kind: "run", flow: parseFlow(BG), task: "t", repo, vars: {} }, { source: "ui" });
    return { s, id, repo };
  };
  const waitFor = async (ok: () => boolean) => {
    const end = Date.now() + 15_000;
    while (!ok() && Date.now() < end) await sleep(20);
    expect(ok()).toBe(true);
  };
  const pidIn = (repo: string) => (existsSync(join(repo, "child.pid")) ? Number(readFileSync(join(repo, "child.pid"), "utf8").trim()) : 0);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("stops the run as interrupted, with its child processes dead when it returns", async () => {
    const { s, id, repo } = setup();
    await waitFor(() => pidIn(repo) > 0);
    const pid = pidIn(repo);
    expect(await s.interrupt([id])).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(s.isActive(id)).toBe(false);
    const run = s.get(id)!;
    expect(run.status).toBe("cancelled");
    expect(run.reason).toBe(RESTART_INTERRUPTED);
    expect(run.state.next).toBe("a");
  }, 30_000);

  it("an unknown id counts as done", async () => {
    const { s, id, repo } = setup();
    expect(await s.interrupt(["nope"])).toBe(true);
    await waitFor(() => pidIn(repo) > 0);
    expect(await s.interrupt([id])).toBe(true);
  }, 30_000);

  it("a normal cancel keeps its own reason", async () => {
    const { s, id, repo } = setup();
    await waitFor(() => pidIn(repo) > 0);
    s.cancel(id);
    await s.idle();
    expect(s.get(id)!.reason).toBe('cancelled during step "a"');
  }, 30_000);
});
