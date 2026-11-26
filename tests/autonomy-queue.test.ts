import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { setLevel } from "../src/governance/autonomy-store.js";
import { Scheduler, type Job } from "../src/queue/scheduler.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const FLOW = `name: au\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "true"}\n`;

describe("the level of a queued job (#968)", () => {
  let tmp: string;
  let repo: string;
  let runsDir: string;
  let queueFile: string;
  const saved = process.env.FACTORY_HOME;
  const other = randomUUID();
  const run = (): Job => ({ kind: "run", flow: parseFlow(FLOW), task: "t", repo, vars: {} });
  const config = () => ({ ...ConfigSchema.parse({ bot: { name: "T", email: "t@example.com" }, protected_branches: [], promotion: { enforce: "off" } }) });
  const make = () => new Scheduler({ runsDir, queueFile, claudeBin, config });
  const queueEntry = () => JSON.parse(readFileSync(queueFile, "utf8"))[0];
  const logOf = (id: string) => readFileSync(join(runsDir, id, "live.log"), "utf8");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "autonomy-queue-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    runsDir = join(tmp, "runs");
    queueFile = join(tmp, "queue.json");
    process.env.FACTORY_HOME = join(tmp, "home");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the level at queue time, and the start line says it was raised while queued", async () => {
    setLevel("flows", "au", "guarded-write", other);
    const a = make();
    a.drain();
    const id = a.submit(run());
    expect(a.queuedJob(id)?.autonomy).toBe("guarded-write");
    expect(queueEntry().autonomy).toBe("guarded-write");
    a.close();

    setLevel("flows", "au", "delivery-handoff", other);
    const b = make(); // a restart: the entry is read from the queue file
    expect(b.queuedJob(id)?.autonomy).toBe("guarded-write");
    b.drain();
    b.resume();
    await b.wait(id);
    const summary = JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));
    expect(summary.autonomy.level).toBe("delivery-handoff");
    expect(logOf(id)).toContain("raised guarded-write→delivery-handoff while queued");
  });

  it("says lowered while queued", async () => {
    setLevel("flows", "au", "delivery-handoff", other);
    const a = make();
    a.drain();
    const id = a.submit(run());
    setLevel("flows", "au", "plan-only", other);
    a.resume();
    await a.wait(id);
    expect(logOf(id)).toContain("lowered delivery-handoff→plan-only while queued");
  });

  it("stores no level when the store cannot be read", () => {
    mkdirSync(join(tmp, "home"), { recursive: true });
    writeFileSync(join(tmp, "home", "autonomy.json"), "{");
    const a = make();
    a.drain();
    const id = a.submit(run());
    expect(a.queuedJob(id)?.autonomy).toBeUndefined();
    expect(queueEntry()).not.toHaveProperty("autonomy");
    a.close();
  });

  it("starts an older entry without the field, or with an invalid one, with no clause", async () => {
    setLevel("flows", "au", "delivery-handoff", other);
    const a = make();
    a.drain();
    const old = a.submit(run());
    const bad = a.submit(run());
    a.close();
    const entries = JSON.parse(readFileSync(queueFile, "utf8")) as Array<{ runId: string; autonomy?: unknown }>;
    for (const e of entries) {
      if (e.runId === old) delete e.autonomy;
      else e.autonomy = "full";
    }
    writeFileSync(queueFile, JSON.stringify(entries));
    const b = make();
    b.drain();
    b.resume();
    await Promise.all([b.wait(old), b.wait(bad)]);
    expect(logOf(old)).not.toContain("while queued");
    expect(logOf(bad)).not.toContain("while queued");
    expect(JSON.parse(readFileSync(join(runsDir, bad, "run.json"), "utf8")).status).toBe("succeeded");
  });
});
