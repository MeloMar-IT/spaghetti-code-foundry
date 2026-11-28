import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_TOKEN_ACCOUNT,
  AI_TOKEN_MAX,
  AI_TOKEN_SERVICE,
  AI_TOKEN_VARS,
  addAiToken,
  aiTokenPath,
  aiTokenSetAt,
  aiTokenSource,
  aiTokenStartLine,
  checkAiToken,
  clearAiToken,
  hideAiToken,
  readAiToken,
  setAiToken,
} from "../src/auth/ai-token.js";
import { aiTokenCommand } from "../src/auth/ai-token-cli.js";
import type { UserIo } from "../src/auth/cli.js";
import { addItem, deleteItem, findItem } from "../src/credentials/keychain.js";
import { redactText, resetRedactCache } from "../src/credentials/redact.js";
import { TOKEN_MIN } from "../src/credentials/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

// The audit log is the real one; `appendFails` makes the line after a Keychain change fail.
const audit = vi.hoisted(() => ({ appendFails: false, closed: 0 }));
vi.mock("../src/auth/audit.js", async (original) => {
  const real = await original<typeof import("../src/auth/audit.js")>();
  return {
    ...real,
    prepareAuditLocked: (...args: Parameters<typeof real.prepareAuditLocked>) => {
      const log = real.prepareAuditLocked(...args);
      return {
        write: () => {
          if (audit.appendFails) throw new Error("append failed");
          log.write();
        },
        close: () => {
          audit.closed++;
          log.close();
        },
      };
    },
  };
});

// Built at run time, so this file holds no token-shaped string.
const A = "tok-" + "Aq7".repeat(10);
const B = "tok-" + "Bw8".repeat(10);

let kc: FakeKeychain;
let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries([...AI_TOKEN_VARS, "FACTORY_HOME"].map((k) => [k, process.env[k]]));
  for (const k of AI_TOKEN_VARS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "ai-token-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  hideAiToken();
  audit.appendFails = false;
  audit.closed = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  kc.remove();
  rmSync(home, { recursive: true, force: true });
});

const stored = () => kc.items()[`${AI_TOKEN_SERVICE}\0${AI_TOKEN_ACCOUNT}`];
const auditText = () => (existsSync(join(home, "audit.jsonl")) ? readFileSync(join(home, "audit.jsonl"), "utf8") : "");
const auditLines = () => auditText().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const line = (action: string, result = "ok") => ({ time: expect.any(String), by: "cli", action, result, target: "claude-oauth-token" });
const seed = (value: string) => addItem(AI_TOKEN_SERVICE, AI_TOKEN_ACCOUNT, value);
/** A folder in place of the time file: it can be neither written nor removed. */
const blockTimeFile = () => {
  rmSync(aiTokenPath(), { force: true });
  mkdirSync(aiTokenPath());
};
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected an error");
};

describe("generic Keychain items", () => {
  it("adds, finds and deletes, with the value on stdin only and -w last", () => {
    expect(findItem("svc", "acc")).toBeUndefined();
    addItem("svc", "acc", A);
    expect(findItem("svc", "acc")).toBe(A);
    expect(deleteItem("svc", "acc")).toBe(true);
    expect(deleteItem("svc", "acc")).toBe(false);
    expect(JSON.stringify(kc.calls())).not.toContain(A);
    expect(kc.calls().find((c) => c[0] === "add-generic-password")!.at(-1)).toBe("-w");
  });

  it("refuses a value of more than one line, and throws when the tool fails", () => {
    for (const v of ["", `${A}\n`, `${A}\r${B}`]) expect(() => addItem("svc", "acc", v)).toThrow("one line");
    expect(kc.calls()).toEqual([]);
    kc.fail("find");
    expect(() => findItem("svc", "acc")).toThrow("could not be read");
    kc.fail("delete");
    expect(() => deleteItem("svc", "acc")).toThrow("did not remove");
  });
});

describe("the token check", () => {
  it("keeps the length limits and refuses spaces and control characters, without the value", () => {
    expect(() => checkAiToken("x".repeat(TOKEN_MIN))).not.toThrow();
    expect(() => checkAiToken("x".repeat(AI_TOKEN_MAX))).not.toThrow();
    for (const bad of ["q".repeat(TOKEN_MIN - 1), "q".repeat(AI_TOKEN_MAX + 1), `${A} x`, ` ${A}`, `${A}\t`, `${A}\u0001`, `${A}\u007f`]) {
      expect(message(() => checkAiToken(bad))).not.toContain(bad.trim().slice(0, 6));
    }
  });
});

describe("where the sign-in comes from", () => {
  it("a variable wins, and the Keychain is not asked", () => {
    seed(A);
    kc.clearLog();
    for (const name of AI_TOKEN_VARS) {
      process.env[name] = B;
      expect(aiTokenSource()).toEqual({ source: "environment", variable: name });
      delete process.env[name];
    }
    expect(kc.calls()).toEqual([]);
  });

  it("is the keychain with the set time, or none", () => {
    const lines: string[] = [];
    expect(aiTokenSource((m) => lines.push(m))).toEqual({ source: "none" });
    setAiToken(A);
    expect(aiTokenSource()).toEqual({ source: "keychain", setAt: aiTokenSetAt() });
    expect(lines).toEqual([]);
  });

  it("a failed read is none with one line, and never throws", () => {
    kc.fail("find");
    const lines: string[] = [];
    expect(aiTokenSource((m) => lines.push(m))).toEqual({ source: "none", unreadable: true });
    expect(lines).toEqual(["AI sign-in: the Keychain could not be read (the Keychain could not be read (is the login keychain locked?)); going on without it"]);
  });

  it("a system without a Keychain is none with no line", () => {
    const bin = process.env.SCF_SECURITY_BIN;
    delete process.env.SCF_SECURITY_BIN;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      const lines: string[] = [];
      expect(readAiToken((m) => lines.push(m))).toBeUndefined();
      expect(lines).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
      process.env.SCF_SECURITY_BIN = bin;
    }
  });

  it("a stored value that is no token is none with one line", () => {
    seed("two words here");
    const lines: string[] = [];
    expect(readAiToken((m) => lines.push(m))).toBeUndefined();
    expect(lines).toEqual(["AI sign-in: the Keychain item is not valid; going on without it"]);
  });

  it("the start line names the source only", () => {
    expect(aiTokenStartLine()).toBe("AI sign-in: none");
    seed(A);
    expect(aiTokenStartLine()).toBe("AI sign-in: from the keychain");
    process.env.ANTHROPIC_API_KEY = B;
    expect(aiTokenStartLine()).toBe("AI sign-in: from the environment");
  });
});

describe("giving the token to a step", () => {
  const claude = { agent: "claude" as const, provider: { kind: "anthropic" as const } };
  const give = (target: Parameters<typeof addAiToken>[1], env: Record<string, string | undefined> = {}, short = false) => {
    addAiToken(env, target, short, () => {});
    return env.CLAUDE_CODE_OAUTH_TOKEN;
  };

  it("only to Claude on anthropic", () => {
    seed(A);
    expect(give(claude)).toBe(A);
    expect(give({ ...claude, agent: "codex" } as never)).toBeUndefined();
    expect(give({ ...claude, provider: { kind: "anthropic-compatible" } } as never)).toBeUndefined();
  });

  it("looks at the server's variables only when the step inherits them", () => {
    seed(A);
    process.env.ANTHROPIC_API_KEY = B;
    expect(give(claude)).toBeUndefined();
    expect(give(claude, {}, true)).toBe(A);
    expect(give(claude, { ANTHROPIC_API_KEY: B }, true)).toBeUndefined();
  });
});

describe("set and clear", () => {
  it("stores the token, notes only the time and writes one audit line each", () => {
    setAiToken(A);
    expect(stored()).toBe(A);
    expect(JSON.parse(readFileSync(aiTokenPath(), "utf8"))).toEqual({ version: 1, setAt: expect.any(String) });
    expect(clearAiToken()).toBe(true);
    expect(stored()).toBeUndefined();
    expect(existsSync(aiTokenPath())).toBe(false);
    expect(clearAiToken()).toBe(false);
    expect(auditLines()).toEqual([line("ai-token-set"), line("ai-token-clear"), line("ai-token-clear")]);
    expect(auditText()).not.toContain(A);
    expect(audit.closed).toBe(3);
  });

  it("an invalid value reaches neither the Keychain nor the audit log", () => {
    expect(() => setAiToken("short")).toThrow("at least");
    expect(kc.calls()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("a failed change writes a failed line and keeps the item and the time", () => {
    setAiToken(A);
    const time = readFileSync(aiTokenPath(), "utf8");
    kc.fail("add");
    expect(message(() => setAiToken(B))).toBe("the Keychain did not accept the value");
    kc.fail("delete");
    expect(message(() => clearAiToken())).toBe("the Keychain did not remove the item");
    expect(stored()).toBe(A);
    expect(readFileSync(aiTokenPath(), "utf8")).toBe(time);
    expect(auditLines().slice(1)).toEqual([line("ai-token-set", "failed"), line("ai-token-clear", "failed")]);
  });

  for (const replacing of [false, true]) {
    it(`a time file that cannot be written: the ${replacing ? "replacement" : "first set"} is still audited`, () => {
      if (replacing) setAiToken(A);
      blockTimeFile();
      const text = message(() => setAiToken(B));
      expect(text).toContain("the token was stored in the Keychain, but the time it was set was not saved");
      expect(text).toContain("status may show an old time");
      expect(text).not.toContain(B);
      expect(stored()).toBe(B);
      expect(auditLines().at(-1)).toEqual(line("ai-token-set"));
      expect(aiTokenSetAt()).toBeUndefined();
    });
  }

  it("a time file that cannot be removed: the clear is still audited", () => {
    setAiToken(A);
    blockTimeFile();
    expect(message(() => clearAiToken())).toBe("the token was removed from the Keychain, but the file with the time it was set could not be removed");
    expect(stored()).toBeUndefined();
    expect(auditLines().at(-1)).toEqual(line("ai-token-clear"));
  });

  for (const replacing of [false, true]) {
    it(`an audit line that cannot be written: the ${replacing ? "replacement" : "first set"} stands and the time is saved`, () => {
      if (replacing) {
        setAiToken(A);
        writeFileSync(aiTokenPath(), "{}");
      }
      audit.appendFails = true;
      audit.closed = 0;
      const text = message(() => setAiToken(B));
      expect(text).toBe("the token was stored in the Keychain, but the change is not in the audit log");
      expect(stored()).toBe(B);
      expect(aiTokenSetAt()).toBeDefined();
      expect(audit.closed).toBe(1);
    });
  }

  it("an audit line that cannot be written: the clear stands and the time file goes", () => {
    setAiToken(A);
    audit.appendFails = true;
    audit.closed = 0;
    expect(message(() => clearAiToken())).toBe("the token was removed from the Keychain, but the change is not in the audit log");
    expect(stored()).toBeUndefined();
    expect(existsSync(aiTokenPath())).toBe(false);
    expect(audit.closed).toBe(1);
  });

  it("names both when the audit line and the time file fail", () => {
    blockTimeFile();
    audit.appendFails = true;
    const text = message(() => setAiToken(A));
    expect(text).toContain("the change is not in the audit log, and the time it was set was not saved");
    expect(message(() => clearAiToken())).toContain("the change is not in the audit log, and the file with the time");
    expect(audit.closed).toBe(2);
  });
});

describe("hiding the value", () => {
  it("keeps every value it has read hidden, also after a change and a removal", () => {
    const hidden = () => redactText(`${A} ${B}`);
    seed(A);
    expect(readAiToken()).toBe(A);
    seed(B);
    expect(readAiToken()).toBe(B);
    clearAiToken();
    expect(hidden()).toBe("[redacted] [redacted]");
    resetRedactCache();
    expect(hidden()).toContain(A);
  });
});

describe("scf auth", () => {
  const io = (over: { tty?: boolean; input?: string } = {}) => {
    const lines: string[] = [];
    const reads: string[] = [];
    const fake: UserIo = {
      isTTY: over.tty ?? false,
      ask: async () => {
        throw new Error("never asked with echo");
      },
      askHidden: async () => (reads.push("hidden"), over.input ?? A),
      readStdinLine: async () => (reads.push("line"), over.input ?? A),
      out: (s) => void lines.push(s),
    };
    return { fake, lines, reads };
  };
  const run = (positionals: string[], t = io(), values: Record<string, unknown> = {}) => aiTokenCommand({ positionals, values }, t.fake);

  it("refuses bad syntax before anything is read", async () => {
    const t = io();
    for (const args of [[], ["nope"], ["set-token", "now"], ["status", "x"], ["clear-token", "x"]]) await expect(run(args, t)).rejects.toThrow("usage: scf auth");
    await expect(run(["set-token"], t, { force: true })).rejects.toThrow("usage: scf auth");
    expect(t.reads).toEqual([]);
    expect(kc.calls()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("reads a pipe by line and a terminal hidden, and refuses empty input", async () => {
    for (const tty of [false, true]) {
      const t = io({ tty });
      expect(await run(["set-token"], t)).toBe(0);
      expect(t.reads).toEqual([tty ? "hidden" : "line"]);
      expect(t.lines).toEqual(["the token is stored in the Keychain"]);
      await expect(run(["set-token"], io({ tty, input: "" }))).rejects.toThrow(/no token/);
    }
    expect(stored()).toBe(A);
  });

  it("status and clear-token never show the value", async () => {
    const t = io();
    await run(["status"], t);
    await run(["set-token"], t);
    await run(["status"], t);
    process.env.ANTHROPIC_AUTH_TOKEN = B;
    await run(["set-token"], t);
    await run(["status"], t);
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await run(["clear-token"], t);
    await run(["clear-token"], t);
    const time = expect.stringMatching(/^set: \d{4}-.*Z$/);
    expect(t.lines).toEqual([
      "source: none",
      "the token is stored in the Keychain",
      "source: keychain",
      time,
      "the token is stored in the Keychain",
      "note: ANTHROPIC_AUTH_TOKEN is set here, and a variable wins over the Keychain",
      "source: environment (ANTHROPIC_AUTH_TOKEN)",
      expect.stringContaining("not used while a variable is set"),
      "the token was removed from the Keychain",
      "there is no token in the Keychain",
    ]);
    const all = t.lines.join("\n");
    for (const v of [A, B, createHash("sha256").update(A).digest("hex")]) expect(all).not.toContain(v);
  });

  it("status says unknown without a time, and exits 1 when the Keychain cannot be read", async () => {
    seed(A);
    const t = io();
    expect(await run(["status"], t)).toBe(0);
    expect(t.lines).toEqual(["source: keychain", "set: unknown"]);
    kc.fail("find");
    expect(await run(["status"], io())).toBe(1);
  });
});
