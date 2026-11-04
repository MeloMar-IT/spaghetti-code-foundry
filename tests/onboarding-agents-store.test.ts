import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { CONFIG_PATH, configVersion, parseConfigText, readConfigText } from "../src/config.js";
import type { AgentAnswers } from "../src/onboarding/agents.js";
import { agentsFile, readAgentAnswers, readLimitsStatus, realIo, writeAgentAnswersLocked, type AgentsIo } from "../src/onboarding/agents-store.js";
import { getAgents, putAgents, type AgentsDeps } from "../src/server/api-onboarding.js";
import { HttpError } from "../src/server/http.js";

const MARK = "do-not-echo-769";
const answers = (over: Partial<AgentAnswers> = {}): AgentAnswers => ({ have: "both", plans: { claude: "max", codex: "pro" }, share: "even", busy: "normal", ...over });
const body = (a = answers(), replace: string[] = []) => ({ answers: a, replace });

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "agents-store-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  try {
    chmodSync(home, 0o700);
  } catch {
    // already gone
  }
  process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const runtime = () => parseConfigText(readConfigText());
const deps = (io: AgentsIo = realIo) => {
  const reload = vi.fn();
  const audit = vi.fn();
  const d: AgentsDeps = { runtime, reload, audit, io };
  return { d, reload, audit };
};
const io = (over: Partial<AgentsIo>): AgentsIo => ({ ...realIo, ...over });
const config = () => readConfigText();
const store = () => readFileSync(agentsFile(), "utf8");
const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
  return undefined;
};
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("the store file", () => {
  const record = { version: 1 as const, answers: answers(), applied: { concurrency: 2 }, at: "2026-11-04T10:00:00.000Z" };

  it("round-trips, with mode 0600 in a 0700 folder", () => {
    expect(readAgentAnswers()).toBeNull();
    withAuthLock(() => writeAgentAnswersLocked(record));
    expect(readAgentAnswers()).toEqual(record);
    expect(statSync(agentsFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "onboarding")).mode & 0o777).toBe(0o700);
  });

  it("needs the lock to write", () => {
    expect(() => writeAgentAnswersLocked(record)).toThrow(/inside withAuthLock/);
  });

  it("a broken file is a StoreError, and GET answers 500", () => {
    mkdirSync(join(home, "onboarding"));
    writeFileSync(agentsFile(), "{");
    expect(() => readAgentAnswers()).toThrow(expect.objectContaining({ kind: "not-json" }));
    expect(status(() => getAgents())).toBe(500);
    writeFileSync(agentsFile(), JSON.stringify({ version: 1 }));
    expect(() => readAgentAnswers()).toThrow(expect.objectContaining({ kind: "wrong-format" }));
  });

  it("an onboarding path that is a file is unreadable: GET answers 500", () => {
    writeFileSync(join(home, "onboarding"), "x");
    expect(() => readAgentAnswers()).toThrow(StoreError);
    expect(status(() => getAgents())).toBe(500);
  });
});

describe("readLimitsStatus", () => {
  it("is empty without a file and reads the readings of 5% or more", () => {
    expect(readLimitsStatus()).toEqual({ auto: false, readings: [] });
    mkdirSync(join(home, "limits"));
    writeFileSync(join(home, "limits", "state.json"), JSON.stringify({ auto: true, calibrations: { claude: { percent: 3 }, codex: { percent: 40 } } }));
    expect(readLimitsStatus()).toEqual({ auto: true, readings: ["codex"] });
    writeFileSync(join(home, "limits", "state.json"), "{");
    expect(readLimitsStatus()).toEqual({ auto: false, readings: [] });
  });
});

describe("GET and PUT", () => {
  it("GET with nothing saved", () => {
    const g = getAgents();
    expect(g.reply).toMatchObject({ answers: null, kept: [], summary: [] });
    expect(g.version).toBe(configVersion(""));
  });

  it("a first PUT writes the settings; the same PUT again changes nothing", () => {
    const x = deps();
    const r = putAgents(body(), undefined, x.d);
    expect(r.reply.changed.length).toBeGreaterThan(0);
    expect(r.version).toBe(configVersion(config()));
    expect(runtime().router.fallback).toEqual(["codex", "sonnet"]);
    expect(x.audit).toHaveBeenCalledTimes(1);
    expect(x.reload).toHaveBeenCalledTimes(1);
    const [c, s] = [config(), store()];
    const y = deps();
    const again = putAgents(body(), r.version, y.d);
    expect(again.reply.changed).toEqual([]);
    expect([config(), store()]).toEqual([c, s]);
    expect(y.audit).not.toHaveBeenCalled();
    expect(y.reload).not.toHaveBeenCalled();
    expect(getAgents().reply.answers).toEqual(answers());
  });

  it("a stale version answers 409 and writes nothing", () => {
    const x = deps();
    expect(status(() => putAgents(body(), "stale", x.d))).toBe(409);
    expect(config()).toBe("");
    expect(() => readAgentAnswers()).not.toThrow();
    expect(readAgentAnswers()).toBeNull();
  });

  it("invalid answers answer 400 and never echo what was sent", () => {
    const x = deps();
    const m = message(() => putAgents({ answers: { have: MARK, busy: "normal" }, [MARK]: 1 }, undefined, x.d));
    expect(m).toMatch(/invalid answers/);
    expect(m).not.toContain(MARK);
    expect(status(() => putAgents({}, undefined, x.d))).toBe(400);
    expect(JSON.stringify(x.audit.mock.calls)).not.toContain(MARK);
    expect(x.reload).not.toHaveBeenCalled();
  });

  it("invalid YAML in config.yaml answers 400 without the parser's words", () => {
    writeFileSync(CONFIG_PATH(), "a: [\n  " + MARK + "\n");
    const x = deps(realIo);
    const m = message(() => putAgents(body(), undefined, x.d));
    expect(m).toMatch(/invalid config/);
    expect(m).not.toContain(MARK);
    expect(status(() => getAgents())).toBe(400);
  });

  it("keeps a setting set by hand and lists it; `replace` overwrites it", () => {
    writeFileSync(CONFIG_PATH(), "concurrency: 5\n");
    const x = deps();
    expect(putAgents(body(), undefined, x.d).reply.kept).toEqual(["concurrency"]);
    expect(runtime().concurrency).toBe(5);
    expect(getAgents().reply.summary).toContain("Up to 5 runs at the same time.");
    putAgents(body(answers(), ["concurrency"]), undefined, deps().d);
    expect(runtime().concurrency).toBe(2);
    expect(getAgents().reply.kept).toEqual([]);
  });

  it("an unreadable config.yaml answers 500 on both routes and writes, audits and reloads nothing", () => {
    mkdirSync(CONFIG_PATH());
    const x = deps();
    expect(status(() => putAgents(body(), undefined, x.d))).toBe(500);
    expect(status(() => getAgents())).toBe(500);
    expect(readAgentAnswers()).toBeNull();
    expect(x.audit).not.toHaveBeenCalled();
    expect(x.reload).not.toHaveBeenCalled();
  });
});

describe("failures while saving", () => {
  it("a busy lock: 500, nothing written, and a retry works", () => {
    const x = deps(io({ lock: () => { throw new StoreError("locked", "auth.lock", "is held"); } }));
    expect(message(() => putAgents(body(), undefined, x.d))).toContain("locked");
    expect(config()).toBe("");
    expect(x.audit).not.toHaveBeenCalled();
    expect(x.reload).not.toHaveBeenCalled();
    const y = deps();
    expect(putAgents(body(), undefined, y.d).reply.changed.length).toBeGreaterThan(0);
  });

  it("the first store write fails: 500, config and store unchanged, retry works", () => {
    const x = deps(io({ writeStore: () => { throw new StoreError("cannot-write", "agents.json", "cannot be written (EIO)"); } }));
    expect(status(() => putAgents(body(), undefined, x.d))).toBe(500);
    expect(config()).toBe("");
    expect(readAgentAnswers()).toBeNull();
    expect(x.audit).not.toHaveBeenCalled();
    expect(x.reload).not.toHaveBeenCalled();
    expect(putAgents(body(), undefined, deps().d).reply.answers).toEqual(answers());
  });

  it("the config write fails: 500, config unchanged, old answers shown, no pending left, retry works", () => {
    putAgents(body(answers({ share: "auto" })), undefined, deps().d);
    const before = config();
    const x = deps(io({ writeConfig: () => { throw new Error("EIO"); } }));
    expect(message(() => putAgents(body(answers({ share: "codex" })), undefined, x.d))).toBe("config.yaml could not be written; try again");
    expect(config()).toBe(before);
    expect(JSON.parse(store()).pending).toBeUndefined();
    expect(getAgents().reply.answers?.share).toBe("auto");
    expect(x.audit).not.toHaveBeenCalled();
    expect(x.reload).not.toHaveBeenCalled();
    putAgents(body(answers({ share: "codex" })), undefined, deps().d);
    expect(JSON.parse(store()).pending).toBeUndefined();
    expect(getAgents().reply.answers?.share).toBe("codex");
  });

  it("the real config write is atomic: a failed rename leaves no temp file, a failed temp write leaves the file", () => {
    // rename onto a folder fails after the temp file was written
    mkdirSync(CONFIG_PATH());
    expect(() => realIo.writeConfig("concurrency: 3\n")).toThrow();
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    rmSync(CONFIG_PATH(), { recursive: true });
    writeFileSync(CONFIG_PATH(), "concurrency: 4\n");
    if (process.getuid?.() === 0) return; // root can write into a read-only folder
    chmodSync(home, 0o500);
    try {
      expect(() => realIo.writeConfig("concurrency: 3\n")).toThrow();
    } finally {
      chmodSync(home, 0o700);
    }
    expect(readFileSync(CONFIG_PATH(), "utf8")).toBe("concurrency: 4\n");
  });

  it("the final store write fails: 200 with a warning, audit and reload once, new answers shown, an identical retry cleans up", () => {
    let n = 0;
    const x = deps(io({ writeStore: (s) => { if (++n === 2) throw new StoreError("cannot-write", "agents.json", "cannot be written (EIO)"); realIo.writeStore(s); } }));
    const r = putAgents(body(), undefined, x.d);
    expect(r.reply.warning).toMatch(/^saved; /);
    expect(x.audit).toHaveBeenCalledTimes(1);
    expect(x.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store()).pending).toBeDefined();
    expect(getAgents().reply.answers).toEqual(answers());
    const c = config();
    const y = deps();
    expect(putAgents(body(), undefined, y.d).reply.warning).toBeUndefined();
    expect(config()).toBe(c);
    expect(JSON.parse(store()).pending).toBeUndefined();
    expect(y.audit).not.toHaveBeenCalled();
  });

  it("an admin's edit after a save whose final record failed is never overwritten", () => {
    let n = 0;
    putAgents(body(answers({ busy: "little" })), undefined, deps(io({ writeStore: (s) => { if (++n === 2) throw new StoreError("cannot-write", "agents.json", "cannot be written (EIO)"); realIo.writeStore(s); } })).d);
    writeFileSync(CONFIG_PATH(), config().replace(/^concurrency: .*$/m, "concurrency: 7"));
    // the file changed after the save wrote it, so the save is not read as finished: its values count as set by hand
    expect(getAgents().reply.answers).toBeNull();
    const r = putAgents(body(answers({ busy: "fast" })), undefined, deps().d);
    expect(r.reply.kept).toContain("concurrency");
    expect(runtime().concurrency).toBe(7);
    expect(runtime().governor.priority).toBe("background");
  });

  const claude = (plan: "pro" | "max") => body(answers({ have: "claude", plans: { claude: plan }, busy: "normal" }));
  const failConfig = io({ writeConfig: () => { throw new Error("EIO"); } });

  it("a failed config write, a manual edit, then a retry keeps the manual value", () => {
    putAgents(claude("pro"), undefined, deps().d); // concurrency 1
    expect(status(() => putAgents(claude("max"), undefined, deps(failConfig).d))).toBe(500);
    expect(JSON.parse(store()).pending).toBeUndefined();
    writeFileSync(CONFIG_PATH(), config().replace(/^concurrency: .*$/m, "concurrency: 2"));
    const r = putAgents(claude("pro"), undefined, deps().d);
    expect(r.reply.kept).toContain("concurrency");
    expect(runtime().concurrency).toBe(2);
  });

  it("the same when the pending entry could not be cleared after the failed config write", () => {
    let n = 0;
    const noClear = io({
      writeConfig: () => { throw new Error("EIO"); },
      writeStore: (s) => { if (++n >= 2) throw new StoreError("cannot-write", "agents.json", "cannot be written (EIO)"); realIo.writeStore(s); },
    });
    putAgents(claude("pro"), undefined, deps().d); // concurrency 1
    expect(status(() => putAgents(claude("max"), undefined, deps(noClear).d))).toBe(500);
    expect(JSON.parse(store()).pending).toBeDefined();
    writeFileSync(CONFIG_PATH(), config().replace(/^concurrency: .*$/m, "concurrency: 2"));
    const r = putAgents(claude("pro"), undefined, deps().d);
    expect(r.reply.kept).toContain("concurrency");
    expect(runtime().concurrency).toBe(2);
    expect(JSON.parse(store()).pending).toBeUndefined();
  });

  it("a lock that fails to release: 200 with a warning, the lock is freed, audit and the next save work", () => {
    const lock = join(home, "auth.lock");
    const failing = io({
      lock: (fn) => {
        realIo.lock(fn);
        mkdirSync(lock);
        writeFileSync(join(lock, "pid"), String(process.pid));
        throw new StoreError("cannot-write", lock, "cannot be unlocked (EIO)");
      },
    });
    const x = deps(failing);
    // the real audit takes the same lock
    x.audit.mockImplementation(() => withAuthLock(() => undefined, 200));
    const r = putAgents(body(), undefined, x.d);
    expect(r.reply.warning).toContain("lock");
    expect(r.reply.warning).not.toContain("audit");
    expect(x.audit).toHaveBeenCalledTimes(1);
    expect(x.reload).toHaveBeenCalledTimes(1);
    expect(putAgents(body(answers({ busy: "little" })), undefined, deps().d).reply.changed.length).toBeGreaterThan(0);
  });

  it("an audit that fails is a warning, not an error", () => {
    const x = deps();
    x.audit.mockImplementation(() => { throw new Error("locked"); });
    const r = putAgents(body(), undefined, x.d);
    expect(r.reply.warning).toContain("audit");
    expect(x.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when the running config is behind the file, even with nothing to write", () => {
    putAgents(body(), undefined, deps().d);
    const behind = { ...deps().d, runtime: () => parseConfigText("") };
    const x = { ...behind, reload: vi.fn(), audit: vi.fn() };
    putAgents(body(), undefined, x);
    expect(x.reload).toHaveBeenCalledTimes(1);
    expect(x.audit).not.toHaveBeenCalled();
  });
});
