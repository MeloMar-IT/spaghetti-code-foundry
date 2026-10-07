import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoError, parseRepoUrl } from "../src/auth/repo-url.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { INPLACE_REFUSED, WORKTREE_REFUSED, userAccount, workspaceRefused } from "../src/engine/isolation.js";
import { learningsFile, resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { serveStatic } from "../src/server/http.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let ann: { id: string };
let bob: { id: string };
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.FACTORY_HOME;
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  ann = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "user" });
  bob = await createUser({ name: "Bob", email: "bob@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  kc.remove();
  gh.restore();
});

const runsDir = () => join(gh.tmp, "runs");
const config = () => ConfigSchema.parse({ protected_branches: [] });
const go = (flow: ReturnType<typeof parseFlow>, extra: { owner?: string; vars?: Record<string, string>; repo?: string } = {}) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runsDir(), claudeBin, config: config(), ...extra });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const readRun = (id: string) => JSON.parse(readFileSync(join(runsDir(), id, "run.json"), "utf8"));

describe("schema", () => {
  const flow = (run: string, inputs = true) =>
    `name: t\nvars: { who: x }\n${inputs ? "publish: { enabled: true, vars: { who: { mode: input } } }\n" : ""}steps:\n  - { id: a, type: shell, run: ${JSON.stringify(run)} }\n`;

  it("refuses bare {{vars}} in a shell step when users fill in an input", () => {
    expect(() => parseFlow(flow("echo {{vars}}"))).toThrow(/FACTORY_VAR_/);
    expect(() => parseFlow(flow("echo {{ vars }}"))).toThrow(/FACTORY_VAR_/);
  });

  it("allows it without an input", () => {
    expect(() => parseFlow(flow("echo {{vars}}", false))).not.toThrow();
    expect(() => parseFlow(flow("echo {{ vars }}", false))).not.toThrow();
  });

  it("refuses agent_env as an input; fixed and hidden are fine", () => {
    const f = (mode: string) => `name: t\nvars: { agent_env: "A=1" }\npublish: { enabled: true, vars: { agent_env: { mode: ${mode} } } }\nsteps:\n  - { id: a, type: shell, run: "true" }\n`;
    expect(() => parseFlow(f("input"))).toThrow(/agent_env/);
    expect(() => parseFlow(f("fixed"))).not.toThrow();
    expect(() => parseFlow(f("hidden"))).not.toThrow();
  });
});

describe("serveStatic", () => {
  it("refuses a sibling folder whose name starts with the root's", () => {
    const base = mkdtempSync(join(tmpdir(), "static-"));
    try {
      mkdirSync(join(base, "ui"));
      mkdirSync(join(base, "ui-old"));
      writeFileSync(join(base, "ui", "index.html"), "<p>hi</p>");
      writeFileSync(join(base, "ui-old", "secret.txt"), "secret");
      const call = (rel: string) => {
        let status = 0;
        const res = { writeHead: (s: number) => ((status = s), res), end: () => res } as unknown as ServerResponse;
        serveStatic(res, join(base, "ui"), rel);
        return status;
      };
      expect(call("../ui-old/secret.txt")).toBe(404);
      expect(call("index.html")).toBe(200);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("parseRepoUrl", () => {
  it("refuses a user name that starts with - or .", () => {
    for (const url of ["ssh://-oProxyCommand@host/a/b", "ssh://.x@host/a/b"]) {
      try {
        parseRepoUrl(url);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(RepoError);
        expect((e as RepoError).code).toBe("bad-url");
      }
    }
    expect(() => parseRepoUrl("ssh://git@host/a/b")).not.toThrow();
    expect(() => parseRepoUrl("ssh://_x@host/a/b")).not.toThrow();
  });
});

describe("userAccount", () => {
  it("is the id for a user, nothing for an admin or no owner, and fails closed", () => {
    expect(userAccount(ann.id)).toBe(ann.id);
    expect(userAccount("no-such-id")).toBe("no-such-id");
    expect(userAccount(admin.id)).toBeUndefined();
    expect(userAccount(undefined)).toBeUndefined();
    writeFileSync(join(process.env.FACTORY_HOME!, "users.json"), "{broken");
    expect(userAccount(admin.id)).toBe(admin.id);
  });
});

describe("learningsFile", () => {
  it("has its own file for an account without a repository", () => {
    expect(learningsFile({}, "/x/repo", "u1").endsWith("repo__u1.md")).toBe(true);
    expect(learningsFile({ github_repo: "owner/repo" }, "/x/repo", "u1").endsWith("repo__u1.md")).toBe(true);
    expect(learningsFile({ github_repo: "acme/app" }, "/x/repo", "u1")).toBe(learningsFile({ github_repo: "acme/app" }, "/x/repo"));
    const odd = learningsFile({}, "/x/repo", "../x").replace(/^.*learnings\//, "");
    expect(odd).not.toContain("/");
  });
});

describe("learnings of two users", () => {
  const writer = parseFlow(`name: w\nworkspace: empty\nsteps:\n  - id: a\n    type: shell\n    run: 'mkdir -p "$(dirname "$FACTORY_LEARNINGS_FILE")"; echo SENTINEL_A >> "$FACTORY_LEARNINGS_FILE"'\n`);
  const reader = parseFlow(`name: r\nworkspace: empty\nsteps:\n  - { id: a, type: claude, prompt: "Known: {{learnings}}" }\n`);

  it("keeps a user's learnings out of another user's prompt", async () => {
    await go(writer, { owner: ann.id });
    expect(out(await go(reader, { owner: bob.id }), "a")).not.toContain("SENTINEL_A");
    expect(out(await go(reader, { owner: ann.id }), "a")).toContain("SENTINEL_A");
  });

  it("keeps the old shared file for an admin", async () => {
    const lf = learningsFile({}, gh.tmp);
    mkdirSync(join(lf, ".."), { recursive: true });
    writeFileSync(lf, "SHARED_TEXT\n");
    await go(writer, { owner: ann.id });
    const s = await go(reader, { owner: admin.id });
    expect(out(s, "a")).toContain("SHARED_TEXT");
    expect(out(s, "a")).not.toContain("SENTINEL_A");
  });

  it("keeps the repository's file for a run with github_repo", async () => {
    const show = parseFlow(`name: s\nworkspace: empty\nsteps:\n  - { id: a, type: shell, run: 'echo "$FACTORY_LEARNINGS_FILE"' }\n`);
    const s = await go(show, { owner: ann.id, vars: { github_repo: "acme/app" } });
    expect(out(s, "a")).toBe(learningsFile({ github_repo: "acme/app" }, gh.tmp));
  });
});

describe("a user's run in the server's folder", () => {
  const marker = () => join(gh.tmp, "marker");
  const inplace = () => parseFlow(`name: ip\nworkspace: inplace\nsteps:\n  - id: gate\n    type: approval\n    message: ok\n  - { id: mark, type: shell, run: "touch '${marker()}'" }\n`);

  it("never runs a step for a new run", async () => {
    const s = await go(parseFlow(`name: ip\nworkspace: inplace\nsteps:\n  - { id: mark, type: shell, run: "touch '${marker()}'" }\n`), { owner: ann.id });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(INPLACE_REFUSED);
    expect(s.history).toEqual([]);
    expect(existsSync(marker())).toBe(false);
  });

  /** A run of an admin that waits at the gate, then handed to a user. */
  async function handed(stopped: boolean): Promise<string> {
    const s = await go(inplace(), { owner: admin.id });
    expect(s.status).toBe("waiting");
    const file = join(runsDir(), s.runId, "run.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.owner = ann.id;
    if (stopped) {
      j.status = "stopped";
      delete j.waiting;
    }
    writeFileSync(file, JSON.stringify(j));
    return s.runId;
  }
  const refused = (runId: string, history: number) => {
    const j = readRun(runId);
    expect(j.status).toBe("failed");
    expect(j.reason).toBe(INPLACE_REFUSED);
    expect(j.history.length).toBe(history);
    expect(existsSync(marker())).toBe(false);
  };

  it("resume", async () => {
    const id = await handed(true);
    const before = readRun(id).history.length;
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config() });
    refused(id, before);
  });

  it("approve", async () => {
    const id = await handed(false);
    const before = readRun(id).history.length;
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config(), decision: { approved: true, by: "x" } });
    refused(id, before);
  });

  it("reject", async () => {
    const id = await handed(false);
    const before = readRun(id).history.length;
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config(), decision: { approved: false, by: "x" } });
    refused(id, before);
  });

  it("answer", async () => {
    const id = await handed(true);
    const before = readRun(id).history.length;
    const sched = new Scheduler({ runsDir: runsDir(), claudeBin, config });
    sched.answer(id, "text", "ann");
    await sched.wait(id);
    await sched.idle();
    refused(id, before);
  });

  it("a job already in the queue file", async () => {
    const queueFile = join(gh.tmp, "queue.json");
    const flow = parseFlow(`name: ip\nworkspace: inplace\nsteps:\n  - { id: mark, type: shell, run: "touch '${marker()}'" }\n`);
    const a = new Scheduler({ runsDir: runsDir(), queueFile, config: () => ({ ...config(), concurrency: 0 }) });
    const id = a.submit({ kind: "run", flow, task: "t", repo: gh.tmp, vars: {} }, { owner: ann.id });
    const b = new Scheduler({ runsDir: runsDir(), queueFile, claudeBin, config });
    await b.wait(id);
    await b.idle();
    const j = readRun(id);
    expect(j.status).toBe("failed");
    expect(j.reason).toBe(INPLACE_REFUSED);
    expect(j.history).toEqual([]);
    expect(existsSync(marker())).toBe(false);
  });
});

describe("workspaceRefused", () => {
  it("refuses inplace and worktree for users only, and fails closed", () => {
    expect(workspaceRefused("worktree", ann.id)).toBe(WORKTREE_REFUSED);
    expect(workspaceRefused("inplace", ann.id)).toBe(INPLACE_REFUSED);
    expect(workspaceRefused("empty", ann.id)).toBeUndefined();
    for (const w of ["worktree", "inplace", "empty"]) {
      expect(workspaceRefused(w, admin.id)).toBeUndefined();
      expect(workspaceRefused(w, undefined)).toBeUndefined();
    }
    expect(workspaceRefused("worktree", "no-such-id")).toBe(WORKTREE_REFUSED);
    writeFileSync(join(process.env.FACTORY_HOME!, "users.json"), "{broken");
    expect(workspaceRefused("worktree", admin.id)).toBe(WORKTREE_REFUSED);
  });
});

describe("a user's run in a branch of the server's folder", () => {
  const marker = () => join(gh.tmp, "marker");
  const seed = () => join(gh.tmp, "seed");
  const flowOf = (gate: boolean) =>
    parseFlow(`name: wt\nworkspace: worktree\nsteps:\n${gate ? "  - id: gate\n    type: approval\n    message: ok\n" : ""}  - { id: mark, type: shell, run: "touch '${marker()}'" }\n`);
  const git = (...a: string[]) => execFileSync("git", ["-C", seed(), ...a], { encoding: "utf8" });

  it("never runs a step or makes a worktree for a new run", async () => {
    const s = await go(flowOf(false), { owner: ann.id, repo: seed() });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(WORKTREE_REFUSED);
    expect(s.history).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(s.workdir).toBeUndefined();
    expect(s.branch).toBeUndefined();
    expect(existsSync(join(s.runDir, "workspace"))).toBe(false);
    expect(git("branch", "--list", "factory/*").trim()).toBe("");
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("reads nothing from the folder", async () => {
    mkdirSync(join(seed(), ".claude-factory"), { recursive: true });
    writeFileSync(join(seed(), ".claude-factory", "config.yaml"), "vars:\n  from_folder: x\n");
    const s = await go(flowOf(false), { owner: ann.id, repo: seed() });
    expect(s.vars.from_folder).toBeUndefined();
    expect(readRun(s.runId).vars.from_folder).toBeUndefined();
    const ip = await go(parseFlow(`name: ip\nworkspace: inplace\nsteps:\n  - { id: mark, type: shell, run: "true" }\n`), { owner: ann.id, repo: seed() });
    expect(ip.vars.from_folder).toBeUndefined();
    const a = await go(flowOf(false), { owner: admin.id, repo: seed() });
    expect(a.vars.from_folder).toBe("x");
  });

  it("an admin's run still works", async () => {
    const s = await go(flowOf(false), { owner: admin.id, repo: seed() });
    expect(s.status).toBe("succeeded");
    expect(s.branch).toMatch(/^factory\//);
    expect(existsSync(marker())).toBe(true);
  });

  /** A run of an admin that waits at the gate, then handed to a user. */
  async function handed(stopped: boolean): Promise<string> {
    const s = await go(flowOf(true), { owner: admin.id, repo: seed() });
    expect(s.status).toBe("waiting");
    const file = join(runsDir(), s.runId, "run.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.owner = ann.id;
    if (stopped) {
      j.status = "stopped";
      delete j.waiting;
    }
    writeFileSync(file, JSON.stringify(j));
    return s.runId;
  }
  const refused = (runId: string, history: number) => {
    const j = readRun(runId);
    expect(j.status).toBe("failed");
    expect(j.reason).toBe(WORKTREE_REFUSED);
    expect(j.history.length).toBe(history);
    expect(existsSync(marker())).toBe(false);
  };

  it("a run without an owner is not refused", async () => {
    const id = await handed(false);
    const file = join(runsDir(), id, "run.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    delete j.owner;
    writeFileSync(file, JSON.stringify(j));
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config(), decision: { approved: true, by: "x" } });
    expect(readRun(id).status).toBe("succeeded");
  });

  it("resume", async () => {
    const id = await handed(true);
    const before = readRun(id).history.length;
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config() });
    refused(id, before);
  });

  it("approve", async () => {
    const id = await handed(false);
    const before = readRun(id).history.length;
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config(), decision: { approved: true, by: "x" } });
    refused(id, before);
  });

  it("reject", async () => {
    const id = await handed(false);
    const before = readRun(id).history.length;
    await resumeRun({ runsDir: runsDir(), runId: id, claudeBin, config: config(), decision: { approved: false, by: "x" } });
    refused(id, before);
  });

  it("answer", async () => {
    const id = await handed(true);
    const before = readRun(id).history.length;
    const sched = new Scheduler({ runsDir: runsDir(), claudeBin, config });
    sched.answer(id, "text", "ann");
    await sched.wait(id);
    await sched.idle();
    refused(id, before);
  });

  it("a job already in the queue file", async () => {
    const queueFile = join(gh.tmp, "queue.json");
    const a = new Scheduler({ runsDir: runsDir(), queueFile, config: () => ({ ...config(), concurrency: 0 }) });
    const id = a.submit({ kind: "run", flow: flowOf(false), task: "t", repo: seed(), vars: {} }, { owner: ann.id });
    const b = new Scheduler({ runsDir: runsDir(), queueFile, claudeBin, config });
    await b.wait(id);
    await b.idle();
    const j = readRun(id);
    expect(j.status).toBe("failed");
    expect(j.reason).toBe(WORKTREE_REFUSED);
    expect(j.history).toEqual([]);
    expect(git("branch", "--list", "factory/*").trim()).toBe("");
  });
});
