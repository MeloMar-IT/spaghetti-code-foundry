import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let runs: any;
let dialogs: any;
beforeAll(async () => {
  restore = installFakeDom();
  runs = await import("../ui/runs.js" as string);
  dialogs = await import("../ui/run-dialogs.js" as string);
});
afterAll(() => restore());

const LIMIT_REASON = "the issue's spending limit is reached: $0.02 spent of $0.01 (the issue, its split parts and retries) — an administrator can raise it on the run page";
const stopped = (over: Record<string, unknown> = {}) => ({ runId: "r1", status: "stopped", reason: LIMIT_REASON, state: { next: "b" }, flowDef: { steps: [{ id: "a" }, { id: "b" }] }, next: { kind: "stopped" }, ...over });
const labels = (list: FakeElement[]) => list.map((b) => b.textContent);

describe("the Raise the issue's limit button", () => {
  it("shows for a run stopped by the issue limit", () => {
    expect(labels(runs.actions(stopped()))).toContain("Raise the change's limit");
  });
  it("does not show for another stop, another status or a closed issue", () => {
    expect(labels(runs.actions(stopped({ reason: "the project's daily limit is reached — resume tomorrow" })))).not.toContain("Raise the change's limit");
    expect(labels(runs.actions(stopped({ status: "failed" })))).not.toContain("Raise the change's limit");
    expect(labels(runs.actions(stopped({ next: { kind: "issue_closed" } })))).not.toContain("Raise the change's limit");
  });
  it("calls run('raise-limit')", () => {
    const run = vi.fn();
    const b = runs.actions(stopped(), run).find((x: FakeElement) => x.attrs["data-focus"] === "act-raise-limit");
    b.click?.() ?? b.listeners?.click?.[0]?.();
    expect(run).toHaveBeenCalledWith("raise-limit");
  });
});

describe("adminRunActions: raise-limit", () => {
  const info = { spentUsd: 0.02, limitUsd: 0.01, defaultUsd: 0.01 };
  it("reads the state, saves the limit and then resumes the run", async () => {
    const calls: string[] = [];
    const a = {
      issueLimit: vi.fn(async () => (calls.push("issueLimit"), info)),
      setIssueLimit: vi.fn(async (_id: string, n: number) => void calls.push(`set ${n}`)),
      resumeRun: vi.fn(async () => void calls.push("resume")),
    };
    const raise = vi.fn(async (i: unknown, send: (n: number) => Promise<void>) => {
      expect(i).toEqual(info);
      await send(0.02);
      return true;
    });
    const onDone = vi.fn();
    const ok = await dialogs.adminRunActions("r1", { a, raise, onDone })("raise-limit");
    expect(ok).toBe(true);
    expect(calls).toEqual(["issueLimit", "set 0.02", "resume"]);
    expect(onDone).toHaveBeenCalled();
  });

  it("a refused save does not resume", async () => {
    const a = { issueLimit: vi.fn(async () => info), setIssueLimit: vi.fn(async () => { throw new Error("no"); }), resumeRun: vi.fn() };
    const raise = vi.fn(async (_i: unknown, send: (n: number) => Promise<void>) => {
      await expect(send(1)).rejects.toThrow("no");
      return false; // the dialog stays open and the person gives up
    });
    expect(await dialogs.adminRunActions("r1", { a, raise })("raise-limit")).toBe(false);
    expect(a.resumeRun).not.toHaveBeenCalled();
  });

  it("a state that cannot be read shows its sentence and opens no dialog", async () => {
    const a = { issueLimit: vi.fn(async () => { throw new Error("gone"); }) };
    const raise = vi.fn();
    const alerts: string[] = [];
    expect(await dialogs.adminRunActions("r1", { a, raise, setAlert: (t: string) => alerts.push(t) })("raise-limit")).toBe(false);
    expect(raise).not.toHaveBeenCalled();
    expect(alerts.at(-1)).toBeTruthy();
  });
});
