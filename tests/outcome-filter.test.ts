import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRunAsync, type RunBrief, type RunSummary } from "../src/engine/state.js";
import { OutcomeFactsCache, type OutcomeFacts } from "../src/outcome-facts.js";
import { OUTCOME_IDS, type OutcomeWindow } from "../src/outcomes.js";
import { checkedRunAsync } from "../src/server/api-runs.js";
import { briefWorkKey, narrowBriefs, outcomeDefinitionsFor, outcomesFor, parseOutcomeFilter, visibleBriefs } from "../src/server/api-outcomes.js";
import { HttpError } from "../src/server/http.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-30T12:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const WINDOW: OutcomeWindow = { from: new Date(NOW - 10 * DAY), to: new Date(NOW), previousFrom: new Date(NOW - 20 * DAY) };

const parse = (q: string) => parseOutcomeFilter(new URLSearchParams(q));
const refused = (q: string): string => {
  try {
    parse(q);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return (e as HttpError).message;
  }
  throw new Error(`accepted: ${q}`);
};

describe("parseOutcomeFilter", () => {
  it("defaults to 30 days and accepts 1 and 90", () => {
    expect(parse("")).toEqual({ days: 30 });
    expect(parse("days=1").days).toBe(1);
    expect(parse("days=90").days).toBe(90);
  });

  it("refuses a days value that is not a whole number from 1 to 90", () => {
    for (const v of ["0", "91", "1.5", "-1", "abc", "", "0x10", "1e1"]) expect(refused(`days=${encodeURIComponent(v)}`)).toBe("days must be a whole number from 1 to 90");
  });

  it("refuses an empty or too long repo and flow", () => {
    expect(refused("repo=")).toBe("invalid repo");
    expect(refused("flow=")).toBe("invalid flow");
    expect(refused(`repo=${"a".repeat(201)}`)).toBe("invalid repo");
    expect(parse(`flow=${"a".repeat(200)}`).flow).toHaveLength(200);
    expect(parse("repo=acme/app&flow=build")).toEqual({ days: 30, repo: "acme/app", flow: "build" });
  });

  it("takes only a model like agent:provider:model", () => {
    expect(parse("model=claude:anthropic:opus").model).toBe("claude:anthropic:opus");
    expect(parse("model=codex:openai:gpt-5").model).toBe("codex:openai:gpt-5");
    for (const v of ["claude:anthropic", "foo:x:y", " claude:anthropic:opus", ""]) expect(refused(`model=${encodeURIComponent(v)}`)).toMatch(/^model must be agent:provider:model/);
  });

  it("takes only a policy like id@version", () => {
    expect(parse("policy=baseline@1").policy).toBe("baseline@1");
    expect(parse("policy=push-guard@2.0.1").policy).toBe("push-guard@2.0.1");
    for (const v of ["baseline", "Base@1", "a@b@c", "@1", "a@"]) expect(refused(`policy=${encodeURIComponent(v)}`)).toMatch(/^policy must be id@version/);
  });

  it("ignores unknown parameters, as among them", () => {
    expect(parse("as=abc&x=1")).toEqual({ days: 30 });
  });
});

let n = 0;
function brief(o: Partial<RunBrief> = {}): RunBrief {
  const runId = `run-${++n}`;
  return { runId, dirName: runId, flow: "build", status: "succeeded", startedAt: iso(5), finishedAt: iso(4), owner: "ann", runDir: `/x/${runId}`, updatedAt: iso(4), githubRepo: "acme/app", ...o };
}

describe("visibleBriefs", () => {
  it("gives a user their own runs on repositories in their list only", () => {
    const own = brief();
    const other = brief({ owner: "bob" });
    const noRepo = brief({ githubRepo: undefined });
    const removed = brief({ githubRepo: "acme/old" });
    expect(visibleBriefs([own, other, noRepo, removed], { owner: "ann", repos: new Set(["acme/app"]) })).toEqual([own]);
  });

  it("matches the repository in any case", () => {
    const b = brief({ githubRepo: "Acme/App" });
    expect(visibleBriefs([b], { owner: "ann", repos: new Set(["acme/app"]) })).toEqual([b]);
  });

  it("keeps everything for an admin", () => {
    const all = [brief(), brief({ owner: undefined, githubRepo: undefined }), brief({ owner: "bob" })];
    expect(visibleBriefs(all, {})).toEqual(all);
  });
});

describe("narrowBriefs", () => {
  const narrow = (briefs: RunBrief[], scope = {}) => narrowBriefs(briefs, scope, WINDOW);

  it("drops a run that ended before the previous window and keeps one from the previous window", () => {
    const old = brief({ finishedAt: iso(25), startedAt: iso(26) });
    const previous = brief({ finishedAt: iso(15), startedAt: iso(16) });
    const current = brief();
    expect(narrow([old, previous, current])).toEqual([previous, current]);
  });

  it("keeps an open run that started in the window and drops one that started before", () => {
    const open = brief({ status: "running", finishedAt: undefined, startedAt: iso(3) });
    const stale = brief({ status: "running", finishedAt: undefined, startedAt: iso(30) });
    expect(narrow([open, stale])).toEqual([open]);
  });

  it("pulls in older runs of the same work item, but not runs with no work key or of another flow", () => {
    const current = brief({ issue: "7" });
    const history = brief({ issue: "7", startedAt: iso(60), finishedAt: iso(59) });
    const alone = brief({ startedAt: iso(60), finishedAt: iso(59) });
    const otherFlow = brief({ issue: "7", flow: "plan", startedAt: iso(60), finishedAt: iso(59) });
    expect(narrow([current, history, alone, otherFlow])).toEqual([current, history, otherFlow]);
    expect(narrow([current, history, alone, otherFlow], { flow: "build" })).toEqual([current, history]);
  });

  it("filters by repository in any case, and keeps archived runs", () => {
    const a = brief({ githubRepo: "Acme/App", archived: true });
    const b = brief({ githubRepo: "acme/other" });
    expect(narrow([a, b], { repo: "acme/app" })).toEqual([a]);
  });

  it("builds the work key like the run version does", () => {
    expect(briefWorkKey(brief({ issue: "7" }))).toBe("acme/app#issue:7");
    expect(briefWorkKey(brief({ pr: "3" }))).toBe("acme/app#pr:3");
    expect(briefWorkKey(brief({ ciRun: "9" }))).toBe("acme/app#ci:9");
    const alone = brief();
    expect(briefWorkKey(alone)).toBe(alone.runId);
  });
});

describe("outcomeDefinitionsFor", () => {
  it("leaves out cost and returning users for a user", () => {
    const ids = outcomeDefinitionsFor(false).map((d) => d.id);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain("cost_per_successful_run");
    expect(ids).not.toContain("returning_users");
    expect(outcomeDefinitionsFor(true).map((d) => d.id)).toEqual([...OUTCOME_IDS]);
  });
});

const factsOf = (runId: string, over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  runId, evidence: { stream: true, read: true, manifest: true, incomplete: false }, pushed: false, delivered: false, policyBlocks: 0, observeDenies: 0,
  models: [], policies: [], approvals: { decided: 0, totalMs: 0, maxMs: 0 }, resumes: 0, ...over,
});

/** A cache whose evidence reader is replaced: `facts` by runId, and a log of the runs it was asked about. */
function stubCache(facts: Map<string, OutcomeFacts>) {
  const asked: string[] = [];
  const cache = new OutcomeFactsCache();
  cache.collect = async (runs) => {
    const out = new Map<string, OutcomeFacts>();
    for (const r of runs) {
      asked.push(r.runId);
      const f = facts.get(r.runId);
      if (f) out.set(r.runId, f);
    }
    return out;
  };
  return { cache, asked };
}

const runOf = (b: RunBrief, over: Partial<RunSummary> = {}): RunSummary => ({ runId: b.runId, flow: b.flow, status: b.status, startedAt: b.startedAt, finishedAt: b.finishedAt, owner: b.owner, runDir: b.runDir, source: b.source, vars: {}, ...over }) as unknown as RunSummary;
const measure = (r: Awaited<ReturnType<typeof outcomesFor>>, id: string) => r.measures.find((m) => m.id === id)!;

describe("outcomesFor", () => {
  it("loads and reads evidence only for the briefs it is given, and never reads evidence of a refinement run", async () => {
    const a = brief();
    const b = brief();
    const refinement = brief({ source: "refinement abc" });
    const loaded: string[] = [];
    const { cache, asked } = stubCache(new Map());
    await outcomesFor({ briefs: [a, b, refinement], filter: { days: 10 }, admin: true, window: WINDOW }, {
      cache,
      load: async (x) => {
        loaded.push(x.runId);
        return runOf(x);
      },
    });
    expect(loaded).toEqual([a.runId, b.runId, refinement.runId]);
    expect(asked).toEqual([a.runId, b.runId]);
  });

  it("keeps the event loop free while a load is pending", async () => {
    const a = brief();
    let release!: (r: RunSummary) => void;
    const held = new Promise<RunSummary>((r) => (release = r));
    const { cache } = stubCache(new Map());
    let settled = false;
    const p = outcomesFor({ briefs: [a], filter: { days: 10 }, admin: true, window: WINDOW }, { cache, load: () => held }).then(() => (settled = true));
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
    release(runOf(a));
    await p;
    expect(settled).toBe(true);
  });

  it("gives the event loop a turn between loads", async () => {
    const briefs = [brief(), brief(), brief(), brief()];
    const { cache } = stubCache(new Map());
    let yielded = false;
    const q = outcomesFor({ briefs, filter: { days: 10 }, admin: true, window: WINDOW }, { cache, yieldEvery: 2, load: async (x) => runOf(x) });
    setImmediate(() => (yielded = true));
    const before = yielded;
    await q;
    expect(before).toBe(false);
    expect(yielded).toBe(true);
  });

  it("counts only the runs whose facts have the model, and never a run with no facts", async () => {
    const a = brief();
    const b = brief();
    const c = brief();
    const facts = new Map([[a.runId, factsOf(a.runId, { models: ["claude:anthropic:opus"] })], [b.runId, factsOf(b.runId, { models: ["codex:openai:gpt-5"] })]]);
    const { cache } = stubCache(facts);
    const run = (model?: string, policy?: string) =>
      outcomesFor({ briefs: [a, b, c], filter: { days: 10, model, policy }, admin: true, window: WINDOW }, { cache, load: async (x) => runOf(x) });
    expect(measure(await run(), "resume_count").counted).toBe(3);
    expect(measure(await run("claude:anthropic:opus"), "resume_count").counted).toBe(1);
    expect(measure(await run("claude:anthropic:haiku"), "resume_count").counted).toBe(0);
  });

  it("filters by policy", async () => {
    const a = brief();
    const b = brief();
    const { cache } = stubCache(new Map([[a.runId, factsOf(a.runId, { policies: ["baseline@1"] })], [b.runId, factsOf(b.runId, { policies: ["baseline@2"] })]]));
    const r = await outcomesFor({ briefs: [a, b], filter: { days: 10, policy: "baseline@2" }, admin: true, window: WINDOW }, { cache, load: async (x) => runOf(x) });
    expect(measure(r, "resume_count").counted).toBe(1);
  });

  it("gives model and policy values to an admin only, and hides cost for a user", async () => {
    const a = brief();
    const { cache } = stubCache(new Map([[a.runId, factsOf(a.runId, { models: ["claude:anthropic:opus"], policies: ["baseline@1"] })]]));
    const input = { briefs: [a], filter: { days: 10 }, window: WINDOW };
    const deps = { cache, load: async (x: RunBrief) => runOf(x) };
    const admin = await outcomesFor({ ...input, admin: true }, deps);
    expect(admin.values).toEqual({ models: ["claude:anthropic:opus"], policies: ["baseline@1"] });
    expect(admin.measures).toHaveLength(10);
    const user = await outcomesFor({ ...input, admin: false }, deps);
    expect(user.values).toEqual({});
    expect(user.measures.map((m) => m.id)).toEqual(user.definitions.map((d) => d.id));
    expect(user.measures).toHaveLength(8);
    expect(JSON.stringify(user)).not.toContain("costUsd");
  });
});

describe("async run loading", () => {
  const tmp = mkdtempSync(join(tmpdir(), "outcome-load-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("loadRunAsync gives undefined for a bad id and for a missing file, and the run otherwise", async () => {
    mkdirSync(join(tmp, "r1"));
    writeFileSync(join(tmp, "r1", "run.json"), JSON.stringify({ runId: "r1", status: "succeeded" }));
    expect((await loadRunAsync(tmp, "r1"))?.runId).toBe("r1");
    expect(await loadRunAsync(tmp, "nope")).toBeUndefined();
    expect(await loadRunAsync(tmp, "../r1")).toBeUndefined();
  });

  it("checkedRunAsync refuses another owner and a runId that differs from the folder name", async () => {
    const runs: Record<string, Partial<RunSummary>> = { a: { runId: "a", owner: "ann" }, b: { runId: "other", owner: "ann" } };
    const scheduler = { getAsync: async (id: string) => runs[id] as RunSummary | undefined } as unknown as Parameters<typeof checkedRunAsync>[0];
    expect((await checkedRunAsync(scheduler, "a", "ann"))?.runId).toBe("a");
    expect((await checkedRunAsync(scheduler, "a"))?.runId).toBe("a");
    expect(await checkedRunAsync(scheduler, "a", "bob")).toBeUndefined();
    expect(await checkedRunAsync(scheduler, "b")).toBeUndefined();
    expect(await checkedRunAsync(scheduler, "missing")).toBeUndefined();
  });
});
