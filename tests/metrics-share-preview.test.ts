import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunBrief, RunSummary } from "../src/engine/state.js";
import { shareReportFrom } from "../src/metrics-share/build.js";
import { sharePreview, type PreviewCaller, type PreviewDeps } from "../src/metrics-share/preview.js";
import { NO_INSTALL } from "../src/metrics-share/report.js";
import type { ShareDeps } from "../src/metrics-share/sources.js";
import type { SentRecord, ShareState } from "../src/metrics-share/state.js";

const A = "3f1c3c8e-8a5e-4c43-9f43-0a0e2f6b9b51";
const B = "9b0a1d22-0c7e-4b8e-a2a4-5c2b7d3e8f10";
const REAL = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-11-20T10:00:00.000Z");
let dir: string;

const run = (runId: string, owner: string): RunSummary =>
  ({ runId, flow: "issue-gitflow", flowDef: { steps: [] }, task: "", vars: {}, repo: "", status: "succeeded", runDir: join(dir, runId), startedAt: "2026-11-19T10:00:00.000Z", finishedAt: "2026-11-19T11:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, owner }) as unknown as RunSummary;
const brief = (r: RunSummary): RunBrief => ({ runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt!, owner: r.owner, runDir: join(dir, r.runId), dirName: r.runId, updatedAt: r.finishedAt! });

function share(): ShareDeps {
  const runs = [run("ra1", A), run("ra2", A), run("rb1", B)];
  for (const r of runs) mkdirSync(join(dir, r.runId), { recursive: true });
  const byId = new Map(runs.map((r) => [r.runId, r]));
  return { briefs: () => runs.map(brief), load: async (b) => byId.get(b.runId), watchers: () => new Map(), usage: () => undefined, foundryVersion: () => "0.4.0", install: REAL };
}
const stateWith = (o: Partial<ShareState> = {}): ShareState => ({ version: 1, install: REAL, activeSince: "2026-11-19", posted: true, days: {}, deletes: [], ...o });
const record = (): SentRecord => ({
  version: 1, at: "2026-11-19T00:01:00.000Z", day: "2026-11-18", result: "accepted", status: 200,
  report: { ...shareReportFrom({ day: "2026-11-18", accountIds: [A, B], foundryVersion: "0.4.0", briefs: [], runs: [], watcherSources: new Map() }), install: REAL },
});

function deps(o: Partial<PreviewDeps> = {}): PreviewDeps {
  return { share: share(), accounts: () => [A, B], state: () => ({ state: stateWith(), broken: false }), sent: () => ({ broken: false }), now: () => NOW, ...o };
}
const user = (o: Partial<PreviewCaller> = {}): PreviewCaller => ({ id: A, admin: false, allowed: true, answer: "yes", ...o });
const ended = (p: { next: { report: { changes: { runsEnded: { succeeded: number } } } } }) => p.next.report.changes.runsEnded.succeeded;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-preview-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sharePreview", () => {
  it("a user gets a report of their own runs only, never another account's, also before a yes", async () => {
    const a = await sharePreview(user(), deps());
    expect(a.scope).toBe("own");
    expect(a.next.report.accountsSharing).toBe(1);
    expect(a.next.day).toBe("2026-11-19");
    expect(ended(a)).toBe(2);
    const b = await sharePreview(user({ id: B }), deps());
    expect(ended(b)).toBe(1);
    const unasked = await sharePreview(user({ answer: "unasked" }), deps({ accounts: () => [B] }));
    expect(ended(unasked)).toBe(2);
    expect(unasked.answer).toBe("unasked");
  });

  it("an admin gets the report of every account that shares; none while sharing is off", async () => {
    const p = await sharePreview(user({ id: "admin", admin: true }), deps());
    expect(p.scope).toBe("install");
    expect(p.next.report.accountsSharing).toBe(2);
    expect(ended(p)).toBe(3);
    const off = await sharePreview(user({ id: "admin", admin: true, allowed: false }), deps({ accounts: () => [] }));
    expect(off.next.report.accountsSharing).toBe(0);
    expect(ended(off)).toBe(0);
    expect(off.allowed).toBe(false);
  });

  it("always shows the install id as zeros", async () => {
    const p = await sharePreview(user({ admin: true }), deps({ sent: () => ({ sent: record(), broken: false }) }));
    expect(p.next.report.install).toBe(NO_INSTALL);
    expect(p.last?.report?.install).toBe(NO_INSTALL);
    expect(JSON.stringify(p)).not.toContain(REAL);
  });

  it("last is null before any send, and unreadable for a broken copy", async () => {
    expect((await sharePreview(user(), deps())).last).toBeNull();
    const broken = await sharePreview(user(), deps({ sent: () => ({ broken: true }) }));
    expect(broken.lastUnreadable).toBe(true);
    expect(broken.last).toBeNull();
  });

  it("without a copy, last comes from the push state with reportKept false", async () => {
    const last = { at: "2026-11-19T00:01:00.000Z", request: "send" as const, day: "2026-11-18", result: "refused" as const, status: 503 };
    const p = await sharePreview(user({ admin: true }), deps({ state: () => ({ state: stateWith({ last }), broken: false }) }));
    expect(p.last).toEqual({ at: last.at, day: "2026-11-18", result: "refused", status: 503, reportKept: false });
    // a delete was the last answer: the newest accepted day is the last send
    const del = { at: "2026-11-20T00:01:00.000Z", request: "delete" as const, result: "accepted" as const, status: 200 };
    const days = { "2026-11-17": { accepted: "2026-11-18T00:01:00.000Z", tries: 1 }, "2026-11-18": { accepted: "2026-11-19T00:01:00.000Z", tries: 1 } };
    const q = await sharePreview(user(), deps({ state: () => ({ state: stateWith({ last: del, days }), broken: false }) }));
    expect(q.last).toEqual({ at: "2026-11-19T00:01:00.000Z", day: "2026-11-18", result: "accepted", reportKept: false });
  });

  it("with a copy, a user gets the time, day and answer only, an admin also the report", async () => {
    const d = deps({ sent: () => ({ sent: record(), broken: false }) });
    const u = await sharePreview(user(), d);
    expect(u.last).toEqual({ at: "2026-11-19T00:01:00.000Z", day: "2026-11-18", result: "accepted", status: 200, reportKept: true });
    const a = await sharePreview(user({ admin: true }), d);
    expect(a.last?.report?.day).toBe("2026-11-18");
  });

  it("during a retry wait the next day is the waiting day, not today", async () => {
    const waiting = stateWith({ activeSince: "2026-11-19", days: { "2026-11-19": { tries: 1, nextAt: "2026-11-20T10:30:00.000Z" } } });
    const p = await sharePreview(user(), deps({ state: () => ({ state: waiting, broken: false }) }));
    expect(p.next).toMatchObject({ day: "2026-11-19", sofar: false });
  });

  it("the next day follows the push: today so far when nothing is due, and for a broken state", async () => {
    const done = stateWith({ activeSince: "2026-11-19", days: { "2026-11-19": { accepted: "x", tries: 1 } } });
    const p = await sharePreview(user(), deps({ state: () => ({ state: done, broken: false }) }));
    expect(p.next).toMatchObject({ day: "2026-11-20", sofar: true });
    const broken = await sharePreview(user(), deps({ state: () => ({ broken: true }) }));
    expect(broken).toMatchObject({ stateUnreadable: true, next: { day: "2026-11-20", sofar: true } });
  });
});
