import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateStep } from "../src/self-update-state.js";
import { detectTestCmd, passedBefore, pinsTests, sameTests, testedKey } from "../src/self-update-tests.js";

const dirs: string[] = [];
const make = (files: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "scf-rec-"));
  dirs.push(d);
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(dirname(join(d, k)), { recursive: true });
    writeFileSync(join(d, k), v);
  }
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("testedKey", () => {
  it("is what the flows compute with printf and shasum", () => {
    const tree = "0123456789abcdef0123456789abcdef01234567";
    for (const cmd of ["npm ci && npm test", `sh -c 'echo "$HOME"'`]) {
      const sh = execFileSync("sh", ["-c", "printf '%s\\n%s\\n' \"$1\" \"$2\" | shasum | cut -c1-40", "sh", tree, cmd], { encoding: "utf8" }).trim();
      expect(testedKey(tree, cmd)).toBe(sh);
    }
  });
});

describe("passedBefore", () => {
  const tree = "0123456789abcdef0123456789abcdef01234567";
  const other = "89abcdef0123456789abcdef0123456789abcdef";
  const good = `run r1, 2026-01-01T00:00Z, tree ${tree}`;
  const put = (d: string, content: string, cmd = "npm test") => writeFileSync(join(d, testedKey(tree, cmd)), content);

  it("returns the run and the time of a checked record", () => {
    const d = make();
    put(d, `${good}\n`);
    expect(passedBefore(d, tree, "npm test")).toBe("run r1, 2026-01-01T00:00Z");
    put(d, good);
    expect(passedBefore(d, tree, "npm test")).toBe("run r1, 2026-01-01T00:00Z");
  });

  it("rejects everything else", () => {
    const d = make();
    const bad = ["run X, 2026-01-01T00:00Z\n", `run r1, 2026-01-01T00:00Z, tree ${other}\n`, `${good}\n${good}\n`, ` ${good}\n`, `${good}\r\n`, "",
      `${good}\n${"x".repeat(200)}`, `run a b, 2026-01-01T00:00Z, tree ${tree}\n`, `run $(x), 2026-01-01T00:00Z, tree ${tree}\n`];
    for (const c of bad) {
      put(d, c);
      expect(passedBefore(d, tree, "npm test"), JSON.stringify(c)).toBeUndefined();
    }
  });

  it("rejects a record at the key of another command, a missing file, a folder and a symlink", () => {
    const d = make();
    put(d, `${good}\n`, "npm ci && npm test");
    expect(passedBefore(d, tree, "npm test")).toBeUndefined();
    expect(passedBefore(join(d, "nope"), tree, "npm test")).toBeUndefined();
    mkdirSync(join(d, testedKey(tree, "x")));
    expect(passedBefore(d, tree, "x")).toBeUndefined();
    writeFileSync(join(d, "real"), `${good}\n`);
    symlinkSync(join(d, "real"), join(d, testedKey(tree, "y")));
    expect(passedBefore(d, tree, "y")).toBeUndefined();
  });

  it("rejects a bad tree and an empty command, and never throws", () => {
    const d = make();
    writeFileSync(join(d, testedKey(tree.toUpperCase(), "npm test")), `${good}\n`);
    expect(passedBefore(d, tree.toUpperCase(), "npm test")).toBeUndefined();
    expect(passedBefore(d, tree.slice(1), "npm test")).toBeUndefined();
    put(d, `${good}\n`, "");
    expect(passedBefore(d, tree, "")).toBeUndefined();
    writeFileSync(join(d, "file"), "x");
    expect(passedBefore(join(d, "file"), tree, "npm test")).toBeUndefined();
  });
});

describe("detectTestCmd and pinsTests", () => {
  const pkg = { "package.json": '{"scripts":{"test":"x"}}', "package-lock.json": "{}" };

  it("reads what tools/detect-commands prints", async () => {
    expect(await detectTestCmd(make(pkg))).toBe("npm ci && npm test");
    expect(await detectTestCmd(make({ ...pkg, "node_modules/.keep": "" }))).toBe("npm test");
    expect(await detectTestCmd(make({ ".claude-factory/config.yaml": 'test_cmd: "true"\n' }))).toBe("true");
  });

  it("gives undefined for nothing, a missing tool and more than one line", async () => {
    expect(await detectTestCmd(make())).toBeUndefined();
    expect(await detectTestCmd(make(pkg), join(tmpdir(), "no-such-tool"))).toBeUndefined();
    const tool = join(make({ "t.sh": "echo a\necho b\n" }), "t.sh");
    expect(await detectTestCmd(make(), tool)).toBeUndefined();
  });

  it("pinsTests: false when nothing is pinned, true on any mention or on a file that cannot be read", () => {
    const cfg = (c: string) => make({ ".claude-factory/config.yaml": c });
    expect(pinsTests(make())).toBe(false);
    expect(pinsTests(cfg("vars: { lint_cmd: x }\n"))).toBe(false);
    expect(pinsTests(make({ ".claude-factory": "file" }))).toBe(false);
    for (const c of ['test_cmd: "true"\n', "vars:\n  test_cmd: npm ci && npm test\n", 'vars: { test_cmd: "npm test" }\n', '"test_cmd": npm test\n', "test_cmd: auto\n"]) {
      expect(pinsTests(cfg(c)), c).toBe(true);
    }
    const d = make();
    mkdirSync(join(d, ".claude-factory", "config.yaml"), { recursive: true });
    expect(pinsTests(d)).toBe(true);
  });
});

describe("sameTests", () => {
  const step: UpdateStep = { name: "test", cmd: "npm", args: ["test"] };
  it("accepts the step's own command, alone or after npm ci", () => {
    expect(sameTests(step, "npm test")).toBe(true);
    expect(sameTests(step, "npm ci && npm test")).toBe(true);
  });
  it("rejects every other command and unsafe steps", () => {
    for (const c of ["true", "npm test && x", "npm ci && npm ci && npm test", "npm  test", "yarn install && npm test", undefined, ""]) {
      expect(sameTests(step, c), String(c)).toBe(false);
    }
    expect(sameTests(undefined, "npm test")).toBe(false);
    expect(sameTests({ name: "test", cmd: "sh", args: ["-c", "npm test"] }, "sh -c npm test")).toBe(false);
    expect(sameTests({ name: "test", cmd: "sh", args: ["a;b"] }, "sh a;b")).toBe(false);
  });
});
