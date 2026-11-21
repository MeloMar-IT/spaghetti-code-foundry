import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunBrief, RunSummary } from "../src/engine/state.js";
import { EVIDENCE_EVENTS_FILE } from "../src/evidence/version.js";
import { DAY_TEXT, sourceKeyOf } from "../src/metrics-share/build.js";
import {
  METRICS_USAGE, PREVIEW_NOTE, SEND_BUSY, SEND_DONE_ALREADY, SEND_NOT_ENDED, SEND_NOT_SHARING, SEND_TOO_OLD, metricsCommand, yesterday,
} from "../src/metrics-share/cli.js";
import { fakeReceiver, type FakeReceiver } from "./fixtures/fake-receiver.js";
import { NO_INSTALL, ShareReportSchema } from "../src/metrics-share/report.js";
import { buildShareReport, readUsageSplits, reduceRun, watcherSources, type ShareDeps } from "../src/metrics-share/sources.js";

const A = "3f1c3c8e-8a5e-4c43-9f43-0a0e2f6b9b51";
let dir: string;
let n = 0;
const ev = (runId: string, type: string, time: string, rest: object = {}) => JSON.stringify({ version: 3, id: `ev-${++n}`, seq: n, runId, time, type, ...rest });

const run = (runId: string, o: Partial<RunSummary> = {}): RunSummary =>
  ({ runId, flow: "issue-gitflow", flowDef: { steps: [] }, task: "", vars: {}, repo: "", status: "succeeded", runDir: join(dir, runId), startedAt: "2026-11-19T10:00:00.000Z", finishedAt: "2026-11-19T11:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, owner: A, ...o }) as unknown as RunSummary;
const brief = (r: RunSummary): RunBrief => ({ runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), owner: r.owner, runDir: join(dir, r.runId), dirName: r.runId, updatedAt: r.finishedAt ?? r.startedAt });

/** A run folder with the given evidence lines. */
function folder(r: RunSummary, lines?: string[]): RunSummary {
  mkdirSync(join(dir, r.runId), { recursive: true });
  if (lines) writeFileSync(join(dir, r.runId, EVIDENCE_EVENTS_FILE), lines.join("\n") + "\n");
  return r;
}

function deps(runs: RunSummary[], o: Partial<ShareDeps> = {}): ShareDeps {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  return { briefs: () => runs.map(brief), load: async (b) => byId.get(b.runId), watchers: () => new Map(), usage: () => undefined, foundryVersion: () => "0.4.0", ...o };
}

const split = (runId: string, time: string, id = `${runId}:issue:0`) => JSON.stringify({ id, time, runId, workspace: "default", name: "issue.split", parent: 5, parts: [11, 12] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-share-"));
  n = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildShareReport", () => {
  it("counts a run that crosses midnight: started on the first day, its question stop and its split on the days they happened", async () => {
    const r = folder(run("r-night", { startedAt: "2026-11-19T23:00:00.000Z", finishedAt: "2026-11-20T02:00:00.000Z" }), [
      ev("r-night", "run.started", "2026-11-19T23:00:00.000Z"),
      ev("r-night", "run.stopped", "2026-11-19T23:30:00.000Z", { at: "send_back" }),
      ev("r-night", "run.resumed", "2026-11-20T00:10:00.000Z", { from: "send_back", by: { kind: "cli" } }),
    ]);
    const d = deps([r], { usage: (month) => (month === "2026-11" ? Buffer.from(`${split("r-night", "2026-11-20T00:30:00.000Z")}\n`) : undefined) });
    const first = await buildShareReport("2026-11-19", [A], d);
    expect(first.changes.runsStarted).toBe(1);
    expect(first.changes.runsEnded.succeeded).toBe(0);
    expect(first.quality.stoppedWithQuestions).toBe(1);
    expect(first.splits.issuesSplit).toBe(0);
    const second = await buildShareReport("2026-11-20", [A], d);
    expect(second.changes.runsStarted).toBe(0);
    expect(second.changes.runsEnded.succeeded).toBe(1);
    expect(second.quality.stoppedWithQuestions).toBe(0);
    expect(second.splits.issuesSplit).toBe(1);
    expect(second.rework.resumes).toBe(1);
  });

  it("leaves the splits out when the usage file cannot be read, and skips runs that cannot be loaded", async () => {
    const r = folder(run("r1"), []);
    const report = await buildShareReport("2026-11-19", [A], deps([r], {
      usage: () => {
        throw new Error("too large");
      },
      load: async (b) => (b.runId === "r1" ? r : undefined),
      briefs: () => [brief(r), { ...brief(run("gone")) }, { ...brief(run("wrong")), dirName: "r1" }],
    }));
    expect(report.splits).toEqual({});
    expect(report.changes.runsEnded.succeeded).toBe(1);
  });

  it("attributes a run of a watcher that exists only in repo-watchers.json to its source", async () => {
    const r = folder(run("r-w", { source: "watcher repo-only issue #3" }));
    const ws = watcherSources([{ id: "file-w", source: "issues" }], [{ id: "repo-only", source: "pr-feedback" }]);
    const report = await buildShareReport("2026-11-19", [A], deps([r], { watchers: () => ws, briefs: () => [{ ...brief(r), source: "watcher repo-only issue #3" }] }));
    expect(report.use.bySource).toEqual({ "pr-feedback": 1 });
  });
});

describe("watcherSources", () => {
  it("merges both stores; a config.yaml id wins; a watcher with no source is an issues watcher", () => {
    const m = watcherSources([{ id: "same", source: "schedule" }, { id: "mon", source: "monitor" }], [{ id: "same", source: "issues" }, { id: "plain" }, { id: 7 }]);
    expect(Object.fromEntries(m)).toEqual({ same: "schedule", mon: "monitor", plain: "issues" });
    expect(sourceKeyOf("watcher plain issue #1", m)).toBe("issues");
    expect(sourceKeyOf("watcher missing issue #1", m)).toBe("unknown");
  });
});

describe("readUsageSplits", () => {
  it("takes only valid issue.split events and skips broken lines", () => {
    const other = JSON.stringify({ id: "x:started", time: "2026-11-19T01:00:00.000Z", runId: "x", workspace: "default", name: "run.started" });
    const bad = JSON.stringify({ id: "y", time: "2026-11-19T01:00:00.000Z", runId: "y", workspace: "default", name: "issue.split", parts: [1], note: "free text" });
    const bytes = Buffer.from([split("a", "2026-11-19T01:00:00.000Z"), other, "{not json \"issue.split\"", bad, ""].join("\n"));
    expect(readUsageSplits(bytes)).toEqual([{ id: "a:issue:0", runId: "a", time: "2026-11-19T01:00:00.000Z", parts: 2 }]);
  });
});

describe("bounded evidence", () => {
  const lines = (id: string) => [ev(id, "run.queued", "2026-11-19T09:00:00.000Z"), ev(id, "run.started", "2026-11-19T10:00:00.000Z"), ev(id, "run.stopped", "2026-11-19T10:30:00.000Z", { at: "send_back" })];

  it("reads evidence that fits", async () => {
    const r = folder(run("ok"), lines("ok"));
    const s = await reduceRun(r, brief(r));
    expect(s.facts.evidence.read).toBe(true);
    expect(s.measures.queueMs).toBe(3_600_000);
    expect(s.evidence?.questionStops).toEqual(["2026-11-19T10:30:00.000Z"]);
  });

  it("reads decided.json: no rounds when the file is absent, unknown when it is invalid", async () => {
    const none = folder(run("no-decided"), lines("no-decided"));
    expect((await reduceRun(none, brief(none))).decided).toEqual([]);
    const bad = folder(run("bad-decided"), lines("bad-decided"));
    writeFileSync(join(dir, "bad-decided", "decided.json"), "not json");
    expect((await reduceRun(bad, brief(bad))).decided).toBeUndefined();
  });

  it("adds nothing from an oversized, a linked or an unreadable evidence file", async () => {
    const big = folder(run("big"), lines("big"));
    const linked = folder(run("linked"));
    const real = join(dir, "real.jsonl");
    writeFileSync(real, lines("linked").join("\n") + "\n");
    symlinkSync(real, join(dir, "linked", EVIDENCE_EVENTS_FILE));
    const unreadable = folder(run("unreadable"));
    mkdirSync(join(dir, "unreadable", EVIDENCE_EVENTS_FILE));
    const runs = [big, linked, unreadable];
    for (const r of runs) {
      const s = await reduceRun(r, brief(r), r === big ? 100 : undefined);
      expect(s.facts.evidence.read, r.runId).toBe(false);
      expect(s.evidence, r.runId).toBeUndefined();
      expect(s.measures.queueMs, r.runId).toBeUndefined();
    }
    const report = await buildShareReport("2026-11-19", [A], deps(runs, { maxEvidenceBytes: 100 }));
    expect(report.quality.stoppedWithQuestions).toBeUndefined();
    expect(report.changes.workItemsDelivered).toBeUndefined();
    expect(report.speed.queueTime.counts.every((c) => c === 0)).toBe(true);
  });
});

describe("scf metrics preview", () => {
  it("prints a report that parses with the schema, with the placeholder install id; nothing is written", async () => {
    const r = folder(run("r1"), [ev("r1", "run.started", "2026-11-19T10:00:00.000Z")]);
    const before = readdirSync(dir, { recursive: true }).sort();
    const out: string[] = [];
    const notes: string[] = [];
    const code = await metricsCommand(["preview"], { day: "2026-11-19", runsDir: dir, deps: deps([r]), accounts: () => [A] }, (l) => out.push(l), (l) => notes.push(l));
    expect(code).toBe(0);
    const report = ShareReportSchema.parse(JSON.parse(out.join("\n")));
    expect(report.install).toBe(NO_INSTALL);
    expect(report.changes.runsStarted).toBe(1);
    expect(notes).toEqual([PREVIEW_NOTE]);
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });

  it("takes yesterday by default and refuses a bad subcommand or day", async () => {
    const out: string[] = [];
    await metricsCommand(["preview"], { runsDir: dir, now: new Date("2026-11-20T08:00:00.000Z"), deps: deps([]), accounts: () => [] }, (l) => out.push(l), () => {});
    expect(JSON.parse(out.join("\n")).day).toBe("2026-11-19");
    expect(yesterday(new Date("2026-03-01T00:30:00.000Z"))).toBe("2026-02-28");
    const call = (pos: string[], day?: string) => metricsCommand(pos, { runsDir: dir, deps: deps([]), accounts: () => [], ...(day ? { day } : {}) }, () => {}, () => {});
    await expect(call(["push"])).rejects.toThrow(METRICS_USAGE);
    await expect(call(["send", "extra"])).rejects.toThrow(METRICS_USAGE);
    await expect(call([])).rejects.toThrow(METRICS_USAGE);
    await expect(call(["preview", "extra"])).rejects.toThrow(METRICS_USAGE);
    await expect(call(["preview"], "2026-13-01")).rejects.toThrow(DAY_TEXT);
  });
});

describe("scf metrics send (#889)", () => {
  let rcv: FakeReceiver;
  const NOW = new Date("2026-11-20T08:00:00.000Z");
  beforeEach(async () => {
    rcv = await fakeReceiver();
  });
  afterEach(() => rcv.close());
  const stateFile = () => join(dir, "metrics-share.json");
  const lockFile = () => join(dir, "metrics-share.lock");
  const cfgNow = () => ({ allowed: allowedNow, endpoint: rcv.endpoint, timeout_ms: 5000 });
  let allowedNow = true;
  const send = async (o: { day?: string; accounts?: string[]; allowed?: boolean } = {}) => {
    allowedNow = o.allowed ?? true;
    const out: string[] = [];
    const notes: string[] = [];
    const code = await metricsCommand(
      ["send"],
      { runsDir: dir, now: NOW, deps: deps([]), accounts: () => o.accounts ?? [A], config: cfgNow(), reload: cfgNow, stateFile: stateFile(), lockFile: lockFile(), ...(o.day ? { day: o.day } : {}) },
      (l) => out.push(l),
      (l) => notes.push(l),
    );
    return { code, out, notes };
  };

  it("sends one day, marks it accepted and refuses to send it again; preview shows the id and the last answer", async () => {
    const first = await send();
    expect(first).toEqual({ code: 0, out: ["accepted (200)"], notes: [] });
    expect(rcv.got).toHaveLength(1);
    const body = JSON.parse(rcv.got[0]!.body);
    ShareReportSchema.parse(body);
    expect(body.day).toBe("2026-11-19");
    expect(body.install).toMatch(/^[0-9a-f]{32}$/);
    expect(body.install).not.toBe(NO_INSTALL);
    const s = JSON.parse(readFileSync(stateFile(), "utf8"));
    expect(s.days["2026-11-19"].accepted).toBe(NOW.toISOString());
    expect(await send()).toEqual({ code: 1, out: [], notes: [SEND_DONE_ALREADY] });
    expect(rcv.got).toHaveLength(1);
    const out: string[] = [];
    const notes: string[] = [];
    await metricsCommand(["preview"], { runsDir: dir, now: NOW, deps: deps([]), accounts: () => [A], stateFile: stateFile() }, (l) => out.push(l), (l) => notes.push(l));
    expect(JSON.parse(out.join("\n")).install).toBe(body.install);
    expect(notes).toEqual([PREVIEW_NOTE, `last answer of the receiver: ${NOW.toISOString()} send 2026-11-19 accepted (200)`]);
  });

  it("reports an answer that is not accepted", async () => {
    rcv.answer = () => ({ status: 503 });
    expect(await send()).toEqual({ code: 1, out: ["not accepted: refused (503)"], notes: [] });
  });

  it("refuses today, a later day, a day over 7 days old, a bad day and nobody sharing, without a request", async () => {
    expect((await send({ day: "2026-11-20" })).notes).toEqual([SEND_NOT_ENDED]);
    expect((await send({ day: "2026-11-25" })).notes).toEqual([SEND_NOT_ENDED]);
    expect((await send({ day: "2026-11-12" })).notes).toEqual([SEND_TOO_OLD]);
    expect((await send({ day: "2026-11-13" })).code).toBe(0); // exactly 7 days old
    await expect(send({ day: "2026-02-30" })).rejects.toThrow(DAY_TEXT);
    expect(await send({ day: "2026-11-18", accounts: [] })).toEqual({ code: 1, out: [], notes: [SEND_NOT_SHARING] });
    expect(await send({ day: "2026-11-18", allowed: false })).toEqual({ code: 1, out: [], notes: [SEND_NOT_SHARING] });
    expect(rcv.got).toHaveLength(1);
  });

  it("does nothing while the server holds the lock, and refuses a day the server already sent", async () => {
    writeFileSync(lockFile(), "server");
    expect(await send()).toEqual({ code: 1, out: [], notes: [SEND_BUSY] });
    rmSync(lockFile());
    writeFileSync(stateFile(), JSON.stringify({ version: 1, install: "ab".repeat(16), activeSince: "2026-11-18", posted: true, endpoint: rcv.endpoint, days: { "2026-11-19": { accepted: "2026-11-20T00:01:00.000Z", tries: 1 } }, deletes: [] }));
    expect(await send()).toEqual({ code: 1, out: [], notes: [SEND_DONE_ALREADY] });
    expect(rcv.got).toHaveLength(0);
  });

  it("sends nothing when sharing is switched off while the report is built", async () => {
    let off = false;
    const notes: string[] = [];
    const code = await metricsCommand(
      ["send"],
      {
        runsDir: dir, now: NOW, accounts: () => [A], stateFile: stateFile(), lockFile: lockFile(),
        deps: { ...deps([]), briefs: () => { off = true; return []; } },
        config: { allowed: true, endpoint: rcv.endpoint, timeout_ms: 5000 },
        reload: () => ({ allowed: !off, endpoint: rcv.endpoint, timeout_ms: 5000 }),
      },
      () => {},
      (l) => notes.push(l),
    );
    expect(code).toBe(1);
    expect(notes).toEqual([SEND_NOT_SHARING]);
    expect(rcv.got).toHaveLength(0);
  });
});
