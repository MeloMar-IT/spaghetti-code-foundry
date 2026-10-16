import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A static check of the code that reads skills: no network module, no process, no fetch.
// It does not cover helpers outside src/skills/ (for example src/home.ts, which starts `du`); they are
// not on the path of a skill read and are not imported by the modules listed here.

const SKILLS = "src/skills";
const BUILTIN = new Set(["crypto", "fs", "path", "os", "url", "module"]);
const PACKAGES = new Set(["zod", "yaml"]);
const OUTSIDE = new Set(["../config.js", "../auth/store.js", "../auth/repo-url.js", "../engine/state.js", "../flow/schema.js", "../home.js", "../home-migrate.js", "../engine/local-git.js", "../flow/load.js"]);

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
    it("local-git.ts starts one local `git` with an argument array, and no network API", () => {
      const text = readFileSync("src/engine/local-git.ts", "utf8");
      const code = codeLines(text);
      const starts = code.filter((l) => /\b(?:spawn|spawnSync)\s*\(/.test(l));
      expect(starts).toHaveLength(1);
      expect(starts[0]).toContain('spawnSync("git", [...args], {');
      expect(code.filter((l) => /(?<![.\w])exec\s*\(|execSync|execFile|\bfork\s*\(|\bshell\b/.test(l))).toEqual([]);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual(["node:child_process"]);
    });
    it("cli.ts uses no process and no network", () => {
      const text = readFileSync("src/skill-import/cli.ts", "utf8");
      const code = codeLines(text);
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual([]);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
    it("evaluate-cli.ts uses no process and no network", () => {
      const text = readFileSync("src/skill-import/evaluate-cli.ts", "utf8");
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual([]);
      expect(codeLines(text).filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
    it("compare.ts is pure and compare-cli.ts starts no process and no network", () => {
      const pure = readFileSync("src/skills/compare.ts", "utf8");
      for (const name of modulesOf(pure)) expect(name.startsWith("./") && name.endsWith(".js"), name).toBe(true);
      expect(codeLines(pure).filter((l) => /\bprocess\.|child_process|\bfs\b|node:fs/.test(l))).toEqual([]);
      const cli = readFileSync("src/skills/compare-cli.ts", "utf8");
      expect(modulesOf(cli).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual([]);
      expect(codeLines(cli).filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
    it("ls-remote.ts starts one detached `git ls-remote` and nothing else", () => {
      const text = readFileSync("src/skill-import/ls-remote.ts", "utf8");
      const code = codeLines(text);
      const starts = code.filter((l) => /\b(?:spawn|spawnSync)\s*\(/.test(l));
      expect(starts).toHaveLength(1);
      expect(starts[0]).toContain('spawn("git", [...OPTIONS, "ls-remote", "--quiet", "--", url, ...patterns], {');
      expect(starts[0]).toContain("detached: true");
      expect(code.filter((l) => /\bspawnSync\b|(?<![.\w])exec\s*\(|execSync|execFile|\bfork\s*\(/.test(l))).toEqual([]);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual(["node:child_process"]);
    });
    it("catalogue-git.ts names exactly the git commands of the update and starts only git and gh with argument arrays", () => {
      const text = readFileSync("src/skill-import/catalogue-git.ts", "utf8");
      const code = codeLines(text);
      const m = text.match(/CATALOGUE_GIT_COMMANDS\s*=\s*\[([^\]]*)\]/);
      expect([...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual(["config", "rev-parse", "symbolic-ref", "fetch", "ls-tree", "cat-file", "hash-object", "read-tree", "update-index", "write-tree", "commit-tree", "push", "ls-remote"]);
      const starts = code.filter((l) => /\b(?:spawn|spawnSync)\s*\(/.test(l));
      expect(starts).toHaveLength(2);
      expect(starts[0]).toContain('spawnSync("git", [cmd, ...rest], {');
      expect(starts[1]).toContain("spawnSync(ghBin(ctx.env), args, {");
      expect(code.filter((l) => /(?<![.\w])exec\s*\(|execSync|execFile|\bfork\s*\(|\bshell\b|\bspawn\s*\(/.test(l))).toEqual([]);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      expect(modulesOf(text).filter((x) => NETWORK_MODULES.test(`"${x}"`))).toEqual(["node:child_process"]);
      // the tool never merges, approves, closes or readies a pull request: no such gh word is in the code
      expect(code.filter((l) => /"(?:merge|close|review|--approve|ready)"/.test(l))).toEqual([]);
    });
    it("update-cli.ts uses no process and no network", () => {
      const text = readFileSync("src/skill-import/update-cli.ts", "utf8");
      expect(modulesOf(text).filter((x) => NETWORK_MODULES.test(`"${x}"`))).toEqual([]);
      expect(codeLines(text).filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
    it("source-update.ts reads no file, starts no process and reads no clock", () => {
      const text = readFileSync(join(SKILLS, "source-update.ts"), "utf8");
      expect(modulesOf(text).filter((x) => /^(?:node:)?(?:fs|fs\/promises|os|child_process|path|process)$/.test(x))).toEqual([]);
      expect(codeLines(text).filter((l) => /Date\.now|new Date|process\./.test(l))).toEqual([]);
    });
    it("the update modules import nothing that pins, locks or releases", () => {
      for (const f of ["src/skills/source-update.ts", "src/skill-import/update-cli.ts", "src/skill-import/catalogue-git.ts"]) {
        expect(modulesOf(readFileSync(f, "utf8")).filter((x) => /(?:registry|lock|release|promotion|selections)\.js$/.test(x)), f).toEqual([]);
      }
    });
    it("discover-cli.ts uses no process and no network", () => {
      const text = readFileSync("src/skill-import/discover-cli.ts", "utf8");
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual([]);
      expect(codeLines(text).filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
    });
    it("discovery code imports nothing that approves, pins, stages or releases", () => {
      for (const f of ["src/skills/discovery.ts", "src/skill-import/discover-cli.ts", "src/skill-import/ls-remote.ts"]) {
        const mods = modulesOf(readFileSync(f, "utf8"));
        expect(mods.filter((m) => /(?:registry|lock|import-plan|import-stage|release)\.js$/.test(m)), f).toEqual([]);
      }
    });
    it("only the discovery modules know the candidate list", () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
      const own = new Set(["src/skills/discovery.ts", "src/skill-import/discover-cli.ts", "src/skill-import/ls-remote.ts"]);
      const users = walk("src").filter((f) => {
        const text = readFileSync(f, "utf8");
        return text.includes("skill-source-candidates") || modulesOf(text).some((m) => /(?:^|\/)discovery\.js$/.test(m));
      });
      expect(users.filter((f) => !own.has(f))).toEqual([]);
    });
    it("only src/cli.ts and the skill source sweeper import from src/skill-import/", () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
      const files = walk("src");
      expect(files.length).toBeGreaterThan(50);
      const importers = files.filter((f) => modulesOf(readFileSync(f, "utf8")).some((m) => /skill-import\//.test(m)));
      expect(importers.filter((f) => !f.startsWith("src/skill-import/"))).toEqual(["src/cli.ts", "src/server/skill-update-sweep.ts"]); // the sweeper runs `skills update --due` in the server (#559)
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

describe("the static scanner runs nothing", () => {
  const FORBIDDEN_MODULES = /^(?:node:)?(?:child_process|vm|worker_threads|fs|fs\/promises|http|https|http2|net|tls|dns|dgram)$/;
  const DYNAMIC_CODE = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/];

  it("scan.ts imports exactly the reviewed modules", () => {
    const mods = modulesOf(readFileSync(join(SKILLS, "scan.ts"), "utf8"));
    expect([...mods].sort()).toEqual(
      ["node:crypto", "./credential-scan.js", "./import-plan.js", "./normalize.js", "./package.js", "./schema.js", "./scan-rules.js", "./sources.js"].sort(),
    );
  });
  it("scan-rules.ts has no imports", () => {
    expect(modulesOf(readFileSync(join(SKILLS, "scan-rules.ts"), "utf8"))).toEqual([]);
  });
  for (const f of ["scan.ts", "scan-rules.ts"]) {
    it(`${f} imports no process, VM, file or network module and uses no dynamic code`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => FORBIDDEN_MODULES.test(m))).toEqual([]);
      const code = codeLines(text);
      for (const re of DYNAMIC_CODE) expect(code.filter((l) => re.test(l)), String(re)).toEqual([]);
    });
  }
});

describe("the workflow gate runs nothing", () => {
  const FORBIDDEN_MODULES = /^(?:node:)?(?:child_process|vm|worker_threads|fs|fs\/promises|http|https|http2|net|tls|dns|dgram)$/;
  const DYNAMIC_CODE = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/];
  it("workflow-rules.ts has no imports", () => {
    expect(modulesOf(readFileSync(join(SKILLS, "workflow-rules.ts"), "utf8"))).toEqual([]);
  });
  for (const f of ["workflow.ts", "workflow-rules.ts"]) {
    it(`${f} imports no process, VM, file or network module and uses no dynamic code`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => FORBIDDEN_MODULES.test(m))).toEqual([]);
      const code = codeLines(text);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      for (const re of DYNAMIC_CODE) expect(code.filter((l) => re.test(l)), String(re)).toEqual([]);
    });
  }
});

describe("scf skills scan is offline and read-only", () => {
  const PROCESS_OR_NET = /^(?:node:)?(?:child_process|vm|worker_threads|http|https|http2|net|tls|dns|dgram)$/;
  const DYNAMIC_CODE = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/];
  for (const f of ["cli.ts", "staged-import.ts", "selections-evaluate-cli.ts", "profile-evaluate-cli.ts", "profile-evaluate.ts", "profile-canonical.ts", "profile-evaluations.ts", "scan-staged.ts", "import-stage.ts", "import-evidence.ts", "licence.ts", "licence-rules.ts", "promotion.ts", "scan-exceptions.ts", "selections.ts", "import-plan.ts", "normalize.ts", "suite-records.ts", "suite-checks.ts", "suite-rules.ts"]) {
    it(`${f} imports no process or network module and uses no dynamic code`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => PROCESS_OR_NET.test(m))).toEqual([]);
      const code = codeLines(text);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      for (const re of DYNAMIC_CODE) expect(code.filter((l) => re.test(l)), String(re)).toEqual([]);
    });
  }
  it("scf skills promote check reads no file in the pure modules and calls no process", () => {
    for (const f of ["import-evidence.ts", "licence.ts", "licence-rules.ts", "promotion.ts", "suite-checks.ts", "suite-rules.ts"]) {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => /^(?:node:)?(?:fs|fs\/promises|child_process)$/.test(m)), f).toEqual([]);
      expect(modulesOf(text).filter((m) => PROCESS_OR_NET.test(m)), f).toEqual([]);
    }
  });
  it("only the CLI and the pure evaluation import selections.js, so no run reads the file", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const users = walk("src").filter((f) => modulesOf(readFileSync(f, "utf8")).some((m) => /(?:^|\/)selections\.js$/.test(m)));
    expect(users.sort()).toEqual([join("src", "skills", "cli.ts"), join("src", "skills", "selections-evaluate-cli.ts"), join("src", "skills", "source-skill-evaluation.ts"), join("src", "skills", "staged-import.ts")]);
  });
  it("only src/skills/cli.ts imports selections-evaluate-cli.js", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const users = walk("src").filter((f) => modulesOf(readFileSync(f, "utf8")).some((m) => /^\.\/selections-evaluate-cli\.js$/.test(m)));
    expect(users).toEqual([join("src", "skills", "cli.ts")]);
  });
  it("selections-evaluate-cli.ts writes nothing and stages nothing", () => {
    for (const f of ["selections-evaluate-cli.ts"]) {
      const code = codeLines(readFileSync(join(SKILLS, f), "utf8"));
      expect(code.filter((l) => /writeFileSync|mkdirSync|renameSync|rmSync|unlinkSync|publishImport|pinSkill|pinBuiltinSkills|removeSkillPin|stageImport/.test(l)), f).toEqual([]);
    }
  });
  it("profile-evaluate-cli.ts, profile-evaluate.ts and scan-staged.ts write nothing, stage nothing and take no lock", () => {
    for (const f of ["profile-evaluate-cli.ts", "profile-evaluate.ts", "profile-canonical.ts", "scan-staged.ts"]) {
      const code = codeLines(readFileSync(join(SKILLS, f), "utf8"));
      expect(code.filter((l) => /writeFileSync|mkdirSync|renameSync|rmSync|unlinkSync|publishImport|pinSkill|pinBuiltinSkills|removeSkillPin|stageImport|claimHomeWrite|\b[lL]ock|[a-z]Lock\b/.test(l)), f).toEqual([]);
    }
  });
  it("only src/skills/cli.ts imports profile-evaluate-cli.js", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const users = walk("src").filter((f) => modulesOf(readFileSync(f, "utf8")).some((m) => /^\.\/profile-evaluate-cli\.js$/.test(m)));
    expect(users).toEqual([join("src", "skills", "cli.ts")]);
  });
  for (const f of ["profile-evaluate.ts", "profile-canonical.ts"]) {
    it(`${f} reads no file and no clock`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => /^(?:node:)?(?:fs|fs\/promises|child_process|process)$/.test(m))).toEqual([]);
      expect(codeLines(text).filter((l) => /\bprocess\.|Date\.now|new Date/.test(l))).toEqual([]);
    });
  }
  it("only source-evaluation.ts imports source-skill-evaluation.js", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const users = walk("src").filter((f) => modulesOf(readFileSync(f, "utf8")).some((m) => /(?:^|\/)source-skill-evaluation\.js$/.test(m)));
    // skill-eval/score.ts reads the registered skills as baselines for `scf skills score --agent`
    expect(users.sort()).toEqual([join("src", "skill-eval", "score.ts"), join("src", "skills", "overlap.ts"), join("src", "skills", "source-evaluation.ts")]);
  });
  it("suite-rules.ts has no imports", () => {
    expect(modulesOf(readFileSync(join(SKILLS, "suite-rules.ts"), "utf8"))).toEqual([]);
  });
  it("provider-rules.ts has no imports", () => {
    expect(modulesOf(readFileSync(join(SKILLS, "provider-rules.ts"), "utf8"))).toEqual([]);
  });
  it("the source skill evaluation imports no process, file or network module and reads no clock", () => {
    const forbidden = /^(?:node:)?(?:child_process|vm|worker_threads|fs|fs\/promises|http|https|http2|net|tls|dns|dgram|process)$/;
    for (const f of ["source-skill-evaluation.ts", "provider-rules.ts"]) {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => forbidden.test(m)), f).toEqual([]);
      expect(codeLines(text).filter((l) => /\bprocess\.|Date\.now|new Date/.test(l)), f).toEqual([]);
    }
  });
  it("src/skills/cli.ts imports nothing from skill-import/", () => {
    expect(modulesOf(readFileSync(join(SKILLS, "cli.ts"), "utf8")).filter((m) => /skill-import\//.test(m))).toEqual([]);
  });
  it("scf skills score and gate start no process, call no network and no model, and reach no migration code", () => {
    const files = ["evaluate-cli.ts", "evaluation-store.ts", "staged-import.ts"];
    for (const f of files) {
      const text = readFileSync(join(SKILLS, f), "utf8");
      const mods = modulesOf(text);
      expect(mods.filter((m) => PROCESS_OR_NET.test(m)), f).toEqual([]);
      expect(mods.filter((m) => /\.\.\/(?:agents|steps|engine|server|queue)\/|home-migrate/.test(m)), f).toEqual([]);
      expect(codeLines(text).filter((l) => NETWORK_GLOBALS.test(l)), f).toEqual([]);
      for (const re of DYNAMIC_CODE) expect(codeLines(text).filter((l) => re.test(l)), `${f} ${re}`).toEqual([]);
    }
    // from ../home.js only claimHomeWrite
    const store = readFileSync(join(SKILLS, "evaluation-store.ts"), "utf8");
    expect(store.match(/import \{[^}]*\} from "\.\.\/home\.js"/g)).toEqual(['import { claimHomeWrite } from "../home.js"']);
  });
  it("the readers in evaluation-store.ts call no write function", () => {
    const text = readFileSync(join(SKILLS, "evaluation-store.ts"), "utf8");
    const marker = "// --- read only below this line ---";
    expect(text.split(marker)).toHaveLength(2);
    expect(codeLines(text.split(marker)[1]!).join("\n")).not.toMatch(/writeFileSync|writeSync|mkdirSync|renameSync|linkSync|claimHomeWrite|chmodSync|unlinkSync|rmSync|openSync/);
  });
  it("the reader in import-stage.ts calls no write function", () => {
    const text = readFileSync(join(SKILLS, "import-stage.ts"), "utf8");
    const marker = "// --- read only below this line ---";
    expect(text.split(marker)).toHaveLength(2);
    const below = codeLines(text.split(marker)[1]!).join("\n");
    expect(below).not.toMatch(/writeFileSync|mkdirSync|renameSync|removeTree|acquireLock|claimHomeWrite|importStoreSettings\.rename|chmodSync|unlinkSync|rmSync/);
  });
});

describe("the connector modules run nothing", () => {
  const FORBIDDEN_MODULES = /^(?:node:)?(?:child_process|vm|worker_threads|fs|fs\/promises|http|https|http2|net|tls|dns|dgram|process)$/;
  const DYNAMIC_CODE = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/, /\bprocess\./];
  for (const f of ["connector.ts", "connector-rules.ts"]) {
    it(`${f} imports no process, VM, file or network module and uses no dynamic code`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => FORBIDDEN_MODULES.test(m))).toEqual([]);
      for (const re of DYNAMIC_CODE) expect(codeLines(text).filter((l) => re.test(l)), String(re)).toEqual([]);
    });
  }
  it("import-review.ts is pure: no file, process or clock", () => {
    const text = readFileSync(join(SKILLS, "import-review.ts"), "utf8");
    expect(modulesOf(text).filter((m) => /(?:^|:)(?:fs|os|child_process|path)$/.test(m))).toEqual([]);
    expect(codeLines(text).filter((l) => /Date\.now|new Date|process\./.test(l))).toEqual([]);
  });
  for (const f of ["review-cli.ts", "staged-import.ts"]) {
    it(`${f} calls no write API`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(codeLines(text).filter((l) => /writeFile|appendFile|mkdir|rename|rmSync|unlink|openSync|copyFile|symlink/.test(l))).toEqual([]);
    });
  }
  it("connector-rules.ts has no imports", () => {
    expect(modulesOf(readFileSync(join(SKILLS, "connector-rules.ts"), "utf8"))).toEqual([]);
  });
  it("release-signature.ts imports only node:crypto and ./release.js, and calls no file API", () => {
    const text = readFileSync(join(SKILLS, "release-signature.ts"), "utf8");
    expect(modulesOf(text).sort()).toEqual(["./release.js", "node:crypto"]);
    expect(codeLines(text).filter((l) => /Sync\s*\(|readFile|writeFile|\bfs\b/.test(l))).toEqual([]);
  });
  it("only the release store, publish and CLI modules call publishRelease; the engine and registry never import them", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const files = walk("src");
    expect(files.filter((f) => codeLines(readFileSync(f, "utf8")).some((l) => /publishRelease\(/.test(l))).sort()).toEqual(
      [join(SKILLS, "release-cli.ts"), join(SKILLS, "release-publish.ts"), join(SKILLS, "release-store.ts")].sort(),
    );
    for (const f of [...files.filter((x) => x.startsWith(join("src", "engine"))), join(SKILLS, "registry.ts"), join(SKILLS, "run-lock.ts")]) {
      expect(modulesOf(readFileSync(f, "utf8")).filter((m) => /release-(?:cli|publish)\.js$/.test(m)), f).toEqual([]);
    }
  });
  for (const f of ["release-verify.ts", "release-cli.ts", "release-signature.ts", "release-store.ts", "schema.ts"]) {
    it(`${f} starts no process, opens no connection and does not read the process`, () => {
      const text = readFileSync(join(SKILLS, f), "utf8");
      expect(modulesOf(text).filter((m) => NETWORK_MODULES.test(`"${m}"`))).toEqual([]);
      const code = codeLines(text);
      expect(code.filter((l) => NETWORK_GLOBALS.test(l))).toEqual([]);
      expect(code.filter((l) => /\bprocess\.|spawn|exec\w*\s*\(|\bfork\s*\(/.test(l))).toEqual([]);
    });
  }
});
