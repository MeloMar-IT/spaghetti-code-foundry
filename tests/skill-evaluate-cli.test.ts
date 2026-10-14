import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { EVALUATE_USAGE, skillEvaluateCommand } from "../src/skill-import/evaluate-cli.js";
import { GitTreeError, type GitTree, type GitTreeErrorCode } from "../src/skill-import/git-tree.js";
import type { TreeEntry } from "../src/skills/import-plan.js";

const COMMIT = "b".repeat(40);
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const GOOD: Record<string, string> = { "skills/a/SKILL.md": md("a") };

function fakeTree(files: Record<string, string> = GOOD): GitTree & { closed: number } {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  const t = {
    closed: 0,
    close() {
      t.closed++;
    },
    list: (p: string) => all.filter((e) => p === "." || e.path.startsWith(p + "/")),
    read: (entries: TreeEntry[]) => entries.map((e) => Buffer.from(files[e.path]!)),
  };
  return t as GitTree & { closed: number };
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
  review: { by: "@example", on: "2026-01-01", commit: COMMIT, licence: "MIT" },
  ...over,
});

let dir: string;
let home: string;
let opens: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skill-evaluate-cli-")));
  home = join(dir, "home");
  opens = 0;
  write([source()]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (sources: Record<string, unknown>[]) => writeFileSync(join(dir, "skill-sources.yaml"), stringify({ schema: 1, sources }));

const snap = (d: string): string[] => {
  try {
    return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      return e.isDirectory() ? [`${p} ${statSync(p).mode}`, ...snap(p)] : [`${p} ${statSync(p).mode} ${readFileSync(p).toString("hex")}`];
    });
  } catch {
    return [];
  }
};

async function run(tree: GitTree | GitTreeErrorCode, operands: string[] = ["lib"], values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const rc = await skillEvaluateCommand({ positionals: operands, values }, (l) => lines.push(l), {
    cwd: dir,
    home,
    open: async () => {
      opens++;
      if (typeof tree === "string") throw new GitTreeError(tree);
      return tree;
    },
  });
  return { rc, lines, text: lines.join("\n") };
}

describe("scf skills evaluate", () => {
  it("evaluates, closes the tree once and leaves the data folder alone", async () => {
    const t = fakeTree();
    const before = snap(home);
    const r = await run(t);
    expect(r.text).toContain("EVALUATED 1 skill");
    expect(r.text).toMatch(/COMPATIBILITY lib-a-[0-9a-f]+: none declared/);
    expect(r.text).toMatch(/TOOLS lib-a-[0-9a-f]+: none declared/);
    expect(r.text).toContain("importing grants none");
    expect(r.text).toContain("REFUSED skills/a: licence");
    expect(r.rc).toBe(1);
    expect(t.closed).toBe(1);
    expect(snap(home)).toEqual(before);
  });

  it("treats missing technology operands as no evidence, not as an empty project", async () => {
    write([source({ scope: { capabilities: ["oracle"], technologies: { oracle: ">=19" } } })]);
    const r = await run(fakeTree());
    expect(r.text).not.toContain("project:");
    expect(r.text).not.toContain("incompatible");
    const given = await run(fakeTree(), ["lib", "oracle@12.2"]);
    expect(given.text).toMatch(/oracle >=19 \(source\); project: incompatible/);
  });

  it("checks the syntax before any read", async () => {
    for (const [ops, vals] of [[[], {}], [["Bad_Id"], {}], [["lib"], { x: "1" }], [["lib", "oracle@x"], {}], [["lib", "oracle@1", "oracle@2"], {}]] as const) {
      await expect(run(fakeTree(), [...ops], { ...vals })).rejects.toThrow(EVALUATE_USAGE);
    }
    expect(opens).toBe(0);
  });

  it("reports problems with the source list", async () => {
    expect((await run(fakeTree(), ["other"])).text).toContain("PROBLEM no source with the id other");
    write([source({ status: "disabled", reason: "not selected" })]);
    expect((await run(fakeTree())).text).toContain("PROBLEM the source lib is disabled");
    write([source({ ref: { track: "main" } })]);
    expect((await run(fakeTree())).text).toContain("needs ref.approved");
    writeFileSync(join(dir, "skill-sources.yaml"), "schema: 1\nsources: nope\n");
    expect((await run(fakeTree())).text).toContain("PROBLEM");
    rmSync(join(dir, "skill-sources.yaml"));
    expect((await run(fakeTree())).text).toContain("does not exist");
    expect(opens).toBe(0);
  });

  it("reports git errors and an empty import", async () => {
    const r = await run("fetch-failed" as GitTreeErrorCode);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("PROBLEM");
    const empty = await run(fakeTree({ "skills/readme.md": "x" }));
    expect(empty.rc).toBe(1);
    expect(empty.text).toContain("PROBLEM");
  });
});
