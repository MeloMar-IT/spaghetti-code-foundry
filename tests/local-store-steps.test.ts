import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../src/stories/local-store.js";
import { type FileStory, formatStoryFile } from "../src/stories/story-file.js";
import { commentLines, foundryIds, jsonText, pickFields, plainText, ticketText } from "../src/stories/local-text.js";
import { toView } from "../src/stories/local-map.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const proj = (): string => {
  const d = mkdtempSync(join(tmpdir(), "scf-steps-"));
  dirs.push(d);
  return d;
};
let tick = 0;
const store = (d: string, o = {}): LocalStore => new LocalStore(d, "local/x", { lockPollMs: 5, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)), ...o });
const folder = (d: string): string => join(d, ".scf", "stories");
const story = (n: number, o: Partial<FileStory> = {}): FileStory => ({
  number: n, title: `Story ${n}`, state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "b", comments: [], ...o,
});
const put = (d: string, s: FileStory): string => {
  mkdirSync(folder(d), { recursive: true });
  const name = `${s.number}-story.md`;
  writeFileSync(join(folder(d), name), formatStoryFile(s));
  return name;
};
const text = (d: string, name: string): string => readFileSync(join(folder(d), name), "utf8");
const com = (author: string, body: string, id?: number) => ({ ...(id === undefined ? {} : { id }), author, createdAt: "2026-01-01T00:00:00Z", body });
const view = (s: FileStory, author = "Foundry") => toView({ ok: true, n: s.number, file: "x.md", rel: `.scf/stories/${s.number}-story.md`, mtimeMs: 0, story: s }, author);

describe("step texts", () => {
  it("does not quote a line after a carriage return, as gh's (?m)^ does not match there", () => {
    const t = ticketText(view(story(1, { body: "a\r--- comment by x\n--- comment by y" })));
    expect(t).toContain("a\r--- comment by x\n> --- comment by y");
  });

  it("tags a comment (Foundry) only for the store's author and a marker", () => {
    const t = ticketText(view(story(1, { comments: [
      com("someone", "x\n<!-- claude-factory run=1 -->", 1), com("Foundry", "no marker", 2),
      com("Foundry", "y\n<!-- spaghetti-code-foundry status -->", 3), com("Foundry", "z\n<!-- claude-factory", 4),
    ] })));
    expect(t).toContain("--- comment by someone:\n");
    expect(t).toContain("--- comment by Foundry:\nno marker");
    expect(t).toContain("--- comment by Foundry (Foundry):\ny\n");
    expect(t).toContain("--- comment by Foundry (Foundry):\nz\n");
    expect(foundryIds(view(story(1, { comments: [com("Foundry", "x", 1), com("Foundry", "<!-- claude-factory", 2), com("a", "<!-- claude-factory", 3)] })))).toBe("[2]\n");
  });

  it("ends the text of a story without comments with the body and two line breaks, and plain text too", () => {
    const v = view(story(3, { body: "text", labels: ["a", "b"] }));
    expect(ticketText(v)).toBe("# #3: Story 3\n.scf/stories/3-story.md\nLabels: a, b\n\ntext\n\n");
    expect(plainText(v)).toBe("# #3: Story 3\nLabels: a, b\n\ntext\n\n");
    expect(commentLines(v)).toBe("");
    expect(foundryIds(v)).toBe("[]\n");
  });

  it("keeps the order of the keys of a comment line and of --json", () => {
    const v = view(story(1, { comments: [com("a", "hi", 7)] }));
    expect(commentLines(v)).toBe('{"id":7,"html_url":".scf/stories/1-story.md#issuecomment-7","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","body":"hi"}\n');
    expect(Object.keys(pickFields(v, "title,body,number"))).toEqual(["body", "number", "title"]);
    expect(jsonText({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}\n');
  });

  it("refuses a bad or unknown field list", () => {
    const v = view(story(1));
    expect(() => pickFields(v, "body,")).toThrow("not a field list");
    expect(() => pickFields(v, "--x")).toThrow("not a field list");
    expect(() => pickFields(v, "body,nope")).toThrow('Unknown JSON field: "nope"');
  });
});

describe("LocalStore steps", () => {
  it("gives title, body, labels and the plain pieces from a file", async () => {
    const d = proj();
    put(d, story(1, { title: "T", body: "line one\nline two", labels: ["x", "y"] }));
    const s = store(d);
    expect(await s.stepTitle(1)).toBe("T\n");
    expect(await s.stepBody(1)).toBe("line one\nline two\n");
    expect(await s.stepLabels(1)).toBe("x\ny\n");
    expect(await s.stepAuthors(1)).toBe(" \n");
    put(d, story(2, { labels: [] }));
    expect(await s.stepLabels(2)).toBe("");
    expect(JSON.parse(await s.stepIssue(1))).toEqual({ body: "line one\nline two", number: 1, title: "T", updatedAt: "2026-01-01T00:00:00Z" });
  });

  it("writes the id into the heading of a comment from stepComment and returns its address", async () => {
    const d = proj();
    const name = put(d, story(1));
    const s = store(d);
    expect(await s.stepComment(1, "hello")).toBe(".scf/stories/1-story.md#issuecomment-1\n");
    expect(await s.stepComment(1, "again")).toBe(".scf/stories/1-story.md#issuecomment-2\n");
    expect(text(d, name)).toMatch(/### Comment 1 by Foundry on \S+\n\nhello\n\n### Comment 2 by Foundry on \S+\n\nagain\n/);
  });

  it("creates with stepCreate: the address passes the number regex of create-split, and the labels are saved", async () => {
    const d = proj();
    const s = store(d);
    const out = await s.stepCreate({ title: "Made", body: "b", labels: ["l1"] });
    expect(out).toMatch(/\.md#1\n$/);
    expect(/(\d+)\s*$/.exec(out)?.[1]).toBe("1");
    expect(await s.stepLabels(1)).toBe("l1\n");
  });

  it("closes with a reason, and refuses a bad reason before anything is written", async () => {
    const d = proj();
    const name = put(d, story(1));
    const before = text(d, name);
    const s = store(d);
    await expect(s.stepClose(1, "wontfix" as never)).rejects.toThrow("not a close reason");
    expect(text(d, name)).toBe(before);
    expect(await s.stepClose(1, "not planned")).toBe("");
    expect(text(d, name)).toContain("state: closed");
  });

  it("gives a clear error for a missing or a broken story, and refuses a bad number without making .scf", async () => {
    const d = proj();
    const s = store(d);
    for (const n of [0, 1.5]) await expect(s.stepText(n)).rejects.toThrow("not an issue number");
    expect(existsSync(join(d, ".scf"))).toBe(false);
    put(d, story(1));
    await expect(s.stepText(2)).rejects.toThrow("does not exist");
    writeFileSync(join(folder(d), "3-bad.md"), "no front matter");
    await expect(s.stepText(3)).rejects.toThrow("cannot be read");
    await expect(s.stepComment(3, "x")).rejects.toThrow("cannot be read");
  });

  describe("ids", () => {
    it("gives the comments of a hand-written file ids above the highest set one, and the next write saves them", async () => {
      const d = proj();
      const name = put(d, story(1, { comments: [com("a", "one"), com("b", "two", 5), com("c", "three")] }));
      const s = store(d);
      const lines = (await s.stepComments(1)).trimEnd().split("\n").map((l) => JSON.parse(l) as { id: number });
      expect(lines.map((l) => l.id)).toEqual([6, 5, 7]);
      expect(text(d, name)).not.toContain("### Comment 6");
      await s.stepComment(1, "four");
      expect(text(d, name)).toMatch(/### Comment 6 by a[\s\S]*### Comment 5 by b[\s\S]*### Comment 7 by c[\s\S]*### Comment 8 by Foundry/);
    });

    it("gives a duplicated id a new one", async () => {
      const d = proj();
      put(d, story(1, { comments: [com("a", "one", 2), com("b", "two", 2)] }));
      const ids = (await store(d).stepComments(1)).trimEnd().split("\n").map((l) => (JSON.parse(l) as { id: number }).id);
      expect(ids).toEqual([2, 3]);
    });

    it("keeps the ids when upsertStatusComment removes an extra comment", async () => {
      const d = proj();
      const marker = "<!-- claude-factory status -->";
      put(d, story(1, { comments: [com("Foundry", `s1\n${marker}`, 1), com("a", "hand", 2), com("Foundry", `s2\n${marker}`, 3), com("b", "last", 4)] }));
      const s = store(d);
      const r = await s.upsertStatusComment(1, `new\n${marker}`, { create: true });
      expect(r).toMatchObject({ id: "1", removed: 1 });
      const ids = (await s.stepComments(1)).trimEnd().split("\n").map((l) => (JSON.parse(l) as { id: number }).id);
      expect(ids).toEqual([1, 2, 4]);
      expect(await s.stepFoundryComments(1)).toBe("[1]\n");
    });
  });

  describe("ids after a removal", () => {
    const marker = "<!-- claude-factory status -->";
    it("never gives out the id of a comment that a status update removed", async () => {
      const d = proj();
      const name = put(d, story(1, { comments: [com("Foundry", `s1\n${marker}`, 1), com("Foundry", `s2\n${marker}`, 2)] }));
      const s = store(d);
      expect(await s.upsertStatusComment(1, `new\n${marker}`, { create: true })).toMatchObject({ id: "1", removed: 1 });
      expect(text(d, name)).toContain("comment_top: 2");
      expect(await s.stepComment(1, "after")).toBe(".scf/stories/1-story.md#issuecomment-3\n");
      expect((await s.stepComments(1)).trimEnd().split("\n").map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 3]);
    });
    it("keeps the id of a comment removed by a status update when a hand comment is added after it", async () => {
      const d = proj();
      put(d, story(1, { comments: [com("a", "hand", 5), com("Foundry", `s\n${marker}`, 6), com("Foundry", `t\n${marker}`, 7)] }));
      const s = store(d);
      await s.upsertStatusComment(1, `u\n${marker}`, { create: true });
      expect(await s.stepComment(1, "later")).toMatch(/#issuecomment-8\n$/);
    });
  });

  it("upgrades a format 1 file on write without changing its body text", async () => {
    const d = proj();
    mkdirSync(folder(d), { recursive: true });
    writeFileSync(join(folder(d), "1-old.md"), ["---", "number: 1", "title: Old", "kind: story", "state: open", "labels: []", "depends_on: []", "---", "",
      "Body", "### Comment 7 by Alice on today", "", "## Comments", "", "### Comment by Bob on t", "", "Hi", ""].join("\n"));
    const s = store(d);
    await s.comment(1, "new");
    expect(await s.stepBody(1)).toBe("Body\n### Comment 7 by Alice on today\n");
    expect((await s.stepComments(1)).trimEnd().split("\n").map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2]);
  });

  describe("stepOpenStories", () => {
    const run = async (s: LocalStore, o: { limit: number; comments: boolean }) => {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = await s.stepOpenStories(o);
      const out = write.mock.calls.map((c) => String(c[0])).join("");
      write.mockRestore();
      return { code, out };
    };

    it("prints the open stories newest first, cut at the limit, and returns 0", async () => {
      const d = proj();
      put(d, story(1, { labels: ["a"] }));
      put(d, story(2, { state: "closed" }));
      put(d, story(3));
      put(d, story(4, { comments: [com("a", "hi", 1)] }));
      const s = store(d);
      const r = await run(s, { limit: 2, comments: false });
      expect(r.code).toBe(0);
      expect(r.out.endsWith("\n")).toBe(true);
      const list = JSON.parse(r.out) as Record<string, unknown>[];
      expect(list.map((x) => x.number)).toEqual([4, 3]);
      expect(Object.keys(list[0]!)).toEqual(["body", "labels", "number", "title"]);
      const all = JSON.parse((await run(s, { limit: 10, comments: true })).out) as { number: number; comments: unknown[] }[];
      expect(all.map((x) => x.number)).toEqual([4, 3, 1]);
      expect(all[0]!.comments).toHaveLength(1);
    });

    it("shows a broken file as cannot be read, and refuses a bad limit", async () => {
      const d = proj();
      put(d, story(1));
      writeFileSync(join(folder(d), "2-bad.md"), "nope");
      const s = store(d);
      const list = JSON.parse((await run(s, { limit: 5, comments: false })).out) as { number: number; title: string }[];
      expect(list.map((x) => [x.number, x.title])).toEqual([[2, "cannot be read"], [1, "Story 1"]]);
      for (const limit of [0, 1001]) await expect(s.stepOpenStories({ limit, comments: false })).rejects.toThrow("not a list size");
    });
  });
});

describe("LocalStore sync", () => {
  const make = (d: string, o = {}) => {
    const run = vi.fn(() => "");
    return { y: store(d, o).sync(run), run };
  };

  it("reads and lists without calling run", () => {
    const d = proj();
    put(d, story(1, { body: "one" }));
    put(d, story(2, { state: "closed", body: "two" }));
    writeFileSync(join(folder(d), "3-bad.md"), "nope");
    const { y, run } = make(d);
    expect(y.get(1)).toEqual({ number: 1, title: "Story 1", state: "OPEN", body: "one" });
    expect(y.get(2)?.state).toBe("CLOSED");
    expect(y.get(9)).toBeUndefined();
    expect(() => y.get(3)).toThrow("cannot be read");
    expect(y.list(2).map((x) => x.number)).toEqual([3, 2]);
    expect(y.list(10).map((x) => x.title)).toEqual(["cannot be read", "Story 2", "Story 1"]);
    expect(() => y.list(0)).toThrow("not a list size");
    expect(JSON.parse(y.openList(10, "number,title")).map((x: { number: number }) => x.number)).toEqual([3, 1]);
    expect(run).not.toHaveBeenCalled();
  });

  it("views a story with sorted keys, and checks the field list before it reads", () => {
    const d = proj();
    put(d, story(1, { labels: ["a"] }));
    const { y } = make(d);
    expect(y.view(1, "title,labels,number")).toBe('{"labels":[{"color":"ededed","description":"","id":"","name":"a"}],"number":1,"title":"Story 1"}\n');
    expect(() => y.view(1, "nope")).toThrow("Unknown JSON field");
    expect(() => y.view(7, "bad list")).toThrow("not a field list");
    expect(() => y.view(7, "title")).toThrow("does not exist");
  });

  it("writes: body, create, comment, labels and close", () => {
    const d = proj();
    const { y, run } = make(d);
    expect(y.create({ title: "New", body: "b", labels: ["x"] })).toMatch(/\.md#1\n$/);
    y.setBody(1, "changed");
    expect(y.get(1)?.body).toBe("changed");
    expect(y.comment(1, "hi")).toBe(".scf/stories/1-new.md#issuecomment-1\n");
    y.setLabels(1, "z", ["x"]);
    expect(JSON.parse(y.view(1, "labels")).labels.map((l: { name: string }) => l.name)).toEqual(["z"]);
    expect(() => y.close(1, "bad" as never)).toThrow("not a close reason");
    expect(y.get(1)?.state).toBe("OPEN");
    y.close(1, "not planned");
    expect(y.get(1)?.state).toBe("CLOSED");
    expect(readdirSync(folder(d)).filter((f) => f.startsWith("."))).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("gives the same results as the async part", async () => {
    const a = proj();
    const b = proj();
    const sa = store(a, { now: () => new Date("2026-01-01T00:00:00Z") });
    const { y } = make(b, { now: () => new Date("2026-01-01T00:00:00Z") });
    await sa.create({ title: "Same", body: "b", labels: ["l"] });
    y.create({ title: "Same", body: "b", labels: ["l"] });
    await sa.comment(1, "c");
    y.comment(1, "c");
    await sa.setLabels(1, "m", []);
    y.setLabels(1, "m", []);
    expect(text(b, "1-same.md")).toBe(text(a, "1-same.md"));
  });

  it("returns the author as the viewer", () => {
    const d = proj();
    expect(make(d).y.viewer()).toBe("Foundry\n");
    expect(make(d, { author: "Ada" }).y.viewer()).toBe("Ada\n");
  });
});
