import { describe, expect, it, vi } from "vitest";
import { ASKS, DONE, FAILED, TRIGGER, WAITING, WORKING, decided, said, setupOverrule } from "./helpers/overrule-setup.js";

describe("the watcher acts on /overrule", () => {
  const s = setupOverrule();
  const { t, watcher, issues, comments, plant, log, acks, notes, acts, runLog, untouched } = s;
  const overrule = said("/overrule Q1 use sqlite");

  it("resumes a stopped run from its first step after one ack, and the ack comes first", async () => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, overrule);
    let ackedAtSubmit = false;
    t.submit.mockImplementation((() => { ackedAtSubmit = acks() === 1; return "queued-1"; }) as never);
    const w = watcher();
    await w.tick();
    expect(acks()).toBe(1);
    expect(log()).toContain("**Overrule accepted** for Q1.");
    expect(ackedAtSubmit).toBe(true);
    expect(t.submit).toHaveBeenCalledTimes(1);
    expect(t.submit.mock.calls[0]![0]).toMatchObject({ kind: "resume", runId: "r1", from: "pull_ticket" });
    expect(log()).toContain(`--add-label ${WORKING}`);
    expect(runLog()).toContain("overrule 901 planned again");
    expect(acts(w)).toContain("overruled by @marcel");
    await w.tick();
    expect(acks()).toBe(1);
  });

  it.each([
    ["failed", { status: "failed", reason: "boom" }, [TRIGGER, FAILED]],
    ["waiting", { status: "waiting", reason: "approval" }, [TRIGGER, WAITING]],
  ])("resumes a %s run", async (_n, over, labels) => {
    plant(over); issues(labels as string[]); comments(decided, overrule);
    await watcher().tick();
    expect(acks()).toBe(1);
    expect(t.submit.mock.calls[0]![0]).toMatchObject({ kind: "resume", runId: "r1", from: "pull_ticket" });
  });

  it("ignores a read-only user: one line in the activity and the run log, nothing posted", async () => {
    process.env.FAKE_GH_READONLY = "stranger";
    plant(); issues([TRIGGER, ASKS]); comments(decided, said("/overrule Q1 x", "stranger"));
    const w = watcher();
    await w.tick();
    issues([TRIGGER, ASKS], "2026-01-03T00:00:00Z");
    await w.tick();
    untouched();
    expect(acts(w).match(/#4 ignored \/overrule from @stranger \(no write access\)/g)).toHaveLength(1);
    expect(runLog().filter((l) => l === "#4 ignored /overrule from @stranger (no write access)")).toHaveLength(1);
    delete process.env.FAKE_GH_READONLY;
  });

  it.each([["unknown Q7", "/overrule Q7 x"], ["malformed", "/overrule please"]])("posts one note for %s and plans nothing", async (_n, body) => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, said(body));
    const w = watcher();
    await w.tick();
    expect(notes()).toBe(1);
    issues([TRIGGER, ASKS], "2026-01-03T00:00:00Z");
    await w.tick();
    expect(notes()).toBe(1);
    expect(t.submit).not.toHaveBeenCalled();
  });

  it("stops an active run, then plans it again once it stopped as overruled", async () => {
    plant({ status: "running", reason: undefined }); issues([TRIGGER, WORKING]); comments(decided, overrule);
    vi.spyOn(t.scheduler, "isActive").mockReturnValue(true);
    const stop = vi.spyOn(t.scheduler, "requestStop").mockReturnValue(true);
    const w = watcher();
    await w.tick();
    expect(stop).toHaveBeenCalledWith("r1", "overruled");
    expect(acks()).toBe(0);
    expect(t.submit).not.toHaveBeenCalled();
    vi.mocked(t.scheduler.isActive).mockReturnValue(false);
    plant({ status: "stopped", reason: "overruled" });
    await w.tick();
    expect(acks()).toBe(1);
    expect(t.submit.mock.calls[0]![0]).toMatchObject({ kind: "resume", runId: "r1", from: "pull_ticket" });
  });

  it("waits while the run is queued", async () => {
    plant(); issues([TRIGGER, WORKING]); comments(decided, overrule);
    vi.spyOn(t.scheduler, "isQueued").mockReturnValue(true);
    await watcher().tick();
    untouched();
  });

  it("restarts a finished plan-only run: ack, done label removed, new run", async () => {
    plant({ status: "succeeded", reason: undefined }); issues([TRIGGER, DONE]); comments(decided, overrule);
    await watcher().tick();
    expect(acks()).toBe(1);
    expect(t.submit.mock.calls[0]![0]).toMatchObject({ kind: "run" });
    expect(log()).toContain(`--remove-label ${DONE}`);
    expect(log()).toContain(`--add-label ${WORKING}`);
  });

  it("holds a restart while the daily budget is spent, then does it", async () => {
    plant({ status: "succeeded", reason: undefined }); issues([TRIGGER, DONE]); comments(decided, overrule);
    const w = watcher();
    const spent = vi.spyOn(w as never, "budgetLeft" as never).mockReturnValue(false as never);
    await w.tick();
    untouched();
    spent.mockReturnValue(true as never);
    await w.tick();
    expect(acks()).toBe(1);
    expect(t.submit.mock.calls[0]![0]).toMatchObject({ kind: "run" });
  });

  it.each([
    ["merged code", { status: "succeeded", history: [{ id: "push_main", type: "shell", visit: 1, ok: true, output: "pushed" }] }],
    ["a parked run", { parkedAt: "2026-01-01T02:00:00.000Z" }],
    ["a run cancelled while stopped", { status: "cancelled", reason: "cancelled by user while stopped" }],
  ])("changes nothing for %s", async (_n, over) => {
    plant(over); issues([TRIGGER, DONE]); comments(decided, overrule);
    await watcher().tick();
    untouched();
  });

  it("does not take an /overrule as the answer to the questions of a stopped run", async () => {
    plant({ flowDef: { name: "x", steps: [{ id: "pull_ticket" }] } }); issues([TRIGGER, ASKS]);
    comments({ author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=r1 -->", createdAt: "2026-01-01T00:00:00Z" }, overrule);
    await watcher().tick();
    untouched();
  });

  it("an up-front needs-info issue (no run yet) takes the overrule as an answer: ack, then a new run", async () => {
    issues([TRIGGER, ASKS]); comments(decided, overrule);
    await watcher().tick();
    expect(acks()).toBe(1);
    expect(t.submit.mock.calls[0]![0]).toMatchObject({ kind: "run" });
    expect(log()).toContain(`--add-label ${WORKING}`);
  });

  it("a plain /overrule without a decided comment is no answer", async () => {
    issues([TRIGGER, ASKS]); comments({ author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=pre1 questions -->", createdAt: "2026-01-01T00:00:00Z" }, overrule);
    await watcher().tick();
    untouched();
  });
});
