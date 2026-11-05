import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoError, addRepo, reposPath, setRepoAuth, setRepoWorkspace, transferRepo } from "../src/auth/repos.js";
import { ConfigSchema, parseConfigText } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, queuedWorkspace, type Job } from "../src/queue/scheduler.js";
import { limitsOf, knownWorkspace, workspaceForJob, workspaceOfRepo, workspaceOfRun, workspacesOf } from "../src/workspaces/index.js";
import { WORKSPACE_ID_RE } from "../src/workspaces/list.js";
import { UsageEventSchema } from "../src/usage/schema.js";
import { loadPlugins } from "../src/plugins/load.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAT = "33333333-3333-4333-8333-333333333333";
const OK = { ownerOk: () => true };
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "workspaces-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const config = (text: string) => writeFileSync(join(home, "config.yaml"), text);
const TEAMS = `workspaces:
  - {id: team-a, name: Team A, members: ["${ANN}", "${BOB}"], limits: {max_concurrent: 2}}
  - {id: team-b, name: Team B, members: ["${BOB}"]}
`;
const bad = (text: string) => expect(() => parseConfigText(text)).toThrow();
const noRepo = (id: string) => workspaceOfRepo(id);

describe("config", () => {
  it("accepts a valid list and fills members and limits", () => {
    const c = parseConfigText(`workspaces:\n  - {id: team-a, name: " A "}\n`);
    expect(c.workspaces).toEqual([{ id: "team-a", name: "A", members: [], limits: {} }]);
    expect(parseConfigText("").workspaces).toEqual([]);
  });
  it("refuses bad entries", () => {
    const w = (s: string) => `workspaces:\n  - ${s}\n`;
    for (const s of [
      "{id: Team, name: A}", "{id: -a, name: A}", "{id: default, name: A}", "{id: a}", "{id: a, name: A, extra: 1}",
      '{id: a, name: A, members: ["bob"]}', `{id: a, name: A, members: ["${ANN}", "${ANN}"]}`,
      "{id: a, name: A, limits: {max_concurrent: 0}}", "{id: a, name: A, limits: {test_slots: 1.5}}", "{id: a, name: A, limits: {monthly_budget_usd: -1}}",
    ]) bad(w(s));
    bad("workspaces:\n  - {id: a, name: A}\n  - {id: a, name: B}\n");
  });
});

describe("lookups", () => {
  it("puts everyone in default without a list", () => {
    expect(workspacesOf(ANN)).toEqual(["default"]);
    expect(limitsOf("default")).toEqual({});
    expect(knownWorkspace("default")).toBe(true);
    expect(knownWorkspace("team-a")).toBe(false);
  });
  it("lists every workspace of an account in list order, else default", () => {
    config(TEAMS);
    expect(workspacesOf(BOB)).toEqual(["team-a", "team-b"]);
    expect(workspacesOf(ANN)).toEqual(["team-a"]);
    expect(workspacesOf(CAT)).toEqual(["default"]);
    expect(limitsOf("team-a")).toEqual({ max_concurrent: 2 });
    expect(limitsOf("team-b")).toEqual({});
    expect(limitsOf("nope")).toEqual({});
    expect(knownWorkspace("team-b")).toBe(true);
  });
  it("never throws on a broken config.yaml", () => {
    config("workspaces: [\n");
    expect(workspacesOf(ANN)).toEqual(["default"]);
    expect(limitsOf("team-a")).toEqual({});
  });
  it("reads the workspace of a repository and of a run", () => {
    expect(noRepo("nope")).toBe("default");
    const r = addRepo(ANN, { url: "acme/app" }, OK);
    expect(workspaceOfRepo(r.id)).toBe("default");
    config(TEAMS);
    setRepoWorkspace(r.id, { workspace: "team-a" }, knownWorkspace);
    expect(workspaceOfRepo(r.id)).toBe("team-a");
    const runs = join(home, "runs");
    mkdirSync(join(runs, "r1"), { recursive: true });
    mkdirSync(join(runs, "r2"), { recursive: true });
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ runId: "r1", workspace: "team-a" }));
    writeFileSync(join(runs, "r2", "run.json"), JSON.stringify({ runId: "r2" }));
    expect(workspaceOfRun("r1")).toBe("team-a");
    expect(workspaceOfRun("r2")).toBe("default");
    expect(workspaceOfRun("missing")).toBe("default");
    expect(workspaceOfRun("../x")).toBe("default");
  });
});

describe("setRepoWorkspace and records", () => {
  const known = (id: string) => id === "team-a";
  const stored = () => (JSON.parse(readFileSync(reposPath(), "utf8")) as { repos: Record<string, unknown>[] }).repos[0]!;
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof RepoError ? e.code : e;
    }
    return undefined;
  };
  it("sets, clears and refuses", () => {
    const r = addRepo(ANN, { url: "acme/app" }, OK);
    expect(setRepoWorkspace(r.id, { workspace: "team-a" }, known)).toMatchObject({ changed: true, repo: { workspace: "team-a" } });
    expect(stored().workspace).toBe("team-a");
    expect(setRepoWorkspace(r.id, { workspace: "team-a" }, known).changed).toBe(false);
    expect(setRepoWorkspace(r.id, { workspace: null }, known).changed).toBe(true);
    expect("workspace" in stored()).toBe(false);
    setRepoWorkspace(r.id, { workspace: "team-a" }, known);
    expect(setRepoWorkspace(r.id, { workspace: "default" }, known).changed).toBe(true);
    expect("workspace" in stored()).toBe(false);
    for (const input of [{ workspace: "team-z" }, { workspace: "Bad" }, {}, null, "team-a", { workspace: 5 }]) expect(code(() => setRepoWorkspace(r.id, input, known))).toBe("bad-settings");
    expect(code(() => setRepoWorkspace(BOB, { workspace: null }, known))).toBe("not-found");
  });
  it("is kept by transferRepo and setRepoAuth", () => {
    const r = addRepo(ANN, { url: "acme/app", method: "github-token", token: TOKEN }, OK);
    setRepoWorkspace(r.id, { workspace: "team-a" }, known);
    setRepoAuth(ANN, r.id, { token: TOKEN + "x" }, OK);
    expect(stored().workspace).toBe("team-a");
    setRepoAuth(ANN, r.id, { method: "none" }, OK);
    setRepoAuth(ANN, r.id, { method: "none" }, OK);
    expect(stored().workspace).toBe("team-a");
    const t = transferRepo(r.id, "bob@example.com", { findOwner: () => ({ id: BOB, status: "active" }) });
    expect(t.repo.workspace).toBe("team-a");
    expect(stored().workspace).toBe("team-a");
  });
  it("keeps the value when a personal token is wiped by a transfer", () => {
    const r = addRepo(ANN, { url: "acme/app2", method: "github-token", token: TOKEN }, OK);
    setRepoWorkspace(r.id, { workspace: "team-a" }, known);
    const t = transferRepo(r.id, "bob@example.com", { findOwner: () => ({ id: BOB, status: "active" }) });
    expect(t.repo).toMatchObject({ method: "none", workspace: "team-a" });
  });
});

describe("workspaceForJob", () => {
  it("finds the owner's record, a shared value, or default", () => {
    const a = addRepo(ANN, { url: "acme/app" }, OK);
    const none = (_: string) => true;
    expect(workspaceForJob({ githubRepo: "acme/app", owner: ANN })).toBe("default");
    setRepoWorkspace(a.id, { workspace: "team-a" }, none);
    expect(workspaceForJob({ githubRepo: "acme/app", owner: ANN })).toBe("team-a");
    expect(workspaceForJob({ githubRepo: "acme/app", owner: BOB })).toBe("team-a"); // not the owner: the one record's value
    expect(workspaceForJob({ githubRepo: "acme/other", owner: ANN })).toBe("default");
    expect(workspaceForJob({ githubRepo: "owner/repo" })).toBe("default");
    expect(workspaceForJob({})).toBe("default");
    expect(workspaceForJob({ githubRepo: "not a name" })).toBe("default");
  });
});

describe("usage schema", () => {
  const base = { id: "a", time: "2026-11-04T10:00:00.000Z", runId: "r", name: "run.started" };
  it("takes default and team ids, refuses an empty or malformed one", () => {
    expect(UsageEventSchema.safeParse({ ...base, workspace: "default" }).success).toBe(true);
    expect(UsageEventSchema.safeParse({ ...base, workspace: "team-a" }).success).toBe(true);
    expect(UsageEventSchema.safeParse({ ...base, workspace: "" }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...base, workspace: "Team" }).success).toBe(false);
    expect(WORKSPACE_ID_RE.test("a".repeat(41))).toBe(false);
  });
});

describe("the queue", () => {
  const SLOW = "name: slow\nworkspace: inplace\nvars:\n  github_repo: acme/flowdefault\nsteps:\n  - {id: a, type: shell, run: \"true\"}\n";
  const setup = () => {
    const repo = join(home, "repo");
    mkdirSync(repo);
    const queueFile = join(home, "queue.json");
    const cfg = () => ({ ...ConfigSchema.parse({}), concurrency: 1 });
    const make = () => {
      const s = new Scheduler({ runsDir: join(home, "runs"), queueFile, config: cfg });
      s.drain(); // nothing starts
      return s;
    };
    const job = (vars: Record<string, string> = {}, extra: Partial<Extract<Job, { kind: "run" }>> = {}): Job => ({ kind: "run", flow: parseFlow(SLOW), task: "t", repo, vars, ...extra });
    const file = () => JSON.parse(readFileSync(queueFile, "utf8")) as { runId: string; workspace?: string }[];
    return { make, job, file };
  };
  it("stores a given workspace, none for default, and drops an invalid one", () => {
    const { make, job, file } = setup();
    const s = make();
    const a = s.submit(job({ github_repo: "acme/none" }), { owner: ANN, workspace: "team-a" });
    const b = s.submit(job({ github_repo: "acme/none" }), { owner: ANN });
    const c = s.submit(job({ github_repo: "acme/none" }), { owner: ANN, workspace: "Bad" });
    const f = (id: string) => file().find((q) => q.runId === id)!;
    expect(f(a).workspace).toBe("team-a");
    expect("workspace" in f(b)).toBe(false);
    expect(queuedWorkspace(f(b))).toBe("default");
    expect("workspace" in f(c)).toBe(false);
    expect(queuedWorkspace({})).toBe("default");
  });
  it("takes the repository's workspace from the effective variables and keeps it over a restart", () => {
    const { make, job, file } = setup();
    const r = addRepo(ANN, { url: "acme/flowdefault" }, OK);
    const g = addRepo(ANN, { url: "acme/given" }, OK);
    setRepoWorkspace(r.id, { workspace: "team-a" }, () => true);
    setRepoWorkspace(g.id, { workspace: "team-b" }, () => true);
    const s = make();
    const fromFlow = s.submit(job(), { owner: ANN }); // github_repo only from the flow's defaults
    const given = s.submit(job({ github_repo: "acme/given" }), { owner: ANN });
    const frozen = s.submit(job({}, { frozenVars: true }), { owner: ANN }); // vars as they are: no github_repo
    const f = (id: string) => file().find((q) => q.runId === id)!;
    expect(f(fromFlow).workspace).toBe("team-a");
    expect(f(given).workspace).toBe("team-b");
    expect("workspace" in f(frozen)).toBe(false);
    const again = make(); // a new scheduler reads the file back and writes it again with the next change
    again.submit(job({ github_repo: "acme/given" }), { owner: ANN });
    expect(f(fromFlow).workspace).toBe("team-a");
    expect(again.queue().pending).toHaveLength(4);
  });
});

describe("the queue reads a run's variables once", () => {
  it("runs with the repository it was queued for when its settings change while it waits", async () => {
    const repo = join(home, "repo-frozen");
    mkdirSync(join(repo, ".claude-factory"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "config.yaml"), "vars:\n  github_repo: acme/a\n");
    const a = addRepo(ANN, { url: "acme/a" }, OK);
    setRepoWorkspace(a.id, { workspace: "team-a" }, () => true);
    const s = new Scheduler({ runsDir: join(home, "runs"), queueFile: join(home, "queue-frozen.json"), config: () => ({ ...ConfigSchema.parse({}), concurrency: 1 }) });
    s.drain(); // nothing starts until resume()
    const flow = parseFlow(`name: plain\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "true"}\n`);
    const id = s.submit({ kind: "run", flow, task: "t", repo, vars: {} }); // no owner: the run is not refused
    writeFileSync(join(repo, ".claude-factory", "config.yaml"), "vars:\n  github_repo: acme/b\n");
    s.resume();
    await s.idle();
    const run = JSON.parse(readFileSync(join(home, "runs", id, "run.json"), "utf8")) as { vars: Record<string, string>; workspace?: string };
    expect(run.vars.github_repo).toBe("acme/a");
    expect(run.workspace).toBe("team-a");
  });
});

describe("plugin point", () => {
  const load = (registers: ((api: any) => unknown)[]) =>
    loadPlugins(registers.map((_, i) => ({ module: `/abs/p${i}.mjs`, options: {} })), {
      blockedDirs: [],
      resolve: (s) => s,
      importModule: async (url) => ({ register: registers[Number(/p(\d+)\.mjs/.exec(url)![1])] }),
    });
  const list = [{ id: "plug", name: "Plug", members: [ANN], limits: {} }];
  it("replaces the config list, is registered, and dispose puts the config list back", async () => {
    config(TEAMS);
    const reg = await load([(api) => api.workspaces({ list: () => list })]);
    expect(reg.plugins[0]!.registered).toEqual([{ point: "workspaces", name: "workspaces" }]);
    expect(workspacesOf(ANN)).toEqual(["plug"]);
    expect(workspacesOf(BOB)).toEqual(["default"]);
    reg.dispose!();
    expect(workspacesOf(ANN)).toEqual(["team-a"]);
  });
  it("reports a second supplier and keeps the first", async () => {
    const reg = await load([(api) => api.workspaces({ list: () => list }), (api) => api.workspaces({ list: () => [] })]);
    expect(reg.problems).toHaveLength(1);
    expect(reg.problems[0]!.reason).toContain("supplies the workspaces already");
    expect(workspacesOf(ANN)).toEqual(["plug"]);
    reg.dispose!();
  });
  it("reports a bad list once, with fixed text, and falls back to default", async () => {
    config(TEAMS);
    const reg = await load([(api) => api.workspaces({ list: () => [{ id: "SECRET-TEXT" }] })]);
    expect(reg.problems).toHaveLength(1);
    expect(reg.problems[0]!.reason).not.toContain("SECRET-TEXT");
    expect(workspacesOf(ANN)).toEqual(["default"]);
    expect(workspacesOf(ANN)).toEqual(["default"]);
    expect(reg.problems).toHaveLength(1);
    reg.dispose!();
  });
  it("reports a list() that throws or answers with a promise or thenable, and swallows a late rejection", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const stores: (() => unknown)[] = [
        () => {
          throw new Error("boom-text");
        },
        () => Promise.reject(new Error("now-text")),
        () => new Promise((_, rej) => setTimeout(() => rej(new Error("later-text")), 0)),
        () => ({ then: (_a: unknown, b: (e: unknown) => void) => b(new Error("thenable-text")) }),
      ];
      for (const fn of stores) {
        const reg = await load([(api) => api.workspaces({ list: fn })]);
        expect(reg.problems).toHaveLength(1);
        expect(reg.problems[0]!.reason).not.toMatch(/-text/);
        expect(workspacesOf(ANN)).toEqual(["default"]);
        reg.dispose!();
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
  it("fails the load for a store without list and throws for a call after register", async () => {
    await expect(load([(api) => api.workspaces({})])).rejects.toThrow(/list\(\)/);
    let late: any;
    const reg = await load([(api) => void (late = api)]);
    expect(() => late.workspaces({ list: () => [] })).toThrow(/while register/);
    reg.dispose!();
    await expect(load([(api) => (api.workspaces({ list: () => [] }), api.workspaces({ list: () => [] }))])).rejects.toThrow(/once/);
    expect(workspacesOf(ANN)).toEqual(["default"]); // the failed load removed its supplier
  });
});
