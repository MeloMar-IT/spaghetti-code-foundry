import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shareReportFrom } from "../src/metrics-share/build.js";
import { DURATION_EDGES_MS, PARTS_EDGES } from "../src/metrics-share/report.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/metrics-shared.js" as string);
});
afterAll(() => restore());
beforeEach(() => (document as any).getElementById("modal-root").replaceChildren());

const zeros = (edges: readonly number[]) => new Array<number>(edges.length + 1).fill(0);
function report(): any {
  const r: any = shareReportFrom({ day: "2026-11-19", accountIds: ["a"], foundryVersion: "0.4.0", briefs: [], runs: [], watcherSources: new Map() });
  r.speed.runDuration = { counts: zeros(DURATION_EDGES_MS).map((_, i) => (i === 3 ? 2 : 0)), sum: 2 * 12 * 60_000 };
  r.splits = { issuesSplit: 1, partsPerSplit: { counts: zeros(PARTS_EDGES).map((_, i) => (i === 2 ? 1 : 0)), sum: 3 } };
  r.cost.byModel = { opus: { tokensIn: 1200, tokensOut: 300, costUsd: 0.5 } };
  r.cost.costUsd = 0.5;
  delete r.changes.workItemsDelivered;
  return r;
}
const preview = (o: any = {}) => ({
  scope: "own", allowed: true, answer: "yes", next: { day: "2026-11-19", sofar: false, report: report() }, last: null, lastUnreadable: false, stateUnreadable: false, ...o,
});
const GROUPS = ["Changes", "Speed", "Splits", "Rework", "Quality", "Cost and models", "Use"];
const titles = (el: FakeElement) => el.all("h4").map((x) => x.textContent);
const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the What is shared view", () => {
  it("shows the seven groups, the raw JSON under a disclosure and what is never sent", () => {
    const p = preview();
    const v = m.sharedView(p);
    expect(titles(v)).toEqual(GROUPS);
    const details = v.all("details");
    expect(details).toHaveLength(1);
    expect(JSON.parse(details[0]!.all("pre")[0]!.textContent)).toEqual(p.next.report);
    expect(v.textContent).toContain(m.SHARED.never);
    expect(v.textContent).toContain("repositories, branches, issues, titles, files, prompts");
    expect(v.textContent).toContain(m.SHARED.install);
  });

  it("says not known for a missing measure, a duration for times and a number of parts for splits", () => {
    const rows = Object.fromEntries(m.reportGroups(report()).flatMap((g: any) => g.rows));
    expect(rows["Work items delivered"]).toBe("not known");
    expect(rows["Run time"]).toBe("2, on average 12 min");
    expect(rows["Time in the queue"]).toBe("none");
    expect(rows["Parts per split"]).toBe("1, on average 3.0 parts");
    expect(rows["Model: opus"]).toBe("1200 in, 300 out, $0.50");
    expect(rows.Cost).toBe("$0.50");
  });

  it("says when no report was sent yet, and shows no last groups", () => {
    const v = m.sharedView(preview());
    expect(v.textContent).toContain(m.SHARED.noneYet);
    expect(titles(v)).toHaveLength(7);
  });

  it("says a broken copy is unreadable, never that nothing was sent", () => {
    const v = m.sharedView(preview({ lastUnreadable: true }));
    expect(v.textContent).toContain(m.SHARED.unreadable);
    expect(v.textContent).not.toContain(m.SHARED.noneYet);
  });

  it("says a sent report's copy is missing with its time and answer", () => {
    const v = m.sharedView(preview({ last: { at: "2026-11-19T00:01:00.000Z", day: "2026-11-18", result: "refused", status: 503, reportKept: false } }));
    expect(v.textContent).toContain(m.SHARED.notKept);
    expect(v.textContent).toContain("refused (503)");
    expect(v.textContent).not.toContain(m.SHARED.noneYet);
  });

  it("shows an admin the last report in full, and a user only its time and answer", () => {
    const last = { at: "2026-11-19T00:01:00.000Z", day: "2026-11-18", result: "accepted", status: 200, reportKept: true };
    const a = m.sharedView(preview({ scope: "install", last: { ...last, report: report() } }));
    expect(titles(a)).toEqual([...GROUPS, ...GROUPS]);
    expect(a.all("details")).toHaveLength(2);
    expect(a.textContent).toContain("accepted (200)");
    expect(a.textContent).toContain(m.SHARED.installScope);
    const u = m.sharedView(preview({ last }));
    expect(titles(u)).toHaveLength(7);
    expect(u.textContent).toContain(m.SHARED.hiddenLast);
  });

  it("says when sharing is off, when the account does not share and when the report is today's so far", () => {
    expect(m.sharedView(preview({ allowed: false })).textContent).toContain(m.SHARED.off);
    expect(m.sharedView(preview({ answer: "no" })).textContent).toContain(m.SHARED.notSharing);
    expect(m.sharedView(preview({ next: { day: "2026-11-20", sofar: true, report: report() } })).textContent).toContain(m.SHARED.provisional);
  });
});

describe("the What is shared dialog", () => {
  it("shows loading, then the view", async () => {
    let answer: (v: unknown) => void = () => {};
    const a = { metricsSharePreview: () => new Promise((r) => (answer = r)) };
    void m.whatIsSharedDialog(a);
    expect(modalRoot().textContent).toContain(m.SHARED.loading);
    answer(preview());
    await flush();
    expect(titles(modalRoot())).toEqual(GROUPS);
  });

  it("shows the error of a failed call", async () => {
    void m.whatIsSharedDialog({ metricsSharePreview: async () => { throw Object.assign(new Error("boom"), { status: 500 }); } });
    await flush();
    expect(modalRoot().textContent).toContain(m.SHARED.failed);
  });

  it("changes nothing for an answer after it was closed", async () => {
    let answer: (v: unknown) => void = () => {};
    void m.whatIsSharedDialog({ metricsSharePreview: () => new Promise((r) => (answer = r)) });
    modalRoot().all("button").find((b) => b.attrs["aria-label"] === "Close")!.click();
    await flush();
    answer(preview());
    await flush();
    expect(modalRoot().children).toHaveLength(0);
  });
});
