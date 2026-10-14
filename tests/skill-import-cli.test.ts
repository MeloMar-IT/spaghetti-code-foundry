import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GitTreeError, type GitTree, type GitTreeErrorCode } from "../src/skill-import/git-tree.js";
import { IMPORT_USAGE, skillImportCommand } from "../src/skill-import/cli.js";
import { prepareImport, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport, readStagedImport } from "../src/skills/import-stage.js";
import { LICENCE_LIMITS } from "../src/skills/licence-rules.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const GOOD: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") };

interface Fake extends GitTree {
  closed: number;
}
function fakeTree(
  files: Record<string, string> = GOOD,
  hooks: { onList?: () => void; onRead?: () => void; over?: Record<string, Partial<TreeEntry>>; failRead?: (entries: readonly TreeEntry[]) => Error | undefined } = {},
): Fake {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path, ...hooks.over?.[path] }));
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
      const err = hooks.failRead?.(entries);
      if (err) throw err;
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

const sourceOf = (): SkillLibrarySource => ({ ...(source() as object), repositoryKey: "github.com/example/skills" }) as SkillLibrarySource;

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
    expect(r.lines).toHaveLength(5);
    expect(r.lines[4]).toBe("Licence evidence: 0 files kept");
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
  const LICENCE = "MIT License\n\nPermission is hereby granted.\n";
  const hasRoot = (entries: readonly TreeEntry[]) => entries.some((e) => e.path === "LICENSE");

  it("keeps a licence above the selected paths and reads it back", async () => {
    const r = await run(fakeTree({ LICENSE: LICENCE, ...GOOD }));
    expect(r.rc).toBe(0);
    expect(r.lines.at(-1)).toBe("Licence evidence: 1 files kept");
    const got = readStagedImport("lib", COMMIT, { home });
    if (got.state !== "ok") throw new Error("not ok");
    expect(got.record.evidence).toHaveLength(1);
    expect(got.evidence!.files.map((f) => [f.path, f.dir, Buffer.from(f.content!).toString()])).toEqual([["LICENSE", ".", LICENCE]]);
    expect(existsSync(join(got.dir, "evidence", got.record.evidence![0]!.sha256!))).toBe(true);
  });

  it("records a too-large file and a link as problems without reading them", async () => {
    const read: string[] = [];
    const t = fakeTree({ LICENSE: LICENCE, NOTICE: "x", ...GOOD }, {
      over: { LICENSE: { size: LICENCE_LIMITS.fileBytes + 1 }, NOTICE: { kind: "symlink" } },
      onRead: () => void 0,
    });
    const inner = t.read.bind(t);
    t.read = (entries) => {
      read.push(...entries.map((e) => e.path));
      return inner(entries);
    };
    const r = await run(t);
    expect(r.rc).toBe(0);
    expect(r.lines).toContain(`EVIDENCE LICENSE: is larger than ${LICENCE_LIMITS.fileBytes} bytes`);
    expect(r.lines).toContain("EVIDENCE NOTICE: a symbolic link");
    expect(r.lines.at(-1)).toBe("Licence evidence: 2 files kept, 2 with a problem");
    expect(read).not.toContain("LICENSE");
    expect(read).not.toContain("NOTICE");
  });

  it("keeps a licence that cannot be read as a problem and still stages", async () => {
    const t = fakeTree({ LICENSE: LICENCE, "skills/NOTICE": "n", ...GOOD }, { failRead: (e) => (hasRoot(e) ? new GitTreeError("read-failed") : undefined) });
    const r = await run(t);
    expect(r.rc).toBe(0);
    expect(r.lines).toContain("EVIDENCE LICENSE: cannot be read");
    expect(r.lines.at(-1)).toBe("Licence evidence: 2 files kept, 1 with a problem");
    expect(quarantine()).toBe(true);
    expect(t.closed).toBe(1);
    const got = readStagedImport("lib", COMMIT, { home });
    if (got.state !== "ok") throw new Error("not ok");
    expect(got.evidence!.files.map((f) => [f.path, f.problem, f.content === undefined])).toEqual([["LICENSE", "cannot be read", true], ["skills/NOTICE", undefined, false]]);
  });

  it("stages nothing when git times out reading a licence", async () => {
    const r = await run(fakeTree({ LICENSE: LICENCE, ...GOOD }, { failRead: (e) => (hasRoot(e) ? new GitTreeError("timeout") : undefined) }));
    expect(r.rc).toBe(1);
    expect(r.lines).toEqual(["PROBLEM git did not finish in 120 seconds; nothing was staged"]);
    expect(quarantine()).toBe(false);
  });

  it("stages nothing when the licence listing cannot be read", async () => {
    const t = fakeTree();
    const list = t.list.bind(t);
    t.list = (p) => {
      if (p === ".") throw new GitTreeError("bad-listing");
      return list(p);
    };
    const r = await run(t);
    expect(r.lines).toEqual(["PROBLEM the file list of the commit could not be read"]);
    expect(t.closed).toBe(1);
    expect(quarantine()).toBe(false);
  });

  it("stages nothing for more than 200 licence files", async () => {
    const many: Record<string, string> = { ...GOOD };
    for (let i = 0; i < 201; i++) many[`skills/LICENSE-${i}`] = "x";
    const r = await run(fakeTree(many));
    expect(r.rc).toBe(1);
    expect(r.lines).toEqual(["PROBLEM the source holds more than 200 licence or notice files"]);
    expect(quarantine()).toBe(false);
  });

  it("asks to remove a folder staged by an older scf", async () => {
    publishImport(prepareImport(sourceOf(), fakeTree({ LICENSE: LICENCE, ...GOOD })), { home });
    const r = await run(fakeTree({ LICENSE: LICENCE, ...GOOD }));
    expect(r.rc).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^PROBLEM .*older scf.*Remove that folder, then import again\.$/);
  });

  it("is interrupted even when the killed read fails", async () => {
    const r = await run(fakeTree({ LICENSE: LICENCE, ...GOOD }, { failRead: (e) => (hasRoot(e) ? (process.emit("SIGINT"), new GitTreeError("read-failed")) : undefined) }));
    expect(r.lines).toEqual([INTERRUPTED]);
    expect(quarantine()).toBe(false);
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
