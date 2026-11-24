import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { AUDIT_TIMEOUT_MS, MAVEN_TIMEOUT_MS, NPM_CI_TIMEOUT_MS, NPM_OUTDATED_TIMEOUT_MS } from "../src/deps/check.js";
import { GO_TIMEOUT_MS, GRADLE_TIMEOUT_MS, PIP_NOT_SET_NOTE, PIP_TIMEOUT_MS } from "../src/deps/ecosystems.js";
import { OSV_TIMEOUT_MS } from "../src/deps/osv.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const ENV = [
  "FACTORY_NPM_BIN", "FACTORY_MVN_BIN", "FAKE_NPM_LOG", "FAKE_NPM_OUTDATED", "FAKE_NPM_OUTDATED_EXIT", "FAKE_NPM_AUDIT", "FAKE_MVN_OUT", "FAKE_MVN_EXIT", "NPM_TOKEN",
  "FACTORY_GRADLE_BIN", "FACTORY_PIP_BIN", "FACTORY_GO_BIN", "FACTORY_OSV_BIN", "FAKE_GRADLE_REPORT", "FAKE_GRADLE_NO_PLUGIN", "FAKE_PIP_OUT", "FAKE_GO_OUT", "FAKE_OSV_OUT",
  "FAKE_GH_LATEST_RELEASES", "FAKE_GH_TAG_SHAS", "FAKE_GH_FAIL_API",
];
const LAST = "Updates found: 0 (0 security). Tools not available: 0. Incomplete: 0.";

let gh: ReturnType<typeof fakeGithub>;
let osvFake = "";
beforeEach(() => {
  gh = fakeGithub();
  const script = (name: string, body: string) => {
    const f = join(gh.tmp, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  // A fake npm: logs where it ran, its arguments, how many variables look like tokens and whether .npmrc exists.
  process.env.FACTORY_NPM_BIN = script("fake-npm", [
    '{ pwd; echo "$@"; echo "tokens=$(env | cut -d= -f1 | grep -ci token)"; [ -e .npmrc ] && echo npmrc=yes || echo npmrc=no; } >> "$FAKE_NPM_LOG"',
    'case "$1" in',
    "ci) exit 0;;",
    `outdated) printf '%s' "$FAKE_NPM_OUTDATED"; exit "\${FAKE_NPM_OUTDATED_EXIT:-1}";;`,
    `audit) printf '%s' "$FAKE_NPM_AUDIT"; exit 1;;`,
    "esac",
  ].join("\n"));
  process.env.FACTORY_MVN_BIN = script("fake-mvn", `echo "$@" >> "$FAKE_NPM_LOG"\nprintf '%s' "$FAKE_MVN_OUT"\nexit "\${FAKE_MVN_EXIT:-0}"`);
  process.env.FAKE_NPM_LOG = join(gh.tmp, "npm.log");
  // Fakes for the other tools, so a real gradle, pip, go or osv-scanner on the machine is never called. The scanner is off unless a test turns it on.
  process.env.FACTORY_GRADLE_BIN = script("fake-gradle", [
    'echo "gradle $@" >> "$FAKE_NPM_LOG"',
    `if [ -n "$FAKE_GRADLE_NO_PLUGIN" ]; then echo "Task 'dependencyUpdates' not found in root project 'x'." >&2; exit 1; fi`,
    'mkdir -p build/dependencyUpdates; printf \'%s\' "$FAKE_GRADLE_REPORT" > build/dependencyUpdates/report.json',
  ].join("\n"));
  process.env.FACTORY_PIP_BIN = script("fake-pip", 'echo "pip $@ tokens=$(env | cut -d= -f1 | grep -ci token) config=$PIP_CONFIG_FILE" >> "$FAKE_NPM_LOG"\nprintf \'%s\' "$FAKE_PIP_OUT"');
  process.env.FACTORY_GO_BIN = script("fake-go", 'echo "go $@ toolchain=$GOTOOLCHAIN" >> "$FAKE_NPM_LOG"\nprintf \'%s\' "$FAKE_GO_OUT"');
  process.env.FACTORY_OSV_BIN = join(gh.tmp, "no-such-osv");
  osvFake = script("fake-osv", 'echo "osv $@" >> "$FAKE_NPM_LOG"\nprintf \'%s\' "$FAKE_OSV_OUT"\nexit 1');
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  gh.restore();
});

const run = () => runFlow(loadFlow("deps-weekly", gh.tmp).flow, { runsDir: join(gh.tmp, "runs"), claudeBin, task: "", repo: gh.tmp, vars: { github_repo: "acme/app" } });
const checkOut = (s: { history: { id: string; output: string }[] }) => s.history.find((h) => h.id === "check")?.output ?? "";
const deps = (s: { runDir: string }) => JSON.parse(readFileSync(join(s.runDir, "deps.json"), "utf8"));
const npmLog = () => (existsSync(process.env.FAKE_NPM_LOG!) ? readFileSync(process.env.FAKE_NPM_LOG!, "utf8") : "");

/** A commit on the fake remote's main branch. */
function addFiles(files: Record<string, string>) {
  const work = mkdtempSync(join(gh.tmp, "w-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: work, stdio: "pipe" });
  git("clone", "-q", gh.remote, ".");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add files");
  git("push", "-q", "origin", "main");
}
const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { version: v } } });
const MAVEN = [
  "[INFO] The following dependencies in Dependencies have newer versions:",
  "[INFO]   org.foo:bar ........................ 1.0.0 -> 1.0.1",
  "[INFO] ",
  "[INFO] The following plugin updates are available:",
  "[INFO]   org.x:some-plugin ................... 1.0 -> 1.1.0",
  "[INFO] ",
  "[INFO] The parent project has a newer version:",
  "[INFO]   org.p:parent ........................ 1.0 -> 2.0",
  "",
].join("\n");
const audit = (pkg: string, severity: string) => JSON.stringify({ vulnerabilities: { [pkg]: { via: [{ name: pkg, severity, title: "Bad", url: "https://github.com/advisories/GHSA-1" }], fixAvailable: true } } });

describe("deps-weekly flow", { timeout: 60_000 }, () => {
  it("has the shape of a flow that writes only issues and labels", () => {
    const { flow } = loadFlow("deps-weekly", gh.tmp);
    expect(flow.steps.map((s) => s.id)).toEqual(["clone", "actions", "check", "file_stories"]);
    // Only the clone, the lookup step (which runs no repository code) and the filing step have the token; the step that runs the repository's code has none.
    expect(flow.steps.filter((s) => (s as { repo_access?: boolean }).repo_access === true).map((s) => s.id)).toEqual(["clone", "actions", "file_stories"]);
    expect(flow.steps[2]).not.toHaveProperty("repo_access");
    expect(flow.steps[3]).toMatchObject({ type: "shell", repo_access: true });
    expect(flow.steps.every((s) => s.type === "shell" || s.id === "clone")).toBe(true);
    expect(flow.vars).toMatchObject({ deps_labels: "Factory_go", deps_majors_go: "no", deps_ignore: "" });
    // The tool limits run one after another; the step backstop must outlast them.
    const worst = (MAVEN_TIMEOUT_MS + NPM_CI_TIMEOUT_MS + NPM_OUTDATED_TIMEOUT_MS + AUDIT_TIMEOUT_MS + GRADLE_TIMEOUT_MS + PIP_TIMEOUT_MS + GO_TIMEOUT_MS + OSV_TIMEOUT_MS) / 1000;
    expect((flow.steps[2] as { timeout_sec?: number }).timeout_sec!).toBeGreaterThan(worst);
    expect(flow).not.toHaveProperty("one_per_repo");
    expect(Object.keys(flow.var_info ?? {}).sort()).toEqual(Object.keys(flow.vars ?? {}).sort());
  });

  it("reports an up-to-date repository, runs npm ci in the clone and writes nothing", async () => {
    addFiles({ "package.json": "{}", "package-lock.json": lock("4.17.21") });
    process.env.FAKE_NPM_OUTDATED = "{}";
    process.env.FAKE_NPM_OUTDATED_EXIT = "0";
    process.env.FAKE_NPM_AUDIT = JSON.stringify({ vulnerabilities: {} });
    const before = gh.remoteGit("for-each-ref");
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual(["clone", "actions", "check", "file_stories"]);
    const text = checkOut(s);
    expect(text).toContain("All dependencies are up to date.");
    expect(text.trimEnd().split("\n").at(-1)).toBe(LAST);
    expect(gh.remoteGit("for-each-ref")).toBe(before);
    for (const l of gh.ghLog().split("\n").filter((l) => l.startsWith("gh "))) expect(l).toMatch(/^gh repo clone/);
    const log = npmLog();
    expect(log).toMatch(/\/repo\n/);
    expect(log).toContain("ci --ignore-scripts");
    expect(log).toContain("--registry=https://registry.npmjs.org/");
  });

  it("classes the updates, marks security, and keeps credentials away from npm", async () => {
    addFiles({
      "pom.xml": "<project/>", "package.json": "{}", "package-lock.json": lock("4.17.20"), ".npmrc": "@acme:registry=https://example.invalid/\n",
    });
    process.env.NPM_TOKEN = "sentinel-secret";
    const before = gh.remoteGit("for-each-ref");
    process.env.FAKE_MVN_OUT = MAVEN;
    process.env.FAKE_NPM_OUTDATED = JSON.stringify({
      lodash: { latest: "4.17.21" }, react: { current: "17.0.0", latest: "18.0.0" }, jest: { current: "29.0.0", latest: "29.1.0", dependent: "app" },
    });
    process.env.FAKE_NPM_AUDIT = audit("lodash", "moderate");
    const s = await run();
    expect(s.status).toBe("succeeded");
    const d = deps(s);
    const row = (n: string) => d.updates.find((u: { name: string }) => u.name === n);
    expect(row("org.foo:bar")).toMatchObject({ tool: "maven", kind: "dependency", class: "patch", security: false });
    expect(row("org.x:some-plugin")).toMatchObject({ kind: "plugin", class: "minor" });
    expect(row("org.p:parent")).toMatchObject({ kind: "parent", class: "major" });
    expect(row("lodash")).toMatchObject({ current: "4.17.20", class: "patch", security: true });
    expect(row("react")).toMatchObject({ class: "major", security: false });
    expect(checkOut(s).trimEnd().split("\n").at(-1)).toBe("Updates found: 6 (1 security). Tools not available: 0. Incomplete: 0.");
    expect(checkOut(s)).toContain("org.p:parent");
    // file_stories: one security story, one patch/minor story, one story for each of the two majors; the remote's refs do not change
    expect(gh.createdBodies().map((m) => m.labels)).toEqual([["Factory_go", "bug"], ["Factory_go", "enhancement"], ["enhancement"], ["enhancement"]]);
    expect(s.history.find((h) => h.id === "file_stories")?.output.trimEnd().split("\n").at(-1)).toBe(
      "Updates found: 6. Filed: 6 in 4 stories. Updated in open stories: 0. Skipped as already filed: 0. Tools not available: 0.",
    );
    expect(gh.remoteGit("for-each-ref")).toBe(before);
    expect(npmLog()).toContain("tokens=0");
    expect(npmLog()).toContain("npmrc=no");
    expect(npmLog()).toContain("versions:display-dependency-updates");
  });

  it("lists a vulnerable package that has no update row", async () => {
    addFiles({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    process.env.FAKE_NPM_OUTDATED = "{}";
    process.env.FAKE_NPM_OUTDATED_EXIT = "0";
    process.env.FAKE_NPM_AUDIT = audit("minimist", "high");
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(checkOut(s)).toContain("Vulnerable, no update row:\n- high minimist: Bad");
    expect(checkOut(s)).not.toContain("All dependencies are up to date.");
    expect(deps(s).advisories).toHaveLength(1);
  });

  it("prefers ./mvnw to FACTORY_MVN_BIN", async () => {
    addFiles({ "pom.xml": "<project/>", mvnw: `#!/bin/sh\ncat <<'EOF'\n${MAVEN}EOF\n` });
    process.env.FACTORY_MVN_BIN = join(gh.tmp, "no-such-mvn");
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(deps(s).updates.map((u: { name: string }) => u.name)).toContain("org.p:parent");
    expect(checkOut(s)).not.toContain("not found");
  });

  it("turns a missing or failing tool into a note and stays green", async () => {
    addFiles({ "pom.xml": "<project/>", "package.json": "{}" });
    process.env.FACTORY_MVN_BIN = join(gh.tmp, "no-such-mvn");
    process.env.FAKE_NPM_OUTDATED = JSON.stringify({ error: { code: "E404", summary: "nope" } });
    const s = await run();
    expect(s.status).toBe("succeeded");
    const text = checkOut(s);
    expect(text).toContain("Note: maven: mvn was not found");
    expect(text).toContain("Note: npm outdated: npm outdated failed: nope");
    expect(text).toContain("Note: npm audit: the repository has no package-lock.json");
    expect(text).not.toContain("All dependencies are up to date.");
    expect(text.trimEnd().split("\n").at(-1)).toBe("Updates found: 0 (0 security). Tools not available: 3. Incomplete: 0.");
    expect(text).toContain("Note: osv-scanner: osv-scanner is not installed; only npm audit marks updates as security");
    expect(deps(s).notes).toHaveLength(5);
  });

  it("treats npm outdated exit 2 as a failure", async () => {
    addFiles({ "package.json": "{}" });
    process.env.FAKE_NPM_OUTDATED = "{}";
    process.env.FAKE_NPM_OUTDATED_EXIT = "2";
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(checkOut(s)).toContain("Note: npm outdated: npm outdated failed with exit code 2");
  });

  const SHA = "a".repeat(40);
  const WORKFLOW = [
    "name: ci", "on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/checkout@v3", "      - { uses: actions/setup-go@v5 }", `      - uses: actions/cache@${SHA}`,
    "      - run: echo uses actions/evil@v1", "",
  ].join("\n");
  const row = (d: { updates: { name: string }[] }, n: string) => d.updates.find((u) => u.name === n);

  it("checks Gradle, pip, Go and Actions, and lets the OSV scanner mark security", async () => {
    addFiles({ "build.gradle": "", "requirements.txt": "", "go.mod": "module x\n", ".github/workflows/ci.yml": WORKFLOW });
    process.env.FACTORY_OSV_BIN = osvFake;
    process.env.FAKE_GRADLE_REPORT = JSON.stringify({
      outdated: { dependencies: [
        { group: "com.google.guava", name: "guava", version: "30.0-jre", available: { release: "33.0.0-jre" } },
        { group: "org.x", name: "y", version: "1.2.0", available: { release: null, milestone: "1.2.5" } },
      ] },
      unresolved: { count: 0 },
    });
    process.env.FAKE_PIP_OUT = JSON.stringify([{ name: "pkg", version: "1.0.post2", latest_version: "1.0.post10" }, { name: "requests", version: "2.0", latest_version: "2.1" }]);
    process.env.FAKE_GO_OUT = [
      { Path: "x", Main: true }, { Path: "github.com/a/b", Version: "v1.2.0", Update: { Version: "v1.3.0" } },
      { Path: "github.com/a/ind", Version: "v1.0.0", Indirect: true, Update: { Version: "v9.0.0" } },
    ].map((m) => JSON.stringify(m, null, 1)).join("\n");
    process.env.FAKE_OSV_OUT = JSON.stringify({ results: [{ packages: [{ package: { name: "github.com/a/b", version: "1.2.0", ecosystem: "Go" }, vulnerabilities: [{ id: "GO-1" }] }] }] });
    process.env.FAKE_GH_LATEST_RELEASES = JSON.stringify({ "actions/checkout": "v4.2.0", "actions/setup-go": "v5.1.0", "actions/cache": "v4.0.0" });
    process.env.FAKE_GH_TAG_SHAS = JSON.stringify({ "actions/cache@v4.0.0": "b".repeat(40) });
    const s = await run();
    expect(s.status).toBe("succeeded");
    const d = deps(s);
    expect(d.projects).toEqual(["gradle", "pip", "go", "actions"]);
    expect(row(d, "com.google.guava:guava")).toMatchObject({ tool: "gradle", class: "major", security: false });
    expect(row(d, "org.x:y")).toMatchObject({ tool: "gradle", class: "patch" });
    expect(row(d, "pkg")).toMatchObject({ tool: "pip", class: "patch" });
    expect(row(d, "requests")).toMatchObject({ tool: "pip", class: "minor" });
    expect(row(d, "github.com/a/b")).toMatchObject({ tool: "go", class: "minor", security: true });
    expect(row(d, "github.com/a/ind")).toBeUndefined();
    expect(row(d, "actions/checkout")).toMatchObject({ tool: "actions", kind: "action", current: "v3", latest: "v4.2.0", class: "major" });
    expect(row(d, "actions/setup-go")).toBeUndefined();
    expect(row(d, "actions/evil")).toBeUndefined();
    expect(d.notes).toContain("actions: not compared: actions/cache@aaaaaaa (newest release v4.0.0; its version is not known)");
    expect(d.notes).not.toContainEqual(expect.stringContaining("osv-scanner"));
    const out = checkOut(s);
    expect(out).toContain("actions/checkout");
    expect(out.trimEnd().split("\n").at(-1)).toBe("Updates found: 6 (1 security). Tools not available: 0. Incomplete: 1.");
    const calls = gh.ghLog();
    expect(calls).toContain("gh api repos/actions/checkout/releases/latest");
    expect(calls).toContain("gh api repos/actions/cache/commits/v4.0.0 --jq .sha");
    expect(calls).not.toContain("actions/evil");
    const log = npmLog();
    expect(log).toContain("osv --format json --recursive .");
    expect(log).toContain("gradle --no-daemon --console=plain dependencyUpdates");
    expect(log).toContain("pip list --outdated --format json");
    expect(log).toContain("tokens=0 config=/dev/null");
    expect(log).toContain("go list -m -u -json all toolchain=local");
  });

  it("does not run pip on the runner's packages when no project environment is configured", async () => {
    addFiles({ "requirements.txt": "requests==2.0\n" });
    delete process.env.FACTORY_PIP_BIN;
    process.env.FAKE_PIP_OUT = JSON.stringify([{ name: "runner-only", version: "1.0", latest_version: "2.0" }]);
    const s = await run();
    expect(s.status).toBe("succeeded");
    const d = deps(s);
    expect(d.notes).toContain(`pip: ${PIP_NOT_SET_NOTE}`);
    expect(d.notes).not.toContainEqual(expect.stringContaining("runner-only"));
    expect(d.updates).toEqual([]);
    expect(npmLog()).not.toContain("pip list");
    expect(checkOut(s)).not.toContain("All dependencies are up to date.");
  });

  it("turns missing tools, a Gradle build without the plugin and a failed lookup into notes", async () => {
    addFiles({ "build.gradle": "", "requirements.txt": "", "go.mod": "module x\n", ".github/workflows/ci.yml": WORKFLOW });
    process.env.FAKE_GRADLE_NO_PLUGIN = "1";
    process.env.FACTORY_PIP_BIN = join(gh.tmp, "no-such-pip");
    process.env.FACTORY_GO_BIN = join(gh.tmp, "no-such-go");
    process.env.FAKE_GH_FAIL_API = "release-latest";
    const s = await run();
    expect(s.status).toBe("succeeded");
    const d = deps(s);
    expect(d.notes).toContain("gradle: the Gradle versions plugin (com.github.ben-manes.versions) is not applied; Gradle was skipped");
    expect(d.notes).toContain("pip: pip was not found");
    expect(d.notes).toContain("go: go was not found");
    expect(d.notes).toContain("osv-scanner: osv-scanner is not installed; only npm audit marks updates as security");
    expect(d.notes.some((n: string) => n.startsWith("actions: the newest release of 3 actions could not be looked up"))).toBe(true);
    expect(d.updates).toEqual([]);
    expect(checkOut(s)).not.toContain("All dependencies are up to date.");
  });

  it("runs the OSV scanner for a repository with only workflows", async () => {
    addFiles({ ".github/workflows/ci.yml": WORKFLOW });
    process.env.FACTORY_OSV_BIN = osvFake;
    process.env.FAKE_OSV_OUT = JSON.stringify({ results: [{ packages: [{ package: { name: "actions/checkout", version: "v3", ecosystem: "GitHub Actions" }, vulnerabilities: [{ id: "A" }] }] }] });
    process.env.FAKE_GH_LATEST_RELEASES = JSON.stringify({ "actions/checkout": "v4.2.0", "actions/setup-go": "v5.1.0", "actions/cache": "v4.0.0" });
    process.env.FAKE_GH_TAG_SHAS = JSON.stringify({ "actions/cache@v4.0.0": SHA });
    const s = await run();
    expect(s.status).toBe("succeeded");
    const d = deps(s);
    expect(d.projects).toEqual(["actions"]);
    expect(d.updates).toHaveLength(1);
    expect(row(d, "actions/checkout")).toMatchObject({ security: true, class: "major" });
    expect(d.notes).toEqual([]);
    expect(npmLog()).toContain("osv --format json --recursive .");
  });
});

describe("deps-weekly schedule", () => {
  let tmp: string;
  let scheduler: Scheduler;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-deps-"));
    mkdirSync(join(tmp, "runs"));
    scheduler = new Scheduler({ runsDir: join(tmp, "runs"), config: () => ConfigSchema.parse({ concurrency: 1 }) });
    scheduler.drain();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const lastRun = (daysAgo: number) => {
    const runDir = join(tmp, "runs", "20260101-000000-aaaa");
    mkdirSync(runDir, { recursive: true });
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      runId: "20260101-000000-aaaa", flow: "deps-weekly", task: "t", repo: tmp, runDir, status: "succeeded",
      vars: { github_repo: "acme/app", chore_watcher: "deps" }, startedAt: at, finishedAt: at, totalCostUsd: 0, history: [],
    }));
  };
  const tick = async () => {
    const w = new Watcher(WatcherSchema.parse({ id: "deps", github_repo: "acme/app", source: "schedule", flow: "deps-weekly", every: "7d", task: "Weekly dependency check" }), {
      scheduler, runsDir: join(tmp, "runs"), repo: tmp, log: () => undefined,
    });
    await (w as unknown as { tickChore(): Promise<void> }).tickChore();
    return scheduler.queue().pending.map((p) => scheduler.queuedJob(p.runId)!.job);
  };

  it("queues a run when there is none", async () => {
    const q = await tick();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ vars: { chore_watcher: "deps", github_repo: "acme/app" } });
  });
  it("queues none one day after the last run", async () => {
    lastRun(1);
    expect(await tick()).toHaveLength(0);
  });
  it("queues one eight days after the last run", async () => {
    lastRun(8);
    expect(await tick()).toHaveLength(1);
  });
});
