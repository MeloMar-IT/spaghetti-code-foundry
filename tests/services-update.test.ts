import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceAccount, lookupServiceToken } from "../src/auth/service-accounts.js";
import { createUser, setStatus } from "../src/auth/users.js";
import type { ServiceConfig } from "../src/config.js";
import { ServiceSupervisor, type ServiceAuditEvent, type SupervisorOptions } from "../src/services/supervisor.js";
import { accountProblem, managedAccounts } from "../src/services/setup.js";
import { rawPublicKey } from "../src/skills/release-signature.js";
import { Watched } from "./helpers/stray-procs.js";

// Applying a changed `services:` list while the supervisor runs (#941).

const FIXTURE = resolve("tests/fixtures/services/fake-service.mjs");
const FAST = { firstMs: 20, maxMs: 80, stableMs: 10_000 };
let home: string;
let program: string;
let saved: string | undefined;
let sups: ServiceSupervisor[] = [];

beforeAll(() => chmodSync(FIXTURE, 0o755));
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-upd-"));
  process.env.FACTORY_HOME = home;
  program = join(home, "svc.mjs"); // a copy, so a .sig file here never meets another test file
  copyFileSync(FIXTURE, program);
  chmodSync(program, 0o755);
});
afterEach(async () => {
  const watched = new Watched();
  try {
    for (const s of sups) await s.stop();
  } finally {
    // a program that ignores SIGTERM leads a group of its own: it is killed whatever happened above
    for (const f of readdirSync(home).filter((n) => n.endsWith(".out"))) {
      for (const r of starts(f.slice(0, -4))) if (r.argv.includes("--ignore-term")) watched.pid(r.pid, r.pid);
    }
    watched.kill();
  }
  sups = [];
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const out = (n: string) => join(home, `${n}.out`);
const cfg = (name: string, args: string[] = [], over: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, command: program, args: ["--out", out(name), ...args], env: {}, scope: ["GET health"], ...over,
});
const make = (services: ServiceConfig[], over: Partial<SupervisorOptions> = {}) => {
  const lines: string[] = [];
  const audits: ServiceAuditEvent[] = [];
  const s = new ServiceSupervisor({
    services, home, runsDir: join(home, "runs"), url: "http://127.0.0.1:1", log: (l) => lines.push(l), checkScope: () => undefined,
    backoff: FAST, graceMs: 300, audit: (e) => audits.push(e), ...over,
  });
  sups.push(s);
  return Object.assign(s, { lines, audits });
};
const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const outText = (n: string) => (existsSync(out(n)) ? readFileSync(out(n), "utf8") : "");
const starts = (n: string) => outText(n).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { argv: string[]; token: string; pid: number });
const last = (n: string) => starts(n).at(-1)!;
const live = (t: string) => lookupServiceToken(t)?.state === "live";
const view = (s: ServiceSupervisor, n: string) => s.view().find((v) => v.name === n);
const logText = (n: string) => readFileSync(join(home, "services", `${n}.log`), "utf8");
const actions = (s: { audits: ServiceAuditEvent[] }, action: string, target: string) => s.audits.filter((a) => a.action === action && a.target === target);

describe("update: add, remove, change", () => {
  it("starts a new entry and leaves the others alone", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    const pid = last("a").pid;
    await s.update([cfg("a"), cfg("b")]);
    await until(() => starts("b").length === 1, "b");
    expect(starts("a")).toHaveLength(1);
    expect(last("a").pid).toBe(pid);
    expect(s.view().map((v) => v.name)).toEqual(["a", "b"]);
    expect(actions(s, "service-start", "b")).toHaveLength(1);
    expect(actions(s, "service-start", "a")).toHaveLength(0);
  });

  it("stops a removed entry, revokes its token and keeps the others", async () => {
    const s = make([cfg("a"), cfg("b")]);
    s.start();
    await until(() => starts("a").length === 1 && starts("b").length === 1, "both");
    const a = last("a");
    const b = last("b");
    await s.update([cfg("a")]);
    await until(() => outText("b").includes("term"), "b stopped");
    expect(live(b.token)).toBe(false);
    expect(live(a.token)).toBe(true);
    expect(last("a").pid).toBe(a.pid);
    expect(s.view().map((v) => v.name)).toEqual(["a"]);
    expect(logText("b")).toContain("stopped (removed from config.yaml)");
    expect(actions(s, "service-stop", "b")).toMatchObject([{ result: "ok" }]);
  });

  it("restarts only the changed entry, with a new token", async () => {
    const s = make([cfg("a"), cfg("b")]);
    s.start();
    await until(() => starts("a").length === 1 && starts("b").length === 1, "both");
    const a = last("a");
    const b = last("b");
    await s.update([cfg("a", ["--x"]), cfg("b")]);
    await until(() => starts("a").length === 2, "a restarted");
    expect(last("a").pid).not.toBe(a.pid);
    expect(last("a").token).not.toBe(a.token);
    expect(live(a.token)).toBe(false);
    expect(live(last("a").token)).toBe(true);
    expect(starts("b")).toHaveLength(1);
    expect(live(b.token)).toBe(true);
    expect(view(s, "a")).toMatchObject({ state: "running", restarts: 0 });
    expect(actions(s, "service-stop", "a")).toHaveLength(1);
    expect(actions(s, "service-start", "a")).toHaveLength(1);
  });

  it("the same list again does nothing", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    await s.update([cfg("a")]);
    expect(starts("a")).toHaveLength(1);
    expect(s.audits).toEqual([]);
  });

  it("two updates without await end in the second list, one process per name", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    void s.update([cfg("a"), cfg("b")]);
    void s.update([cfg("a", ["--v2"])]);
    const done = s.update([cfg("a", ["--v3"]), cfg("c")]);
    await done;
    await until(() => starts("c").length === 1 && starts("a").length === 2, "end state");
    expect(last("a").argv).toContain("--v3");
    expect(starts("b")).toHaveLength(0);
    expect(s.view().map((v) => v.name)).toEqual(["a", "c"]);
    expect(live(starts("a")[0]!.token)).toBe(false);
  });

  it("a new entry starts quickly while other services ignore SIGTERM and are changed or removed", async () => {
    const s = make([cfg("a", ["--ignore-term"]), cfg("b", ["--ignore-term"])], { graceMs: 2000 });
    s.start();
    await until(() => starts("a").length === 1 && starts("b").length === 1, "both");
    const t0 = Date.now();
    const done = s.update([cfg("a", ["--ignore-term", "--x"]), cfg("n")]);
    await until(() => starts("n").length === 1, "n", 1500);
    expect(Date.now() - t0).toBeLessThan(1500);
    await done;
    expect(s.view().map((v) => v.name)).toEqual(["a", "n"]);
  });

  it("a changed-back entry clears a pending refused change", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    await s.update([cfg("a", [], { acts_for: "nobody-here" })]);
    expect(view(s, "a")!.problem).toContain("the change in config.yaml is not applied");
    await s.update([cfg("a")]);
    expect(view(s, "a")!.problem).toBeUndefined();
    expect(starts("a")).toHaveLength(1);
  });
});

describe("update: checks on a change", () => {
  const keys = generateKeyPairSync("ed25519");
  const pub = rawPublicKey(keys.publicKey);

  it("keeps the old process when the signature is missing, shows why, applies once it is fixed", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    const a = last("a");
    await s.update([cfg("a", [], { public_key: pub })]);
    expect(view(s, "a")).toMatchObject({ state: "running", pid: a.pid, problem: "the change in config.yaml is not applied: the signature file is missing" });
    expect(live(a.token)).toBe(true);
    expect(actions(s, "service-refuse", "a")).toMatchObject([{ result: "failed", detail: "the signature file is missing" }]);
    await new Promise((r) => setTimeout(r, 250)); // retries with the backoff: still one audit line for the same problem
    expect(actions(s, "service-refuse", "a")).toHaveLength(1);
    expect(starts("a")).toHaveLength(1);
    writeFileSync(`${program}.sig`, sign(null, readFileSync(program), keys.privateKey));
    await until(() => starts("a").length === 2, "the retry");
    expect(view(s, "a")!.problem).toBeUndefined();
    expect(live(a.token)).toBe(false);
    await until(() => actions(s, "service-start", "a").length === 1, "start audit");
  });

  it("keeps the old process for an acts_for that names no person", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    const a = last("a");
    await s.update([cfg("a", [], { acts_for: "nobody-here" })]);
    expect(view(s, "a")).toMatchObject({ pid: a.pid, problem: "the change in config.yaml is not applied: acts_for names no person account" });
    expect(live(a.token)).toBe(true);
  });

  it("keeps the old process when the account is blocked", async () => {
    const ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345" });
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    const a = last("a");
    const id = managedAccounts().a!;
    await setStatus(id, "blocked");
    await s.update([cfg("a", [], { acts_for: ann.email })]);
    expect(view(s, "a")).toMatchObject({ pid: a.pid, problem: "the change in config.yaml is not applied: the service account is blocked" });
  });

  it("keeps the old process when an unknown name clashes with an existing account", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    const a = last("a");
    createServiceAccount({ name: "taken", scope: ["GET health"] }); // an account the mapping does not know
    await s.update([cfg("a"), cfg("taken")]);
    const clash = "a service account with that name exists already, or the account cannot be made";
    expect(view(s, "taken")).toMatchObject({ state: "refused", problem: clash });
    expect(accountProblem("taken", ["GET health"])).toBe(clash);
    expect(view(s, "a")).toMatchObject({ state: "running", pid: a.pid });
    expect(live(a.token)).toBe(true);
  });

  it("accountProblem names a missing person, a blocked account and writes nothing", async () => {
    expect(accountProblem("fresh", ["GET health"])).toBeUndefined();
    expect(managedAccounts().fresh).toBeUndefined();
    expect(accountProblem("fresh", ["GET health"], "nobody-here")).toBe("acts_for names no person account");
    expect(existsSync(join(home, "services-accounts.json"))).toBe(false);
  });

  it("a signature that turns bad between the check and the stop refuses the entry; the retry applies once fixed", async () => {
    let spoiled = false;
    const s = make([cfg("a")], {
      afterCheck: () => {
        if (!spoiled) writeFileSync(`${program}.sig`, Buffer.alloc(64, 7));
        spoiled = true;
      },
    });
    s.start();
    await until(() => starts("a").length === 1, "a");
    writeFileSync(`${program}.sig`, sign(null, readFileSync(program), keys.privateKey)); // good at the check, bad after it
    await s.update([cfg("a", [], { public_key: pub })]);
    await until(() => view(s, "a")?.state === "refused", "refused");
    expect(view(s, "a")!.problem).toBe("the signature does not match the program");
    expect(actions(s, "service-refuse", "a").length).toBeGreaterThanOrEqual(1);
    writeFileSync(`${program}.sig`, sign(null, readFileSync(program), keys.privateKey));
    await until(() => view(s, "a")?.state === "running" && starts("a").length === 2, "the retry");
    await until(() => actions(s, "service-start", "a").length === 1, "start audit");
  });

  it("refuses a new entry with a missing program, and the others run on", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    await s.update([cfg("a"), cfg("b", [], { command: join(home, "nope") })]);
    expect(view(s, "b")).toMatchObject({ state: "refused", problem: "the program does not exist" });
    expect(view(s, "a")!.state).toBe("running");
    expect(actions(s, "service-refuse", "b")).toHaveLength(1);
    expect(logText("b")).toContain("not started: the program does not exist");
  });
});

describe("update: an exit while a change is refused", () => {
  const keys = generateKeyPairSync("ed25519");
  const pub = rawPublicKey(keys.publicKey);
  const killed = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  };

  it("the running program still restarts after it exits, though a change is refused", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    await s.update([cfg("a", ["--x"], { public_key: pub })]); // no .sig: refused, the old settings keep running
    expect(view(s, "a")!.problem).toContain("the change in config.yaml is not applied");
    killed(last("a").pid);
    await until(() => starts("a").length === 2, "the restart after the exit");
    expect(last("a").argv).not.toContain("--x"); // the last accepted settings, not the refused ones
    expect(view(s, "a")).toMatchObject({ state: "running" });
  });

  it("a refused replacement never takes over when the program exits and the retry runs", async () => {
    const s = make([cfg("a")]);
    s.start();
    await until(() => starts("a").length === 1, "a");
    await s.update([cfg("a", ["--x"], { acts_for: "nobody-here" })]);
    killed(last("a").pid);
    await until(() => starts("a").length === 2, "the restart");
    await new Promise((r) => setTimeout(r, 200)); // several retries of the refused change
    expect(starts("a").every((r) => !r.argv.includes("--x"))).toBe(true);
    expect(view(s, "a")).toMatchObject({ state: "running", problem: "the change in config.yaml is not applied: acts_for names no person account" });
  });
});

describe("update: stopping", () => {
  it("stop() during an update leaves nothing running and no live token", async () => {
    const s = make([cfg("a", ["--ignore-term"]), cfg("b")], { graceMs: 400 });
    s.start();
    await until(() => starts("a").length === 1 && starts("b").length === 1, "both");
    const tokens = [last("a").token, last("b").token];
    const upd = s.update([cfg("a", ["--ignore-term", "--x"]), cfg("b")]);
    await new Promise((r) => setTimeout(r, 30));
    await s.stop();
    await upd;
    for (const t of tokens) expect(live(t)).toBe(false);
    expect(starts("a")).toHaveLength(1);
    expect(s.view().every((v) => v.state === "stopped")).toBe(true);
  });

  it("stopNow() reaches a removed entry that is still stopping", async () => {
    const s = make([cfg("a", ["--ignore-term"])], { graceMs: 3000 });
    s.start();
    await until(() => starts("a").length === 1, "a");
    const pid = last("a").pid;
    const upd = s.update([]);
    await new Promise((r) => setTimeout(r, 100));
    s.stopNow();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the process is gone");
    await upd;
  });
});
