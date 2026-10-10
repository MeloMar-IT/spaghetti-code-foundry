import { describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HOME_CHANGED, CODEX_HOME_REFUSED, CODEX_HOME_UNKNOWN, codexHomeId, codexIsolationLine, codexIsolationMode, codexResumeRefusal, privateCodexHome } from "../src/agents/codex-home.js";

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
  });

  it("resolves the path", () => {
    expect(codexHomeId({ run: false, codexHome: "/x/../y" })).toBe(codexHomeId({ run: false, codexHome: "/y" }));
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
    expect(codexResumeRefusal("personal:aaaaaaaaaaaa", "personal:aaaaaaaaaaaa")).toBeUndefined();
  });

  it("refuses another folder", () => {
    expect(codexResumeRefusal("run", "personal:aaaaaaaaaaaa")).toBe(CODEX_HOME_CHANGED);
    expect(codexResumeRefusal("personal:aaaaaaaaaaaa", "run")).toBe(CODEX_HOME_CHANGED);
    expect(codexResumeRefusal("personal:aaaaaaaaaaaa", "personal:bbbbbbbbbbbb")).toBe(CODEX_HOME_CHANGED);
  });

  it("refuses a folder that is not known", () => {
    for (const v of [undefined, "", 7, null]) expect(codexResumeRefusal(v, "run")).toBe(CODEX_HOME_UNKNOWN);
  });
});

describe("codexIsolationMode", () => {
  it.each([
    [false, true, true, "off"],
    [false, false, false, "off"],
    [true, true, false, "private"],
    [true, false, true, "private"],
    [true, false, false, "ignore-config"],
  ] as const)("isolate=%s local=%s key=%s gives %s", (isolate, local, hasKey, want) => {
    expect(codexIsolationMode({ isolate, local, hasKey })).toBe(want);
  });
});

describe("privateCodexHome", () => {
  const tmpDir = () => mkdtempSync(join(tmpdir(), "pch-"));

  it("makes a 0700 folder under the run folder", () => {
    const dir = tmpDir();
    try {
      expect(privateCodexHome(dir)).toEqual({ CODEX_HOME: join(dir, "home", ".codex"), HOME: join(dir, "home") });
      expect(statSync(join(dir, "home", ".codex")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a symlink at the path and leaves its target alone", () => {
    const dir = tmpDir();
    try {
      const target = join(dir, "elsewhere");
      mkdirSync(target);
      mkdirSync(join(dir, "home"));
      symlinkSync(target, join(dir, "home", ".codex"));
      expect("CODEX_HOME" in privateCodexHome(dir)).toBe(true);
      expect(lstatSync(join(dir, "home", ".codex")).isSymbolicLink()).toBe(false);
      expect(lstatSync(target).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the folder cannot be made, with no CODEX_HOME", () => {
    const r = privateCodexHome("/x", () => {
      throw new Error("no");
    });
    expect("refused" in r && r.refused.startsWith(CODEX_HOME_REFUSED)).toBe(true);
    expect("CODEX_HOME" in r).toBe(false);
  });
});

describe("codexIsolationLine", () => {
  it("has no line for off and a Codex: line for the others", () => {
    expect(codexIsolationLine("off")).toBeUndefined();
    for (const m of ["private", "ignore-config", "unsupported"] as const) expect(codexIsolationLine(m)).toMatch(/^Codex: /);
    expect(codexIsolationLine("ignore-config")).toContain("personal skills, AGENTS.md and command rules still apply");
  });
});
