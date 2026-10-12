import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORK } from "../src/remote/areas/work.js";
import { parseCmd, specProblems, type Cmd } from "../src/remote/spec.js";
import { remoteWorld, type RemoteWorld } from "./helpers/remote.js";

const WALK = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const SLOW = `name: slow
workspace: empty
steps:
  - {id: a, type: shell, run: "sleep 30"}
`;

let w: RemoteWorld;
// the tests run the table of this file, also before it is registered with the other areas
const scf = (words: string[], o: Parameters<RemoteWorld["scf"]>[1] = {}) => w.scf(words, { cmds: WORK, ...o });
const cmd = (area: string, action: string): Cmd => WORK.find((c) => c.area === area && c.action === action)!;
const callOf = (area: string, action: string, words: string[]) => parseCmd(cmd(area, action), words).call;

interface Run { runId: string; status: string }
const runOf = async (id: string) => (await scf(["runs", "show", id, "--json"])).json<Run>();
async function until(id: string, status: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if ((await runOf(id)).status === status) return;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`run ${id} did not become ${status}`);
}
const start = async (flow: string, task: string) => (await scf(["runs", "start", flow, task, "--json"])).json<{ runId: string }>().runId;
const writeRun = (id: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(w.runsDir, id), { recursive: true });
  writeFileSync(join(w.runsDir, id, "run.json"), JSON.stringify({
    runId: id, flow: "old", task: "", vars: {}, repo: w.tmp, status: "succeeded", runDir: join(w.runsDir, id),
    startedAt: new Date(Date.now() - 3_600_000).toISOString(), finishedAt: new Date(Date.now() - 3_000_000).toISOString(),
    totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...extra,
  }));
};

let walk: string;

beforeAll(async () => {
  w = await remoteWorld();
  for (const [name, yaml] of [["walk", WALK], ["slow", SLOW]] as const) {
    const r = await w.scf(["api", "PUT", `flows/${name}`, "--data", JSON.stringify({ yaml, scope: "repo" }), "--yes"]);
    expect(r.code).toBe(0);
  }
  walk = await start("walk", "Feed the quokka\nsecond line");
  await until(walk, "waiting");
});
afterAll(() => w.close());

describe("the table", () => {
  it("has no mistakes, and its area names are free", () => {
    expect(specProblems(WORK)).toEqual([]);
    expect([...new Set(WORK.map((c) => c.area))].sort()).toEqual(["board", "find", "runs", "turn"]);
  });

  it("turns the words into the calls the server reads", () => {
    expect(callOf("runs", "list", ["bug", "--status", "failed", "--repo", "acme/app", "--archived"])).toEqual({ method: "GET", path: "runs", query: { q: "bug", status: "failed", repo: "acme/app", archived: "1" } });
    expect(callOf("runs", "start", ["walk", "Do it", "--vars", '{"issue":"7"}', "--like-user"])).toEqual({ method: "POST", path: "runs", body: { flow: "walk", task: "Do it", vars: { issue: "7" }, likeUser: true } });
    expect(callOf("runs", "log", ["r1", "2"])).toEqual({ method: "GET", path: "runs/r1/transcript/2" });
    expect(callOf("runs", "answer", ["r1", "Use the second option"])).toEqual({ method: "POST", path: "runs/r1/answer", body: { text: "Use the second option" } });
    expect(callOf("runs", "reject", ["r1", "--note", "too big"])).toEqual({ method: "POST", path: "runs/r1/reject", body: { note: "too big" } });
    expect(callOf("runs", "resume", ["r1", "--from", "plan"])).toEqual({ method: "POST", path: "runs/r1/resume", body: { from: "plan" } });
    expect(callOf("turn", "show", ["acme/app#7|questions|r1"])).toEqual({ method: "GET", path: "your-turn/detail", query: { key: "acme/app#7|questions|r1" } });
    expect(callOf("board", "since", ["2026-10-01"])).toEqual({ method: "GET", path: "since", query: { since: "2026-10-01" } });
    expect(callOf("find", "id", ["run:r1"])).toEqual({ method: "GET", path: "search", query: { id: "run:r1" } });
  });

  it("sends an action on an item with what `turn show` printed", () => {
    const seen = ["--stamp", "s1", "--digest", "d1"];
    expect(callOf("turn", "answer", ["k", "--answers", '[{"n":1,"text":"yes"}]', ...seen]).body).toEqual({ action: "answer", key: "k", answers: [{ n: 1, text: "yes" }], stamp: "s1", digest: "d1" });
    expect(callOf("turn", "defaults", ["k", ...seen]).body).toEqual({ action: "defaults", key: "k", stamp: "s1", digest: "d1" });
    expect(callOf("turn", "approve", ["k", "--text", "fine", ...seen]).body).toEqual({ action: "approve", key: "k", text: "fine", stamp: "s1", digest: "d1" });
    expect(callOf("turn", "reject", ["k", "smaller steps", ...seen]).body).toEqual({ action: "reject", key: "k", text: "smaller steps", stamp: "s1", digest: "d1" });
    expect(callOf("turn", "retry", ["k"])).toEqual({ method: "POST", path: "your-turn/act", body: { action: "retry", key: "k" } });
    expect(callOf("turn", "retry-hint", ["k", "look at the lock file", "--stamp", "s1"]).body).toEqual({ action: "retry_hint", key: "k", text: "look at the lock file", stamp: "s1" });
    expect(() => callOf("turn", "approve", ["k"])).toThrow("--stamp is needed");
    expect(() => callOf("turn", "reject", ["k", ...seen])).toThrow("missing <text>");
  });
});

describe("runs", () => {
  it("lists the runs with what they are for, and narrows the list", async () => {
    const out = (await scf(["runs", "list"])).out.split("\n");
    expect(out[0]).toMatch(/^ID\s+FLOW\s+STATUS\s+FOR\s+STARTED\s+OWNER\s+NEXT$/);
    expect(out.find((l) => l.startsWith(walk))).toMatch(/\s+walk\s+waiting\s+Feed the quokka\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+admin\s+\S/);
    expect((await scf(["runs", "list", "quokka", "--status", "waiting", "--json"])).json<Run[]>().map((r) => r.runId)).toEqual([walk]);
    expect((await scf(["runs", "list", "--status", "failed"])).out).toBe("no runs");
    const bad = await scf(["runs", "list", "--status", "odd"]);
    expect([bad.code, bad.err]).toEqual([1, "error: status must be one of: running, succeeded, failed, cancelled, stopped, waiting"]);
  });

  it("shows one run: where it stands and its steps", async () => {
    const out = (await scf(["runs", "show", walk])).out;
    expect(out).toContain(`id:        ${walk}`);
    expect(out).toMatch(/flow:\s+walk\n/);
    expect(out).toMatch(/status:\s+waiting\n/);
    expect(out).toMatch(/for:\s+Feed the quokka\n/);
    expect(out).toMatch(/started:\s+\d{4}-\d\d-\d\d \d\d:\d\d\n/);
    expect(out).toMatch(/waits for:\s+Go\?\n/);
    expect(out).toMatch(/\nN\s+STEP\s+TYPE\s+OK\s+STARTED\s+TOOK\n0\s+say\s+shell\s+yes\s/);
    const gone = await scf(["runs", "show", "nope"]);
    expect([gone.code, gone.err]).toEqual([1, "error: run not found"]);
  });

  it("reads the transcript of a step and the changes", async () => {
    expect((await scf(["runs", "log", walk, "0"])).out).toMatch(/^step say \(shell\)\n\n/);
    expect((await scf(["runs", "log", walk, "9"])).err).toBe("error: no such step");
    const diff = await scf(["runs", "diff", walk]);
    expect([diff.code, diff.out]).toEqual([0, "no changes"]);
    const evidence = await scf(["runs", "evidence", walk]);
    expect(evidence.code).toBe(0);
    expect(evidence.out).toMatch(new RegExp(`^(no )?evidence · run ${walk} · [a-z-]+\\n\\n`));
    const none = await scf(["runs", "evidence", "nope"]);
    expect([none.code, none.err]).toEqual([1, "error: run not found"]);
  });

  it("names the owners and the filter values", async () => {
    expect((await scf(["runs", "owners"])).out).toMatch(/^ID\s+NAME\s+RUNS\n\S+\s+admin\s+1$/);
    expect((await scf(["runs", "filters"])).out).toBe("repositories: none\nflows:        walk");
  });

  it("approves a waiting run, archives it and takes it back", async () => {
    const busy = await scf(["runs", "archive", walk]);
    expect([busy.code, busy.err]).toEqual([1, "error: only a finished run can be archived; this run is running, waiting or queued"]);
    expect((await scf(["runs", "approve", walk, "--note", "fine"])).out).toBe(`run ${walk} continues: approved`);
    await until(walk, "succeeded");
    expect((await scf(["runs", "archive", walk])).out).toBe(`run ${walk} is archived`);
    expect((await scf(["runs", "list"])).out).toBe("no runs");
    expect((await scf(["runs", "list", "--archived", "--json"])).json<Run[]>().map((r) => r.runId)).toEqual([walk]);
    expect((await scf(["runs", "unarchive", walk])).out).toBe(`run ${walk} is back in the list of runs`);
    expect((await scf(["runs", "list"])).out).toContain(walk);
    const late = await scf(["runs", "reject", walk]);
    expect([late.code, late.err]).toEqual([1, "error: run is not waiting for approval"]);
    const answer = await scf(["runs", "answer", walk, "yes"]);
    expect([answer.code, answer.err]).toEqual([1, "error: this run did not stop with questions"]);
  });

  it("asks before it cancels a run", async () => {
    const slow = await start("slow", "Wait a while");
    await until(slow, "running");
    await expect(scf(["runs", "cancel", slow])).rejects.toThrow("This stops the run; the work of the step that is running is lost. Add --yes to do it without a question.");
    expect((await runOf(slow)).status).toBe("running");
    expect((await scf(["runs", "cancel", slow, "--yes"])).out).toBe(`run ${slow} is cancelled`);
    await until(slow, "cancelled");
    expect((await scf(["runs", "cancel", slow, "--yes"])).out).toBe(`run ${slow} is not running or queued: nothing to cancel`);
  });

  it("gives a user their own runs only, and refuses the admin commands", async () => {
    const ann = await w.signIn("ann@example.com");
    expect((await scf(["runs", "list"], { as: ann })).out).toBe("no runs");
    // another account's run answers like an unknown one
    expect((await scf(["runs", "show", walk], { as: ann })).err).toBe("error: run not found");
    for (const words of [["runs", "owners"], ["turn", "list"], ["board", "show"], ["board", "next"], ["turn", "clarity"]]) {
      const r = await scf(words, { as: ann });
      expect([words.join(" "), r.code, r.err.startsWith("error: ")]).toEqual([words.join(" "), 4, true]);
    }
    const own = await scf(["runs", "start", "walk", "Ann's walk"], { as: ann });
    expect(own.out).toMatch(/^run \S+ (started|is queued)$/);
    expect((await scf(["runs", "list", "--json"], { as: ann })).json<Run[]>()).toHaveLength(1);
    const hidden = await scf(["runs", "start", "slow"], { as: ann });
    expect([hidden.code, hidden.err]).toEqual([1, "error: flow not found"]);
  });
});

describe("your turn, the board and search", () => {
  let waiting: string;
  let key: string;

  it("says what changed since a time", async () => {
    const out = (await scf(["board", "since", "2020-01-01"])).out;
    expect(out).toMatch(/^since 2020-01-01 00:00: 1 change\n\n1 newly waiting for you\nAT\s+WHERE\s+TITLE\n\S+ \S+\s+run \S+\s+Ann's walk$/);
    expect((await scf(["board", "since", "soon"])).err).toBe('error: "since" must be a time');
  });

  it("lists what waits for you, with the key and what is asked", async () => {
    waiting = await start("walk", "Paint the fence");
    await until(waiting, "waiting");
    const turn = (await scf(["turn", "list", "--json"])).json<{ count: number; groups: { items: { key: string; next: { runId?: string; status: string } }[] }[] }>();
    const item = turn.groups.flatMap((g) => g.items).find((i) => i.next.runId === waiting)!;
    key = item.key;
    const out = (await scf(["turn", "list"])).out;
    // a run without a repository names a folder of the server: the heading does not repeat it
    expect(out).toMatch(/^\(no repository\)\nKEY\s+WHAT\s+ASKED\s+SINCE\n/);
    expect(out.split("\n").find((l) => l.startsWith(key))).toContain(item.next.status);
  });

  it("dismisses an item and brings it back", async () => {
    const keys = (r: { json<T>(): T }) => r.json<{ dismissed: number; groups: { items: { key: string }[] }[] }>();
    const gone = keys(await scf(["turn", "dismiss", key, "--json"]));
    expect([gone.dismissed, gone.groups.flatMap((g) => g.items).some((i) => i.key === key)]).toEqual([1, false]);
    expect((await scf(["turn", "list"])).out).toContain("1 dismissed (scf turn restore brings them back)");
    expect((await scf(["turn", "restore"])).out).toContain(key);
    expect((await scf(["turn", "dismiss", "no|such|item"])).err).toBe("error: no such item");
  });

  it("answers an item without an issue with the server's reason", async () => {
    // a run started by hand has no issue: there is no comment to read or to write
    const detail = await scf(["turn", "show", key]);
    expect([detail.code, detail.err]).toEqual([1, "error: there is nothing to show for this item here"]);
    const act = await scf(["turn", "approve", key, "--stamp", "s", "--digest", "d"]);
    expect([act.code, act.err]).toEqual([1, "error: that is not possible for this item"]);
    expect((await scf(["turn", "clarity", "--json"])).json<{ waitingNow: number }>().waitingNow).toBeGreaterThan(0);
    expect((await scf(["turn", "clarity"])).code).toBe(0);
  });

  it("shows the board and what happens next", async () => {
    writeRun("r-story", { flow: "walk", task: "Repair the gizmo", vars: { github_repo: "acme/app", issue: "254" }, source: "ui" });
    const board = (await scf(["board", "show"])).out.split("\n");
    expect(board[0]).toBe("acme/app");
    expect(board[1]).toMatch(/^COLUMN\s+ISSUE\s/);
    expect(board[2]).toMatch(/^Done\s+#254\s/);
    expect(board[2]).toContain("r-story");
    const next = (await scf(["board", "next"])).out;
    expect(next).toMatch(/^WHO\s+WHERE\s+STATUS/);
    expect(next).toContain("acme/app#254");
    expect(next).toMatch(new RegExp(`\\nYou\\s+run ${waiting}\\s+waiting for you`));
    expect((await scf(["runs", "list", "#254"])).out).toMatch(/\nr-story\s+walk\s+succeeded\s+acme\/app#254\s/);
  });

  it("finds things by text and by id", async () => {
    const out = (await scf(["find", "all", "gizmo"])).out;
    expect(out).toMatch(/^Runs\nID\s+TITLE\s+STATUS\s+REPO\s+DETAIL\s+WHEN\nr-story\s+Repair the gizmo\s+\S.*acme\/app\s+walk · #254\s/);
    expect((await scf(["find", "id", "run:r-story", "--json"])).json<{ groups: { hits: { id: string }[] }[] }>().groups[0]!.hits[0]!.id).toBe("r-story");
    expect((await scf(["find", "all", "zzzz-nothing"])).out).toBe("nothing found");
    expect((await scf(["find", "id", "r-story"])).err).toBe("error: an id must look like <type>:<id>");
  });
});
