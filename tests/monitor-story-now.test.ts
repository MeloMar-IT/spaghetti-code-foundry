import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { Names } from "../src/monitor/clean.js";
import { loadFindings, saveFindings, type Finding } from "../src/monitor/findings.js";
import type { LogEntry, Mute, Verdict } from "../src/monitor/guard.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { markerFor, markerHash } from "../src/monitor/story.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub, type FakeIssue } from "./helpers/fake-github.js";

const T0 = new Date(2026, 9, 1, 12, 0, 0);
const TARGET = "acme/app";
const NAMES: Names = { target: TARGET, users: [], emails: [], repos: [], watchers: [], complete: true };
const GO: Verdict = { go: true };

describe("make a story now", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let file: string;
  let report_to: string | undefined;
  let verdict: () => Verdict;
  let mutes: Mute[];
  let records: LogEntry[];
  let rate: { at: string; resources: Record<string, { limit: number; used: number; remaining: number; reset: number }> } | undefined;
  let saved: Finding[];
  let found: Finding[];

  const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
    detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [T0.toISOString()], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] },
    firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), count: 1, gone: false, ...over,
  });
  const cfg = () => ConfigSchema.parse({ monitor: { ...(report_to ? { report_to } : {}), report_limits: { per_day: 1, per_check: 1 } } }).monitor;
  const reporter = () =>
    new Reporter({ config: cfg, buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }), guard: () => verdict(), mutes: () => mutes, record: (e) => records.push(e), rateLimit: () => rate, log: () => {} });
  const now = () => T0;
  const press = (r: Reporter, id = "a", list = found) => r.storyNow(list, `restart-loop|${id}`, now(), "admin-1", (f) => saved.push(f));
  const issue = (n: number, fp: string, over: Partial<FakeIssue> = {}): FakeIssue => ({
    number: n, state: "open", state_reason: null, title: "t", body: `text\n\n${markerFor(`restart-loop|${fp}`)}`, labels: [{ name: "bug" }],
    html_url: `https://github.com/${TARGET}/issues/${n}`, created_at: T0.toISOString(), closed_at: null, ...over,
  });

  beforeEach(() => {
    gh = fakeGithub();
    file = join(gh.tmp, "monitor-findings.json");
    report_to = TARGET;
    verdict = () => GO;
    mutes = [];
    records = [];
    rate = undefined;
    saved = [];
    found = [finding("a")];
  });
  afterEach(() => gh.restore());

  it("makes a story at the first check of a critical finding, and logs who asked", async () => {
    const r = await press(reporter());
    expect(r).toMatchObject({ ok: true, made: true });
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.labels).toEqual(["bug", "go"]);
    expect(made[0]!.body).toContain(markerFor("restart-loop|a"));
    expect(saved[0]!.report).toMatchObject({ repo: TARGET, seen: 0 });
    expect(saved[0]!.tries).toBe(1);
    expect(records).toEqual([expect.objectContaining({ event: "story-made", by: "admin-1", fingerprint: "restart-loop|a" })]);
  });

  it("makes a story for a minor finding seen on one day, and ignores the limits", async () => {
    found = [finding("a", { severity: "minor" }), finding("b", { report: { repo: TARGET, issue: 5, url: "u", at: T0.toISOString(), seen: 1 } })];
    expect(await press(reporter())).toMatchObject({ ok: true, made: true });
  });

  it("is not stopped by the quiet time or the circuit breaker", async () => {
    for (const reason of ["cooldown", "breaker"] as const) {
      verdict = () => ({ go: false, reason, note: reason });
      gh.setBugIssues([]);
      expect(await press(reporter())).toMatchObject({ ok: true, made: true });
    }
  });

  it("is refused when off or unreadable, and creates nothing", async () => {
    for (const reason of ["off", "unreadable"] as const) {
      verdict = () => ({ go: false, reason, note: reason });
      expect(await press(reporter())).toEqual({ ok: false, code: reason });
    }
    expect(gh.createdBodies()).toEqual([]);
    expect(gh.ghLog()).not.toContain("gh api");
  });

  it("creates nothing when the switch turns off after the list call", async () => {
    let n = 0;
    verdict = () => (++n > 1 ? { go: false, reason: "off", note: "off" } : GO);
    expect(await press(reporter())).toEqual({ ok: false, code: "off" });
    expect(gh.createdBodies()).toEqual([]);
  });

  it("is refused for a muted finding and a muted detector", async () => {
    const base = { id: "m1", reason: "r", since: T0.toISOString(), by: "cli" };
    mutes = [{ ...base, kind: "finding", detector: "restart-loop", fingerprint: "restart-loop|a" }];
    expect(await press(reporter())).toEqual({ ok: false, code: "muted" });
    mutes = [{ ...base, kind: "detector", detector: "restart-loop" }];
    expect(await press(reporter())).toEqual({ ok: false, code: "muted" });
    expect(gh.createdBodies()).toEqual([]);
  });

  it("is refused after two tries, for a story in the target, for a gone finding and without a repository", async () => {
    found = [finding("a", { tries: 2 })];
    expect(await press(reporter())).toEqual({ ok: false, code: "two_tries" });
    found = [finding("a", { report: { repo: "ACME/app", issue: 5, url: "u", at: T0.toISOString(), seen: 1 } })];
    expect(await press(reporter())).toEqual({ ok: false, code: "exists" });
    found = [finding("a", { gone: true })];
    expect(await press(reporter())).toEqual({ ok: false, code: "gone" });
    found = [finding("a")];
    expect(await press(reporter(), "zzz")).toEqual({ ok: false, code: "unknown" });
    report_to = undefined;
    expect(await press(reporter())).toEqual({ ok: false, code: "no_target" });
    expect(gh.ghLog()).not.toContain("gh api");
  });

  it("takes up a story whose save was lost: no new story, one more try", async () => {
    for (const [over, check] of [
      [{}, (f: Finding) => expect(f.report?.closedAt).toBeUndefined()],
      [{ state: "closed", state_reason: "completed", closed_at: T0.toISOString() } as Partial<FakeIssue>, (f: Finding) => expect(f.report?.closedAt).toBeDefined()],
      [{ state: "closed", state_reason: "not_planned", closed_at: T0.toISOString() } as Partial<FakeIssue>, (f: Finding) => expect(f.report?.muted).toBe(true)],
    ] as const) {
      saved = [];
      gh.setBugIssues([issue(101, "a", over)]);
      expect(await press(reporter())).toMatchObject({ ok: true, made: false, issue: 101 });
      expect(saved[0]!.tries).toBe(1);
      check(saved[0]!);
    }
    expect(gh.createdBodies()).toEqual([]);
  });

  it("leaves the log lines and the summary out for a finding of another repository", async () => {
    found = [finding("a", { repo: "other-owner/secret-repo", summary: "raw summary of other-owner/secret-repo" })];
    expect(await press(reporter())).toMatchObject({ ok: true, made: true });
    const body = gh.createdBodies()[0]!.body;
    expect(body).not.toContain("other-owner/secret-repo");
    expect(body).not.toContain("raw summary");
  });

  it("answers github when a call fails, changes nothing, and a second press makes one story", async () => {
    process.env.FAKE_GH_FAIL_API = "create";
    expect(await press(reporter())).toEqual({ ok: false, code: "github" });
    expect(saved).toEqual([]);
    delete process.env.FAKE_GH_FAIL_API;
    expect(await press(reporter())).toMatchObject({ ok: true, made: true });
    expect(gh.createdBodies()).toHaveLength(1);
    process.env.FAKE_GH_FAIL_API = "list";
    expect(await press(reporter())).toEqual({ ok: false, code: "github" });
  });

  it("does not call GitHub when the request limit is used up", async () => {
    rate = { at: new Date().toISOString(), resources: { core: { limit: 5000, used: 5000, remaining: 0, reset: Math.floor(Date.now() / 1000) + 3600 } } };
    expect(await press(reporter())).toEqual({ ok: false, code: "github" });
    expect(gh.ghLog()).not.toContain("gh api");
  });
});

describe("Monitor.storyNow", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let file: string;
  let sheet: Finding[];

  const config = () => ConfigSchema.parse({ monitor: { report_to: TARGET } }).monitor;
  const make = (over: { thresholds?: () => ReturnType<typeof config> } = {}) => {
    const rep = new Reporter({ config, buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({}), log: () => {} });
    const scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) });
    return new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "1h" }), {
      scheduler, watchers: () => [], thresholds: over.thresholds ?? config, log: () => {}, file, reporter: rep, detectors: [{ name: "t", description: "t", run: () => sheet.map((f) => ({ ...f })) }],
    });
  };
  const input = (id: string): Finding => ({ detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry", evidence: {}, firstSeen: "", lastSeen: "", count: 0, gone: false });
  const hash = (id: string) => markerHash(`restart-loop|${id}`);

  beforeEach(() => {
    gh = fakeGithub();
    file = join(gh.tmp, "monitor-findings.json");
    sheet = [input("a")];
  });
  afterEach(() => gh.restore());

  it("makes the story, saves it, and makes no other story or comment", async () => {
    sheet = [input("a"), input("b")];
    const m = make();
    const r = await m.storyNow(hash("a"), "admin-1");
    expect(r).toMatchObject({ ok: true, made: true });
    expect(gh.createdBodies()).toHaveLength(1);
    const byFp = new Map(loadFindings(file).findings.map((f) => [f.fingerprint, f]));
    expect(byFp.get("restart-loop|a")!.report).toBeDefined();
    expect(byFp.get("restart-loop|b")!.report).toBeUndefined();
    expect(m.status.notes).toBeUndefined();
    expect(m.status.lastActions[0]).toContain("an admin asked for it");
  });

  it("answers unknown for an unknown finding and failed when the check fails", async () => {
    expect(await make().storyNow(hash("zzz"), "admin-1")).toEqual({ ok: false, code: "unknown" });
    const broken = make({ thresholds: () => { throw new Error("boom"); } });
    expect(await broken.storyNow(hash("a"), "admin-1")).toEqual({ ok: false, code: "failed" });
  });

  it("two calls at once make one story, and the second says it exists", async () => {
    const m = make();
    const [a, b] = await Promise.all([m.storyNow(hash("a"), "admin-1"), m.storyNow(hash("a"), "admin-2")]);
    expect(gh.createdBodies()).toHaveLength(1);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, code: "exists" });
  });

  it("moves the story of another repository to earlier", async () => {
    const m = make();
    await m.tick(true);
    const now = loadFindings(file).findings;
    saveFindings(now.map((f) => ({ ...f, report: { repo: "old/repo", issue: 2, url: "https://github.com/old/repo/issues/2", at: T0.toISOString(), seen: 1 } })), file);
    expect(await m.storyNow(hash("a"), "admin-1")).toMatchObject({ ok: true, made: true });
    const f = loadFindings(file).findings[0]!;
    expect(f.report?.repo).toBe(TARGET);
    expect(f.earlier).toEqual([{ repo: "old/repo", issue: 2, url: "https://github.com/old/repo/issues/2" }]);
  });

  it("never writes over a findings file that became unreadable", async () => {
    const m = make();
    await m.tick(true);
    const release = gh.hold("-X POST");
    const pending = m.storyNow(hash("a"), "admin-1");
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(file, "{ nope");
    release();
    expect(await pending).toEqual({ ok: false, code: "github" });
    expect(readFileSync(file, "utf8")).toBe("{ nope");
  }, 20_000);

  it("keeps what another writer saved while the create call is held", async () => {
    const m = make();
    await m.tick(true); // the finding is stored
    const release = gh.hold("-X POST");
    const pending = m.storyNow(hash("a"), "admin-1");
    await new Promise((r) => setTimeout(r, 1500));
    const now = loadFindings(file).findings;
    saveFindings([...now.map((f) => ({ ...f, count: 99 })), { ...input("other"), firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), count: 1 }], file);
    release();
    expect(await pending).toMatchObject({ ok: true, made: true });
    const after = loadFindings(file).findings;
    expect(after.find((f) => f.fingerprint === "restart-loop|a")).toMatchObject({ count: 99, tries: 1 });
    expect(after.find((f) => f.fingerprint === "restart-loop|a")!.report).toBeDefined();
    expect(after.some((f) => f.fingerprint === "restart-loop|other")).toBe(true);
  }, 20_000);
});
