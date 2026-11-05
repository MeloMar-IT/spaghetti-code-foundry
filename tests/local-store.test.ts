import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATUS_MARKER } from "../src/github.js";
import { LocalStore, NO_CHANGES, UNREADABLE_TITLE } from "../src/stories/local-store.js";
import { type FileStory, formatStoryFile, parseStoryFile } from "../src/stories/story-file.js";
import { storyStoreContract } from "./story-store-contract.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const proj = (): string => {
  const d = mkdtempSync(join(tmpdir(), "scf-local-"));
  dirs.push(d);
  return d;
};
const NOW = new Date("2026-01-01T00:00:00.000Z");
const folder = (d: string): string => join(d, ".scf", "stories");
const store = (d: string, o = {}): LocalStore => new LocalStore(d, "local/x", { lockPollMs: 5, now: () => NOW, commit: false, ...o });
const story = (n: number, o: Partial<FileStory> = {}): FileStory => ({
  number: n, title: `Story ${n}`, state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "b", comments: [], ...o,
});
/** Writes a story file by hand, as a person would. */
function put(d: string, s: FileStory, name = `${s.number}-story.md`): string {
  mkdirSync(folder(d), { recursive: true });
  writeFileSync(join(folder(d), name), formatStoryFile(s));
  return name;
}
const read = (d: string, name: string): string => readFileSync(join(folder(d), name), "utf8");
const nameOf = (d: string, n: number): string => readdirSync(folder(d)).find((f) => f.startsWith(`${n}-`))!;
const leftovers = (d: string): string[] => readdirSync(folder(d)).filter((f) => !/^\d+-.*\.md$/.test(f) && f !== "next-number");

storyStoreContract("LocalStore", () => ({ store: new LocalStore(proj(), "local/x", { commit: false }), login: "Foundry" }));

describe("LocalStore numbering", () => {
  it("counts up from 1 and never gives a number back", async () => {
    const d = proj();
    const s = store(d);
    const numbers: number[] = [];
    for (const title of ["a", "b", "c"]) numbers.push((await s.create({ title, body: "", labels: [] })).number);
    expect(numbers).toEqual([1, 2, 3]);
    rmSync(join(folder(d), nameOf(d, 3)));
    expect((await s.create({ title: "d", body: "", labels: [] })).number).toBe(4);
    expect(read(d, "next-number")).toBe("5\n");
  });

  it("goes one above the highest file when next-number is missing, and skips past a lower next-number", async () => {
    const d = proj();
    put(d, story(7));
    put(d, story(3));
    expect((await store(d).create({ title: "x", body: "", labels: [] })).number).toBe(8);
    const e = proj();
    put(e, story(9));
    writeFileSync(join(folder(e), "next-number"), "4\n");
    expect((await store(e).create({ title: "x", body: "", labels: [] })).number).toBe(10);
  });

  it("rejects an invalid next-number and writes nothing", async () => {
    const d = proj();
    mkdirSync(folder(d), { recursive: true });
    writeFileSync(join(folder(d), "next-number"), "abc\n");
    await expect(store(d).create({ title: "x", body: "", labels: [] })).rejects.toThrow(/next-number/);
    expect(readdirSync(folder(d))).toEqual(["next-number"]);
  });

  it("identifies a story by its parsed number: 007- is story 7, and 7- next to it is a duplicate", async () => {
    const d = proj();
    put(d, story(7), "007-a.md");
    const s = store(d);
    expect((await s.get(7))?.title).toBe("Story 7");
    expect((await s.listAll({ pages: 1 })).issues.map((i) => i.number)).toEqual([7]);
    writeFileSync(join(folder(d), "7-b.md"), formatStoryFile(story(7)));
    const dup = await s.get(7);
    expect(dup?.title).toBe(UNREADABLE_TITLE);
    expect(dup?.body).toMatch(/more than one file has number 7: 007-a.md, 7-b.md/);
    expect((await s.listAll({ pages: 1 })).issues).toHaveLength(1);
    await expect(s.edit(7, { body: "x" })).rejects.toThrow(/cannot be read/);
  });

  it("gives different numbers to ten parallel creates on two stores", async () => {
    const d = proj();
    const a = store(d);
    const b = store(d);
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).create({ title: `s${i}`, body: "", labels: [] })));
    expect(new Set(made.map((m) => m.number)).size).toBe(10);
    expect(leftovers(d)).toEqual([]);
  });
});

describe("LocalStore broken files", () => {
  const broken = (d: string): string => {
    mkdirSync(folder(d), { recursive: true });
    writeFileSync(join(folder(d), "5-bad.md"), "no front matter here\n");
    return "5-bad.md";
  };

  it("shows the file as 'cannot be read' and leaves its bytes alone", async () => {
    const d = proj();
    const name = broken(d);
    put(d, story(6, { labels: ["x"] }));
    const before = read(d, name);
    const s = store(d);
    for (const list of [(await s.listAll({ pages: 1 })).issues, (await s.listOpen({ pages: 1 })).issues, await s.listNewest()]) {
      const e = list.find((i) => i.number === 5)!;
      expect(e.title).toBe(UNREADABLE_TITLE);
      expect(e.body).toMatch(/5-bad\.md.*front matter/);
    }
    expect((await s.listWithBodies(10)).find((i) => i.number === 5)?.title).toBe(UNREADABLE_TITLE);
    expect((await s.get(5))?.title).toBe(UNREADABLE_TITLE);
    await expect(s.edit(5, { body: "x" })).rejects.toThrow(/cannot be read/);
    await expect(s.comment(5, "x")).rejects.toThrow(/cannot be read/);
    await expect(s.setLabels(5, "a", [])).rejects.toThrow(/cannot be read/);
    await expect(s.close(5, "completed")).rejects.toThrow(/cannot be read/);
    await expect(s.state(5)).rejects.toThrow(/cannot be read/);
    await expect(s.states([6, 5])).rejects.toThrow(/cannot be read/);
    expect(read(d, name)).toBe(before);
    expect(await s.listOpenWithLabel("x", { limit: 10 })).toHaveLength(1);
    expect(await s.listClosedWithAnyLabel(["x"], { limit: 10 })).toHaveLength(0);
    expect(leftovers(d)).toEqual([]);
  });

  it("treats a link and a file over 1 MiB as broken", async () => {
    const d = proj();
    mkdirSync(folder(d), { recursive: true });
    const outside = join(proj(), "t.md");
    writeFileSync(outside, formatStoryFile(story(2)));
    symlinkSync(outside, join(folder(d), "2-link.md"));
    writeFileSync(join(folder(d), "3-big.md"), `${formatStoryFile(story(3))}${"x".repeat(1024 * 1024)}`);
    const s = store(d);
    expect((await s.get(2))?.body).toMatch(/link/);
    expect((await s.get(3))?.body).toMatch(/larger than 1 MiB/);
  });
});

describe("LocalStore links and folders", () => {
  const outsideWith = (): string => {
    const o = proj();
    writeFileSync(join(o, "keep.txt"), "keep");
    return o;
  };

  it("refuses a linked .scf/stories on every write", async () => {
    const d = proj();
    const out = outsideWith();
    writeFileSync(join(out, "1-story.md"), formatStoryFile(story(1)));
    mkdirSync(join(d, ".scf"));
    symlinkSync(out, folder(d));
    const s = store(d);
    await expect(s.create({ title: "x", body: "", labels: [] })).rejects.toThrow(/link or not a folder/);
    await expect(s.comment(1, "x")).rejects.toThrow(/link or not a folder/);
    await expect(s.listAll({ pages: 1 })).rejects.toThrow(/link or not a folder/);
    expect(readdirSync(out).sort()).toEqual(["1-story.md", "keep.txt"]);
  });

  it("refuses a linked .scf", async () => {
    const d = proj();
    const out = outsideWith();
    symlinkSync(out, join(d, ".scf"));
    await expect(store(d).create({ title: "x", body: "", labels: [] })).rejects.toThrow(/link or not a folder/);
    expect(readdirSync(out)).toEqual(["keep.txt"]);
  });

  it("does not follow a linked .lock or next-number", async () => {
    for (const name of [".lock", "next-number"]) {
      const d = proj();
      put(d, story(1));
      const out = outsideWith();
      symlinkSync(join(out, "keep.txt"), join(folder(d), name));
      await expect(store(d).create({ title: "x", body: "", labels: [] })).rejects.toThrow(/link or not a plain file/);
      if (name === ".lock") await expect(store(d).comment(1, "x")).rejects.toThrow(/link or not a plain file/);
      expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("keep");
    }
  });

  it("makes the folders only on create", async () => {
    const d = proj();
    await expect(store(d).comment(1, "x")).rejects.toThrow(/does not exist/);
    expect(existsSync(join(d, ".scf"))).toBe(false);
    expect((await store(d).create({ title: "x", body: "", labels: [] })).number).toBe(1);
    expect(existsSync(folder(d))).toBe(true);
  });
});

describe("LocalStore size", () => {
  const MAX = 1024 * 1024;
  it("rejects a write that would make the story unreadable, and accepts one just below", async () => {
    const d = proj();
    const s = store(d);
    const n = (await s.create({ title: "big", body: "", labels: [] })).number;
    const name = nameOf(d, n);
    const before = read(d, name);
    await expect(s.comment(n, "x".repeat(MAX))).rejects.toThrow("the story would be larger than 1 MiB");
    expect(read(d, name)).toBe(before);
    const parsed = parseStoryFile(before, name);
    if (!parsed.ok) throw new Error(parsed.reason);
    const base = Buffer.byteLength(formatStoryFile({ ...parsed.story, commentTop: 1, comments: [{ id: 1, author: "Foundry", createdAt: NOW.toISOString(), body: "" }] }));
    await s.comment(n, "é".repeat(Math.floor((MAX - base) / 2)));
    expect(statSync(join(folder(d), name)).size).toBeLessThanOrEqual(MAX);
    expect((await s.comments(n)).length).toBe(1);
    expect((await s.get(n))?.title).toBe("big");
  });

  it("rejects an oversized create or edit and writes nothing", async () => {
    const d = proj();
    const s = store(d);
    await expect(s.create({ title: "x", body: "y".repeat(MAX), labels: [] })).rejects.toThrow(/1 MiB/);
    expect(existsSync(join(folder(d), "next-number"))).toBe(false);
    const n = (await s.create({ title: "x", body: "", labels: [] })).number;
    const before = read(d, nameOf(d, n));
    await expect(s.edit(n, { body: "y".repeat(MAX) })).rejects.toThrow(/1 MiB/);
    expect(read(d, nameOf(d, n))).toBe(before);
  });
});

describe("LocalStore hand edits and other behaviour", () => {
  it("shows a hand edit at the next get and in lists, and a hand comment by another author", async () => {
    const d = proj();
    const s = store(d);
    const n = (await s.create({ title: "old", body: "", labels: [] })).number;
    const name = nameOf(d, n);
    const parsed = parseStoryFile(read(d, name), name);
    if (!parsed.ok) throw new Error(parsed.reason);
    writeFileSync(join(folder(d), name), formatStoryFile({ ...parsed.story, title: "new", comments: [{ author: "marcel", createdAt: "2026-02-01T00:00:00Z", body: "hi" }] }));
    expect((await s.get(n))?.title).toBe("new");
    expect((await s.listAll({ pages: 1 })).issues[0]?.title).toBe("new");
    const c = (await s.comments(n))[0]!;
    expect([c.author.login, c.viewerDidAuthor, c.body]).toEqual(["marcel", false, "hi"]);
  });

  it("keeps the file name when the title changes", async () => {
    const d = proj();
    const n = (await store(d).create({ title: "first", body: "", labels: [] })).number;
    const name = nameOf(d, n);
    await store(d).edit(n, { title: "second", body: "" });
    expect(nameOf(d, n)).toBe(name);
    expect((await store(d).get(n))?.title).toBe("second");
  });

  it("leaves the file alone when the status comment has the same body", async () => {
    const d = proj();
    const s = store(d);
    const n = (await s.create({ title: "s", body: "", labels: [] })).number;
    await s.upsertStatusComment(n, `a\n${STATUS_MARKER}`, { create: true });
    const name = nameOf(d, n);
    const text = read(d, name);
    const mtime = statSync(join(folder(d), name)).mtimeMs;
    const r = await s.upsertStatusComment(n, `a\n${STATUS_MARKER}`, { create: true });
    expect(r.changed).toBe(false);
    expect(read(d, name)).toBe(text);
    expect(statSync(join(folder(d), name)).mtimeMs).toBe(mtime);
  });

  it("does not create a status comment when create is false", async () => {
    const d = proj();
    const s = store(d);
    const n = (await s.create({ title: "s", body: "", labels: [] })).number;
    expect(await s.upsertStatusComment(n, `a\n${STATUS_MARKER}`, { create: false })).toMatchObject({ changed: false, removed: 0, left: 0 });
    expect(await s.comments(n)).toEqual([]);
  });

  it("leaves a marker comment of another author alone and adds its own", async () => {
    const d = proj();
    const other = { author: "marcel", createdAt: "2026-02-01T00:00:00Z", body: `theirs\n${STATUS_MARKER}` };
    put(d, story(1, { comments: [other] }));
    const s = store(d);
    const r = await s.upsertStatusComment(1, `mine\n${STATUS_MARKER}`, { create: true });
    expect(r.created).toBe(true);
    const all = await s.comments(1);
    expect(all.map((c) => [c.author.login, c.body])).toEqual([["marcel", other.body], ["Foundry", `mine\n${STATUS_MARKER}`]]);
  });

  it("updates the first status comment of ours and removes the extra ones", async () => {
    const d = proj();
    const ours = (t: string) => ({ author: "Foundry", createdAt: "2026-02-01T00:00:00Z", body: `${t}\n${STATUS_MARKER}` });
    put(d, story(1, { comments: [ours("one"), { author: "marcel", createdAt: "2026-02-01T00:00:00Z", body: "hi" }, ours("two")] }));
    const s = store(d);
    const r = await s.upsertStatusComment(1, `new\n${STATUS_MARKER}`, { create: true });
    expect(r).toMatchObject({ id: "1", changed: true, removed: 1, left: 0 });
    expect((await s.comments(1)).map((c) => c.body)).toEqual([`new\n${STATUS_MARKER}`, "hi"]);
  });

  it("refuses a status comment on a pull request", async () => {
    const d = proj();
    await expect(store(d).upsertStatusComment(1, "x", { create: true, on: "pr" })).rejects.toThrow(NO_CHANGES);
  });
});

describe("LocalStore shapes", () => {
  it("gives upper-case states, label filters and the order of GitHub", async () => {
    const d = proj();
    put(d, story(1, { labels: ["Bug", "ready"] }));
    put(d, story(2, { labels: ["bug"] }));
    put(d, story(3, { labels: ["bug", "ready"], state: "closed", closedAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z" }));
    put(d, story(4, { labels: ["ready"], state: "closed", closedAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-06T00:00:00Z" }));
    const s = store(d);
    expect((await s.listWithBodies(10)).map((i) => [i.number, i.state])).toEqual([[4, "CLOSED"], [3, "CLOSED"], [2, "OPEN"], [1, "OPEN"]]);
    expect(await s.stateAndLabels(3)).toEqual({ state: "CLOSED", labels: [{ name: "bug" }, { name: "ready" }] });
    expect(await s.isClosed(3)).toBe(true);
    expect(await s.isClosed(1)).toBe(false);
    expect((await s.listOpenWithAnyLabel("bug", ["READY"], { limit: 10 })).map((i) => i.number)).toEqual([1]);
    expect((await s.listClosedWithAnyLabel(["ready"], { limit: 10 })).map((i) => i.number)).toEqual([4, 3]);
    expect((await s.listOpenWithLabel("BUG", { limit: 10 })).map((i) => i.number)).toEqual([2, 1]);
    expect((await s.listByLabel("bug")).map((i) => i.number)).toEqual([3, 2, 1]);
    expect(await s.labels()).toEqual(["Bug", "bug", "ready"]);
    const states = await s.states([1, 3], { before: () => {} });
    expect([...states]).toEqual([[1, "open"], [3, "closed"]]);
  });

  it("says a newest page is cut at 100 stories", async () => {
    for (const [count, cut] of [[99, false], [100, true], [101, true]] as const) {
      const d = proj();
      for (let i = 1; i <= count; i++) put(d, story(i));
      const r = await store(d).listNewestCut();
      expect([r.issues.length, r.cut]).toEqual([Math.min(count, 100), cut]);
      expect(r.issues[0]?.number).toBe(count);
    }
  });

  it("pages the open stories of a label 100 at a time", async () => {
    const d = proj();
    for (let i = 1; i <= 150; i++) put(d, story(i, { labels: ["l"] }));
    const r = await store(d).listOpenByLabelPages("l", { fromPage: 1, pages: 2 });
    expect([r.pages.get(1)!.length, r.pages.get(2)!.length, r.next]).toEqual([100, 50, 1]);
    const first = await store(d).listOpenByLabelPages("l", { fromPage: 1, pages: 1 });
    expect(first.next).toBe(2);
    const cut = await store(d).listOpen({ pages: 1 });
    expect([cut.issues.length, cut.cut]).toEqual([100, true]);
    await expect(store(d).listOpen({ pages: 0 })).rejects.toThrow(/pages/);
  });

  it("leaves the folder alone for the label calls", async () => {
    const d = proj();
    put(d, story(1));
    const before = readdirSync(folder(d));
    await store(d).ensureLabel("a", "fff", "d");
    await store(d).createLabelIfMissing("a", "fff", "d");
    expect(readdirSync(folder(d))).toEqual(before);
  });

  it("finds /overrule comments updated since a date", async () => {
    const d = proj();
    const old = "2020-01-01T00:00:00Z";
    const c = { author: "marcel", createdAt: old, body: "/Overrule this" };
    put(d, story(1, { comments: [c], updatedAt: old }));
    put(d, story(2, { comments: [c], updatedAt: "2026-03-01T00:00:00Z" }));
    put(d, story(3, { comments: [{ ...c, body: "fine" }], updatedAt: "2026-03-01T00:00:00Z" }));
    utimesSync(join(folder(d), "1-story.md"), new Date(old), new Date(old));
    utimesSync(join(folder(d), "2-story.md"), new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
    const s = store(d);
    expect(await s.searchOverrules({ since: "2025-01-01", limit: 10 })).toEqual([{ number: 2, updatedAt: "2026-03-01T00:00:00Z" }]);
    expect((await s.searchOverrules({ since: "2019-01-01", limit: 10 })).map((r) => r.number)).toEqual([2, 1]);
    await expect(s.searchOverrules({ since: "yesterday", limit: 10 })).rejects.toThrow("not a date");
  });

  it("refuses a bad number before touching a file, and a missing story", async () => {
    const d = proj();
    const s = store(d);
    for (const n of [0, -1, 1.5]) {
      await expect(s.get(n)).rejects.toThrow("not an issue number");
      await expect(s.edit(n, { body: "" })).rejects.toThrow("not an issue number");
    }
    expect(existsSync(join(d, ".scf"))).toBe(false);
    await expect(s.listWithBodies(0)).rejects.toThrow("not a list size");
    put(d, story(1));
    await expect(s.edit(2, { body: "" })).rejects.toThrow(/does not exist/);
    await expect(s.states([9])).rejects.toThrow(/does not exist/);
    expect(await s.get(9)).toBeUndefined();
  });
});

describe("LocalStore refusals", () => {
  const s = store("/nonexistent-local-store-dir");
  const calls: [string, () => Promise<unknown>][] = [
    ["probeAccess", () => s.probeAccess(async () => 1)],
    ["openChangeWith", () => s.openChangeWith({ head: "h", base: "b", title: "t", body: "" }, async () => 1)],
    ["findChange", () => s.findChange("b")],
    ["changeState", () => s.changeState(1)],
    ["openChange", () => s.openChange({ head: "h", title: "t", body: "" })],
    ["updateChange", () => s.updateChange(1, { body: "" })],
    ["mergeChange", () => s.mergeChange(1)],
    ["closeChange", () => s.closeChange(1)],
    ["changeComments", () => s.changeComments(1)],
    ["commentOnChange", () => s.commentOnChange(1, "x")],
    ["mergedChanges", () => s.mergedChanges(1)],
    ["checks", () => s.checks("abcdef0")],
    ["reviewComments", () => s.reviewComments(1)],
    ["openChanges", () => s.openChanges(1)],
    ["changeActivity", () => s.changeActivity(1)],
  ];
  it.each(calls)("%s says there are no pull requests", async (_name, call) => {
    await expect(call()).rejects.toThrow(new RegExp(`^${NO_CHANGES}$`));
  });

  const steps = ["stepFindChange", "stepReviewDecision", "stepListChanges", "stepCommentOnChange", "stepSetReady", "stepChangeText", "stepReviewComments", "stepReviews", "stepOpenChange", "stepChecks", "stepCheckout", "stepMerge"];
  it.each(steps)("%s is not yet available", async (name) => {
    await expect((s as unknown as Record<string, () => Promise<unknown>>)[name]!()).rejects.toThrow("not yet available");
  });
  it("the pull request calls of sync say there are no pull requests", () => {
    const y = s.sync(() => { throw new Error("run was called"); });
    const calls = [
      () => y.listChanges({ state: "open", limit: 1, fields: "number" }), () => y.viewChange(1, "number"),
      () => y.openChange({ head: "h", title: "t", body: "" }), () => y.updateChange(1, { body: "" }), () => y.requestReview(1, "someone"),
    ];
    for (const call of calls) expect(call).toThrow(new RegExp(`^${NO_CHANGES}$`));
  });
});

describe("LocalStore go state", () => {
  const stateOf = (d: string, n: number): string => /^state: (\w+)$/m.exec(read(d, nameOf(d, n)))![1]!;
  const labelsOf = (d: string, n: number): string[] => {
    const r = parseStoryFile(read(d, nameOf(d, n)), nameOf(d, n));
    return r.ok ? r.story.labels : [];
  };

  it("shows a go story as open with the label go", async () => {
    const d = proj();
    put(d, story(1, { state: "go", labels: ["bug"] }));
    put(d, story(2));
    const s = store(d);
    const got = await s.listOpenWithLabel("go", { limit: 10 });
    expect(got.map((i) => i.number)).toEqual([1]);
    expect(got[0]!.state).toBe("OPEN");
    expect(got[0]!.labels.map((l) => l.name).sort()).toEqual(["bug", "go"]);
    expect((await s.listOpen({ pages: 1 })).issues.map((i) => i.number).sort()).toEqual([1, 2]);
    expect((await s.listOpenByLabelPages("go", { fromPage: 1, pages: 1 })).pages.get(1)!.map((i) => i.number)).toEqual([1]);
    expect((await s.listOpenWithAnyLabel("go", ["bug"], { limit: 5 })).map((i) => i.number)).toEqual([1]);
    expect((await s.stateAndLabels(1)).state).toBe("OPEN");
    expect((await s.states([1, 2])).get(1)).toBe("open");
    expect(await s.state(1)).toBe("open");
    expect(await s.labels()).toContain("go");
  });

  it("adds and removes go as the state, and keeps other labels", async () => {
    const d = proj();
    put(d, story(1));
    const s = store(d);
    await s.setLabels(1, "go", []);
    expect(stateOf(d, 1)).toBe("go");
    expect(labelsOf(d, 1)).toEqual([]);
    await s.setLabels(1, "factory:working", []);
    expect(stateOf(d, 1)).toBe("go");
    expect(labelsOf(d, 1)).toEqual(["factory:working"]);
    await s.setLabels(1, undefined, ["Go"]);
    expect(stateOf(d, 1)).toBe("open");
    expect(labelsOf(d, 1)).toEqual(["factory:working"]);
  });

  it("closing a closed story changes nothing: closedAt stays and the file is not written", async () => {
    const d = proj();
    const name = put(d, story(1, { state: "closed", closedAt: "2025-05-05T00:00:00Z" }));
    const before = read(d, name);
    const s = store(d);
    await s.close(1, "completed");
    expect(read(d, name)).toBe(before);
    expect(read(d, name)).toContain("2025-05-05");
    put(d, story(2));
    await s.close(2, "completed");
    const once = read(d, nameOf(d, 2));
    expect(once).toContain("closed");
    await s.close(2, "completed");
    expect(read(d, nameOf(d, 2))).toBe(once);
  });

  it("keeps a closed story closed when go is added, and closing a go story closes it", async () => {
    const d = proj();
    put(d, story(1, { state: "closed" }));
    put(d, story(2, { state: "go" }));
    const s = store(d);
    await s.setLabels(1, "go", []);
    expect(stateOf(d, 1)).toBe("closed");
    expect(await s.listOpenWithLabel("go", { limit: 10 })).toEqual([2].map(() => expect.objectContaining({ number: 2 })));
    await s.close(2, "completed");
    expect(stateOf(d, 2)).toBe("closed");
    expect(await s.listOpen({ pages: 1 })).toEqual({ issues: [], cut: false });
    expect(await s.listClosedWithAnyLabel(["go"], { limit: 5 })).toEqual([]);
    await s.reopen(2);
    expect(stateOf(d, 2)).toBe("open");
  });

  it("creates a go story from the label go", async () => {
    const d = proj();
    const s = store(d);
    const made = await s.create({ title: "T", body: "b", labels: ["go", "bug"] });
    expect(stateOf(d, made.number)).toBe("go");
    expect(labelsOf(d, made.number)).toEqual(["bug"]);
    expect((await s.get(made.number))!.labels).toEqual([{ name: "bug" }, { name: "go" }]);
  });

  it("keeps a literal go label of an old open or closed file after every write", async () => {
    const d = proj();
    put(d, story(1, { labels: ["go", "bug"] }));
    put(d, story(2, { state: "closed", labels: ["go", "bug"] }));
    const s = store(d);
    expect(await s.listOpenWithLabel("go", { limit: 10 })).toEqual([]);
    expect((await s.stateAndLabels(1)).labels).toEqual([{ name: "bug" }]);
    await s.setLabels(1, "factory:working", ["bug"]);
    await s.setLabels(2, "other", []);
    await s.comment(1, "hi");
    await s.close(1, "completed");
    await s.reopen(1);
    await s.reopen(2);
    expect(labelsOf(d, 1)).toEqual(["go", "factory:working"]);
    expect(labelsOf(d, 2)).toEqual(["go", "bug", "other"]);
    expect(stateOf(d, 1)).toBe("open");
    // go removed and added through the store never touches the file's own entry
    await s.setLabels(1, undefined, ["go"]);
    expect(labelsOf(d, 1)).toEqual(["go", "factory:working"]);
  });
});

describe("LocalStore setGithubIssue and markGithubDone", () => {
  it("saves the fields, keeps them through a later write, and refuses a different number or repository", async () => {
    const d = proj();
    put(d, story(3));
    const s = store(d);
    await s.setGithubIssue(3, 41, "acme/app");
    const text = read(d, nameOf(d, 3));
    expect(text).toMatch(/^github_issue: 41$/m);
    expect(text).toMatch(/^github_repo: acme\/app$/m);
    await s.setGithubIssue(3, 41, "acme/app");
    await s.comment(3, "hello");
    await s.markGithubDone(3);
    await s.edit(3, { body: "new" });
    const back = parseStoryFile(read(d, nameOf(d, 3)), nameOf(d, 3));
    expect(back.ok && back.story).toMatchObject({ githubIssue: 41, githubRepo: "acme/app", githubDone: true });
    await expect(s.setGithubIssue(3, 42, "acme/app")).rejects.toThrow("story #3 was already moved to acme/app#41");
    await expect(s.setGithubIssue(3, 41, "acme/other")).rejects.toThrow("already moved");
    await expect(s.setGithubIssue(3, 0, "acme/app")).rejects.toThrow("not an issue number");
    await expect(s.setGithubIssue(3, 5, "nope")).rejects.toThrow("not a repository name");
  });
  it("markGithubDone needs a saved issue", async () => {
    const d = proj();
    put(d, story(3));
    await expect(store(d).markGithubDone(3)).rejects.toThrow("has no GitHub issue yet");
  });
});

describe("LocalStore source", () => {
  it("runs no gh and no process", () => {
    for (const f of ["src/stories/local-store.ts", "src/stories/local-map.ts", "src/stories/story-lock.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain("child_process");
      expect(text).not.toMatch(/import\s*(?:type\s*)?\{[^}]*\b(?:gh|ghJson|ghInherit)\b[^}]*\}/);
    }
  });
});
