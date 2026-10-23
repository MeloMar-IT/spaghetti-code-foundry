import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { TOOLS_DIR } from "../src/engine/guards.js";
import { resetSandboxCache, sandboxAvailable } from "../src/engine/os-sandbox.js";
import { runFlow } from "../src/engine/runner.js";
import { hasCommit } from "../src/release/build-claims.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { parseFlow } from "../src/flow/load.js";
import { runProcess } from "../src/steps/process.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// A user's shell steps run inside `sandbox-exec` on macOS. These tests use the real program (a system program, not a service).
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
if (!basic) console.warn(`os-sandbox-run tests skipped: ${process.platform === "darwin" ? "sandbox-exec does not work here (perhaps this process is already inside a sandbox)" : "they need macOS"}`);

const hereGit = spawnSync("/usr/bin/which", ["git"], { encoding: "utf8" }).stdout.trim();
const config = () => ConfigSchema.parse({ protected_branches: [], sandbox: { user_read: [resolve("tests/fixtures"), ...(hereGit ? [resolve(hereGit, "..")] : [])] } });

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };
let saved: Record<string, string | undefined>;
const runs = () => join(gh.tmp, "runs");

describe.skipIf(!basic)("a user's shell step in the OS sandbox", () => {
  beforeEach(async () => {
    saved = { FACTORY_HOME: process.env.FACTORY_HOME, FACTORY_LOCK_DIR: process.env.FACTORY_LOCK_DIR, SCF_USER_SANDBOX: process.env.SCF_USER_SANDBOX };
    gh = fakeGithub();
    process.env.FACTORY_HOME = join(gh.tmp, "home");
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "home", "locks");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    delete process.env.SCF_USER_SANDBOX;
    resetSandboxCache();
    kc = fakeKeychain();
    resetRedactCache();
    admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
    user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
    addRepo(user.id, { url: "acme/app", method: "none" });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(join(TOOLS_DIR, "zz-probe"), { force: true });
    resetSandboxCache();
    resetRedactCache();
    kc.remove();
    gh.restore();
  });

  const flowOf = (...cmds: string[]) =>
    parseFlow(`name: box\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${cmds.map((c, i) => `  - id: s${i + 1}\n    type: shell\n    run: ${JSON.stringify(c)}\n`).join("")}`, "box.yaml");
  const go = (flow: ReturnType<typeof flowOf>, owner: string, runId?: string) =>
    runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: config(), owner, ...(runId ? { runId } : {}) });
  const out = (s: { history: { id: string; output: string }[] }, id = "s1") => (s.history.find((h) => h.id === id)?.output ?? "").trim();

  it("holds the generated profile: sandboxAvailable() is true", () => {
    expect(sandboxAvailable()).toBe(true);
  });

  it("cannot read another run, users.json or the gh folder of another step", async () => {
    mkdirSync(join(runs(), "other"), { recursive: true });
    writeFileSync(join(runs(), "other", "secret.txt"), "OTHER-RUN-SECRET");
    mkdirSync(join(gh.tmp, "scf-gh-other"));
    writeFileSync(join(gh.tmp, "scf-gh-other", "hosts.yml"), "GH-SECRET");
    const s = await go(flowOf(`cat ${runs()}/other/secret.txt; cat "$FACTORY_HOME/users.json"; cat ${gh.tmp}/scf-gh-other/hosts.yml; echo done`), user.id);
    const text = out(s);
    expect(text).not.toContain("OTHER-RUN-SECRET");
    expect(text).not.toContain("GH-SECRET");
    expect(text).not.toContain("password");
    expect(text).toMatch(/Operation not permitted/);
  });

  it("cannot write outside its run folder, to its own run.json or to tools/", async () => {
    const outside = join(gh.tmp, "outside.txt");
    const s = await go(flowOf(`echo x > ${outside}; echo x >> "{{run.dir}}/run.json"; echo x > "$FACTORY_TOOLS/zz-probe"; echo x > "{{run.dir}}/live.log"; echo end`), user.id);
    expect(out(s)).toMatch(/Operation not permitted/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(TOOLS_DIR, "zz-probe"))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).runId).toBe(s.runId);
  });

  it("can write in the workspace, tmp and the run folder, and run git and node, with its own HOME and TMPDIR", async () => {
    const s = await go(
      flowOf(
        `echo a > "$FACTORY_WORKDIR/w.txt" && echo b > "$TMPDIR/t.txt" && echo c > "{{run.dir}}/tests.log" && git init -q x && echo "$HOME|$TMPDIR" && node -e "console.log(1+1)" && touch "$GH_CONFIG_DIR/x" && cat ${resolve("tests/fixtures/fake-gh.sh")} > /dev/null && echo ok`,
      ),
      user.id,
    );
    expect(s.status, out(s)).toBe("succeeded");
    const real = realpathSync(s.runDir);
    expect(out(s)).toContain(`${s.runDir}/home|${s.runDir}/tmp`);
    expect(out(s)).toContain("\n2\n");
    for (const d of ["home", "tmp"]) expect(statSync(join(real, d)).mode & 0o777).toBe(0o700);
  });

  it("cannot make hard links or clones of files it may not read or write", async () => {
    const s = await go(flowOf(`ln "{{run.dir}}/run.json" "$FACTORY_WORKDIR/l1"; ln "$FACTORY_HOME/users.json" "$FACTORY_WORKDIR/l2"; cp -c "$FACTORY_HOME/users.json" "$FACTORY_WORKDIR/l3"; ls "$FACTORY_WORKDIR"`), user.id);
    for (const n of ["l1", "l2", "l3"]) expect(existsSync(join(s.workdir!, n)), n).toBe(false);
    expect(out(s)).toMatch(/Operation not permitted/);
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).runId).toBe(s.runId);
  });

  it("makes home and tmp real folders again when an earlier step left links there", async () => {
    mkdirSync(join(gh.tmp, "elsewhere"), { mode: 0o755 });
    const elsewhere = join(gh.tmp, "elsewhere");
    const s = await go(flowOf(`rm -rf "{{run.dir}}/home" "{{run.dir}}/tmp"; ln -s ${elsewhere} "{{run.dir}}/home"; ln -s ${elsewhere} "{{run.dir}}/tmp"; echo one`, `ls -ld "$HOME" "$TMPDIR" | cut -c1-10`), user.id);
    expect(out(s, "s2")).toBe("drwx------\ndrwx------");
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
  });

  it("can take an area lock, which holds a marker, and cannot remove the marker", async () => {
    const s = await go(flowOf(`"$FACTORY_TOOLS/area-lock" acquire "$FACTORY_RUN_ID" "{{run.dir}}" src/a --wait-sec 0; rm -f "$FACTORY_LOCK_DIR/.running/$FACTORY_RUN_ID"; ls "$FACTORY_LOCK_DIR/.running"`), user.id);
    expect(out(s)).toContain("LOCKED: src/a");
    expect(out(s)).toContain(s.runId);
    const lockFile = join(gh.tmp, "home", "locks", "acme_app");
    expect(existsSync(lockFile)).toBe(true);
  });

  it("appends to its learnings file", async () => {
    const s = await go(flowOf(`mkdir -p "$(dirname "$FACTORY_LEARNINGS_FILE")" && echo learned >> "$FACTORY_LEARNINGS_FILE" && echo ok`), user.id);
    expect(s.status, out(s)).toBe("succeeded");
  });

  it("an admin's run is not held: server's HOME, other runs readable", async () => {
    mkdirSync(join(runs(), "other"), { recursive: true });
    writeFileSync(join(runs(), "other", "secret.txt"), "OTHER-RUN-SECRET");
    const s = await go(flowOf(`cat ${runs()}/other/secret.txt`), admin.id);
    expect(out(s)).toContain("OTHER-RUN-SECRET");
  });

  it("runProcess with a profile kills a background process on timeout and hides pinned secrets in the log", async () => {
    const log = join(gh.tmp, "p.log");
    const t = await runProcess("/bin/sh", ["-c", "sleep 30 & wait"], { cwd: gh.tmp, logFile: log, timeoutMs: 300, ownGroup: true, sandboxProfile: "(version 1)(allow default)" });
    expect(t.timedOut).toBe(true);
    const r = await runProcess("/bin/sh", ["-c", "echo SECRET-VALUE-12345; echo SECRET-VALUE-12345 >&2"], { cwd: gh.tmp, logFile: log, pinnedSecrets: ["SECRET-VALUE-12345"], sandboxProfile: "(version 1)(allow default)" });
    expect(r.stdout + r.stderr + readFileSync(log, "utf8")).not.toContain("SECRET-VALUE-12345");
  });

  it("an automatic release-build run of a user takes its commit on the server, outside the sandbox", async () => {
    const sha = "e".repeat(40);
    const flow = parseFlow(
      `name: release-build\nworkspace: empty\nvars: { github_repo: acme/app, ref: main }\nsteps:\n` +
        `  - id: resolve\n    type: shell\n    run: ${JSON.stringify(`mkdir -p "{{run.dir}}/release" && echo '{"sha":"${sha}","recipe":{}}' > "{{run.dir}}/release/plan.json" && echo resolved`)}\n`,
      "release-build.yaml",
    );
    const start = () =>
      runFlow(flow, { task: "t", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app", ref: "main", release_build_watcher: "rel" }, config: config(), owner: user.id, source: "watcher rel release-build" });
    const one = await start();
    expect(one.status, out(one, "resolve")).toBe("succeeded");
    expect(hasCommit("acme/app", "main", sha)).toBe(true);
    // the step itself could not have written there
    const direct = await go(flowOf(`mkdir -p "${process.env.FACTORY_HOME}/release-builds/x" && echo no`), user.id);
    expect(direct.status).toBe("failed");
    const two = await start();
    expect(JSON.parse(readFileSync(join(two.runDir, "release", "plan.json"), "utf8"))).toEqual({ sha, skip: "this commit was handled before" });
  });

  it("cannot read the delivery keys, also a key made while the step runs and with user_read over the data folder", async () => {
    const data = process.env.FACTORY_HOME!;
    const keys = join(data, "delivery-keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "signing-key"), "OLD-KEY-SECRET", { mode: 0o600 });
    writeFileSync(join(data, "plain.txt"), "DATA-OK");
    const runId = "20261023-000000-dk01";
    const runDir = join(runs(), runId);
    const cfg = ConfigSchema.parse({ protected_branches: [], sandbox: { user_read: [resolve("tests/fixtures"), data, ...(hereGit ? [resolve(hereGit, "..")] : [])] } });
    const cmd =
      `echo WORKSPACE-OK > "$FACTORY_WORKDIR/w.txt"; touch "{{run.dir}}/started"; i=0; while [ ! -f "{{run.dir}}/go" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done; ` +
      `cat "${keys}/signing-key"; cat "${keys}/signing-key.new"; cat "$FACTORY_WORKDIR/w.txt"; cat "${data}/plain.txt"; echo end`;
    const ac = new AbortController();
    const p = runFlow(flowOf(cmd), { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: cfg, owner: user.id, runId, signal: ac.signal });
    let failed: unknown;
    p.catch((e) => {
      failed = e;
    });
    let done = false;
    try {
      for (let i = 0; i < 1000 && !failed && !existsSync(join(runDir, "started")); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(join(runDir, "started")), "the step did not start").toBe(true);
      writeFileSync(join(keys, "signing-key.new"), "NEW-KEY-SECRET", { mode: 0o600 });
      writeFileSync(join(runDir, "go"), "");
      const s = await p;
      done = true;
      const text = out(s);
      expect(text).not.toContain("OLD-KEY-SECRET");
      expect(text).not.toContain("NEW-KEY-SECRET");
      expect(text).toContain("WORKSPACE-OK");
      expect(text).toContain("DATA-OK");
      expect(text).toContain("end");
      expect(text).toMatch(/Operation not permitted/);
    } finally {
      if (!done) ac.abort();
      await p.catch(() => {});
    }
  });

  it("records whether a profile nests (for #305): a step that starts sandbox-exec itself", async () => {
    const s = await go(flowOf(`/usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/true; echo "nested=$?"`), user.id);
    // sandbox-exec cannot apply a second profile inside a sandbox: it fails (non-zero). #305 must not start an agent's own sandbox inside this one.
    const nested = /nested=(\d+)/.exec(out(s))?.[1];
    expect(nested).toBeDefined();
    expect(nested).not.toBe("0");
  });
});
