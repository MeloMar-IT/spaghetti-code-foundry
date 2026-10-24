import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { resetSandboxCache, SANDBOX_REFUSED } from "../src/engine/os-sandbox.js";
import { runFlow, resumeRun } from "../src/engine/runner.js";
import { markRunning, sweepRunning, sweepStaleRunning, unmarkRunning } from "../src/engine/running.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const lock = () => process.env.FACTORY_LOCK_DIR!;
const markers = () => {
  try {
    return readdirSync(join(lock(), ".running"));
  } catch {
    return [];
  }
};
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_LOCK_DIR;
  process.env.FACTORY_LOCK_DIR = mkdtempSync(join(tmpdir(), "running-"));
});
afterEach(() => {
  process.env.FACTORY_LOCK_DIR = saved;
});

describe("the running marker", () => {
  it("is written with a token, and no temp file is left", () => {
    const token = markRunning("r1");
    expect(token).toBeTruthy();
    expect(markers()).toEqual(["r1"]);
    expect(readFileSync(join(lock(), ".running", "r1"), "utf8")).toBe(token);
  });

  it("is removed only with the right token", () => {
    const token = markRunning("r1");
    unmarkRunning("r1", "wrong");
    unmarkRunning("r1", undefined);
    expect(markers()).toEqual(["r1"]);
    unmarkRunning("r1", token);
    expect(markers()).toEqual([]);
  });

  it("two holders: the first one's removal leaves the marker, the second one's removes it", () => {
    const first = markRunning("r1");
    const second = markRunning("r1");
    unmarkRunning("r1", first);
    expect(markers()).toEqual(["r1"]);
    unmarkRunning("r1", second);
    expect(markers()).toEqual([]);
  });

  it("returns undefined and does not throw when it cannot be written", () => {
    const file = join(lock(), "blocked");
    writeFileSync(file, "x");
    process.env.FACTORY_LOCK_DIR = file;
    expect(markRunning("r1")).toBeUndefined();
  });
});

describe("sweepRunning", () => {
  const runsDir = () => join(lock(), "runs");
  const run = (id: string, status: string | "bad") => {
    mkdirSync(join(runsDir(), id), { recursive: true });
    writeFileSync(join(runsDir(), id, "run.json"), status === "bad" ? "{ nope" : JSON.stringify({ status, pid: 999999 }));
  };

  it("removes markers of ended or deleted runs and keeps those of running or unreadable ones", () => {
    run("ended", "failed");
    run("live", "running");
    run("broken", "bad");
    for (const id of ["ended", "live", "broken", "gone"]) markRunning(id);
    sweepRunning(runsDir());
    expect(markers().sort()).toEqual(["broken", "live"]);
  });

  it("does not wait for a pipe or follow a link in the lock folder, and takes the run folder from the run id", () => {
    run("ended", "failed");
    mkdirSync(join(lock(), "repo"), { recursive: true });
    execFileSync("mkfifo", [join(lock(), "repo", "evil.json")]);
    writeFileSync(join(lock(), "target"), JSON.stringify({ runId: "ended" }));
    symlinkSync(join(lock(), "target"), join(lock(), "repo", "link.json"));
    // a lock whose own runDir points at a folder that says "failed" while the real run still runs
    run("live", "running");
    const elsewhere = join(lock(), "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "run.json"), JSON.stringify({ status: "failed" }));
    writeFileSync(join(lock(), "repo", "forged.json"), JSON.stringify({ runId: "live", runDir: elsewhere, areas: ["x"] }));
    writeFileSync(join(lock(), "repo", "dots.json"), JSON.stringify({ runId: "../elsewhere", runDir: elsewhere, areas: ["x"] }));
    sweepRunning(runsDir());
    expect(readdirSync(join(lock(), "repo")).sort()).toEqual(["dots.json", "evil.json", "forged.json", "link.json"]);
  });

  it("removes a temp file older than a minute and keeps a fresh one", () => {
    markRunning("x");
    const old = join(lock(), ".running", ".tmp-old");
    writeFileSync(old, "");
    writeFileSync(join(lock(), ".running", ".tmp-new"), "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(old, past, past);
    sweepRunning(runsDir());
    expect(markers()).toContain(".tmp-new");
    expect(markers()).not.toContain(".tmp-old");
  });

  it("removes a lock without the flag of an ended run, keeps a running one and a marker lock", () => {
    run("ended", "failed");
    run("live", "running");
    mkdirSync(join(lock(), "repo"), { recursive: true });
    const put = (name: string, body: object) => writeFileSync(join(lock(), "repo", name), JSON.stringify(body));
    put("a.json", { runId: "ended", runDir: join(runsDir(), "ended"), areas: ["x"] });
    put("b.json", { runId: "live", runDir: join(runsDir(), "live"), areas: ["y"] });
    put("c.json", { runId: "ended", runDir: join(runsDir(), "ended"), areas: ["z"], marker: true });
    sweepRunning(runsDir());
    expect(readdirSync(join(lock(), "repo")).sort()).toEqual(["b.json", "c.json"]);
  });
});

describe("sweepStaleRunning", () => {
  const runsDir = () => join(lock(), "runs");
  const run = (id: string, o: { status?: string; pid?: number; bad?: boolean; ageMs?: number } = {}) => {
    mkdirSync(join(runsDir(), id), { recursive: true });
    const f = join(runsDir(), id, "run.json");
    writeFileSync(f, o.bad ? "{ nope" : JSON.stringify({ status: o.status ?? "running", pid: o.pid ?? 999999 }));
    if (o.ageMs) {
      const t = new Date(Date.now() - o.ageMs);
      utimesSync(f, t, t);
    }
  };
  const put = (name: string, body: object) => {
    mkdirSync(join(lock(), "repo"), { recursive: true });
    writeFileSync(join(lock(), "repo", name), JSON.stringify(body));
  };
  const left = () => readdirSync(join(lock(), "repo")).sort();

  it("at start removes markers of dead, own, old-boot, unreadable and missing runs and keeps active and live ones", () => {
    run("dead");
    run("own", { pid: process.pid });
    run("oldboot", { pid: process.ppid, ageMs: 3600_000 });
    run("broken", { bad: true });
    run("active");
    run("live", { pid: process.ppid });
    for (const id of ["dead", "own", "oldboot", "broken", "missing", "active", "live"]) markRunning(id);
    const res = sweepStaleRunning(runsDir(), (id) => id === "active", { atStart: true, bootMs: Date.now() });
    expect(markers().sort()).toEqual(["active", "live"]);
    expect(res.markers.sort()).toEqual(["broken", "dead", "missing", "oldboot", "own"]);
  });

  it("keeps a run.json that cannot be read while the server runs", () => {
    run("broken", { bad: true });
    markRunning("broken");
    expect(sweepStaleRunning(runsDir(), () => false, { atStart: false }).markers).toEqual([]);
    expect(markers()).toEqual(["broken"]);
  });

  it("frees the locks of removed runs and lists them; keeps the others", () => {
    run("dead");
    run("active");
    run("elsewhere-dead");
    markRunning("dead");
    put("a.json", { runId: "dead", runDir: join(runsDir(), "dead"), areas: ["x", "y"], marker: true });
    put("b.json", { runId: "active", runDir: join(runsDir(), "active"), areas: ["z"], marker: true });
    put("c.json", { runId: "elsewhere-dead", runDir: join(runsDir(), "elsewhere-dead"), areas: ["w"] });
    put("d.json", { runId: "notmine", runDir: "/nowhere", areas: ["v"] });
    const res = sweepStaleRunning(runsDir(), (id) => id === "active", { atStart: false });
    expect(left()).toEqual(["b.json", "d.json"]);
    expect(res.locks.map((l) => [l.runId, l.repo, l.areas]).sort()).toEqual([
      ["dead", "repo", ["x", "y"]],
      ["elsewhere-dead", "repo", ["w"]],
    ]);
  });

  it("leaves pipes, links, forged run dirs and ../ alone", () => {
    execFileSync("mkfifo", [join(lock(), "evil.json")]);
    mkdirSync(join(lock(), "repo"), { recursive: true });
    execFileSync("mkfifo", [join(lock(), "repo", "evil.json")]);
    writeFileSync(join(lock(), "target"), JSON.stringify({ runId: "dead", marker: true }));
    symlinkSync(join(lock(), "target"), join(lock(), "repo", "link.json"));
    run("live", { pid: process.ppid });
    const elsewhere = join(lock(), "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "run.json"), JSON.stringify({ status: "failed" }));
    put("forged.json", { runId: "live", runDir: elsewhere, areas: ["x"] });
    put("dots.json", { runId: "../elsewhere", runDir: elsewhere, areas: ["x"] });
    sweepStaleRunning(runsDir(), () => false, { atStart: true, bootMs: Date.now() - 3600_000 });
    expect(left()).toEqual(["dots.json", "evil.json", "forged.json", "link.json"]);
  });

  it("lets a waiting area-lock take over from a dead run", () => {
    run("r1");
    markRunning("r1");
    const tool = resolve("tools/area-lock");
    const al = (...args: string[]) => {
      try {
        return execFileSync("node", [tool, "acquire", ...args, "--wait-sec", "0"], { env: { ...process.env, FACTORY_VAR_GITHUB_REPO: "acme/app", AREA_LOCK_POLL_MS: "10" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return String((e as { stdout?: string }).stdout);
      }
    };
    expect(al("r1", join(runsDir(), "r1"), "@develop")).toContain("LOCKED");
    expect(al("r2", join(runsDir(), "r2"), "@develop")).toContain("TIMEOUT");
    sweepStaleRunning(runsDir(), () => false);
    expect(al("r2", join(runsDir(), "r2"), "@develop")).toContain("LOCKED");
  });
});

describe("area-lock wait file", () => {
  const tool = resolve("tools/area-lock");
  const env = { ...process.env, FACTORY_VAR_GITHUB_REPO: "acme/app", AREA_LOCK_POLL_MS: "50" };
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(ok()).toBe(true);
  };
  const exit = (c: ChildProcess) => new Promise<number | null>((r) => c.on("close", r));

  it("exists while it waits for another run, and is gone on LOCKED and on TIMEOUT", async () => {
    const runs = join(lock(), "runs");
    mkdirSync(join(runs, "r1"), { recursive: true });
    mkdirSync(join(runs, "r2"), { recursive: true });
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ status: "running" }));
    execFileSync("node", [tool, "acquire", "r1", join(runs, "r1"), "@develop", "--wait-sec", "0"], { env });
    const wait = join(runs, "r2", "area-wait.json");
    const c = spawn("node", [tool, "acquire", "r2", join(runs, "r2"), "@develop", "--wait-sec", "5"], { env, stdio: "ignore" });
    const done = exit(c);
    await until(() => existsSync(wait) && JSON.parse(readFileSync(wait, "utf8")).waitingFor === "r1");
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ status: "failed" }));
    expect(await done).toBe(0);
    expect(existsSync(wait)).toBe(false);

    // r2 holds it now; r3 times out
    writeFileSync(join(runs, "r2", "run.json"), JSON.stringify({ status: "running" }));
    mkdirSync(join(runs, "r3"), { recursive: true });
    const t = spawn("node", [tool, "acquire", "r3", join(runs, "r3"), "@develop", "--wait-sec", "0.3"], { env, stdio: "ignore" });
    expect(await exit(t)).toBe(1);
    expect(existsSync(join(runs, "r3", "area-wait.json"))).toBe(false);
  });
});

describe("area-lock with a marker", () => {
  const tool = resolve("tools/area-lock");
  const al = (...args: string[]) =>
    execFileSync("node", [tool, "acquire", ...args, "--wait-sec", "0"], { env: { ...process.env, FACTORY_VAR_GITHUB_REPO: "acme/app", AREA_LOCK_POLL_MS: "10" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const alTry = (...args: string[]) => {
    try {
      return al(...args);
    } catch (e) {
      return String((e as { stdout?: string }).stdout);
    }
  };
  const lockFiles = () => readdirSync(join(lock(), "acme_app")).filter((f) => f.endsWith(".json"));

  it("stores the flag when the run has a marker, blocks an overlap, and is freed when the marker goes", () => {
    const runs = join(lock(), "runs");
    mkdirSync(join(runs, "r1"), { recursive: true });
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ status: "running" }));
    const token = markRunning("r1");
    expect(al("r1", join(runs, "r1"), "src/a")).toContain("LOCKED");
    expect(JSON.parse(readFileSync(join(lock(), "acme_app", lockFiles()[0]), "utf8")).marker).toBe(true);
    expect(alTry("r2", join(runs, "r2"), "src/a")).toContain("TIMEOUT");
    // the run.json is not looked at for a lock with the flag
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ status: "failed" }));
    expect(alTry("r2", join(runs, "r2"), "src/a")).toContain("TIMEOUT");
    unmarkRunning("r1", token);
    expect(al("r2", join(runs, "r2"), "src/a")).toContain("LOCKED");
  });

  it("a lock without the flag still follows run.json; a run.json that cannot be read counts as running", () => {
    const runs = join(lock(), "runs");
    mkdirSync(join(runs, "r1"), { recursive: true });
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ status: "running" }));
    expect(al("r1", join(runs, "r1"), "src/a")).toContain("LOCKED"); // no marker: no flag
    expect(JSON.parse(readFileSync(join(lock(), "acme_app", lockFiles()[0]), "utf8")).marker).toBeUndefined();
    expect(alTry("r2", join(runs, "r2"), "src/a")).toContain("TIMEOUT");
    writeFileSync(join(runs, "r1", "run.json"), JSON.stringify({ status: "failed" }));
    expect(al("r2", join(runs, "r2"), "src/a")).toContain("LOCKED");
    expect(existsSync(join(runs, "r1", "run.json"))).toBe(true);
  });
});

describe("a user's run on a computer without a sandbox", () => {
  let admin: { id: string };
  let user: { id: string };
  let savedEnv: string | undefined;
  beforeAll(async () => {
    admin = await createUser({ name: "A", email: "a@example.com", password: TEST_PASSWORD, role: "admin" });
    user = await createUser({ name: "U", email: "u@example.com", password: TEST_PASSWORD, role: "user" });
  });
  beforeEach(() => {
    savedEnv = process.env.SCF_USER_SANDBOX;
    delete process.env.SCF_USER_SANDBOX;
    resetSandboxCache(false);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SCF_USER_SANDBOX;
    else process.env.SCF_USER_SANDBOX = savedEnv;
    resetSandboxCache();
  });

  const flow = () => parseFlow("name: refuse\nworkspace: empty\nsteps:\n  - id: s1\n    type: shell\n    run: echo hi\n", "refuse.yaml");
  const start = (owner: string, runsDir: string) => runFlow(flow(), { task: "t", repo: runsDir, runsDir, claudeBin, config: ConfigSchema.parse({ protected_branches: [] }), owner });

  it("is refused before any step, at the start and on resume; an admin's run goes on", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "refuse-"));
    const s = await start(user.id, runsDir);
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(SANDBOX_REFUSED);
    expect(s.history).toEqual([]);
    const again = await resumeRun({ runsDir, runId: s.runId, from: "s1", config: ConfigSchema.parse({ protected_branches: [] }), claudeBin });
    expect(again.status).toBe("failed");
    expect(again.reason).toBe(SANDBOX_REFUSED);
    expect(again.history).toEqual([]);
    expect((await start(admin.id, runsDir)).status).toBe("succeeded");
  });

  it("goes on when the setting allows it", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "refuse-"));
    const s = await runFlow(flow(), { task: "t", repo: runsDir, runsDir, claudeBin, config: ConfigSchema.parse({ protected_branches: [], sandbox: { user_runs: "off" } }), owner: user.id });
    expect(s.status).toBe("succeeded");
  });
});
