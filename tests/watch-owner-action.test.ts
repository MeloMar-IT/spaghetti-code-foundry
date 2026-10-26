import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const TRIGGER = "claude-factory";
const ASKS = "factory:needs-info";
const WORKING = "factory:working";

const bot = (body: string, createdAt = "2026-01-01T00:00:00Z") => ({ author: { login: "bot" }, body, createdAt });
const owner = (extra = "") => bot(`**Q1. Commit config/app.yaml with the production settings**\n**Kind:** owner_action\n${extra}**Recommendation:** none\n<!-- claude-factory run=r1 -->`);
const product = "**Q2. Which colour?**\n**Kind:** product\n**Recommendation:** blue\n";
const said = (body: string, login = "marcel") => ({ author: { login }, body, createdAt: "2026-01-01T01:00:00Z" });

describe("owner_action questions", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let submit: ReturnType<typeof vi.spyOn>;
  let logged: string[];
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    logged = [];
    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_LABEL_FILTER = "1";
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
    submit = vi.spyOn(scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ["FAKE_GH_FAIL_ON", "FAKE_GH_COMMENTS", "FAKE_GH_PERMISSION", "FAKE_GH_LABEL_FILTER", "FAKE_GH_FILES", "FAKE_GH_DIRS"]) delete process.env[k];
    gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { develop_branch: "develop" }, flow: oldFlowFor({}), status_comment: false, auto_defaults: true, ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: (m: string) => { logged.push(m); },
    });
  const issues = () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "issue 4", state: "OPEN", labels: [TRIGGER, ASKS].map((name) => ({ name })) }]);
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const plant = () => {
    const runDir = join(gh.tmp, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    saveRun({
      runId: "r1", flow: oldFlowFor({}), flowDef: { name: oldFlowFor({}), steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: gh.tmp, status: "stopped", runDir,
      reason: 'stopped at step "send_back"', startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0,
      history: [{ id: "plan", type: "claude", visit: 1, ok: true, output: "Why.\nPLAN_STATUS: NEEDS_INFO" }],
      state: { next: "send_back", steps: {}, visits: {} }, ...{},
    } as unknown as RunSummary);
  };
  const log = () => gh.ghLog();
  const hold = (w: Watcher) => w.status.holds?.find((h) => h.issue === 4);
  const contentsCalls = () => log().split("\n").filter((l) => l.includes("contents/"));

  it("is not answered with /defaults, and nothing resumes at later checks", async () => {
    plant(); issues(); comments(owner());
    const w = watcher();
    await w.tick();
    await w.tick();
    expect(log()).not.toContain("comment on #4");
    expect(log()).not.toContain("auto-defaults");
    expect(submit).not.toHaveBeenCalled();
    expect(hold(w)?.next.kind).toBe("owner_action");
    expect(hold(w)?.next.action).toBe("Commit config/app.yaml with the production settings");
    expect(hold(w)?.next.status).toBe("waiting for you — something to do");
  });

  it("resumes after a person's answer", async () => {
    plant(); issues(); comments(owner(), said("Done, it is committed."));
    await watcher().tick();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
    expect(log()).toContain(`--add-label ${WORKING}`);
    expect(log()).not.toContain("auto-defaults");
  });

  it("resumes once the file is on develop, with one note, and not before", async () => {
    plant(); issues(); comments(owner("**Needs:** file `config/app.yaml`\n"));
    process.env.FAKE_GH_FILES = "[]";
    const w = watcher();
    await w.tick();
    expect(contentsCalls()).toHaveLength(1);
    expect(contentsCalls()[0]).toContain("repos/acme/app/contents/config/app.yaml?ref=develop");
    expect(submit).not.toHaveBeenCalled();
    expect(hold(w)?.next.until).toContain("`config/app.yaml` is on `develop`");
    process.env.FAKE_GH_FILES = JSON.stringify(["develop:config/app.yaml"]);
    await w.tick();
    expect(log()).toContain("owner-file");
    expect(log()).not.toContain("auto-defaults");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
    expect(w.status.lastActions.join("\n")).toContain("`config/app.yaml` is on `develop`");
  });

  it("keeps the question open when the note was posted but the resume did not happen", async () => {
    plant(); issues();
    comments(owner("**Needs:** file config/app.yaml.\n"), bot("**Nothing needed from you** — x\n\n<!-- spaghetti-code-foundry owner-file -->", "2026-01-01T00:05:00Z"));
    process.env.FAKE_GH_FILES = JSON.stringify(["develop:config/app.yaml"]);
    await watcher().tick();
    expect(log()).not.toContain("auto-defaults");
    expect(contentsCalls()[0]).toContain("contents/config/app.yaml?ref=develop"); // the trailing full stop is not part of the path
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
  });

  it("looks only on develop with gitflow, and on the default branch without it", async () => {
    plant(); issues(); comments(owner("**Needs:** file config/app.yaml\n"));
    process.env.FAKE_GH_FILES = JSON.stringify(["main:config/app.yaml", "default:other"]);
    await watcher().tick();
    expect(submit).not.toHaveBeenCalled();
    process.env.FAKE_GH_FILES = JSON.stringify(["default:config/app.yaml"]);
    await watcher({ vars: { develop_branch: "" } }).tick();
    expect(contentsCalls().at(-1)).toMatch(/contents\/config\/app\.yaml$/);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
  });

  it("does not look for a file when another open question needs a person", async () => {
    plant(); issues(); comments(bot(`${owner("**Needs:** file config/app.yaml\n").body}\n${product}`));
    process.env.FAKE_GH_FILES = JSON.stringify(["develop:config/app.yaml"]);
    const w = watcher();
    await w.tick();
    expect(contentsCalls()).toHaveLength(0);
    expect(log()).not.toContain("auto-defaults");
    expect(submit).not.toHaveBeenCalled();
    expect(hold(w)?.next.kind).toBe("owner_action");
  });

  it("starts an issue with up-front questions once the file is there, and never answers them with /defaults", async () => {
    issues();
    comments(bot("**Q1. Commit config/app.yaml**\n**Kind:** owner_action\n**Needs:** file config/app.yaml\n<!-- claude-factory run=pre1 questions -->"));
    process.env.FAKE_GH_FILES = "[]";
    const w = watcher();
    await w.tick();
    expect(log()).not.toContain("auto-defaults");
    expect(submit).not.toHaveBeenCalled();
    expect(hold(w)?.next.kind).toBe("owner_action");
    process.env.FAKE_GH_FILES = JSON.stringify(["develop:config/app.yaml"]);
    await w.tick();
    expect(log()).not.toContain("auto-defaults");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }), expect.anything());
  });

  it("makes no request for an unsafe path", async () => {
    plant(); issues(); comments(owner("**Needs:** file ../secret\n"));
    const w = watcher();
    await w.tick();
    expect(contentsCalls()).toHaveLength(0);
    expect(hold(w)?.next.until).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  });

  it("goes on by itself at most twice per issue", async () => {
    plant(); issues();
    const mark = (t: string) => bot(`**Nothing needed from you** — x\n\n<!-- spaghetti-code-foundry owner-file -->`, t);
    comments(owner("**Needs:** file config/app.yaml\n"), mark("2026-01-01T00:01:00Z"), mark("2026-01-01T00:02:00Z"));
    process.env.FAKE_GH_FILES = JSON.stringify(["develop:config/app.yaml"]);
    await watcher().tick();
    expect(contentsCalls()).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not fail the check when the request for the file fails", async () => {
    plant(); issues(); comments(owner("**Needs:** file config/app.yaml\n"));
    process.env.FAKE_GH_FAIL_ON = "contents/";
    const w = watcher();
    await w.tick();
    expect(submit).not.toHaveBeenCalled();
    expect(logged.filter((l) => l.includes("looking for config/app.yaml"))).toHaveLength(1);
    expect(hold(w)?.next.kind).toBe("owner_action");
  });

  it("does not take a directory of that name as the file", async () => {
    plant(); issues(); comments(owner("**Needs:** file config/app.yaml\n"));
    process.env.FAKE_GH_DIRS = JSON.stringify(["develop:config/app.yaml"]);
    const w = watcher();
    await w.tick();
    expect(contentsCalls()).toHaveLength(1);
    expect(log()).not.toContain("owner-file");
    expect(submit).not.toHaveBeenCalled();
    expect(hold(w)?.next.kind).toBe("owner_action");
  });

  it("writes no note when the resume could not be scheduled, and tries again at the next check", async () => {
    plant(); issues(); comments(owner("**Needs:** file config/app.yaml\n"));
    process.env.FAKE_GH_FILES = JSON.stringify(["develop:config/app.yaml"]);
    submit.mockImplementationOnce(() => { throw new Error("queue closed"); });
    const w = watcher();
    await w.tick().catch(() => undefined);
    expect(log()).not.toContain("owner-file");
    await w.tick();
    expect(log()).toContain("owner-file");
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("still answers a product-only question with /defaults", async () => {
    plant(); issues(); comments(bot(`${product}<!-- claude-factory run=r1 -->`));
    await watcher().tick();
    expect(log()).toContain("auto-defaults");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
  });
});
