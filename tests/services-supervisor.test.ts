import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lookupServiceToken } from "../src/auth/service-accounts.js";
import type { ServiceConfig } from "../src/config.js";
import { ServiceSupervisor, withServicesStopped, type SupervisorOptions } from "../src/services/supervisor.js";
import { serviceToken } from "../src/services/setup.js";
import { rawPublicKey } from "../src/skills/release-signature.js";

// Managed services (#867) with the real fixture program: start, exit, restart, signature, log, stop.

const FIXTURE = resolve("tests/fixtures/services/fake-service.mjs");
const FAST = { firstMs: 20, maxMs: 80, stableMs: 10_000 };
let home: string;
let saved: string | undefined;
let sups: ServiceSupervisor[] = [];

beforeAll(() => chmodSync(FIXTURE, 0o755));
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-sup-"));
  process.env.FACTORY_HOME = home;
});
afterEach(async () => {
  for (const s of sups) await s.stop();
  sups = [];
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const out = () => join(home, "out.jsonl");
const cfg = (args: string[] = [], over: Partial<ServiceConfig> = {}): ServiceConfig => ({ name: "bot", command: FIXTURE, args: ["--out", out(), ...args], env: {}, scope: ["GET health"], ...over });
const make = (services: ServiceConfig[], over: Partial<SupervisorOptions> = {}) => {
  const lines: string[] = [];
  const s = new ServiceSupervisor({
    services, home, runsDir: join(home, "runs"), url: "http://127.0.0.1:1", log: (l) => lines.push(l), checkScope: () => undefined,
    backoff: FAST, graceMs: 300, ...over,
  });
  sups.push(s);
  return Object.assign(s, { lines });
};
const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const outLines = () => (existsSync(out()) ? readFileSync(out(), "utf8").trim().split("\n").filter(Boolean) : []);
const starts = () => outLines().filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { argv: string[]; token: string; url: string; pid: number });
const live = (t: string) => lookupServiceToken(t)?.state === "live";
const logText = (n = "bot.log") => readFileSync(join(home, "services", n), "utf8");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("start", () => {
  it("runs with a live token and the url, and the token is not in argv", async () => {
    const s = make([cfg()]);
    s.start();
    await until(() => starts().length === 1, "the start");
    const [r] = starts();
    expect(r!.url).toBe("http://127.0.0.1:1");
    expect(live(r!.token)).toBe(true);
    expect(r!.argv.join(" ")).not.toContain(r!.token);
    expect(s.view()[0]).toMatchObject({ name: "bot", state: "running", restarts: 0 });
  });

  it("does not pass the server's own variables on", async () => {
    process.env.SOME_PROVIDER_KEY = "leaky";
    try {
      const s = make([cfg(["--print-env", "SOME_PROVIDER_KEY"])]);
      s.start();
      await until(() => existsSync(join(home, "services", "bot.log")) && logText().includes("env="), "output");
      expect(logText()).toContain("env=undefined");
    } finally {
      delete process.env.SOME_PROVIDER_KEY;
    }
  });

  it("with an empty list and no earlier state creates nothing", () => {
    const s = make([]);
    s.start();
    expect(s.view()).toEqual([]);
    expect(existsSync(join(home, "services"))).toBe(false);
    expect(existsSync(join(home, "services-accounts.json"))).toBe(false);
  });
});

describe("exit and restart", () => {
  it("starts again after a failed exit, with a new token", async () => {
    const s = make([cfg(["--exit", "1", "--after", "30"])]);
    s.start();
    await until(() => starts().length >= 3, "two restarts");
    const t = starts();
    expect(live(t[0]!.token)).toBe(false);
    expect(live(t[1]!.token)).toBe(false);
    const v = s.view()[0]!;
    expect(v.restarts).toBeGreaterThanOrEqual(2);
    expect(v.lastExit).toMatchObject({ code: 1, signal: null });
  });

  it("stops the child of a program that exits before the next start", async () => {
    const s = make([cfg(["--fork-child", "--exit", "0", "--after", "80"])]);
    s.start();
    await until(() => starts().length >= 1 && existsSync(`${out()}.child`), "the child");
    const child = Number(readFileSync(`${out()}.child`, "utf8"));
    await until(() => starts().length >= 2, "the second start");
    expect(alive(child)).toBe(false);
  });
});

describe("signature", () => {
  const keys = generateKeyPairSync("ed25519");
  const pub = rawPublicKey(keys.publicKey);

  it("starts with a good signature", async () => {
    writeFileSync(`${FIXTURE}.sig`, sign(null, readFileSync(FIXTURE), keys.privateKey));
    try {
      const s = make([cfg([], { public_key: pub })]);
      s.start();
      await until(() => starts().length === 1, "the start");
      expect(s.view()[0]!.state).toBe("running");
    } finally {
      rmSync(`${FIXTURE}.sig`, { force: true });
    }
  });

  it("refuses a missing or wrong signature, and an unclean exit leaves no live token", async () => {
    const earlier = serviceToken("bot", ["GET health"]); // a token an earlier server run left live
    const s = make([cfg([], { public_key: pub })]);
    s.start();
    expect(s.view()[0]).toMatchObject({ state: "refused", problem: "the signature file is missing" });
    expect(s.view()[0]!.nextStart).toBeDefined();
    expect(live(earlier.token)).toBe(false);
    expect(starts()).toEqual([]);
    writeFileSync(`${FIXTURE}.sig`, Buffer.alloc(64, 7));
    try {
      await until(() => s.view()[0]!.problem === "the signature does not match the program", "the second refusal");
      expect(s.view()[0]!.state).toBe("refused");
    } finally {
      rmSync(`${FIXTURE}.sig`, { force: true });
    }
  });

  it("refuses a scope the server does not grant", () => {
    const s = make([cfg()], { checkScope: () => "the scope is not valid" });
    s.start();
    expect(s.view()[0]).toMatchObject({ state: "refused", problem: "the scope is not valid" });
  });

  it("revokes the tokens of earlier runs when the list is empty now", () => {
    const earlier = serviceToken("gone", []);
    make([]).start();
    expect(live(earlier.token)).toBe(false);
  });

  it("refuses a program that cannot be run and tries again", async () => {
    const bad = join(home, "bad");
    // executable, but its interpreter does not exist: the spawn itself fails (no fallback to /bin/sh)
    writeFileSync(bad, "#!/nonexistent/interp-867\n", { mode: 0o755 });
    const s = make([cfg([], { command: bad })]);
    s.start();
    await until(() => s.view()[0]!.state === "refused", "the refusal");
    expect(s.view()[0]!.nextStart).toBeDefined();
  });
});

describe("log", () => {
  it("hides the token, a configured secret, and a token split in two writes", async () => {
    const s = make([cfg(["--print-token", "--print-env", "API_KEY", "--split-token"], { env: { API_KEY: "sekret-value-123" } })]); // factory:allow-secret (test value)
    s.start();
    await until(() => existsSync(join(home, "services", "bot.log")) && logText().includes("half="), "the output");
    await until(() => logText().includes("[redacted]\n") || logText().split("[redacted]").length > 3, "the redaction");
    const text = logText();
    const token = starts()[0]!.token;
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(0, 20));
    expect(text).not.toContain("sekret-value-123");
    expect(text).toContain("[redacted]");
    expect(statSync(join(home, "services", "bot.log")).mode & 0o777).toBe(0o600);
  });

  it("redacts a secret split between stdout and stderr", async () => {
    const s = make([cfg(["--split-streams"], { env: { API_KEY: "sekret-value-123" } })]); // factory:allow-secret (test value)
    s.start();
    await until(() => existsSync(join(home, "services", "bot.log")) && logText().includes("[redacted]"), "the redaction");
    expect(logText()).not.toContain("sekret");
    expect(logText()).not.toContain("alue-123");
  });

  it("rotates at the limit and no file passes it, also with multibyte text", async () => {
    const s = make([cfg(["--chatter", "5000"])], { maxLogBytes: 1000 });
    s.start();
    await until(() => existsSync(join(home, "services", "bot.log.1")), "the rotation");
    await s.stop();
    expect(statSync(join(home, "services", "bot.log")).size).toBeLessThanOrEqual(1000);
    expect(statSync(join(home, "services", "bot.log.1")).size).toBeLessThanOrEqual(1000);
  });

  it("goes on when the log cannot be written", async () => {
    const s = make([cfg()], { home });
    writeFileSync(join(home, "services"), "a file where the folder goes");
    s.start();
    await until(() => starts().length === 1, "the start");
    expect(s.view()[0]!.state).toBe("running");
  });
});

describe("stop", () => {
  it("sends SIGTERM, drains the output and revokes the token", async () => {
    const s = make([cfg(["--term-chatter", "20"])]);
    s.start();
    await until(() => starts().length === 1, "the start");
    const t = starts()[0]!.token;
    await s.stop();
    expect(outLines()).toContain("term");
    expect(s.view()[0]!.state).toBe("stopped");
    expect(live(t)).toBe(false);
    expect(logText()).toContain("x".repeat(20));
    const before = starts().length;
    await new Promise((r) => setTimeout(r, 150));
    expect(starts().length).toBe(before); // no restart after the stop
  });

  it("stopNow ends a program that ignores SIGTERM within the grace time, and revokes", async () => {
    const s = make([cfg(["--ignore-term"])]);
    s.start();
    await until(() => starts().length === 1, "the start");
    const { pid, token } = starts()[0]!;
    const began = Date.now();
    s.stopNow();
    expect(Date.now() - began).toBeLessThan(1300);
    await until(() => !alive(pid), "the process to go");
    expect(live(token)).toBe(false);
  });

  it("stopNow lets a normal program write before it returns", async () => {
    const s = make([cfg()]);
    s.start();
    await until(() => starts().length === 1, "the start");
    s.stopNow();
    expect(outLines()).toContain("term");
  });

  it("stopNow never throws, also when the account is gone or the store fails", async () => {
    const s = make([cfg()], { alive: () => { throw new Error("ps failed"); } });
    s.start();
    await until(() => starts().length === 1, "the start");
    const { pid } = starts()[0]!;
    const { deleteUser } = await import("../src/auth/users.js");
    const { managedAccounts } = await import("../src/services/setup.js");
    deleteUser(managedAccounts().bot!);
    expect(() => s.stopNow()).not.toThrow();
    await until(() => !alive(pid), "the process to go");
    writeFileSync(join(home, "users.json"), "broken");
    expect(() => s.stopNow()).not.toThrow();
  });
});

describe("withServicesStopped", () => {
  it("stops first, then runs the callback, even when the stop throws", () => {
    const order: string[] = [];
    withServicesStopped(() => order.push("exit"), { stopNow: () => void order.push("stop") })();
    withServicesStopped(() => order.push("exit2"), { stopNow: () => { throw new Error("x"); } })();
    withServicesStopped(() => order.push("exit3"))();
    expect(order).toEqual(["stop", "exit", "exit2", "exit3"]);
  });
});
