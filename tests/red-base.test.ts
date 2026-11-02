import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRedactCache } from "../src/credentials/redact.js";
import { addCredential } from "../src/credentials/store.js";
import { fakeKeychain, fakeToken } from "./helpers/keychain.js";
import type { RunSummary } from "../src/engine/state.js";
import type { RestIssue } from "../src/github.js";
import { inOrder } from "../src/queue/release-trigger.js";
import {
  NO_STORY_AUTONOMY, advance, checkRed, fixStory, greenOf, judgeStops, labelNames, namesAll, newEvidence, readBaseStop, readRed, redBaseEnv, redBaseFacts,
  redComment, redFile, redLine, stoppedOnRed, storyHeld, writeRed, type BaseStop, type RedCheck, type RedState,
} from "../src/red-base.js";

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const stop = (issue: number, over: Partial<BaseStop> = {}): BaseStop => ({ runId: `r${issue}`, issue, branch: "develop", commit: C1, clean: false, at: T0, failing: ["a.B.c"], assertions: [], ...over });
const state = (over: Partial<RedState> = {}): RedState => ({ branch: "develop", commit: C1, failing: ["a.B.c"], assertions: [], since: T0, held: true, ...over });

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "red-base-")); });
afterEach(() => { vi.useRealTimers(); rmSync(tmp, { recursive: true, force: true }); });

describe("judgeStops", () => {
  it("needs two issues with the same tests, or one clean stop", () => {
    expect(judgeStops([stop(1), stop(2)], C1)?.failing).toEqual(["a.B.c"]);
    expect(judgeStops([stop(1), stop(1)], C1)).toBeUndefined();
    expect(judgeStops([stop(1), stop(2, { failing: ["x.Y.z"] })], C1)).toBeUndefined();
    expect(judgeStops([stop(1, { clean: true })], C1)).toBeDefined();
    expect(judgeStops([stop(1, { gate: true }), stop(2, { gate: true })], C1)).toBeUndefined();
    expect(judgeStops([stop(1), stop(2)], C2)).toBeUndefined();
  });
});

describe("advance", () => {
  it("a new commit ends the hold and keeps the entry as cleared and moved", () => {
    const r = advance(state(), { stops: [], head: C2, greens: [], now: T1 });
    expect(r.held).toBe(false);
    expect(r.state).toMatchObject({ cleared: T1, moved: true, held: false });
  });
  it("a green on the head clears; a green on an older commit does not", () => {
    expect(advance(state(), { stops: [], head: C1, greens: [{ branch: "develop", commit: C1, at: T1 }], now: T2 }).held).toBe(false);
    expect(advance(state(), { stops: [], head: C1, greens: [{ branch: "develop", commit: C2, at: T2 }], now: T2 }).held).toBe(true);
    expect(advance(state({ since: T1 }), { stops: [], head: C1, greens: [{ branch: "develop", commit: C1, at: T0 }], now: T2 }).held).toBe(true);
  });
  it("ignores a stop older than a green on that commit", () => {
    const r = advance(undefined, { stops: [stop(1), stop(2)], head: C1, greens: [{ branch: "develop", commit: C1, at: T1 }], now: T2 });
    expect(r.held).toBe(false);
  });
  it("makes a red state and keeps the replaced one in prior", () => {
    const r = advance(state(), { stops: [stop(1, { commit: C2, failing: ["q.R.s"] }), stop(2, { commit: C2, failing: ["q.R.s"] })], head: C2, greens: [], now: T1 });
    expect(r.state).toMatchObject({ commit: C2, failing: ["q.R.s"], held: true, prior: [{ commit: C1, failing: ["a.B.c"] }] });
  });
  it("keeps the fix story while it covers the tests", () => {
    const fix = { issue: 7, tests: ["a.B"], commit: C1, label: "go" };
    const r = advance(state({ fix }), { stops: [stop(1, { commit: C2 }), stop(2, { commit: C2 })], head: C2, greens: [], now: T1 });
    expect(r.state?.fix).toEqual(fix);
  });
});

describe("stoppedOnRed and newEvidence", () => {
  it("knows late stops, green-cleared states, foreign tests and prior commits", () => {
    expect(stoppedOnRed(state(), stop(1))).toBe(true);
    expect(stoppedOnRed(state(), stop(1, { failing: ["a.B.c", "z"] }))).toBe(false);
    expect(stoppedOnRed(state({ cleared: T1 }), stop(1, { at: T2 }))).toBe(false);
    expect(stoppedOnRed(state({ cleared: T1, moved: true }), stop(1, { at: T2 }))).toBe(true);
    const s = state({ commit: C2, prior: [{ commit: C1, failing: ["a.B.c"] }] });
    expect(stoppedOnRed(s, stop(1))).toBe(true);
    expect(stoppedOnRed(s, stop(1, { failing: ["other"] }))).toBe(false);
  });
  it("drops covered stops only for a moved cleared state", () => {
    const cleared = state({ cleared: T1, moved: true });
    expect(newEvidence(cleared, [stop(1)])).toEqual([]);
    expect(newEvidence(cleared, [stop(1, { commit: C2 })])).toHaveLength(1);
    expect(newEvidence(state({ cleared: T1 }), [stop(1)])).toHaveLength(1);
  });
});

describe("storyHeld", () => {
  it("does not hold the fix story, a hotfix or a story that names every test", () => {
    const s = state({ fix: { issue: 5, tests: ["a.B.c"], commit: C1, label: "go" } });
    expect(storyHeld(s, { number: 5 }, false)).toBe(false);
    expect(storyHeld(s, { number: 6 }, true)).toBe(false);
    expect(storyHeld(s, { number: 6, body: "## Failing tests to fix\n- a.B" }, false)).toBe(false);
    expect(storyHeld(s, { number: 6, body: "no names" }, false)).toBe(true);
  });
});

describe("fixStory and words", () => {
  const withCommits = { lines: ["Depends on #1 and @someone <!-- x -->"], total: 40 };
  it("has the sections, and its tests are parsed by namesAll", () => {
    const f = fixStory({ repo: "o/r", state: state({ assertions: [{ test: "a.B.c", message: "expected 1 to be 2" }] }), commits: withCommits, lastGreen: C2 });
    if ("unusable" in f) throw new Error(f.unusable);
    expect(f.body).toContain("## Failing tests to fix");
    expect(f.body).toContain("- `a.B.c`");
    expect(f.body).toContain("## Base commit");
    expect(f.body).toContain("## Commits since the last green baseline");
    expect(f.body).toContain("… and 39 more");
    expect(f.body).not.toContain("@someone");
    expect(f.body).not.toContain("<!-- x -->");
    expect(f.body).toContain(f.marker);
    expect(namesAll(f.body, ["a.B.c"])).toBe(true);
  });
  it("says when no green or no commits are known", () => {
    const a = fixStory({ repo: "o/r", state: state() });
    expect("body" in a && a.body).toContain("No earlier green baseline is known.");
    const b = fixStory({ repo: "o/r", state: state(), lastGreen: C2 });
    expect("body" in b && b.body).toContain("could not be read");
  });
  it("refuses names that cannot be published", () => {
    expect(fixStory({ repo: "o/r", state: state({ failing: ["a <!-- b"] }) })).toHaveProperty("unusable");
    expect(fixStory({ repo: "o/r", state: state({ failing: ["depends on #3"] }) })).toHaveProperty("unusable");
    expect(fixStory({ repo: "o/r", state: state({ failing: Array.from({ length: 101 }, (_, i) => `t${i}`) }) })).toHaveProperty("unusable");
  });
  it("never shows a stored secret", () => {
    const savedHome = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = join(tmp, "home");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    const kc = fakeKeychain();
    try {
      const stored = fakeToken("Aa1");
      addCredential({ userId: "u1", type: "token", name: "fixture", secret: stored }, { ownerOk: () => true });
      const s = state({ failing: [`a.B.${stored}`], assertions: [{ test: "x", message: stored }] });
      expect(fixStory({ repo: "o/r", state: s })).toHaveProperty("unusable");
      for (const t of [redLine(s), JSON.stringify(redBaseFacts(s)), redComment("run1", s)]) expect(t).not.toContain(stored);
    } finally {
      kc.remove();
      resetRedactCache();
      if (savedHome === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = savedHome;
    }
  });
  it("builds the line and the comment", () => {
    expect(redLine(state({ failing: ["a", "b", "c", "d", "e"] }))).toBe("develop has failing tests: a, b, c and 2 more");
    const c = redComment("run1", state({ fix: { issue: 7, tests: [], commit: C1, label: "go" } }));
    expect(c).toContain("#7");
    expect(c).toContain("<!-- claude-factory run=run1 -->");
  });
});

describe("files and runs", () => {
  const runWith = (dir: string, history: unknown[], vars = { issue: "3" }): RunSummary => ({ runId: "r", runDir: dir, status: "failed", history, vars } as unknown as RunSummary);
  it("readRed survives a broken file and writeRed keeps other repositories", () => {
    const file = redFile(join(tmp, "runs"));
    writeFileSync(file, "{broken");
    expect(readRed(file, "o/r", "develop")).toBeUndefined();
    writeRed(file, "o/r", "develop", state());
    writeRed(file, "o/other", "develop", state({ commit: C2 }));
    expect(readRed(file, "o/r", "develop")?.commit).toBe(C1);
    expect(readRed(file, "o/other", "develop")?.commit).toBe(C2);
  });
  it("readBaseStop needs a baseline stop and a good file", () => {
    const history = [{ id: "baseline_failed", ok: false, type: "shell", visit: 1, output: "" }];
    expect(readBaseStop(runWith(tmp, history))).toBeUndefined();
    writeFileSync(join(tmp, "baseline-stop.json"), "{}");
    expect(readBaseStop(runWith(tmp, history))).toBeUndefined();
    writeFileSync(join(tmp, "baseline-stop.json"), JSON.stringify({ version: 1, branch: "develop", commit: C1, clean: true, at: T0, failing: ["a.B.c"], assertions: [] }));
    expect(readBaseStop(runWith(tmp, history))).toMatchObject({ issue: 3, clean: true });
    expect(readBaseStop(runWith(tmp, []))).toBeUndefined();
  });
  it("greenOf reads only the last line of the last good baseline step", () => {
    const g = (output: string, branch = "develop") => greenOf(runWith(tmp, [{ id: "baseline_tests", ok: true, output }]), branch);
    expect(g(`log\nBASE_GREEN: develop ${C1} ${T0}\n`)).toEqual({ branch: "develop", commit: C1, at: T0 });
    expect(g(`BASE_GREEN: develop ${C1} ${T0}\nmore`)).toBeUndefined();
    expect(g(`BASE_GREEN: develop ${C1} ${T0}`, "main")).toBeUndefined();
  });
  it("labelNames reads strings and objects", () => {
    expect(labelNames({ labels: ["a", { name: "b" }] })).toEqual(["a", "b"]);
  });
  it("redBaseEnv is empty without a held state, and short", () => {
    const runs = join(tmp, "runs");
    mkdirSync(runs);
    const vars = { github_repo: "o/r", develop_branch: "develop" };
    expect(redBaseEnv(runs, vars)).toEqual({});
    writeRed(redFile(runs), "o/r", "develop", state({ cleared: T1 }));
    expect(redBaseEnv(runs, vars)).toEqual({});
    writeRed(redFile(runs), "o/r", "develop", state({ failing: Array.from({ length: 5000 }, (_, i) => `a.b.test_number_${i}`) }));
    expect(redBaseEnv(runs, vars).FACTORY_RED_BASE!.length).toBeLessThanOrEqual(64_000);
    expect(redBaseEnv(runs, {})).toEqual({});
  });
});

describe("checkRed", () => {
  const issue = (n: number, over: Partial<RestIssue> = {}): RestIssue => ({ number: n, state: "open", title: "t", body: "", html_url: `https://github.com/o/r/issues/${n}`, created_at: T1, labels: [], ...over });
  let file: string;
  let heads: number;
  let creates: { title: string; body: string; labels: string[] }[];
  let existing: RestIssue[];
  let cut: boolean;
  beforeEach(() => { file = join(tmp, "red-base.json"); heads = 0; creates = []; existing = []; cut = false; });
  const make = (over: Partial<RedCheck> = {}): RedCheck => ({
    repo: "o/r", branch: "develop", label: "go", file, stops: [stop(1), stop(2)], listed: new Map(), greens: () => [],
    head: async () => { heads++; return C1; },
    commits: async () => ({ lines: [], total: 0 }),
    store: {
      create: async (o) => { creates.push(o); const i = issue(50 + creates.length, { body: o.body, labels: o.labels }); existing.unshift(i); return i; },
      get: async (n) => existing.find((i) => i.number === n),
      listAll: async () => ({ issues: existing, cut }),
    },
    noStory: () => undefined, alive: () => {}, log: () => {}, now: () => T1, eligible: (l) => l.includes("go"), ...over,
  });
  const fixListed = new Map([[51, ["go"]]]);

  it("makes no head read without stops and without a state", async () => {
    expect(await checkRed(make({ stops: [] }))).toBeUndefined();
    expect(heads).toBe(0);
  });
  it("creates one fix story for two stops, and none the second time", async () => {
    const r = await checkRed(make());
    expect(r?.held).toBe(true);
    expect(r?.made?.number).toBe(51);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.labels).toEqual(["go"]);
    await checkRed(make({ listed: fixListed }));
    expect(creates).toHaveLength(1);
  });
  it("makes one story for two overlapping checks", async () => {
    await Promise.all([inOrder("k", () => checkRed(make())), inOrder("k", () => checkRed(make()))]);
    expect(creates).toHaveLength(1);
  });
  it("a new commit ends the hold, and later checks read no head for covered stops", async () => {
    await checkRed(make());
    heads = 0;
    const moved = make({ head: async () => { heads++; return C2; }, listed: fixListed });
    expect((await checkRed(moved))?.held).toBe(false);
    expect(heads).toBe(1);
    heads = 0;
    expect((await checkRed(moved))?.held).toBe(false);
    expect(heads).toBe(0);
    await checkRed({ ...moved, stops: [stop(1, { commit: C2 })] });
    expect(heads).toBe(1);
  });
  it("keeps the stored state when the head cannot be read", async () => {
    await checkRed(make());
    const r = await checkRed(make({ head: async () => { throw new Error("down"); }, listed: fixListed }));
    expect(r?.held).toBe(true);
  });
  it("finds a marker story after a crash and adopts it with the stored label", async () => {
    await checkRed(make());
    const made = existing[0]!;
    const s = readRed(file, "o/r", "develop")!;
    writeRed(file, "o/r", "develop", { ...s, fix: undefined, pending: { marker: "m", at: T1, label: "go" } });
    creates = [];
    const r = await checkRed(make({ label: "other", eligible: () => true }));
    expect(creates).toHaveLength(0);
    expect(r?.state.fix).toMatchObject({ issue: made.number, label: "go" });
  });
  it("a failed search sets a problem and creates nothing", async () => {
    const failing = make({ store: { create: async () => { throw new Error("no"); }, get: async () => undefined, listAll: async () => { throw new Error("down"); } } });
    const r = await checkRed(failing);
    expect(r?.state.problem).toBeDefined();
    expect(r?.state.fix).toBeUndefined();
  });
  it("a cut search that does not reach pending.at creates nothing; one that does, creates", async () => {
    writeRed(file, "o/r", "develop", state({ pending: { marker: "m", at: T1, label: "go" } }));
    cut = true;
    const r = await checkRed(make());
    expect(creates).toHaveLength(0);
    expect(r?.state.problem).toBeDefined();
    existing = [issue(3, { created_at: "2025-01-01T00:00:00.000Z" })];
    expect((await checkRed(make()))?.made).toBeDefined();
  });
  it("a failed create sets a problem and keeps pending for the next search", async () => {
    const flaky = make({ store: { create: async () => { throw new Error("no"); }, get: async () => undefined, listAll: async () => ({ issues: [], cut: false }) } });
    expect((await checkRed(flaky))?.state.problem).toBeDefined();
    expect(readRed(file, "o/r", "develop")?.pending).toBeDefined();
  });
  it("sets a problem when the fix story is closed on the same commit, and makes a new one on an older commit", async () => {
    await checkRed(make());
    existing[0] = { ...existing[0]!, state: "closed" };
    expect((await checkRed(make()))?.state.problem).toBeDefined();
    const s = readRed(file, "o/r", "develop")!;
    // the base branch moved on and is red again; the closed fix story belongs to the older commit
    writeRed(file, "o/r", "develop", { ...s, commit: C2, problem: undefined });
    expect((await checkRed(make({ head: async () => C2, stops: [stop(1, { commit: C2 }), stop(2, { commit: C2 })] })))?.made).toBeDefined();
  });
  it("only the owner checks the fix story's labels", async () => {
    await checkRed(make());
    expect((await checkRed(make({ listed: new Map([[51, ["other"]]]) })))?.state.problem).toBeDefined();
    // another watcher does not own the fix: it leaves the stored state, problem included, as it is
    const before = readFileSync(file, "utf8");
    const other = await checkRed(make({ listed: new Map([[51, ["other"]]]), label: "other" }));
    expect(other?.state.problem).toBeDefined();
    expect(readFileSync(file, "utf8")).toBe(before);
    // the owner sees its fix again with its label: the problem goes
    expect((await checkRed(make({ listed: fixListed })))?.state.problem).toBeUndefined();
  });
  it("noStory sets the problem and makes no story; it is not asked while a fix exists", async () => {
    const r = await checkRed(make({ noStory: () => NO_STORY_AUTONOMY }));
    expect(r?.state.problem).toBe(NO_STORY_AUTONOMY);
    expect(creates).toHaveLength(0);
    const r2 = await checkRed(make());
    expect(r2?.made).toBeDefined();
    expect(r2?.state.problem).toBeUndefined();
    let asked = 0;
    await checkRed(make({ noStory: () => { asked++; return undefined; }, listed: fixListed }));
    expect(asked).toBe(0);
  });
  it("a hanging search ends at its time limit", async () => {
    vi.useFakeTimers();
    const hang = make({ store: { create: async () => issue(1), get: async () => undefined, listAll: () => new Promise(() => {}) } });
    const done = checkRed(hang);
    await vi.advanceTimersByTimeAsync(26_000);
    expect((await done)?.state.problem).toBeDefined();
    expect(creates).toHaveLength(0);
  });
  it("a given-up check creates and writes nothing", async () => {
    let calls = 0;
    const dead = make({ alive: () => { if (++calls > 3) throw new Error("given up"); } });
    await expect(checkRed(dead)).rejects.toThrow("given up");
    expect(creates).toHaveLength(0);
    expect(readRed(file, "o/r", "develop")?.fix).toBeUndefined();
  });
});
