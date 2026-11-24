import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deniedProgram, findOnPath, imageToolRules, installedImageTools, projectScriptRules, readGateRefusals, refusedCommand, refusedCommandReason, refusedCommandStop, stepCommands,
} from "../src/agents/command-allow.js";
import { mergeRules, writable } from "../src/agents/run.js";
import { loadFlow } from "../src/flow/load.js";
import type { ClaudeStep } from "../src/flow/schema.js";

let tmp: string;
let bin: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "command-allow-"));
  bin = join(tmp, "bin");
  mkdirSync(bin);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const tool = (name: string, mode = 0o755) => {
  writeFileSync(join(bin, name), "#!/bin/sh\n");
  chmodSync(join(bin, name), mode);
};

describe("finding image tools", () => {
  it("finds executable files only, and skips folders", () => {
    tool("magick");
    tool("cwebp", 0o644);
    mkdirSync(join(bin, "sips"));
    expect(findOnPath("magick", bin)).toBeTruthy();
    expect(findOnPath("cwebp", bin)).toBeUndefined();
    expect(findOnPath("sips", bin)).toBeUndefined();
    expect(findOnPath("magick", undefined)).toBeUndefined();
    expect(findOnPath("magick", bin, [bin])).toBeUndefined();
    expect(installedImageTools(bin).map((t) => t.name)).toEqual(["magick"]);
  });

  it("finds a tool whose file is a symlink to a binary with another name, under the tool's own name", () => {
    writeFileSync(join(tmp, "weird-binary"), "#!/bin/sh\n");
    chmodSync(join(tmp, "weird-binary"), 0o755);
    symlinkSync(join(tmp, "weird-binary"), join(bin, "magick"));
    const tools = installedImageTools(bin);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("magick");
    expect(tools[0]!.path).toBe(realpathSync(join(tmp, "weird-binary")));
  });

  it("gives qlmanage a -t rule", () => {
    expect(imageToolRules(["magick", "qlmanage"])).toEqual(["Bash(magick *)", "Bash(qlmanage -t *)"]);
  });
});

describe("projectScriptRules", () => {
  const pkg = (scripts: Record<string, string>) => writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts }));

  it("allows build and test scripts only", () => {
    pkg({ build: "x", test: "x", "test:unit": "x", "build.ui": "x", lint: "x", deploy: "x", postinstall: "x", "test;rm": "x", "test x": "x", "build(": "x", testing: "x" });
    const rules = projectScriptRules(tmp);
    expect(rules).toEqual(expect.arrayContaining(["Bash(npm run build)", "Bash(npm run test:unit)", "Bash(npm run build.ui *)", "Bash(npm test)", "Bash(npm test *)"]));
    for (const bad of ["lint", "deploy", "postinstall", "test;rm", "test x", "build(", "testing"]) expect(rules.join("\n")).not.toContain(`run ${bad}`);
  });

  it("gives nothing without a usable package.json, and adds pnpm and yarn only with their lock file", () => {
    expect(projectScriptRules(tmp)).toEqual([]);
    writeFileSync(join(tmp, "package.json"), "{bad");
    expect(projectScriptRules(tmp)).toEqual([]);
    writeFileSync(join(tmp, "package.json"), " ".repeat(1_000_001));
    expect(projectScriptRules(tmp)).toEqual([]);
    pkg({ build: "x" });
    expect(projectScriptRules(tmp).join()).not.toContain("pnpm");
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    writeFileSync(join(tmp, "yarn.lock"), "");
    const rules = projectScriptRules(tmp);
    expect(rules).toEqual(expect.arrayContaining(["Bash(pnpm run build)", "Bash(yarn run build)"]));
  });

  it("is capped at 40 rules", () => {
    pkg(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`test:${i}`, "x"])));
    expect(projectScriptRules(tmp)).toHaveLength(40);
  });
});

describe("stepCommands", () => {
  const o = (over: Record<string, unknown> = {}) => ({ runDir: join(tmp, "run"), workdir: join(tmp, "ws"), path: bin, declaredProfile: false, attempt: 1, ...over });
  beforeEach(() => mkdirSync(join(tmp, "ws"), { recursive: true }));

  it("does nothing without allow_commands, or with a declared tool profile", () => {
    expect(stepCommands({ id: "a" }, o()).rules).toEqual([]);
    const c = stepCommands({ id: "a", allow_commands: ["images"] }, o({ declaredProfile: true }));
    expect(c.rules).toEqual([]);
    expect(c.binDir).toBeUndefined();
    expect(c.log).toMatch(/declared tool profile/);
  });

  it("writes read-only wrappers with the paths fixed, and removes its folders", () => {
    tool("magick");
    const c = stepCommands({ id: "a", allow_commands: ["images"] }, o());
    expect(c.rules).toEqual(["Bash(magick *)"]);
    const wrapper = join(c.binDir!, "magick");
    const text = readFileSync(wrapper, "utf8");
    expect(text).toContain("image-gate.mjs");
    expect(text).toContain(c.refusalLog!);
    expect(statSync(wrapper).mode & 0o777).toBe(0o555);
    expect(statSync(c.binDir!).mode & 0o222).toBe(0);
    expect(c.logDir!.startsWith(join(tmp, "ws"))).toBe(false);
    expect(existsSync(c.refusalLog!)).toBe(true);
    c.cleanup();
    expect(existsSync(c.binDir!)).toBe(false);
    expect(existsSync(c.logDir!)).toBe(false);
  });

  it("gives every attempt its own folders", () => {
    tool("magick");
    const a = stepCommands({ id: "a", allow_commands: ["images"] }, o());
    const b = stepCommands({ id: "a", allow_commands: ["images"] }, o());
    expect(a.binDir).not.toBe(b.binDir);
    expect(a.logDir).not.toBe(b.logDir);
    a.cleanup();
    expect(existsSync(b.binDir!)).toBe(true);
    b.cleanup();
  });

  it("adds project script rules and ignores the wrapper folder when it looks for tools", () => {
    writeFileSync(join(tmp, "ws", "package.json"), JSON.stringify({ scripts: { build: "x" } }));
    const c = stepCommands({ id: "a", allow_commands: ["images", "project_scripts"] }, o());
    expect(c.rules).toContain("Bash(npm run build)");
    expect(c.binDir).toBeUndefined();
    expect(c.log).toMatch(/none installed/);
    tool("magick");
    const first = stepCommands({ id: "a", allow_commands: ["images"] }, o());
    const second = stepCommands({ id: "a", allow_commands: ["images"] }, o({ path: `${first.binDir}:${bin}` }));
    expect(readFileSync(join(second.binDir!, "magick"), "utf8")).not.toContain(first.binDir!);
    first.cleanup();
    second.cleanup();
  });
});

describe("rules and writable folders", () => {
  it("adds the extra folder and rules, and changes nothing without them", () => {
    expect(writable({})).toBeUndefined();
    expect(writable({}, undefined, ["/x/log"])).toEqual(["/x/log"]);
    expect(mergeRules(undefined, undefined)).toBeUndefined();
    expect(mergeRules(["A"], undefined)).toEqual(["A"]);
    expect(mergeRules(["A"], ["A", "B"])).toEqual(["A", "B"]);
    expect(mergeRules(undefined, ["B"])).toEqual(["B"]);
  });
});

describe("refusals", () => {
  it("reads the gate's log, cleaned and capped", () => {
    const log = join(tmp, "log");
    expect(readGateRefusals(log)).toEqual([]);
    expect(readGateRefusals(undefined)).toEqual([]);
    writeFileSync(log, ["magick a b", "magick a b", "cwebp\t\u0001x", "", "1", "2", "3", "4"].join("\n"));
    const got = readGateRefusals(log);
    expect(got).toHaveLength(5);
    expect(got[0]).toBe("Bash: magick a b");
    expect(got[1]).toBe("Bash: cwebp x");
  });

  it("names the program of a Bash denial", () => {
    expect(deniedProgram("Bash: FOO=1 /usr/bin/curl x")).toBe("curl");
    expect(deniedProgram("Edit: a.txt")).toBeUndefined();
  });

  it("does not follow a symlink for the log, and reads only its start", () => {
    const log = join(tmp, "log");
    const target = join(tmp, "protected");
    writeFileSync(target, "secret line\n");
    symlinkSync(target, log);
    expect(readGateRefusals(log)).toEqual([]);
    rmSync(log);
    writeFileSync(log, "magick a b\n".repeat(20_000));
    const got = readGateRefusals(log);
    expect(got).toEqual(["Bash: magick a b"]);
    rmSync(log);
    mkdirSync(log);
    expect(readGateRefusals(log)).toEqual([]);
  });

  it("finds the marker only at the start of a line", () => {
    expect(refusedCommand({ output: "done\nREFUSED_COMMAND: magick a.jpg a.png\n" })).toBe("magick a.jpg a.png");
    expect(refusedCommand({ output: "REFUSED_COMMAND: `cwebp a b`" })).toBe("cwebp a b");
    expect(refusedCommand({ output: "end your answer with the line `REFUSED_COMMAND: x`" })).toBeUndefined();
    expect(refusedCommand({ output: "REFUSED_COMMAND: <the command>" })).toBeUndefined();
    expect(refusedCommand({ output: `REFUSED_COMMAND: ${"x".repeat(300)}` })).toHaveLength(120);
  });

  it("finds an image-tool denial, and a program refused on the earlier visit", () => {
    expect(refusedCommand({ output: "ok", denied: ["Bash: magick /etc/hosts out.png"] })).toBe("magick /etc/hosts out.png");
    expect(refusedCommand({ output: "ok", denied: ["Bash: curl x"] })).toBeUndefined();
    expect(refusedCommand({ output: "ok", denied: ["Bash: curl x"], earlierDenied: ["Bash: A=1 curl y"] })).toBe("curl x");
    expect(refusedCommand({ output: "ok", denied: ["Bash: curl x"], earlierDenied: ["Bash: wget y", "Edit: curl"] })).toBeUndefined();
    expect(refusedCommand({ output: "ok", denied: ["Edit: magick"] })).toBeUndefined();
  });

  it("explains in plain words", () => {
    expect(refusedCommandReason("implement", "magick a b")).toBe('step "implement" needs a command that is not allowed: magick a b. Install the tool or allow the command in the flow, then resume the run.');
  });

  const step = (allow = true) => ({ id: "s", type: "claude", prompt: "x", ...(allow ? { allow_commands: ["images"] } : {}) }) as unknown as ClaudeStep;
  const engine = (history: { id: string; denied?: string[] }[] = []) => ({ summary: { history } as never, log: () => {} });
  const ok = { ok: true, output: "done" };

  it("turns an ok answer with a marker or an image refusal into a stop", () => {
    const marked = refusedCommandStop(step(), { prefix: "" }, engine(), { ...ok, output: "REFUSED_COMMAND: cwebp a" });
    expect(marked).toMatchObject({ ok: false, refusedCommand: "cwebp a" });
    expect(marked.error).toContain("cwebp a");
    expect(refusedCommandStop(step(), { prefix: "" }, engine(), { ...ok, denied: ["Bash: magick /etc/hosts o"] }).refusedCommand).toBe("magick /etc/hosts o");
  });

  it("uses the latest earlier record of the same step, scoped by prefix", () => {
    const history = [{ id: "sub/s", denied: ["Bash: curl a"] }];
    expect(refusedCommandStop(step(), { prefix: "sub/" }, engine(history), { ...ok, denied: ["Bash: curl b"] }).refusedCommand).toBe("curl b");
    expect(refusedCommandStop(step(), { prefix: "" }, engine(history), { ...ok, denied: ["Bash: curl b"] }).refusedCommand).toBeUndefined();
  });

  it("leaves other results alone", () => {
    const res = { ...ok, output: "REFUSED_COMMAND: x" };
    expect(refusedCommandStop(step(false), { prefix: "" }, engine(), res)).toBe(res);
    for (const r of [{ ...res, limited: true }, { ...res, held: "abc" }, { ...res, error: "timed out after 5s" }]) {
      expect(refusedCommandStop(step(), { prefix: "" }, engine(), r)).toBe(r);
    }
    const aborted = { ...engine(), signal: AbortSignal.abort() };
    expect(refusedCommandStop(step(), { prefix: "" }, aborted, res)).toBe(res);
  });
});

describe("the shipped flows", () => {
  const WITH = ["implement", "fix_guard", "fix_tests", "fix_tests_1", "fix_tests_2", "fix_fixed_tests", "address_review_1", "address_review_2", "resolve_conflicts", "resolve_back", "fix_develop", "fix_back"];
  for (const name of ["issue-gitflow", "issue-code-daily"]) {
    it(`${name}: the code steps carry allow_commands, the reviewers and docs do not`, () => {
      const { flow } = loadFlow(name, process.cwd());
      const claude = flow.steps.filter((s): s is ClaudeStep => s.type === "claude");
      for (const s of claude) {
        if (WITH.includes(s.id)) {
          expect(s.allow_commands, s.id).toEqual(["images", "project_scripts"]);
          expect(s.prompt, s.id).toContain("REFUSED_COMMAND:");
        } else if (/^review_|^docs$/.test(s.id)) {
          expect(s.allow_commands, s.id).toBeUndefined();
          expect(s.prompt, s.id).not.toContain("REFUSED_COMMAND:");
        }
      }
      expect(claude.some((s) => s.id === "implement" && s.allow_commands)).toBe(true);
    });
  }

  it("the conflict prompt mentions the build scripts", () => {
    const step = loadFlow("issue-gitflow", process.cwd()).flow.steps.find((s) => s.id === "resolve_conflicts") as ClaudeStep;
    expect(step.prompt).toContain("npm run build");
  });
});
