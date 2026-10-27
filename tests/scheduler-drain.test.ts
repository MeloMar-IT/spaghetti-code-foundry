import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("Scheduler.requestStop", () => {
  const dirs: string[] = [];
  const schedulers: Scheduler[] = [];
  const gates: string[] = [];
  afterEach(async () => {
    for (const g of gates.splice(0)) writeFileSync(g, ""); // release every gate, then wait for the runs to end
    for (const s of schedulers.splice(0)) await s.idle();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const waitFor = async (ok: () => boolean) => {
    const end = Date.now() + 15_000;
    while (!ok() && Date.now() < end) await sleep(20);
    expect(ok()).toBe(true);
  };
  /** An id ending in "*" is a gate: the step waits for a file (with a deadline of its own). The others echo. */
  const setup = (ids: string[]) => {
    const tmp = mkdtempSync(join(tmpdir(), "stop-"));
    dirs.push(tmp);
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const gate = (id: string) => join(tmp, `go-${id}`);
    const steps = ids
      .map((id) => {
        const g = id.endsWith("*");
        const name = g ? id.slice(0, -1) : id;
        const run = g ? `for i in $(seq 1 400); do [ -f ${gate(name)} ] && exit 0; sleep 0.05; done; exit 1` : `echo ${name}`;
        if (g) gates.push(gate(name));
        return `  - {id: ${name}, type: shell, run: ${JSON.stringify(run)}, timeout_sec: 30}`;
      })
      .join("\n");
    const config = () => ({ ...ConfigSchema.parse({}), concurrency: 1 });
    const s = new Scheduler({ runsDir: join(tmp, "runs"), queueFile: join(tmp, "queue.json"), config });
    schedulers.push(s);
    const id = s.submit({ kind: "run", flow: parseFlow(`name: t\nworkspace: inplace\nsteps:\n${steps}\n`), task: "t", repo, vars: {} }, { source: "ui" });
    const open = (name: string) => writeFileSync(gate(name), "");
    const close = (name: string) => rmSync(gate(name), { force: true });
    const at = (step: string) => () => s.get(id)?.status === "running" && s.get(id)?.state.next === step;
    return { s, id, open, close, at };
  };
  const ids = (s: Scheduler, id: string) => s.get(id)!.history.map((h) => h.id);

  it("stops an active run before its next step", async () => {
    const { s, id, open, at } = setup(["a*", "b"]);
    await waitFor(at("a"));
    expect(s.requestStop(id, "overruled")).toBe(true);
    open("a");
    const run = await s.wait(id);
    expect(run!.status).toBe("stopped");
    expect(run!.reason).toBe("overruled");
    expect(run!.state.next).toBe("b");
    expect(ids(s, id)).toEqual(["a"]);
  }, 30_000);

  it("drops a request when the run ends", async () => {
    const { s, id, open, at } = setup(["a", "b*"]);
    await waitFor(at("b"));
    expect(s.requestStop(id, "overruled")).toBe(true); // no boundary is left
    open("b");
    expect((await s.wait(id))!.status).toBe("succeeded");
    expect(s.requestStop(id, "overruled")).toBe(false);
    s.submit({ kind: "resume", runId: id, from: "a" }, { source: "ui" });
    const run = await s.wait(id);
    expect(run!.status).toBe("succeeded");
    expect(ids(s, id)).toEqual(["a", "b", "a", "b"]);
  }, 30_000);

  it("is dropped once the run reaches merge_develop", async () => {
    const { s, id, open, at } = setup(["a*", "merge_develop*", "c"]);
    await waitFor(at("a"));
    expect(s.requestStop(id, "overruled")).toBe(true);
    open("a");
    await waitFor(at("merge_develop"));
    expect(s.requestStop(id, "overruled")).toBe(false);
    open("merge_develop");
    const run = await s.wait(id);
    expect(run!.status).toBe("succeeded");
    expect(ids(s, id)).toEqual(["a", "merge_develop", "c"]);
  }, 30_000);

  it("refuses steps after a merge step too", async () => {
    const { s, id, open, at } = setup(["merge_develop", "test_develop*", "c"]);
    await waitFor(at("test_develop"));
    expect(s.requestStop(id, "overruled")).toBe(false);
    open("test_develop");
    expect((await s.wait(id))!.status).toBe("succeeded");
  }, 30_000);

  it("stops a resumed run before its next step", async () => {
    const { s, id, open, close, at } = setup(["a*", "b"]);
    await waitFor(at("a"));
    open("a");
    expect((await s.wait(id))!.status).toBe("succeeded");
    close("a");
    s.submit({ kind: "resume", runId: id, from: "a" }, { source: "ui" });
    await waitFor(() => s.isActive(id) && at("a")());
    expect(s.requestStop(id, "overruled")).toBe(true);
    open("a");
    const run = await s.wait(id);
    expect(run!.status).toBe("stopped");
    expect(run!.reason).toBe("overruled");
    expect(run!.state.next).toBe("b");
  }, 30_000);

  it("refuses a request for a run resumed after a merge", async () => {
    const { s, id, open, close, at } = setup(["merge_develop", "test_develop*", "c"]);
    await waitFor(at("test_develop"));
    open("test_develop");
    expect((await s.wait(id))!.status).toBe("succeeded");
    close("test_develop");
    s.submit({ kind: "resume", runId: id, from: "test_develop" }, { source: "ui" });
    await waitFor(() => s.isActive(id) && at("test_develop")());
    expect(s.requestStop(id, "overruled")).toBe(false);
    open("test_develop");
    expect((await s.wait(id))!.status).toBe("succeeded");
  }, 30_000);

  it("refuses an unknown run, an empty reason and a cancelled run", async () => {
    const { s, id, at } = setup(["a*", "b"]);
    expect(s.requestStop("nope", "overruled")).toBe(false);
    await waitFor(at("a"));
    expect(s.requestStop(id, "")).toBe(false);
    expect(s.requestStop(id, "   ")).toBe(false);
    s.cancel(id);
    expect(s.requestStop(id, "overruled")).toBe(false);
  }, 30_000);
});
