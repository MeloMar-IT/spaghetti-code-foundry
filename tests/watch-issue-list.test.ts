import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { RepoGhIdentity } from "../src/queue/gh-identity.js";
import { dropIssueList, issueListsDir, readIssueList } from "../src/queue/issue-list.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };

describe("the issue list read of a check", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let logs: string[];
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");
  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    logs = [];
    delete process.env.FAKE_GH_FAIL_API;
  });
  afterEach(() => {
    delete process.env.FAKE_GH_ISSUES;
    delete process.env.FAKE_GH_FAIL_API;
    rmSync(issueListsDir(), { force: true, recursive: true });
    gh.restore();
  });

  const watcher = (id = "go", identity?: RepoGhIdentity) => new Watcher(WatcherSchema.parse({
    id, github_repo: REPO, label: "Factory_go", flow: "issue-deliver", exclude_labels: ["other"],
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"],
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: (m) => void logs.push(m), gh: identity });
  /** Issue 4 is open and excluded; issue 6 waits for it. */
  const issues = () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "issue 4", state: "OPEN", labels: [{ name: "Factory_go" }, { name: "other" }], body: "" },
      { number: 6, title: "issue 6", state: "OPEN", labels: [{ name: "Factory_go" }], body: "Depends on #4" },
    ]);
  };
  const lines = () => gh.ghLog().split("\n");
  const restReads = () => lines().filter((l) => l.includes("state=all") && l.endsWith("page=1"));
  const fallbackCalls = () => lines().filter((l) => l.includes("--state all"));
  const until = async (cond: () => boolean) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); expect(cond()).toBe(true); };
  /** "ok" or the error text, when this watcher's issues check ends. Call it before tick(). */
  const issuesCheckEnd = (w: Watcher) => new Promise<string>((done) => {
    const inner = (w as any).tickIssues.bind(w);
    (w as any).tickIssues = (...a: unknown[]) => { const p = inner(...a); p.then(() => done("ok"), (e: Error) => done(e.message)); return p; };
  });

  it("a check writes one record per issue and a readAt", async () => {
    issues();
    const w = watcher();
    await w.tick();
    const list = readIssueList(REPO)!;
    expect(list.issues.map((i) => i.number).sort()).toEqual([4, 6]);
    expect(list.issues.find((i) => i.number === 6)!.dependsOn).toEqual([4]);
    expect(Number.isNaN(Date.parse(list.readAt))).toBe(false);
    expect(list.cut).toBe(false);
  });
  it("an issue that depends on an open one is held without a second list call", async () => {
    issues();
    const w = watcher();
    await w.tick();
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    expect(fallbackCalls()).toEqual([]);
    expect(restReads()).toHaveLength(1);
  });
  it("watchers of one sign-in share a read; another sign-in reads on its own", async () => {
    issues();
    const other: RepoGhIdentity = { prepare: async () => ({ stamp: "token:test" }), usesHostLogin: () => false, dispose: () => {} };
    await Promise.all([watcher("a").tick(), watcher("b").tick(), watcher("c", other).tick()]);
    expect(restReads()).toHaveLength(2);
  });
  it("is cut at issueListPages", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, state: "OPEN", labels: [], body: "" })));
    const w = watcher();
    w.issueListPages = 1;
    await w.tick();
    const list = readIssueList(REPO)!;
    expect(list.cut).toBe(true);
    expect(list.issues).toHaveLength(100);
  });
  it("a failed read leaves the file, the check still works through the fallback call", async () => {
    issues();
    const w = watcher();
    await w.tick();
    const before = readIssueList(REPO)!;
    process.env.FAKE_GH_FAIL_API = "list";
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
    expect(readIssueList(REPO)).toEqual(before);
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    expect(fallbackCalls()).toHaveLength(1);
    expect(logs.some((l) => l.includes("! issue list:"))).toBe(true);
  });
  it("a failed write is logged and the dependency is still held", async () => {
    issues();
    writeFileSync(issueListsDir(),"not a folder");
    const w = watcher();
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    expect(fallbackCalls()).toEqual([]);
    expect(logs.some((l) => l.includes("! issue list not saved:"))).toBe(true);
  });
  it("a retired watcher writes no file", async () => {
    issues();
    const w = watcher();
    const ended = issuesCheckEnd(w);
    const release = gh.hold("state=all");
    const tick = w.tick();
    await until(() => restReads().length === 1);
    w.stop(true);
    dropIssueList(REPO);
    release();
    expect(await ended).toBe("this check was given up");
    await tick;
    expect(readIssueList(REPO)).toBeUndefined();
  });
  it("a check that is given up while reading writes no file", async () => {
    issues();
    const w = watcher();
    await w.tick();
    dropIssueList(REPO);
    const ended = issuesCheckEnd(w);
    const release = gh.hold("state=all");
    w.checkTimeoutMs = 1000;
    const tick = w.tick();
    await until(() => restReads().length === 2);
    await tick;
    expect(w.status.lastError).toMatch(/given up/);
    release();
    expect(await ended).toBe("this check was given up");
    expect(readIssueList(REPO)).toBeUndefined();
  });
  it("a check whose setup outlasted the timeout asks nothing and writes nothing", async () => {
    issues();
    const w = watcher();
    const ended = issuesCheckEnd(w);
    let entered!: () => void;
    const inSetup = new Promise<void>((r) => { entered = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    (w as any).setup = async () => { entered(); await gate; };
    w.checkTimeoutMs = 50;
    const tick = w.tick();
    await inSetup;
    await tick;
    expect(w.status.lastError).toMatch(/given up/);
    open();
    expect(await ended).toBe("this check was given up");
    expect(readIssueList(REPO)).toBeUndefined();
    expect(lines().some((l) => l.includes("state=all"))).toBe(false);
  });
});
