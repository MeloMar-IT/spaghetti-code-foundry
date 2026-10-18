import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dataHome } from "../src/auth/store.js";
import {
  CODEX_HOME_CHANGED,
  CODEX_HOME_REFUSED,
  CODEX_HOME_UNKNOWN,
  CODEX_PUSH_RULES,
  CODEX_PUSH_RULES_TEXT,
  CODEX_PUSH_UNHELD,
  cleanCodexHome,
  codexHomeId,
  codexIsolationLine,
  codexIsolationMode,
  codexLoginReturnLine,
  codexMustIsolate,
  codexPushAllowed,
  codexResumeRefusal,
  personalCodexDir,
  prepareCleanCodex,
  type PrepareCleanCodex,
} from "../src/agents/codex-home.js";
import { CODEX_LOGIN_NOT_RETURNED, CODEX_NO_LOGIN, codexLoginRecord, lendCodexLogin, returnCodexLogin } from "../src/agents/codex-login.js";
import { ConfigSchema } from "../src/config.js";
import { assembleToolProfile } from "../src/tool-profile/resolve.js";
import { legacyToolProfile, LEGACY_PROFILE_IDENTITY } from "../src/tool-profile/legacy.js";

const made: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "pch-"));
  made.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("codexHomeId", () => {
  it("is 'run' for the run's own folder, whatever the folders are", () => {
    expect(codexHomeId({ run: true })).toBe("run");
    expect(codexHomeId({ run: true, codexHome: "/a", home: "/b" })).toBe("run");
  });

  it("gives the same id for the same folder and another for another", () => {
    expect(codexHomeId({ run: false, codexHome: "/tmp/a" })).toBe(codexHomeId({ run: false, codexHome: "/tmp/a" }));
    expect(codexHomeId({ run: false, codexHome: "/tmp/a" })).not.toBe(codexHomeId({ run: false, codexHome: "/tmp/b" }));
  });

  it("uses .codex under home without CODEX_HOME, and treats an empty CODEX_HOME as unset", () => {
    const want = codexHomeId({ run: false, codexHome: "/h/.codex" });
    expect(codexHomeId({ run: false, home: "/h" })).toBe(want);
    expect(codexHomeId({ run: false, codexHome: "", home: "/h" })).toBe(want);
    expect(personalCodexDir({ home: "/h" })).toBe("/h/.codex");
    expect(personalCodexDir({ codexHome: "/x/../y" })).toBe("/y");
  });

  it("is a short fingerprint that holds no part of the path", () => {
    const id = codexHomeId({ run: false, codexHome: "/Users/secretname/codexdir" });
    expect(id).toMatch(/^personal:[0-9a-f]{12}$/);
    for (const part of ["secretname", "codexdir", "/"]) expect(id).not.toContain(part);
  });
});

describe("codexResumeRefusal", () => {
  it("allows equal ids", () => {
    expect(codexResumeRefusal("run", "run")).toBeUndefined();
  });

  it("refuses another folder", () => {
    expect(codexResumeRefusal("run", "personal:aaaaaaaaaaaa")).toBe(CODEX_HOME_CHANGED);
    expect(codexResumeRefusal("personal:aaaaaaaaaaaa", "run")).toBe(CODEX_HOME_CHANGED);
  });

  it("refuses a folder that is not known", () => {
    for (const v of [undefined, "", 7, null]) expect(codexResumeRefusal(v, "run")).toBe(CODEX_HOME_UNKNOWN);
  });
});

describe("codexIsolationMode and codexMustIsolate", () => {
  it.each([
    [false, true, true, "off"],
    [false, false, false, "off"],
    [true, true, false, "private"],
    [true, false, true, "private"],
    [true, false, false, "login"],
  ] as const)("isolate=%s local=%s key=%s gives %s", (isolate, local, hasKey, want) => {
    expect(codexIsolationMode({ isolate, local, hasKey })).toBe(want);
  });

  it("isolates every run the server starts, and lets CLI runs and runs without a source follow the setting", () => {
    for (const source of ["ui", "watcher w issue #1", "skill evaluation"]) expect(codexMustIsolate({ source, isolate: false })).toBe(true);
    for (const source of ["cli", undefined, ""]) {
      expect(codexMustIsolate({ source, isolate: false })).toBe(false);
      expect(codexMustIsolate({ source, isolate: true })).toBe(true);
    }
  });
});

describe("cleanCodexHome", () => {
  const plant = (run: string) => {
    const dir = join(run, "home", ".codex");
    mkdirSync(join(dir, "skills", "x"), { recursive: true });
    mkdirSync(join(dir, "rules"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    mkdirSync(join(run, "home", ".agents", "skills", "x"), { recursive: true });
    for (const f of ["config.toml", "managed_config.toml", ".env", "AGENTS.md", "AGENTS.override.md", "hooks.json", "auth.json", ".auth.json.tmp"]) writeFileSync(join(dir, f), "x");
    writeFileSync(join(dir, "rules", "other.rules"), "x");
    writeFileSync(join(dir, "sessions", "s.jsonl"), "x");
    return dir;
  };

  it("makes 0700 folders and replaces a symlink at home/.codex", () => {
    const run = tmpDir();
    const target = join(run, "elsewhere");
    mkdirSync(target);
    mkdirSync(join(run, "home"));
    symlinkSync(target, join(run, "home", ".codex"));
    const r = cleanCodexHome(run, { push: false, login: false });
    expect(r).toEqual({ CODEX_HOME: join(run, "home", ".codex"), HOME: join(run, "home"), GH_CONFIG_DIR: join(run, "home", ".config", "gh") });
    expect(lstatSync(join(run, "home", ".codex")).isSymbolicLink()).toBe(false);
    expect(statSync(join(run, "home", ".codex")).mode & 0o777).toBe(0o700);
    expect(readdirSync(target)).toEqual([]);
  });

  it("removes every configuration entry, keeps sessions, and removes a planted login unless one is lent", () => {
    const run = tmpDir();
    const dir = plant(run);
    expect("refused" in cleanCodexHome(run, { push: false, login: false })).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["rules", "sessions"]);
    expect(readdirSync(join(dir, "rules"))).toEqual([CODEX_PUSH_RULES]);
    expect(existsSync(join(run, "home", ".agents"))).toBe(false);

    const keep = tmpDir();
    const kdir = plant(keep);
    cleanCodexHome(keep, { push: false, login: true });
    expect(readdirSync(kdir).sort()).toEqual(["auth.json", "rules", "sessions"]);
  });

  it("removes a link among the entries without touching its target", () => {
    const run = tmpDir();
    const outside = join(run, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "k");
    mkdirSync(join(run, "home", ".codex"), { recursive: true });
    symlinkSync(outside, join(run, "home", ".codex", "skills"));
    symlinkSync(join(outside, "keep.txt"), join(run, "home", ".codex", "config.toml"));
    cleanCodexHome(run, { push: true, login: false });
    expect(existsSync(join(run, "home", ".codex", "skills"))).toBe(false);
    expect(existsSync(join(run, "home", ".codex", "config.toml"))).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("k");
  });

  it("writes exactly the push rule (0600) with push false, and no rules file with push true", () => {
    const run = tmpDir();
    cleanCodexHome(run, { push: false, login: false });
    const file = join(run, "home", ".codex", "rules", CODEX_PUSH_RULES);
    expect(readFileSync(file, "utf8")).toBe(CODEX_PUSH_RULES_TEXT);
    expect(CODEX_PUSH_RULES_TEXT).toContain('decision = "forbidden"');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(run, "home", ".codex", "rules"))).toEqual([CODEX_PUSH_RULES]);
    cleanCodexHome(run, { push: true, login: false });
    expect(readdirSync(join(run, "home", ".codex", "rules"))).toEqual([]);
  });

  it("gives an empty gh folder", () => {
    const run = tmpDir();
    mkdirSync(join(run, "home", ".config", "gh"), { recursive: true });
    writeFileSync(join(run, "home", ".config", "gh", "hosts.yml"), "token");
    cleanCodexHome(run, { push: false, login: false });
    expect(readdirSync(join(run, "home", ".config", "gh"))).toEqual([]);
  });

  it("refuses when a folder cannot be made", () => {
    const r = cleanCodexHome("/x", { push: false, login: false }, () => {
      throw new Error("no");
    });
    expect("refused" in r && r.refused.startsWith(CODEX_HOME_REFUSED)).toBe(true);
    expect("CODEX_HOME" in r).toBe(false);
  });
});

describe("codexPushAllowed", () => {
  const granting = (target: string, approval: "none" | "required" = "none") =>
    assembleToolProfile(LEGACY_PROFILE_IDENTITY, [{ kind: "git", operation: "push", targets: [target], dataClassification: "restricted", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval }]);

  it("is false without a profile, a repository or a policy, and for a generated profile", () => {
    const p = granting("o/r");
    expect(codexPushAllowed(undefined, "o/r", { outcome: "allow" })).toBe(false);
    expect(codexPushAllowed(p, undefined, { outcome: "allow" })).toBe(false);
    expect(codexPushAllowed(p, "o/r")).toBe(false);
    const legacy = legacyToolProfile({ permissionMode: "bypassPermissions", allowedTools: [], sandbox: false, boxed: false, noTools: false, mcpServers: false, credential: "machine" }).profile;
    expect(codexPushAllowed(legacy, "o/r", { outcome: "allow" })).toBe(false);
  });

  it("is true only for a profile that grants the push, that repository and an allowing policy", () => {
    expect(codexPushAllowed(granting("o/r"), "o/r", { outcome: "allow" })).toBe(true);
    expect(codexPushAllowed(granting("o/r"), "o/other", { outcome: "allow" })).toBe(false);
    expect(codexPushAllowed(granting("o/r"), "o/r", { outcome: "deny" })).toBe(false);
    expect(codexPushAllowed(granting("o/r"), "o/r", { outcome: "require_approval" })).toBe(false);
    expect(codexPushAllowed(granting("o/r", "required"), "o/r", { outcome: "allow" })).toBe(false);
  });
});

/** A personal Codex folder with a login file, and a run folder with a clean Codex folder. */
function loan(content = '{"a":1}') {
  const root = tmpDir();
  const personal = join(root, "personal");
  mkdirSync(personal);
  writeFileSync(join(personal, "auth.json"), content);
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "home", ".codex"), { recursive: true });
  return { root, personal, runDir, source: join(personal, "auth.json"), copy: join(runDir, "home", ".codex", "auth.json") };
}
const lockFile = () => join(dataHome(), "codex-logins", "write-back.lock");

describe("lendCodexLogin", () => {
  it("copies the bytes (0600) and keeps the record in the server's folder, not in the run folder", () => {
    const l = loan();
    expect(lendCodexLogin(l.runDir, l.personal)).toEqual({ lent: true });
    expect(readFileSync(l.copy, "utf8")).toBe('{"a":1}');
    expect(statSync(l.copy).mode & 0o777).toBe(0o600);
    const rec = codexLoginRecord(l.runDir);
    expect(rec.startsWith(join(dataHome(), "codex-logins"))).toBe(true);
    expect(statSync(rec).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(rec, "utf8"))).toMatchObject({ version: 1, runDir: l.runDir, source: l.source });
    expect(readdirSync(join(l.runDir, "home", ".codex"))).toEqual(["auth.json"]);
    expect(readdirSync(l.runDir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("refuses a missing, linked, empty, too big or folder login, and writes nothing", () => {
    const cases: Record<string, (l: ReturnType<typeof loan>) => void> = {
      missing: (l) => rmSync(l.source),
      link: (l) => {
        rmSync(l.source);
        writeFileSync(join(l.root, "real.json"), "{}");
        symlinkSync(join(l.root, "real.json"), l.source);
      },
      empty: (l) => writeFileSync(l.source, ""),
      big: (l) => writeFileSync(l.source, "x".repeat(65_537)),
      folder: (l) => {
        rmSync(l.source);
        mkdirSync(l.source);
      },
    };
    for (const [name, change] of Object.entries(cases)) {
      const l = loan();
      change(l);
      const r = lendCodexLogin(l.runDir, l.personal);
      expect(r, name).toEqual({ refused: CODEX_NO_LOGIN });
      expect(existsSync(l.copy), name).toBe(false);
      expect(existsSync(codexLoginRecord(l.runDir)), name).toBe(false);
    }
    expect(CODEX_NO_LOGIN).not.toMatch(/signed out|usage limit|daily budget/i);
  });

  it("keeps a refreshed copy that a failed write-back left, and copies again an unchanged one when the personal file is newer", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"refreshed":1}');
    expect(lendCodexLogin(l.runDir, l.personal)).toEqual({ lent: true });
    expect(readFileSync(l.copy, "utf8")).toBe('{"refreshed":1}');

    const m = loan();
    lendCodexLogin(m.runDir, m.personal);
    writeFileSync(m.source, '{"newer":1}');
    expect(lendCodexLogin(m.runDir, m.personal)).toEqual({ lent: true });
    expect(readFileSync(m.copy, "utf8")).toBe('{"newer":1}');
  });
});

describe("returnCodexLogin", () => {
  it("writes a refreshed copy back when the personal file is unchanged, then removes the copy and the record", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"new":1}');
    expect(returnCodexLogin(l.runDir)).toBe("written-back");
    expect(readFileSync(l.source, "utf8")).toBe('{"new":1}');
    expect(statSync(l.source).mode & 0o777).toBe(0o600);
    expect(readdirSync(l.personal)).toEqual(["auth.json"]);
    expect(existsSync(l.copy)).toBe(false);
    expect(existsSync(codexLoginRecord(l.runDir))).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("removes an unchanged copy without writing", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    expect(returnCodexLogin(l.runDir)).toBe("removed");
    expect(readFileSync(l.source, "utf8")).toBe('{"a":1}');
    expect(existsSync(l.copy)).toBe(false);
  });

  it("keeps the person's file when it changed meanwhile", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"new":1}');
    writeFileSync(l.source, '{"signed-in-again":1}');
    expect(returnCodexLogin(l.runDir)).toBe("kept-personal");
    expect(readFileSync(l.source, "utf8")).toBe('{"signed-in-again":1}');
    expect(existsSync(l.copy)).toBe(false);
    expect(existsSync(codexLoginRecord(l.runDir))).toBe(false);
  });

  it("keeps the person's file when it is replaced right before the rename", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"new":1}');
    expect(returnCodexLogin(l.runDir, { beforeRename: () => writeFileSync(l.source, '{"late":1}') })).toBe("kept-personal");
    expect(readFileSync(l.source, "utf8")).toBe('{"late":1}');
    expect(readdirSync(l.personal)).toEqual(["auth.json"]);
    expect(existsSync(l.copy)).toBe(false);
  });

  it("never writes back a copy that is not a JSON object", () => {
    for (const bad of ["not json", "[1]", "7"]) {
      const l = loan();
      lendCodexLogin(l.runDir, l.personal);
      writeFileSync(l.copy, bad);
      expect(returnCodexLogin(l.runDir)).toBe("removed");
      expect(readFileSync(l.source, "utf8")).toBe('{"a":1}');
      expect(existsSync(l.copy)).toBe(false);
    }
  });

  it("never writes by a record that is not valid", () => {
    const hash = "a".repeat(64);
    const forged = (l: ReturnType<typeof loan>): Record<string, unknown>[] => [
      { version: 1, runDir: l.runDir, source: "relative/auth.json", sha256: hash },
      { version: 1, runDir: l.runDir, source: join(l.root, "other.json"), sha256: hash },
      { version: 1, runDir: l.runDir, source: l.source, sha256: "nothex" },
      { version: 1, runDir: join(l.root, "elsewhere"), source: l.source, sha256: hash },
      { version: 2, runDir: l.runDir, source: l.source, sha256: hash },
    ];
    for (let i = 0; i < forged(loan()).length; i++) {
      const l = loan();
      lendCodexLogin(l.runDir, l.personal);
      writeFileSync(l.copy, '{"new":1}');
      writeFileSync(codexLoginRecord(l.runDir), JSON.stringify(forged(l)[i]));
      expect(returnCodexLogin(l.runDir)).toBe("none");
      expect(readFileSync(l.source, "utf8")).toBe('{"a":1}');
      expect(existsSync(l.copy)).toBe(false);
    }
  });

  it("ignores a forged record in the run folder: the copy is removed and the forged source is untouched", () => {
    const l = loan();
    const victim = join(l.root, "victim", "auth.json");
    mkdirSync(join(l.root, "victim"));
    writeFileSync(victim, "keep");
    writeFileSync(l.copy, '{"planted":1}');
    writeFileSync(join(l.runDir, "codex-login.json"), JSON.stringify({ version: 1, runDir: l.runDir, source: victim, sha256: "b".repeat(64) }));
    writeFileSync(join(l.runDir, "home", ".codex", "codex-login.json"), "x");
    expect(returnCodexLogin(l.runDir)).toBe("none");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(existsSync(l.copy)).toBe(false);
  });

  it("keeps the copy and the record when the write fails, then succeeds on the next return", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"new":1}');
    writeFileSync(lockFile(), String(process.pid)); // held by a live process
    expect(returnCodexLogin(l.runDir)).toBe("write-back-failed");
    expect(readFileSync(l.copy, "utf8")).toBe('{"new":1}');
    expect(existsSync(codexLoginRecord(l.runDir))).toBe(true);
    expect(readFileSync(l.source, "utf8")).toBe('{"a":1}');
    rmSync(lockFile());
    expect(returnCodexLogin(l.runDir)).toBe("written-back");
    expect(readFileSync(l.source, "utf8")).toBe('{"new":1}');
  });

  it("takes over a lock whose process is gone", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"new":1}');
    writeFileSync(lockFile(), String(spawnSync(process.execPath, ["-e", ""]).pid));
    expect(returnCodexLogin(l.runDir)).toBe("written-back");
    expect(existsSync(lockFile())).toBe(false);
  });

  it("lets only the first of two refreshed runs write back", () => {
    const a = loan();
    lendCodexLogin(a.runDir, a.personal);
    const runB = mkdtempSync(join(a.root, "run-"));
    mkdirSync(join(runB, "home", ".codex"), { recursive: true });
    lendCodexLogin(runB, a.personal);
    writeFileSync(a.copy, '{"from":"a"}');
    writeFileSync(join(runB, "home", ".codex", "auth.json"), '{"from":"b"}');
    expect(returnCodexLogin(a.runDir)).toBe("written-back");
    expect(returnCodexLogin(runB)).toBe("kept-personal");
    expect(readFileSync(a.source, "utf8")).toBe('{"from":"a"}');
  });

  it("removes a tmp file a write left in the personal folder and in the run", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    const tmp = join(l.personal, `auth.json.scf-${basename(l.runDir)}.tmp`);
    writeFileSync(tmp, "half");
    writeFileSync(join(l.runDir, "home", ".codex", ".auth.json.tmp"), "half");
    expect(returnCodexLogin(l.runDir)).toBe("removed");
    expect(existsSync(tmp)).toBe(false);
    expect(readdirSync(join(l.runDir, "home", ".codex"))).toEqual([]);
  });

  it("never follows a link in the run folder: a replaced home or .codex leaves the person's files alone, with or without a record", () => {
    for (const replace of ["home", ".codex"] as const) {
      for (const withRecord of [false, true]) {
        const l = loan();
        // the person's Codex folder as the link target, laid out so that a followed path would reach its auth.json
        const target = replace === "home" ? join(l.root, "target-home") : l.personal;
        if (replace === "home") {
          mkdirSync(join(target, ".codex"), { recursive: true });
          writeFileSync(join(target, ".codex", "auth.json"), "personal");
        }
        const reached = replace === "home" ? join(target, ".codex", "auth.json") : l.source;
        const before = readFileSync(reached, "utf8");
        if (withRecord) lendCodexLogin(l.runDir, l.personal);
        rmSync(join(l.runDir, "home"), { recursive: true, force: true });
        if (replace === "home") symlinkSync(target, join(l.runDir, "home"));
        else {
          mkdirSync(join(l.runDir, "home"));
          symlinkSync(target, join(l.runDir, "home", ".codex"));
        }
        returnCodexLogin(l.runDir);
        expect(readFileSync(reached, "utf8"), `${replace} ${withRecord}`).toBe(before);
        expect(existsSync(codexLoginRecord(l.runDir))).toBe(false);
        expect(lendCodexLogin(l.runDir, l.personal)).toHaveProperty("refused");
        expect(readFileSync(reached, "utf8")).toBe(before);
      }
    }
  });

  it("says none when nothing was lent, and never throws on an unreadable record", () => {
    const l = loan();
    expect(returnCodexLogin(l.runDir)).toBe("none");
    writeFileSync(codexLoginRecord(l.runDir), "{not json");
    expect(returnCodexLogin(l.runDir)).toBe("none");
  });
});

describe("prepareCleanCodex", () => {
  const config = ConfigSchema.parse({ protected_branches: [] });
  const prep = (runDir: string, personal: string, over: Partial<PrepareCleanCodex> = {}) =>
    prepareCleanCodex({ runDir, env: {}, config, kind: "openai", short: false, isolated: false, boxed: false, mode: "private", sandbox: "workspace-write", personal, permissionMode: "acceptEdits", allowedTools: [], sandboxed: false, repo: "o/r", ...over });

  it("gives a non-short run the short environment and no machine sign-in", () => {
    const l = loan();
    vi.stubEnv("GH_TOKEN", "ghp_canary");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-canary");
    vi.stubEnv("SCF_CANARY_SECRET", "canary");
    vi.stubEnv("CODEX_API_KEY", "k".repeat(20));
    const r = prep(l.runDir, l.personal, { env: { GH_TOKEN: "bot-token" } });
    if ("refused" in r) throw new Error(r.refused);
    expect(r.cleanEnv).toBe(true);
    expect(r.push).toBe(false);
    expect(r.env.CODEX_HOME).toBe(join(l.runDir, "home", ".codex"));
    expect(r.env.HOME).toBe(join(l.runDir, "home"));
    expect(r.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(r.env.GIT_ASKPASS).toBe("");
    expect(r.env.GH_CONFIG_DIR).toBe(join(l.runDir, "home", ".config", "gh"));
    for (const n of ["GH_TOKEN", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "SCF_CANARY_SECRET"]) expect(r.env[n], n).toBeUndefined();
    expect(r.env.CODEX_API_KEY).toBe("k".repeat(20));
    expect(existsSync(join(l.runDir, "home", ".codex", "auth.json"))).toBe(false);
  });

  it("refuses danger-full-access when push is not allowed, but not a boxed step", () => {
    const l = loan();
    const r = prep(l.runDir, l.personal, { sandbox: "danger-full-access", permissionMode: "bypassPermissions" });
    expect(r).toEqual({ refused: CODEX_PUSH_UNHELD });
    expect(CODEX_PUSH_UNHELD.startsWith(CODEX_HOME_REFUSED)).toBe(true);
    expect("refused" in prep(l.runDir, l.personal, { sandbox: "danger-full-access", permissionMode: "bypassPermissions", boxed: true, short: true })).toBe(false);
  });

  it("lends the login in login mode and returns it with done()", () => {
    const l = loan();
    const r = prep(l.runDir, l.personal, { mode: "login" });
    if ("refused" in r) throw new Error(r.refused);
    expect(readFileSync(l.copy, "utf8")).toBe('{"a":1}');
    writeFileSync(l.copy, '{"new":1}');
    expect(r.done()).toBe("written-back");
    expect(existsSync(l.copy)).toBe(false);
  });

  it("refuses with access set when there is no login file", () => {
    const l = loan();
    rmSync(l.source);
    expect(prep(l.runDir, l.personal, { mode: "login" })).toEqual({ refused: CODEX_NO_LOGIN, access: true });
  });

  it("refuses a key step while a refreshed login copy could not be returned, and keeps the copy", () => {
    const l = loan();
    lendCodexLogin(l.runDir, l.personal);
    writeFileSync(l.copy, '{"new":1}');
    writeFileSync(lockFile(), String(process.pid));
    const r = prep(l.runDir, l.personal, { mode: "private" });
    expect(r).toEqual({ refused: CODEX_HOME_REFUSED + CODEX_LOGIN_NOT_RETURNED });
    expect(readFileSync(l.copy, "utf8")).toBe('{"new":1}');
    rmSync(lockFile());
    const again = prep(l.runDir, l.personal, { mode: "private" });
    expect("refused" in again).toBe(false);
    expect(readFileSync(l.source, "utf8")).toBe('{"new":1}');
    expect(existsSync(l.copy)).toBe(false);
  });
});

describe("codexIsolationLine and codexLoginReturnLine", () => {
  it("has no line for off and a Codex: line for the others", () => {
    expect(codexIsolationLine("off")).toBeUndefined();
    for (const m of ["private", "login"] as const) expect(codexIsolationLine(m)).toMatch(/^Codex: a clean Codex folder/);
    expect(codexIsolationLine("login")).toContain("copy of the Codex login only");
  });

  it("says something for a write-back and for a failure, never with a path", () => {
    expect(codexLoginReturnLine("written-back")).toContain("written back");
    for (const r of ["write-back-failed", "not-removed"] as const) expect(codexLoginReturnLine(r)).toMatch(/^! Codex: /);
    for (const r of ["none", "removed", "kept-personal"] as const) expect(codexLoginReturnLine(r)).toBeUndefined();
  });
});
