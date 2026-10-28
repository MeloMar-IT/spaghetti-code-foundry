import { describe, expect, it, vi } from "vitest";
import { ASKS, DONE, TRIGGER, WORKING, decided, said, setupOverrule } from "./helpers/overrule-setup.js";

describe("the watcher drafts a follow-up after /overrule on merged code", () => {
  const s = setupOverrule();
  const { t, watcher, issues, comments, plant, log, acks, drafts, acts, runLog } = s;
  const overrule = said("/overrule Q1 use sqlite");
  const merged = { status: "succeeded", reason: undefined, history: [{ id: "push_develop", type: "shell", visit: 1, ok: true, output: "PUSHED: abc" }] };
  const closed = (labels = [DONE]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "issue 4", state: "CLOSED", updatedAt: "2026-01-02T00:00:00Z", labels: labels.map((name) => ({ name })) }]);
  };
  const found = () => { process.env.FAKE_GH_OVERRULE_SEARCH = JSON.stringify([{ number: 4, updatedAt: "2026-01-02T00:00:00Z" }]); };
  const noChange = () => expect(log()).not.toMatch(/issue create|--- created issue|issue edit 4/);
  /** A closed, merged story that the search returns; the trigger list does not have it. */
  const closedStory = (labels = [DONE]) => { plant(merged); closed(labels); comments(decided, overrule); found(); };

  it("posts one draft for a labeled merged story, and changes nothing else", async () => {
    plant(merged); issues([TRIGGER, DONE]); comments(decided, overrule); found();
    const w = watcher();
    await w.tick();
    expect(drafts()).toBe(1);
    expect(log()).toContain("is already merged");
    expect(log()).toContain("**Title:** Follow-up to #4");
    expect(acks()).toBe(0);
    expect(t.submit).not.toHaveBeenCalled();
    noChange();
    expect(acts(w)).toContain("follow-up draft posted");
    expect(runLog().join("\n")).toContain("follow-up draft posted");
    await w.tick();
    expect(drafts()).toBe(1);
    issues([TRIGGER, DONE], "2026-01-03T00:00:00Z");
    await w.tick();
    expect(drafts()).toBe(1);
  });

  it.each([[[TRIGGER]], [[TRIGGER, WORKING]]])("starts nothing and edits no label in the check with the draft (%j)", async (labels) => {
    plant(merged); issues(labels); comments(decided, overrule);
    await watcher().tick();
    expect(drafts()).toBe(1);
    expect(t.submit).not.toHaveBeenCalled();
    noChange();
  });

  it.each([
    ["the comments cannot be read", () => { process.env.FAKE_GH_FAIL_ON = "comments,labels"; }, () => { delete process.env.FAKE_GH_FAIL_ON; }, undefined],
    ["a permission lookup fails", () => { process.env.FAKE_GH_PERMISSION = "fail"; }, () => { process.env.FAKE_GH_PERMISSION = "write"; }, "/overrule:"],
  ])("an unfinished check (%s) changes nothing and is tried again", async (_n, fail, fix, logged) => {
    plant(merged); issues([TRIGGER]); comments(decided, overrule);
    fail();
    const w = watcher();
    await w.tick();
    expect(drafts()).toBe(0);
    expect(t.submit).not.toHaveBeenCalled();
    noChange();
    if (logged) expect(t.logged.join("\n")).toContain(logged);
    fix();
    await w.tick();
    expect(drafts()).toBe(1);
  });

  it("drafts for a closed merged story the search finds; no submit, no label edit", async () => {
    closedStory();
    const w = watcher();
    await w.tick();
    expect(log()).toMatch(/gh issue list --repo acme\/app --state all --search overrule in:comments updated:>=\d{4}-\d{2}-\d{2} --limit 30 --json number,updatedAt/);
    expect(drafts()).toBe(1);
    expect(t.submit).not.toHaveBeenCalled();
    noChange();
    await w.tick();
    expect(drafts()).toBe(1);
  });

  it("does not relabel a closed story that got a draft, even with a stale working label", async () => {
    closedStory([WORKING]);
    process.env.FAKE_GH_CLOSED_ISSUES = process.env.FAKE_GH_ISSUES;
    await watcher().tick();
    expect(drafts()).toBe(1);
    expect(log()).not.toContain("issue edit 4");
  });

  it("leaves a closed story with an excluded label alone", async () => {
    closedStory([DONE, "skip"]);
    await watcher({ exclude_labels: ["skip"] }).tick();
    expect(drafts()).toBe(0);
  });

  it("leaves a closed story alone when its labels cannot be read", async () => {
    closedStory();
    process.env.FAKE_GH_FAIL_API = "list";
    process.env.FAKE_GH_FAIL_ON = "state,labels";
    await watcher().tick();
    expect(drafts()).toBe(0);
    expect(t.logged.join("\n")).toContain("labels could not be read");
  });

  it("searches at every check, also when nothing is merged", async () => {
    plant(); issues([TRIGGER, ASKS]);
    const w = watcher();
    await w.tick();
    await w.tick();
    expect(log().split("\n").filter((l) => l.includes("overrule in:comments"))).toHaveLength(2);
  });

  it("ignores a run that did not merge", async () => {
    plant({ status: "succeeded", reason: undefined, history: [{ id: "create_split", type: "shell", visit: 1, ok: true, output: "" }] });
    closed(); found(); comments(decided, overrule);
    await watcher().tick();
    expect(drafts()).toBe(0);
    expect(t.submit).not.toHaveBeenCalled();
  });

  it("finds a merged run outside the list of the latest runs", async () => {
    closedStory();
    vi.spyOn(t.scheduler, "list").mockReturnValue([]);
    await watcher().tick();
    expect(drafts()).toBe(1);
  });

  it("does not stop an active run that has started merging; the draft comes once it ended merged", async () => {
    plant({ status: "running", reason: undefined, history: [{ id: "merge_develop", type: "shell", visit: 1, ok: true, output: "" }], state: { next: "push_develop", steps: {}, visits: {} } });
    issues([TRIGGER, WORKING]); comments(decided, overrule);
    const active = vi.spyOn(t.scheduler, "isActive").mockReturnValue(true);
    const stop = vi.spyOn(t.scheduler, "requestStop");
    const w = watcher();
    await w.tick();
    expect(stop).not.toHaveBeenCalled();
    expect(drafts()).toBe(0);
    expect(acks()).toBe(0);
    active.mockReturnValue(false);
    plant({ ...merged, history: [{ id: "merge_develop", type: "shell", visit: 1, ok: true, output: "" }, ...merged.history] });
    issues([TRIGGER, DONE]);
    await w.tick();
    expect(drafts()).toBe(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("tries a failed post again at the next check", async () => {
    closedStory();
    process.env.FAKE_GH_FAIL_ON = "issue comment";
    const w = watcher();
    await w.tick();
    expect(drafts()).toBe(0);
    expect(t.logged.join("\n")).toMatch(/\/overrule: .*boom/);
    delete process.env.FAKE_GH_FAIL_ON;
    await w.tick();
    expect(drafts()).toBe(1);
  });

  it("logs a failed search and does not fail the check", async () => {
    closedStory();
    process.env.FAKE_GH_FAIL_ON = "overrule in:comments";
    const w = watcher();
    await w.tick();
    expect(drafts()).toBe(0);
    expect(w.status.lastError).toBeUndefined();
    expect(t.logged.join("\n")).toMatch(/\/overrule sweep: .*boom/);
    delete process.env.FAKE_GH_FAIL_ON;
    await w.tick();
    expect(drafts()).toBe(1);
  });

  it("ignores a read-only user's overrule after the merge", async () => {
    closedStory();
    process.env.FAKE_GH_READONLY = "stranger";
    comments(decided, said("/overrule Q1 x", "stranger"));
    const w = watcher();
    await w.tick();
    expect(drafts()).toBe(0);
    expect(acts(w)).toContain("ignored /overrule from @stranger");
  });

  it("says so when the search hits its limit", async () => {
    process.env.FAKE_GH_OVERRULE_SEARCH = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ number: 100 + i, updatedAt: "2026-01-02T00:00:00Z" })));
    issues([TRIGGER, ASKS]);
    await watcher().tick();
    expect(t.logged.join("\n")).toContain("the limit");
  });

  it("keeps a closed story safe from relabelling when its comment read is skipped, and drafts later", async () => {
    closedStory([WORKING]);
    process.env.FAKE_GH_CLOSED_ISSUES = process.env.FAKE_GH_ISSUES;
    const w = watcher();
    (w as any).slowUntil.set(4, Date.now() + 60_000);
    await w.tick();
    expect(drafts()).toBe(0);
    expect(log()).not.toContain("issue edit 4");
    (w as any).slowUntil.clear();
    await w.tick();
    expect(drafts()).toBe(1);
  });
});
