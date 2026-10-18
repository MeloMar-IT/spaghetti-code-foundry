import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/run-evidence.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const SHA = "a".repeat(64);
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const step = (id: string, type = "approval") => ({ id, visit: 1, type });
const arts = [
  { kind: "transcript", path: "logs/02-plan.log", sha256: SHA, bytes: 3, required: true, state: "ok" },
  { kind: "log", path: "logs/03-test.log", sha256: SHA, bytes: 3, required: true, state: "ok" },
  { kind: "flow", path: "run.json", sha256: SHA, bytes: 3, required: true, state: "ok" },
  { kind: "test-report", path: "logs/report.xml", sha256: SHA, bytes: 3, required: true, state: "ok" },
  { kind: "diff", path: "evidence.diff", sha256: SHA, bytes: 3, required: false, state: "changed" },
];
const manifest = (admin: boolean): any => ({
  version: 1, runId: "r1", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T11:00:00Z",
  flow: { name: "build-it", version: 3, sha256: SHA },
  git: { repository: "acme/app", branch: "feature/x", base: "1234567890abcdef", final: "fedcba0987654321" },
  ...(admin ? { models: [{ agent: "claude", provider: "anthropic", model: "opus", effort: "high" }], policies: [{ id: "no-net", version: "1.0" }] } : {}),
  approvals: [{ step: step("gate"), time: "2026-01-01T10:30:00Z", decision: "approved", by: admin ? { kind: "user", id: UUID } : { kind: "user" } }],
  tests: [{ step: step("tests", "shell"), result: { suite: "tests", outcome: "failed", passed: 4, failed: 1 } }],
  artifacts: arts, pullRequest: { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" },
});
const verified = (admin: boolean, over: any = {}): any => ({
  runId: "r1", state: "available",
  verification: { status: "verified", verified: true, explanation: "Everything checks out for run r1.", checks: [], missingOptional: ["evidence.diff"] },
  manifest: manifest(admin), artifacts: arts, ...over,
});
const failedView = (failure: any, over: any = {}): any => ({
  ...verified(true), verification: { status: "failed", verified: false, explanation: "bad", checks: [], missingOptional: [], failure }, ...over,
});
const absent = { runId: "r1", state: "not_available", reason: "none", verification: { status: "absent", verified: false, explanation: "", checks: [], missingOptional: [] }, artifacts: [] };
const notFinal = { ...absent, verification: { status: "not-finalized", verified: false, explanation: "", checks: [], missingOptional: [] } };

const rowLabels = (m: any) => m.rows.map((r: any) => r.label);
const FORBIDDEN = ["logs/", "evidence.jsonl", "evidence.json", "run.json", "evidence.diff", UUID];

describe("evidenceRecordModel", () => {
  it("shows an administrator everything in order", () => {
    const m = mod.evidenceRecordModel(verified(true), { admin: true });
    expect(m.tone).toBe("ok");
    expect(m.label).toBe("Verified");
    expect(m.text).toBe("Everything checks out for run r1.");
    expect(rowLabels(m)).toEqual(["Result", "Flow", "Flow version", "Commits", "Models", "Approvals", "Tests", "Recorded policy denials", "Pull request", "Files"]);
    expect(m.rows.find((r: any) => r.label === "Pull request").href).toBe("https://github.com/acme/app/pull/7");
    expect(m.rows.find((r: any) => r.label === "Recorded policy denials").lines).toEqual(["Denied by no-net version 1.0"]);
    expect(m.rows.find((r: any) => r.label === "Approvals").lines[0]).toContain(`(${UUID})`);
    expect(m.rows.find((r: any) => r.label === "Files").lines[0]).toBe("transcript logs/02-plan.log — unchanged");
    expect(m.rows.find((r: any) => r.label === "Files").lines[4]).toBe("diff evidence.diff — changed (optional)");
  });
  it("shows a user no models and no policies, and a fixed sentence", () => {
    const m = mod.evidenceRecordModel(verified(false), { admin: false });
    expect(rowLabels(m)).toEqual(["Result", "Flow", "Flow version", "Commits", "Approvals", "Tests", "Pull request", "Files"]);
    expect(m.text).toBe("The record of this run is whole and unchanged. 1 optional file is no longer there; that is allowed.");
    expect(m.rows.find((r: any) => r.label === "Approvals").lines[0]).toContain("by a signed-in user");
  });
  it("hides paths, ids, models and policies from a user even when the view has them", () => {
    const views = [verified(true), failedView({ check: "files", code: "file-changed", message: "logs/02-plan.log changed", path: "logs/02-plan.log" }),
      failedView({ check: "chain", code: "chain-hash", message: "evidence.jsonl, line 5", line: 5 }), failedView({ check: "flow", code: "flow-changed", message: "run.json", path: "run.json" })];
    for (const v of views) {
      const text = JSON.stringify(mod.evidenceRecordModel(v, { admin: false }));
      for (const bad of FORBIDDEN) expect(text).not.toContain(bad);
      expect(text).not.toContain("anthropic");
      expect(text).not.toContain("no-net");
    }
  });
  it("names the failure by kind for a user and by path for an administrator", () => {
    const f = { check: "files", code: "file-changed", message: "logs/02-plan.log changed", path: "logs/02-plan.log" };
    const u = mod.evidenceRecordModel(failedView(f), { admin: false }).failure;
    expect(u.where).toBe("A step transcript");
    expect(u.what).toBe("was changed after the run ended");
    const a = mod.evidenceRecordModel(failedView(f), { admin: true }).failure;
    expect(a.where).toBe("logs/02-plan.log");
    expect(a.what).toBe("logs/02-plan.log changed");
    expect(a.next).toContain("scf evidence verify r1");
    expect(mod.evidenceRecordModel(failedView({ check: "x", code: "file-changed", message: "m", path: "other.txt" }), { admin: false }).failure.where).toBe("A file of the run");
  });
  it("names an event line and the flow definition", () => {
    const c = { check: "chain", code: "chain-hash", message: "m", line: 5 };
    expect(mod.evidenceRecordModel(failedView(c), { admin: false }).failure.where).toBe("Event 5 of the event record");
    expect(mod.evidenceRecordModel(failedView(c), { admin: true }).failure.where).toBe("evidence.jsonl, line 5");
    expect(mod.evidenceRecordModel(failedView(c), { admin: false }).failure.what).toBe("does not match its hash or its place in the chain");
    const fl = { check: "flow", code: "flow-changed", message: "m", path: "run.json" };
    expect(mod.evidenceRecordModel(failedView(fl), { admin: false }).failure.where).toBe("The flow definition stored with the run");
  });
  it("gives the next action of each group", () => {
    const next = (code: string, admin: boolean) => mod.evidenceRecordModel(failedView({ check: "manifest", code, message: "m" }), { admin }).failure.next;
    expect(next("incomplete", false)).toBe("The run itself is not affected, but this record cannot be verified. Ask an administrator if you need a verified record.");
    expect(next("incomplete", true)).toContain('"! evidence:"');
    expect(next("manifest-version", true)).toBe("Update the Foundry, then press Check again.");
    expect(next("chain-unsupported-version", false)).toBe("Update the Foundry, then press Check again.");
    expect(mod.evidenceRecordModel(failedView({ check: "chain", code: "chain-unsupported-version", message: "m", line: 2 }), { admin: false }).failure.what).toBe("was written by a newer version of the Foundry");
    expect(next("file-changed", false)).toContain("does not match what was written");
  });
  it("does not say a record was changed when a file is missing, unreadable, or from another run", () => {
    for (const code of ["file-missing", "file-unreadable", "manifest-run", "manifest-unreadable", "events-missing", "events-unreadable"]) {
      const u = mod.evidenceRecordModel(failedView({ check: "files", code, message: "m", path: "logs/02-plan.log" }), { admin: false }).failure;
      expect(u.next).not.toContain("changed");
      expect(u.next).toContain("does not verify");
      const a = mod.evidenceRecordModel(failedView({ check: "files", code, message: "m" }), { admin: true }).failure;
      expect(a.next).toContain("scf evidence verify r1");
      expect(a.next).not.toContain("backup");
    }
    expect(mod.evidenceRecordModel(failedView({ check: "files", code: "file-missing", message: "m", path: "logs/02-plan.log" }), { admin: false }).failure.what).toBe("is gone, and the record needs it");
    expect(mod.evidenceRecordModel(failedView({ check: "manifest", code: "manifest-run", message: "m" }), { admin: false }).failure.what).toBe("belongs to another run");
  });
  it("handles a run that is not finished", () => {
    const live = mod.evidenceRecordModel(notFinal, { admin: false, ended: false });
    expect(live).toMatchObject({ tone: "warn", label: "Not finished", text: "The record is finished when the run ends.", failure: null, rows: [] });
    const done = mod.evidenceRecordModel(notFinal, { admin: false, ended: true });
    expect(done.failure.next).toBe("Ask an administrator why the record could not be finished.");
    expect(mod.evidenceRecordModel(notFinal, { admin: true, ended: true }).failure.next).toContain("no manifest was written");
  });
  it("treats a missing or odd view as no record", () => {
    for (const v of [absent, undefined, {}]) {
      const m = mod.evidenceRecordModel(v, { admin: true });
      expect(m).toMatchObject({ tone: "neutral", label: "No record", rows: [], failure: null });
    }
  });
  it("fills the small rows", () => {
    const v: any = verified(true);
    v.manifest = { ...v.manifest, git: {}, flow: { name: "f" }, approvals: [], tests: [], policies: [], models: [], pullRequest: undefined };
    const m = mod.evidenceRecordModel(v, { admin: true });
    const lines = (l: string) => m.rows.find((r: any) => r.label === l).lines;
    expect(lines("Commits")).toEqual(["None recorded"]);
    expect(lines("Flow version")).toEqual(["Not published"]);
    expect(lines("Approvals")).toEqual(["None"]);
    expect(lines("Tests")).toEqual(["No test results recorded"]);
    expect(lines("Recorded policy denials")).toEqual(["No policy denials recorded"]);
    expect(lines("Models")).toEqual(["None"]);
    expect(lines("Pull request")).toEqual(["None"]);
    expect(m.rows.find((r: any) => r.label === "Pull request").href).toBeUndefined();
    const c = mod.evidenceRecordModel(verified(true), { admin: true }).rows.find((r: any) => r.label === "Commits").lines;
    expect(c).toEqual(["Repository acme/app", "Branch feature/x", "Started from 1234567", "Ended at fedcba0"]);
    expect(mod.evidenceRecordModel(verified(true), { admin: true }).rows.find((r: any) => r.label === "Tests").lines).toEqual(["tests: failed (4 passed, 1 failed)"]);
  });
  it("counts files for a user", () => {
    const files = (a: any[]) => mod.evidenceRecordModel(verified(false, { artifacts: a }), { admin: false }).rows.find((r: any) => r.label === "Files").lines;
    expect(files(arts.map((a) => ({ ...a, state: "ok" })))).toEqual(["5 files: all unchanged"]);
    expect(files(arts.map((a, i) => ({ ...a, state: i ? "ok" : "changed" })))).toEqual(["5 files: 1 changed, 4 unchanged"]);
    expect(files([{ kind: "log", path: "x" }])).toEqual(["1 file: 1 not checked"]);
    expect(files([])).toEqual(["None"]);
  });
});

describe("evidenceExport", () => {
  it("holds exactly the answer, and a safe name", () => {
    const v = verified(true);
    const f = mod.evidenceExport(v, "r-1");
    expect(f.name).toBe("evidence-r-1.json");
    expect(JSON.parse(f.text)).toEqual(v);
    expect(mod.evidenceExport(v, "a/../b c").name).toBe("evidence-a____b_c.json");
  });
});

describe("evidenceRecordSection", () => {
  const make = (views: any[], opts: any = {}) => {
    let n = 0;
    const load = vi.fn(async () => { const v = views[Math.min(n++, views.length - 1)]; if (v instanceof Error) throw v; return v; });
    const save = vi.fn();
    const s = mod.evidenceRecordSection({ load, save, runId: "r1", admin: false, ...opts });
    const node: FakeElement = s.build();
    return { s, node, load, save };
  };
  const btn = (node: FakeElement, f: string) => node.all("button").find((b) => b.attrs["data-focus"] === f)!;
  const alertText = (node: FakeElement) => node.all("p").find((p) => p.attrs.role === "alert")!.textContent;

  it("loads, then shows the status as text in a status element", async () => {
    const { node } = make([verified(false)]);
    expect(node.textContent).toContain("Loading the evidence record…");
    await flush();
    const st = node.all("p").find((p) => p.attrs.role === "status")!;
    expect(st.textContent).toContain("Verified");
    expect(st.textContent).toContain("whole and unchanged");
    expect(node.textContent).toContain("Evidence record");
    expect(node.attrs["aria-labelledby"]).toBeTruthy();
  });
  it("reloads when the run finishes, not on the same summary", async () => {
    const { s, load } = make([verified(false)]);
    await flush();
    s.update({ status: "running" }, undefined);
    s.update({ status: "running" }, { status: "running" });
    expect(load).toHaveBeenCalledTimes(1);
    s.update({ status: "succeeded", finishedAt: "t" }, { status: "running" });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("reloads when a waiting or stopped run is cancelled, although both have a finishedAt", async () => {
    for (const status of ["waiting", "stopped"]) {
      const { s, node, load } = make([notFinal, verified(false)]);
      await flush();
      expect(load).toHaveBeenCalledTimes(1);
      s.update({ status: "cancelled", finishedAt: "t2" }, { status, finishedAt: "t1" });
      expect(load).toHaveBeenCalledTimes(2);
      await flush();
      expect(node.textContent).toContain("Verified");
      // same timestamp but the status became terminal
      s.update({ status: "cancelled", finishedAt: "t2" }, { status: "cancelled", finishedAt: "t2" });
      expect(load).toHaveBeenCalledTimes(2);
    }
  });
  it("reloads when only the status becomes terminal with the same finishedAt", async () => {
    const { s, load } = make([notFinal]);
    await flush();
    s.update({ status: "cancelled", finishedAt: "t1" }, { status: "waiting", finishedAt: "t1" });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("drops the old record when a finished run is resumed, and ignores an answer still on its way", async () => {
    const resolvers: ((v: any) => void)[] = [];
    const load = vi.fn(() => new Promise<any>((r) => { resolvers.push(r); }));
    const s = mod.evidenceRecordSection({ load, runId: "r1", admin: false });
    const node: FakeElement = s.build();
    resolvers[0]!(verified(false));
    await flush();
    expect(node.textContent).toContain("Verified");
    s.update({ status: "succeeded", finishedAt: "t" }, undefined);
    s.update({ status: "running" }, { status: "succeeded", finishedAt: "t" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(node.textContent).not.toContain("Verified");
    expect(node.textContent).toContain("Loading the evidence record…");
    resolvers[1]!(notFinal);
    await flush();
    expect(node.textContent).toContain("Not finished");
    expect(node.textContent).toContain("The record is finished when the run ends.");
    // the run finishes; an old request that resolves late must not win
    s.update({ status: "succeeded", finishedAt: "t2" }, { status: "running" });
    s.update({ status: "succeeded", finishedAt: "t2" }, { status: "succeeded", finishedAt: "t2" });
    resolvers[2]!(verified(false));
    await flush();
    expect(node.textContent).toContain("Verified");
  });
  it("ignores a stale answer after a resume", async () => {
    const resolvers: ((v: any) => void)[] = [];
    const load = vi.fn(() => new Promise<any>((r) => { resolvers.push(r); }));
    const s = mod.evidenceRecordSection({ load, runId: "r1", admin: false });
    const node: FakeElement = s.build();
    s.update({ status: "running" }, { status: "succeeded", finishedAt: "t" });
    resolvers[1]!(notFinal);
    await flush();
    resolvers[0]!(verified(false)); // the old, first request
    await flush();
    expect(node.textContent).toContain("Not finished");
    expect(node.textContent).not.toContain("Verified");
  });
  it("shows Not finished while the run is going and the failure once it ended", async () => {
    const { s, node } = make([notFinal]);
    await flush();
    s.update({ status: "running" }, undefined);
    expect(node.textContent).toContain("The record is finished when the run ends.");
    expect(node.textContent).not.toContain("Verification failed");
    s.update({ status: "failed" }, { status: "running" });
    expect(node.textContent).toContain("Verification failed");
  });
  it("checks again, and disables the button while it loads", async () => {
    const { node, load } = make([verified(false)]);
    await flush();
    btn(node, "evidence-refresh").click();
    expect(load).toHaveBeenCalledTimes(2);
    expect(btn(node, "evidence-refresh").disabled).toBe(true);
    await flush();
    expect(btn(node, "evidence-refresh").disabled).toBe(false);
  });
  it("shows a failed load with a retry", async () => {
    const { node, load } = make([Object.assign(new Error("boom"), { status: 500 }), verified(false)]);
    await flush();
    expect(node.textContent).toContain("Could not load the evidence record.");
    const retry = btn(node, "evidence-retry");
    expect(retry.textContent).toBe("Retry");
    retry.click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(node.textContent).toContain("Verified");
  });
  it("exports a fresh answer", async () => {
    const second = verified(false, { runId: "r1", artifacts: [] });
    const { node, load, save } = make([verified(false), second]);
    await flush();
    btn(node, "evidence-export").click();
    expect(btn(node, "evidence-export").disabled).toBe(true);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe("evidence-r1.json");
    expect(JSON.parse(save.mock.calls[0]![1])).toEqual(second);
    expect(btn(node, "evidence-export").disabled).toBe(false);
    expect(alertText(node)).toBe("");
  });
  it("shows an export error and saves nothing", async () => {
    const { node, save } = make([verified(false), Object.assign(new Error("denied"), { status: 403 })]);
    await flush();
    btn(node, "evidence-export").click();
    await flush();
    expect(save).not.toHaveBeenCalled();
    expect(alertText(node)).toContain("Could not export the evidence.");
    expect(alertText(node)).toContain("denied");
    expect(btn(node, "evidence-export").disabled).toBe(false);
  });
  it("has real buttons, no inline style, and only the pull request link", async () => {
    const { node } = make([verified(false)]);
    await flush();
    for (const f of ["evidence-refresh", "evidence-export"]) expect(btn(node, f).attrs.type).toBe("button");
    const walk = (e: FakeElement): FakeElement[] => [e, ...e.children.flatMap((c) => (c instanceof FakeElement ? walk(c) : []))];
    expect(walk(node).filter((e) => "style" in e.attrs)).toEqual([]);
    const links = node.all("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.attrs.target).toBe("_blank");
    expect(links[0]!.attrs.rel).toBe("noopener");
  });
  it("gives an administrator a details list of files and a user one line", async () => {
    const a = make([verified(true)], { admin: true });
    await flush();
    expect(a.node.all("details")).toHaveLength(1);
    expect(a.node.all("li")).toHaveLength(5);
    expect(a.node.all("summary")[0]!.textContent).toBe("Files (5)");
    const u = make([verified(false)]);
    await flush();
    expect(u.node.all("details")).toHaveLength(0);
    expect(u.node.textContent).toContain("5 files: 4 unchanged, 1 changed");
    for (const bad of FORBIDDEN) expect(u.node.textContent).not.toContain(bad);
  });
  it("shows a user's failure without paths", async () => {
    const { node } = make([failedView({ check: "files", code: "file-changed", message: "logs/02-plan.log changed", path: "logs/02-plan.log" })]);
    await flush();
    expect(node.textContent).toContain("Verification failed");
    expect(node.textContent).toContain("A step transcript was changed after the run ended.");
    expect(node.textContent).toContain("What to do:");
    expect(node.textContent).not.toContain("logs/");
  });
});
