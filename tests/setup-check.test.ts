import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProbe, doctorCommand, parseNeeds, setupCheck, setupText, sharedSetupCheck, type Probe, type ProbeResult } from "../src/setup-check.js";

const ok = (out = ""): ProbeResult => ({ code: 0, out, missing: false });
const fail = (out = "", code = 1): ProbeResult => ({ code, out, missing: false });
const gone: ProbeResult = { code: null, out: "", missing: true };
const slow: ProbeResult = { code: null, out: "", missing: false };
const HELP_AUTH = ok("Usage: claude\n\nCommands:\n  auth    Manage authentication\n  mcp     Configure MCP\n");

/** A fake probe: a map from "cmd args" to a result; anything not in it is missing. It records what it was asked. */
function fake(map: Record<string, ProbeResult>) {
  const calls: string[] = [];
  const probe: Probe = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    return map[key] ?? gone;
  };
  return { probe, calls };
}
const GOOD = {
  "git --version": ok("git version 2.40.0"),
  "/bin/claude --version": ok("2.1.0 (Claude Code)"),
  "/bin/claude --help": HELP_AUTH,
  "/bin/claude auth status": ok('{"loggedIn": true}'),
  "/bin/codex --version": ok("codex-cli 0.5.0"),
  "/bin/codex login status": ok("Logged in using ChatGPT"),
  "node --version": ok("v22.0.0"),
};
const run = (map: Record<string, ProbeResult>, o: Record<string, unknown> = {}) => {
  const f = fake(map);
  return setupCheck({ probe: f.probe, claudeBin: "/bin/claude", codexBin: "/bin/codex", platform: "darwin", ...o }).then((r) => ({ r, calls: f.calls }));
};
const item = (r: Awaited<ReturnType<typeof setupCheck>>, id: string) => r.items.find((i) => i.id === id);

describe("setupCheck", () => {
  it("is ready when everything is present and signed in", async () => {
    const { r } = await run(GOOD);
    expect(r.items.map((i) => [i.id, i.state])).toEqual([["git", "ok"], ["claude", "ok"], ["claude-sign-in", "ok"], ["codex", "ok"], ["codex-sign-in", "ok"]]);
    expect(r).toMatchObject({ ready: true, problems: 0, unchecked: 0, platform: "macos" });
    expect(setupText(r, { simple: true }).trimEnd().endsWith("Everything is ready.")).toBe(true);
  });

  it.each([
    ["darwin", "xcode-select --install"],
    ["linux", "sudo apt install git"],
    ["win32", undefined],
  ] as const)("shows how to get git on %s", async (platform, command) => {
    const { r } = await run({ ...GOOD, "git --version": gone }, { platform });
    const git = item(r, "git")!;
    expect(git.state).toBe("missing");
    expect(git.command).toBe(command);
    expect(git.link?.url).toBe("https://git-scm.com/downloads");
    expect(r.ready).toBe(false);
    expect(r.problems).toBe(1);
  });

  it("shows how to install Claude Code and leaves out its sign-in", async () => {
    const { r } = await run({ ...GOOD, "/bin/claude --version": gone });
    expect(item(r, "claude")).toMatchObject({ state: "missing", command: "npm install -g @anthropic-ai/claude-code" });
    expect(item(r, "claude")!.link?.url).toContain("docs.claude.com");
    expect(item(r, "claude-sign-in")).toBeUndefined();
    expect(r.ready).toBe(false);
    const win = await run({ ...GOOD, "/bin/claude --version": gone }, { platform: "win32" });
    expect(item(win.r, "claude")!.command).toBeUndefined();
  });

  it("says Claude Code is signed out", async () => {
    for (const status of [fail("Not logged in"), ok('{"loggedIn": false}')]) {
      const { r } = await run({ ...GOOD, "/bin/claude auth status": status });
      const s = item(r, "claude-sign-in")!;
      expect(s.state).toBe("signed-out");
      expect(s.explain).toContain("/login");
      expect(r).toMatchObject({ ready: false, problems: 1, unchecked: 0 });
    }
  });

  it("uses the bare name in the sign-in command, and a quoted path otherwise", async () => {
    const bare = await run({ ...GOOD, "claude --version": ok("2.1.0"), "claude --help": HELP_AUTH, "claude auth status": fail("Not logged in") }, { claudeBin: "claude" });
    expect(item(bare.r, "claude-sign-in")!.command).toBe("claude");
    const spaced = await run({ ...GOOD, "/My Apps/claude --version": ok("2.1.0"), "/My Apps/claude --help": HELP_AUTH, "/My Apps/claude auth status": fail("Not logged in") }, { claudeBin: "/My Apps/claude" });
    expect(item(spaced.r, "claude-sign-in")!.command).toBe("'/My Apps/claude'");
    expect(spaced.calls).toContain("/My Apps/claude auth status");
    const quote = await run({ ...GOOD, "/it's/claude --version": ok("2.1.0"), "/it's/claude --help": HELP_AUTH, "/it's/claude auth status": fail("Not logged in") }, { claudeBin: "/it's/claude" });
    expect(item(quote.r, "claude-sign-in")!.command).toBe("'/it'\\''s/claude'");
    const bundled = await run(GOOD, { codexBin: "/bin/codex" });
    expect(bundled.calls).toContain("/bin/claude --version");
  });

  it.each([
    ["help without auth", { "/bin/claude --help": ok("Usage: claude [prompt]") }, false],
    ["unknown command", { "/bin/claude auth status": fail("error: unknown command 'auth'") }, true],
    ["time-out", { "/bin/claude auth status": slow }, true],
  ] as const)("does not call it ready when the sign-in is unknown: %s", async (_name, over, asked) => {
    const { r, calls } = await run({ ...GOOD, ...over });
    expect(item(r, "claude-sign-in")!.state).toBe("unknown");
    expect(calls.includes("/bin/claude auth status")).toBe(asked);
    expect(r).toMatchObject({ ready: false, unchecked: 1, problems: 0 });
    const text = setupText(r, { simple: true });
    expect(text).not.toContain("Everything is ready.");
    expect(text).toContain("could not be checked");
    const out: string[] = [];
    expect(await doctorCommand({ simple: true }, { out: (s) => void out.push(s), err: () => {} }, async () => r)).toBe(1);
  });

  it("treats Codex as optional", async () => {
    const missing = await run({ ...GOOD, "/bin/codex --version": gone });
    expect(item(missing.r, "codex")).toMatchObject({ needed: false, state: "missing", command: "npm install -g @openai/codex" });
    expect(item(missing.r, "codex-sign-in")).toBeUndefined();
    expect(missing.r.ready).toBe(true);
    expect(setupText(missing.r, { simple: true })).toContain("(optional)");
    for (const login of [fail("", 1), ok("Not logged in")]) {
      const { r } = await run({ ...GOOD, "/bin/codex login status": login });
      expect(item(r, "codex-sign-in")).toMatchObject({ state: "signed-out", command: "/bin/codex login" });
    }
    const bare = await run({ ...GOOD, "codex --version": ok("codex 1"), "codex login status": fail("") }, { codexBin: "codex" });
    expect(item(bare.r, "codex-sign-in")!.command).toBe("codex login");
  });

  it("checks Node.js only when asked", async () => {
    const without = await run(GOOD);
    expect(item(without.r, "node")).toBeUndefined();
    expect(without.calls).not.toContain("node --version");
    const missing = await run({ ...GOOD, "node --version": gone }, { needs: ["node"] });
    expect(item(missing.r, "node")).toMatchObject({ state: "missing", needed: true });
    expect(item(missing.r, "node")!.link?.url).toBe("https://nodejs.org/en/download");
    expect(missing.r.ready).toBe(false);
    const there = await run(GOOD, { needs: ["node"] });
    expect(item(there.r, "node")!.state).toBe("ok");
  });
});

describe("parseNeeds", () => {
  it("reads, splits and de-duplicates", () => {
    expect(parseNeeds("node")).toEqual(["node"]);
    expect(parseNeeds(["node,node"])).toEqual(["node"]);
    expect(parseNeeds(undefined)).toEqual([]);
    expect(() => parseNeeds("python")).toThrow("need must be one of: node");
  });
});

describe("sharedSetupCheck", () => {
  it("gives one answer to callers that overlap, and probes again afterwards", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let git = 0;
    const probe: Probe = async (cmd) => {
      if (cmd === "git") {
        git++;
        await hold;
      }
      return gone;
    };
    const o = { probe, claudeBin: "/bin/claude", codexBin: "/bin/codex" };
    const a = sharedSetupCheck(o);
    const b = sharedSetupCheck(o);
    expect(b).toBe(a);
    release();
    await Promise.all([a, b]);
    expect(git).toBe(1);
    await sharedSetupCheck(o);
    expect(git).toBe(2);
  });

  it("forgets a check that failed", async () => {
    let n = 0;
    const probe: Probe = async () => {
      n++;
      throw new Error("boom");
    };
    const o = { probe, claudeBin: "/bin/claude", codexBin: "/bin/codex" };
    await expect(sharedSetupCheck(o)).rejects.toThrow("boom");
    const first = n;
    await expect(sharedSetupCheck(o)).rejects.toThrow("boom");
    expect(n).toBeGreaterThan(first);
  });
});

/** A child process that can be told to ignore signals. */
function fakeChild(ignoreTerm: boolean) {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn((sig: string) => {
    if (!ignoreTerm || sig === "SIGKILL") queueMicrotask(() => c.emit("close", null));
    return true;
  });
  return c;
}

describe("createProbe", () => {
  afterEach(() => vi.useRealTimers());

  it("settles at the limit for a child that ignores SIGTERM, then kills it, and leaves no timer", async () => {
    vi.useFakeTimers();
    const child = fakeChild(true);
    const probe = createProbe((() => child) as never, { timeoutMs: 50, graceMs: 20 });
    const p = probe("x", []);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toEqual({ code: null, out: "", missing: false });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers missing for ENOENT, and with the exit code and output otherwise", async () => {
    const enoent = fakeChild(false);
    const p1 = createProbe((() => enoent) as never)("nope", []);
    enoent.emit("error", Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" }));
    expect(await p1).toEqual({ code: null, out: "", missing: true });
    const child = fakeChild(false);
    const p2 = createProbe((() => child) as never)("x", []);
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.emit("close", 3);
    expect(await p2).toEqual({ code: 3, out: "hello", missing: false });
  });

  it("cuts output over 64 KB", async () => {
    const child = fakeChild(false);
    const p = createProbe((() => child) as never)("x", []);
    child.stdout.emit("data", Buffer.from("a".repeat(100_000)));
    child.emit("close", 0);
    expect((await p).out.length).toBe(64 * 1024);
  });
});

describe("setupText and doctorCommand", () => {
  it("shows versions only in full mode, and never asks for a secret", async () => {
    const { r } = await run({ ...GOOD, "/bin/claude auth status": fail("Not logged in") });
    expect(setupText(r, { simple: true })).not.toContain("git version");
    const full = setupText(r, { simple: false });
    expect(full).toContain("git version 2.40.0");
    expect(full).toContain("Run: /bin/claude");
    expect(full.toLowerCase()).not.toContain("password:");
    expect(full.toLowerCase()).not.toContain("api key");
  });

  it("exits 0 when ready, 1 when not, prints JSON, and rejects an unknown need", async () => {
    const good = (await run(GOOD)).r;
    const bad = (await run({ ...GOOD, "git --version": gone })).r;
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };
    expect(await doctorCommand({ simple: true }, io, async () => good)).toBe(0);
    expect(await doctorCommand({ simple: true }, io, async () => bad)).toBe(1);
    out.length = 0;
    expect(await doctorCommand({ json: true }, io, async () => good)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ ready: true, platform: "macos" });
    expect(await doctorCommand({ need: ["python"] }, io, async () => good)).toBe(1);
    expect(err).toEqual(["need must be one of: node"]);
  });
});
