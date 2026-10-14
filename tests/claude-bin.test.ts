import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Claude desktop app bundles a newer Claude Code than an old `claude` on PATH; the app has
// stored it as <version>/claude.app/… and, later, as <version>/<id>/claude.app/….
describe("finding Claude Code", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    delete process.env.FACTORY_CLAUDE_BIN;
    process.env.FACTORY_DESKTOP_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "claude-code-"));
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const fresh = () => import("../src/steps/claude.js");
  const none = async (): Promise<string> => {
    throw new Error("none");
  };
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const install = (root: string, ...path: string[]) => {
    const dir = join(root, ...path, "claude.app/Contents/MacOS");
    mkdirSync(dir, { recursive: true });
    script(join(dir, "claude"), "echo bundled");
    return join(dir, "claude");
  };
  /** A probe the test releases later. */
  const slow = () => {
    let release!: (v: string) => void;
    const probe = vi.fn(() => new Promise<string>((r) => (release = r)));
    return { probe, release: (v: string) => release(v) };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it("uses the newest bundled version, in either folder layout", async () => {
    const { resolveClaudeBinAsync } = await fresh();
    const root = process.env.FACTORY_DESKTOP_CLAUDE_DIR!;
    const flat = install(root, "999.1.1");
    expect(await resolveClaudeBinAsync(none)).toBe(flat);
    const nested = install(root, "999.1.2", "f2326db61802");
    expect(await resolveClaudeBinAsync(none)).toBe(nested);
    mkdirSync(join(root, "999.1.3", "incomplete"), { recursive: true }); // a download in progress
    expect(await resolveClaudeBinAsync(none)).toBe(nested);
  });

  it("compares the version on PATH with the bundled one", async () => {
    const bundled = install(process.env.FACTORY_DESKTOP_CLAUDE_DIR!, "5.0.0");
    const newer = await fresh();
    expect(await newer.resolveClaudeBinAsync(async () => "6.0.0 (Claude Code)")).toBe("claude");
    vi.resetModules();
    const older = await fresh();
    expect(await older.resolveClaudeBinAsync(async () => "4.9.9 (Claude Code)")).toBe(bundled);
  });

  it("shares one slow probe between callers", async () => {
    const { resolveClaudeBinAsync } = await fresh();
    const bundled = install(process.env.FACTORY_DESKTOP_CLAUDE_DIR!, "5.0.0");
    const s = slow();
    let done = 0;
    const a = resolveClaudeBinAsync(s.probe).then((v) => (done++, v));
    const b = resolveClaudeBinAsync(s.probe).then((v) => (done++, v));
    await tick();
    expect(done).toBe(0);
    expect(s.probe).toHaveBeenCalledTimes(1);
    s.release("1.0.0");
    expect(await Promise.all([a, b])).toEqual([bundled, bundled]);
    const other = vi.fn(none);
    expect(await resolveClaudeBinAsync(other)).toBe(bundled);
    expect(other).not.toHaveBeenCalled();
  });

  it("treats a failing probe as no Claude Code on PATH, and does not probe again", async () => {
    const { resolveClaudeBinAsync } = await fresh();
    const failing = vi.fn(none);
    expect(await resolveClaudeBinAsync(failing)).toBe("claude");
    expect(await resolveClaudeBinAsync(failing)).toBe("claude");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("answers FACTORY_CLAUDE_BIN without probing", async () => {
    const { resolveClaudeBinAsync } = await fresh();
    process.env.FACTORY_CLAUDE_BIN = "/x/claude";
    const probe = vi.fn(none);
    expect(await resolveClaudeBinAsync(probe)).toBe("/x/claude");
    expect(probe).not.toHaveBeenCalled();
  });

  // The providers check runs while the settings route waits for the same probe: no process of its own.
  describe.each([
    ["the bundled program wins", "1.0.0", true],
    ["claude on PATH wins", "9.0.0", false],
  ])("overlap with the providers check when %s", (_name, pathVersion, bundledWins) => {
    it("runs `claude --version` only through the shared probe", async () => {
      const bin = mkdtempSync(join(tmpdir(), "claude-path-"));
      const marker = join(bin, "ran");
      script(join(bin, "claude"), `echo ran >> "${marker}"\necho 9.0.0`);
      script(join(bin, "codex"), "echo codex 1.0.0");
      process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
      process.env.FACTORY_CODEX_BIN = join(bin, "codex");
      if (bundledWins) script(install(process.env.FACTORY_DESKTOP_CLAUDE_DIR!, "999.1.1"), "echo 999.1.1");
      const { resolveClaudeBinAsync } = await fresh();
      const { agentStatuses } = await import("../src/agents/health.js");
      const s = slow();
      let resolved: string | undefined;
      let statuses: Awaited<ReturnType<typeof agentStatuses>> | undefined;
      const a = resolveClaudeBinAsync(s.probe).then((v) => (resolved = v));
      const b = agentStatuses().then((v) => (statuses = v));
      await tick();
      expect(resolved).toBeUndefined();
      expect(statuses).toBeUndefined();
      expect(s.probe).toHaveBeenCalledTimes(1);
      expect(existsSync(marker)).toBe(false);
      s.release(pathVersion);
      await Promise.all([a, b]);
      expect(s.probe).toHaveBeenCalledTimes(1);
      expect(existsSync(marker)).toBe(false);
      const claude = statuses!.find((x) => x.agent === "claude")!;
      expect(claude.installed).toBe(true);
      if (bundledWins) {
        expect(resolved).toContain("claude.app");
        expect(claude.version).toBe("999.1.1");
      } else {
        expect(resolved).toBe("claude");
        expect(claude.version).toBe(pathVersion);
      }
    });
  });

  it("lets the providers check see Claude Code after a failed first probe", async () => {
    const bin = mkdtempSync(join(tmpdir(), "claude-path-"));
    script(join(bin, "codex"), "echo codex 1.0.0");
    process.env.FACTORY_CODEX_BIN = join(bin, "codex");
    process.env.PATH = bin; // no other claude can be found
    const { resolveClaudeBinAsync } = await fresh();
    const { agentStatuses } = await import("../src/agents/health.js");
    expect(await resolveClaudeBinAsync(none)).toBe("claude"); // the first probe failed and stays cached
    expect((await agentStatuses()).find((x) => x.agent === "claude")!.installed).toBe(false);
    script(join(bin, "claude"), "echo 7.7.7");
    const claude = (await agentStatuses()).find((x) => x.agent === "claude")!;
    expect([claude.installed, claude.version]).toEqual([true, "7.7.7"]);
  });

  it("has no blocking resolver any more", async () => {
    expect(await fresh()).not.toHaveProperty("resolveClaudeBin");
    expect(readFileSync("src/steps/claude.ts", "utf8")).not.toContain("execFileSync");
  });
});

describe("environment for steps", () => {
  it("drops a Claude host session's variables, keeps the owner's own settings", async () => {
    const { inheritedEnv } = await import("../src/steps/process.js");
    const host = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_HOST_SESSION_ID: "x", CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
      ANTHROPIC_BASE_URL: "http://host", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k", JAVA_HOME: "/jdk" };
    expect(inheritedEnv(host)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k", JAVA_HOME: "/jdk" });
    // Not inside a host session: a base URL the owner set (e.g. a proxy) stays.
    expect(inheritedEnv({ PATH: "/bin", ANTHROPIC_BASE_URL: "http://proxy" })).toEqual({ PATH: "/bin", ANTHROPIC_BASE_URL: "http://proxy" });
  });
});
