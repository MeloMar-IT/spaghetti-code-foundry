import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A static check of the code that reads skills: no network module, no process, no fetch.
// It does not cover helpers outside src/skills/ (for example src/home.ts, which starts `du`); they are
// not on the path of a skill read and are not imported by the modules listed here.

const SKILLS = "src/skills";
const BUILTIN = new Set(["crypto", "fs", "path", "os", "url", "module"]);
const PACKAGES = new Set(["zod", "yaml"]);
const OUTSIDE = new Set(["../config.js", "../auth/store.js", "../auth/repo-url.js", "../engine/state.js", "../flow/schema.js", "../home.js", "../home-migrate.js"]);

const codeLines = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

function modulesOf(text: string): string[] {
  const code = codeLines(text).join("\n");
  const out: string[] = [];
  for (const re of [/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g, /(?:^|\n)\s*import\s+["']([^"']+)["']/g, /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g]) {
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

const NETWORK_GLOBALS = /\bfetch\s*\(|\bWebSocket\b|\bEventSource\b|\bXMLHttpRequest\b/;
const NETWORK_MODULES = /["'](?:node:)?(?:http|https|http2|net|tls|dns|dgram|child_process)["']/;

describe("skill code does not reach the network", () => {
  const files = readdirSync(SKILLS).filter((f) => f.endsWith(".ts"));
  it("has files to check", () => expect(files.length).toBeGreaterThan(10));

  for (const f of files) {
    it(`${f} imports only reviewed modules and calls no network API`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      for (const name of modulesOf(text)) {
        const bare = name.replace(/^node:/, "");
        const allowed = BUILTIN.has(bare) || PACKAGES.has(name) || (name.startsWith("./") && name.endsWith(".js")) || OUTSIDE.has(name);
        expect(allowed, `${f} imports ${name}`).toBe(true);
      }
      expect(codeLines(text).filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
  }

  describe("src/skill-import/", () => {
    const gitText = readFileSync("src/skill-import/git-tree.ts", "utf8");
    const gitCode = codeLines(gitText);

    it("git-tree.ts names exactly four git commands", () => {
      const m = gitText.match(/GIT_COMMANDS\s*=\s*\[([^\]]*)\]/);
      expect([...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual(["init", "fetch", "ls-tree", "cat-file"]);
    });
    it("git-tree.ts starts only git init, fetch, ls-tree and cat-file", () => {
      const starts = gitCode.filter((l) => /\b(?:spawn|spawnSync)\s*\(/.test(l));
      expect(starts.length).toBeGreaterThanOrEqual(4);
      for (const l of starts) expect(l, l).toMatch(/(?:spawn|spawnSync)\("git", argv\("(init|fetch|ls-tree|cat-file)"/);
      expect(gitCode.filter((l) => /\bexec\s*\(|execSync|execFile|\bfork\s*\(/.test(l))).toEqual([]);
    });
    it("git-tree.ts uses no network API and no module but child_process", () => {
      expect(gitCode.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      const net = modulesOf(gitText).filter((m) => NETWORK_MODULES.test(`"${m}"`));
      expect(net).toEqual(["node:child_process"]);
    });
    it("cli.ts uses no process and no network", () => {
      const text = readFileSync("src/skill-import/cli.ts", "utf8");
      const code = codeLines(text);
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual([]);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
    it("only src/cli.ts imports from src/skill-import/", () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
      const files = walk("src");
      expect(files.length).toBeGreaterThan(50);
      const importers = files.filter((f) => modulesOf(readFileSync(f, "utf8")).some((m) => /skill-import\//.test(m)));
      expect(importers.filter((f) => !f.startsWith("src/skill-import/"))).toEqual(["src/cli.ts"]);
      for (const f of walk("src/skill-import")) {
        for (const m of modulesOf(readFileSync(f, "utf8"))) if (m.endsWith(".js") && m.startsWith(".")) expect(m, `${f} imports ${m}`).toMatch(/^\.\.?\//);
        expect(modulesOf(readFileSync(f, "utf8")).filter((m) => /skill-import\//.test(m)), f).toEqual([]);
      }
    });
  });

  for (const f of ["src/engine/skill-lock.ts", "src/engine/plan-carry.ts"]) {
    it(`${f} starts only the two named git commands`, () => {
      const text = readFileSync(f, "utf8");
      const code = codeLines(text);
      expect(code.filter((l) => NETWORK_MODULES.test(l) && !/child_process/.test(l))).toEqual([]);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      expect(code.filter((l) => /\b(?:spawn|spawnSync|execSync|fork)\s*\(|\bexec\s*\(/.test(l))).toEqual([]);
      const calls = [...text.matchAll(/execFileSync\(\s*([^,]+),\s*\[([^\]]*)\]/g)];
      for (const [, cmd, args] of calls) {
        expect(cmd!.trim()).toBe('"git"');
        expect(/^\s*"rev-parse",\s*"HEAD"|^\s*"--literal-pathspecs",\s*"diff",\s*"--quiet"/.test(args!), args).toBe(true);
      }
    });
  }
});
