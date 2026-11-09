import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testGateEnv } from "../src/agents/run.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { heldWorkspace, stepIsolated, TEAM_INPLACE_REFUSED, TEAM_WORKTREE_REFUSED, workspaceRefused } from "../src/engine/isolation.js";
import { regexQuote, runSandbox, sandboxedRun, sandboxProfile, TEAM_SANDBOX_REFUSED, workspaceCacheEnv, workspaceJavaDir, workspaceSlotsDir, type SandboxPaths } from "../src/engine/os-sandbox.js";
import { learningsFile } from "../src/engine/runner.js";
import { shortEnvRun } from "../src/engine/short-env.js";
import { HostEntry, WorkspaceSchema } from "../src/workspaces/list.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// A team's run is held apart from the others (#785): the decisions and the profile text. No process is started here.

let admin: { id: string };
beforeAll(async () => {
  admin = await createUser({ name: "Admin", email: "admin-iso@example.com", password: TEST_PASSWORD, role: "admin" });
});

const cfg = (user_runs: "required" | "off" = "required") => ConfigSchema.parse({ protected_branches: [], sandbox: { user_runs } });

describe("a held workspace", () => {
  it("is every workspace but default, and fails closed on a bad id", () => {
    for (const v of [undefined, "", "default"]) expect(heldWorkspace(v), String(v)).toBe(false);
    for (const v of ["team-a", "x y"]) expect(heldWorkspace(v), v).toBe(true);
  });

  it("isolates and shortens the environment of an admin's team run, and not of a default run", () => {
    expect(stepIsolated(admin.id, "acme/app", "team-a")).toBe(true);
    expect(shortEnvRun(admin.id, "team-a")).toBe(true);
    expect(stepIsolated(admin.id, "acme/app", "default")).toBe(false);
    expect(stepIsolated(admin.id, "acme/app")).toBe(false);
    expect(shortEnvRun(admin.id)).toBe(false);
    expect(stepIsolated(undefined, undefined, "team-a")).toBe(true);
  });

  it("refuses inplace and worktree flows for a team, for an admin too", () => {
    expect(workspaceRefused("inplace", admin.id, "team-a")).toBe(TEAM_INPLACE_REFUSED);
    expect(workspaceRefused("worktree", admin.id, "team-a")).toBe(TEAM_WORKTREE_REFUSED);
    expect(workspaceRefused("empty", admin.id, "team-a")).toBeUndefined();
    expect(workspaceRefused("inplace", admin.id, "default")).toBeUndefined();
    expect(workspaceRefused("inplace", admin.id)).toBeUndefined();
  });
});

describe("the sandbox decision", () => {
  it("is always on for a team, whatever the setting, and refused when the sandbox is not there", () => {
    const run = { owner: admin.id, workspace: "team-a" };
    expect(runSandbox(run, cfg("off"), () => true)).toBe("on");
    expect(runSandbox(run, cfg("required"), () => true)).toBe("on");
    expect(runSandbox(run, cfg("off"), () => false)).toEqual({ refused: TEAM_SANDBOX_REFUSED });
  });

  it("matches sandboxedRun for the default workspace", () => {
    for (const workspace of [undefined, "default"]) {
      for (const user_runs of ["required", "off"] as const) {
        for (const owner of [admin.id, undefined]) {
          for (const available of [true, false]) expect(runSandbox({ owner, workspace }, cfg(user_runs), () => available), `${workspace} ${user_runs} ${owner} ${available}`).toEqual(sandboxedRun(owner, cfg(user_runs), () => available));
        }
      }
    }
  });
});

const base: SandboxPaths = { home: "/h", data: "/h/d", runs: "/h/d/runs", runDir: "/h/d/runs/r1", tools: "/h/t", hooks: "/h/d/hooks", learnings: "/h/d/learnings/x.md", lockDir: "/h/d/locks" };
const id = (p: string) => p;
const text = (over: Partial<SandboxPaths>) => sandboxProfile({ ...base, ...over }, id);
const allows = (t: string) => t.split("\n").filter((l) => l.startsWith("(allow network-outbound (remote tcp"));

describe("the profile of a team's step", () => {
  it("denies all outbound IP and allows only the proxy and local ports on localhost", () => {
    const t = text({ network: { proxyPort: 4000, localPorts: [11434] } });
    expect(t.split("\n").filter((l) => l === '(deny network-outbound (remote ip "*:*"))')).toHaveLength(1);
    expect(allows(t)).toEqual(['(allow network-outbound (remote tcp "localhost:4000"))', '(allow network-outbound (remote tcp "localhost:11434"))']);
    expect(text({})).not.toContain("remote tcp");
  });

  it("is narrowed by an evaluation limit, never widened", () => {
    expect(allows(text({ network: { proxyPort: 4000, localPorts: [] }, outbound: ["*:443"] }))).toEqual([]);
    expect(allows(text({ network: { proxyPort: 4000, localPorts: [] }, outbound: [] }))).toEqual([]);
    expect(allows(text({ network: { proxyPort: 4000, localPorts: [11434] }, outbound: ["localhost:11434"] }))).toEqual(['(allow network-outbound (remote tcp "localhost:11434"))']);
    expect(allows(text({ network: { proxyPort: 4000, localPorts: [] }, outbound: ["localhost:4000"] }))).toEqual(['(allow network-outbound (remote tcp "localhost:4000"))']);
    expect(text({ network: { proxyPort: 4000, localPorts: [] }, outbound: ["*:443"] }).split("\n").filter((l) => l.includes('remote ip "*:*"'))).toHaveLength(1);
  });

  it("opens the shared cache for reading and writing, and for reading only in a read-only workspace", () => {
    const cache = "/h/d/workspaces/team-a/cache";
    const rw = text({ shared: [cache] });
    expect(rw).toContain(`(allow file-read* (subpath "${cache}"))`);
    expect(rw).toContain(`(allow file-write* (subpath "${cache}"))`);
    const ro = text({ shared: [cache], workspaceReadOnly: true });
    expect(ro).toContain(`(allow file-read* (subpath "${cache}"))`);
    expect(ro).not.toContain(`(allow file-write* (subpath "${cache}"))`);
  });

  it("opens a read-only path for reading only", () => {
    const t = text({ readOnly: ["/h/d/workspaces/team-a/agent-java"] });
    expect(t).toContain('(allow file-read* (subpath "/h/d/workspaces/team-a/agent-java"))');
    expect(t).not.toContain('(allow file-write* (subpath "/h/d/workspaces/team-a/agent-java"))');
  });

  it("opens the slot folders, the workspace's own folder and the governor's files, and nothing else of the slot tree", () => {
    const t = text({ slots: { root: "/h/d/test-slots", workspace: "team-a", link: "/h/d/workspaces/team-a/test-slots" } });
    expect(t).toContain('(allow file-read* file-write* (regex #"^/h/d/test-slots/slot-[0-9]+(/.*)?$"))');
    expect(t).toContain('(allow file-read* file-write* (subpath "/h/d/test-slots/workspaces/team-a"))');
    expect(t).toContain('(allow file-read* (literal "/h/d/test-slots/cap") (literal "/h/d/test-slots/workers") (literal "/h/d/test-slots/pause"))');
    expect(t).toContain('(allow file-read* (literal "/h/d/workspaces/team-a/test-slots"))');
    expect(t).not.toContain('(subpath "/h/d/test-slots")');
    expect(t).not.toContain("team-b");
    // after the write deny, so the slots also hold when the workspace is read-only
    const lines = t.split("\n");
    const denyAt = lines.indexOf("(deny file-write*)");
    expect(lines.findIndex((l) => l.includes("slot-[0-9]+"))).toBeGreaterThan(denyAt);
    expect(text({ slots: { root: "/h/d/test-slots", workspace: "team-a" }, workspaceReadOnly: true })).toContain("slot-[0-9]+");
  });

  it("follows a custom runs folder for the slot tree", () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), "slots-")));
    try {
      const s = workspaceSlotsDir(join(data, "elsewhere", "runs"), "team-a");
      expect(s.root).toBe(join(realpathSync(join(data, "elsewhere")), "test-slots"));
      expect(s.workspace).toBe("team-a");
      expect(lstatSync(join(s.root, "workspaces", "team-a")).isDirectory()).toBe(true);
      expect(s.link.endsWith(join("workspaces", "team-a", "test-slots"))).toBe(true);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("refuses a path with a line break or a quote", () => {
    expect(() => text({ shared: ["/h/d/x\ny"] })).toThrow();
    expect(() => text({ slots: { root: "/h/d/a\nb", workspace: "t" } })).toThrow();
    expect(() => text({ slots: { root: '/h/d/a"b', workspace: "t" } })).toThrow();
  });

  it("quotes a path as a regex", () => {
    expect(regexQuote("/a.b/c+d(e)[f]{g}|h$^*?\\")).toBe("/a\\.b/c\\+d\\(e\\)\\[f\\]\\{g\\}\\|h\\$\\^\\*\\?\\\\");
    for (const bad of ["a\nb", "a\rb", "a\0b", 'a"b']) expect(() => regexQuote(bad)).toThrow();
  });
});

describe("the folders of a workspace", () => {
  const data = () => process.env.FACTORY_HOME!;
  beforeEach(() => rmSync(join(data(), "workspaces"), { recursive: true, force: true }));
  afterAll(() => rmSync(join(data(), "workspaces"), { recursive: true, force: true }));

  it("gives a team its cache and replaces a link planted there", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      mkdirSync(join(data(), "workspaces", "team-a"), { recursive: true });
      symlinkSync(outside, join(data(), "workspaces", "team-a", "cache"));
      const c = workspaceCacheEnv("team-a", { MAVEN_OPTS: "-Xmx1g" });
      expect(c.dir).toBe(join(data(), "workspaces", "team-a", "cache"));
      expect(lstatSync(c.dir).isSymbolicLink()).toBe(false);
      expect(lstatSync(c.dir).isDirectory()).toBe(true);
      expect(c.env.npm_config_cache).toBe(join(c.dir, "npm"));
      expect(c.env.GRADLE_USER_HOME).toBe(join(c.dir, "gradle"));
      expect(c.env.MAVEN_OPTS).toBe(`-Xmx1g -Dmaven.repo.local=${join(c.dir, "m2")}`);
      expect(workspaceCacheEnv("team-a").env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${join(c.dir, "m2")}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("makes the Java stand-in folder for the server and replaces a link planted there", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      mkdirSync(join(data(), "workspaces", "team-a"), { recursive: true });
      symlinkSync(outside, join(data(), "workspaces", "team-a", "agent-java"));
      const dir = workspaceJavaDir("team-a");
      expect(dir).toBe(join(data(), "workspaces", "team-a", "agent-java"));
      expect(lstatSync(dir).isSymbolicLink()).toBe(false);
      expect(() => readlinkSync(dir)).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps the learnings of a team in the team's folder, and of the default workspace where they were", () => {
    const team = learningsFile({ github_repo: "acme/app" }, "/x/repo", undefined, "team-a");
    expect(team).toBe(join(data(), "workspaces", "team-a", "learnings", "acme__app.md"));
    expect(learningsFile({ github_repo: "acme/app" }, "/x/repo", undefined, "default")).toBe(join(data(), "learnings", "acme__app.md"));
    expect(learningsFile({ github_repo: "acme/app" }, "/x/repo")).toBe(join(data(), "learnings", "acme__app.md"));
    expect(() => learningsFile({ github_repo: "acme/app" }, "/x/repo", undefined, "x y")).toThrow();
  });
});

describe("the test gate of a team's run", () => {
  it("puts the Java stand-in in the given folder", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gate-")));
    try {
      const jdk = join(tmp, "jdk");
      mkdirSync(join(jdk, "bin"), { recursive: true });
      writeFileSync(join(jdk, "bin", "java"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(jdk, "bin", "java"), 0o755);
      const stand = join(tmp, "stand");
      mkdirSync(stand);
      const env = testGateEnv("/usr/bin", join(tmp, "runs", "r1"), jdk, stand);
      expect(env.JAVA_HOME?.startsWith(stand)).toBe(true);
      expect(env.FACTORY_REAL_JAVA_HOME).toBe(realpathSync(jdk));
      const plain = testGateEnv("/usr/bin", join(tmp, "runs", "r1"), jdk);
      expect(plain.JAVA_HOME?.startsWith(join(tmp, "agent-java"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the hosts of a workspace", () => {
  it("accepts names, wildcards and ports, and refuses addresses and malformed entries", () => {
    for (const ok of ["repo.example.com", "*.example.com:8443", "a-b.example.co.uk"]) expect(HostEntry.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["1.2.3.4", "a b", "*.", "host:0", "example.com:70000", "localhost", "-a.example.com", "a..example.com", "1.2.3.4:443", "Example.com"]) expect(HostEntry.safeParse(bad).success, bad).toBe(false);
  });

  it("is an empty list by default", () => {
    expect(WorkspaceSchema.parse({ id: "team-a", name: "A" }).hosts).toEqual([]);
    expect(WorkspaceSchema.parse({ id: "team-a", name: "A", hosts: ["repo.example.com"] }).hosts).toEqual(["repo.example.com"]);
    expect(WorkspaceSchema.safeParse({ id: "team-a", name: "A", hosts: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) }).success).toBe(false);
  });
});
