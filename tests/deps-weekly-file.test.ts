import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marker } from "../src/deps/stories.js";
import { fakeGithub } from "./helpers/fake-github.js";

// The file subcommand of tools/deps-weekly, run as a child process against the fake gh: no clone, no engine.
const TOOL = resolve("tools/deps-weekly");
const upd = (name: string, current: string, latest: string, cls: string, o: Record<string, unknown> = {}) => ({
  tool: name.includes(":") ? "maven" : "npm", kind: "dependency", name, current, latest, class: cls, security: false, ...o,
});
const MIX = [
  upd("org.foo:bar", "1.0.0", "1.0.1", "patch"),
  upd("org.x:plugin", "1.0", "1.1.0", "minor", { kind: "plugin" }),
  upd("org.p:parent", "1.0", "2.0", "major", { kind: "parent" }),
  upd("react", "17.0.0", "18.0.0", "major"),
  upd("lodash", "4.17.20", "4.17.21", "patch", { security: true }),
];
const ADV = [{ package: "lodash", severity: "high", title: "Bad", url: "https://github.com/advisories/GHSA-1", fix: true }];
const LAST_MIX = "Updates found: 5. Filed: 5 in 4 stories. Updated in open stories: 0. Skipped as already filed: 0. Tools not available: 0.";

let gh: ReturnType<typeof fakeGithub>;
let n = 0;
beforeEach(() => {
  gh = fakeGithub();
  gh.setLabels([]);
});
afterEach(() => gh.restore());

/** A run folder with deps.json, inside a workspace that may have repo/. */
function folder(updates: unknown[] = MIX, repoFiles: Record<string, string> = {}) {
  const ws = join(gh.tmp, `ws-${n++}`);
  const dir = join(ws, "run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "deps.json"), JSON.stringify({ version: 1, branch: "develop", commit: "c".repeat(40), projects: [], updates, advisories: ADV, unlisted: [], checks: [], notes: [], unavailable: 0, incomplete: 0 }));
  if (Object.keys(repoFiles).length > 0) {
    mkdirSync(join(ws, "repo"));
    for (const [f, t] of Object.entries(repoFiles)) writeFileSync(join(ws, "repo", f), t);
  }
  return { ws, dir };
}
function file(f: { ws: string; dir: string }, env: Record<string, string> = {}) {
  const r = spawnSync("node", [TOOL, "file", f.dir], {
    cwd: f.ws, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, FACTORY_VAR_GITHUB_REPO: "acme/app", FACTORY_HOME: join(gh.tmp, "home"), FACTORY_DEPS_LOCK_WAIT_MS: "300", ...env },
  });
  return { status: r.status, out: r.stdout.trimEnd(), err: r.stderr, last: r.stdout.trimEnd().split("\n").at(-1) };
}
const lockDir = () => join(gh.tmp, "home", "locks", "deps-weekly-acme_app.lock");

describe("deps-weekly file", { timeout: 60_000 }, () => {
  it("files the mix: one patch/minor story, one per major, one security story", () => {
    const f = folder(MIX, { "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }), "package-lock.json": "{}" });
    const r = file(f);
    expect(r.status, r.err).toBe(0);
    expect(r.last).toBe(LAST_MIX);
    const made = gh.createdBodies();
    expect(made.map((m) => [m.title, m.labels])).toEqual([
      ["Fix 1 vulnerable dependency", ["Factory_go", "bug"]],
      ["Update 2 dependencies (patch and minor)", ["Factory_go", "enhancement"]],
      ["Update org.p:parent to 2.0 (major)", ["enhancement"]],
      ["Update react to 18.0.0 (major)", ["enhancement"]],
    ]);
    expect(made[0]!.body).toContain("security: high — https://github.com/advisories/GHSA-1");
    expect(made[0]!.body).toContain("- `npm run build`");
    expect(made[1]!.body).toContain(marker("org.foo:bar", "1.0.1"));
    expect(gh.labels().sort()).toEqual(["Factory_go", "bug", "enhancement"]);
    expect(JSON.parse(readFileSync(join(f.dir, "filed.json"), "utf8")).entries).toHaveLength(4);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("files nothing twice: a second run in a new folder skips everything", () => {
    expect(file(folder()).status).toBe(0);
    const r = file(folder());
    expect(r.status, r.err).toBe(0);
    expect(r.last).toBe("Updates found: 5. Filed: 0 in 0 stories. Updated in open stories: 0. Skipped as already filed: 5. Tools not available: 0.");
    expect(gh.createdBodies()).toHaveLength(4);
    expect(gh.updatedBodies()).toEqual([]);
  });

  it("edits the open story for a newer version and creates nothing for it", () => {
    file(folder());
    const created = gh.createdBodies().length;
    const r = file(folder(MIX.map((u) => (u.name === "org.foo:bar" ? { ...u, latest: "1.0.2" } : u))));
    expect(r.status, r.err).toBe(0);
    expect(r.last).toContain("Filed: 0 in 0 stories. Updated in open stories: 1. Skipped as already filed: 4.");
    expect(gh.createdBodies()).toHaveLength(created);
    const up = gh.updatedBodies();
    expect(up).toHaveLength(1);
    expect(up[0]!.body).toContain(marker("org.foo:bar", "1.0.2"));
    expect(up[0]!.body).not.toContain(marker("org.foo:bar", "1.0.1"));
  });

  it("escalates an open story when the same version becomes a security update", () => {
    file(folder(MIX.map((u) => ({ ...u, security: false }))));
    expect(gh.createdBodies().map((m) => m.labels)).not.toContainEqual(["Factory_go", "bug"]);
    const r = file(folder());
    expect(r.status, r.err).toBe(0);
    expect(r.last).toContain("Updated in open stories: 1.");
    expect(gh.updatedBodies()[0]!.body).toContain(", security: high");
    expect(gh.bugIssues().find((i) => i.labels.some((l) => l.name === "bug"))).toBeDefined();
  });

  it("does not file again an update whose issue was closed as not planned, but files a newer version", () => {
    gh.setBugIssues([{
      number: 50, state: "closed", state_reason: "not_planned", title: "Update react", body: `${marker("react", "18.0.0")}`, labels: [],
      html_url: "https://github.com/acme/app/issues/50", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z",
    }]);
    const r = file(folder());
    expect(r.status, r.err).toBe(0);
    expect(r.last).toContain("Filed: 4 in 3 stories.");
    expect(r.last).toContain("Skipped as already filed: 1.");
    expect(gh.createdBodies().map((m) => m.title)).not.toContain("Update react to 18.0.0 (major)");
    expect(r.out).toContain("closed as not planned");
    const r2 = file(folder(MIX.map((u) => (u.name === "react" ? { ...u, latest: "19.0.0" } : u))));
    expect(r2.status, r2.err).toBe(0);
    expect(gh.createdBodies().map((m) => m.title)).toContain("Update react to 19.0.0 (major)");
  });

  it("a minor update that becomes major leaves the minor story and gets its own story with enhancement only", () => {
    file(folder());
    const bumped = MIX.map((u) => (u.name === "org.x:plugin" ? { ...u, current: "1.1.0", latest: "2.0.0", class: "major" } : u));
    const r = file(folder(bumped));
    expect(r.status, r.err).toBe(0);
    const last = gh.createdBodies().at(-1)!;
    expect(last.title).toBe("Update org.x:plugin to 2.0.0 (major)");
    expect(last.labels).toEqual(["enhancement"]);
    const up = gh.updatedBodies();
    expect(up).toHaveLength(1);
    expect(up[0]!.body).not.toContain(marker("org.x:plugin", "1.1.0"));
    expect(up[0]!.body).toContain(marker("org.foo:bar", "1.0.1"));
    expect(r.out).toContain("Moved org.x:plugin out of #");
  });

  it("follows deps_majors_go and deps_labels, and leaves out deps_ignore", () => {
    const r = file(folder(), { FACTORY_VAR_DEPS_MAJORS_GO: "yes", FACTORY_VAR_DEPS_LABELS: "go,deps", FACTORY_VAR_DEPS_IGNORE: "org.foo:*, lodash" });
    expect(r.status, r.err).toBe(0);
    const made = gh.createdBodies();
    expect(made.map((m) => m.labels)).toEqual([["go", "deps", "enhancement"], ["enhancement", "go", "deps"], ["enhancement", "go", "deps"]]);
    expect(made.map((m) => m.body).join("\n")).not.toMatch(/org\.foo:bar|lodash/);
    expect(r.last).toContain("Updates found: 3.");
  });

  it("commands follow the repository: no lockfile, no test script", () => {
    file(folder([upd("react", "17.0.0", "18.0.0", "major")], { "package.json": JSON.stringify({ scripts: { build: "x", test: 'echo "Error: no test specified" && exit 1' } }) }));
    const body = gh.createdBodies()[0]!.body;
    expect(body).toContain("- `npm install`");
    expect(body).toContain("- `npm run build`");
    expect(body).not.toContain("npm test");
  });

  it("after a stop, a rerun in the same folder files only what is missing", () => {
    const f = folder();
    const r1 = file(f, { FAKE_GH_FAIL_CREATE_AT: "2" });
    expect(r1.status).toBe(1);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.dir, "filed.json"), "utf8")).entries).toHaveLength(1);
    expect(existsSync(lockDir())).toBe(false);
    const r2 = file(f);
    expect(r2.status, r2.err).toBe(0);
    expect(gh.createdBodies()).toHaveLength(4);
    expect(new Set(gh.createdBodies().map((m) => m.title)).size).toBe(4);
    expect(r2.last).toBe(LAST_MIX);
  });

  it("stops before writing when the issues cannot be read", () => {
    const r = file(folder(), { FAKE_GH_FAIL_API: "list" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("nothing was filed");
    expect(gh.createdBodies()).toEqual([]);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("stops before writing when the list of issues is cut, so a marker could be missed", () => {
    const old = (i: number) => ({
      number: i, state: "closed", state_reason: "completed", title: `t${i}`, body: "", labels: [],
      html_url: `https://github.com/acme/app/issues/${i}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z",
    });
    gh.setBugIssues(Array.from({ length: 1001 }, (_, i) => old(i + 1)));
    const r = file(folder());
    expect(r.status).toBe(1);
    expect(r.err).toContain("more issues than the Foundry reads");
    expect(gh.createdBodies()).toEqual([]);
  });

  it("rejects a bad setting before any call", () => {
    for (const env of [{ FACTORY_VAR_DEPS_LABELS: "x".repeat(60) }, { FACTORY_VAR_DEPS_MAJORS_GO: "maybe" }]) {
      const r = file(folder(), env);
      expect(r.status).toBe(1);
      expect(r.err).toMatch(/deps_/);
    }
    expect(gh.ghLog()).toBe("");
  });

  it("makes no call at all when there is nothing to file", () => {
    const r = file(folder([]));
    expect(r.status).toBe(0);
    expect(r.last).toBe("Updates found: 0. Filed: 0 in 0 stories. Updated in open stories: 0. Skipped as already filed: 0. Tools not available: 0.");
    expect(gh.ghLog()).toBe("");
  });

  it("only reads and writes issues and labels", () => {
    file(folder());
    file(folder());
    for (const l of gh.ghLog().split("\n").filter((x) => x.startsWith("gh "))) expect(l).toMatch(/^gh (api repos\/acme\/app\/issues|label |issue edit )/);
  });

  describe("one filing process per repository", () => {
    it("waits, then stops, while a live process holds the lock; the lock is left alone", () => {
      mkdirSync(lockDir(), { recursive: true });
      writeFileSync(join(lockDir(), "pid"), String(process.pid));
      const r = file(folder());
      expect(r.status).toBe(1);
      expect(r.err).toContain("another deps-weekly run is filing");
      expect(gh.createdBodies()).toEqual([]);
      expect(existsSync(lockDir())).toBe(true);
    });
    it("takes over the lock of a process that is gone", () => {
      mkdirSync(lockDir(), { recursive: true });
      writeFileSync(join(lockDir(), "pid"), "2147483646");
      const r = file(folder());
      expect(r.status, r.err).toBe(0);
      expect(gh.createdBodies()).toHaveLength(4);
      expect(existsSync(lockDir())).toBe(false);
    });
  });
});
