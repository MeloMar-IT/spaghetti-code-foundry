import { beforeEach, describe, expect, it } from "vitest";
import { isStatusComment, STATUS_MARKER } from "../src/github.js";
import type { StoryStore } from "../src/stories/store.js";

/**
 * What every story store must do the same way. `subject` is called before each test and returns a store that starts without stories.
 * Each case makes its own stories and uses only the numbers it gets back.
 */
export function storyStoreContract(name: string, subject: () => { store: StoryStore }): void {
  describe(`${name} keeps the story store contract`, () => {
    let store: StoryStore;
    beforeEach(() => {
      store = subject().store;
    });
    const make = async (title: string, labels: string[] = []) => (await store.create({ title, body: `body of ${title}`, labels })).number;
    const names = (i: { labels: ({ name?: string } | string)[] }) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

    it("creates a story and reads it back", async () => {
      const made = await store.create({ title: "T one", body: "line\n$(x) `y`", labels: ["a"] });
      expect(made.number).toBeGreaterThanOrEqual(1);
      expect(made.state).toBe("open");
      expect(names(made)).toEqual(["a"]);
      expect(made.html_url).not.toBe("");
      expect(Number.isNaN(Date.parse(made.created_at))).toBe(false);
      const got = await store.get(made.number);
      expect([got?.title, got?.body, got && names(got)]).toEqual(["T one", "line\n$(x) `y`", ["a"]]);
      expect(await store.get(999999)).toBeUndefined();
    });

    it("edits the title and the body, and keeps the title when only the body changes", async () => {
      const n = await make("before");
      await store.edit(n, { title: "after", body: "new body" });
      expect(await store.get(n)).toMatchObject({ title: "after", body: "new body" });
      await store.edit(n, { body: "only body" });
      expect(await store.get(n)).toMatchObject({ title: "after", body: "only body" });
    });

    it("changes labels", async () => {
      const n = await make("labels", ["a"]);
      await store.setLabels(n, "b", ["a"]);
      expect(names((await store.get(n))!)).toEqual(["b"]);
      await store.setLabels(n, undefined, ["b"]);
      expect(names((await store.get(n))!)).toEqual([]);
    });

    it("adds and lists comments", async () => {
      const n = await make("comments");
      expect(typeof (await store.comment(n, "hello there"))).toBe("string");
      expect((await store.comments(n)).map((c) => c.body.trim())).toContain("hello there");
    });

    it("updates the status comment instead of adding another", async () => {
      const n = await make("status");
      const first = await store.upsertStatusComment(n, `one\n${STATUS_MARKER}`, { create: true });
      expect(first.created).toBe(true);
      const second = await store.upsertStatusComment(n, `two\n${STATUS_MARKER}`, { create: true });
      expect(second.changed).toBe(true);
      expect(second.created).toBeUndefined();
      const ours = (await store.comments(n)).filter(isStatusComment);
      expect(ours.map((c) => c.body.trim())).toEqual([`two\n${STATUS_MARKER}`]);
    });

    it("closes and reopens", async () => {
      const n = await make("closing");
      expect((await store.close(n, "completed")).state).toBe("closed");
      expect((await store.get(n))?.state).toBe("closed");
      expect((await store.reopen(n)).state).toBe("open");
      expect((await store.get(n))?.state).toBe("open");
    });

    it("reports states", async () => {
      const a = await make("a");
      const b = await make("b");
      await store.close(b, "completed");
      expect([...(await store.states([a, b]))]).toEqual([[a, "open"], [b, "closed"]]);
      expect(await store.state(a)).toBe("open");
    });

    it("lists stories", async () => {
      const a = await make("list a", ["lab"]);
      const b = await make("list b", ["lab"]);
      await store.close(b, "completed");
      const all = (await store.listAll({ pages: 1 })).issues;
      expect([all.find((i) => i.number === a)?.state, all.find((i) => i.number === b)?.state]).toEqual(["open", "closed"]);
      const open = (await store.listOpen({ pages: 1 })).issues.map((i) => i.number);
      expect(open).toContain(a);
      expect(open).not.toContain(b);
      const page = (await store.listOpenByLabelPages("lab", { fromPage: 1, pages: 1 })).pages.get(1)!;
      expect(page.map((i) => i.number)).toEqual([a]);
    });

    it("lists the newest stories, newest first, and says when the page is not full", async () => {
      const a = await make("newest a");
      const b = await make("newest b");
      const r = await store.listNewestCut();
      expect(r.cut).toBe(false);
      expect(r.issues.map((i) => i.number)).toEqual([b, a]);
      expect((await store.listNewest()).map((i) => i.number)).toEqual([b, a]);
    });
  });
}
