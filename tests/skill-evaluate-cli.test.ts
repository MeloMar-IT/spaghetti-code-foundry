import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

describe("scf skills evaluate with a reviewed profile", () => {
  const vercel = (over: Record<string, unknown> = {}) =>
    source({ id: "vercel", repository: "https://github.com/vercel-labs/agent-skills", trust: "verified", review: undefined, ...over });
  const VFILES: Record<string, string> = {
    "skills/composition-patterns/SKILL.md": md("composition"),
    "skills/vercel-deploy-claimable/SKILL.md": md("deploy"),
  };
  const pkg = (deps: Record<string, string>) => {
    const d = join(dir, "project-" + Math.random().toString(36).slice(2));
    mkdirSync(d);
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: deps }));
    return d;
  };
  const runV = (tree: GitTree | GitTreeErrorCode, values: Record<string, unknown> = {}, operands: string[] = ["vercel"]) => run(tree, operands, values);
  const canChmod = process.getuid?.() !== 0;
  beforeEach(() => write([vercel(), source()]));

  it("reports the connector line, the unselected folder and the missing roots", async () => {
    const t = fakeTree(VFILES);
    const before = snap(home);
    const r = await runV(t);
    expect(r.text).toMatch(/CONNECTOR vercel-agent-skills \S+: group=frontend declaration unreviewed; evaluation missing/);
    expect(r.text).toContain("NOT-SELECTED skills/vercel-deploy-claimable");
    expect(r.text).toContain("MISSING skills/react-best-practices");
    expect(r.rc).toBe(1);
    expect(t.closed).toBe(1);
    expect(snap(home)).toEqual(before);
  });

  it("reports an import with nothing staged without a PROBLEM", async () => {
    const t = fakeTree();
    t.list = (p: string) => (p === "skills" || p === "." ? [{ path: "skills/composition-patterns/link", kind: "symlink", id: "id:l" }] : []);
    const r = await runV(t);
    expect(r.text).toContain("REFUSED");
    expect(r.text).toContain("MISSING skills/react-best-practices");
    expect(r.text).toMatch(/EVALUATED 0 skills .* 0 conflicts/);
    expect(r.text).not.toContain("PROBLEM");
    expect(r.rc).toBe(1);
    expect(t.closed).toBe(1);
    const none = fakeTree({ "skills/readme.md": "x" });
    const r2 = await runV(none);
    expect(r2.text).toContain("MISSING skills/react-best-practices");
    expect(r2.text).toContain("EVALUATED 0 skills");
    expect(r2.text).not.toContain("PROBLEM");
    expect(none.closed).toBe(1);
  });

  it("reads project evidence with --repo", async () => {
    expect((await runV(fakeTree(VFILES), { repo: pkg({ react: "17.0.2" }) })).text).toContain("project: incompatible");
    expect((await runV(fakeTree(VFILES), { repo: pkg({ lodash: "4.17.21" }) })).text).toContain("project: incompatible");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "17.0.2" } }));
    expect((await runV(fakeTree(VFILES), {})).text).not.toContain("project:");
  });

  it("stops before any fetch when --repo cannot be used", async () => {
    const missing = await runV(fakeTree(VFILES), { repo: join(dir, "nope") });
    expect(missing.text).toContain("PROBLEM the folder given with --repo cannot be read");
    const generic = await run(fakeTree(), ["lib"], { repo: dir });
    expect(generic.text).toContain("PROBLEM --repo needs a source");
    expect(opens).toBe(0);
  });
  it.skipIf(!canChmod)("stops when the folder or a sub-folder cannot be read", async () => {
    const root = pkg({ react: "18.2.0" });
    const sub = join(root, "sub");
    mkdirSync(sub);
    chmodSync(sub, 0o000);
    try {
      const r = await runV(fakeTree(VFILES), { repo: root });
      expect(r.text).toContain("PROBLEM the folder given with --repo could not be read completely (unreadable entries)");
    } finally {
      chmodSync(sub, 0o755);
    }
    const locked = pkg({ react: "18.2.0" });
    chmodSync(locked, 0o000);
    try {
      expect((await runV(fakeTree(VFILES), { repo: locked })).text).toContain("PROBLEM the folder given with --repo cannot be read");
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(opens).toBe(0);
  });

  it("refuses a scope and another trust tier before any fetch", async () => {
    write([vercel({ scope: { capabilities: ["x-y"], technologies: { react: ">=18" } } })]);
    expect((await runV(fakeTree(VFILES))).text).toMatch(/PROBLEM .*cannot have a scope/);
    write([vercel({ trust: "community" })]);
    expect((await runV(fakeTree(VFILES))).text).toContain("PROBLEM");
    expect(opens).toBe(0);
  });

  it("checks the --repo syntax", async () => {
    await expect(runV(fakeTree(VFILES), { repo: "x" }, ["vercel", "react@18"])).rejects.toThrow(EVALUATE_USAGE);
    await expect(runV(fakeTree(VFILES), { repo: true })).rejects.toThrow(EVALUATE_USAGE);
    await expect(runV(fakeTree(VFILES), { repo: "" })).rejects.toThrow(EVALUATE_USAGE);
    expect(opens).toBe(0);
  });
});
