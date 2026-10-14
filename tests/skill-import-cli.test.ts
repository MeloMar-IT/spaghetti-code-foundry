import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GitTreeError, type GitTree, type GitTreeErrorCode } from "../src/skill-import/git-tree.js";
import { IMPORT_USAGE, skillImportCommand } from "../src/skill-import/cli.js";
import { prepareImport, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const GOOD: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") };

interface Fake extends GitTree {
  closed: number;
}
function fakeTree(files: Record<string, string> = GOOD, hooks: { onList?: () => void; onRead?: () => void } = {}): Fake {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  const t: Fake = {
    closed: 0,
    close() {
      t.closed++;
    },
    list(p) {
      hooks.onList?.();
      return all.filter((e) => p === "." || e.path.startsWith(p + "/"));
    },
    read(entries) {
      hooks.onRead?.();
      return entries.map((e) => Buffer.from(files[e.path]!));
    },
  };
  return t;
}

const source = (over: Record<string, unknown> = {}) => ({
  id: "lib",
  repository: "https://github.com/example/skills",
  status: "enabled",
  ref: { track: "main", approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
  ...over,
});

let dir: string;
let home: string;
let opens: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skill-import-cli-")));
  home = join(dir, "home");
  opens = 0;
  write([source()]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (sources: Record<string, unknown>[]) => writeFileSync(join(dir, "skill-sources.yaml"), stringify({ schema: 1, sources }));

async function run(tree: GitTree | GitTreeErrorCode | (() => GitTree), operands: string[] = ["lib"], values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const rc = await skillImportCommand({ positionals: operands, values }, (l) => lines.push(l), {
    cwd: dir,
    home,
    open: async () => {
      opens++;
      if (typeof tree === "string") throw new GitTreeError(tree);
      return typeof tree === "function" ? tree() : tree;
    },
  });
  return { rc, lines, text: lines.join("\n") };
}
const INTERRUPTED = "PROBLEM the import was interrupted; nothing was staged";
const quarantine = () => existsSync(join(home, "skill-quarantine"));

describe("output and exit codes", () => {
  it("prints the skills, the summary and the folder", async () => {
    const t = fakeTree();
    const r = await run(t);
    expect(r.rc).toBe(0);
    expect(r.lines).toHaveLength(4);
    expect(r.lines[0]).toMatch(/^skills\/a\s+a sha256:[0-9a-f]{64} 1 files \d+ bytes$/);
    expect(r.lines[1]).toMatch(/^skills\/b\s+b sha256:/);
    expect(r.lines[2]).toMatch(/^OK 2 skills staged from github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64} \(staged\)$/);
    expect(r.lines[3]).toBe(`Quarantine: ${join(home, "skill-quarantine", "lib", COMMIT)}`);
    expect(t.closed).toBe(1);
  });

  it("prints the same digest and (unchanged) the second time", async () => {
    const a = await run(fakeTree());
    const b = await run(fakeTree());
    expect(b.rc).toBe(0);
    expect(b.lines[2]).toBe(a.lines[2]!.replace("(staged)", "(unchanged)"));
  });

  it("returns 1 and prints REJECTED for a bad skill", async () => {
    const r = await run(fakeTree({ ...GOOD, "skills/c/SKILL.md": "no frontmatter" }));
    expect(r.rc).toBe(1);
    expect(r.text).toMatch(/REJECTED skills\/c: SKILL\.md/);
    expect(r.text).toContain("OK 2 skills staged");
  });

  it("prints REJECTED lines and PROBLEM when nothing can be staged", async () => {
    const r = await run(fakeTree({ "skills/c/SKILL.md": "bad" }));
    expect(r.rc).toBe(1);
    expect(r.lines[0]).toMatch(/^REJECTED skills\/c:/);
    expect(r.lines.at(-1)).toBe("PROBLEM no skill could be staged");
    expect(quarantine()).toBe(false);
  });
});

describe("manifest problems", () => {
  const none = async (r: ReturnType<typeof run>) => {
    const x = await r;
    expect(x.rc).toBe(1);
    expect(x.text).toMatch(/^PROBLEM /);
    expect(opens).toBe(0);
    expect(quarantine()).toBe(false);
    return x;
  };
  it("unknown id", async () => expect((await none(run(fakeTree(), ["other"]))).text).toBe("PROBLEM no source with the id other"));
  it("disabled source", async () => {
    write([source({ status: "disabled", reason: "paused" })]);
    expect((await none(run(fakeTree()))).text).toContain("only an enabled source can be imported");
  });
  it("missing file", async () => expect((await none(run(fakeTree(), ["lib", "nope.yaml"]))).text).toBe("PROBLEM the skill source file does not exist"));
  it("invalid file", async () => {
    writeFileSync(join(dir, "skill-sources.yaml"), "schema: 2\nsources: []\n");
    await none(run(fakeTree()));
  });
});

describe("syntax", () => {
  it.each([[[]], [["a", "b", "c"]], [["Bad_Id"]]])("rejects operands %j", async (operands) => {
    await expect(run(fakeTree(), operands as string[])).rejects.toThrow("scf skills import <source-id>");
    expect(opens).toBe(0);
  });
  it("rejects an option", async () => {
    await expect(run(fakeTree(), ["lib"], { repo: "." })).rejects.toThrow(/unexpected option --repo[\s\S]*scf skills import <source-id>/);
    expect(IMPORT_USAGE).toContain("<source-id> [<file>]");
  });
});

describe("git errors", () => {
  const SENTENCES: Record<GitTreeErrorCode, string> = {
    "no-git": "git was not found; install git and try again",
    "fetch-failed": "the commit could not be fetched from github.com/example/skills",
    "no-commit": "the commit aaaaaaaaaaaa was not found in github.com/example/skills",
    "too-large": "the repository is larger than 256 MiB; nothing was staged",
    timeout: "git did not finish in 120 seconds; nothing was staged",
    interrupted: "the import was interrupted; nothing was staged",
    "bad-listing": "the file list of the commit could not be read",
    "read-failed": "a file of the commit could not be read",
  };
  it.each(Object.entries(SENTENCES))("%s", async (code, sentence) => {
    const r = await run(code as GitTreeErrorCode);
    expect(r.rc).toBe(1);
    expect(r.lines).toEqual([`PROBLEM ${sentence}`]);
    expect(quarantine()).toBe(false);
  });

  it("closes the tree once when the listing fails", async () => {
    const t = fakeTree();
    t.list = () => {
      throw new GitTreeError("bad-listing");
    };
    const r = await run(t);
    expect(r.lines).toEqual(["PROBLEM the file list of the commit could not be read"]);
    expect(t.closed).toBe(1);
    expect(quarantine()).toBe(false);
  });

  it("throws on an error of another type", async () => {
    const t = fakeTree();
    t.list = () => {
      throw new TypeError("boom");
    };
    await expect(run(t)).rejects.toThrow("boom");
    expect(process.listenerCount("SIGINT")).toBe(before.int);
  });
});

const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };

describe("interrupt", () => {
  it("wins over a valid read", async () => {
    const r = await run(fakeTree(GOOD, { onRead: () => void process.emit("SIGINT") }));
    expect(r.lines).toEqual([INTERRUPTED]);
    expect(r.rc).toBe(1);
    expect(quarantine()).toBe(false);
  });

  it("wins over a listing error", async () => {
    const t = fakeTree();
    t.list = () => {
      process.emit("SIGTERM");
      throw new GitTreeError("bad-listing");
    };
    const r = await run(t);
    expect(r.lines).toEqual([INTERRUPTED]);
    expect(quarantine()).toBe(false);
  });

  it("wins over a rejection found after reading", async () => {
    const r = await run(fakeTree({ "skills/c/SKILL.md": "bad" }, { onRead: () => void process.emit("SIGINT") }));
    expect(r.lines).toEqual([INTERRUPTED]);
    expect(quarantine()).toBe(false);
  });
});

describe("licence evidence", () => {
  const LIC: Record<string, string> = { ...GOOD, LICENSE: "MIT License\nSECRET-LICENCE-SENTENCE\n", "skills/a/NOTICE": "notice" };
  const dest = () => join(home, "skill-quarantine", "lib", COMMIT);

  it("stores licences.json and the files, prints the same four lines and no licence text", async () => {
    const r = await run(fakeTree(LIC));
    expect(r.rc).toBe(0);
    expect(r.lines).toHaveLength(4);
    expect(r.text).not.toContain("SECRET-LICENCE-SENTENCE");
    expect(existsSync(join(dest(), "licences.json"))).toBe(true);
    expect(existsSync(join(dest(), "licences", "LICENSE"))).toBe(true);
    expect(existsSync(join(dest(), "licences", "skills/a/NOTICE"))).toBe(true);
  });

  it("collects the evidence while the tree is open", async () => {
    const order: string[] = [];
    const t = fakeTree(LIC, { onList: () => order.push("list"), onRead: () => order.push("read") });
    const close = t.close.bind(t);
    t.close = () => {
      order.push("close");
      close();
    };
    await run(t);
    expect(order.at(-1)).toBe("close");
    expect(order.filter((x) => x === "close")).toHaveLength(1);
    expect(order.filter((x) => x === "list").length).toBeGreaterThan(1);
  });

  it("prints (unchanged) the second time", async () => {
    await run(fakeTree(LIC));
    const b = await run(fakeTree(LIC));
    expect(b.rc).toBe(0);
    expect(b.lines[2]).toContain("(unchanged)");
  });

  it("refuses too many licence files and stages nothing", async () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_v, i) => [`skills/LICENSE-${i}`, "x"]));
    const r = await run(fakeTree({ ...GOOD, ...many }));
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the source holds more than 200 licence or notice files");
    expect(quarantine()).toBe(false);
  });

  it("reports a failed read of a licence file and stages nothing", async () => {
    const t = fakeTree(LIC);
    const read = t.read.bind(t);
    t.read = (entries) => {
      if (entries.some((e) => /LICENSE|NOTICE/.test(e.path))) throw new GitTreeError("read-failed");
      return read(entries);
    };
    const r = await run(t);
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^PROBLEM /);
    expect(quarantine()).toBe(false);
    expect(t.closed).toBe(1);
  });

  it("stages nothing when SIGINT arrives while the licence files are read", async () => {
    const t = fakeTree(LIC);
    const read = t.read.bind(t);
    t.read = (entries) => {
      if (entries.some((e) => /LICENSE|NOTICE/.test(e.path))) void process.emit("SIGINT");
      return read(entries);
    };
    const r = await run(t);
    expect(r.lines).toEqual([INTERRUPTED]);
    expect(quarantine()).toBe(false);
  });

  it("tells how to complete an import staged before evidence was kept", async () => {
    const src = { ...source(), repositoryKey: "github.com/example/skills", ref: { approved: COMMIT } } as unknown as SkillLibrarySource;
    publishImport(prepareImport(src, fakeTree(LIC)), { home });
    const r = await run(fakeTree(LIC));
    expect(r.rc).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^PROBLEM .*Remove that folder, then import again/);
  });
});

describe("signal handlers", () => {
  it("are removed after success and after a failure", async () => {
    await run(fakeTree());
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    await run("timeout");
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });
});
