import { describe, expect, it } from "vitest";
import { CODEX_HOME_CHANGED, CODEX_HOME_UNKNOWN, codexHomeId, codexResumeRefusal } from "../src/agents/codex-home.js";

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
