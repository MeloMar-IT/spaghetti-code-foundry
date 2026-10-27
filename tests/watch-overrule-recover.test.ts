import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ASKS, TRIGGER, WORKING, decided, said, setupOverrule } from "./helpers/overrule-setup.js";

describe("an accepted /overrule is never lost", () => {
  const s = setupOverrule();
  const { t, watcher, issues, comments, plant, log, acks, runLog } = s;
  const overrule = said("/overrule Q1 use sqlite");
  const resumes = () => t.submit.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "resume").length;

  it("a check given up after the ack: no second ack, one resume at the next check", async () => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, overrule);
    const hold = join(t.gh.tmp, "hold");
    writeFileSync(hold, "");
    process.env.FAKE_GH_HOLD = hold;
    process.env.FAKE_GH_HOLD_ON = `--add-label ${WORKING}`;
    const w = watcher();
    w.checkTimeoutMs = 1000;
    await w.tick();
    await vi.waitFor(() => expect(log()).toContain(`--add-label ${WORKING}`));
    expect(acks()).toBe(1);
    expect(w.status.lastError).toMatch(/given up/);
    rmSync(hold);
    delete process.env.FAKE_GH_HOLD;
    w.checkTimeoutMs = 10 * 60_000;
    await w.tick();
    expect(acks()).toBe(1);
    expect(resumes()).toBe(1);
  });

  it("a new watcher (restart) after the ack finds the open work in the issue and the run log", async () => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, overrule);
    t.submit.mockImplementationOnce((() => { throw new Error("down"); }) as never);
    await watcher().tick();
    expect(acks()).toBe(1);
    expect(resumes()).toBe(1);
    const again = watcher();
    await again.tick();
    expect(acks()).toBe(1);
    expect(resumes()).toBe(2);
    expect(runLog()).toContain("overrule 901 planned again");
  });

  it("an overrule already planned again is not planned a second time", async () => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, overrule);
    const w = watcher();
    await w.tick();
    expect(resumes()).toBe(1);
    const w2 = watcher();
    issues([TRIGGER, ASKS], "2026-01-09T00:00:00Z");
    await w2.tick();
    expect(acks()).toBe(1);
    expect(resumes()).toBe(1);
  });

  it("an ack that is being posted by an earlier check is not posted again", async () => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, overrule);
    const w = watcher();
    (w as unknown as { overruleInFlight: Set<string> }).overruleInFlight.add("901");
    await w.tick();
    expect(acks()).toBe(0);
    expect(t.submit).not.toHaveBeenCalled();
    (w as unknown as { overruleInFlight: Set<string> }).overruleInFlight.clear();
    await w.tick();
    expect(acks()).toBe(1);
    expect(resumes()).toBe(1);
  });

  it("a run cancelled while the check ran gets no resume, and the work stays pending", async () => {
    plant(); issues([TRIGGER, ASKS]); comments(decided, overrule);
    const hold = join(t.gh.tmp, "hold");
    writeFileSync(hold, "");
    process.env.FAKE_GH_HOLD = hold;
    process.env.FAKE_GH_HOLD_ON = `--add-label ${WORKING}`;
    const tick = watcher().tick();
    await vi.waitFor(() => expect(log()).toContain(`--add-label ${WORKING}`));
    plant({ parkedAt: "2026-01-01T03:00:00.000Z" }); // parked by someone else while the label is edited
    rmSync(hold);
    await tick;
    expect(acks()).toBe(1);
    expect(t.submit).not.toHaveBeenCalled();
  });
});
