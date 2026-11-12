import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { addRepoWatcher } from "../src/repos/watchers.js";
import { namesAll, redFile, storyHeld, writeRed } from "../src/red-base.js";
import { openWorld, type World } from "./helpers/refinement-world.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let w: World;
const sha = (c: string) => c.repeat(40);
const step = (id: string, output: string, startedAt: string) => ({ id, type: "shell", visit: 1, ok: true, output, startedAt, durationMs: 1000, logFile: "x" });

/** A succeeded gitflow run of issue `n` that pushed develop at `commit`. */
function plant(id: string, n: number, title: string, commit: string, at: string) {
  const runDir = join(w.tmp, "runs", id);
  mkdirSync(runDir, { recursive: true });
  saveRun({
    runId: id, flow: "issue-gitflow", task: "t", vars: { github_repo: "acme/app", develop_branch: "develop", issue: String(n) }, repo: "/x", status: "succeeded", owner: w.ann.user.id, source: "ui",
    runDir, startedAt: at, finishedAt: at, totalCostUsd: 0, flowDef: { name: "issue-gitflow", steps: [] }, state: { next: null, steps: {}, visits: {} },
    history: [step("pull_ticket", `# #${n}: ${title}`, at), step("push_develop", `COMMIT: ${commit}`, at)],
  } as unknown as RunSummary);
}
const plantThree = () => {
  plant("r1", 1, "One", sha("1"), "2026-11-01T10:00:00.000Z");
  plant("r2", 2, "Two", sha("2"), "2026-11-02T10:00:00.000Z");
  plant("r3", 3, "Three", sha("3"), "2026-11-03T10:00:00.000Z");
};
const watch = () => {
  addRepoWatcher(w.annRepo().id, { id: "app-w", label: "Factory_go" });
  w.started.ctx.watchers.sync();
  w.gh.setLabels(["Factory_go"]);
};
const path = () => `/api/repos/${w.annRepo().id}/safe-points/restore`;
const preview = async (commit = sha("1"), who = w.ann) => w.call(who, "POST", path(), { commit, dryRun: true });
const confirm = (commit: string, token: string, who = w.ann) => w.call(who, "POST", path(), { commit, confirm: token });

beforeEach(async () => {
  w = await openWorld("api-restore");
  plantThree();
});
afterEach(async () => {
  await w.close();
});

describe("preview", () => {
  it("lists the titles of the newer points, the fixed sentences and a token, and opens nothing", async () => {
    watch();
    const r = await preview();
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ commit: sha("1"), takenBack: ["Three", "Two"], more: 0 });
    expect(j.notUndone).toMatch(/does not undo/);
    expect(j.others).toMatch(/outside the Foundry/);
    expect(j.confirm.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.gh.createdBodies()).toHaveLength(0);
  });
});

describe("confirm", () => {
  it("opens one change with the build label, and the token works once", async () => {
    watch();
    const token = (await preview()).json().confirm.token;
    const r = await confirm(sha("1"), token);
    expect(r.status).toBe(200);
    expect(r.json().issue).toBeGreaterThan(0);
    const made = w.gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.labels).toContain("Factory_go");
    for (const s of [sha("1"), "`Three`", "`Two`", "git revert", "force-push", "does not undo", `<!-- claude-factory restore=${sha("1")} -->`]) expect(made[0]!.body).toContain(s);
    expect((await confirm(sha("1"), token)).status).toBe(409);
    expect(w.gh.createdBodies()).toHaveLength(1);
  });

  it("refuses a missing or wrong token, a bad body and a commit that is no safe point", async () => {
    watch();
    const token = (await preview()).json().confirm.token;
    expect((await w.call(w.ann, "POST", path(), { commit: sha("1"), confirm: "x" })).status).toBe(409);
    expect((await w.call(w.ann, "POST", path(), { commit: sha("1"), confirm: token.replace(/.$/, "A") })).status).toBe(409);
    expect((await w.call(w.ann, "POST", path(), { commit: sha("1"), dryRun: true, extra: 1 })).status).toBe(400);
    expect((await w.call(w.ann, "POST", path(), { commit: sha("1"), dryRun: false })).status).toBe(400);
    expect((await w.call(w.ann, "POST", path(), { commit: "abc", dryRun: true })).status).toBe(400);
    expect((await preview(sha("9"))).status).toBe(409);
    // a token made for another commit does not fit this one
    expect((await confirm(sha("2"), (await preview(sha("1"))).json().confirm.token)).status).toBe(409);
    expect(w.gh.createdBodies()).toHaveLength(0);
  });

  it("answers 409 and opens nothing when the shown points changed", async () => {
    watch();
    const token = (await preview()).json().confirm.token;
    plant("r4", 4, "Four", sha("4"), "2026-11-04T10:00:00.000Z");
    const r = await confirm(sha("1"), token);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/changed/);
    expect(w.gh.createdBodies()).toHaveLength(0);
  });

  it("opens one change when two confirms come together", async () => {
    watch();
    const token = (await preview()).json().confirm.token;
    const both = await Promise.all([confirm(sha("1"), token), confirm(sha("1"), token)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(w.gh.createdBodies()).toHaveLength(1);
  });

  it("names the failing tests while the base branch is red, so the watcher does not hold the change", async () => {
    watch();
    writeRed(redFile(join(w.tmp, "runs")), "acme/app", "develop", { branch: "develop", commit: sha("3"), failing: ["suite > broken"], assertions: [], since: "2026-11-05T00:00:00.000Z", held: true });
    const token = (await preview()).json().confirm.token;
    expect((await confirm(sha("1"), token)).status).toBe(200);
    const body = w.gh.createdBodies()[0]!.body;
    expect(body).toContain("`suite > broken`");
    expect(namesAll(body, ["suite > broken"])).toBe(true);
    expect(storyHeld({ failing: ["suite > broken"] }, { number: 101, body }, false)).toBe(false);
  });

  it("refuses when the build label does not exist on GitHub", async () => {
    watch();
    const token = (await preview()).json().confirm.token;
    // The new watcher makes its own labels in the background: wait for that, then take every label away.
    while (!w.gh.labels().includes("factory:done")) await new Promise((r) => setTimeout(r, 20));
    w.gh.setLabels(["other"]);
    const r = await confirm(sha("1"), token);
    expect(r.status).toBe(409);
    expect(w.gh.createdBodies()).toHaveLength(0);
  });
});

describe("who may", () => {
  it("gives another user 404 and lets an admin restore", async () => {
    watch();
    expect((await preview(sha("1"), w.bob)).status).toBe(404);
    expect((await confirm(sha("1"), "x", w.bob)).status).toBe(404);
    const t = await preview(sha("1"), w.admin);
    expect(t.status).toBe(200);
    expect((await confirm(sha("1"), t.json().confirm.token, w.admin)).status).toBe(200);
    expect(w.gh.createdBodies()).toHaveLength(1);
  });

  it("answers 409 for a project with no enabled issues watcher", async () => {
    const r = await preview();
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/^Nothing was opened/);
  });
});
