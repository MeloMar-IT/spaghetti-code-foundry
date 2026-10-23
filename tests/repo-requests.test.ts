import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, Scope, StepResult } from "../src/engine/execute.js";
import { applyRepoRequests, drainRepoRequests, grantFor, repoRequestsEnv, repoRequestsFile, type RepoRequestsContext } from "../src/engine/repo-requests.js";
import type { BrokerResult } from "../src/engine/repo-broker.js";
import { parseFlow } from "../src/flow/load.js";
import { stepRepoOps, type ClaudeStep } from "../src/flow/schema.js";
import { buildClaudeArgs } from "../src/steps/claude.js";
import { buildCodexArgs } from "../src/steps/codex.js";
import { legacyToolProfile } from "../src/tool-profile/legacy.js";
import type { ToolProfile } from "../src/tool-profile/schema.js";

let runDir: string;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "repo-requests-"));
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

const flow = (steps: string) => `name: t\nsteps:\n${steps}`;
const claude = (extra: string) => flow(`  - {id: a, type: claude, prompt: x${extra}}`);

describe("repo_ops in a flow", () => {
  it("accepts a list of known operations", () => {
    expect(parseFlow(claude(", repo_ops: [commit, push]")).steps[0]).toMatchObject({ repo_ops: ["commit", "push"] });
  });
  it("refuses an empty list, a duplicate and an unknown name", () => {
    expect(() => parseFlow(claude(", repo_ops: []"))).toThrow(/repo_ops/);
    expect(() => parseFlow(claude(", repo_ops: [commit, commit]"))).toThrow(/twice/);
    expect(() => parseFlow(claude(", repo_ops: [merge]"))).toThrow(/repo_ops/);
  });
  it("refuses repo_ops on a shell step", () => {
    expect(() => parseFlow(flow("  - {id: a, type: shell, run: x, repo_ops: [commit]}"))).toThrow(/repo_ops/);
  });
  it("refuses repo_ops on a reviewer step", () => {
    expect(() => parseFlow(claude(", skill_role: reviewer, permission_mode: plan, repo_ops: [status]"))).toThrow(/reviewer step cannot have repo_ops/);
    expect(stepRepoOps({ repo_ops: ["status"], skill_role: "reviewer" })).toBeUndefined();
    expect(stepRepoOps({ repo_ops: ["status"] })).toEqual(["status"]);
  });
  it("refuses a step with repo_ops in a parallel step", () => {
    const text = flow("  - {id: p, type: parallel, steps: [a, b]}\n  - {id: a, type: claude, prompt: x, repo_ops: [status]}\n  - {id: b, type: shell, run: x}");
    expect(() => parseFlow(text)).toThrow(/has repo_ops, so it cannot be listed in a parallel step/);
  });
});

const step = (over: Partial<ClaudeStep> = {}): ClaudeStep => ({ id: "a", type: "claude", prompt: "x", repo_ops: ["commit", "status", "push"], ...over }) as ClaudeStep;
const scope = (visits: Record<string, number> = { a: 1 }): Scope => ({ prefix: "", visits }) as unknown as Scope;

describe("repoRequestsFile and repoRequestsEnv", () => {
  it("names the file after the step and the visit", () => {
    expect(repoRequestsFile("/r", "build/fix", 2)).toBe("/r/repo-requests/build_fix-2.jsonl");
  });

  it("makes the folder, removes an old file and sets both names", () => {
    const engine = { summary: { runDir } };
    const file = repoRequestsFile(runDir, "a", 1);
    mkdirSync(join(runDir, "repo-requests"));
    writeFileSync(file, "old\n");
    const env = repoRequestsEnv(engine, scope(), step());
    expect(env).toEqual({ FACTORY_REPO_REQUESTS: file, SCF_REPO_REQUESTS: file });
    expect(existsSync(file)).toBe(false);
    expect(statSync(join(runDir, "repo-requests")).mode & 0o777).toBe(0o700);
    mkdirSync(file); // a folder left at the path
    repoRequestsEnv(engine, scope(), step());
    expect(existsSync(file)).toBe(false);
  });

  it("replaces a link for the folder and leaves its target alone", () => {
    const outside = mkdtempSync(join(tmpdir(), "repo-requests-out-"));
    try {
      writeFileSync(join(outside, "a-1.jsonl"), "keep\n");
      symlinkSync(outside, join(runDir, "repo-requests"));
      repoRequestsEnv({ summary: { runDir } }, scope(), step());
      expect(statSync(join(runDir, "repo-requests")).isDirectory()).toBe(true);
      expect(readFileSync(join(outside, "a-1.jsonl"), "utf8")).toBe("keep\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("gives a step without repo_ops no names and leaves a file at the path", () => {
    const file = repoRequestsFile(runDir, "a", 1);
    mkdirSync(join(runDir, "repo-requests"));
    writeFileSync(file, "planted\n");
    expect(repoRequestsEnv({ summary: { runDir } }, scope(), step({ repo_ops: undefined }))).toEqual({ FACTORY_REPO_REQUESTS: undefined, SCF_REPO_REQUESTS: undefined });
    expect(existsSync(file)).toBe(true);
    expect(repoRequestsEnv({ summary: { runDir } }, scope(), step({ skill_role: "reviewer" })).FACTORY_REPO_REQUESTS).toBeUndefined();
  });
});

describe("drainRepoRequests", () => {
  const dir = () => join(runDir, "repo-requests");
  const file = () => repoRequestsFile(runDir, "a", 1);
  const setup = (content: string | Buffer) => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(file(), content);
  };

  it("gives no lines for a missing file or folder", () => {
    expect(drainRepoRequests(runDir, file())).toEqual({ lines: [] });
    mkdirSync(dir());
    expect(drainRepoRequests(runDir, file())).toEqual({ lines: [] });
  });

  it("skips blank lines and removes the file", () => {
    setup('{"op":"status"}\n\n  \n{"op":"clone"}\n');
    expect(drainRepoRequests(runDir, file())).toEqual({ lines: ['{"op":"status"}', '{"op":"clone"}'] });
    expect(existsSync(file())).toBe(false);
  });

  it("refuses a link to a file and leaves the target", () => {
    const outside = join(runDir, "secret.txt");
    writeFileSync(outside, "secret\n");
    mkdirSync(dir());
    symlinkSync(outside, file());
    expect(drainRepoRequests(runDir, file())).toEqual({ problem: "not-a-file" });
    expect(readFileSync(outside, "utf8")).toBe("secret\n");
    expect(existsSync(file())).toBe(false);
  });

  it("reads nothing and removes nothing when the folder is a link", () => {
    const outside = mkdtempSync(join(tmpdir(), "repo-requests-out-"));
    try {
      writeFileSync(join(outside, "a-1.jsonl"), '{"op":"status"}\n');
      symlinkSync(outside, dir());
      expect(drainRepoRequests(runDir, file())).toEqual({ problem: "not-a-file" });
      expect(readFileSync(join(outside, "a-1.jsonl"), "utf8")).toBe('{"op":"status"}\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting", () => {
    mkdirSync(dir());
    execFileSync("mkfifo", [file()]);
    expect(drainRepoRequests(runDir, file())).toEqual({ problem: "not-a-file" });
  });

  it("refuses a folder", () => {
    mkdirSync(file(), { recursive: true });
    expect(drainRepoRequests(runDir, file())).toEqual({ problem: "not-a-file" });
  });

  it("limits the size and the number of requests", () => {
    setup(Buffer.alloc(64 * 1024 + 1, "x"));
    expect(drainRepoRequests(runDir, file())).toEqual({ problem: "too-large" });
    expect(existsSync(file())).toBe(false);
    setup(Array.from({ length: 20 }, () => '{"op":"status"}').join("\n"));
    expect(drainRepoRequests(runDir, file())).toMatchObject({ lines: expect.any(Array) });
    setup(Array.from({ length: 21 }, () => '{"op":"status"}').join("\n"));
    expect(drainRepoRequests(runDir, file())).toEqual({ problem: "too-many" });
  });
});

describe("applyRepoRequests", () => {
  const OK: StepResult = { ok: true, output: "agent said hi" };
  const profileOf = (ops: ClaudeStep["repo_ops"]) => legacyToolProfile({ permissionMode: "acceptEdits", allowedTools: [], sandbox: false, boxed: false, noTools: false, mcpServers: false, credential: "machine", repoOps: ops }).profile;
  const file = () => repoRequestsFile(runDir, "a", 1);
  const put = (...lines: string[]) => {
    mkdirSync(join(runDir, "repo-requests"), { recursive: true });
    writeFileSync(file(), lines.join("\n") + "\n");
  };

  function rig(results: BrokerResult[], s: ClaudeStep = step(), signal?: AbortSignal) {
    const logs: string[] = [];
    const calls: { request: unknown; grant: unknown }[] = [];
    let i = 0;
    const ctx: RepoRequestsContext = {
      engine: { summary: { runDir }, log: (m: string) => logs.push(m), signal } as unknown as Engine,
      scope: scope(),
      step: s,
      identity: { id: "a", visit: 1, type: "claude" } as RepoRequestsContext["identity"],
      logFile: join(runDir, "live.log"),
      profile: profileOf(s.repo_ops),
      broker: async (_c, request, grant) => {
        calls.push({ request, grant });
        return results[i++] ?? { outcome: "done", output: "" };
      },
    };
    return { ctx, logs, calls };
  }
  const done = (output = ""): BrokerResult => ({ outcome: "done", output });

  it("carries out requests in order and adds the section", async () => {
    put('{"op":"commit","message":"m"}', '{"op":"status"}');
    const { ctx, calls, logs } = rig([done("committed"), done("clean")]);
    const res = await applyRepoRequests(ctx, OK);
    expect(res.ok).toBe(true);
    expect(calls.map((c) => (c.request as { op: string }).op)).toEqual(["commit", "status"]);
    expect(res.output).toMatch(/^agent said hi\n\n## Repository operations\n- commit: done\n {4}committed\n- status: done\n {4}clean\n$/);
    expect(logs).toContain("    · repo commit: done");
    expect(existsSync(file())).toBe(false);
  });

  it("stops at the first request that is not done", async () => {
    put('{"op":"commit","message":"m"}', '{"op":"push","branch":"b"}', '{"op":"status"}');
    const { ctx, calls, logs } = rig([done(), { outcome: "refused", refusal: "not-in-profile", output: "no" }]);
    const res = await applyRepoRequests(ctx, OK);
    expect(calls).toHaveLength(2);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("repository operation push refused: not-in-profile");
    expect(logs).toContain("    · repo push: refused (not-in-profile)");
    expect(logs).toContain("    · repo: 1 later request(s) were not carried out");
    expect(res.output).toContain("- 1 later request(s) were not carried out");
  });

  it("uses the text of a policy denial as the error, and the first line of a failure as the reason", async () => {
    put('{"op":"fetch"}');
    const denied = await applyRepoRequests(rig([{ outcome: "refused", refusal: "policy", output: "denied by policy" }], step({ repo_ops: ["fetch"] })).ctx, OK);
    expect(denied.error).toBe("denied by policy");
    put('{"op":"status"}');
    const failed = await applyRepoRequests(rig([{ outcome: "failed", output: "\nboom\nmore" }]).ctx, OK);
    expect(failed.error).toBe("repository operation status failed: boom");
  });

  it("sends a line that is not JSON as null, and an operation that is not listed with no grant", async () => {
    put("not json", '{"op":"clone"}', '{"op":"commit","message":"m"}');
    const { ctx, calls } = rig([done(), done(), done()], step({ repo_ops: ["commit"] }));
    await applyRepoRequests(ctx, OK);
    expect(calls[0]).toEqual({ request: null, grant: undefined });
    expect(calls[1]!.grant).toBeUndefined();
    expect(calls[2]!.grant).toMatchObject({ kind: "git" });
  });

  it("checks pass_if and fail_if on the agent output before any request", async () => {
    for (const s of [step({ fail_if: "agent" }), step({ pass_if: "^nope$" }), step({ pass_if: "commit: done" })]) {
      put('{"op":"commit","message":"m"}');
      const { ctx, calls } = rig([done()], s);
      const res = await applyRepoRequests(ctx, OK);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/fail_if|pass_if/);
      expect(calls).toHaveLength(0);
      expect(existsSync(file())).toBe(false);
    }
  });

  it("carries out nothing when the step failed or the run is cancelled", async () => {
    put('{"op":"status"}');
    const a = rig([done()]);
    const failed = await applyRepoRequests(a.ctx, { ok: false, output: "", error: "bad" });
    expect(failed.error).toBe("bad");
    expect(a.calls).toHaveLength(0);
    expect(a.logs).toContain("    · repo: 1 request(s) not carried out: the step did not succeed");
    expect(existsSync(file())).toBe(false);
    put('{"op":"status"}');
    const ac = new AbortController();
    ac.abort();
    const b = rig([done()], step(), ac.signal);
    await applyRepoRequests(b.ctx, OK);
    expect(b.calls).toHaveLength(0);
  });

  it("fails the step on a file that is over a limit", async () => {
    put(...Array.from({ length: 21 }, () => '{"op":"status"}'));
    const { ctx, calls } = rig([]);
    const res = await applyRepoRequests(ctx, OK);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/more than 20 requests/);
    expect(calls).toHaveLength(0);
  });

  it("returns the result as it is for a step without repo_ops", async () => {
    put('{"op":"status"}');
    const { ctx, calls } = rig([], step({ repo_ops: undefined, fail_if: "agent" }));
    expect(await applyRepoRequests(ctx, OK)).toBe(OK);
    expect(calls).toHaveLength(0);
    expect(existsSync(file())).toBe(true);
  });
});

describe("grantFor", () => {
  const profile = (grants: unknown[]) => ({ grants }) as unknown as ToolProfile;
  const git = { kind: "git", operations: ["status", "push"], targets: ["acme/app"] };
  it("returns the grant that names the operation, or nothing", () => {
    const p = profile([git, { kind: "github", operations: ["pull-request.write"], targets: ["*"] }]);
    expect(grantFor(p, "push")).toBe(git);
    expect(grantFor(p, "pull-request")).toMatchObject({ kind: "github" });
    expect(grantFor(p, "commit")).toBeUndefined();
  });
});

describe("buildClaudeArgs writable dirs", () => {
  const o = { prompt: "p", cwd: "/w", logFile: "/l", writableDirs: ["/r/repo-requests"] };
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]!);
  it("adds the request folder to the agent's folders and to its bash sandbox", () => {
    const args = buildClaudeArgs({ ...o, sandbox: true });
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/r/repo-requests");
    expect(settingsOf(args).sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: ["/r/repo-requests"] } });
  });
  it("adds only the folder without the sandbox, and nothing without writable dirs", () => {
    const args = buildClaudeArgs(o);
    expect(args).toContain("--add-dir");
    expect(args).not.toContain("--settings");
    expect(buildClaudeArgs({ prompt: "p", cwd: "/w", logFile: "/l", sandbox: true })).not.toContain("--add-dir");
  });
});

describe("buildCodexArgs writable roots", () => {
  const base = { sandbox: "workspace-write" } as Parameters<typeof buildCodexArgs>[0];
  it("adds the request folder to workspace-write only", () => {
    expect(buildCodexArgs({ ...base, writableRoots: ["/r/repo-requests"] })).toContain('sandbox_workspace_write.writable_roots=["/r/repo-requests"]');
    expect(buildCodexArgs({ ...base, sandbox: "read-only", writableRoots: ["/r"] }).join(" ")).not.toContain("writable_roots");
    expect(buildCodexArgs(base).join(" ")).not.toContain("writable_roots");
  });
});
