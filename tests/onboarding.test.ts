import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTool, startSignIn, stopSignIns, testCall, type OnboardingTool } from "../src/onboarding.js";
import type { SetupReport } from "../src/setup-check.js";

const CLAUDE = resolve("tests/fixtures/fake-claude.mjs");
const CODEX = resolve("tests/fixtures/fake-codex.mjs");
const VARS = ["FAKE_CLAUDE_AUTH_FILE", "FAKE_CODEX_AUTH_FILE", "FAKE_CLAUDE_NO_AUTH_CMD", "FAKE_CLAUDE_LOGIN_FAIL", "FAKE_CLAUDE_LOGIN_HANG", "FAKE_CLAUDE_CALL_FAIL", "FAKE_CODEX_CALL_FAIL", "FAKE_CLAUDE_ARGS_FILE", "FAKE_CODEX_ARGS_FILE"];
const LEAKS = ["ok args=", "Login successful", "Successfully logged in", "401", "codex ok", "PROMPT<<"];

let dir: string;
let claudeAuth: string;
let codexAuth: string;
const onboardingDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("factory-onboarding-")).sort();
let before: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "onboarding-test-"));
  claudeAuth = join(dir, "claude-auth");
  codexAuth = join(dir, "codex-auth");
  process.env.FAKE_CLAUDE_AUTH_FILE = claudeAuth;
  process.env.FAKE_CODEX_AUTH_FILE = codexAuth;
  before = onboardingDirs();
});
afterEach(() => {
  for (const v of VARS) delete process.env[v];
  rmSync(dir, { recursive: true, force: true });
});

const noLeak = (answer: unknown) => {
  const s = JSON.stringify(answer);
  for (const l of LEAKS) expect(s).not.toContain(l);
};

/** A child that never ends until the test says so. */
function stub() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  return child;
}

describe("parseTool", () => {
  it("accepts claude and codex only", () => {
    expect(parseTool("claude")).toBe("claude");
    expect(parseTool("codex")).toBe("codex");
    for (const bad of [undefined, "", "gh", "claude; rm -rf /", "Claude", 3, ["claude"]]) expect(() => parseTool(bad)).toThrow("tool must be one of: claude, codex");
  });
});

describe("startSignIn", () => {
  it.each(["claude", "codex"] as const)("signs in %s, then the test call works", async (tool) => {
    const o = { claudeBin: CLAUDE, codexBin: CODEX, startWaitMs: 20_000 };
    const auth = tool === "claude" ? claudeAuth : codexAuth;
    expect((await testCall(tool, o)).state).toBe("signed-out");
    const a = await startSignIn(tool, o);
    expect(a.state).toBe("done");
    expect(a.explain).toContain("the computer that runs the Foundry");
    expect(existsSync(auth)).toBe(true);
    const t = await testCall(tool, o);
    expect(t.state).toBe("ok");
    noLeak([a, t]);
    expect(onboardingDirs()).toEqual(before);
  });

  it("answers missing for a program that is not there", async () => {
    for (const tool of ["claude", "codex"] as OnboardingTool[]) {
      const a = await startSignIn(tool, { claudeBin: join(dir, "nope"), codexBin: join(dir, "nope") });
      expect(a.state).toBe("missing");
    }
  });

  it("does not run auth login on a Claude without auth", async () => {
    process.env.FAKE_CLAUDE_NO_AUTH_CMD = "1";
    const a = await startSignIn("claude", { claudeBin: CLAUDE });
    expect(a.state).toBe("failed");
    expect(a.explain).toContain("Update Claude Code");
    expect(existsSync(claudeAuth)).toBe(false);
  });

  it("answers failed when the sign-in ends with an error", async () => {
    process.env.FAKE_CLAUDE_LOGIN_FAIL = "1";
    const a = await startSignIn("claude", { claudeBin: CLAUDE, startWaitMs: 20_000 });
    expect(a.state).toBe("failed");
    noLeak(a);
  });

  it("answers started while it runs, and starts nothing twice", async () => {
    const spawns: string[][] = [];
    const kids: ReturnType<typeof stub>[] = [];
    const spawnFn = ((_c: string, args: string[]) => {
      spawns.push(args);
      const k = stub();
      kids.push(k);
      return k;
    }) as unknown as typeof spawn;
    const o = { claudeBin: "x", codexBin: "x", spawnFn, startWaitMs: 0 };
    const a = await startSignIn("codex", o);
    expect(a.state).toBe("started");
    expect(a.explain).toContain("the computer that runs the Foundry");
    const b = await startSignIn("codex", o);
    expect(b.state).toBe("started");
    expect(b.explain).toContain("already open");
    expect(spawns).toEqual([["login"]]);
    kids[0]!.emit("close", 0);
    const c = await startSignIn("codex", o);
    expect(c.state).toBe("started");
    expect(spawns).toEqual([["login"], ["login"]]);
    kids[1]!.emit("close", 0);
  });

  it("takes the slot before the help probe answers", async () => {
    const spawns: string[][] = [];
    const kids: ReturnType<typeof stub>[] = [];
    let loginSpawned!: () => void;
    const seen = new Promise<void>((r) => (loginSpawned = r));
    const spawnFn = ((_c: string, args: string[]) => {
      spawns.push(args);
      const k = stub();
      kids.push(k);
      if (args[0] === "auth") loginSpawned();
      return k;
    }) as unknown as typeof spawn;
    const o = { claudeBin: "x", spawnFn, startWaitMs: 0 };
    const first = startSignIn("claude", o);
    const second = startSignIn("claude", o);
    expect((await second).explain).toContain("already open");
    kids[0]!.stdout.emit("data", "Commands:\n  auth  Manage\n");
    kids[0]!.emit("close", 0);
    await seen;
    expect((await first).state).toBe("started");
    expect(spawns).toEqual([["--help"], ["auth", "login"]]);
    kids[1]!.emit("close", 0);
  });

  it("keeps the slot until the child has closed, also after SIGTERM", async () => {
    const kids: ReturnType<typeof stub>[] = [];
    let termed!: () => void;
    const gotTerm = new Promise<void>((r) => (termed = r));
    const spawnFn = (() => {
      const k = stub();
      k.kill.mockImplementation(() => (termed(), true));
      kids.push(k);
      return k;
    }) as unknown as typeof spawn;
    const o = { codexBin: "x", spawnFn, startWaitMs: 0, limitMs: 10, graceMs: 60_000 };
    await startSignIn("codex", o);
    await gotTerm;
    expect(kids[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect((await startSignIn("codex", o)).explain).toContain("already open");
    expect(kids).toHaveLength(1);
    kids[0]!.emit("close", null);
    await startSignIn("codex", { ...o, limitMs: 60_000 });
    expect(kids).toHaveLength(2);
    kids[1]!.emit("close", 0);
  });

  it("stopSignIns ends a sign-in that ignores SIGTERM", async () => {
    process.env.FAKE_CLAUDE_LOGIN_HANG = "1";
    let child!: ChildProcess;
    const spawnFn = ((c: string, a: string[], opts: object) => (child = spawn(c, a, opts))) as typeof spawn;
    const a = await startSignIn("claude", { claudeBin: CLAUDE, spawnFn, startWaitMs: 300 });
    expect(a.state).toBe("started");
    const closed = once(child, "close");
    stopSignIns(100);
    const [code, signal] = await closed;
    expect(code === null ? signal : code).toBe("SIGKILL");
  });

  it("stops a sign-in whose help probe is still pending, and starts no login", async () => {
    const spawns: string[][] = [];
    const kids: ReturnType<typeof stub>[] = [];
    let helpStarted!: () => void;
    const seen = new Promise<void>((r) => (helpStarted = r));
    const spawnFn = ((_c: string, args: string[]) => {
      spawns.push(args);
      const k = stub();
      kids.push(k);
      helpStarted();
      return k;
    }) as unknown as typeof spawn;
    const answer = startSignIn("claude", { claudeBin: "x", spawnFn, startWaitMs: 0 });
    await seen;
    stopSignIns(60_000);
    expect(kids[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    kids[0]!.emit("close", null);
    const a = await answer;
    expect(a.state).toBe("failed");
    expect(spawns).toEqual([["--help"]]);
  });
});

describe("testCall", () => {
  it("answers missing without a call", async () => {
    for (const tool of ["claude", "codex"] as OnboardingTool[]) {
      const t = await testCall(tool, { claudeBin: join(dir, "nope"), codexBin: join(dir, "nope") });
      expect(t.state).toBe("missing");
    }
  });

  it("answers signed-out when the call is refused although the check says ok", async () => {
    const check = async () => ({ items: [] }) as unknown as SetupReport;
    for (const tool of ["claude", "codex"] as OnboardingTool[]) {
      const t = await testCall(tool, { claudeBin: CLAUDE, codexBin: CODEX, check });
      expect(t.state).toBe("signed-out");
      noLeak(t);
    }
    expect(onboardingDirs()).toEqual(before);
  });

  it("answers failed for any other failure", async () => {
    await startSignIn("claude", { claudeBin: CLAUDE, startWaitMs: 20_000 });
    await startSignIn("codex", { codexBin: CODEX, startWaitMs: 20_000 });
    process.env.FAKE_CLAUDE_CALL_FAIL = "1";
    process.env.FAKE_CODEX_CALL_FAIL = "1";
    for (const tool of ["claude", "codex"] as OnboardingTool[]) {
      const t = await testCall(tool, { claudeBin: CLAUDE, codexBin: CODEX });
      expect(t.state).toBe("failed");
      noLeak(t);
    }
    expect(onboardingDirs()).toEqual(before);
  });

  it("makes the call without tools and personal setup", async () => {
    const claudeArgs = join(dir, "claude-args");
    const codexArgs = join(dir, "codex-args");
    process.env.FAKE_CLAUDE_ARGS_FILE = claudeArgs;
    process.env.FAKE_CODEX_ARGS_FILE = codexArgs;
    await startSignIn("claude", { claudeBin: CLAUDE, startWaitMs: 20_000 });
    await startSignIn("codex", { codexBin: CODEX, startWaitMs: 20_000 });
    expect((await testCall("claude", { claudeBin: CLAUDE, codexBin: CODEX })).state).toBe("ok");
    expect((await testCall("codex", { claudeBin: CLAUDE, codexBin: CODEX })).state).toBe("ok");
    const claude = JSON.parse(readFileSync(claudeArgs, "utf8").trim().split("\n").pop()!) as string[];
    expect(claude[claude.indexOf("--tools") + 1]).toBe("");
    expect(claude).toContain("--strict-mcp-config");
    expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("project,local");
    expect(claude[claude.indexOf("--model") + 1]).toBe("haiku");
    expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("plan");
    const codex = JSON.parse(readFileSync(codexArgs, "utf8").trim().split("\n").pop()!) as string[];
    for (const a of ["mcp_servers={}", "features.codex_hooks=false", "--ignore-user-config", 'sandbox_mode="read-only"', 'model_reasoning_effort="low"']) expect(codex).toContain(a);
    expect(codex).not.toContain("-m");
  });

  it("shares one call between overlapping requests", async () => {
    let checks = 0;
    const check = async () => {
      checks++;
      await new Promise((r) => setTimeout(r, 20));
      return { items: [{ id: "claude", state: "missing" }] } as unknown as SetupReport;
    };
    const [a, b] = await Promise.all([testCall("claude", { claudeBin: "x", codexBin: "y", check }), testCall("claude", { claudeBin: "x", codexBin: "y", check })]);
    expect(checks).toBe(1);
    expect(a).toBe(b);
    expect(a.state).toBe("missing");
  });
});
