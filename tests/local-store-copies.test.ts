import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "../src/stories/local-store.js";
import { GitHubStore } from "../src/stories/github-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "scf-copies-"));
  dirs.push(d);
  return d;
};
const git = (d: string, ...args: string[]): string => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (s: string): string[] => s.split("\n").filter(Boolean);
const KEY = "0123456789abcdef";
const folder = (d: string): string => join(d, ".scf", "stories");

function repo(): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "T");
  git(d, "config", "user.email", "t@example.invalid");
  git(d, "config", "commit.gpgsign", "false");
  writeFileSync(join(d, "README.md"), "x\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "init");
  return d;
}
const store = (d: string): LocalStore => new LocalStore(d, "local/x", { lockPollMs: 5, branch: "scf/stories" });
const treeOf = (d: string): string[] => lines(git(d, "ls-tree", "-r", "--name-only", "scf/stories"));

/** Two pictures kept outside the project. */
function sources(): { name: string; from: string }[] {
  const s = tmp();
  writeFileSync(join(s, "1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(s, "2.jpg"), Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]));
  return [
    { name: `pictures/${KEY}/1.png`, from: join(s, "1.png") },
    { name: `pictures/${KEY}/2.jpg`, from: join(s, "2.jpg") },
  ];
}
const create = (s: LocalStore, files: { name: string; from: string }[]) => s.create({ title: "Hello", body: "b", labels: [], files });

describe("LocalStore keeps files with a story", () => {
  it("writes the copies and commits them with the story", async () => {
    const d = repo();
    const files = sources();
    const made = await create(store(d), files);
    for (const f of files) expect(readFileSync(join(folder(d), f.name)).equals(readFileSync(f.from))).toBe(true);
    const shown = lines(git(d, "show", "--name-only", "--format=%s", "scf/stories"));
    expect(shown[0]).toBe(`scf: story #${made.number} created`);
    expect(shown.slice(1).sort()).toEqual([".scf/stories/1-hello.md", ".scf/stories/next-number", `.scf/stories/pictures/${KEY}/1.png`, `.scf/stories/pictures/${KEY}/2.jpg`]);
    // the story scan ignores the picture folder
    expect((await store(d).get(made.number))?.title).toBe("Hello");
    expect(readdirSync(folder(d)).filter((f) => f.endsWith(".md"))).toEqual(["1-hello.md"]);
  });

  it.each([
    ["a name that climbs out", `../x.png`],
    ["a type that is not a picture", `pictures/${KEY}/1.svg`],
    ["a folder that is not a key", "pictures/short/1.png"],
    ["a name outside pictures", `other/${KEY}/1.png`],
  ])("refuses %s and writes nothing", async (_n, name) => {
    const d = repo();
    const [first] = sources();
    await expect(create(store(d), [{ name, from: first!.from }])).rejects.toThrow("a file to keep with the story is not valid");
    expect(existsSync(join(folder(d), "next-number"))).toBe(false);
    expect(existsSync(join(folder(d), "pictures"))).toBe(false);
  });

  it("refuses a relative or missing source and 6 files", async () => {
    const d = repo();
    const [first] = sources();
    await expect(create(store(d), [{ name: first!.name, from: "rel.png" }])).rejects.toThrow("not valid");
    await expect(create(store(d), [{ name: first!.name, from: join(tmp(), "nope.png") }])).rejects.toThrow("not valid");
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `pictures/${KEY}/${i + 1}.png`, from: first!.from }));
    await expect(create(store(d), many)).rejects.toThrow("not valid");
    expect(existsSync(join(folder(d), "next-number"))).toBe(false);
  });

  it.each([["pictures"], [`pictures/${KEY}`]])("refuses a link as the folder %s and leaves the counter alone", async (level) => {
    const d = repo();
    const files = sources();
    mkdirSync(folder(d), { recursive: true });
    writeFileSync(join(folder(d), "next-number"), "7\n");
    const away = tmp();
    if (level === "pictures") symlinkSync(away, join(folder(d), "pictures"));
    else {
      mkdirSync(join(folder(d), "pictures"));
      symlinkSync(away, join(folder(d), level));
    }
    await expect(create(store(d), files)).rejects.toThrow("not valid");
    expect(readFileSync(join(folder(d), "next-number"), "utf8")).toBe("7\n");
    expect(readdirSync(folder(d)).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(readdirSync(away)).toEqual([]);
  });

  it("refuses a destination that is a link or holds other bytes, on create and on commitCreated", async () => {
    const d = repo();
    const files = sources();
    const s = store(d);
    const made = await create(s, files);
    const dest = join(folder(d), files[0]!.name);
    // other bytes
    writeFileSync(dest, "changed");
    await expect(s.commitCreated(made.number, undefined, undefined, files)).rejects.toThrow("not valid");
    await expect(create(s, files)).rejects.toThrow("not valid");
    // a link to a file with the same bytes
    rmSync(dest);
    symlinkSync(files[0]!.from, dest);
    const before = git(d, "rev-parse", "scf/stories");
    await expect(s.commitCreated(made.number, undefined, undefined, files)).rejects.toThrow("not valid");
    await expect(create(s, files)).rejects.toThrow("not valid");
    expect(git(d, "rev-parse", "scf/stories")).toBe(before);
    expect(readdirSync(folder(d)).filter((f) => f.endsWith(".md"))).toEqual(["1-hello.md"]);
  });

  it("writes no copy when the guard stops the write", async () => {
    const d = repo();
    await expect(store(d).create({ title: "Hello", body: "b", labels: [], files: sources() }, undefined, () => { throw new Error("not yours"); })).rejects.toThrow("not yours");
    expect(existsSync(join(folder(d), "pictures"))).toBe(false);
    expect(existsSync(join(folder(d), "next-number"))).toBe(false);
  });

  it("commits missing copies with commitCreated, and makes no new commit when all are committed", async () => {
    const d = repo();
    const files = sources();
    const s = store(d);
    const made = await s.create({ title: "Hello", body: "b", labels: [] });
    await s.commitCreated(made.number, undefined, undefined, files);
    expect(treeOf(d)).toContain(`.scf/stories/pictures/${KEY}/1.png`);
    expect(treeOf(d)).toContain(`.scf/stories/pictures/${KEY}/2.jpg`);
    const tip = git(d, "rev-parse", "scf/stories");
    await s.commitCreated(made.number, undefined, undefined, files);
    expect(git(d, "rev-parse", "scf/stories")).toBe(tip);
    expect(readdirSync(join(folder(d), "pictures"))).toEqual([KEY]);
  });
});

describe("GitHubStore refuses files", () => {
  it("rejects without calling gh", async () => {
    await expect(new GitHubStore("acme/app").create({ title: "t", body: "b", labels: [], files: [{ name: `pictures/${KEY}/1.png`, from: "/x" }] })).rejects.toThrow("nothing was uploaded");
  });
});
