import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { TelemetryEventSchema, type TelemetryEvent } from "../src/telemetry/envelope.js";
import { configureTelemetry, flushTelemetry, resetTelemetry, telemetryStats } from "../src/telemetry/telemetry.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const CLI = resolve("dist/cli.js");

describe("telemetry of watchers", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let home: string;

  beforeEach(() => {
    gh = fakeGithub();
    home = join(gh.tmp, "home");
    mkdirSync(home);
    process.env.FACTORY_HOME = home; // gh.restore() puts the whole environment back
    // concurrency 0: the jobs stay queued, so no run makes telemetry of its own
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ({ ...ConfigSchema.parse({}), concurrency: 0 }), claudeBin });
    configureTelemetry(ConfigSchema.parse({ protected_branches: [] }));
  });
  afterEach(() => {
    resetTelemetry();
    gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "true" }, ...over, flow: oldFlowFor(over) }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
    });
  const oneIssue = () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 5, title: "issue 5", labels: [{ name: "claude-factory" }] }]);
  };
  const raw = (dir = home): string => {
    const d = join(dir, "telemetry");
    return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), "utf8")).join("") : "";
  };
  const events = (): TelemetryEvent[] => {
    flushTelemetry();
    return raw().split("\n").filter(Boolean).map((l) => TelemetryEventSchema.parse(JSON.parse(l)));
  };
  const named = (name: string) => events().filter((e) => e.name === name);

  it("records the queued run and the check of an issues watcher", async () => {
    oneIssue();
    await watcher().tick();
    const queued = named("watcher.queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.watcher).toEqual({ id: "w", source: "issues" });
    expect(queued[0]!.repository).toBe("acme/app");
    expect(queued[0]!.runId).toBe(scheduler.queue().pending[0]!.runId);
    expect(queued[0]!.actor).toEqual({ kind: "watcher", id: "w" });
    const checked = named("watcher.checked");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.outcome).toBe("ok");
    expect(Number.isInteger(checked[0]!.durationMs) && checked[0]!.durationMs! >= 0).toBe(true);
  });

  it("records a PR-feedback run with the pull request and no top-level repository", async () => {
    execFileSync("git", ["-C", gh.remote, "branch", "factory/pr-17", "main"]);
    process.env.FAKE_GH_PRS = JSON.stringify([{ number: 17, headRefName: "factory/x" }]);
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({
      comments: [{ author: { login: "alice" }, body: "please rename x", createdAt: new Date(Date.now() - 60_000).toISOString() }],
      reviews: [],
      commits: [{ committedDate: new Date(Date.now() - 3_600_000).toISOString() }],
    });
    await watcher({ source: "pr-feedback" }).tick();
    const runId = scheduler.queue().pending[0]!.runId;
    const fb = named("pull_request.feedback");
    expect(fb).toHaveLength(1);
    expect(fb[0]!.pullRequest).toEqual({ repository: "acme/app", number: 17 });
    expect(fb[0]!.runId).toBe(runId);
    expect(fb[0]!.watcher?.source).toBe("pr-feedback");
    expect(fb[0]!.repository).toBeUndefined();
    const queued = named("watcher.queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runId).toBe(runId);
  });

  it("records a failed check without its error text", async () => {
    process.env.FAKE_GH_FAIL = "repo view";
    process.env.FAKE_GH_FAIL_TEXT = "secret-boom-xyz";
    await watcher().tick();
    const failed = named("watcher.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.outcome).toBe("failed");
    expect(named("watcher.checked")).toHaveLength(0);
    expect(raw()).not.toContain("secret-boom-xyz");
  });

  it("leaves out a watcher id that telemetry does not accept, and drops nothing", async () => {
    oneIssue();
    await watcher({ id: "w".repeat(129) }).tick();
    const t = events().filter((e) => e.name === "watcher.queued" || e.name === "watcher.checked");
    expect(t.map((e) => e.name).sort()).toEqual(["watcher.checked", "watcher.queued"]);
    for (const e of t) {
      expect(e.repository).toBe("acme/app");
      expect(e.watcher).toBeUndefined();
      expect(e.actor).toBeUndefined();
    }
    expect(telemetryStats().dropped.invalid).toBe(0);
  });

  describe("scf watch", () => {
    const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
      const e: NodeJS.ProcessEnv = { ...process.env, SCF_HOME: home, ...extra };
      delete e.FACTORY_HOME;
      return e;
    };
    const watchOnce = (extra: Record<string, string>) => {
      if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`npm run build\` first`);
      return spawnSync(process.execPath, [CLI, "watch", "--once", "--var", "github_repo=acme/app", "--repo", gh.tmp], { env: env(extra), encoding: "utf8", timeout: 30_000 });
    };
    const lines = () => raw().split("\n").filter(Boolean);

    it("writes watcher.checked", () => {
      const r = watchOnce({ FAKE_GH_ISSUES: "[]" });
      expect(r.status).toBe(0);
      const l = lines();
      expect(l).toHaveLength(1);
      const e = TelemetryEventSchema.parse(JSON.parse(l[0]!));
      expect(e.name).toBe("watcher.checked");
      expect(e.watcher).toEqual({ id: "cli", source: "issues" });
    });

    it("writes watcher.failed when gh fails", () => {
      const r = watchOnce({ FAKE_GH_ISSUES: "[]", FAKE_GH_FAIL: "repo view", FAKE_GH_FAIL_TEXT: "secret-boom-xyz" });
      expect(r.status).toBe(1);
      const l = lines();
      expect(l).toHaveLength(1);
      expect(TelemetryEventSchema.parse(JSON.parse(l[0]!)).name).toBe("watcher.failed");
      expect(raw()).not.toContain("secret-boom-xyz");
    });
  });
});
