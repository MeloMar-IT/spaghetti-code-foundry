import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";

const flow = () => parseFlow("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: echo one}\n");
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sched-settled-")); mkdirSync(join(tmp, "repo")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const make = (o: Partial<ConstructorParameters<typeof Scheduler>[0]>) =>
  new Scheduler({ runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), config: () => ConfigSchema.parse({ protected_branches: [] }), queueFile: join(tmp, "queue.json"), ...o });
const submit = (s: Scheduler) => s.submit({ kind: "run", flow: flow(), task: "t", repo: join(tmp, "repo"), vars: {} });

describe("Scheduler onSettled", () => {
  it("runs after the run has left the active list, when onFinished still sees it active", async () => {
    let resolveHook!: (v: { active: boolean; archive: string; during: boolean }) => void;
    const seen = new Promise<{ active: boolean; archive: string; during: boolean }>((r) => (resolveHook = r));
    let during = true;
    const s: Scheduler = make({
      onFinished: (x) => { during = s.isActive(x.runId); },
      onSettled: (x) => resolveHook({ active: s.isActive(x.runId), archive: s.setArchived(x.runId, true, "t"), during }),
    });
    submit(s);
    expect(await seen).toEqual({ active: false, archive: "done", during: true });
  });

  it("a throwing hook does not stop the next job", async () => {
    const s = make({ onSettled: () => { throw new Error("boom"); } });
    const a = submit(s);
    const b = submit(s);
    expect((await s.wait(a))?.status).toBe("succeeded");
    expect((await s.wait(b))?.status).toBe("succeeded");
  });

  it("a rejected `done` leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const s: Scheduler = make({
        onFinished: (x) => {
          writeFileSync(join(x.runDir, "run.json"), "{broken");
          throw new Error("hook failed");
        },
        onSettled: () => {},
      });
      const j = submit(s);
      await s.wait(j).catch(() => {});
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});
